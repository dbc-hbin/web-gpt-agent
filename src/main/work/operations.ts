/**
 * Durable mutation receipts for managed work.
 *
 * One row per logical mutation, keyed by a UUID the caller supplies. The row is written
 * *before* any side effect and committed through `prepared -> running -> completed`, so a
 * retried call with the same id and the same canonical arguments joins the original result
 * instead of running the command again. A retried call with the same id and *different*
 * arguments is a conflict, never a second execution.
 *
 * The module owns no database. It is written against a narrow port so the work ledger
 * (`store.ts`) can satisfy it structurally, and so the state machine can be tested without
 * SQLite. Everything that talks to disk — the store, and the session asset helpers used to
 * retain completed output — is injected.
 *
 * Ownership is immutable: the agent and work recorded on the first admission are the only
 * ones that may ever resolve that operation id. A worker cannot claim another worker's
 * receipt by reusing its id, because the id is checked against the recorded owner before the
 * receipt is even looked up.
 */

import { createHash } from 'node:crypto';
import { promises as fs } from 'node:fs';
import path from 'node:path';
import type { ToolResult } from '../mcp/kernel.js';

export type OperationState = 'prepared' | 'running' | 'completed' | 'failed' | 'outcome_unknown';

/** Why an operation is no longer live, when a user explicitly decided its fate. */
export interface OperationResolution {
  decision: 'accept_observed_effects' | 'authorize_retry';
  note: string;
  at: number;
  /** The command id that carried the decision, for audit. */
  by_command: string;
}

export interface WorkOperationRecord {
  operation_id: string;
  work_id: string;
  agent_id: string;
  generation: number;
  tool: string;
  /** Canonical validated tool+args hash, excluding `operation_id`. */
  args_hash: string;
  state: OperationState;
  /** Managed process id, when the operation launched or continued one. */
  process_id: string | null;
  /** Durable reference (session asset id) to the retained result text. */
  result_ref: string | null;
  /** Bounded inline result projection, so a replay does not need the asset. */
  result_json: string | null;
  /** The managed session that owns the retained result asset. */
  session_id: string | null;
  /** Patch recovery: blob hash per path before the write, keyed by the patch's spelling. */
  expect_before: Record<string, string | null> | null;
  /** Patch recovery: expected blob hash per path after the write. */
  expect_after: Record<string, string | null> | null;
  /** `retry_of` names the unknown operation this row was authorized to replace. */
  retry_of: string | null;
  /** On an unknown row, the fresh operation id the user authorized for one retry. */
  retry_operation_id: string | null;
  resolution: OperationResolution | null;
  created_at: number;
  updated_at: number;
}

/** The minimal work/agent projection admission needs; the ledger owns the real rows. */
export interface OperationAdmissionContext {
  work_id: string;
  work_status: string;
  agent_id: string;
  agent_generation: number;
  agent_state: string;
}

/**
 * Everything durable the operation state machine needs.
 *
 * `insertOperation` MUST be atomic and MUST throw when the id already exists — that throw is
 * the only thing standing between two concurrent retries and two executions.
 */
export interface OperationLedgerPort {
  getOperation(operationId: string): WorkOperationRecord | null;
  insertOperation(record: WorkOperationRecord): void;
  updateOperation(operationId: string, patch: Partial<WorkOperationRecord>): void;
  listOpenOperations(workId?: string): WorkOperationRecord[];
  /** Agent/work projection used to fence generation and work status before execution. */
  admissionContext(agentId: string): OperationAdmissionContext | null;
  appendEvent(workId: string, kind: string, payload: unknown): number;
}

/** Retained result storage; production passes the session asset helpers. */
export interface OperationArtifactPort {
  write(sessionId: string, text: string): Promise<string | null>;
  read(sessionId: string, assetId: string): Promise<string | null>;
}

