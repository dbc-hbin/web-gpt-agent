/**
 * The executing half of managed work.
 *
 * The ledger (`store.ts`) owns identity and state; the service (`service.ts`) owns the six
 * request shapes and the delivery pump. This module is what actually *runs* a work: it captures
 * the private baseline commit, creates the integration and worker worktrees, dispatches the
 * prime ChatGPT conversation through the existing outbox, admits every mutation through the
 * operation receipts, integrates worker branches under one mutation lock, and owns the single
 * recovery authority per managed agent generation.
 *
 * Three things are load-bearing and worth stating plainly:
 *
 * 1. `managedToolGate` is installed on the MCP kernel for the whole lifetime of an endpoint
 *    generation. It is NEVER null: before the runtime initializes it denies every coding call
 *    with a typed refusal, so there is no window in which an unrestored host admits mutations.
 * 2. Every managed mutation carries an `operation_id`. The gate admits it against the durable
 *    ledger *before* the handler runs, commits `running` before the first side effect, and
 *    records the result before publishing it. A retry with the same id and the same canonical
 *    arguments joins the original instead of running a second copy.
 * 3. Identity is never taken from the model. It comes from the kernel's proven conversation
 *    correlation, resolved against the durable agent binding, and it is fenced by generation.
 */

import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { AsyncLocalStorage } from 'node:async_hooks';
import { promises as fs } from 'node:fs';
import { z } from 'zod';

import { getConfig, updateConfig } from '../config.js';
import { approvedRootContaining, resolvePath, validateNewRoot } from '../sandbox.js';
import { listProjects } from '../projects.js';
import { getChatModels } from '../chat-models.js';
import { logInfo, logWarn } from '../logger.js';
import { powerHolders, setPowerHolder } from '../power.js';
import { queueResume, setManagedRecoveryHooks } from '../bridge.js';
import {
  onGuiLeaseReleased,
  releaseGuiLease,
  setManagedCallerResolver
} from './cua.js';
import {
  explicitWorkTarget,
  resolveWorkTarget,
  type ManagedWorkerIdentity,
  type WorkTarget
} from './control-source.js';
import { externalCallOutcome, isReadOnlyExternalCall } from '../mcp/tools-external.js';
import { ExternalNotDispatched } from '../plugins/manager.js';
import { findSessionByConversation, getSession, readOverflowText, writeOverflowText } from '../session/store.js';
import { listInputs } from '../session/input.js';
import { retryQueuedInputBrowser } from '../session/start-input.js';
import {
  abortContinuationNow, attachSummary, continuationByToken, openContinuationNow,
  setManagedPrimeRebind
} from '../session/continuation.js';
import {
  failAgent,
  primeConversation,
  setConversationBindHook,
  setFinishPrecondition,
  setSpawnTransform,
  type WorkerSpawn
} from '../agents.js';
import {
  capturePatchAfterHashes,
  createOperationLedger,
  hashPathBlob,
  hashTextBlob,
  type OperationAdmissionContext,
  type OperationLedger,
  type OperationLedgerPort
} from './operations.js';
import {
  createRecoveryOwner,
  continuationText,
  type ProgressMarker,
  type RecoveryOwner,
  type RecoveryRecord
} from './recovery.js';
import {
  autoBindPrimeController,
  observeWorkControllerMessage,
  observeWorkControllerSnapshot,
  bindWorkController,
  unbindWorkController,
  getWorkControllerBinding,
  getWorkControllerBindingByConversation,
  listWorkControllerWatches,
  setWorkControllerEnabled,
  claimWorkControllerTurn,
  completeWorkControllerTurnClaim,
  releaseWorkControllerTurnClaim,
  workControllerMessageOrigin,
  type WorkControllerObservationResult,
  type WorkMessageOrigin
} from './continuity.js';
import {
  attachWorkChanges,
  createWorkService,
  setWorkService,
  subscribeWorkChanges,
  type WorkRuntimeControl,
  type WorkRuntimeControlResult,
  type WorkRuntimeDelivery,
  type WorkRuntimeDeliveryResult,
  type WorkRuntimePort,
  type WorkRuntimeReconcileInput,
  type WorkRuntimeStart,
  type WorkServiceHandle
} from './service.js';
import {
  createWorkStore,
  type WorkAgentRow,
  type WorkArtifactRow,
  type WorkOperationRow,
  type WorkRow,
  type WorkStore
} from './store.js';
import {
  WORK_BLOCKER_CODES,
  WORK_ERROR_CODES,
  WORK_EVENT_KINDS,
  WorkServiceError as WorkError
} from '../../shared/work.js';
import {
  fail,
  ok,
  type ManagedToolGate,
  type ManagedToolInvocation,
  type ToolResult
} from '../mcp/kernel.js';
import type { CallContext } from '../mcp/call-context.js';
import type { WorktreeManager } from './worktrees.js';
import type { ApplyPatchAction } from '../codex/apply-patch/index.js';

/**
 * The continuity surface, re-exported so a host can reach it through the runtime module it
 * already imports. The implementation lives in `continuity.ts`; nothing is re-implemented here.
 */
export {
  observeWorkControllerMessage,
  observeWorkControllerSnapshot,
  listWorkControllerWatches,
  bindWorkController,
  unbindWorkController,
  getWorkControllerBinding,
  getWorkControllerBindingByConversation,
  setWorkControllerEnabled,
  claimWorkControllerTurn,
  completeWorkControllerTurnClaim,
  releaseWorkControllerTurnClaim,
  workControllerMessageOrigin,
  type WorkControllerObservationResult,
  type WorkMessageOrigin
};

// --------------------------------------------------------------------------- errors

/**
 * A managed call that could not be attributed to a live work generation.
 *
 * Thrown synchronously, because the kernel's pre-dispatch validation is synchronous: a stale
 * generation must be refused before any broker liveness bookkeeping runs, not after.
 */
export class ManagedCallerError extends Error {
  readonly code: string;
  readonly detail?: string;
  constructor(code: string, message: string, detail?: string) {
    super(`${code}: ${message}`);
    this.name = 'ManagedCallerError';
    this.code = code;
    this.detail = detail;
  }
}

/** The host has not started its durable work ledger. A refusal, never a fail-open. */
export class WorkServiceUnavailable extends Error {
  readonly code = 'WORK_SERVICE_UNAVAILABLE';
  constructor() {
    super('WORK_SERVICE_UNAVAILABLE: the host has not restored its durable work ledger yet. No local tool ran.');
    this.name = 'WorkServiceUnavailable';
  }
}

/**
 * The resolved identity of one managed caller, owned by `control-source.ts`.
 *
 * Re-exported rather than re-declared: the module that resolves a target is the module that decides
 * what a resolved target is, and two structurally identical interfaces would be two places for the
 * two to drift apart.
 */
export type { ManagedWorkerIdentity };

// --------------------------------------------------------------------------- deps

/** One in-flight managed call, scoped for the duration of its handler. */
interface ManagedCallState {
  identity: ManagedWorkerIdentity;
  operationId: string | null;
  tool: string;
}

const managedCall = new AsyncLocalStorage<ManagedCallState>();
const pendingExec = new Map<string, { identity: ManagedWorkerIdentity; done: Promise<ToolResult> }>();
const liveExec = new Map<string, { identity: ManagedWorkerIdentity; terminate: () => Promise<boolean>; settled: Promise<void> }>();

/**
 * The GUI lease and external-call classifier, owned by the CUA gateway. Injected rather than
 * imported so this module has no dependency on the plugin/CUA stack and a host without it
 * still runs managed coding work.
 */
export interface ManagedCuaBridge {
  /** Fail-closed read-only classifier over the enabled external catalog. */
  isReadOnlyExternalCall(args: unknown): boolean;
  /** Whether a dispatched external call's outcome is genuinely ambiguous. */
  externalCallOutcome(result: ToolResult): 'completed' | 'outcome_unknown';
  /** Release the host-wide GUI lease after pause/cancel/complete/shutdown. */
  releaseGuiLease(workId: string): Promise<void>;
  /** Wake works blocked on CUA_BUSY. */
  onGuiLeaseReleased(listener: (workId: string) => void): () => void;
}

/**
 * The bridge's existing recovery primitives. `requestManagedReload` must be the *same* one-shot
 * reload the unmanaged silence path uses, never a second mechanism.
 */
export interface ManagedBridgeBridge {
  isManaged(conversationId: string): boolean;
  requestManagedReload(input: { sessionId: string; conversationId: string; reason: string }): boolean;
  onTurnFailure(input: { sessionId: string; conversationId: string; turnId: string; reason: 'thinking_failed' | 'transport_failure' }): boolean;
  onSilence(input: { sessionId: string; conversationId: string; turnId: string; pro: boolean }): boolean;
  onProgress(input: { sessionId: string; conversationId: string; turnId: string }): void;
}

/** Persists one bounded search page and returns its durable artifact row. */
export interface SearchArtifactRecord {
  workId: string;
  agentId: string | null;
  sessionId: string;
  kind: string;
  queryHash: string | null;
  pageIndex: number;
  pageCount: number;
  hitCount: number;
  totalHits: number;
  truncatedReason: string | null;
  text: string;
}

export interface SearchArtifactStore {
  recordArtifact(input: SearchArtifactRecord): Promise<WorkArtifactRow>;
  getArtifact(cursor: string): Promise<WorkArtifactRow | null>;
  /**
   * Every retained page of one run.
   *
   * A run is split across several pages and a cursor names one of them, so the next cursor
   * has to name the *following* page of the same run. Without this, paging could only ever
   * see the page it was handed and a large run would silently truncate.
   */
  listArtifacts(input: { workId: string; kind?: string; queryHash?: string }): Promise<WorkArtifactRow[]>;
}

export interface ManagedSearchContext {
  owner: { workId: string; agentId: string; sessionId: string };
  worktreePath: string;
  artifacts: SearchArtifactStore;
}

export interface WorkRuntimeDeps {
  dataDir: string;
  worktreesRoot: string;
  worktrees: WorktreeManager;
  store?: WorkStore;
  now?: () => number;
  /**
   * Delivery of one durable command; production is `sendDesktopInput`.
   *
   * `dueAt` is the durable command's own `created_at`, never a fresh `Date.now()`: the outbox uses
   * it for the first enqueue of that input id, so a retry schedules against the same instant and
   * the same message cannot look like a new one on every attempt.
   *
   * Optional, and null is a real answer rather than a missing feature: a standalone daemon has no
   * browser page to type into, so it installs no delivery path at all. A work started there is
   * admitted and durably recorded exactly as everywhere else, and its first delivery reports
   * `failed` with "no delivery path is installed" — the truth — instead of a fabricated `queued`
   * that nothing would ever send.
   */
  deliverOutbox?: (input: WorkOutboxDelivery) => Promise<WorkOutboxResult>;
  /**
   * Read-only projection of one already-admitted outbox row, or null when there is none.
   *
   * A stopped work must still reconcile an input that was already authorized before the stop: the
   * native receipt may land later, and refusing to look would hide it behind the stop forever.
   * This never sends, never wakes and never re-admits.
   */
  readOutbox?: (id: string) => Promise<WorkOutboxResult | null>;
  /**
   * Withdraws one still-unclaimed outbox row, atomically with the outbox's own unsent check.
   *
   * Returns true only when non-delivery is provable. False means the row may already have been
   * submitted, which is exactly the case a stop must not rewrite into a cancellation.
   */
  cancelOutbox?: (id: string) => Promise<boolean>;
}

/** One message handed to the durable input outbox. */
export interface WorkOutboxDelivery {
  id: string;
  sessionId: string | null;
  text: string;
  model: string | null;
  reasoning: string | null;
  /** Stable scheduling instant for the first enqueue of this input id. */
  dueAt: number;
  /**
   * The work this message belongs to, for the outbox's own final Send authority.
   *
   * A managed instruction must not be sent into a work the user has stopped, nor into a chat that
   * is no longer that work's prime, so the row records which work it answers to.
   */
  workId: string;
}

/**
 * What the outbox established, in the outbox's own vocabulary.
 *
 * `delivered` requires positive proof of receipt; `queued` is accepted-but-not-acknowledged;
 * `unknown` is an attempted hand-off whose outcome cannot be established and is never re-sent.
 */
export type WorkOutboxResult = { state: 'queued' | 'delivered' | 'unknown' | 'failed' | 'cancelled'; error?: string | null };

export interface WorkRuntimeHandle {
  service: WorkServiceHandle;
  operations: OperationLedger;
  recovery: RecoveryOwner;
  store: WorkStore;
  worktrees: WorktreeManager;
  /** Delivery of one outbox message; production wires `sendDesktopInput` here. */
  deliver: ((input: WorkOutboxDelivery) => Promise<WorkOutboxResult>) | null;
  /** Read-only reconciliation of an already-admitted outbox row; never sends. */
  readOutbox: ((id: string) => Promise<WorkOutboxResult | null>) | null;
  /** Atomic withdrawal of one still-unclaimed outbox row; false means it may already be sent. */
  cancelOutbox: ((id: string) => Promise<boolean>) | null;
  /** Pause/cancel drain: fence every agent, terminate owned processes, release the GUI lease. */
  drain(): Promise<void>;
  /** Startup reconciliation, run before the endpoint admits anything. */
  reconcile(): Promise<void>;
}

// --------------------------------------------------------------------------- module state

let runtime: WorkRuntimeHandle | null = null;
let runtimePromise: Promise<WorkRuntimeHandle> | null = null;
/** Detaches the store's change stream when the runtime is drained or reset. */
let detachChanges: (() => void) | null = null;
/** Detaches the power-assertion subscriber. */
let detachPower: (() => void) | null = null;
/** Set while shutdown has begun: admissions are refused even if the service is still live. */
let shuttingDown = false;

function current(): WorkRuntimeHandle {
  if (!runtime) throw new WorkServiceUnavailable();
  return runtime;
}

// --------------------------------------------------------------------------- identity

function requireIdentity(context: CallContext | null): ManagedWorkerIdentity {
  if (!runtime || shuttingDown) throw new WorkServiceUnavailable();
  const conversationId = context?.caller.conversationId ?? null;
  if (!conversationId) {
    throw new ManagedCallerError(
      'WORKER_CONNECTION_REQUIRED',
      'this call has no managed conversation of its own. Name the work explicitly with a work_id (and optionally agent_id), or use the direct work tool with action="start", "list" or "status". No local tool ran.'
    );
  }
  return managedTargetIdentity({ conversationId });
}

/**
 * Provenance for one managed call, or a typed refusal.
 *
 * Synchronous on purpose: the kernel's pre-dispatch validation calls this before any broker
 * bookkeeping, and a stale generation must not be able to cause worker lifecycle effects.
 */
export function assertManagedCaller(context: CallContext | null, target?: WorkTarget | null): ManagedWorkerIdentity {
  return target ? managedTargetIdentity(target) : requireIdentity(context);
}

/** Whether this conversation belongs to a managed work, without throwing. */
export function isManagedConversation(conversationId: string | null | undefined): boolean {
  if (!conversationId || !runtime) return false;
  return runtime.store.getAgentByConversation(conversationId) !== null;
}

// --------------------------------------------------------------------------- mutation gate

/** Child effects own receipts. The exec composer has no aggregate mutation to replay. */
const MUTATING_TOOLS = new Set(['apply_patch', 'exec_command', 'write_stdin', 'agents', 'mcp_call', 'work_checkpoint']);

function requiresOperationId(invocation: ManagedToolInvocation, cua: ManagedCuaBridge | null): boolean {
  if (invocation.surface === 'plugins') return invocation.external !== undefined;
  if (invocation.surface !== 'core') return false;
  if (!MUTATING_TOOLS.has(invocation.name)) return false;
  const args = invocation.args && typeof invocation.args === 'object' ? invocation.args as Record<string, unknown> : {};
  if (invocation.name === 'write_stdin') {
    // An empty poll is a status read; only real input is a mutation.
    const chars = args['chars'];
    return typeof chars === 'string' && chars.length > 0;
  }
  if (invocation.name === 'agents') {
    const action = args['action'];
    // Status is a read. spawn/message/finish/integrate all mutate.
    return action !== 'status';
  }
  if (invocation.name === 'mcp_call') {
    return !(cua?.isReadOnlyExternalCall(invocation.args) === true);
  }
  return true;
}

function operationIdOf(invocation: ManagedToolInvocation): string | null {
  const args = invocation.args;
  if (!args || typeof args !== 'object') return null;
  const value = (args as Record<string, unknown>)['operation_id'];
  return typeof value === 'string' && /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(value) ? value : null;
}

/**
 * A managed admission refusal.
 *
 * Every code this gate produces — `WORKER_CONNECTION_REQUIRED`, `STALE_AGENT_GENERATION`,
 * `WORK_NOT_RUNNING`, `STATE_UNAVAILABLE`, `OPERATION_ID_REQUIRED`, `OPERATION_ID_CONFLICT`,
 * `OPERATION_UNKNOWN_UNRESOLVED` — is a known refusal with its own actionable text. None of them
 * means "the browser identity was lost": the kernel's true `!conversationId` path owns that
 * advisory, and it runs before this gate. Rendering these through `failIdentity` appended a false
 * "Identity recovered" notice to correct refusals.
 */
function denial(result: { code: string; message: string }): ToolResult {
  return fail(`${result.code}: ${result.message}`);
}

