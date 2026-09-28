import { offerToolInput, acknowledgeToolInput, TOOL_INPUT_HEADER } from '../session/input.js';
import { pluginManager } from '../plugins/manager.js';
/**
 * The machinery every model-facing tool sits on, independent of which surface it lives on.
 *
 * The tools themselves are split by connector — `tools-core.ts` and `tools-desktop.ts` —
 * because a connector is a discovery boundary and that split is the whole point of the
 * design (see `docs/tool-surface.md` §6.4). None of what is in this file is surface-shaped:
 * error mapping, the call clock, the recording context, the agent key and the result
 * formatters behave identically wherever a tool is registered, and duplicating them per
 * surface is how two connectors would quietly start reporting the same thing differently.
 *
 * A tool first appears when its capability is enabled. For the lifetime of a running MCP
 * endpoint the exposed surface is monotonic: if that permission is later revoked, the tool
 * stays registered so a cached ChatGPT tool snapshot does not break, while the live handler
 * returns TOOL_DISABLED. Read-only mode is applied upstream in effectiveCapabilities, so a
 * fresh endpoint starts with every write tool absent.
 *
 * Annotations matter for real behaviour, not just documentation: ChatGPT treats a tool
 * without readOnlyHint as a write action and asks the user to confirm each call, so every
 * genuinely read-only tool is marked as such.
 */

import { rawPromises as fs } from '../rawfs.js';
import os from 'node:os';
import { beginToolTiming, inboundRequestId, inboundPublication } from './inbound.js';
import { McpServer, type ServerContext } from '@modelcontextprotocol/server';
import { z } from 'zod';
import type { Capabilities, Root } from '../../shared/types.js';
import { CAPABILITY_LABELS, WRITE_CAPABILITIES } from '../../shared/types.js';
import { FsOpError, formatBytes, type FileInfo } from '../fsops.js';
import { SearchPatternError } from '../search.js';
import { SearchPageError } from '../search-pages.js';
import { logInfo, logWarn } from '../logger.js';
import { toolSchema, toolSchemaJson } from './tool-declarations.js';
import type { PluginToolSchema } from '../../shared/plugin-refresh.js';
import {
  SandboxError,
  resolvePath,
  type Resolved
} from '../sandbox.js';
import { firstTaskRoot } from '../skill-access.js';
import { ExecError } from '../exec.js';
import { getConfig } from '../config.js';
import {
  AgentError,
  IdentityLostError,
  currentRunId,
  acknowledgeOffersForCaller,
  currentRunForCaller,
  agentFamiliesForCaller,
  reconcileAgentRequestOwners,
  dormantWorkerNotice,
  reactivateDormantRunForConversation,
  endedWorkerNotice,
  sleepSilentWorkers,
  noteAgentAlive,
  agentForCaller,
  agentForOwnedConversation,
  agentForFinishCaller,
  offerMessagesForCaller,
  persistCriticalSwarmNow,
  requestWorkerRevivals,
  releaseQuiescentRun,
  retiredWorkerForConversation,
  stageQueuedWorkerRevivals
} from '../agents.js';
import type { SurfaceId } from './surfaces.js';
import {
  currentCall,
  emptyEvidence,
  noteOutcome,
  holdWhileSettling,
  runInCallContext,
  runningToolProgress,
  trackInFlight,
  trackMcpRequest,
  type CallContext,
  type CallCaller
} from './call-context.js';
import {
  REQUEST_ID_GRACE_MS,
  awaitFreshCallOrigin,
  evidenceWindow,
  freshCallOrigin,
  recordAgentMessage,
  recordToolCall
} from '../session/recorder.js';
import { requestCorrelation } from '../session/correlation.js';
import { BLOCKED_CHAT_REFUSAL, anyChatBlocked, isChatBlocked } from '../session/blocked-chats.js';
import { anyContinuationOpen, compactingConversation } from '../session/continuation.js';
import { DEFAULT_MAX_OUTPUT_TOKENS } from '../codex/unified-exec-constants.js';
import { conversationAttachment } from '../session/store.js';
import { sessionFinishDeadline } from '../session/finish.js';
import type { ToolOutcome } from '../../shared/session.js';
import type { WorkService } from '../work/service.js';

export interface ToolContext {
  /** Production supplies the restored durable authority before MCP starts listening. */
  workService?: WorkService;
  exposedFinishTool?: boolean;
  roots: Root[];
  /** Capabilities currently allowed by the live settings. */
  caps: Capabilities;
  /**
   * Capabilities whose tools must remain registered for the lifetime of the local MCP
   * endpoint. This prevents an already-cached ChatGPT tool snapshot from turning into
   * UNKNOWN when the user disables a permission mid-session. Calls are still checked
   * against `caps` and return TOOL_DISABLED instead of executing.
   */
  exposedCaps?: Capabilities;
  readOnly: boolean;
  /** When on, an unspecified screenshot captures only the foreground window. */
  privacyScreenshots?: boolean;
  /** Whether session recording is live right now. Defaults to the live setting. */
  sessionTools?: boolean;
  /** Whether multi-agent mode is live right now. Defaults to the live setting. */
  agentTools?: boolean;
  /**
   * Whether these feature tools must stay registered for the lifetime of the endpoint,
   * for the same reason as `exposedCaps`: ChatGPT caches a tools/list snapshot, and a
   * tool that disappears from under a cached snapshot surfaces as a transport-level
   * failure rather than a tidy error. Default to the live values.
   */
  exposedSessionTools?: boolean;
  exposedAgentTools?: boolean;
  /**
   * Whether `find` must stay registered for the lifetime of the endpoint.
   *
   * Search remains available alongside command execution. Once exposed, keep the schema
   * registered so disabling search produces a typed refusal rather than an unknown tool.
   */
  exposedFind?: boolean;
}

export type ToolContent =
  | { type: 'text'; text: string }
  | { type: 'image'; data: string; mimeType: string }
  | { type: 'audio'; data: string; mimeType: string };

export type ToolResult = { content: ToolContent[]; structuredContent?: Record<string, unknown>; isError?: boolean };

export interface ManagedToolInvocation {
  context: CallContext;
  name: string;
  args: unknown;
  surface: SurfaceId;
  external?: { installationId: string; toolName: string; schemaHash: string; generation: number };
}

export type ManagedToolGate = (
  input: ManagedToolInvocation,
  invoke: () => Promise<ToolResult>
) => Promise<ToolResult>;

let managedToolGate: ManagedToolGate | null = null;

/**
 * Installs the durable-work admission gate for the lifetime of an endpoint generation.
 *
 * One seam, not two: the gate itself decides whether a call names a work at all, so there is no
 * separate pre-dispatch validator that could refuse a caller the gate would have admitted.
 */
export function setManagedToolGate(gate: ManagedToolGate | null): void {
  managedToolGate = gate;
}

export const ok = (text: string): ToolResult => ({ content: [{ type: 'text', text }] });
export const fail = (text: string): ToolResult => ({ content: [{ type: 'text', text }], isError: true });

// Typed local refusals only: arbitrary tool/plugin text cannot arm a recovery notice.
const identityRefusals = new WeakSet<ToolResult>();
export function failIdentity(text: string): ToolResult {
  const result = fail(text);
  identityRefusals.add(result);
  return result;
}

// Advisory, process-local history; never ownership or permission. Exact correlation
// remains the only join, including when late proof belongs to an earlier request.
const identityRecovery = new Map<string, { tools: Set<string>; offer?: CallContext['publication'] }>();
const MAX_IDENTITY_RECOVERY = 2_000;