export type OperationRejectionCode =
  | 'OPERATION_ID_REQUIRED'
  | 'OPERATION_ID_CONFLICT'
  | 'STALE_AGENT_GENERATION'
  | 'WORK_NOT_RUNNING'
  | 'OPERATION_UNKNOWN_UNRESOLVED'
  | 'STATE_UNAVAILABLE';

export type OperationAdmission =
  | { kind: 'admitted'; operationId: string; record: WorkOperationRecord }
  | {
      kind: 'joined';
      operationId: string;
      record: WorkOperationRecord;
      /** Present when the original call already completed or failed. */
      replay?: ToolResult;
      /** Present while the original call is still running in this process. */
      pending?: Promise<ToolResult>;
    }
  | { kind: 'retry'; operationId: string; retryOperationId: string; record: WorkOperationRecord }
  | { kind: 'rejected'; code: OperationRejectionCode; message: string };

export interface OperationAdmissionInput {
  operationId: string;
  workId: string;
  agentId: string;
  generation: number;
  tool: string;
  /** Parsed, validated arguments exactly as the handler will consume them. */
  args: unknown;
  /** Managed session that owns retained result assets. */
  sessionId: string | null;
  /**
   * What this call's name actually resolved to, when the surface that owns the routing knows.
   *
   * A raw Plugins child is named by the upstream tool's own name, and a plugin refresh can
   * rebind that name to a different installation or a different declaration. The name alone
   * would then let a retry join a receipt that describes a *different* tool, so the surface
   * supplies the resolved identity and it becomes part of the receipt's hash. Absent for Core
   * calls, whose name is the identity.
   */
  scope?: string | null;
  /** Patch recovery only: pre-write blob hashes for every affected path. */
  expectBefore?: Record<string, string | null> | null;
  now?: number;
}

export interface OperationCompletion {
  operationId: string;
  result: ToolResult;
  /** Managed process id, when this operation owns or continues one. */
  processId?: string | null;
  /** Patch recovery only: post-write blob hashes for the recorded paths. */
  expectAfter?: Record<string, string | null> | null;
  /** Managed session that owns the retained result asset, when one is known. */
  sessionId?: string | null;
}

const MAX_INLINE_RESULT_BYTES = 8 * 1024;

/**
 * Canonical JSON: object keys sorted, `undefined` dropped, arrays kept in order.
 *
 * Two spellings of the same arguments must hash identically or a retry looks like a
 * different command. Values that cannot be serialized are represented by their type name
 * rather than silently becoming `null`.
 */
function canonicalize(value: unknown): unknown {
  if (value === null || typeof value !== 'object') {
    if (typeof value === 'number' && !Number.isFinite(value)) return { __number: String(value) };
    if (typeof value === 'bigint') return { __bigint: value.toString() };
    return value;
  }
  if (Array.isArray(value)) return value.map(canonicalize);
  const source = value as Record<string, unknown>;
  const out: Record<string, unknown> = {};
  for (const key of Object.keys(source).sort()) {
    if (source[key] === undefined) continue;
    out[key] = canonicalize(source[key]);
  }
  return out;
}

/**
 * Stable hash of a validated tool call. `operation_id` is excluded so the same logical
 * mutation retried with a *different* operation id (an authorized retry) hashes the same as
 * the original, while an id reused with different arguments does not.
 *
 * `scope` is the resolved identity behind the name when the owning surface can state one (a
 * raw Plugins child names its installation and declaration, not just the upstream tool name).
 * It is part of the hash because a name is not an identity: a plugin refresh can rebind the
 * same upstream name to another installation or a changed declaration, and a reused operation
 * id must then conflict rather than silently join the previous tool's receipt.
 */
export function canonicalOperationHash(tool: string, args: unknown, scope?: string | null): string {
  const source = args && typeof args === 'object' && !Array.isArray(args)
    ? { ...(args as Record<string, unknown>) }
    : args;
  if (source && typeof source === 'object' && !Array.isArray(source)) {
    delete (source as Record<string, unknown>)['operation_id'];
  }
  const canonicalArgs = canonicalize(source);
  const body = JSON.stringify(scope == null ? { tool, args: canonicalArgs } : { tool, scope, args: canonicalArgs });
  return createHash('sha256').update(body, 'utf8').digest('hex');
}