/** The runtime's own typed refusal rendered for the model, or null when this is not one. */
function denialFor(error: unknown): ToolResult | null {
  if (error instanceof ManagedCallerError) return denial({ code: error.code, message: error.message.replace(/^[A-Z_]+: /, '') });
  if (error instanceof WorkServiceUnavailable) return denial({ code: error.code, message: error.message.replace(/^[A-Z_]+: /, '') });
  return null;
}

/**
 * Tools whose *contract* is a managed work's lifecycle.
 *
 * Everything else — reading, searching, running a command, applying a patch, calling an external
 * tool — is ordinary coding. Those calls may still earn a durable receipt when their conversation
 * happens to be bound to a live work, but their execution never depends on that binding: a chat
 * whose work was paused, cancelled, completed, superseded or is simply unreachable still reads,
 * runs and patches, because a work's lifecycle is not a licence for the coding tools.
 */
const WORK_LIFECYCLE_TOOLS = new Set(['agents', 'work_checkpoint', 'work_resume']);

/** What this call's own conversation turned out to be. */
type GateTarget =
  /** Names no work: ordinary coding, admitted by permissions and the sandbox. */
  | { kind: 'ordinary' }
  | { kind: 'resolved'; identity: ManagedWorkerIdentity }
  | { kind: 'refused'; code: string; message: string };

/**
 * The work a call's proven conversation names, if it names one at all.
 *
 * Only an *existing* binding can make a call managed, and a conversation this ledger has never
 * heard of is an ordinary chat — as is a call from a host that has not restored its ledger yet.
 * Both run with their existing permissions rather than being refused for not being a worker.
 *
 * `strict` is the difference between the two kinds of caller. A work lifecycle command (`agents`)
 * is *about* the work, so a work that is paused, cancelled, completed or unreachable is a refusal
 * by name. An ordinary coding call is not, so the same unresolvable binding simply means "no
 * receipt" and the call proceeds — which is what keeps a stale or paused work from taking a chat's
 * ability to read a file or run a build down with it.
 */
function conversationTarget(context: CallContext, strict: boolean): GateTarget {
  const conversationId = context.caller.conversationId ?? null;
  if (!conversationId || !runtime) return { kind: 'ordinary' };
  if (!runtime.store.getAgentByConversation(conversationId)) return { kind: 'ordinary' };
  if (shuttingDown) {
    return strict
      ? {
          kind: 'refused',
          code: 'WORK_SERVICE_UNAVAILABLE',
          message: 'this host is shutting down, so its managed work no longer accepts calls. No local tool ran.'
        }
      : { kind: 'ordinary' };
  }
  const resolved = resolveWorkTarget(runtime.store, { conversationId });
  if (resolved.kind === 'resolved') return { kind: 'resolved', identity: resolved.identity };
  return strict ? resolved : { kind: 'ordinary' };
}

/**
 * Re-reads the exact target a call was admitted under, immediately before its side effect.
 *
 * Admission yields, so a pause, a cancel, a completion or a rebound conversation can land while a
 * mutation is waiting. Re-resolving the *same* target — never a fresh guess — is the one fence
 * still ahead of the write. Only a call that was admitted *because* it names a work is refused
 * when that work has moved on; an ordinary coding call keeps its right to run.
 */
function assertTargetStillAdmissible(
  context: CallContext,
  explicit: { workId: string; agentId: string | null } | null,
  strict: boolean
): void {
  if (explicit) {
    assertManagedCaller(null, { workId: explicit.workId, agentId: explicit.agentId });
    return;
  }
  const resolved = conversationTarget(context, strict);
  if (resolved.kind === 'resolved' || !strict) return;
  if (resolved.kind === 'refused') throw new ManagedCallerError(resolved.code, resolved.message);
  throw new ManagedCallerError(
    'WORKER_CONNECTION_REQUIRED',
    'this conversation is no longer a managed work’s own agent conversation, so this call was not run. No local tool ran.'
  );
}

/**
 * The admission gate installed on the MCP kernel.
 *
 * Order matters and is the whole contract:
 * identity → work/generation fence → operation-id requirement → durable admission →
 * `running` before the handler → result recorded before publication.
 */
export const managedToolGate: ManagedToolGate = async (invocation, invoke) => {
  // Ordinary coding never inherits admission requirements from a conversation binding.
  if (!WORK_LIFECYCLE_TOOLS.has(invocation.name)) return invoke();
  // A call is *managed* because it names a work, and there are exactly two ways to do that.
  //
  // An explicit `work_id` (with an optional `agent_id`) is the caller naming its target outright,
  // which is what lets `work_checkpoint` and `work_resume` run from a client whose page is
  // deliberately closed; the ids are resolved against the durable ledger and nothing is inferred.
  // Otherwise the call's own proven conversation decides — but only if that conversation is
  // already a managed work's agent conversation.
  //
  // A call that names neither is ordinary coding. It runs with the caller's existing permissions
  // and the approved-root sandbox, and it gets no work receipt because it is not an operation of
  // any work. That is the whole point of this gate being about *work*, not about transport: a
  // fresh chat, a phone, a headless client or an unrestored ledger must never turn a read, a
  // command or a patch into a refusal to be a worker.
  const explicit = invocation.name === 'work_checkpoint' || invocation.name === 'work_resume'
    ? explicitWorkTarget(invocation.args)
    : null;
  let identity: ManagedWorkerIdentity | null;
  if (explicit) {
    try {
      identity = assertManagedCaller(null, { workId: explicit.workId, agentId: explicit.agentId });
    } catch (error) {
      const refusal = denialFor(error);
      if (refusal) return refusal;
      throw error;
    }
  } else {
    // A work lifecycle command is answered by the work it names; an ordinary coding call is only
    // ever *enriched* by a live binding, never gated on one.
    const strict = WORK_LIFECYCLE_TOOLS.has(invocation.name);
    const resolved = conversationTarget(invocation.context, strict);
    if (resolved.kind === 'ordinary') return invoke();
    if (resolved.kind === 'refused') return denial({ code: resolved.code, message: resolved.message });
    identity = resolved.identity;
  }
  const active = current();
  const cua = activeCua();
  const needsId = requiresOperationId(invocation, cua);
  const operationId = invocation.surface === 'plugins' && !invocation.external ? null : operationIdOf(invocation);
  const receiptTool = invocation.external ? `plugins:${invocation.external.installationId}:${invocation.external.toolName}` : invocation.name;
  const scope = invocation.external ? JSON.stringify([invocation.external.installationId, invocation.external.toolName, invocation.external.schemaHash]) : undefined;
  if (needsId && !operationId) {
    return fail(
      'OPERATION_ID_REQUIRED: this managed mutation needs an `operation_id` (a UUID you generate for this exact call). ' +
      'Reuse the same id only when retrying this identical call. No local tool ran.'
    );
  }
  // Read-only managed calls run without a receipt but still carry identity for the handler.
  if (!operationId) {
    return managedCall.run({ identity, operationId: null, tool: invocation.name }, () => invoke());
  }

  const sessionId = identity.sessionId ?? await resolveSessionId(invocation.context);
  let admission = await active.operations.admit({
    operationId,
    workId: identity.workId,
    agentId: identity.agentId,
    generation: identity.generation,
    tool: receiptTool,
    scope,
    args: invocation.args,
    sessionId
  });
  if (admission.kind === 'rejected') {
    return denial({ code: admission.code, message: admission.message.replace(/^[A-Z_]+: /, '') });
  }
  if (admission.kind === 'retry') {
    // The user authorized exactly one retry of an unknown operation. It runs under the fresh
    // id, linked back to the unknown row, and only this once.
    admission = await active.operations.admit({
      operationId: admission.retryOperationId,
      workId: identity.workId,
      agentId: identity.agentId,
      generation: identity.generation,
      tool: receiptTool,
      scope,
      args: invocation.args,
      sessionId
    });
    if (admission.kind === 'rejected') {
      return denial({ code: admission.code, message: admission.message.replace(/^[A-Z_]+: /, '') });
    }
  }
  if (admission.kind === 'joined') {
    if (admission.replay) return admission.replay;
    if (admission.pending) return admission.pending;
    return fail(
      'OPERATION_IN_PROGRESS: this exact operation was already accepted and is still running. Its result will be returned to the original call; do not repeat it.'
    );
  }

  const admittedId = admission.operationId;
  let invoked = false;
  const run = (async (): Promise<ToolResult> => {
    // Admission yields: a pause may have fenced this generation before execution resumes, and a
    // contradictory ancestor may have landed for this request while it waited. Both are re-read
    // here, at the last moment before the handler, because this is the only fence that is still
    // ahead of the side effect.
    assertTargetStillAdmissible(invocation.context, explicit, WORK_LIFECYCLE_TOOLS.has(invocation.name));
    active.operations.markRunning(admittedId);
    // A managed worker's finish publishes a branch as the result of its work, so the branch is
    // checkpointed here — before the broker's durable finish barrier — rather than after. A
    // checkpoint that cannot be taken refuses the finish instead of publishing a stale tree.
    if (invocation.surface === 'core' && invocation.name === 'agents' && (invocation.args as { action?: unknown } | null)?.action === 'finish' && identity.role === 'worker') {
      const refusal = await checkpointWorkerBeforeFinish(active, identity, admittedId);
      if (refusal) {
        await active.operations.fail(admittedId, refusal, sessionId);
        return fail(refusal);
      }
    }
    // The evidence is recorded here, on the one path that is by construction an admitted managed
    // mutation: the receipt exists and the handler is about to run. It is durable-or-refuse, so a
    // side effect can never happen without the receipt that proves it.
    if (!recordNativeExecution(identity.workId, identity, admittedId, receiptTool, invocation.context)) {
      const refusal = 'NATIVE_EVIDENCE_UNAVAILABLE: this managed call could not record the durable receipt that proves which controller turn executed it, so it was not run. No local tool ran; retry this call.';
      await active.operations.fail(admittedId, refusal, sessionId);
      return fail(refusal);
    }
    invoked = true;
    const result = await managedCall.run(
      { identity, operationId: admittedId, tool: receiptTool },
      () => invoke()
    );
    if ((invocation.external || (invocation.surface === 'core' && invocation.name === 'mcp_call')) && externalCallOutcome(result) === 'outcome_unknown') {
      active.operations.markUnknown(admittedId, 'external MCP call returned an ambiguous outcome');
      return result;
    }
    const terminate = invocation.surface === 'core' && invocation.name === 'exec_command' ? invocation.context.terminateProcess : undefined;
    const completion = invocation.context.evidence.processCompletion;
    const processId = invocation.context.evidence.processSessionId;
    if (terminate && completion && processId && invocation.context.evidence.running === true) {
      active.operations.markRunning(admittedId, processId);
      const settled = completion.then(async completion => {
        const text = `EXEC_COMPLETED: process session ${processId} ended with exit code ${completion.exitCode ?? 'unavailable'}. Unread output remains available through write_stdin.`;
        await active.operations.complete({ operationId: admittedId, sessionId, processId,
          result: completion.exitCode === 0 || completion.benignExit ? ok(text) : fail(text) });
      }).catch((error: unknown) => {
        active.operations.markUnknown(admittedId, error instanceof Error ? error.message : String(error));
      }).finally(() => { liveExec.delete(admittedId); });
      liveExec.set(admittedId, { identity, terminate, settled });
    } else {
      await active.operations.complete({ operationId: admittedId, result, sessionId });
    }
    return result;
  })().catch(async (error: unknown) => {
    const message = error instanceof Error ? error.message : String(error);
    // A transport-level ambiguity is never recorded as a settled failure: the side effect may
    // already have happened, and a settled row would invite a blind replay. A refusal that
    // provably never dispatched is the opposite case and settles as a normal failure.
    if (invoked && (invocation.external || (invocation.surface === 'core' && invocation.name === 'mcp_call')) && !(error instanceof ExternalNotDispatched)) {
      active.operations.markUnknown(admittedId, message);
    } else {
      await active.operations.fail(admittedId, message, sessionId);
    }
    throw error;
  });
  active.operations.track(admittedId, run);
  if (invocation.surface === 'core' && invocation.name === 'exec_command') {
    pendingExec.set(admittedId, { identity, done: run });
    const clear = (): void => { pendingExec.delete(admittedId); };
    void run.then(clear, clear);
  }
  return run;
};

/**
 * Provider requests that have already recorded their native-execution evidence.
 *
 * ChatGPT stamps every MCP call with its own request id, and one workflow request can cover several
 * connector calls. The evidence is about the *request*, so it is written once: the ledger stays a
 * record of work, not of transport retries.
 */
const recordedNativeExecutions = new Set<string>();

function nativeExecutionKey(workId: string, providerRequestId: string): string {
  return `${workId}\u0000${providerRequestId}`;
}

/**
 * Records that one provider request really executed managed work.
 *
 * This is the evidence a mobile controller needs: the controller conversation's own turn can drive
 * this work, and the only honest proof of that is a call the host actually admitted. It is written
 * on the admitted path of the managed gate — after the durable receipt, before the handler — and it
 * carries the exact host caller's provider request id, so it can be joined against the page's own
 * record of which question that request belonged to.
 *
 * Nothing here is inferred: an unscoped read, a rejected call or a completed call never reaches this
 * point.
 */
function recordNativeExecution(workId: string, identity: ManagedWorkerIdentity, operationId: string, tool: string, context: CallContext): boolean {
  const providerRequestId = context.caller.requestId;
  // No provider request id means no controller turn can be claiming this call, so there is nothing
  // to prove and nothing to refuse.
  if (!providerRequestId) return true;
  const key = nativeExecutionKey(workId, providerRequestId);
  if (recordedNativeExecutions.has(key)) return true;
  try {
    // The durable lookup is the real coalescing: the in-process set is only a cache, and after a
    // restart it is empty while the ledger still holds the row.
    if (!nativeExecutionRecorded(workId, providerRequestId)) {
      runtime?.store.appendEvent(workId, 'native_execution', {
        provider_request_id: providerRequestId,
        agent_id: identity.agentId,
        generation: identity.generation,
        operation_id: operationId,
        tool
      });
    }
  } catch (error) {
    // This receipt is the duplicate-prevention authority, so it is not optional: without it a
    // controller message this call really executed would later look unhandled and be relayed a
    // second time. The mutation is refused instead, and nothing is cached.
    logWarn(`work ${workId.slice(0, 8)} refused a managed call: its native execution evidence could not be recorded (${(error as Error).message})`);
    return false;
  }
  // Cached only after the durable commit, so a failed write cannot make later calls for the same
  // provider request skip their retry.
  recordedNativeExecutions.add(key);
  if (recordedNativeExecutions.size > NATIVE_EXECUTION_MAX) {
    const oldest = recordedNativeExecutions.keys().next().value;
    if (oldest !== undefined) recordedNativeExecutions.delete(oldest);
  }
  return true;
}

/** Bound on the in-process coalescing set; the durable event is the record that matters. */
const NATIVE_EXECUTION_MAX = 2_000;
/** Events read per page while proving whether one provider request already has its evidence. */
const NATIVE_EXECUTION_PAGE = 500;

/**
 * Whether this work has durable evidence that one provider request executed managed work.
 *
 * Deliberately independent of the current prime session or generation: a prime may have been
 * replaced since, and that must not erase the fact that it really did the work.
 *
 * The scan is exact, not a bounded tail: an accepted execution can lie arbitrarily far behind, and
 * a window would answer "no evidence" for a request that really ran — which is how a message that
 * was already handled would be relayed a second time. So the read pages to the end of the work's
 * own events.
 */
export function hasNativeExecution(input: { workId: string; providerRequestId: string | null | undefined }): boolean {
  if (!input.providerRequestId || !runtime) return false;
  return nativeExecutionRecorded(input.workId, input.providerRequestId);
}

/** Pages one work's own events to the end, looking for the exact provider request's evidence. */
function nativeExecutionRecorded(workId: string, providerRequestId: string): boolean {
  const store = runtime?.store;
  if (!store) return false;
  let cursor = 0;
  for (;;) {
    const { events, hasMore } = store.readEvents({ workId, after: cursor, limit: NATIVE_EXECUTION_PAGE });
    for (const event of events) {
      if (event.kind === 'native_execution' && event.payload['provider_request_id'] === providerRequestId) return true;
    }
    if (!hasMore || events.length === 0) return false;
    cursor = events[events.length - 1]!.sequence;
  }
}

/**
 * Live mutations started by one agent, excluding an operation that is *this* call.
 *
 * The finish's own operation is `running` while the handler executes, so counting it would make
 * every finish permanently busy with itself.
 */
function liveMutations(active: WorkRuntimeHandle, identity: ManagedWorkerIdentity, ownOperationId: string | null): WorkOperationRow[] {
  return active.store.listOperationsForAgent(identity.agentId, identity.generation)
    .filter(row => (row.state === 'running' || row.state === 'prepared') && row.operation_id !== ownOperationId);
}

/**
 * Checkpoints a managed worker's private branch immediately before its finish is accepted.
 *
 * This is what makes "finished" mean something: the recorded commit is the tree the worker
 * actually produced, taken while the branch is still in the state the worker left it.
 */