function rememberIdentityRefusal(requestId: string | null, tool: string): void {
  if (!requestId) return;
  const previous = identityRecovery.get(requestId);
  const pending = previous && !previous.offer ? previous : { tools: new Set<string>() };
  if (pending.tools.size < 8) pending.tools.add(tool.slice(0, 100));
  identityRecovery.delete(requestId);
  identityRecovery.set(requestId, pending);
  if (identityRecovery.size > MAX_IDENTITY_RECOVERY) identityRecovery.delete(identityRecovery.keys().next().value!);
}

async function withIdentityRecoveredNotice(context: CallContext, result: ToolResult): Promise<ToolResult> {
  const { caller, publication } = context;
  if (!identityRecovery.size || !publication || !caller.conversationId || !caller.sessionId) return result;
  const exact = requestCorrelation(caller.requestId);
  if (exact?.conversationId !== caller.conversationId || exact.sessionId !== caller.sessionId) return result;
  if (await conversationAttachment(caller.conversationId, caller.sessionId) !== 'current') return result;
  // Recheck live restrictions after the await, including identity learned during a handler.
  if (isChatBlocked(caller.conversationId) || compactingConversation(caller.conversationId) ||
      retiredWorkerForConversation(caller.conversationId) || dormantWorkerNotice(caller.conversationId) ||
      endedWorkerNotice(caller.conversationId)) return result;
  const pending: Array<{ tools: Set<string>; offer?: CallContext['publication'] }> = [];
  for (const [requestId, entry] of identityRecovery) {
    if (entry.offer && !entry.offer.failed) {
      if (entry.offer.completedAt !== null) identityRecovery.delete(requestId);
      continue;
    }
    const owner = requestCorrelation(requestId);
    if (owner?.conversationId === caller.conversationId && owner.sessionId === caller.sessionId) pending.push(entry);
  }
  if (!pending.length) return result;
  const tools = [...new Set(pending.flatMap(entry => [...entry.tools]))].slice(0, 8).join(', ');
  const text = '\n--- Identity recovered ---\n' +
    `Your request is now matched to this ChatGPT conversation. Earlier ${tools} calls were refused because chat identity was missing. ` +
    'You can now retry any still-needed operation that was not performed because of that refusal. ' +
    'Do not repeat completed operations. Other permissions and lifecycle restrictions still apply.';
  const used = result.content.reduce((bytes, part) => bytes + (part.type === 'text' ? Buffer.byteLength(part.text, 'utf8') : 0), 0);
  if (used + Buffer.byteLength(text, 'utf8') > DEFAULT_MAX_OUTPUT_TOKENS * 4) return result;
  // Reserve synchronously across parallel outer results. A failed local publication
  // can re-offer; successful publication suppresses repetition, not proof of comprehension.
  for (const entry of pending) entry.offer = publication;
  return { ...result, content: [...result.content, { type: 'text', text }] };
}

/** Maps runtime errors to short model-facing text without ever exposing real paths. */
export function friendlyError(err: unknown): string {
  if (err instanceof SandboxError || err instanceof SearchPageError) return err.message;
  const code = (err as NodeJS.ErrnoException).code;
  if (code === 'ENOENT') return 'Not found';
  if (code === 'EACCES' || code === 'EPERM') return 'Access denied by the operating system';
  if (code === 'EBUSY') return 'The file is in use by another program';
  if (code === 'ENOTEMPTY') return 'Directory is not empty';
  if (code === 'EEXIST') return 'Already exists';
  // Node filesystem errors routinely embed the absolute host path in `err.message`.
  // Unknown errno values (ELOOP, ENAMETOOLONG, EINVAL, ENOSPC, …) used to fall through
  // verbatim and violate the model-facing virtual-path contract. Keep the errno useful
  // without echoing the path Windows supplied.
  if (typeof code === 'string' && code.length > 0) return `Filesystem error (${code})`;
  return err instanceof Error ? err.message : String(err);
}

/**
 * Epoch ms of the last tool ChatGPT actually ran, or null if it never has.
 *
 * Deliberately separate from "a request arrived". ChatGPT connects, initialises and
 * lists tools on every connect even when the model is then forbidden to use them —
 * which is precisely what an account with Developer mode switched off looks like from
 * here. Only a tool that ran proves the whole chain, model included, works.
 *
 * Kept per surface as well as overall. "Has ChatGPT ever run a tool here" is the only
 * honest proof a connector was created and works, and with two connectors the answer for
 * one says nothing about the other — a user whose Core connector is fine and whose
 * Desktop connector was never added would otherwise see setup reported as finished.
 */
let toolCallSeenAt: number | null = null;
const surfaceToolCallAt = new Map<SurfaceId, number>();

/** Direct authenticated work controls share the same clocks as worker tools. */
export function noteSurfaceToolCall(surface: SurfaceId): void {
  const observedAt = Date.now();
  toolCallSeenAt = observedAt;
  surfaceToolCallAt.set(surface, observedAt);
}

export function lastToolCallAt(surface?: SurfaceId): number | null {
  if (surface === undefined) return toolCallSeenAt;
  return surfaceToolCallAt.get(surface) ?? null;
}

/** Cleared with the server, so the answer is always about the current session. */
export function resetToolClock(): void {
  identityRecovery.clear();
  toolCallSeenAt = null;
  surfaceToolCallAt.clear();
  transportIdentity = { checked: false, present: false };
}

/**
 * Turns any thrown error into a tool execution error the model can act on, and keeps
 * unexpected internals out of the response. Error results are logged with only their
 * first line, so Activity stays useful without copying command output or file contents.
 */
export async function guard(name: string, fn: () => Promise<ToolResult>): Promise<ToolResult> {
  const started = Date.now();
  // Counted before the work, and counted even when the tool is disabled or fails:
  // the question this answers is whether the model may call us at all.
  toolCallSeenAt = started;
  try {
    const result = await fn();
    const elapsed = Date.now() - started;
    if (result.isError) {
      const summary = result.content
        .find((item): item is Extract<ToolContent, { type: 'text' }> => item.type === 'text')
        ?.text.split(/\r?\n/, 1)[0]
        ?.slice(0, 500);
      // A rejected edit, disabled permission, stale cursor, etc. is a normal tool
      // outcome, not evidence that the connector itself is unhealthy.
      noteOutcomeSafely('tool_rejected');
      logInfo(`tool ${name} rejected in ${elapsed} ms${summary ? `: ${summary}` : ''}`);
    } else {
      noteOutcomeSafely('ok');
      logInfo(`tool ${name} ok in ${elapsed} ms`);
    }
    return result;
  } catch (err) {
    const message = friendlyError(err);
    const elapsed = Date.now() - started;
    if (
      err instanceof SandboxError ||
      err instanceof FsOpError ||
      err instanceof SearchPatternError ||
      (err instanceof SearchPageError &&
        (err.code === 'SEARCH_CURSOR_INVALID' || err.code === 'SEARCH_CURSOR_EXPIRED')) ||
      err instanceof ExecError ||
      err instanceof AgentError
    ) {
      noteOutcomeSafely('tool_rejected');
      logInfo(`tool ${name} rejected in ${elapsed} ms: ${message}`);
    } else {
      noteOutcomeSafely('tool_internal_error');
      logWarn(`tool ${name} failed in ${elapsed} ms: ${message}`);
    }
    return err instanceof IdentityLostError ? failIdentity(message) : fail(message);
  }
}

// noteOutcome is only meaningful inside a call context; guard is also used by tests and
// by internal paths that have none, and a missing context must not turn into an error.
function noteOutcomeSafely(outcome: ToolOutcome): void {
  try {
    noteOutcome(outcome);
  } catch {
    /* no call context: nothing to record against */
  }
}