/** One managed mutation, resolved against the durable ledger. */
export interface OperationLedger {
  admit(input: OperationAdmissionInput): Promise<OperationAdmission>;
  /** Commits `running` before the caller performs any external side effect. */
  markRunning(operationId: string, processId?: string | null): void;
  complete(input: OperationCompletion): Promise<void>;
  fail(operationId: string, message: string, sessionId?: string | null): Promise<void>;
  /** A host crash or lost transport left the outcome unknown; never replayed blindly. */
  markUnknown(operationId: string, reason: string): void;
  /**
   * Records an explicit user decision on an unknown operation and returns the fresh
   * operation id when a retry was authorized.
   */
  resolveUnknown(input: {
    operationId: string;
    decision: 'accept_observed_effects' | 'authorize_retry';
    note: string;
    byCommand: string;
    retryOperationId?: string;
  }): { ok: true; retryOperationId?: string } | { ok: false; code: OperationRejectionCode; message: string };
  /**
   * Records the pre-write and expected post-write blob hashes for a patch operation, before any
   * file is touched. Kept on the ledger so the runtime never reaches into store patch shapes.
   */
  setExpectations(operationId: string, expectations: {
    before: Record<string, string | null>;
    after: Record<string, string | null>;
  }): void;
  get(operationId: string): WorkOperationRecord | null;
  /** Live rows whose outcome the process cannot vouch for; used at startup. */
  openOperations(workId?: string): WorkOperationRecord[];
  /**
   * Registers the handler promise for a freshly admitted operation, so a retry arriving while
   * the first call still runs joins it rather than executing a second copy.
   */
  track(operationId: string, work: Promise<ToolResult>): void;
  /** Test/observability seam: operations joined in this process right now. */
  inFlightCount(): number;
}

export interface OperationLedgerDeps {
  port: OperationLedgerPort;
  artifacts?: OperationArtifactPort;
  now?: () => number;
}

function replayFrom(record: WorkOperationRecord): ToolResult | undefined {
  if (record.state !== 'completed' && record.state !== 'failed') return undefined;
  if (record.result_json) {
    try {
      const parsed = JSON.parse(record.result_json) as ToolResult;
      if (parsed && Array.isArray(parsed.content)) return parsed;
    } catch {
      /* Fall through to the durable text reference. */
    }
  }
  return undefined;
}

/**
 * One same-process admission claim: the id is admitted, the handler promise does not exist yet.
 *
 * `admit` is fully synchronous, so claiming an id and observing an existing claim cannot
 * interleave. That is what makes two identical concurrent calls resolve to one execution
 * instead of two: the first claims, the second joins the claim, and `track` attaches the real
 * handler promise to it in the same synchronous step that creates it.
 */
interface OperationClaim {
  /** Resolves with the handler promise once `track` registers it. */
  readonly work: Promise<ToolResult>;
  readonly attach: (work: Promise<ToolResult>) => void;
}

function newClaim(): OperationClaim {
  const { promise: work, resolve } = Promise.withResolvers<ToolResult>();
  // A joiner receives the original call's own failure, so the derived promise may reject
  // without a joiner attached; mark it observed so an unjoined rejection is not an unhandled one.
  void work.catch(() => undefined);
  return { work, attach: resolve };
}