async function checkpointWorkerBeforeFinish(
  active: WorkRuntimeHandle,
  identity: ManagedWorkerIdentity,
  ownOperationId: string
): Promise<string | null> {
  const live = liveMutations(active, identity, ownOperationId);
  if (live.length > 0) {
    return `WORKER_BUSY: ${live.length} operation(s) started by this agent are still live (${live.map(row => `${row.tool}:${row.operation_id}`).join(', ')}). Wait for them to settle, then finish again.`;
  }
  try {
    const checkpoint = await active.worktrees.finishWorker({
      workId: identity.workId,
      agentId: identity.agentId,
      message: `wgpt: ${identity.agentId} finish`
    });
    active.store.updateAgent(identity.agentId, { result_ref: `${checkpoint.commit}:${checkpoint.treeHash}` });
    active.store.appendEvent(identity.workId, 'worker_checkpointed', {
      agent_id: identity.agentId,
      generation: identity.generation,
      commit: checkpoint.commit,
      tree_hash: checkpoint.treeHash,
      changed_files: checkpoint.changedFiles.length,
      noop: checkpoint.noop
    });
    return null;
  } catch (error) {
    return `WORKTREE_FAILED: your branch could not be checkpointed, so this finish was refused: ${(error as Error).message}`;
  }
}

/** Resolves the durable session behind a proven conversation. */
async function resolveSessionId(context: CallContext): Promise<string | null> {
  if (context.caller.sessionId) return context.caller.sessionId;
  const conversationId = context.caller.conversationId;
  if (!conversationId) return null;
  try {
    const session = await findSessionByConversation(conversationId, { requireUnique: true });
    return session?.id ?? null;
  } catch {
    return null;
  }
}

let cuaBridge: ManagedCuaBridge | null = null;
function activeCua(): ManagedCuaBridge | null {
  return cuaBridge;
}

// --------------------------------------------------------------------------- patch intent

/**
 * Records what a verified patch is about to change, before it changes anything.
 *
 * A crash after the writes but before the receipt would otherwise leave a mutation whose
 * outcome cannot be reconstructed. Recording the pre-write blob hash and the *expected*
 * post-write hash lets recovery distinguish "nothing landed", "all of it landed" and "some of
 * it landed" without guessing.
 *
 * A true no-op for an unmanaged call (no gate context) — the old code paths keep working.
 */
export async function recordManagedPatchIntent(action: ApplyPatchAction): Promise<void> {
  const state = managedCall.getStore();
  if (!state?.operationId) return;
  const active = runtime;
  if (!active) return;
  const cwd = action.cwd;
  const paths = [...action.expectedFiles.keys()];
  if (paths.length === 0) return;
  // Throws on a read failure rather than recording nothing: an unrecorded expectation is worse
  // than a refused patch, because it turns a recoverable ambiguity into a silent one.
  const before: Record<string, string | null> = {};
  for (const spelled of paths) before[spelled] = await hashPathBlob(path.resolve(cwd, spelled));
  const expected: Record<string, string | null> = {};
  for (const [spelled, file] of action.expectedFiles) {
    expected[spelled] = file.present ? hashTextBlob(file.content) : null;
  }
  active.operations.setExpectations(state.operationId, { before, after: expected });
  active.store.appendEvent(state.identity.workId, 'operation_prepared', {
    operation_id: state.operationId,
    tool: state.tool,
    agent_id: state.identity.agentId,
    generation: state.identity.generation,
    patch_paths: paths.slice(0, 200)
  });
}

/**
 * Reconciles a patch operation after the fact: re-hashes every recorded path and reports which
 * of the three recoverable states the tree is actually in.
 */
export async function reconcilePatchOperation(operationId: string, cwd: string): Promise<'all_before' | 'all_after' | 'mixed' | 'unchanged' | 'unknown'> {
  const active = runtime;
  if (!active) return 'unknown';
  const record = active.store.getOperation(operationId);
  if (!record?.expect_before) return 'unknown';
  const { after, summary } = await capturePatchAfterHashes(record.expect_before, cwd);
  const expected = record.expect_after;
  if (expected) {
    let matchesExpected = 0;
    let matchesBefore = 0;
    for (const key of Object.keys(expected)) {
      if (after[key] === expected[key]) matchesExpected += 1;
      if (after[key] === record.expect_before[key]) matchesBefore += 1;
    }
    const total = Object.keys(expected).length;
    if (matchesExpected === total) return 'all_after';
    if (matchesBefore === total) return 'all_before';
    if (matchesExpected === 0 && matchesBefore === 0) return 'mixed';
  }
  return summary;
}

// --------------------------------------------------------------------------- checkpoint / resume

const verificationSchema = z.object({ operation_id: z.uuid(), outcome: z.enum(['passed', 'failed']) }).strict();

/**
 * The live identity one explicit target names, or a typed refusal.
 *
 * This is the one authority behind every managed call, and `assertManagedCaller` below is the thin
 * conversation-shaped caller of it. It lives beside the checkpoint pair because that pair is the
 * caller that most needs it: a checkpoint addressed by `work_id` has no conversation to resolve
 * through, and inventing one — or falling back to whichever work is running — is exactly the
 * inference the explicit target exists to avoid.
 */
export function managedTargetIdentity(target: WorkTarget): ManagedWorkerIdentity {
  if (!runtime || shuttingDown) throw new WorkServiceUnavailable();
  const resolved = resolveWorkTarget(runtime.store, target);
  if (resolved.kind === 'refused') throw new ManagedCallerError(resolved.code, resolved.message);
  return resolved.identity;
}

/**
 * The checkpoint pair names its target the same two ways every managed call does.
 *
 * `work_id` (with an optional `agent_id`) is the explicit form, and it is what makes a checkpoint
 * usable from a client whose page is deliberately closed: the ids are resolved against the durable
 * ledger and nothing is inferred. Omitted, the call resolves through its own managed conversation.
 * Either way the ledger's own constraints apply — a work that is not running, an agent that is not
 * part of the named work, and a terminal work all refuse by name.
 */
export const workCheckpointSchema = z.object({
  summary: z.string().min(1).max(24 * 1024),
  remaining: z.array(z.string().min(1).max(4000)).max(100),
  verification: z.array(verificationSchema).max(100),
  operation_id: z.uuid(),
  complete: z.boolean().optional(),
  work_id: z.uuid().optional(),
  agent_id: z.uuid().optional()
}).strict().refine(value => Buffer.byteLength(JSON.stringify(value), 'utf8') <= 24 * 1024, 'Checkpoint exceeds the 24KiB limit');
export type WorkCheckpointInput = z.output<typeof workCheckpointSchema>;

export const workResumeSchema = z.object({
  operation_id: z.uuid().optional(),
  work_id: z.uuid().optional(),
  agent_id: z.uuid().optional()
}).strict();
export type WorkResumeInput = z.output<typeof workResumeSchema>;

/**
 * The target one checkpoint call names, or a refusal when it names neither form.
 *
 * A call with no explicit `work_id` and no managed conversation of its own has nothing to act on:
 * it is refused rather than resolved to whichever work happens to be around, because "the work this
 * app is running" is not a target a checkpoint may assume.
 */
function checkpointTarget(
  input: { work_id?: string; agent_id?: string },
  context: CallContext | null
): WorkTarget | string {
  if (input.work_id) return { workId: input.work_id, agentId: input.agent_id ?? null };
  if (input.agent_id) {
    return 'STATE_UNAVAILABLE: an agent_id alone does not identify a work; pass the work_id it belongs to. Nothing was recorded.';
  }
  const conversationId = context?.caller.conversationId ?? null;
  if (!conversationId) {
    return 'WORKER_CONNECTION_REQUIRED: this call names no work_id and has no managed conversation of its own, so there is no work to act on. Pass the work_id (and optionally agent_id) the receipt returned. Nothing was recorded.';
  }
  return { conversationId };
}

/**
 * Returns only a positively known ordinary conversation. An absent runtime, a runtime that is
 * shutting down, and a caller without a conversation remain unresolved so the existing service
 * and identity refusals stay authoritative.
 */
function knownUnboundConversation(context: CallContext | null): string | null {
  const conversationId = context?.caller.conversationId ?? null;
  if (!conversationId || !runtime || shuttingDown) return null;
  return runtime.store.getAgentByConversation(conversationId) ? null : conversationId;
}

/**
 * Saves the durable checkpoint for the calling agent's work.
 *
 * `complete: true` is a claim, and it is checked rather than believed: every recorded
 * verification must reference an operation that belongs to this work, every child agent must be
 * settled, and no integration may be outstanding.
 */
export async function workCheckpoint(input: WorkCheckpointInput, context: CallContext | null): Promise<ToolResult> {
  if (!input.work_id && !input.agent_id && knownUnboundConversation(context)) {
    return fail(
      'WORK_NOT_BOUND: this conversation is not connected to a managed work, so an untargeted checkpoint cannot be saved. ' +
      'Name the assigned work_id (and optionally agent_id). Ordinary read, exec_command, apply_patch and agents calls remain subject to their existing permissions and ownership checks. Nothing was recorded.'
    );
  }
  const target = checkpointTarget(input, context);
  if (typeof target === 'string') return fail(target);
  let identity: ManagedWorkerIdentity;
  try {
    identity = assertManagedCaller(context, target);
  } catch (error) {
    return identityRefusal(error);
  }
  const active = runtime!;
  for (const item of input.verification) {
    const operation = active.store.getOperation(item.operation_id);
    if (!operation || operation.work_id !== identity.workId) {
      return fail(`VERIFICATION_REFERENCE_INVALID: ${item.operation_id} is not an operation of this work. Nothing was recorded.`);
    }
  }
  const previous = active.store.getWork(identity.workId)?.checkpoint ?? null;
  const revision = (previous?.revision ?? 0) + 1;
  active.store.setCheckpoint(identity.workId, {
    revision,
    summary: input.summary,
    remaining: input.remaining,
    verification: input.verification,
    host_generated: false,
    updated_at: active.store.getWork(identity.workId)?.updated_at ?? Date.now()
  });
  active.store.updateAgent(identity.agentId, { checkpoint_ref: `${identity.workId}:${revision}` });
  active.store.appendEvent(identity.workId, WORK_EVENT_KINDS.checkpointUpdated, {
    operation_id: input.operation_id,
    agent_id: identity.agentId,
    generation: identity.generation,
    revision,
    complete: input.complete === true
  });
  active.recovery.noteProgress({
    kind: 'progress',
    workId: identity.workId,
    agentId: identity.agentId,
    sessionId: identity.sessionId ?? '',
    // The caller's own conversation is optional metadata here: a remote checkpoint has none, and
    // an empty string is the honest record of that.
    conversationId: context?.caller.conversationId ?? '',
    turnId: context?.caller.requestId ?? '',
    generation: identity.generation,
    at: Date.now(),
    marker: { kind: 'operation', inputHash: `checkpoint:${revision}`, resultHash: `${input.verification.length}` }
  });
  if (input.complete === true) {
    const refusal = completionRefusal(active, identity);
    if (refusal) return fail(refusal);
    active.store.setWorkStatus(identity.workId, 'completed', WORK_EVENT_KINDS.workCompleted);
    active.store.setBlocker(identity.workId, null, WORK_EVENT_KINDS.workCompleted);
    if (cuaBridge) void cuaBridge.releaseGuiLease(identity.workId).catch(() => undefined);
    return ok(`Work ${identity.workId} is marked completed. Checkpoint revision ${revision} recorded with ${input.verification.length} verification reference(s).`);
  }
  return ok(`Checkpoint revision ${revision} recorded for ${identity.workId}. Remaining items: ${input.remaining.length}. Verification references: ${input.verification.length}.`);
}

/** Whether the work really is finished: terminal children, no outstanding integration. */
function completionRefusal(active: WorkRuntimeHandle, identity: ManagedWorkerIdentity): string | null {
  if (identity.role !== 'prime') {
    return 'NOT_PRIME: only the prime agent may mark a work complete. Report to the prime with agents action=finish instead.';
  }
  const work = active.store.getWork(identity.workId);
  if (!work) return 'STATE_UNAVAILABLE: the work row could not be read.';
  if (work.integration_intent && work.integration_intent.status === 'running') {
    return 'INTEGRATION_OUTSTANDING: an integration is still in flight in the integration worktree. Resolve it before marking the work complete.';
  }
  const unsettled = active.store.listAgents(work.work_id)
    .filter(agent => agent.role === 'worker' && !['finished', 'failed'].includes(agent.state));
  if (unsettled.length > 0) {
    return `CHILDREN_UNSETTLED: ${unsettled.map(agent => `${agent.agent_id}(${agent.state})`).join(', ')} are still live. Finish or fail them, then mark the work complete.`;
  }
  // An instruction the user already sent, but which the conversation has not taken yet, must not
  // be stranded by a completion: `completed` is terminal for this work, and a queued instruction
  // would then have nowhere to run. Start commands are excluded — their delivery state is the
  // admission stage's own outcome, not a message waiting for the browser.
  // Work, kind and delivery state are all matched inside SQL before the limit, so neither another
  // work's backlog nor a truncation of this work's own rows can hide a still-undelivered
  // instruction and let a work complete on top of it.
  if (active.store.hasOutstandingInstruction(work.work_id)) {
    return 'INSTRUCTION_OUTSTANDING: an instruction the user already sent has not reached this conversation yet. ' +
      'Wait for it to be delivered, or let it complete the work itself.';
  }
  // The completing checkpoint is already admitted and running. Only that exact receipt
  // is exempt; unrelated mutations (including other checkpoints) still block completion.
  const own = managedCall.getStore();
  const ownId = own?.tool === 'work_checkpoint' && own.identity.agentId === identity.agentId &&
    own.identity.generation === identity.generation ? own.operationId : null;
  const running = active.store.listOpenOperations(work.work_id).filter(operation => operation.operation_id !== ownId);
  if (running.length > 0) {
    return `OPERATIONS_OUTSTANDING: ${running.length} operation(s) are still ${running.map(row => row.state).join('/')}. Wait for them to settle before completing.`;
  }
  return null;
}

/**
 * Reads the compact checkpoint, or one operation's durable result.
 *
 * Read-only: it never resumes paused work. The direct work control action owns resume.
 */
export async function workResume(input: WorkResumeInput, context: CallContext | null): Promise<ToolResult> {
  if (!input.work_id && !input.agent_id && !input.operation_id) {
    const conversationId = knownUnboundConversation(context);
    if (conversationId) {
      return ok([
        'managed_connection: unbound',
        'target_source: conversation',
        `conversation_id: ${conversationId}`,
        'This is an ordinary conversation/agents worker, not a managed work agent.',
        'No managed checkpoint was read and no work was created.',
        'Normal read, exec_command, apply_patch and agents calls remain subject to their existing permissions and ownership checks.'
      ].join('\n'));
    }
  }
  const target = checkpointTarget(input, context);
  if (typeof target === 'string') return fail(target);
  let identity: ManagedWorkerIdentity;
  try {
    identity = assertManagedCaller(context, target);
  } catch (error) {
    return identityRefusal(error);
  }
  const active = runtime!;
  if (input.operation_id) {
    const operation = active.store.getOperation(input.operation_id);
    if (!operation || operation.work_id !== identity.workId) {
      return fail(`OPERATION_NOT_FOUND: ${input.operation_id} is not an operation of this work. Nothing was read.`);
    }
    const text = await operationResultText(operation);
    return ok([
      `operation_id: ${operation.operation_id}`,
      `tool: ${operation.tool}`,
      `state: ${operation.state}`,
      operation.process_id ? `process_id: ${operation.process_id}` : null,
      text ?? (operation.state === 'running' ? 'Still running; its result has not been recorded yet.' : 'No result text was retained for this operation.')
    ].filter((line): line is string => line !== null).join('\n'));
  }
  const work = active.store.getWork(identity.workId)!;
  const checkpoint = work.checkpoint;
  const open = active.store.listOpenOperations(identity.workId);
  const agents = active.store.listAgents(identity.workId).map(agent =>
    `- ${agent.agent_id} (${agent.role}, ${agent.state}, gen ${agent.generation})${agent.worktree_path ? ` worktree ${agent.worktree_path}` : ''}${agent.branch ? ` branch ${agent.branch}` : ''}`
  );
  const lines = [
    `target_source: ${input.work_id ? 'explicit' : 'conversation'}`,
    ...(input.work_id ? [] : [
      'managed_connection: bound',
      `conversation_id: ${context?.caller.conversationId ?? ''}`,
      `agent_id: ${identity.agentId}`,
      `role: ${identity.role}`,
      `generation: ${identity.generation}`
    ]),
    `work_id: ${work.work_id}`,
    `status: ${work.status}${work.desired_state ? ` (desired ${work.desired_state})` : ''}`,
    `goal: ${work.goal.split('\n')[0]?.slice(0, 300) ?? ''}`,
    `integration: ${work.integration_branch ?? 'n/a'} at ${work.integration_worktree ?? 'n/a'}`,
    `base_commit: ${work.base_commit ?? 'not captured yet'}`,
    `checkpoint: ${checkpoint ? `revision ${checkpoint.revision} (${checkpoint.host_generated ? 'host-recorded facts' : 'agent-recorded'})` : 'none recorded yet'}`,
    ...(checkpoint?.summary ? [`summary: ${checkpoint.summary}`] : []),
    ...(checkpoint?.remaining.length ? [`remaining: ${checkpoint.remaining.join('; ')}`] : []),
    ...(checkpoint?.verification.length ? [`verification: ${checkpoint.verification.map(item => `${item.operation_id}=${item.outcome}`).join(', ')}`] : []),
    `agents:`,
    ...agents,
    `open_operations: ${open.length === 0 ? 'none' : open.map(row => `${row.operation_id}(${row.state})`).join(', ')}`,
    ...(work.blocker ? [`blocker: ${work.blocker.code} — ${work.blocker.detail}`] : [])
  ];
  return ok(lines.join('\n'));
}