/**
 * The conversation this call was made from, if this call itself proved it.
 *
 * The only identity any agent has, and the reason no tool here carries a key. It reads one
 * thing: ChatGPT's own message model naming *this* tool request, in exactly one conversation,
 * at or after the moment this call started. Not `provenConversation()` — that reports whichever
 * chat has drawn connector rows lately and keeps answering for a minute after that chat went
 * quiet, which on a machine with one busy chat says the same thing whoever is calling. Not the
 * active chat, not the last chat, not a guess.
 *
 * Deliberately non-blocking, and deliberately after the handler has run. Non-blocking because
 * this is on the path of every ordinary read and exec, and waiting on the browser to answer a
 * question about attribution would make the browser a dependency of reading a file. After the
 * handler because the page reports on its own tick: a call that took a second has had a second
 * for its evidence to arrive, which is exactly the calls whose attribution matters most.
 *
 * A call that cannot be placed simply has no agent. It is not refused — most calls in most
 * installs are an ordinary chat with no swarm anywhere near it, and a phone talking to the same
 * connector is not a worker impersonation attempt. What it does not get is somebody else's
 * inbox, and control of the run: `agents` establishes identity for itself, and refuses without
 * it by name.
 */
function callerConversation(tool: string, startedAt: number, requestId: string | null): string | null {
  return freshCallOrigin(tool, startedAt, requestId);
}

/** Publishes both halves of one exact request proof into the call context. */
function setCallerConversation(context: CallContext, conversationId: string | null): void {
  context.caller.conversationId = conversationId;
  const exact = conversationId ? requestCorrelation(context.caller.requestId) : null;
  context.caller.sessionId = exact?.conversationId === conversationId ? exact.sessionId : null;
}

/** Request identity still comes from ingress ALS; the SDK context is retained only for genuine
 * request-scoped progress notifications and transport session metadata. */
type McpCallContext = Pick<ServerContext, 'sessionId' | 'mcpReq'>;

function progressNotifier(mcpCtx: McpCallContext | undefined): CallContext['notify'] {
  const mcpReq = mcpCtx?.mcpReq;
  if (!mcpReq) return undefined;
  const progressToken = mcpReq._meta?.progressToken;
  if (progressToken === undefined) return undefined;
  return async content => {
    if (content.type !== 'text') {
      throw new Error('MCP progress notifications can carry text only; binary output will be returned by the next exec or wait result.');
    }
    await mcpReq.notify({
      method: 'notifications/progress',
      params: { progressToken, progress: 0, message: content.text }
    });
  };
}

/**
 * ChatGPT's id for this request, from `x-request-id`, without the per-attempt suffix.
 *
 * The header arrives as `wfr_<id>/<suffix>` and ChatGPT's own message model holds the
 * `wfr_<id>` half, so the suffix is dropped rather than matched on. Measured live on
 * 2026-08-18: header `wfr_00000000000000000000000000000001/yqy1`, page evidence
 * `read#wfr_00000000000000000000000000000001`.
 *
 * This is what makes caller identity a lookup instead of an inference. Before it, two
 * workers of the same run calling `agents` seconds apart were indistinguishable — both
 * conversations had named an unclaimed `agents` request inside the same window — and both
 * were refused WORKER_IDENTITY_LOST. Nothing about timing needs to be assumed now.
 */
function requestIdOf(mcpCtx: McpCallContext | undefined): string | null {
  // server.ts normalizes x-request-id exactly once at raw HTTP ingress and binds that value
  // to this async request. Re-reading the SDK header here would create a second parser/source
  // of truth for the correlation key.
  void mcpCtx;
  return inboundRequestId();
}

/**
 * Whether the MCP transport ever gave us a session id, once a real call has arrived.
 *
 * Recorded rather than assumed, because it is the one thing that would let this app know
 * which conversation is calling without asking the browser at all. Until it does, identity
 * comes from page evidence. This is what the Activity log reports on the first tool call of
 * each run.
 */
let transportIdentity: { checked: boolean; present: boolean } = { checked: false, present: false };

export function transportIdentityStatus(): { checked: boolean; present: boolean } {
  return { ...transportIdentity };
}

function noteTransportIdentity(transportKey: string | null): void {
  if (transportIdentity.checked) return;
  transportIdentity = { checked: true, present: transportKey !== null };
  logInfo(
    transportKey
      ? 'MCP transport supplied a session id — agent identity could be bound to the transport'
      : 'MCP transport supplied no session id (stateless connector) — agent identity comes from page evidence'
  );
}

/**
 * Appends the messages waiting for this agent to the tool result.
 *
 * This is the push-like delivery: an agent gets whatever has been said to it since its last
 * call, at the end of every result, with no polling loop. It works for a call this app could
 * place in a conversation, which is most of them and never all of them — so nothing is
 * retired here, and a message the page could not confirm is simply offered again next time.
 *
 * Messages are *offered* here, not retired. They are retired when this agent calls
 * again, because that is the first real evidence this result reached ChatGPT.
 */
function withInbox(
  caller: CallCaller,
  agent: string | null,
  result: ToolResult,
  onFinish = false
): ToolResult {
  // Conversation ownership is the durable authority. This matters most for a parked prime:
  // there is deliberately no live `agent:prime` while another history may be active, but its
  // exact conversation still owns final worker reports queued before parking. The finish flag
  // also preserves the one dormant-worker exception: retrying a lost finish result may re-offer
  // rows that rode on that finish, without re-authorising ordinary worker activity.
  const scoped = offerMessagesForCaller(caller, onFinish, onFinish);
  const recipient = scoped?.agentId ?? agent;
  const messages = scoped?.messages ?? [];
  if (messages.length === 0) return result;
  const lines = messages
    .map(
      (message) =>
        `• ${message.from}${message.runId ? ` [run_id=${message.runId}]` : ''}${message.offers > 1 ? ' (delivery retry)' : ''}: ${message.text}`
    )
    .join('\n');
  return {
    ...result,
    content: [
      ...result.content,
      { type: 'text', text: `\n--- ${messages.length} message(s) for ${recipient ?? 'this conversation'} ---\n${lines}` }
    ]
  };
}

/**
 * Runs one tool call inside a recording context.
 *
 * Registration is wrapped rather than each handler, so the arguments and the result
 * recorded are exactly the ones that crossed the wire — the recorder never has to
 * reconstruct a call from a log line — and so identity is resolved in one place.
 *
 * `finishing` replaces the old `name === 'finish_agent'` test: with the collapsed
 * `agents` tool the terminal call is an *action* rather than a tool name, and the
 * re-offer rule has to follow the action.
 */
export async function dispatch(
  name: string,
  args: unknown,
  transportKey: string | null,
  requestId: string | null,
  surface: SurfaceId,
  run: () => Promise<ToolResult>,
  parent?: CallContext,
  external?: ManagedToolInvocation['external'],
  mcpCtx?: McpCallContext
): Promise<ToolResult> {
  // The context is built here, one layer out from where the work happens, because the
  // compaction barrier asks about the whole request and not just the handler. A call is
  // still unsettled while it waits for its request-id evidence, while its outcome is being
  // recorded, and while its result is on the way back — and a handoff written in any of
  // those gaps describes a machine that has not finished changing. The counter therefore
  // opens with the request and closes with it.
  const context: CallContext = {
    notify: parent?.notify ?? progressNotifier(mcpCtx),
    publication: parent?.publication ?? inboundPublication() ?? { completedAt: null, failed: false },
    startedAt: Date.now(),
    transportKey,
    agent: null,
    allowUnattributed: getConfig().multiAgent.allowUnattributedCalls,
    caller: parent ? { ...parent.caller } : { transportKey, requestId, conversationId: null, sessionId: null },
    outcome: null,
    evidence: emptyEvidence()
  };
  try {
    const result = await trackMcpRequest(() =>
      trackInFlight(context, () => dispatchTracked(context, name, args, transportKey, requestId, surface, run, !!parent, external))
    );
    // In-process callers have no socket; resolving their outer invocation publishes it.
    if (!parent && !inboundPublication()) context.publication!.completedAt = Date.now();
    return result;
  } catch (error) {
    if (!parent) context.publication!.failed = true;
    throw error;
  }
}