export function createOperationLedger(deps: OperationLedgerDeps): OperationLedger {
  const { port, artifacts } = deps;
  const now = deps.now ?? (() => Date.now());
  /** Same-process claims: admitted in this process, handler not yet registered. */
  const claims = new Map<string, OperationClaim>();
  /** Same-process joins: the in-flight promise for an admitted operation. */
  const inFlight = new Map<string, Promise<ToolResult>>();

  const reject = (code: OperationRejectionCode, message: string): OperationAdmission => ({ kind: 'rejected', code, message });

  function persistResult(result: ToolResult, sessionId: string | null): Promise<{ ref: string | null; json: string | null }> {
    const serialized = JSON.stringify(result);
    const inline = Buffer.byteLength(serialized, 'utf8') <= MAX_INLINE_RESULT_BYTES ? serialized : null;
    const text = result.content
      .filter((part): part is Extract<ToolResult['content'][number], { type: 'text' }> => part.type === 'text')
      .map((part) => part.text).join('\n');
    if (!artifacts || !sessionId || text.length === 0) return Promise.resolve({ ref: null, json: inline });
    return artifacts.write(sessionId, text)
      .then((ref) => ({ ref, json: inline }))
      .catch(() => ({ ref: null, json: inline }));
  }

  /** Registers the handler promise for an admitted operation so a retry can join it. */
  function track(operationId: string, work: Promise<ToolResult>): void {
    const claim = claims.get(operationId);
    if (claim) {
      claims.delete(operationId);
      claim.attach(work);
    }
    inFlight.set(operationId, work);
    const settled = (): void => { if (inFlight.get(operationId) === work) inFlight.delete(operationId); };
    void work.then(settled, settled);
  }

  /**
   * The handler promise for one id, if this process can already name it.
   *
   * `running` means the receipt was committed but the caller has not reached `track` yet; a
   * joiner still receives the claim, so a duplicate never falls through to the
   * "still running, do not repeat" text and never starts a second execution.
   */
  function liveWork(operationId: string): Promise<ToolResult> | undefined {
    return inFlight.get(operationId) ?? claims.get(operationId)?.work;
  }

  return {
    async admit(input) {
      const context = port.admissionContext(input.agentId);
      if (!context) {
        return reject('STATE_UNAVAILABLE', 'STATE_UNAVAILABLE: the durable work ledger has no record for this agent, so no mutation was admitted.');
      }
      // Ownership and generation are checked before the receipt is consulted. A stale
      // generation must not be able to observe, join or replay a current operation.
      if (context.work_id !== input.workId || context.agent_id !== input.agentId) {
        return reject('OPERATION_ID_CONFLICT', 'OPERATION_ID_CONFLICT: this operation id belongs to another work or agent. No mutation was performed.');
      }
      if (context.agent_generation !== input.generation) {
        return reject('STALE_AGENT_GENERATION', `STALE_AGENT_GENERATION: this conversation belongs to generation ${context.agent_generation}, not ${input.generation}. Its replacement owns this agent now; do not retry here.`);
      }
      if (!['running', 'recovering', 'starting'].includes(context.work_status)) {
        return reject('WORK_NOT_RUNNING', `WORK_NOT_RUNNING: this work is ${context.work_status}. No mutation was admitted; wait for it to resume or ask the user to resume it.`);
      }
      const hash = canonicalOperationHash(input.tool, input.args, input.scope);
      const existing = port.getOperation(input.operationId);
      if (existing) {
        if (existing.work_id !== input.workId || existing.agent_id !== input.agentId || existing.args_hash !== hash) {
          return reject('OPERATION_ID_CONFLICT', 'OPERATION_ID_CONFLICT: this operation id was already used with different arguments or by another agent. Nothing was run; use a new operation_id for the new work.');
        }
        switch (existing.state) {
          case 'completed':
          case 'failed': {
            const replay = replayFrom(existing);
            return replay
              ? { kind: 'joined', operationId: existing.operation_id, record: existing, replay }
              : { kind: 'joined', operationId: existing.operation_id, record: existing };
          }
          case 'running': {
            const pending = liveWork(existing.operation_id);
            return { kind: 'joined', operationId: existing.operation_id, record: existing, ...(pending ? { pending } : {}) };
          }
          case 'prepared': {
            // Admitted but never committed to a side effect: safe to run under this same row.
            // The claim is what makes it *this* call's row: a second identical call arriving
            // while the first is still between its receipt and its handler joins the claim
            // rather than becoming a second `admitted` and running the mutation twice.
            const pending = liveWork(existing.operation_id);
            if (pending) return { kind: 'joined', operationId: existing.operation_id, record: existing, pending };
            claims.set(existing.operation_id, newClaim());
            return { kind: 'admitted', operationId: existing.operation_id, record: existing };
          }
          case 'outcome_unknown': {
            if (existing.resolution?.decision === 'accept_observed_effects') {
              return {
                kind: 'joined',
                operationId: existing.operation_id,
                record: existing,
                replay: {
                  content: [{ type: 'text', text: `OPERATION_EFFECTS_ACCEPTED: the user recorded that this operation's effects were accepted without a verified result. Do not run it again. (${existing.resolution.note})` }],
                  isError: true
                }
              };
            }
            if (existing.resolution?.decision === 'authorize_retry' && existing.retry_operation_id) {
              return { kind: 'retry', operationId: existing.operation_id, retryOperationId: existing.retry_operation_id, record: existing };
            }
            return reject('OPERATION_UNKNOWN_UNRESOLVED', 'OPERATION_UNKNOWN_UNRESOLVED: this operation may already have taken effect and its result was never recorded. Nothing was run again. Ask the user to accept the observed effects or authorize one retry before repeating it.');
          }
        }
      }
      const at = input.now ?? now();
      const record: WorkOperationRecord = {
        operation_id: input.operationId,
        work_id: input.workId,
        agent_id: input.agentId,
        generation: input.generation,
        tool: input.tool,
        args_hash: hash,
        state: 'prepared',
        process_id: null,
        result_ref: null,
        result_json: null,
        session_id: input.sessionId,
        expect_before: input.expectBefore ?? null,
        expect_after: null,
        retry_of: null,
        retry_operation_id: null,
        resolution: null,
        created_at: at,
        updated_at: at
      };
      try {
        port.insertOperation(record);
      } catch (error) {
        // A concurrent call inserted the same id between our read and our write. Re-read:
        // the loser joins the winner rather than running a second copy.
        const raced = port.getOperation(input.operationId);
        if (!raced) throw error;
        if (raced.args_hash !== hash) {
          return reject('OPERATION_ID_CONFLICT', 'OPERATION_ID_CONFLICT: this operation id was used concurrently with different arguments. Nothing extra was run.');
        }
        const pending = liveWork(raced.operation_id);
        return { kind: 'joined', operationId: raced.operation_id, record: raced, ...(pending ? { pending } : {}) };
      }
      // The claim is registered before this call returns, so an identical call arriving while
      // this one is still between its receipt and its handler joins it instead of being
      // admitted a second time.
      claims.set(record.operation_id, newClaim());
      port.appendEvent(input.workId, 'operation_prepared', { operation_id: record.operation_id, tool: record.tool, agent_id: record.agent_id, generation: record.generation });
      return { kind: 'admitted', operationId: record.operation_id, record };
    },

    markRunning(operationId, processId) {
      port.updateOperation(operationId, { state: 'running', process_id: processId ?? null, updated_at: now() });
    },

    async complete({ operationId, result, processId, expectAfter, sessionId }) {
      const record = port.getOperation(operationId);
      if (!record) return;
      const stored = await persistResult(result, sessionId ?? record.session_id);
      port.updateOperation(operationId, {
        state: 'completed',
        process_id: processId ?? record.process_id,
        result_ref: stored.ref,
        result_json: stored.json,
        expect_after: expectAfter ?? record.expect_after,
        updated_at: now()
      });
      port.appendEvent(record.work_id, 'operation_completed', { operation_id: operationId, agent_id: record.agent_id, tool: record.tool });
    },

    async fail(operationId, message, sessionId) {
      const record = port.getOperation(operationId);
      if (!record) return;
      const stored = await persistResult({ content: [{ type: 'text', text: message }], isError: true }, sessionId ?? null);
      port.updateOperation(operationId, { state: 'failed', result_ref: stored.ref, result_json: stored.json, updated_at: now() });
      port.appendEvent(record.work_id, 'operation_failed', { operation_id: operationId, agent_id: record.agent_id, tool: record.tool });
    },

    markUnknown(operationId, reason) {
      const record = port.getOperation(operationId);
      if (!record || record.state === 'completed' || record.state === 'failed') return;
      port.updateOperation(operationId, { state: 'outcome_unknown', updated_at: now() });
      port.appendEvent(record.work_id, 'operation_outcome_unknown', { operation_id: operationId, agent_id: record.agent_id, tool: record.tool, reason: reason.slice(0, 500) });
    },

    resolveUnknown({ operationId, decision, note, byCommand, retryOperationId }) {
      const record = port.getOperation(operationId);
      if (!record) return { ok: false, code: 'STATE_UNAVAILABLE', message: 'STATE_UNAVAILABLE: that operation is not in the durable ledger.' };
      if (record.state !== 'outcome_unknown') {
        return { ok: false, code: 'OPERATION_ID_CONFLICT', message: 'OPERATION_ID_CONFLICT: that operation already has a settled outcome; no resolution was recorded.' };
      }
      if (record.resolution) {
        return { ok: false, code: 'OPERATION_ID_CONFLICT', message: 'OPERATION_ID_CONFLICT: that operation was already resolved. Ask the user to decide on the current state instead.' };
      }
      if (decision === 'authorize_retry' && !retryOperationId) {
        return { ok: false, code: 'STATE_UNAVAILABLE', message: 'STATE_UNAVAILABLE: an authorized retry needs a fresh operation id.' };
      }
      port.updateOperation(operationId, {
        resolution: { decision, note: note.slice(0, 2000), at: now(), by_command: byCommand },
        retry_operation_id: decision === 'authorize_retry' ? retryOperationId! : null,
        updated_at: now()
      });
      port.appendEvent(record.work_id, 'operation_resolved', { operation_id: operationId, decision, by_command: byCommand });
      return decision === 'authorize_retry' ? { ok: true, retryOperationId } : { ok: true };
    },

    setExpectations(operationId, expectations) {
      port.updateOperation(operationId, {
        expect_before: expectations.before,
        expect_after: expectations.after,
        updated_at: now()
      });
    },

    get(operationId) {
      return port.getOperation(operationId);
    },

    openOperations(workId) {
      return port.listOpenOperations(workId).filter((row) => row.state === 'prepared' || row.state === 'running');
    },

    inFlightCount() {
      return inFlight.size;
    },

    /**
     * Registers the handler promise for a freshly admitted operation. The runtime gate calls
     * this immediately after `admit` returns `admitted`, so a retry arriving while the first
     * call is still executing joins that promise instead of starting a second execution.
     */
    track(operationId, work) {
      track(operationId, work);
    }
  };
}