async function operationResultText(operation: WorkOperationRow): Promise<string | null> {
  if (operation.result_json) {
    try {
      const parsed = JSON.parse(operation.result_json) as ToolResult;
      const text = parsed.content?.filter((part): part is Extract<ToolResult['content'][number], { type: 'text' }> => part.type === 'text')
        .map(part => part.text).join('\n');
      if (text) return text;
    } catch {
      /* Fall through to the asset reference. */
    }
  }
  if (operation.result_ref && operation.session_id) {
    return readOverflowText(operation.session_id, operation.result_ref);
  }
  return null;
}

function identityRefusal(error: unknown): ToolResult {
  if (error instanceof ManagedCallerError) return denial({ code: error.code, message: error.message.replace(/^[A-Z_]+: /, '') });
  if (error instanceof WorkServiceUnavailable) return denial({ code: error.code, message: error.message.replace(/^[A-Z_]+: /, '') });
  return fail(error instanceof Error ? error.message : String(error));
}

// --------------------------------------------------------------------------- integration

export interface IntegrateWorkAgentInput {
  to: string;
  run_id?: string;
  operation_id?: string;
}

/**
 * Integrates one worker's private branch into the work's integration branch.
 *
 * Callable only by the owning prime, and only with an operation id: the host serializes the
 * integration under a per-worktree mutation lock, requires quiescence, checkpoints the private
 * main changes first, and persists the intent before the cherry-pick so a crash is
 * reconcilable rather than ambiguous.
 */
export async function integrateWorkAgent(input: IntegrateWorkAgentInput, context: CallContext): Promise<ToolResult> {
  let identity: ManagedWorkerIdentity;
  try {
    identity = requireIdentity(context);
  } catch (error) {
    return identityRefusal(error);
  }
  const active = runtime!;
  if (identity.role !== 'prime') {
    return fail('NOT_PRIME: only the owning prime may integrate a worker branch. Ask the prime to run agents action=integrate.');
  }
  if (!input.operation_id) {
    return fail('OPERATION_ID_REQUIRED: agents action=integrate needs an operation_id. No branch was integrated.');
  }
  const worker = active.store.getAgent(input.to);
  if (!worker || worker.work_id !== identity.workId || worker.role !== 'worker') {
    return fail(`WORKER_NOT_FOUND: ${input.to} is not a worker of this work. Integration never resolves a worker id globally.`);
  }
  const workerWorktree = worker.worktree_path ?? active.store.getWorktreeAssignment(identity.workId, worker.agent_id)?.path ?? null;
  if (!workerWorktree) {
    return fail(`WORKTREE_FAILED: no worktree is assigned to ${worker.agent_id}, so there is nothing to integrate.`);
  }
  if (!active.store.getWorktreeAssignment(identity.workId, worker.agent_id)) {
    return fail(`WORKTREE_FAILED: ${worker.agent_id} has no persisted worktree assignment. Nothing was integrated.`);
  }
  const live = active.store.listOperationsForAgent(worker.agent_id, worker.generation)
    .filter(row => row.state === 'running' || row.state === 'prepared');
  if (live.length > 0) {
    return fail(`WORKER_BUSY: ${worker.agent_id} has ${live.length} live operation(s) (${live.map(row => `${row.tool}:${row.operation_id}`).join(', ')}). Wait for them to settle, then integrate.`);
  }
  try {
    await active.worktrees.assertQuiescent({
      workId: identity.workId,
      worktreePath: identity.integrationPath,
      excludeOperationId: input.operation_id
    });
  } catch (error) {
    return fail(`${(error as { code?: string }).code ?? 'WORKTREE_BUSY'}: the integration worktree is busy. Nothing was integrated; retry once its processes settle.`);
  }
  // Checkpoint private main changes first, so the integration baseline is exactly what the
  // prime has actually written rather than an uncommitted working tree.
  let mainCommit: string;
  try {
    const checkpoint = await active.worktrees.checkpointIntegration({
      workId: identity.workId,
      message: `wgpt: main checkpoint before integrating ${worker.agent_id}`,
      baseCommit: active.store.getWork(identity.workId)?.base_commit ?? undefined
    });
    mainCommit = checkpoint.commit;
  } catch (error) {
    return fail(`WORKTREE_FAILED: the integration worktree could not be checkpointed: ${(error as Error).message}`);
  }
  let workerCommit: string;
  try {
    const finish = await active.worktrees.finishWorker({ workId: identity.workId, agentId: worker.agent_id, message: `wgpt: ${worker.agent_id} finish` });
    workerCommit = finish.commit;
  } catch (error) {
    return fail(`WORKTREE_FAILED: ${worker.agent_id}'s branch could not be checkpointed: ${(error as Error).message}`);
  }
  const intentAt = Date.now();
  active.store.setIntegrationIntent(identity.workId, {
    workId: identity.workId,
    operationId: input.operation_id,
    workerId: worker.agent_id,
    workerCommit,
    mainBefore: mainCommit,
    status: 'running',
    conflictFiles: [],
    mainCommit: null,
    ...(input.run_id ? { runId: input.run_id } : {}),
    startedAt: intentAt,
    updatedAt: intentAt
  });
  active.store.appendEvent(identity.workId, WORK_EVENT_KINDS.integrationIntent, {
    operation_id: input.operation_id,
    worker_id: worker.agent_id,
    worker_commit: workerCommit,
    main_before: mainCommit
  });
  let result;
  try {
    result = await active.worktrees.integrate({
      workId: identity.workId,
      workerId: worker.agent_id,
      workerCommit,
      operationId: input.operation_id,
      ...(input.run_id ? { runId: input.run_id } : {})
    });
  } catch (error) {
    active.store.setIntegrationIntent(identity.workId, {
      workId: identity.workId,
      operationId: input.operation_id,
      workerId: worker.agent_id,
      workerCommit,
      mainBefore: mainCommit,
      status: 'unknown',
      conflictFiles: [],
      mainCommit: null,
      startedAt: intentAt,
      updatedAt: Date.now()
    });
    return fail(`INTEGRATION_UNKNOWN: the integration outcome could not be determined (${(error as Error).message}). The intent is recorded; use the direct work tool with action="status" to inspect and resolve it before retrying.`);
  }
  const status = result.state === 'conflict' ? 'conflict' : result.state === 'merged' || result.state === 'already-applied' || result.state === 'noop' ? 'merged' : 'unknown';
  active.store.setIntegrationIntent(identity.workId, {
    workId: identity.workId,
    operationId: input.operation_id,
    workerId: worker.agent_id,
    workerCommit,
    mainBefore: mainCommit,
    status,
    conflictFiles: result.conflictFiles,
    mainCommit: result.mainCommit,
    startedAt: intentAt,
    updatedAt: Date.now()
  });
  active.store.updateWork(identity.workId, { base_commit: result.mainCommit ?? mainCommit });
  active.store.appendEvent(identity.workId, 'integration_result', {
    operation_id: input.operation_id,
    worker_id: worker.agent_id,
    state: result.state,
    main_commit: result.mainCommit,
    conflict_files: result.conflictFiles.slice(0, 50)
  });
  if (result.state === 'conflict') {
    return fail([
      `INTEGRATION_CONFLICT: ${result.conflictFiles.length} file(s) conflict in ${result.resultPath}.`,
      ...result.conflictFiles.slice(0, 20).map((file: string) => `- ${file}`),
      'Resolve them in the integration worktree, commit, then continue. The original checkout was never rewritten.'
    ].join('\n'));
  }
  if (result.state === 'unknown') {
    return fail(`INTEGRATION_UNKNOWN: the integration did not reach a settled state (${result.reason ?? 'no reason reported'}). Nothing further was attempted; inspect the integration worktree before retrying.`);
  }
  return ok([
    `Integrated ${worker.agent_id} into ${result.integrationBranch} (${result.state}).`,
    `integration worktree: ${result.resultPath}`,
    `main commit: ${result.mainCommit ?? 'unchanged'}`,
    `worker commit: ${workerCommit}`
  ].join('\n'));
}

// --------------------------------------------------------------------------- search context

function artifactStore(store: WorkStore): SearchArtifactStore {
  return {
    async recordArtifact(input) {
      const text = input.text;
      const assetId = await writeOverflowText(input.sessionId, text);
      if (!assetId) {
        throw new WorkError(WORK_ERROR_CODES.stateUnavailable,
          'SEARCH_ARTIFACT_UNAVAILABLE: the page could not be retained in the session store, so no cursor was issued.');
      }
      const artifactId = randomUUID();
      store.insertArtifact({
        artifact_id: artifactId,
        work_id: input.workId,
        agent_id: input.agentId,
        session_id: input.sessionId,
        asset_id: assetId,
        kind: input.kind,
        query_hash: input.queryHash,
        page_index: input.pageIndex,
        page_count: input.pageCount,
        hit_count: input.hitCount,
        total_hits: input.totalHits,
        truncated_reason: input.truncatedReason,
        byte_size: Buffer.byteLength(text, 'utf8'),
        created_at: Date.now()
      });
      store.appendEvent(input.workId, WORK_EVENT_KINDS.artifactRecorded, {
        artifact_id: artifactId,
        kind: input.kind,
        query_hash: input.queryHash,
        page_index: input.pageIndex,
        hit_count: input.hitCount,
        truncated_reason: input.truncatedReason
      });
      const row = store.getArtifact(artifactId);
      if (!row) throw new WorkError(WORK_ERROR_CODES.stateUnavailable, 'SEARCH_ARTIFACT_UNAVAILABLE: the page row could not be read back.');
      return row;
    },
    async getArtifact(cursor) {
      return store.getArtifact(cursor);
    },
    async listArtifacts(input) {
      return store.listArtifacts({
        workId: input.workId,
        ...(input.kind !== undefined ? { kind: input.kind } : {}),
        ...(input.queryHash !== undefined ? { queryHash: input.queryHash } : {})
      });
    }
  };
}

/**
 * The durable search context for a *managed* call, or null for ordinary coding.
 *
 * Null is the ordinary answer, not a failure: `find` is a coding tool, and a call that names no
 * work — a fresh chat, a phone, a daemon, a host whose ledger is still restoring — searches the
 * approved roots under its own permissions exactly like `read` and `exec_command`. Resolving
 * managed identity here unconditionally is what used to turn an ordinary search into
 * `WORKER_CONNECTION_REQUIRED`, reported to the model as a filesystem error.
 */
export function getManagedSearchContext(context: CallContext): ManagedSearchContext | null {
  if (!runtime || shuttingDown) return null;
  const conversationId = context.caller.conversationId ?? null;
  if (!conversationId || !runtime.store.getAgentByConversation(conversationId)) return null;
  const resolved = resolveWorkTarget(runtime.store, { conversationId });
  if (resolved.kind !== 'resolved') return null;
  const identity = resolved.identity;
  return {
    owner: { workId: identity.workId, agentId: identity.agentId, sessionId: identity.sessionId ?? '' },
    worktreePath: identity.worktreePath,
    artifacts: artifactStore(runtime.store)
  };
}

// --------------------------------------------------------------------------- start stage

/** The runtime's `WorkRuntimePort`: the executing half of the six service methods. */
function createRuntimePort(handle: () => WorkRuntimeHandle): WorkRuntimePort {
  return {
    async beginStart(input: WorkRuntimeStart): Promise<void> {
      await beginStart(handle(), input);
    },
    async deliver(input: WorkRuntimeDelivery): Promise<WorkRuntimeDeliveryResult> {
      return deliverCommand(handle(), input);
    },
    async control(input: WorkRuntimeControl): Promise<WorkRuntimeControlResult> {
      return controlWork(handle(), input);
    },
    async reconcile(input: WorkRuntimeReconcileInput): Promise<void> {
      await reconcileStartup(handle(), input);
    }
  };
}

/**
 * Whether the start stage may still act on a work.
 *
 * One invariant, used at every await boundary in the start stage and by the binding watcher: the
 * work must still be the one this stage was admitted for (not paused, cancelled or completed),
 * it must carry no committed desired state, and its prime must still be the exact generation
 * this stage started. A missing prime row or a changed generation is a refusal — never a bypass,
 * because a stage that cannot prove its owner must not write.
 */
function startStageLive(store: WorkStore, workId: string, agentId: string, generation: number): boolean {
  if (shuttingDown) return false;
  const work = store.getWork(workId);
  if (!work) return false;
  if (work.status === 'paused' || work.status === 'cancelled' || work.status === 'completed') return false;
  if (work.desired_state !== null) return false;
  const agent = store.getAgent(agentId);
  if (!agent) return false;
  return agent.generation === generation;
}

/**
 * The `starting` stage: baseline snapshot, integration worktree, prime dispatch.
 *
 * Everything here is deliberately after the durable receipt. A missing connector, login or
 * browser is a retained blocker on an admitted work, never a failed admission — the user's
 * mobile call has already been answered with a work id.
 *
 * The stage spans several awaits, and a pause/cancel may land during any of them. Every mutation
 * is therefore guarded by {@link startStageLive}: a cancelled work is never turned back into
 * `starting`, its prime is never dispatched, and the failure path never blocks a work the user
 * has already stopped.
 */
async function beginStart(active: WorkRuntimeHandle, input: WorkRuntimeStart): Promise<void> {
  const { store, worktrees } = active;
  const work = store.getWork(input.workId);
  if (!work) throw new WorkError(WORK_ERROR_CODES.workNotFound, 'WORK_NOT_FOUND: the admitted work row disappeared before its start stage.');
  const primeAtAdmission = store.getPrimeAgent(input.workId);
  // The service always creates the prime row in the same transaction as the work, so a missing
  // row is a corrupt ledger, not a phase to tolerate. Blocking is the honest answer; a stage
  // that cannot name its owner must never proceed on a permissive default.
  if (!primeAtAdmission) {
    store.setWorkStatus(input.workId, 'blocked', WORK_EVENT_KINDS.workBlocked);
    store.setBlocker(input.workId, {
      code: WORK_BLOCKER_CODES.primeLaunchFailed,
      detail: 'This work has no prime agent row, so its start stage cannot be attributed. Start a new work.',
      at: Date.now()
    }, WORK_EVENT_KINDS.workBlocked);
    return;
  }
  const agentId = primeAtAdmission.agent_id;
  const generation = primeAtAdmission.generation;
  if (!startStageLive(store, input.workId, agentId, generation)) return;
  store.setWorkStatus(input.workId, 'starting', WORK_EVENT_KINDS.workStarting);
  // Everything from here — including the sandbox root approval — is inside one guard, so any
  // failure becomes a retained `blocked` work with its real reason rather than a work that sits
  // in `starting` with a blocker nobody set.
  let rootName = '';
  try {
    // The private worktree must be reachable by the sandbox before any agent can work in it.
    rootName = await approveWorktreeRoot(input.integrationWorktree);
    // A work that continues a predecessor starts from that predecessor's result snapshot rather
    // than from a fresh checkout of the project: committed history is preserved underneath and the
    // dirty/staged/untracked tree the predecessor left is carried into the successor. Both calls
    // refuse with their own code rather than guessing, and the catch below keeps that code.
    const baseline = input.predecessorWorkId
      ? await worktrees.captureSuccessorBaseline({
          workId: input.workId,
          predecessorWorkId: input.predecessorWorkId,
          projectPath: input.projectPath
        })
      : await worktrees.captureBaseline({ projectPath: input.projectPath, workId: input.workId });
    // The integration worktree is the PRIME's assignment, so its agent id is passed through and
    // the assignment is persisted by the manager rather than reconstructed here. The canonical
    // project path comes from the baseline: the two agree in identity but may differ in spelling.
    const primeForAssignment = store.getPrimeAgent(input.workId);
    const assignment = await worktrees.ensureIntegrationWorktree({
      workId: input.workId,
      projectPath: baseline.projectPath,
      baselineCommit: baseline.baselineCommit,
      ...(primeForAssignment ? { agentId: primeForAssignment.agent_id } : {})
    });
    // A pause/cancel during the snapshot must not be undone by the stage that was already in
    // flight. The worktrees above are real and remain assigned; only the status/agent writes
    // stop here.
    if (!startStageLive(store, input.workId, agentId, generation)) return;
    store.updateWork(input.workId, { base_commit: baseline.baselineCommit });
    const prime = store.getPrimeAgent(input.workId);
    if (prime) {
      store.assignWorktree({
        workId: input.workId,
        agentId: prime.agent_id,
        role: 'prime',
        branch: assignment.branch,
        path: assignment.path,
        baseCommit: baseline.baselineCommit,
        createdAt: Date.now()
      });
      store.updateAgent(prime.agent_id, {
        state: 'pending',
        base_commit: baseline.baselineCommit,
        model: input.model,
        reasoning: input.reasoning
      });
    }
    store.appendEvent(input.workId, WORK_EVENT_KINDS.worktreeAssigned, {
      branch: assignment.branch,
      path: assignment.path,
      base_commit: baseline.baselineCommit,
      root: rootName,
      unborn: baseline.unborn
    });
  } catch (error) {
    // A stage that was superseded while it ran reports its failure as an event, never as a
    // status change over the user's pause/cancel.
    if (!startStageLive(store, input.workId, agentId, generation)) {
      store.appendEvent(input.workId, 'start_stage_abandoned', { reason: (error as Error).message.slice(0, 500) });
      return;
    }
    const code = (error as { code?: string }).code ?? WORK_BLOCKER_CODES.primeLaunchFailed;
    store.setWorkStatus(input.workId, 'blocked', WORK_EVENT_KINDS.workBlocked);
    store.setBlocker(input.workId, {
      code: code === 'PROJECT_NOT_GIT' ? WORK_ERROR_CODES.projectNotGit : code,
      detail: (error as Error).message.slice(0, 4000),
      at: Date.now()
    }, WORK_EVENT_KINDS.workBlocked);
    return;
  }

  // Dispatch the prime conversation through the existing outbox, under the persisted command
  // id as its stable input id, so a retry cannot open a second prime chat.
  if (!startStageLive(store, input.workId, agentId, generation)) return;
  const prime = store.getPrimeAgent(input.workId);
  if (!prime) return;
  const sessionId = input.requestId;
  store.updateAgent(prime.agent_id, { session_id: sessionId });
  store.updateWork(input.workId, { prime_session_id: sessionId });
  const text = primePrompt(input, store.getWork(input.workId)!);
  const delivery = await deliverOutbox(active, {
    id: sessionId,
    sessionId: null,
    text,
    model: input.model,
    reasoning: input.reasoning,
    // The admitted start command's own instant: a retried opening send is scheduled against the
    // same moment instead of looking like a brand-new message.
    dueAt: input.createdAt,
    workId: input.workId
  });
  // The send is already durably owned by `sessionId`; a work stopped while it was in flight
  // keeps its stop, and the row is left for the user's next resume to retry.
  if (!startStageLive(store, input.workId, agentId, generation)) {
    store.appendEvent(input.workId, 'prime_dispatch_abandoned', { session_id: sessionId, delivery: delivery.state });
    return;
  }
  if (delivery.state === 'failed') {
    store.setWorkStatus(input.workId, 'blocked', WORK_EVENT_KINDS.workBlocked);
    store.setBlocker(input.workId, {
      code: WORK_BLOCKER_CODES.primeLaunchFailed,
      detail: (delivery.error ?? 'the prime conversation could not be opened').slice(0, 4000),
      at: Date.now()
    }, WORK_EVENT_KINDS.workBlocked);
    return;
  }
  store.appendEvent(input.workId, 'prime_dispatched', { session_id: sessionId });
  void watchPrimeBinding(active, input.workId, prime.agent_id, sessionId, input.model, input.reasoning, prime.generation);
}