/**
 * Refused to a chat whose session is being compacted into a fresh chat.
 *
 * The brief is the whole point of that window and the one thing the model is asked for, so
 * the refusal is written to steer a turn that is still busy with its old task straight into
 * writing it — and to make a chat with an unstoppable turn harmless, since nothing it calls
 * now can change the machine the brief describes.
 */
export const COMPACTION_IN_PROGRESS_REFUSAL =
  'COMPACTION_IN_PROGRESS: this chat is being compacted into a fresh chat, and no local tool was run. ' +
  'Nothing will run here until the handoff is done. Make no further tool calls of any kind. The latest ' +
  'user message asks for the handoff brief: write that brief now, as plain text, and then stop. ' +
  'Work continues in the replacement chat.';

async function dispatchTracked(
  context: CallContext,
  name: string,
  args: unknown,
  transportKey: string | null,
  requestId: string | null,
  surface: SurfaceId,
  run: () => Promise<ToolResult>,
  nested: boolean,
  external?: ManagedToolInvocation['external']
): Promise<ToolResult> {
  noteTransportIdentity(transportKey);
  const markTiming = beginToolTiming();
  // Recorded here rather than in `guard` because only this layer knows which server
  // answered, and "was this connector ever actually used from ChatGPT" is a per-connector
  // question the setup screen has to answer honestly.
  noteSurfaceToolCall(surface);
  const isFinish = surface === 'core' && isFinishCall(name, args);
  const startedAt = context.startedAt;
  // Cheap, non-blocking ingress identity. When the page has already reported this exact
  // request id, identity-sensitive handlers (workspace/session/agents) see it before they
  // touch state. If the page is one tick late this stays null; only handlers that actually
  // require identity wait for their own exact mate. Ordinary absolute reads/execs never wait.
  if (!nested) setCallerConversation(context, callerConversation(name, startedAt, requestId));
  await reconcileAgentRequestOwners().catch(error => {
    logWarn(`Worker ownership recovery deferred: ${error instanceof Error ? error.message : String(error)}`);
  });
  if (!context.caller.conversationId) setCallerConversation(context, callerConversation(name, startedAt, requestId));
  // update_plan and session_finish consume this exact session, even outside a swarm. Resolve it
  // before the shared blocked/superseded checks rather than guessing from selection.
  // Only session_finish needs to wait for exact chat evidence at ingress. Native
  // Desktop calls check the exact current session in their backend; browser-only exec
  // must not wait for native identity or inherit a foreground policy.
  const finishDeadline = name === 'session_finish' ? sessionFinishDeadline(startedAt) : null;
  const identityWindow = (requested: number): number => finishDeadline === null
    ? requested : Math.min(requested, Math.max(0, finishDeadline - Date.now()));
  if (!context.caller.conversationId && name === 'session_finish' && requestId) {
    setCallerConversation(
      context,
      await awaitFreshCallOrigin(name, startedAt, identityWindow(SPAWN_EVIDENCE_MS), { requestId })
    );
  }
  // And the user's own block, which needs identity resolved to the same depth as everything
  // above and used to be the one rule here that read it without ever waiting.
  //
  // Attribution waits: an unproven call is held for REQUEST_ID_GRACE_MS and then filed under
  // whichever conversation the page proves inside that window. Enforcement did not, so a call
  // that arrived before its page evidence — the first calls of a turn, and every call of a turn
  // whose wedged page reports late — passed the block check as "no proven owner", ran the tool,
  // and *then* appeared in the blocked chat's own timeline. That is exactly the failure the user
  // sees: a chat marked blocked going on using tools, correctly attributed to it while it does.
  // Enforcement losing a race that attribution wins is not a policy about unknown callers, it is
  // a bug in how long enforcement is willing to look.
  //
  // So look as long as the recorder does, and only when there is a block to enforce: with no
  // blocked chat this is a `Map.size` check on the way past, and a request id that is already
  // proven — every later call of a turn — resolves from the registry without waiting at all.
  // Unproven still means unblocked, as everywhere else here; what changes is that "unproven"
  // now means the page never proved it, not that the page had not proved it yet.
  //
  // A chat being compacted is refused on the same terms, so it waits on the same terms.
  if (!context.caller.conversationId && (anyChatBlocked() || anyContinuationOpen()) && requestId) {
    setCallerConversation(
      context,
      await awaitFreshCallOrigin(name, startedAt, identityWindow(REQUEST_ID_GRACE_MS), { requestId })
    );
  }
  const supersededConversation = context.caller.conversationId
    ? (await conversationAttachment(context.caller.conversationId, context.caller.sessionId ?? null)) === 'superseded'
    : false;
  // Two things about liveness, both before the agent is resolved so that the answer this
  // call gets is the state this call itself established.
  //
  // Use the same three-minute work clock as bridge maintenance for attached and
  // detached workers. Record this call's proven liveness first; unrelated and
  // unidentified calls cannot renew a worker's deadline or protect its slot.
  // A superseded frontend is durable historical identity, not liveness. Letting its refused
  // call pass through the broker bookkeeping used to revive the very worker/chat the store had
  // just retired, which kept the session card on "active" after A -> B.
  //
  // Before any of that: a proven call from a worker whose family was parked when it was
  // thought asleep takes the free execution slot back for that family, so the liveness
  // bookkeeping below sees the same run it would have seen had the parking not happened. A
  // chat the user stopped from the app is refused below anyway and reclaims nothing.
  if (!supersededConversation && !isFinish && !isChatBlocked(context.caller.conversationId)) {
    reactivateDormantRunForConversation(context.caller.conversationId);
  }
  const alive = supersededConversation || isChatBlocked(context.caller.conversationId) ? null : noteAgentAlive(context.caller.conversationId);
  const quietWorkers = supersededConversation ? [] : sleepSilentWorkers(Date.now(), undefined, id => runningToolProgress(id) !== null);
  for (const quiet of quietWorkers) {
    if (quiet.report) await recordAgentMessage(quiet.report, 'sent', quiet.info.conversationId);
  }
  // And this call is itself first-hand evidence that its own conversation is alive. That is
  // what undoes a worker given up on because its tab went away — the turn never stopped, so
  // the call arrives from a chat the app had written off, and the write-off was wrong.
  if (alive?.report) await recordAgentMessage(alive.report, 'sent', context.caller.conversationId);
  // A prime message accepted while a worker's tab was closed could not safely be injected while
  // that server-side turn might still be running. If the silence check above has now proved the
  // worker stopped, carry that already-durable unread work into a revival instead of leaving it
  // stranded until the prime happens to send a second message. Do this after noteAgentAlive so a
  // tool call from the supposedly quiet worker wins and simply keeps the worker active.
  const quietByRun = new Map<string, string[]>();
  for (const entry of quietWorkers) {
    const runId = entry.info.runId ?? (entry.info.conversationId ? currentRunId(entry.info.conversationId) : null);
    if (!runId) continue;
    quietByRun.set(runId, [...(quietByRun.get(runId) ?? []), entry.info.id]);
  }
  for (const [runId, ids] of quietByRun) {
    const deferredWake = stageQueuedWorkerRevivals(ids, runId);
    if (deferredWake.waking.length > 0) {
      try {
        if (await persistCriticalSwarmNow()) {
          deferredWake.commit();
          requestWorkerRevivals(deferredWake.waking, runId);
        } else {
          deferredWake.rollback();
          logWarn('multi-agent: could not durably reserve queued work for a worker that just fell asleep');
        }
      } catch (err) {
        deferredWake.rollback();
        logWarn(
          `multi-agent: could not durably reserve queued work for a worker that just fell asleep — ${err instanceof Error ? err.message : String(err)}`
        );
      }
    }
  }
  context.agent = isFinish ? agentForFinishCaller(context.caller) : agentForCaller(context.caller);
  const retiredWorker = retiredWorkerForConversation(context.caller.conversationId);
  // Parking a run releases its global execution claim without retiring its worker chats. Those
  // exact conversations remain workers, though: a stale sleeping/terminal worker tab must not
  // turn into an ordinary unidentified chat and keep running local tools merely because another
  // prime currently owns the active run (or because no run is active at all). Only the owning
  // prime's explicit agents message may wake a sleeping worker.
  const dormantWorker = isFinish ? null : dormantWorkerNotice(context.caller.conversationId);
  // A worker that really is over learns so on its own next call. Without this its calls
  // resolved to nobody and ran anyway, so a chat the user had ended went on writing files
  // in the name of no agent at all.
  // A terminal worker may do exactly one thing: retry its own idempotent finish after a lost
  // result. It still has a tombstone identity for that call so the dispatcher can re-offer the
  // inbox that rode on the missing result. Every other tool call from the same chat is refused
  // by endedWorkerNotice as before.
  const endedWorker = isFinish ? null : endedWorkerNotice(context.caller.conversationId);
  // The user's own verdict on this chat, and the only one that outranks every other. It is not
  // a lifecycle state the broker derived: somebody looked at a rogue turn they could not stop
  // from the page and stopped it here instead, so it applies to every tool on every surface,
  // `agents` finish included. A blocked chat has nothing left to finish.
  const blockedChat = isChatBlocked(context.caller.conversationId);
  // A chat whose session is on its way to a fresh chat. Compact & Resume interrupts the turn
  // from the page and waits for the app's in-flight count to reach zero, but neither is a
  // fact about the model: ChatGPT's Stop control can vanish while the server-side turn goes
  // on calling tools, and a count of zero between two calls is not a turn that has ended. On
  // 2026-09-01 that is exactly what happened — the "stopped" turn kept calling tools, the
  // handoff prompt was typed into it, and the model spent eleven more minutes on its task,
  // applying patches, before it got round to the brief. So the refusal lives here, where
  // every call passes: from the moment the continuation is filed until its commit hands the
  // chat over to `superseded`, chat A gets no tool at all, and each refusal tells the model
  // the only thing it can usefully do is write the brief.
  const compacting = !blockedChat && compactingConversation(context.caller.conversationId) !== null;
  // The arrival of this exact call acknowledges earlier injected input before the
  // handler reads the queue. New queued input is still offered only with its result.
  if (!nested) await acknowledgeToolInput(context.caller.sessionId, context.caller.conversationId, requestId, startedAt)
    .catch(() => logWarn('Prior user input receipt could not be saved; its existing claim is preserved'));
  // Nothing here acknowledges or drains a completed terminal: a poll of that exact process id
  // reads its retained output, and that is the only thing that retires it.
  let handlerRan = false;
  markTiming('identity');
  const invokeHandler = (): Promise<ToolResult> => {
    handlerRan = true;
    return run();
  };
  const result = await runInCallContext(context, () =>
      blockedChat
        ? Promise.resolve(fail(BLOCKED_CHAT_REFUSAL))
        : compacting
        ? Promise.resolve(fail(COMPACTION_IN_PROGRESS_REFUSAL))
        : supersededConversation
        ? Promise.resolve(
            fail(
              'CONVERSATION_SUPERSEDED: Compact & Resume replaced this ChatGPT conversation. Its transcript remains readable, but it can no longer execute local tools. Continue only in the replacement chat; no local tool was run.'
            )
          )
        : dormantWorker
        ? Promise.resolve(fail(dormantWorker))
        : retiredWorker
        ? Promise.resolve(
            fail(
              `WORKER_RETIRED: ${retiredWorker.id} was retired because ${retiredWorker.reason}. This chat can no longer use local tools. Stop working and return to the prime chat.`
            )
          )
        : endedWorker
        ? Promise.resolve(fail(endedWorker))
        : nested && surface !== 'plugins' && (name === 'exec' || name === 'exec_read' || name === 'session_finish' || isFinish)
        ? Promise.resolve(fail('DIRECT_CALL_REQUIRED: call this lifecycle tool directly, outside exec. No action was taken.'))
        : managedToolGate
        ? managedToolGate({ context, name, args, surface, external }, invokeHandler)
        : invokeHandler()
  );
  markTiming('handler');
  if (identityRefusals.has(result)) rememberIdentityRefusal(requestId, name);
  // Identity, once, from this call's own evidence — see callerConversation. `agents` has
  // already established its own inside the call and adopted it, and re-reading here would
  // only be able to disagree with the stronger answer it waited for.
  if (!context.caller.conversationId) {
    const resolved = callerConversation(name, startedAt, requestId);
    if (resolved) setCallerConversation(context, resolved);
  }
  await reconcileAgentRequestOwners().catch(error => {
    logWarn(`Worker ownership recovery deferred after tool completion: ${error instanceof Error ? error.message : String(error)}`);
  });
  const deliveryFenced = blockedChat || compacting || supersededConversation || isChatBlocked(context.caller.conversationId) ||
    compactingConversation(context.caller.conversationId) !== null || Boolean(context.caller.conversationId &&
      (await conversationAttachment(context.caller.conversationId, context.caller.sessionId ?? null)) === 'superseded');
  // Never erase an identity a handler proved more strongly (agents::callerNow). The old
  // post-handler pass could fail to rediscover evidence that callerNow had already reserved
  // and then set agent back to null, which is the live WORKER_IDENTITY_LOST / missing-inbox
  // split brain worker-1 observed.
  const exactRole = context.caller.conversationId ? agentForOwnedConversation(context.caller.conversationId) : null;
  const recoveredWorkerRole = context.agent === 'prime' && exactRole && exactRole !== 'prime' ? exactRole : null;
  if (recoveredWorkerRole) {
    // A provisional spawn selected its newly-created fleet before the page proved that
    // this caller was already a worker. That fleet now belongs to the real prime; retain
    // the worker's own role/inbox rather than using its old provisional selection.
    context.caller.runId = undefined;
    context.agent = recoveredWorkerRole;
  }
  const provenAgent = isFinish ? agentForFinishCaller(context.caller) : agentForCaller(context.caller);
  if (!context.agent || (context.caller.conversationId && provenAgent)) context.agent = provenAgent;
  // This call is the best evidence there is that the previous result reached the agent's
  // conversation, so anything offered then can be retired and written to its history —
  // except what was offered on a finish result, which this call may itself be the model's
  // retry after a lost result. The SDK exposes the JSON-RPC id, but a model-issued retry is
  // a new MCP request with a new id, so that id cannot prove the previous finish result was
  // seen. The broker therefore re-offers rather than assuming; see acknowledgeOffers.
  const acknowledgedForConversation = deliveryFenced || nested
    ? null
    : acknowledgeOffersForCaller(
        context.caller,
        isFinish,
        startedAt,
        isFinish
      );
  const acknowledged = acknowledgedForConversation?.messages ?? [];
  for (const message of acknowledged) {
    // The exact caller conversation is stronger than the friendly recipient id and remains
    // unique after a run parks. Without this override, a parked Prime A acknowledging its report
    // while Prime B is active could file the delivery into B's `prime` session (or Unattributed).
    await recordAgentMessage(message, 'delivered', context.caller.conversationId);
  }
  // Inbox messages are part of the MCP result ChatGPT actually receives. Build the delivered
  // result before recording so the app transcript retains the delivered wire value rather than a
  // subtly earlier internal value that omits the worker report most likely to matter later.
  // The Plugins handler owns validation/redaction of external results. A dispatcher refusal
  // never visited that owner and therefore needs its own single redaction pass.
  const baseResult = surface === 'plugins' && !handlerRan ? pluginManager.redactResult(result) as ToolResult : result;
  // An unproven caller gets no identity prose here. The call ran, its result is the answer, and a
  // paragraph explaining attribution on every response is output the model pays for and the user
  // reads as noise. Attribution stays a recorder fact: `tool_call` rows and the Activity view are
  // where "this was Unattributed" belongs.
  let delivered = nested || deliveryFenced ? baseResult : withInbox(context.caller, context.agent, baseResult, isFinish);
  if (!nested && recoveredWorkerRole && !deliveryFenced) delivered = {
    ...delivered,
    content: [...delivered.content, { type: 'text', text: '\n--- Worker ownership recovered ---\n' +
      `Exact request proof identifies this caller as ${recoveredWorkerRole}. Any provisional fleet created by this request is attached to its real prime. ` +
      'Keep your worker role and continue using enabled tools for your assignment; do not repeat completed work.' }]
  };
  // Ordinary tools carry direct user input, but only the explicit finish signal
  // advances a planned stage. Successful work is not evidence that a stage is done.
  const userInput = nested || deliveryFenced ? { messages: [], reminder: '' } : await offerToolInput(context.caller.sessionId, context.caller.conversationId, context.caller.requestId, startedAt, name === 'session_finish' && !result.isError).catch(() => {
    logWarn('User input could not be attached; the completed tool result is preserved');
    return { messages: [], reminder: '' };
  });
  if (userInput.messages.length) {
    const attachments: ToolResult['content'] = [];
    for (const [index, message] of userInput.messages.entries()) {
      attachments.push({ type: 'text', text: (index === 0 ? TOOL_INPUT_HEADER : '\n\n') + message.text });
      for (const image of message.images) attachments.push({ type: 'image', mimeType: 'image/webp', data: image.dataUrl.slice(image.dataUrl.indexOf(',') + 1) });
    }
    if (userInput.reminder) attachments.push({ type: 'text', text: '\n\n' + userInput.reminder });
    delivered = { ...delivered, content: [...delivered.content, ...attachments] };
  }
  // Completed background output is no longer appended to unrelated results. A command's output
  // belongs to the call that started it or to an explicit `write_stdin` poll; pushing retained
  // terminal text onto every later response is exactly the automatic output that made a chat
  // slower and noisier to read, and `write_stdin` (plus the retained-output paging it already
  // uses) is the lookup path for it.
  if (!nested) delivered = await withIdentityRecoveredNotice(context, delivered);
  if (surface === 'plugins' && delivered.content.length > baseResult.content.length) {
    // All delivery projections above append to the immutable handler result. Only these
    // new app-authored blocks need redacting; traversing its large external payload again
    // wastes work and can make the recorded result differ from what the caller received.
    const added = pluginManager.redactResult({ content: delivered.content.slice(baseResult.content.length) });
    delivered = { ...delivered, content: [...baseResult.content, ...added.content as ToolResult['content']] };
  }
  // Some hosts consume structured results instead of content. Core owns these shapes;
  // project its final app appendices once without changing the underlying tool data.
  if (surface === 'core' && delivered.structuredContent) {
    const supplemental = delivered.content.slice(baseResult.content.length)
      .filter((part): part is Extract<ToolContent, { type: 'text' }> => part.type === 'text')
      .map(part => part.text).join('\n');
    if (supplemental) delivered = { ...delivered, structuredContent: { ...delivered.structuredContent, supplemental_context: supplemental } };
  }
  const recorderStartedAt = Date.now();
  // Event duration includes identity/handler/delivery work. Recorder and local HTTP finish
  // are measured separately because a row cannot contain the time of its own later commit.
  const durationMs = recorderStartedAt - startedAt;
  markTiming('delivery');
  // A handler may return a bounded wire preview while retaining its original explicit output for
  // the session recorder. App-authored delivery blocks are not in that original, so append them
  // once; never copy the full recording-only content into the MCP response or structured content.
  const recordingContent = context.recordingContent
    ? [...context.recordingContent, ...delivered.content.slice(baseResult.content.length)]
    : delivered.content;
  const recording = recordToolCall({
    nested,
    tool: name,
    args: surface === 'plugins' ? pluginManager.redact(args) : args,
    content: recordingContent,
    ...(surface === 'plugins' ? { protocolResult: context.recordingContent ? { ...delivered, content: recordingContent } : delivered } : {}),
    // guard() already marks unexpected defects; an unclassified isError is an expected rejection.
    outcome: context.outcome ?? (result.isError ? 'tool_rejected' : 'ok'),
    durationMs,
    startedAt,
    evidence: context.evidence,
    agent: context.agent,
    bind: context.bindOnAttribution ?? null,
    requestId: context.caller.requestId,
    conversationId: context.caller.conversationId,
    sessionId: context.caller.sessionId ?? null,
    endsActivity: isFinish && !result.isError
  });
  // Exact request-id identity needs no browser wait, so make its durable session append part
  // of completing the MCP call. The recorder catches storage failures and returns null, so a
  // broken history never breaks the tool itself. Only the degraded/unidentified path remains
  // fire-and-forget because it may still spend a grace window waiting for page evidence.
  if (context.caller.conversationId) {
    await recording;
  } else {
    void recording.then(() => logInfo(`mcp recording surface=${surface} recorder_async_ms=${Date.now() - recorderStartedAt}`));
    holdWhileSettling(context, recording);
  }
  // Retire a completed run only after this call has had every chance to acknowledge and
  // receive its inbox. Doing it inside acknowledgeOffers would let `agents status` destroy
  // the run halfway through identifying itself; here the handler and result are already done.
  const callerRunId = currentRunForCaller(context.caller);
  if (!deliveryFenced && callerRunId) releaseQuiescentRun({}, callerRunId);
  else if (!deliveryFenced && !context.caller.runId) {
    for (const family of agentFamiliesForCaller(context.caller)) if (family.running) releaseQuiescentRun({}, family.run_id);
  }
  markTiming('recorder', true);
  return delivered;
}