// --------------------------------------------------------------------------- file hashes

/**
 * Blob hash of one path: SHA-256 of the bytes, or of the link text for a symlink (never
 * followed), or `null` when the path does not exist. Matches how the worktree manager
 * captures tree entries, so a patch's recorded hashes can be compared to a Git tree.
 */
export async function hashPathBlob(absolutePath: string): Promise<string | null> {
  try {
    const stat = await fs.lstat(absolutePath);
    if (stat.isSymbolicLink()) {
      const target = await fs.readlink(absolutePath);
      return createHash('sha256').update(target, 'utf8').digest('hex');
    }
    if (stat.isDirectory()) return null;
    const data = await fs.readFile(absolutePath);
    return createHash('sha256').update(data).digest('hex');
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null;
    throw error;
  }
}

/**
 * Blob hash of text a patch is about to write.
 *
 * Identical construction to {@link hashPathBlob}'s byte hash, so an expected post-write hash
 * can be compared directly to what is later read off disk.
 */
export function hashTextBlob(text: string): string {
  return createHash('sha256').update(Buffer.from(text, 'utf8')).digest('hex');
}

/**
 * Pre-write hashes for every path a verified patch will touch.
 *
 * Called after the patch has been parsed and verified against the real files and before
 * `executeApplyPatch` writes anything. Paths are resolved exactly as the patch spelled them,
 * so the same key can be re-hashed after the write and compared.
 */