/**
 * The prime's opening message: the user's own goal, then the facts it needs about where it works.
 *
 * No instructions, warnings or tool recipes. The user's request is the whole of the request, and the
 * lines below it are workspace coordinates rather than policy: which work this is, which worktree
 * and branch it owns, and where the untouched checkout is. Everything the host enforces — identity,
 * receipts, duplication, reporting — is enforced in code, so nothing here repeats it at the model.
 *
 * The one line that is not a coordinate is the completion contract, and it is one line because it is
 * the one fact the model cannot derive: a work is completed by an explicit `work_checkpoint` call,
 * so nothing in the app can infer completion from the conversation ending. Natural language is never
 * treated as completion anywhere in this runtime.
 */
function primePrompt(input: WorkRuntimeStart, work: WorkRow): string {
  return [
    input.goal,
    '',
    `Work: ${input.workId}`,
    `Worktree: ${input.integrationWorktree}`,
    `Branch: ${input.integrationBranch}; base: ${work.base_commit ?? 'captured during start'}`,
    `Original checkout: ${input.projectPath}`,
    'Complete the work with work_checkpoint complete:true.'
  ].join('\n');
}

/**
 * One live binding watcher per (work, agent, generation).
 *
 * A watcher outlives the call that started it, and a pause/cancel can land while it is asleep
 * between polls. Two things follow: a superseded watcher must not be able to mutate anything,
 * and only one watcher may own a given binding — otherwise a resume's retry and the original
 * start could both decide the work's status. The token below is that ownership.
 */
const bindingWatchers = new Map<string, symbol>();

function watcherKey(workId: string, agentId: string, generation: number): string {
  return `${workId}:${agentId}:${generation}`;
}

/** One poll interval, kept as a helper so the delay shape lives in one place. */
let watcherDelayOverride: ((ms: number) => Promise<void>) | null = null;

async function watcherDelay(ms: number): Promise<void> {
  if (watcherDelayOverride) return watcherDelayOverride(ms);
  const { promise, resolve } = Promise.withResolvers<void>();
  const timer = setTimeout(resolve, ms);
  timer.unref?.();
  await promise;
}

/**
 * Test seam: replaces the watcher's poll interval with a controlled wait.
 *
 * A test that needs "the watcher polls once more" can hold a promise instead of sleeping, so the
 * assertion is about the fence rather than about wall-clock timing.
 */
export function setWatcherDelayForTests(delay: ((ms: number) => Promise<void>) | null): void {
  watcherDelayOverride = delay;
}

/**
 * Binds the prime's conversation once the browser has actually opened the chat, and moves the
 * work to `running`. A chat that never appears becomes a retained blocker, not an infinite
 * pending state.
 *
 * Every mutation is fenced: before it, the watcher re-reads the durable work and agent rows and
 * gives up if this generation was superseded, the work was paused/cancelled, or another watcher
 * took over. A late chat binding therefore cannot turn a cancelled work back to `running`, and a
 * deadline cannot block a work the user has already resumed.
 */
async function watchPrimeBinding(
  active: WorkRuntimeHandle,
  workId: string,
  agentId: string,
  sessionId: string,
  model: string | null,
  reasoning: string | null,
  generation: number
): Promise<void> {
  const key = watcherKey(workId, agentId, generation);
  const token = Symbol(key);
  bindingWatchers.set(key, token);
  const owns = (): boolean => bindingWatchers.get(key) === token;
  const release = (): void => { if (owns()) bindingWatchers.delete(key); };
  /** Whether this watcher may still act on the work at all. */
  const live = (): boolean => {
    if (shuttingDown || !owns()) return false;
    const work = active.store.getWork(workId);
    if (!work) return false;
    if (work.status === 'paused' || work.status === 'cancelled' || work.status === 'completed') return false;
    if (work.desired_state !== null) return false;
    const agent = active.store.getAgent(agentId);
    if (!agent) return false;
    // The generation fence is never bypassed: a watcher whose generation is unknown cannot be
    // constructed, and a changed generation means a replacement conversation already owns this
    // agent. Failing closed here is what stops a stale watcher from writing over its successor.
    return agent.generation === generation;
  };

  const deadline = Date.now() + 5 * 60_000;
  try {
    for (;;) {
      if (!live()) return;
      const session = await getSession(sessionId).catch(() => null);
      if (!live()) return;
      if (session?.conversationId) {
        active.store.bindAgentConversation({ agentId, sessionId, conversationId: session.conversationId });
        active.store.updateAgent(agentId, { state: 'active' });
        // The chat that started a desktop work becomes its controller, so the work can be
        // continued from that same conversation after it completes. A work that already has a
        // controller keeps it — a prime transfer or a successor never steals the original — and a
        // disabled binding is never reactivated here.
        autoBindPrimeController({ sessionId, conversationId: session.conversationId, workId });
        if (!live()) return;
        active.store.setWorkStatus(workId, 'running', WORK_EVENT_KINDS.workRunning);
        active.store.setBlocker(workId, null, WORK_EVENT_KINDS.workRunning);
        active.store.appendEvent(workId, WORK_EVENT_KINDS.workStarted, {
          conversation_id: session.conversationId,
          model,
          reasoning,
          generation
        });
        logInfo(`work ${workId.slice(0, 8)} prime bound to conversation ${session.conversationId}`);
        return;
      }
      // The outbox row is the authority on whether the message can still be delivered at all. A
      // recorded startup failure (no connector, no browser, login required) must become a visible
      // blocker immediately, not a work that sits in `starting` until an arbitrary deadline.
      const entry = (await listInputs().catch(() => [])).find(row => row.id === sessionId);
      if (!live()) return;
      if (entry && entry.state !== 'sent' && entry.error) {
        const auth = /login|sign in|log in|authenticat/i.test(entry.error);
        active.store.setWorkStatus(workId, 'blocked', WORK_EVENT_KINDS.workBlocked);
        active.store.setBlocker(workId, {
          code: auth ? WORK_BLOCKER_CODES.authRequired : WORK_BLOCKER_CODES.primeLaunchFailed,
          detail: `The prime conversation could not be opened: ${entry.error}`.slice(0, 4000),
          at: Date.now()
        }, WORK_EVENT_KINDS.workBlocked);
        return;
      }
      if (Date.now() > deadline) {
        active.store.setWorkStatus(workId, 'blocked', WORK_EVENT_KINDS.workBlocked);
        active.store.setBlocker(workId, {
          code: WORK_BLOCKER_CODES.primeLaunchFailed,
          detail: 'The prime ChatGPT conversation was queued but never opened within five minutes. Check the browser companion connection and the dedicated profile login, then resume the work.',
          at: Date.now()
        }, WORK_EVENT_KINDS.workBlocked);
        return;
      }
      await watcherDelay(2_000);
    }
  } finally {
    release();
  }
}

/**
 * Approves the managed worktree root so agents can resolve their own assigned folder.
 *
 * The root does not exist before the first work, and `validateNewRoot` canonicalizes an existing
 * directory — so it is created first. A failure here is *not* swallowed: without an approved
 * root, every agent's `resolvePath` would reject its own assigned worktree, so the work must be
 * blocked with the real reason rather than starting and failing later with a confusing refusal.
 */
async function approveWorktreeRoot(worktreePath: string): Promise<string> {
  const root = path.dirname(path.dirname(worktreePath));
  try {
    await fs.mkdir(root, { recursive: true, mode: 0o700 });
    // A root already inside an approved folder is reachable as it stands; adding a nested root
    // would be redundant, and the sandbox would reject it as overlapping the existing one.
    if (await approvedRootContaining(getConfig().roots, root)) return path.basename(root);
    const real = await validateNewRoot(root, getConfig().roots);
    let name = '';
    await updateConfig(config => {
      const existing = config.roots.find(entry => entry.path === real);
      if (existing) {
        name = existing.name;
        return config;
      }
      name = uniqueRootName(real, config.roots);
      return { ...config, roots: [...config.roots, { name, path: real }] };
    });
    if (!name) throw new Error('the managed worktree root could not be recorded as an approved folder');
    return name;
  } catch (error) {
    throw new Error(
      `the managed worktree root ${root} could not be approved (${(error as Error).message}). ` +
      'Agents cannot be given an assigned folder until this folder is approved, so the work was not started.'
    );
  }
}

function uniqueRootName(real: string, roots: readonly { name: string; path: string }[]): string {
  const base = `wgpt-${path.basename(real).replace(/[^a-z0-9]+/gi, '-').slice(0, 24) || 'worktrees'}`;
  const used = new Set(roots.map(root => root.name));
  if (!used.has(base)) return base;
  for (let n = 2; n < 100; n++) if (!used.has(`${base}-${n}`)) return `${base}-${n}`;
  return `${base}-${randomUUID().slice(0, 6)}`;
}

// --------------------------------------------------------------------------- delivery

async function deliverOutbox(active: WorkRuntimeHandle, input: WorkOutboxDelivery): Promise<WorkOutboxResult> {
  if (active.deliver) return active.deliver(input);
  return { state: 'failed', error: 'no delivery path is installed' };
}

/**
 * Delivers one durably recorded command.
 *
 * Instructions go to the prime's conversation, at the next safe turn boundary. The outbox id is
 * the persisted command id, so a retry after a lost acknowledgement reuses the same durable
 * input row instead of sending a second copy.
 */
async function deliverCommand(active: WorkRuntimeHandle, input: WorkRuntimeDelivery): Promise<WorkRuntimeDeliveryResult> {
  const work = active.store.getWork(input.workId);
  if (!work) return { state: 'failed', error: 'the work row no longer exists' };
  if (input.kind === 'start') {
    // `beginStart` already owns the opening send; the start command is its receipt, not a
    // second delivery.
    return { state: 'delivered' };
  }
  // Every current factual stop is a fence, not just the committed cancellation intent: a pause or
  // cancel that already drained leaves `desired_state` null, and a delivery admitted before it must
  // not be sent afterwards. The fence is checked *after* the existing-row reconciliation below, so
  // a stop never hides a receipt for an input that was already authorized.
  const stopped = work.status === 'cancelled' || work.desired_state === 'cancelled'
    ? 'cancelled' as const
    : work.status === 'paused' || work.desired_state === 'paused' ? 'paused' as const : null;
  if (stopped) {
    // The stop fence is checked *after* the existing row, for both stop states: a receipt that
    // landed before the stop is a fact about the message, and a stop must never erase it.
    //
    // A read that *failed* and a read that proved there is no row are different facts, and the
    // difference decides whether this can be terminalized at all: only the second says anything
    // about the message, and even that says only "not admitted yet".
    let admitted: WorkOutboxResult | null = null;
    let readFailed = false;
    if (active.readOutbox) {
      try {
        admitted = await active.readOutbox(input.outboxInputId);
      } catch {
        readFailed = true;
      }
    } else {
      readFailed = true;
    }
    if (admitted?.state === 'delivered') return { state: 'delivered' };
    if (admitted?.state === 'unknown') return { state: 'unknown', error: admitted.error ?? 'the hand-off outcome could not be established' };
    if (admitted?.state === 'failed') return { state: 'failed', error: admitted.error ?? 'the message could not be queued' };
    if (admitted?.state === 'cancelled') return { state: 'cancelled' };
    if (stopped === 'paused') {
      // A pause is a pause: the instruction keeps its place and is delivered after a resume. It is
      // never discarded, and its row is never rewritten.
      return { state: 'deferred', detail: 'the work is paused, so its instruction waits for a resume' };
    }
    if (readFailed) return { state: 'unknown', error: 'the outbox row for this instruction could not be read, so its outcome is unresolved' };
    if (!admitted) {
      // No row *yet* is not proof that none can appear: the start stage can be inside its own send
      // while this runs, so terminalizing here would strand the row that send is about to create.
      // The command stays pending, and a later pump reconciles it against the real row.
      return { state: 'deferred', detail: 'the instruction has not reached the outbox yet, so its outcome cannot be settled' };
    }
    // Provably unsent: withdraw it atomically. False means the browser may already have it, which
    // stays `unknown` rather than becoming a cancellation the user would read as "never sent".
    const withdrawn = active.cancelOutbox ? await active.cancelOutbox(input.outboxInputId).catch(() => false) : false;
    return withdrawn
      ? { state: 'cancelled' }
      : { state: 'unknown', error: 'the work was cancelled, but this instruction may already have been handed to the browser' };
  }
  // A *linked* instruction shares the successor's opening input id: its text is already in that
  // opening message, so this command must never produce a row of its own. It only reads and
  // reconciles the opening's receipt, and waits while the opening does not exist yet — creating it
  // here would claim the start id first and the opening message (and its new chat) would never
  // happen. The link is a fact about this command, not a hint: it is decided by the durable
  // outbox id, which only the service's successor path makes different from the request id.
  const linkedOpening = input.outboxInputId !== input.requestId;
  if (linkedOpening) {
    if (!active.readOutbox) return { state: 'deferred', detail: 'the opening message cannot be read yet' };
    const opening = await active.readOutbox(input.outboxInputId).catch(() => null);
    // No row yet means the opening has not been admitted; the start stage owns that, and this
    // instruction waits for it rather than racing it.
    if (!opening) return { state: 'deferred', detail: 'the opening message has not been admitted yet' };
    if (opening.state === 'delivered') return { state: 'delivered' };
    if (opening.state === 'unknown') return { state: 'unknown', error: opening.error ?? 'the hand-off outcome could not be established' };
    if (opening.state === 'failed') return { state: 'failed', error: opening.error ?? 'the opening message could not be queued' };
    if (opening.state === 'cancelled') return { state: 'cancelled' };
    // Accepted but not acknowledged: the opening carries this instruction, so it is queued, never
    // "delivered" — a claim on enqueue is exactly the lie this rule exists to prevent.
    return { state: 'queued' };
  }
  const prime = work.prime_agent_id ? active.store.getAgent(work.prime_agent_id) : active.store.getPrimeAgent(input.workId);
  if (!prime?.session_id) {
    // Work-scoped: nothing about this row decides it, so the pump may hold the work's other
    // unlinked rows for the rest of its pass instead of asking the same question per row.
    return { state: 'deferred', detail: 'the prime conversation is not bound yet', scope: 'work' };
  }
  const result = await deliverOutbox(active, {
    id: input.outboxInputId,
    sessionId: prime.session_id,
    text: input.text ?? '',
    model: work.model,
    reasoning: work.reasoning,
    // The durable command's own instant, so the outbox's first enqueue of this input id is
    // stable across retries.
    dueAt: input.commandCreatedAt,
    workId: input.workId
  });
  // The result is reported factually and nothing else: the service owns the command's delivery
  // state and writes its transition event once, so a reconciliation poll that observes the same
  // fact again cannot append a duplicate.
  if (result.state === 'unknown') {
    return { state: 'unknown', error: result.error ?? 'the hand-off outcome could not be established' };
  }
  // `queued` is not a delivery: the outbox accepted the message and it is still waiting for its
  // turn, so the command keeps that factual state and a later acknowledgement reconciles it.
  if (result.state === 'queued') return { state: 'queued' };
  if (result.state === 'delivered') return { state: 'delivered' };
  if (result.state === 'cancelled') return { state: 'cancelled' };
  return { state: 'failed', error: result.error ?? 'the message could not be handed to the browser' };
}