/**
 * Adopts an identity established *inside* a tool call.
 *
 * The dispatcher can only resolve a caller from what the call carried, which for the prime
 * is nothing at all. The `agents` tool proves who is calling from evidence rendered after
 * that call began, and this is how that answer gets back to the layers that need it: the
 * record this call will be filed under, and the inbox attached to its result. Called only
 * from the one tool that does that work, and only with an id it has just proven.
 */
export async function adoptAgent(agent: string | null): Promise<void> {
  const context = currentCall();
  if (!context || !agent) return;
  context.agent = agent;
  // Identity adoption is intentionally pure. A handler may prove identity more strongly than
  // ingress could, but it must not also retire inbox state: the dispatcher owns exactly one ACK
  // point after the handler, where it knows whether this call is a finish retry and can apply
  // the finish-specific at-least-once rule correctly.
}

function isFinishCall(name: string, args: unknown): boolean {
  if (name !== 'agents') return false;
  if (!args || typeof args !== 'object') return false;
  return (args as Record<string, unknown>)['action'] === 'finish';
}

/**
 * A path named by a tool call, resolved against the approved roots.
 *
 * Every path argument in every tool goes through here rather than calling `resolvePath`
 * directly, so shorthand means the same thing in `read` as in `exec` as in `apply_patch`.
 *
 * A relative path is taken to start at the first approved *task* root — a folder the user approved,
 * in the order the user approved it — or at an explicit base the calling tool passed (the folder a
 * patch names, for instance). It is never a directory this process remembered from an earlier
 * conversation: which project a call touches is decided by that call's own arguments and the user's
 * approved folders, so an ordinary read or command cannot be steered — or refused — by whichever
 * chat happened to run something before it.
 *
 * `resolvePath` applies the live filesystem mode, while retaining root, containment,
 * `..` and symlink checks for aliases. Native paths are separately validated and canonicalized;
 * the base supplies a prefix for a relative path before validation.
 */