export async function capturePatchBeforeHashes(
  changes: Iterable<string>,
  cwd: string
): Promise<Record<string, string | null>> {
  const out: Record<string, string | null> = {};
  for (const spelled of changes) {
    const absolute = path.resolve(cwd, spelled);
    out[spelled] = await hashPathBlob(absolute);
  }
  return out;
}

export type PatchHashSummary = 'all_before' | 'all_after' | 'mixed' | 'unchanged';

export interface PatchAfterHashes {
  after: Record<string, string | null>;
  summary: PatchHashSummary;
}

/**
 * Post-write hashes and the recovery verdict.
 *
 * - `all_before`: nothing landed (a crash before any write, or a rejected patch).
 * - `all_after`: every path changed as intended.
 * - `mixed`: some paths landed and some did not; the operation is not atomic and needs an
 *   explicit decision rather than a blind replay.
 * - `unchanged`: hashes match the before-state and match each other, i.e. a no-op write.
 */
export async function capturePatchAfterHashes(
  before: Readonly<Record<string, string | null>>,
  cwd: string
): Promise<PatchAfterHashes> {
  const after: Record<string, string | null> = {};
  for (const spelled of Object.keys(before)) {
    after[spelled] = await hashPathBlob(path.resolve(cwd, spelled));
  }
  const keys = Object.keys(before);
  if (keys.length === 0) return { after, summary: 'unchanged' };
  let changed = 0;
  for (const key of keys) if (before[key] !== after[key]) changed += 1;
  const summary: PatchHashSummary = changed === 0 ? 'all_before' : changed === keys.length ? 'all_after' : 'mixed';
  return { after, summary };
}