// --------------------------------------------------------------------------- control

/**
 * Pause, resume and cancel.
 *
 * Pause/cancel fence first (already committed by the ledger), terminate the work's owned
 * process groups, release the GUI lease, and report the factual status back. Resume lifts the
 * fence and, when the work was blocked as `RECOVERY_EXHAUSTED`, grants exactly one more
 * recovery episode — an explicit user instruction is the only thing that may do that.
 */
async function controlWork(active: WorkRuntimeHandle, input: WorkRuntimeControl): Promise<WorkRuntimeControlResult> {
  if (input.action === 'pause' || input.action === 'cancel') {
    await drainWork(active, input.workId, input.action === 'cancel' ? 'cancelled' : 'paused');
    const work = active.store.getWork(input.workId);
    return { status: input.action === 'cancel' ? 'cancelled' : 'paused', blocker: work?.blocker ?? null };
  }
  // resume
  const work = active.store.getWork(input.workId);
  if (!work) throw new WorkError(WORK_ERROR_CODES.workNotFound, 'WORK_NOT_FOUND: the work row no longer exists.');
  const agents = active.store.listAgents(input.workId);
  const prime = work.prime_agent_id ? active.store.getAgent(work.prime_agent_id) : active.store.getPrimeAgent(input.workId);
  if (prime?.session_id && prime.conversation_id && !(await reconcileManagedPrimeBinding(active.store, prime))) {
    throw new Error(`managed prime ${prime.agent_id} has no readable current session binding`);
  }
  // A work blocked or paused before its prime chat ever opened is the first-login path, and it
  // has two shapes:
  //  - an opening outbox row already exists (the send was attempted): retry THAT row, reusing one
  //    durable input instead of sending a second copy, and never replaying an ambiguous send;
  //  - the start stage was stopped before it dispatched at all (no row): repeat the start stage
  //    under the ORIGINAL durable start command id, which is what re-creates the same opening.
  if (prime && !prime.conversation_id) {
    const startCommand = active.store.listCommands(input.workId, 50).find(command => command.kind === 'start');
    const requestId = startCommand?.request_id ?? prime.session_id;
    if (prime.session_id) {
      const retried = await retryQueuedInputBrowser(prime.session_id).catch(() => null);
      if (retried) {
        active.store.appendEvent(input.workId, 'resume_retry', {
          request_id: input.commandId,
          outbox_input_id: prime.session_id
        });
        // The same watcher that owns the opening send now owns this retry's outcome.
        void watchPrimeBinding(active, input.workId, prime.agent_id, prime.session_id, work.model, work.reasoning, prime.generation);
      } else {
        const entry = (await listInputs().catch(() => [])).find(row => row.id === prime.session_id);
        if (entry) {
          // The row exists but is not retryable (already handed to the browser, or ambiguous).
          // Keep the work blocked with the outbox's own reason rather than pretending to resume.
          const detail = entry.error ?? 'the opening message is not in a state that can be retried yet';
          active.store.setWorkStatus(input.workId, 'blocked', WORK_EVENT_KINDS.workBlocked);
          active.store.setBlocker(input.workId, {
            code: /login|sign in|log in|authenticat/i.test(detail) ? WORK_BLOCKER_CODES.authRequired : WORK_BLOCKER_CODES.primeLaunchFailed,
            detail: `Resume could not open the prime conversation yet: ${detail}`.slice(0, 4000),
            at: Date.now()
          }, WORK_EVENT_KINDS.workBlocked);
          active.store.appendEvent(input.workId, 'resume_retry_refused', {
            request_id: input.commandId,
            outbox_input_id: prime.session_id
          });
          return { status: 'blocked', blocker: active.store.getWork(input.workId)?.blocker ?? null };
        }
        // No row at all: the start stage never dispatched. Repeat it under the original command id.
        if (requestId) await restartAdmission(active, input.workId, requestId, prime.agent_id);
      }
    } else if (requestId) {
      await restartAdmission(active, input.workId, requestId, prime.agent_id);
    }
  }
  let anyActive = false;
  for (const agent of agents) {
    if (agent.state === 'blocked') active.store.updateAgent(agent.agent_id, { state: 'active' });
    if (agent.state === 'blocked' || agent.state === 'active') anyActive = true;
  }
  if (input.grantRecoveryEpisode) {
    for (const agent of agents) {
      active.recovery.noteUserInstruction({
        workId: input.workId,
        agentId: agent.agent_id,
        generation: agent.generation,
        textHash: `resume:${input.commandId}`
      });
    }
  }
  active.store.setBlocker(input.workId, null, WORK_EVENT_KINDS.workUnblocked);
  return { status: anyActive ? 'running' : 'recovering', blocker: null };
}

/**
 * Repeats a work's start stage after a stop that landed before its prime was dispatched.
 *
 * The original durable start command id is reused, so the opening message that is eventually
 * sent is the same durable input a fresh start would have created — never a second one. The
 * worktree assignment already on the row is preserved, so this is a continuation of the same
 * admission rather than a new one.
 */
async function restartAdmission(active: WorkRuntimeHandle, workId: string, requestId: string, agentId: string): Promise<void> {
  const work = active.store.getWork(workId);
  if (!work || !work.integration_branch || !work.integration_worktree) return;
  active.store.updateAgent(agentId, { state: 'pending' });
  active.store.appendEvent(workId, 'resume_restart_admission', { request_id: requestId });
  await beginStart(active, {
    workId,
    requestId,
    projectPath: work.project_path,
    goal: work.goal,
    title: work.title,
    model: work.model,
    reasoning: work.reasoning,
    maxWorkers: work.max_workers,
    integrationBranch: work.integration_branch,
    integrationWorktree: work.integration_worktree,
    ...(work.predecessor_work_id ? { predecessorWorkId: work.predecessor_work_id } : {}),
    // The durable start command's own instant, so a repeated opening send keeps one `dueAt`.
    createdAt: active.store.getCommand(requestId)?.created_at ?? work.created_at
  });
}

/** The one drain path for pause, cancel and host shutdown. */
async function drainWork(active: WorkRuntimeHandle, workId: string, reason: 'paused' | 'cancelled'): Promise<void> {
  const agents = active.store.listAgents(workId);
  for (const agent of agents) {
    active.store.fenceAgentGeneration({ workId, agentId: agent.agent_id, generation: agent.generation });
    // A command can still be inside its initial yield. Let it publish the exact-instance
    // lifetime handle before draining; no later call can pass the generation fence.
    await Promise.allSettled([...pendingExec.values()].filter(entry => entry.identity.workId === workId &&
      entry.identity.agentId === agent.agent_id && entry.identity.generation === agent.generation).map(entry => entry.done));
    const operations = active.store.listOperationsForAgent(agent.agent_id, agent.generation);
    for (const operation of operations) {
      if (operation.state !== 'running' && operation.state !== 'prepared') continue;
      const process = liveExec.get(operation.operation_id);
      if (process && process.identity.workId === workId && process.identity.agentId === agent.agent_id &&
          process.identity.generation === agent.generation) {
        try {
          await process.terminate();
          await process.settled;
        } catch (error) {
          logWarn(`work process drain failed: ${error instanceof Error ? error.message : String(error)}`);
        }
      }
      const state = active.store.getOperation(operation.operation_id)?.state;
      if (state === 'running' || state === 'prepared')
        active.operations.markUnknown(operation.operation_id, `drained because the work was ${reason}`);
    }
    if (agent.state === 'active' || agent.state === 'pending') active.store.updateAgent(agent.agent_id, { state: 'blocked' });
  }
  if (cuaBridge) await cuaBridge.releaseGuiLease(workId).catch(() => undefined);
  active.store.appendEvent(workId, reason === 'cancelled' ? WORK_EVENT_KINDS.cancelled : WORK_EVENT_KINDS.paused, {
    drained_agents: agents.length
  });
}

// --------------------------------------------------------------------------- reconciliation

/**
 * Every work in the ledger, page by page.
 *
 * A lifecycle pass (quit drain, startup power reconciliation) must see every work, so it cannot
 * use a single bounded query: an older active work beyond the first page would be skipped, and a
 * skipped active work is exactly the one that must be fenced and drained.
 */
function forEachWork(store: WorkStore, visit: (work: WorkRow) => void | Promise<void>): Promise<void> {
  const run = async (): Promise<void> => {
    let cursor: string | null = null;
    for (;;) {
      const page = store.listWorks({ limit: 100, cursor });
      if (page.length === 0) return;
      for (const work of page) await visit(work);
      if (page.length < 100) return;
      cursor = page[page.length - 1]!.work_id;
    }
  };
  return run();
}

/**
 * Startup reconciliation.
 *
 * A persisted `prepared` row never reached a side effect, so it is safely retryable under its
 * own id. A persisted `running` row is *not* assumed live: this process cannot vouch for the
 * previous one's PIDs (they can be reused), so shell/stdin rows become `outcome_unknown` and
 * patch rows are re-hashed against their recorded expectations.
 */
async function reconcileStartup(active: WorkRuntimeHandle, input: WorkRuntimeReconcileInput): Promise<void> {
  const cwdByWork = new Map<string, string>();
  for (const operation of input.openOperations) {
    if (operation.state === 'prepared') {
      active.store.updateOperation(operation.operation_id, { state: 'prepared', process_id: null });
      active.store.appendEvent(operation.work_id, 'operation_reconciled', {
        operation_id: operation.operation_id,
        previous: 'prepared',
        resolution: 'retryable under the same operation id'
      });
      continue;
    }
    const isPatch = operation.tool === 'apply_patch';
    if (isPatch && operation.expect_before) {
      const worktreePath = operation.session_id ? await worktreeForSession(active, operation.session_id) : null;
      const cwd = worktreePath ?? cwdByWork.get(operation.work_id) ?? null;
      if (cwd) {
        cwdByWork.set(operation.work_id, cwd);
        const verdict = await reconcilePatchOperation(operation.operation_id, cwd);
        active.store.updateOperation(operation.operation_id, {
          state: verdict === 'all_after' ? 'completed' : verdict === 'all_before' ? 'failed' : 'outcome_unknown'
        });
        active.store.appendEvent(operation.work_id, 'operation_reconciled', {
          operation_id: operation.operation_id,
          previous: 'running',
          resolution: verdict
        });
        if (verdict === 'mixed' || verdict === 'unknown') markUnknownBlocker(active, operation.work_id, operation.operation_id, verdict);
        continue;
      }
    }
    active.store.updateOperation(operation.operation_id, { state: 'outcome_unknown', process_id: null });
    active.store.appendEvent(operation.work_id, WORK_EVENT_KINDS.workBlocked, {
      operation_id: operation.operation_id,
      previous: 'running',
      resolution: 'outcome_unknown'
    });
    markUnknownBlocker(active, operation.work_id, operation.operation_id, 'the host restarted while this operation was running');
  }
  for (const command of input.pendingCommands) {
    active.store.updateCommand(command.request_id, { delivery_state: 'pending' });
  }
  await redispatchUnfinishedWorks(active);
}

/**
 * Re-dispatches work that was admitted but never reached `running` when the host died.
 *
 * The crash window this closes is the one between the durable receipt and the prime binding:
 * the work row exists and the user has a work id, but no ChatGPT conversation was ever opened
 * (or one was opened and the host died before noticing). Leaving it `queued` forever would make
 * a paid admission look like a task that silently never started.
 *
 * It is safe to repeat because both halves are idempotent: the baseline/worktree calls return
 * the persisted assignment, and the opening send uses the *persisted start command id* as its
 * outbox input id, so a retry joins the existing durable input row instead of opening a second
 * chat.
 */
async function redispatchUnfinishedWorks(active: WorkRuntimeHandle): Promise<void> {
  for (const work of active.store.listWorks({ limit: 200 })) {
    if (work.desired_state !== null) continue;
    if (work.status !== 'queued' && work.status !== 'starting' && work.status !== 'recovering') continue;
    const prime = work.prime_agent_id ? active.store.getAgent(work.prime_agent_id) : active.store.getPrimeAgent(work.work_id);
    if (!prime) {
      active.store.setWorkStatus(work.work_id, 'blocked', WORK_EVENT_KINDS.workBlocked);
      active.store.setBlocker(work.work_id, {
        code: WORK_BLOCKER_CODES.primeLaunchFailed,
        detail: 'The work has no prime agent row, so it cannot be started. Start a new work.',
        at: Date.now()
      }, WORK_EVENT_KINDS.workBlocked);
      continue;
    }
    // A bound prime means the chat was opened; only the status transition was lost.
    if (prime.conversation_id) {
      active.store.updateAgent(prime.agent_id, { state: 'active' });
      active.store.setWorkStatus(work.work_id, 'running', WORK_EVENT_KINDS.workRunning);
      active.store.setBlocker(work.work_id, null, WORK_EVENT_KINDS.workRunning);
      active.store.appendEvent(work.work_id, 'work_reconciled', {
        previous: work.status,
        resolution: 'prime conversation was already bound'
      });
      continue;
    }
    if (!work.integration_worktree || !work.integration_branch) {
      active.store.setWorkStatus(work.work_id, 'blocked', WORK_EVENT_KINDS.workBlocked);
      active.store.setBlocker(work.work_id, {
        code: WORK_BLOCKER_CODES.primeLaunchFailed,
        detail: 'The work has no integration worktree recorded, so its start stage cannot be repeated. Start a new work.',
        at: Date.now()
      }, WORK_EVENT_KINDS.workBlocked);
      continue;
    }
    const startCommand = active.store.listCommands(work.work_id, 50).find(command => command.kind === 'start');
    const requestId = startCommand?.request_id ?? prime.session_id;
    if (!requestId) {
      active.store.setWorkStatus(work.work_id, 'blocked', WORK_EVENT_KINDS.workBlocked);
      active.store.setBlocker(work.work_id, {
        code: WORK_BLOCKER_CODES.primeLaunchFailed,
        detail: 'The work has no recorded start command, so its opening message cannot be identified. Start a new work.',
        at: Date.now()
      }, WORK_EVENT_KINDS.workBlocked);
      continue;
    }
    active.store.appendEvent(work.work_id, 'work_redispatched', { previous: work.status, request_id: requestId });
    try {
      await beginStart(active, {
        workId: work.work_id,
        requestId,
        projectPath: work.project_path,
        goal: work.goal,
        title: work.title,
        model: work.model,
        reasoning: work.reasoning,
        maxWorkers: work.max_workers,
        integrationBranch: work.integration_branch,
        integrationWorktree: work.integration_worktree,
        ...(work.predecessor_work_id ? { predecessorWorkId: work.predecessor_work_id } : {}),
        createdAt: startCommand?.created_at ?? work.created_at
      });
    } catch (error) {
      active.store.setWorkStatus(work.work_id, 'blocked', WORK_EVENT_KINDS.workBlocked);
      active.store.setBlocker(work.work_id, {
        code: WORK_BLOCKER_CODES.primeLaunchFailed,
        detail: `The interrupted start could not be repeated: ${(error as Error).message}`.slice(0, 4000),
        at: Date.now()
      }, WORK_EVENT_KINDS.workBlocked);
    }
  }
}

function markUnknownBlocker(active: WorkRuntimeHandle, workId: string, operationId: string, detail: string): void {
  const work = active.store.getWork(workId);
  if (!work || work.status === 'cancelled' || work.status === 'completed') return;
  active.store.setBlocker(workId, {
    code: WORK_BLOCKER_CODES.operationOutcomeUnknown,
    detail: `Operation ${operationId} may already have taken effect (${detail}). It was not replayed. Send an instruction with resolve_operations to accept the observed effects or authorize one retry.`,
    at: Date.now(),
    operation_id: operationId
  }, WORK_EVENT_KINDS.workBlocked);
}

async function worktreeForSession(active: WorkRuntimeHandle, sessionId: string): Promise<string | null> {
  const agent = active.store.getAgentBySession(sessionId);
  if (!agent) return null;
  const assignment = active.store.getWorktreeAssignment(agent.work_id, agent.agent_id);
  return assignment?.path ?? agent.worktree_path ?? null;
}

// --------------------------------------------------------------------------- recovery actions

/** The durable session owns the prime frontend; the work row is only its projection. */
function projectManagedPrime(store: WorkStore, sessionId: string, from: string, to: string): boolean {
  const agent = store.getAgentBySession(sessionId);
  if (!agent || agent.role !== 'prime') return true;
  if (agent.conversation_id === to) return true;
  if (agent.conversation_id !== from) return false;
  store.bindAgentConversation({ agentId: agent.agent_id, sessionId, conversationId: to });
  return true;
}

/**
 * At startup, continuation restore has already repaired the authoritative session. Reconcile
 * its managed projection before the recovery owner re-arms any old A deadlines in either host.
 */