export async function resolveIn(
  roots: Parameters<typeof resolvePath>[0],
  requested: string,
  options: { allowMissing?: boolean; base?: string | null } = {}
): Promise<Resolved> {
  // An explicit adapter-supplied base wins; otherwise a relative path starts at the configured
  // first task root. Either way the joining happens inside `resolvePath`, ahead of validation, so a
  // `..` in the caller's text still meets `checkSegment` instead of being normalised away first.
  // Doing that join here is how a relative path could climb out of its folder:
  // `posix.normalize('/root/a/../../elsewhere')` is a perfectly clean-looking `/elsewhere`, and
  // nothing downstream can tell it apart from a path that was always that.
  const fallback = firstTaskRoot(roots);
  const base = options.base !== undefined ? options.base : (fallback ? `/${fallback.name}` : getConfig().fileAccessMode === 'all-files' ? os.homedir() : null);
  const mode = getConfig().fileAccessMode;
  const resolution = {
    ...(options.allowMissing === undefined ? {} : { allowMissing: options.allowMissing }),
    base, fileAccessMode: mode
  };
  const resolved = await resolvePath(roots, requested, resolution);
  // A filesystem await can race a settings change; an old all-files result is not authority.
  if (mode === 'all-files' && getConfig().fileAccessMode !== 'all-files') {
    return resolvePath(getConfig().roots, requested, { ...resolution, fileAccessMode: 'approved-roots' });
  }
  return resolved;
}