/** In-memory port for tests and for a host that has not opened its database yet. */
export function createMemoryOperationPort(seed: OperationAdmissionContext[] = []): OperationLedgerPort {
  const operations = new Map<string, WorkOperationRecord>();
  const contexts = new Map(seed.map((entry) => [entry.agent_id, entry]));
  let sequence = 0;
  const port: OperationLedgerPort = {
    getOperation: (id) => operations.get(id) ?? null,
    insertOperation: (record) => {
      if (operations.has(record.operation_id)) {
        const error = new Error('DUPLICATE_OPERATION_ID') as NodeJS.ErrnoException;
        error.code = 'DUPLICATE_OPERATION_ID';
        throw error;
      }
      operations.set(record.operation_id, { ...record });
    },
    updateOperation: (id, patch) => {
      const current = operations.get(id);
      if (current) operations.set(id, { ...current, ...patch });
    },
    listOpenOperations: (workId) => [...operations.values()]
      .filter((row) => (workId === undefined || row.work_id === workId) && (row.state === 'prepared' || row.state === 'running')),
    admissionContext: (agentId) => contexts.get(agentId) ?? null,
    appendEvent: () => (sequence += 1)
  };
  // A test may register an agent/work context after construction; the port is the only place
  // that knows the projection, so it carries its own seeding seam.
  Object.defineProperty(port, '__seed', {
    value: (context: OperationAdmissionContext) => { contexts.set(context.agent_id, context); },
    enumerable: false
  });
  return port;
}

/** Registers a fake agent/work context. Tests and the in-memory host only. */
export function seedOperationContext(port: OperationLedgerPort, context: OperationAdmissionContext): void {
  const internal = port as OperationLedgerPort & { __seed?: (c: OperationAdmissionContext) => void };
  internal.__seed?.(context);
}