async function reconcileManagedPrimeBinding(store: WorkStore, prime: WorkAgentRow): Promise<boolean> {
  const session = await getSession(prime.session_id!);
  if (!session?.conversationId) return false;
  if (session.conversationId === prime.conversation_id) return true;
  if (!session.retiredChatAt?.[prime.conversation_id!]) {
    throw new Error(`managed prime ${prime.agent_id} cannot prove its retired source binding`);
  }
  // Re-read after the await; a later A→B→A must defeat the earlier B snapshot.
  const current = await getSession(prime.session_id!);
  const agent = store.getAgent(prime.agent_id);
  if (!current?.conversationId || !agent || agent.session_id !== prime.session_id) {
    throw new Error(`managed prime ${prime.agent_id} lost its session owner during recovery`);
  }
  if (agent.conversation_id === current.conversationId) return true;
  if (!current.retiredChatAt?.[agent.conversation_id ?? ''] ||
      !projectManagedPrime(store, prime.session_id!, agent.conversation_id!, current.conversationId)) {
    throw new Error(`managed prime ${prime.agent_id} cannot follow its durable session`);
  }
  return true;
}

async function reconcileManagedPrimeBindings(store: WorkStore): Promise<void> {
  await forEachWork(store, async work => {
    const prime = store.getPrimeAgent(work.work_id);
    if (!prime?.session_id || !prime.conversation_id) return;
    if (await reconcileManagedPrimeBinding(store, prime)) return;
    // A stopped historical work has no execution authority. Keep its binding untouched;
    // explicit resume must re-prove the session before lifting the work fence.
    if (work.desired_state === null && (work.status === 'paused' || work.status === 'cancelled' || work.status === 'completed')) {
      logWarn(`managed prime ${prime.agent_id} has no readable current session binding; retaining stopped work`);
      return;
    }
    throw new Error(`managed prime ${prime.agent_id} has no readable current session binding`);
  });
}

/**
 * Wires the single recovery owner's actions to the real mechanisms: the bridge's one-shot
 * reload, the outbox for a same-conversation continuation, and the existing continuation
 * transaction for a transfer to a fresh conversation.
 */
function recoveryActions(active: () => WorkRuntimeHandle): Parameters<typeof createRecoveryOwner>[0]['actions'] {
  return {
    async reload({ sessionId, conversationId, reason }) {
      const bridge = bridgeHooks();
      if (!bridge) {
        logWarn(`managed recovery wanted a reload for ${conversationId} but no bridge recovery hooks are installed`);
        return false;
      }
      return bridge.requestManagedReload({ sessionId, conversationId, reason });
    },
    async continueConversation({ sessionId, promptId, text, workId, agentId, generation }) {
      const activeRuntime = active();
      const work = activeRuntime.store.getWork(workId);
      if (!work) return false;
      // The prompt id was persisted by the owner before this call, so a crash here leaves a
      // retryable record rather than a duplicated send.
      // The recovery owner persisted this prompt id before the send. Its record's own timestamp is
      // the durable instant that record was made, so a retry after a restart schedules against the
      // same moment instead of a fresh one that would make the same message look new.
      const record = activeRuntime.store.loadRecovery<RecoveryRecord>(agentId, generation);
      const delivery = await deliverOutbox(activeRuntime, {
        id: promptId,
        sessionId,
        text,
        model: work.model,
        reasoning: work.reasoning,
        dueAt: record?.updated_at ?? work.created_at,
        workId
      });
      // `queued` is an accepted hand-off and `unknown` is an ambiguous one; neither may be
      // re-sent, and neither is a failure of the continuation itself.
      if (delivery.state === 'failed') {
        activeRuntime.store.appendEvent(workId, 'recovery_continuation_failed', {
          agent_id: agentId,
          generation,
          prompt_id: promptId,
          error: delivery.error ?? 'unknown'
        });
        return false;
      }
      activeRuntime.store.appendEvent(workId, 'recovery_continuation', { agent_id: agentId, generation, prompt_id: promptId });
      return true;
    },
    async transfer({ workId, agentId, generation, sessionId, conversationId, checkpoint }) {
      const activeRuntime = active();
      let ownedToken: string | null = null;
      let queueAttempted = false;
      let sourceEpoch: number | undefined;
      const sourceCurrent = async (): Promise<boolean> => {
        const session = await getSession(sessionId);
        const agent = activeRuntime.store.getAgent(agentId);
        return sourceEpoch !== undefined && session?.conversationId === conversationId &&
          session.bindingEpoch === sourceEpoch && agent?.session_id === sessionId && agent.conversation_id === conversationId &&
          agent.generation === generation && startStageLive(activeRuntime.store, workId, agentId, generation);
      };
      try {
        sourceEpoch = (await getSession(sessionId))?.bindingEpoch;
        if (!await sourceCurrent()) return false;
        // Exclusive opening prevents a host-generated checkpoint from modifying a ticket
        // already authorized by the user or another recovery attempt.
        const continuation = await openContinuationNow(sessionId, conversationId, true, null, true);
        ownedToken = continuation.token;
        if (!await sourceCurrent()) throw new Error('the managed source changed before checkpoint capture');
        const handoff = await attachSummary(continuation.token, continuationText(checkpoint));
        if (!handoff) throw new Error('the continuation could not store the host checkpoint');
        if (!await sourceCurrent()) throw new Error('the managed source changed before replacement opening');
        // Past queue handout, browser custody may be ambiguous. Never retire that ticket
        // merely because event recording or a subsequent await failed.
        queueAttempted = true;
        if (!queueResume(sessionId, continuation.token)) throw new Error('the replacement chat could not be queued');
        activeRuntime.store.appendEvent(workId, 'recovery_transfer', {
          agent_id: agentId, generation, token: continuation.token, host_generated: checkpoint.hostGenerated
        });
        return true;
      } catch (error) {
        if (ownedToken && !queueAttempted) {
          const ticket = continuationByToken(ownedToken);
          if (ticket && (ticket.state === 'awaiting-summary' || ticket.state === 'awaiting-chat') &&
              ticket.sourceSend.state === 'not-attempted' && ticket.destinationSend.state === 'not-attempted') {
            try {
              await abortContinuationNow(ownedToken, 'the managed recovery transfer could not be prepared');
            } catch (abortError) {
              logWarn(`managed recovery could not retire unsent continuation ${ownedToken}: ${abortError instanceof Error ? abortError.message : String(abortError)}`);
            }
          }
        }
        activeRuntime.store.appendEvent(workId, 'recovery_transfer_failed', {
          agent_id: agentId, generation, reason: (error as Error).message.slice(0, 500)
        });
        return false;
      }
    },
    onGenerationAdvanced({ workId, agentId, generation }) {
      active().store.appendEvent(workId, 'recovery_generation_advanced', { agent_id: agentId, generation });
    }
  };
}

let bridgeBridge: ManagedBridgeBridge | null = null;
function bridgeHooks(): ManagedBridgeBridge | null {
  return bridgeBridge;
}

// --------------------------------------------------------------------------- worker staging

/**
 * Prepares a managed worker's worktree before its chat is opened, and rewrites the bootstrap so
 * the worker knows exactly which folder, branch and base commit it owns.
 *
 * Returns the workers that should actually be opened: an unmanaged swarm is passed through
 * untouched, so this is inert for every existing use.
 */
export async function prepareManagedWorkerBootstraps(
  active: WorkRuntimeHandle,
  workers: readonly WorkerSpawn[]
): Promise<WorkerSpawn[]> {
  if (workers.length === 0) return [...workers];
  const out: WorkerSpawn[] = [];
  for (const worker of workers) {
    const prime = worker.primeConversationId ? active.store.getAgentByConversation(worker.primeConversationId) : null;
    if (!prime) {
      out.push(worker);
      continue;
    }
    const work = active.store.getWork(prime.work_id);
    if (!work) {
      failAgent(worker.id, `managed worktree preparation failed — work ${prime.work_id} is missing from the ledger`, undefined, {}, worker.runId);
      continue;
    }
    const baseCommit = work.base_commit ?? active.store.getWorktreeAssignment(work.work_id, prime.agent_id)?.baseCommit ?? '';
    if (!baseCommit) {
      const reason = 'the managed work has no captured base commit';
      failAgent(worker.id, `managed worktree preparation failed — ${reason}`, undefined, {}, worker.runId);
      active.store.appendEvent(work.work_id, 'worker_worktree_failed', {
        agent_id: worker.id,
        reason,
        reservation_released: false
      });
      continue;
    }
    let reservationCreatedAt: number | null = null;
    try {
      const createdAt = Date.now();
      active.store.insertAgent({
        agent_id: worker.id,
        work_id: work.work_id,
        parent_id: prime.agent_id,
        role: 'worker',
        label: worker.id,
        state: 'pending',
        session_id: null,
        conversation_id: null,
        generation: 0,
        worktree_path: null,
        branch: null,
        base_commit: baseCommit,
        model: worker.model,
        reasoning: worker.reasoningEffort,
        result_ref: null,
        checkpoint_ref: null,
        created_at: createdAt,
        updated_at: createdAt
      });
      reservationCreatedAt = createdAt;
      // createWorkerWorktree persists through assignWorktree. The exact agent reservation must
      // therefore exist first, while the chat still has not been opened.
      const assignment = await active.worktrees.createWorkerWorktree({
        workId: work.work_id,
        agentId: worker.id,
        baseCommit
      });
      active.store.appendEvent(work.work_id, WORK_EVENT_KINDS.agentRegistered, {
        agent_id: worker.id,
        role: 'worker',
        branch: assignment.branch,
        path: assignment.path,
        base_commit: assignment.baseCommit
      });
      // The worker's task is the prime's own words, plus the same kind of coordinates the prime
      // gets: which worktree and branch this worker owns and what it starts from. No instructions.
      out.push({
        ...worker,
        task: [
          worker.task,
          '',
          `Work: ${work.work_id}`,
          `Worktree: ${assignment.path}`,
          `Branch: ${assignment.branch}; base: ${assignment.baseCommit}`
        ].join('\n')
      });
    } catch (error) {
      const reason = error instanceof Error ? error.message : String(error);
      let reservationReleased = false;
      if (reservationCreatedAt !== null) {
        try {
          reservationReleased = active.store.releaseAgentReservation({
            agentId: worker.id,
            workId: work.work_id,
            parentId: prime.agent_id,
            createdAt: reservationCreatedAt
          });
          if (!reservationReleased) {
            const reserved = active.store.getAgent(worker.id);
            if (reserved?.work_id === work.work_id && reserved.created_at === reservationCreatedAt && reserved.state === 'pending') {
              active.store.updateAgent(worker.id, { state: 'failed' });
            }
          }
        } catch (rollbackError) {
          logWarn(`managed worker ${worker.id} reservation rollback failed: ${rollbackError instanceof Error ? rollbackError.message : String(rollbackError)}`);
        }
      }
      failAgent(worker.id, `managed worktree preparation failed — ${reason}`, undefined, {}, worker.runId);
      try {
        active.store.appendEvent(work.work_id, 'worker_worktree_failed', {
          agent_id: worker.id,
          reason: reason.slice(0, 500),
          reservation_released: reservationReleased
        });
      } catch (eventError) {
        logWarn(`managed worker ${worker.id} preparation failure could not be recorded: ${eventError instanceof Error ? eventError.message : String(eventError)}`);
      }
    }
  }
  return out;
}

/** Binds a worker's conversation to its durable agent row and its own worktree folder. */
export async function bindManagedWorkerConversation(conversationId: string, sessionId: string, agentId: string): Promise<boolean> {
  if (!runtime) return false;
  const active = runtime;
  const existing = active.store.getAgent(agentId);
  if (!existing) return false;
  active.store.bindAgentConversation({ agentId, sessionId, conversationId });
  active.store.updateAgent(agentId, { state: 'active' });
  return true;
}

/**
 * Installs the managed hooks the broker exposes: worker-worktree staging before a chat opens,
 * the proven worker binding, and the finish precondition.
 *
 * Called by `initWorkRuntime`; a host without a runtime keeps the unmanaged behavior exactly.
 */
function installBrokerHooks(active: () => WorkRuntimeHandle | null): void {
  setManagedPrimeRebind((sessionId, from, to) => {
    const handle = active();
    return handle ? projectManagedPrime(handle.store, sessionId, from, to) : false;
  });
  setSpawnTransform(async workers => {
    const handle = active();
    if (!handle) return workers;
    return prepareManagedWorkerBootstraps(handle, workers);
  });
  setConversationBindHook((agentId, conversationId, runId) => {
    const handle = active();
    if (!handle || !runId) return;
    const primeConversationId = primeConversation(runId);
    if (!primeConversationId) return;
    const prime = handle.store.getAgentByConversation(primeConversationId);
    if (!prime || prime.role !== 'prime') return;
    const agent = handle.store.getAgent(agentId);
    if (!agent || agent.role !== 'worker' || agent.work_id !== prime.work_id || agent.parent_id !== prime.agent_id) return;
    handle.store.bindAgentConversation({ agentId, sessionId: agent.session_id ?? '', conversationId });
    handle.store.updateAgent(agentId, { state: 'active' });
  });
  setFinishPrecondition(caller => {
    const handle = active();
    if (!handle) return null;
    const conversationId = caller.conversationId ?? null;
    if (!conversationId) return null;
    const agent = handle.store.getAgentByConversation(conversationId);
    if (!agent || agent.role !== 'worker') return null;
    // The gate already excludes the finish's own operation; by the time the broker's
    // precondition runs, the checkpoint has been taken and this is the last backstop.
    const live = handle.store.listOperationsForAgent(agent.agent_id, agent.generation)
      .filter(row => row.state === 'running' || row.state === 'prepared');
    if (live.length === 0) return null;
    return `WORKER_BUSY: ${live.length} operation(s) started by this agent are still live (${live.map(row => `${row.tool}:${row.operation_id}`).join(', ')}). Wait for them to settle, then finish again.`;
  });
  // §5: the bridge forwards its browser-observed facts to the single recovery owner, and the
  // owner's reload goes back through the bridge's own one-shot queue.
  setManagedRecoveryHooks({
    isManaged: conversationId => isManagedConversation(conversationId),
    onTurnFailure: input => {
      const handle = active();
      if (!handle) return false;
      const identity = managedIdentityForConversation(handle, input.conversationId);
      if (!identity) return false;
      handle.recovery.noteTurnFailure({
        kind: input.reason,
        workId: identity.workId,
        agentId: identity.agentId,
        sessionId: input.sessionId,
        conversationId: input.conversationId,
        turnId: input.turnId,
        generation: identity.generation,
        at: Date.now()
      });
      return true;
    },
    onSilence: input => {
      const handle = active();
      if (!handle) return false;
      const identity = managedIdentityForConversation(handle, input.conversationId);
      if (!identity) return false;
      handle.recovery.noteSilence({
        kind: 'silence',
        pro: input.pro,
        workId: identity.workId,
        agentId: identity.agentId,
        sessionId: input.sessionId,
        conversationId: input.conversationId,
        turnId: input.turnId,
        generation: identity.generation,
        at: Date.now()
      });
      return true;
    },
    onProgress: input => {
      const handle = active();
      if (!handle) return;
      const identity = managedIdentityForConversation(handle, input.conversationId);
      if (!identity) return;
      // Advisory only: a page heartbeat must not reset the episode count. The durable marker
      // that matters comes from the runtime's own operation completions.
      handle.recovery.noteProgress({
        kind: 'progress',
        workId: identity.workId,
        agentId: identity.agentId,
        sessionId: input.sessionId,
        conversationId: input.conversationId,
        turnId: input.turnId,
        generation: identity.generation,
        at: Date.now(),
        marker: { kind: 'instruction', textHash: `page:${input.turnId}` }
      });
    }
  });
}

/** The durable agent behind a proven conversation, or null when it is unmanaged. */
function managedIdentityForConversation(active: WorkRuntimeHandle, conversationId: string): { workId: string; agentId: string; generation: number } | null {
  const agent = active.store.getAgentByConversation(conversationId);
  if (!agent) return null;
  return { workId: agent.work_id, agentId: agent.agent_id, generation: agent.generation };
}

/** Removes the broker hooks on shutdown, so a closed runtime stops receiving observations. */
function clearBrokerHooks(): void {
  setManagedPrimeRebind(null);
  setSpawnTransform(null);
  setConversationBindHook(null);
  setFinishPrecondition(null);
  setManagedRecoveryHooks(null);
  setManagedCallerResolver(null);
}

/**
 * Installs the CUA gateway seam: the gateway asks the runtime for proven identity, and the
 * runtime asks the gateway two questions the gateway owns — whether an external call is on its
 * reviewed read-only allowlist, and whether a dispatched call's outcome is ambiguous.
 */
function installCuaSeam(): void {
  setManagedCallerResolver(context => {
    if (!context) throw new WorkServiceUnavailable();
    return assertManagedCaller(context);
  });
  cuaBridge = {
    isReadOnlyExternalCall,
    externalCallOutcome,
    releaseGuiLease,
    onGuiLeaseReleased
  };
}

// --------------------------------------------------------------------------- lifecycle

/**
 * Creates the runtime, the store, the service and the gate, and installs the gate so an
 * endpoint that starts listening afterwards is already fenced.
 *
 * Idempotent: concurrent callers share one initialization.
 */