export interface ResolvedCwd {
  real: string;
  virtual: string;
  /** True when the caller named no folder, so the first task root or home was used. */
  defaulted: boolean;
}

/**
 * The working directory a command tool may use under the live filesystem mode.
 *
 * The caller is told which folder this turned out to be, and whether it was a default, because
 * omitting `workdir` while working inside a nested project is a quiet way to run the wrong build.
 * The default is the first approved *task* root — a folder the user approved, in the order the
 * user approved it — and never a folder some earlier call happened to use.
 */
export async function resolveCwd(ctx: ToolContext, virtualPath: string | undefined): Promise<ResolvedCwd> {
  // Codex treats an explicitly empty workdir exactly like an omitted one.
  const provided = virtualPath !== undefined && virtualPath !== '';
  const fallback = firstTaskRoot(ctx.roots);
  const target = provided ? virtualPath : (fallback ? `/${fallback.name}` : getConfig().fileAccessMode === 'all-files' ? os.homedir() : '');
  if (!target) {
    throw new SandboxError(
      'No folder is approved, so there is nowhere to run. The user approves folders in the app, or supply an absolute path inside one.'
    );
  }
  const resolved = await resolveIn(ctx.roots, target);
  const stat = await fs.stat(resolved.real);
  if (!stat.isDirectory()) throw new SandboxError('workdir must be a folder');
  return { real: resolved.real, virtual: resolved.virtual, defaulted: !provided };
}

// ------------------------------------------------------------------ shared args

export const pathArg = z.string().min(1).max(4096);
export const lineNumberArg = z.number().int().min(1).max(100_000_000);
// ------------------------------------------------------------------ registration

export interface ToolAnnotations {
  readOnlyHint: boolean;
  destructiveHint: boolean;
  idempotentHint: boolean;
  openWorldHint: boolean;
}

/**
 * What a surface module is handed to register its tools with.
 *
 * Passing a small object rather than the raw `McpServer` is what keeps the two surface
 * modules from being able to diverge on the things that must not differ: every tool goes
 * through `dispatch`, every tool gets the agent key under the same condition, and every
 * capability refusal reads the same. A surface decides *which* tools exist, never how a
 * tool is wired up.
 */
export interface SurfaceRegistrar {
  ctx: ToolContext;
  caps: Capabilities;
  exposedCaps: Capabilities;
  sessionToolsLive: boolean;
  sessionToolsExposed: boolean;
  agentToolsLive: boolean;
  agentToolsExposed: boolean;
  /** Whether `find` is part of this endpoint's surface. See ToolContext.exposedFind. */
  findExposed: boolean;
  register<Schema extends z.ZodType>(
    name: string,
    config: {
      title?: string;
      description: string;
      inputSchema: Schema;
      outputSchema?: z.ZodType;
      annotations?: ToolAnnotations;
      /**
       * Opaque host metadata advertised verbatim in tools/list.
       * Never interpreted here.
       */
      _meta?: Record<string, unknown>;
    },
    handler: (args: z.output<Schema>) => Promise<ToolResult>
  ): void;
  /** Runs `fn` only while `cap` is live, and explains the refusal otherwise. */
  guarded(cap: keyof Capabilities, name: string, fn: () => Promise<ToolResult>): Promise<ToolResult>;
  /** Refusal used when a whole feature is off but its tool is still exposed. */
  featureDisabled(feature: string, setting: string): ToolResult;
  /** Names actually registered on this server, in registration order. */
  registered(): string[];
  /** Same registered handler/schema, with a fresh child recording context and inherited proof. */
  invokeNested(name: string, args: unknown, parent: CallContext): Promise<ToolResult>;
  descriptions(): Array<{ name: string; description: string }>;
  /** Exact internal declarations, fetched only when a caller asks for schemas. */
  catalog(): PluginToolSchema[];
}