export async function initWorkRuntime(deps: WorkRuntimeDeps): Promise<WorkRuntimeHandle> {
  if (runtime) return runtime;
  if (runtimePromise) return runtimePromise;
  runtimePromise = (async () => {
    const store = deps.store ?? createWorkStore({ dataDir: deps.dataDir, ...(deps.now ? { now: deps.now } : {}) });
    const operations = createOperationLedger({
      port: operationPortFor(store),
      artifacts: {
        write: (sessionId, text) => writeOverflowText(sessionId, text),
        read: (sessionId, assetId) => readOverflowText(sessionId, assetId)
      },
      ...(deps.now ? { now: deps.now } : {})
    });
    let handleRef: WorkRuntimeHandle | null = null;
    const recovery = createRecoveryOwner({
      port: recoveryPortFor(store),
      actions: recoveryActions(() => {
        if (!handleRef) throw new WorkServiceUnavailable();
        return handleRef;
      }),
      ...(deps.now ? { now: deps.now } : {})
    });
    const service = createWorkService({
      store,
      runtime: createRuntimePort(() => {
        if (!handleRef) throw new WorkServiceUnavailable();
        return handleRef;
      }),
      projects: projectDirectory(),
      models: modelSelection(),
      worktreesRoot: deps.worktreesRoot,
      ...(deps.now ? { now: deps.now } : {})
    });
    handleRef = {
      service,
      operations,
      recovery,
      store,
      worktrees: deps.worktrees,
      deliver: deps.deliverOutbox ?? null,
      readOutbox: deps.readOutbox ?? null,
      cancelOutbox: deps.cancelOutbox ?? null,
      drain: async () => {
        // Every work, not the first page: an older active work beyond the page would otherwise
        // be left unfenced and its owned processes alive across the quit. A work whose
        // pause/cancel is already committed is drained too — its own desired state decides the
        // terminal status, so a cancelled work stays cancelled and a pending pause finishes —
        // and no work is skipped merely because another control call got there first.
        await forEachWork(store, async work => {
          const active = work.desired_state === 'cancelled' || work.desired_state === 'paused' ||
            work.status === 'running' || work.status === 'starting' || work.status === 'recovering' ||
            work.status === 'queued';
          if (active) {
            const cancelled = work.desired_state === 'cancelled' || work.status === 'cancelled';
            await drainWork(handleRef!, work.work_id, cancelled ? 'cancelled' : 'paused');
            // The factual status is settled only after the drain really finished, so a quit
            // never publishes `paused`/`cancelled` over still-running owned processes.
            if (cancelled) {
              store.setWorkStatus(work.work_id, 'cancelled', WORK_EVENT_KINDS.cancelled);
            } else {
              store.setWorkStatus(work.work_id, 'paused', WORK_EVENT_KINDS.paused);
              // An explicit host stop is a pause the user must resume, and it is named as such —
              // but only when nothing more specific already applies. A cancelled work keeps its
              // terminal status, and a work already blocked by an unknown operation or a failed
              // drain keeps that blocker, because those are the facts the user has to act on.
              const current = store.getWork(work.work_id);
              const keepBlocker = current?.blocker &&
                (current.blocker.code === WORK_BLOCKER_CODES.operationOutcomeUnknown ||
                  current.blocker.code === WORK_BLOCKER_CODES.drainFailed ||
                  current.blocker.code === WORK_BLOCKER_CODES.recoveryExhausted);
              if (!keepBlocker) {
                store.setBlocker(work.work_id, {
                  code: WORK_BLOCKER_CODES.hostStopped,
                  detail: 'The host was stopped while this work was running. Resume it after the app is running again.',
                  at: Date.now()
                }, WORK_EVENT_KINDS.workBlocked);
              }
            }
            store.setDesiredState(work.work_id, null, WORK_EVENT_KINDS.paused);
          }
          setWorkPowerHolder(work.work_id, false);
        });
      },
      reconcile: async () => {
        await service.reconcile();
        recovery.reconcileOnStartup();
      }
    } as WorkRuntimeHandle;
    setWorkService(service);
    runtime = handleRef;
    installBrokerHooks(() => runtime);
    installCuaSeam();
    // The GUI's `work:changed` push and the CLI's event stream read this one bus; the store's
    // change stream is bridged into it for the lifetime of this runtime. The same subscription
    // keeps the power assertion in step with the durable lifecycle, so a work that starts holds
    // it and a work that pauses/blocks/completes releases it.
    detachChanges = attachWorkChanges(store);
    detachPower = subscribeWorkChanges(change => applyPowerFor(store.getWork(change.work_id)));
    logInfo(`work runtime initialized: store=${store.file} worktrees=${deps.worktreesRoot}`);
    return handleRef;
  })();
  try {
    return await runtimePromise;
  } finally {
    runtimePromise = null;
  }
}

/** The operation-ledger port: the store is structurally compatible already. */
function operationPortFor(store: WorkStore): OperationLedgerPort {
  return {
    getOperation: (id) => store.getOperation(id),
    insertOperation: (record) => store.insertOperation(record),
    updateOperation: (id, patch) => store.updateOperation(id, patch),
    listOpenOperations: (workId) => store.listOpenOperations(workId),
    admissionContext: (agentId): OperationAdmissionContext | null => {
      const context = store.admissionContext(agentId);
      return context ?? null;
    },
    appendEvent: (workId, kind, payload) => store.appendEvent(workId, kind, payload)
  };
}

/** The recovery owner's port, over the same store plus the operation rows. */
function recoveryPortFor(store: WorkStore) {
  return {
    load: (agentId: string, generation: number): RecoveryRecord | null => {
      const record = store.loadRecovery<RecoveryRecord>(agentId, generation);
      const agent = store.getAgent(agentId);
      return record && agent?.generation === generation && agent.session_id === record.session_id &&
        agent.conversation_id === record.conversation_id ? record : null;
    },
    save: (record: RecoveryRecord) => store.saveRecovery(record),
    list: (): RecoveryRecord[] => store.listRecovery<RecoveryRecord>().filter(record => {
      const agent = store.getAgent(record.agent_id);
      return agent?.generation === record.generation && agent.session_id === record.session_id &&
        agent.conversation_id === record.conversation_id;
    }),
    hasActiveCommands: (observation: { agentId: string; generation: number }) =>
      store.countActiveOperations(observation.agentId, observation.generation) > 0,
    lastProgress: (observation: { agentId: string; generation: number }): ProgressMarker | null => {
      const record = store.loadRecovery<RecoveryRecord>(observation.agentId, observation.generation);
      if (!record?.last_progress) return null;
      return parseProgressMarker(record.last_progress);
    },
    readCheckpoint: (workId: string) => {
      const work = store.getWork(workId);
      if (!work?.checkpoint) return null;
      return {
        summary: work.checkpoint.summary,
        remaining: work.checkpoint.remaining,
        verification: work.checkpoint.verification,
        revision: work.checkpoint.revision,
        hostGenerated: work.checkpoint.host_generated
      };
    },
    fenceGeneration: (input: { workId: string; agentId: string; generation: number }) => store.fenceAgentGeneration(input),
    markBlocked: (input: { workId: string; reason: 'RECOVERY_EXHAUSTED' | 'AUTH_REQUIRED' | 'PROVIDER_UNAVAILABLE'; detail: string }) => {
      store.setWorkStatus(input.workId, 'blocked', WORK_EVENT_KINDS.workBlocked);
      store.setBlocker(input.workId, { code: input.reason, detail: input.detail.slice(0, 4000), at: Date.now() }, WORK_EVENT_KINDS.workBlocked);
      if (cuaBridge) void cuaBridge.releaseGuiLease(input.workId).catch(() => undefined);
    },
    advanceGeneration: (input: { workId: string; agentId: string }) => store.advanceAgentGeneration(input),
    appendEvent: (workId: string, kind: string, payload: unknown) => store.appendEvent(workId, kind, payload)
  };
}

/** Round-trips a stored progress marker back into its typed form. */
function parseProgressMarker(value: string): ProgressMarker | null {
  if (value.startsWith('tree:')) return { kind: 'tree', treeHash: value.slice(5) };
  if (value.startsWith('instr:')) return { kind: 'instruction', textHash: value.slice(6) };
  if (value.startsWith('op:')) {
    const [, inputHash, resultHash] = value.split(':');
    if (inputHash && resultHash) return { kind: 'operation', inputHash, resultHash };
  }
  return null;
}

/** The existing project registry, behind the service's narrow interface. */
function projectDirectory() {
  return {
    async resolve(inputPath: string) {
      if (!path.isAbsolute(inputPath)) {
        return { path: inputPath, name: path.basename(inputPath), exists: false, isGit: false, error: 'the project path must be absolute' };
      }
      // Canonicalize first: the ledger, the worktrees and the sandbox must all agree on one
      // path. A symlinked project would otherwise produce two spellings of the same folder.
      const resolved = await resolvePath(getConfig().roots, inputPath).catch(() => null);
      const candidate = resolved?.real ?? inputPath;
      const real = await fs.realpath(candidate).catch(() => null);
      if (!real) {
        return { path: candidate, name: path.basename(candidate), exists: false, isGit: false, error: 'that folder does not exist or is not a directory' };
      }
      const stat = await fs.stat(real).catch(() => null);
      if (!stat?.isDirectory()) {
        return { path: real, name: path.basename(real), exists: false, isGit: false, error: 'that path is not a directory' };
      }
      // A worktree's `.git` is a file, not a directory, so existence is the only test that is
      // true for both a repository and a linked worktree.
      const isGit = await fs.stat(path.join(real, '.git')).then(() => true).catch(() => false);
      return { path: real, name: path.basename(real), exists: true, isGit };
    },
    async list() {
      const projects = await listProjects().catch(() => []);
      return projects.map(project => ({ id: project.id, name: project.name, path: project.path }));
    }
  };
}

/**
 * Model/effort selection against what the account actually offers.
 *
 * A requested pair that is not observed is a refusal, never a silent downgrade; an unspecified
 * pair inherits the saved setup selection. When the account's model list has not been observed
 * yet, an explicitly requested model cannot be validated — and inventing a selection would be
 * worse than saying so, so it is refused as `MODEL_UNAVAILABLE` with the reason.
 */
function modelSelection() {
  return {
    async resolve(input: { model?: string; reasoning?: string }) {
      const catalog = getChatModels();
      const configured = getConfig().multiAgent;
      const model = input.model ?? configured.defaultModel ?? null;
      const reasoning = input.reasoning ?? configured.defaultReasoning ?? null;
      const explicit = input.model !== undefined || input.reasoning !== undefined;
      if (catalog.models.length === 0) {
        // No observation yet. Inheriting the saved default is honest ("use whatever the app is
        // configured to use"); an explicit request cannot be verified, so it is refused rather
        // than accepted on faith and then silently ignored by the ChatGPT picker.
        if (explicit) {
          throw new WorkError(
            WORK_ERROR_CODES.modelUnavailable,
            'MODEL_UNAVAILABLE: this account\'s available models have not been observed yet, so the requested model/effort cannot be verified. Open the app once so it can discover the account models, then retry.'
          );
        }
        return { model, reasoning };
      }
      if (!model) return { model: null, reasoning };
      const offered = catalog.models.find(entry => entry.id === model);
      if (!offered) {
        throw new WorkError(
          WORK_ERROR_CODES.modelUnavailable,
          `MODEL_UNAVAILABLE: "${model}" is not offered by this ChatGPT account. Observed models: ${catalog.models.map(entry => entry.id).join(', ')}.`
        );
      }
      if (reasoning && offered.efforts.length > 0 && !offered.efforts.includes(reasoning as never)) {
        throw new WorkError(
          WORK_ERROR_CODES.modelUnavailable,
          `MODEL_UNAVAILABLE: reasoning "${reasoning}" is not offered for "${model}". Observed efforts: ${offered.efforts.join(', ')}.`
        );
      }
      return { model, reasoning };
    }
  };
}

/**
 * Pause/cancel/host-shutdown drain for the whole runtime.
 *
 * The drain is terminal for the runtime *instance*, so the module state goes with it: the handle
 * and its closed ledger are dropped, and a host that needs a work runtime again builds a fresh one
 * through `initWorkRuntime`. Leaving a drained handle installed is how a later start would silently
 * reuse a closed SQLite handle — its statements finalized, its service closed — and fail somewhere
 * far away from the drain that caused it. Nothing is admitted in the meantime either: with no
 * runtime installed, every path that needs one refuses through `WorkServiceUnavailable`, and the
 * caller's own endpoint is already stopped.
 */
export async function drainWorkRuntime(): Promise<void> {
  shuttingDown = true;
  const active = runtime;
  runtime = null;
  runtimePromise = null;
  if (active) await active.drain().catch(error => logWarn(`work runtime drain failed: ${(error as Error).message}`));
  // Watchers sleeping between polls belong to the drained runtime. `shuttingDown` is cleared
  // below for a later restart, so revoke their ownership here; otherwise one wakes after the
  // store it holds was closed and reads through a finalized statement.
  bindingWatchers.clear();
  clearBrokerHooks();
  detachChanges?.();
  detachChanges = null;
  detachPower?.();
  detachPower = null;
  active?.service.close();
  setWorkService(null);
  // Cleared last, and only after everything the drain owned is released, so a concurrent caller
  // that was already inside a handler still sees the runtime as gone rather than as restartable.
  shuttingDown = false;
}

/**
 * The power assertion for one work.
 *
 * Held while a work is starting/running/recovering or a pause/cancel is still draining, and
 * released the moment it is not. Reference-counted per work id, so two works hold independently
 * and a second reconciliation after a restart cannot release the first work's claim.
 */
export function setWorkPowerHolder(workId: string, held: boolean): void {
  setPowerHolder(`work:${workId}`, held);
}

/** The statuses that keep the host awake, plus a committed pause/cancel that has not drained. */
const POWER_HELD_STATES = new Set(['queued', 'starting', 'running', 'recovering']);

/**
 * The worktree manager's activity probe, backed by the real operation ledger.
 *
 * A worktree is busy while any operation of its work is `prepared` or `running`, because those
 * are exactly the mutations that can still be writing files or holding a process. The caller's
 * own receipt travels in the call (`excludeOperationId`) rather than in module state: two works
 * integrating concurrently must not clobber each other's exclusion, and a process-wide slot
 * would let one work's integration see the other's receipt as its own.
 */
export function createWorktreeActivityProbe(store: WorkStore): {
  isBusy(input: { workId: string; worktreePath: string; excludeOperationId?: string }): boolean;
} {
  return {
    isBusy: input => store.listOpenOperations(input.workId)
      .some(operation => operation.operation_id !== input.excludeOperationId)
  };
}

/**
 * Reconciles every held power assertion with the durable ledger.
 *
 * Called at startup and after every committed work change, so a transition into or out of
 * `starting`/`running`/`recovering` (or a pause/cancel that has not drained yet) updates the
 * assertion immediately. It reads the works this process is already tracking plus the changed
 * row, never a fresh scan of the whole table per event.
 */
function applyPowerFor(work: WorkRow | null | undefined): void {
  if (!work) return;
  const draining = work.desired_state !== null && work.status !== 'paused' && work.status !== 'cancelled';
  setWorkPowerHolder(work.work_id, draining || POWER_HELD_STATES.has(work.status));
}

/** Startup: reconcile the whole ledger once, and release any holder whose work is gone. */
export async function syncWorkPowerHolders(): Promise<void> {
  if (!runtime) return;
  const seen = new Set<string>();
  await forEachWork(runtime.store, work => {
    seen.add(work.work_id);
    applyPowerFor(work);
  });
  for (const name of powerHolders()) {
    if (!name.startsWith('work:')) continue;
    const workId = name.slice('work:'.length);
    if (seen.has(workId)) continue;
    setPowerHolder(name, false);
  }
}

/** Test seam: forget the runtime without touching disk. */
export function resetWorkRuntimeForTests(): void {
  setManagedPrimeRebind(null);
  // The coalescing set is process-local by design: a restart must re-prove from the ledger, which
  // is exactly what this clears the way for.
  recordedNativeExecutions.clear();
  bindingWatchers.clear();
  runtime = null;
  runtimePromise = null;
  shuttingDown = false;
  cuaBridge = null;
  bridgeBridge = null;
  detachChanges?.();
  detachChanges = null;
  detachPower?.();
  detachPower = null;
  setWorkService(null);
}

/**
 * Test seam: deliver one durable command through the real delivery path.
 *
 * The delivery decision for a *linked* instruction (one whose outbox id is the successor's opening)
 * is a property of the runtime's own port, so a test has to reach it without first having to make
 * the service create a successor. This calls exactly the production function.
 */
export function deliverWorkCommandForTests(input: WorkRuntimeDelivery): Promise<WorkRuntimeDeliveryResult> {
  if (!runtime) return Promise.resolve({ state: 'failed', error: 'no work runtime is installed' });
  return deliverCommand(runtime, input);
}

/** Test seam: install the runtime directly, for tests that own their own store. */
export function installWorkRuntimeForTests(handle: WorkRuntimeHandle): void {
  runtime = handle;
  shuttingDown = false;
}

/**
 * Startup reconciliation, in one named step so the host's startup seam reads as one line.
 *
 * Runs before any admission: the service reconciles commands and open operations, the recovery
 * owner re-arms deadlines that outlived the process, and the power holders are reconciled with
 * the durable ledger.
 */
export async function reconcileWorkRuntime(): Promise<void> {
  const active = current();
  await reconcileManagedPrimeBindings(active.store);
  await active.reconcile();
  await syncWorkPowerHolders();
}

export function isWorkRuntimeReady(): boolean {
  return runtime !== null && !shuttingDown;
}