export function createRegistrar(server: McpServer | null, ctx: ToolContext, surface: SurfaceId, observe?: (name: string, config: { title?: string; description: string; inputSchema: z.ZodType; outputSchema?: z.ZodType; annotations?: ToolAnnotations; _meta?: Record<string, unknown> }) => void, publicNames?: ReadonlySet<string>): SurfaceRegistrar {
  const caps = ctx.caps;
  const exposedCaps = ctx.exposedCaps ?? caps;
  // These two do not follow a capability checkbox: they are whole features the user
  // switches on in the app, and neither touches the filesystem. Like the capability
  // tools they are exposed monotonically and disabled at the handler, so switching a
  // feature off does not delete a tool a cached ChatGPT snapshot still believes in.
  const sessionToolsLive = ctx.sessionTools ?? getConfig().sessions.record;
  const agentToolsLive = ctx.agentTools ?? getConfig().multiAgent.enabled;
  const sessionToolsExposed = ctx.exposedSessionTools ?? sessionToolsLive;
  const agentToolsExposed = ctx.exposedAgentTools ?? agentToolsLive;
  const findExposed = ctx.exposedFind ?? exposedCaps.search;
  const names: string[] = [];
  const handlers = new Map<string, { description: string; declaration: () => PluginToolSchema; run: (args: unknown, parent: CallContext) => Promise<ToolResult> }>();

  return {
    ctx,
    caps,
    exposedCaps,
    sessionToolsLive,
    sessionToolsExposed,
    agentToolsLive,
    agentToolsExposed,
    findExposed,
    registered: () => [...names],
    descriptions: () => [...handlers].map(([name, entry]) => ({ name, description: entry.description })),
    catalog: () => [...handlers.values()].map(entry => entry.declaration()),
    invokeNested(name, args, parent) {
      // Lifecycle admission is independent of argument validity and always wins.
      if (name === 'exec' || name === 'exec_read' || name === 'wait' || name === 'session_finish' || isFinishCall(name, args)) {
        return Promise.resolve(fail('DIRECT_CALL_REQUIRED: call this lifecycle tool directly, outside exec. No action was taken.'));
      }
      const entry = handlers.get(name);
      return entry ? entry.run(args, parent)
        : Promise.resolve(fail('UNKNOWN_TOOL: this tool is not available on this connector.'));
    },
    register(name, config, handler) {
      names.push(name);
      handlers.set(name, { description: config.description, declaration: () => ({
        name, description: config.description, inputSchema: { type: 'object', ...toolSchemaJson(config.inputSchema) },
        ...(config.title ? { title: config.title } : {}),
        ...(config.outputSchema ? { outputSchema: toolSchemaJson(config.outputSchema, 'output') } : {}),
        ...(config.annotations ? { annotations: { ...config.annotations } } : {}),
        ...(config._meta ? { _meta: config._meta } : {})
      }), run: async (args, parent) => {
        const parsed = await config.inputSchema.safeParseAsync(args);
        if (parsed.success) return dispatch(
          name, parsed.data, parent.caller.transportKey, parent.caller.requestId, surface,
          () => handler(parsed.data), parent
        );
        // Preserve the schema owner's corrective explanation for code-mode children too.
        // Zod issues omit input values; bound paths/messages and the number of diagnostics.
        const details = parsed.error.issues.slice(0, 3).map(issue =>
          `${issue.path.map(String).join('.').slice(0, 80) || 'arguments'}: ${issue.message.slice(0, 300)}`
        ).join('; ');
        return fail(`INVALID_ARGUMENTS: ${details}`);
      } });
      if (publicNames && !publicNames.has(name)) return;
      observe?.(name, config);
      // No identity field is ever added here. Every tool's schema is exactly what its
      // surface declared: who is calling is a fact about the conversation, established from
      // page evidence in `dispatch`, and never something the model is asked to carry.
      server?.registerTool(name, {
        ...config,
        inputSchema: toolSchema(config.inputSchema),
        ...(config.outputSchema ? { outputSchema: toolSchema(config.outputSchema) } : {})
      }, ((args: never, mcpCtx?: McpCallContext) =>
        dispatch(name, args, mcpCtx?.sessionId ?? null, requestIdOf(mcpCtx), surface, () =>
          handler(args), undefined, undefined, mcpCtx
        )) as never);
    },
    guarded(cap, name, fn) {
      return guard(name, async () => {
        if (!caps[cap]) {
          // The effective capability can be off because Read-only overrides its checkbox.
          // Name that owner, otherwise use the same permission label as Settings.
          return fail(
            ctx.readOnly && WRITE_CAPABILITIES.includes(cap)
              ? `TOOL_DISABLED: ${name} is disabled because Read-only mode is on. Ask the user to turn Read-only off in the app, then retry.`
              : `TOOL_DISABLED: ${name} requires the "${CAPABILITY_LABELS[cap]}" permission. Ask the user to enable "${CAPABILITY_LABELS[cap]}" in the app, then retry.`
          );
        }
        return fn();
      });
    },
    featureDisabled(feature, setting) {
      return fail(
        `FEATURE_DISABLED: ${feature} is switched off in Web GPT Agent. ` +
          `Ask the user to enable "${setting}" in the app, then try again.`
      );
    }
  };
}

// ------------------------------------------------------------------ formatters

/**
 * Largest brief a handoff save will accept.
 *
 * Generous on purpose. A brief that hits this is a symptom — the compaction of a very
 * long session — and refusing it there would throw away the one artefact the whole flow
 * exists to produce. The bound is only to keep a runaway generation from being written
 * to disk unbounded; at roughly four characters per token this is comfortably past any
 * single ChatGPT answer.
 */
/**
 * How long a prime-role `agents` call waits for the calling chat to show its own block.
 *
 * The prime holds no credential, so this window *is* its identity, and it has to be
 * evidence from this call: a block rendered after the call began, in exactly one
 * conversation. Shorter than a join because a prime calls `agents` repeatedly during a run
 * and a join happens once, but long enough that a page reporting on its own tick lands
 * inside it. Nothing falls back to "the only chat that has been active lately".
 */
export const PRIME_EVIDENCE_MS = evidenceWindow(2_500);

/**
 * The same window for a call ChatGPT gave a request id, which is waiting for one exact
 * page record rather than for whichever block turns up.
 *
 * Two and a half seconds was measured too short for the case that matters most: a worker's
 * first `agents` call runs seconds after its tab opened, and on 2026-08-18 worker-1 was
 * told WORKER_IDENTITY_LOST at 16:33:56 with the page evidence for that very call arriving
 * at 16:34:04. The wait is event-driven and ends the instant the mate lands, so the extra
 * seconds are only ever spent by a call that was going to be refused anyway.
 */
export const IDENTITY_EVIDENCE_MS = evidenceWindow(15_000);

/**
 * The same window again for the two `agents` actions whose refusal cannot be retried cheaply.
 *
 * Everything else that waits for identity is asking about work it can decline and be asked
 * for again a moment later. `spawn` is not: a refused `spawn` ends the turn with
 * no run, and the model's own retry costs the user another full generation — on 2026-08-21 it
 * cost two, and the run still never started. The wait is event-driven and returns the instant
 * the page's request-id mate lands, so a longer ceiling is only ever spent by a call that was
 * going to be refused anyway; against that, the live evidence shows ids arriving twenty
 * seconds after the window that refused them. Kept well inside ChatGPT's own connector
 * timeout, so a slow proof still comes back as a spawned run rather than as a dead call.
 */
export const SPAWN_EVIDENCE_MS = evidenceWindow(30_000);

/** Splits on blank lines so a part never ends mid-sentence unless a block is huge. */
export function chunkText(text: string, size: number): string[] {
  if (text.length <= size) return [text];
  const parts: string[] = [];
  let current = '';
  for (const block of text.split(/\n{2,}/)) {
    const candidate = current ? `${current}\n\n${block}` : block;
    if (candidate.length <= size) {
      current = candidate;
      continue;
    }
    if (current) parts.push(current);
    if (block.length <= size) {
      current = block;
    } else {
      for (let at = 0; at < block.length; at += size) parts.push(block.slice(at, at + size));
      current = '';
    }
  }
  if (current) parts.push(current);
  return parts.length > 0 ? parts : [''];
}

/** The per-path header `read` prints. This is what `file_info` used to be. */
export function formatFileInfo(info: FileInfo): string {
  const lines = [
    `path: ${info.virtualPath}`,
    `type: ${info.type}`,
    `size: ${formatBytes(info.bytes)}`,
    `modified: ${info.modified}`,
    `created: ${info.created}`
  ];
  if (info.readOnly) lines.push('readonly: true');
  if (info.binary !== null) lines.push(`binary: ${info.binary}`);
  if (info.lines !== null) lines.push(`lines: ${info.lines}`);
  if (info.sha256) lines.push(`sha256: ${info.sha256}`);
  return lines.join('\n');
}
