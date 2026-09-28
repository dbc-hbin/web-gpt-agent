import { createHash, randomUUID } from 'node:crypto';
import path from 'node:path';
import {
  WORK_BLOCKER_CODES,
  WORK_ERROR_CODES,
  WORK_EVENT_KINDS,
  WORK_GOAL_MAX_BYTES,
  WORK_GOAL_PREVIEW_CHARS,
  WORK_INSTRUCTION_PREVIEW_CHARS,
  WORK_LIST_DEFAULT_LIMIT,
  WORK_LIST_MAX_LIMIT,
  WORK_RESPONSE_MAX_BYTES,
  WORK_EVENTS_DEFAULT_LIMIT,
  WorkServiceError,
  workControlSchema,
  workErrorPayload,
  workEventsRequestSchema,
  workInstructionSchema,
  workListSchema,
  workStartSchema,
  workStatusRequestSchema,
  type WorkAgentSummary,
  type WorkChange,
  type WorkControl,
  type WorkDesiredState,
  type WorkEvent,
  type WorkEventPage,
  type WorkEventsRequest,
  type WorkInstruction,
  type WorkList,
  type WorkPage,
  type WorkProjectOption,
  type WorkReceipt,
  type WorkService,
  type WorkState,
  type WorkStatus,
  type WorkStatusRequest,
  type WorkStart,
  type WorkSummary
} from '../../shared/work.js';
import type {
  WorkCommandRow,
  WorkOperationRow,
  WorkRow,
  WorkStore
} from './store.js';

/**
 * The one durable work authority.
 *
 * Three interfaces — GUI IPC, the CLI over the control socket, and the MCP tools — all parse
 * the same Zod schemas and call these six methods. None of them keeps its own queue, because a
 * second queue is a second truth: the whole product promise is that a work id survives a
 * closed window, a dropped MCP response, a browser reload and a host restart.
 *
 * The shape of every mutation is the same, and it is the important part of this file:
 *
 * 1. Canonicalize the request and hash it.
 * 2. Look the `request_id` up in `work_commands`. Same payload returns the prior receipt;
 *    a different payload is `REQUEST_ID_CONFLICT`. Nothing is executed twice.
 * 3. Commit the state change, the revision, the event and the delivery intent in one
 *    transaction.
 * 4. Only then return. Delivery to the browser is a background pump, never part of the
 *    response: a control call must not wait for a tunnel, a page, or a model.
 *
 * Execution lives behind `WorkRuntimePort`, which the runtime supplies. This module never
 * imports the runtime, so the ledger can be tested — and reasoned about — without a browser.
 */

export interface WorkProjectResolution {
  /** Canonical absolute path, or the input when it could not be resolved. */
  path: string;
  name: string;
  exists: boolean;
  isGit: boolean;
  /** Set when the path exists but could not be used; shown verbatim to the caller. */
  error?: string;
}

/** Project discovery: the existing project registry, behind one narrow interface. */
export interface WorkProjectDirectory {
  resolve(inputPath: string): Promise<WorkProjectResolution>;
  list(): Promise<WorkProjectOption[]>;
}

/**
 * Model/effort selection. Implementations validate against what the account actually offers
 * and throw `WorkServiceError(MODEL_UNAVAILABLE)` rather than silently downgrading.
 */
export interface WorkModelSelection {
  resolve(input: { model?: string; reasoning?: string }): Promise<{ model: string | null; reasoning: string | null }>;
}

export interface WorkRuntimeStart {
  workId: string;
  requestId: string;
  projectPath: string;
  goal: string;
  title: string;
  model: string | null;
  reasoning: string | null;
  maxWorkers: number;
  integrationBranch: string;
  integrationWorktree: string;
  /**
   * The completed work this admission continues, when there is one. The runtime uses it to
   * capture the successor baseline from the predecessor's integration branch instead of a fresh
   * project snapshot.
   */
  predecessorWorkId?: string;
  /**
   * When the durable start command was created. The outbox uses it as a stable `dueAt`, so a
   * retried send is scheduled against the same instant rather than "now".
   */
  createdAt: number;
}

export interface WorkRuntimeDelivery {
  workId: string;
  requestId: string;
  kind: WorkCommandRow['kind'];
  text: string | null;
  /** The persisted command id, used as the stable outbox input id so a retry cannot double-send. */
  outboxInputId: string;
  /** Attempt number, 1-based. */
  attempt: number;
  /**
   * When the durable command row was created. This is the stable `dueAt` for the outbox: a
   * retry must reuse the original instant, because a re-derived `Date.now()` would make the same
   * message look like a new one on every attempt.
   */
  commandCreatedAt: number;
}

/**
 * What one delivery attempt actually established.
 *
 * The distinction that matters is acknowledgement: only `delivered` means the conversation has
 * the message. `queued` means the outbox accepted it and it is still waiting for its turn, and
 * `unknown` means the hand-off was attempted and its outcome cannot be established — both are
 * recorded as such and reconciled later, never reported as a delivery that happened.
 */
export type WorkRuntimeDeliveryResult =
  | { state: 'delivered' }
  | { state: 'queued'; detail?: string }
  | { state: 'unknown'; error: string }
  | { state: 'deferred'; detail?: string }
  | { state: 'failed'; error: string }
  | { state: 'cancelled' };

export interface WorkRuntimeControl {
  workId: string;
  action: WorkControl['action'];
  commandId: string;
  /** True only for an explicit new resume request, which grants one more recovery episode. */
  grantRecoveryEpisode: boolean;
}

export interface WorkRuntimeControlResult {
  /** The factual status after draining. The ledger never invents one. */
  status: WorkState;
  /**
   * The blocker to record for this transition. `null` means none; a pause of an already-blocked
   * work may legitimately keep its recorded reason.
   */
  blocker?: { code: string; detail: string } | null;
}

export interface WorkRuntimeReconcileInput {
  openOperations: WorkOperationRow[];
  /** Every command that never reached a terminal delivery state, including start commands. */
  pendingCommands: WorkCommandRow[];
  /**
   * Works that are not finished and have no live delivery: the runtime decides which need the
   * admission stage re-run (a crash before the prime was dispatched) and which are simply
   * waiting for a user instruction. Nothing is replayed blindly.
   */
  unfinishedWorks: WorkRow[];
}

/**
 * Everything the service needs from the executing side. All members are required: a missing
 * execution path is a construction error, not a silently accepted no-op that would report
 * success for work that never ran.
 */
export interface WorkRuntimePort {
  /** Fire-and-forget admission stage: snapshots, worktrees, browser, prime dispatch. */
  beginStart(input: WorkRuntimeStart): Promise<void>;
  deliver(input: WorkRuntimeDelivery): Promise<WorkRuntimeDeliveryResult>;
  control(input: WorkRuntimeControl): Promise<WorkRuntimeControlResult>;
  /** Startup reconciliation; the ledger is already the source of truth. */
  reconcile(input: WorkRuntimeReconcileInput): Promise<void>;
}

export interface WorkServiceDependencies {
  store: WorkStore;
  runtime: WorkRuntimePort;
  projects: WorkProjectDirectory;
  models: WorkModelSelection;
  /** Root of managed worktrees; the integration worktree is `<root>/<work_id>/main`. */
  worktreesRoot: string;
  now?: () => number;
  /** Delivery attempts before a command is parked as failed. */
  maxDeliveryAttempts?: number;
}

export interface WorkServiceHandle extends WorkService {
  /** Startup: reconcile durable rows, then start the delivery pump. */
  reconcile(): Promise<void>;
  /** Runs the pump once; tests use this instead of waiting for a timer. */
  pumpNow(): Promise<void>;
  close(): void;
}

/** Re-exported so main-process callers can type a `WorkService` field without a second import. */
export type { WorkService, WorkServiceError };
export { isWorkServiceError, workErrorPayload } from '../../shared/work.js';

/** Delivery attempts before an instruction is parked with a visible blocker. */
const DEFAULT_MAX_DELIVERY_ATTEMPTS = 3;
const MAX_STATUS_GOAL_CHARS = 16 * 1024;
const MAX_STATUS_OPERATIONS = 20;
const MAX_STATUS_COMMANDS = 20;
const PUMP_BATCH = 20;
/**
 * The slow fallback interval for a command whose send is not acknowledged yet (`queued`) or
 * whose hand-off is ambiguous (`unknown`). The outbox's own change notification is the fast path;
 * this bound is what keeps a lost acknowledgement from polling the ledger in a tight loop.
 */
const RECONCILE_PUMP_DELAY_MS = 15_000;

function fail(code: string, message: string, detail?: string): never {
  throw new WorkServiceError(code, message, detail);
}

/** Internal signal: a concurrent caller already admitted this request id. */
class AdmissionConflict extends Error {
  constructor() {
    super('REQUEST_ID_CONFLICT');
    this.name = 'AdmissionConflict';
  }
}

/** Canonical JSON so two spellings of the same request hash identically. */
function canonical(value: unknown): unknown {
  if (value === null || typeof value !== 'object') {
    if (typeof value === 'number' && !Number.isFinite(value)) return { __number: String(value) };
    return value;
  }
  if (Array.isArray(value)) return value.map(canonical);
  const source = value as Record<string, unknown>;
  const out: Record<string, unknown> = {};
  for (const key of Object.keys(source).sort()) {
    if (source[key] === undefined) continue;
    out[key] = canonical(source[key]);
  }
  return out;
}

function requestHash(kind: string, payload: unknown): string {
  return createHash('sha256').update(JSON.stringify({ kind, payload: canonical(payload) }), 'utf8').digest('hex');
}

/**
 * An explicitly truncated preview that never exceeds `limit` characters: the marker is part of
 * the budget, so a client parsing against the schema's bound cannot be surprised by a preview
 * that grew.
 */
function preview(text: string, limit: number): string {
  if (text.length <= limit) return text;
  const marker = `…[+${text.length}]`;
  const keep = Math.max(0, limit - marker.length);
  return `${text.slice(0, keep)}${marker}`;
}

function truncate(text: string, limit: number): string {
  if (text.length <= limit) return text;
  return `${text.slice(0, limit)}\n…[truncated ${text.length - limit} characters; the full text is retained by the work ledger]`;
}

function integrationPaths(worktreesRoot: string, workId: string): { branch: string; worktree: string } {
  return {
    branch: `wgpt/${workId}/main`,
    worktree: path.join(worktreesRoot, workId, 'main')
  };
}

/**
 * The successor's goal: the user's own follow-up request, then only what it takes to place it.
 *
 * The order is the point. The successor's prime is opened by this text, and the thing it must act
 * on is the new instruction — the same words the user typed. Putting the predecessor's goal first
 * (or carrying only that) would open the new work on a task that was already finished.
 *
 * What travels with it is a *reference*, not a briefing: the predecessor's id, and a bounded excerpt
 * of its goal for continuity of meaning. The predecessor's branch, worktree and base commit are
 * deliberately not restated — they are the previous run's immutable coordinates, they are already
 * durably linked through `works.predecessor_work_id`, and naming them here would point the new
 * prime at paths it must not work in. There is also no imperative header: the instruction is the
 * instruction, and the excerpt is labeled as what it is.
 */
function continuationGoal(predecessor: WorkRow, instruction: string): string {
  const reference = `Predecessor work: ${predecessor.work_id}`;
  const fixed = Buffer.byteLength([instruction, '', reference, '', 'Predecessor goal:', ''].join('\n'), 'utf8');
  // No room for any context: the goal is the instruction alone. The lineage is not lost with it —
  // `works.predecessor_work_id` and the successor's own worktree/branch already record it durably,
  // and the runtime receives `predecessorWorkId` on the start stage — so a maximal request is
  // carried whole rather than pushing the row past the goal budget.
  const budget = WORK_GOAL_MAX_BYTES - fixed;
  if (budget <= 0) return instruction;
  const marker = `\n…[truncated; the full goal is retained by work ${predecessor.work_id}]`;
  const markerBytes = Buffer.byteLength(marker, 'utf8');
  const source = predecessor.goal;
  if (Buffer.byteLength(source, 'utf8') <= budget) {
    return [instruction, '', reference, '', 'Predecessor goal:', source].join('\n');
  }
  const keep = budget - markerBytes;
  const excerpt = keep > 0 ? `${utf8Slice(source, keep)}${marker}` : '';
  return [instruction, '', reference, '', 'Predecessor goal:', excerpt].join('\n');
}

/**
 * Truncates to at most `limit` UTF-8 bytes without splitting a code point.
 *
 * `String.prototype.slice` counts UTF-16 units, so slicing a CJK or emoji goal by a byte budget
 * would overshoot it by up to 3x — the exact case this budget exists to prevent.
 */
function utf8Slice(value: string, limit: number): string {
  if (Buffer.byteLength(value, 'utf8') <= limit) return value;
  let bytes = 0;
  let end = 0;
  for (const char of value) {
    const size = Buffer.byteLength(char, 'utf8');
    if (bytes + size > limit) break;
    bytes += size;
    end += char.length;
  }
  return value.slice(0, end);
}

/**
 * Keeps a status/control body under the 64KiB response cap by trimming the *variable* text
 * fields first — goal, checkpoint prose, blocker detail — and marking each truncation
 * explicitly. Identity, status and references are never dropped: a client must always be able
 * to see what happened and where the full text lives.
 */
function boundStatus(status: WorkStatus): WorkStatus {
  if (Buffer.byteLength(JSON.stringify(status), 'utf8') <= WORK_RESPONSE_MAX_BYTES) return status;
  const bound = (text: string, keep: number): string => (text.length <= keep ? text : `${text.slice(0, keep)}…[truncated; full text retained by the work ledger]`);
  const trimmed: WorkStatus = {
    ...status,
    goal: bound(status.goal, 4096),
    blocker: status.blocker ? { ...status.blocker, detail: bound(status.blocker.detail, 2000) } : null,
    checkpoint: status.checkpoint ? { ...status.checkpoint, summary: bound(status.checkpoint.summary, 2000) } : null,
    operations: status.operations.slice(0, 10),
    pending_commands: status.pending_commands.slice(0, 10),
    agents: status.agents.slice(0, 16)
  };
  if (Buffer.byteLength(JSON.stringify(trimmed), 'utf8') <= WORK_RESPONSE_MAX_BYTES) return trimmed;
  return {
    ...trimmed,
    goal: bound(trimmed.goal, 1024),
    checkpoint: trimmed.checkpoint ? { ...trimmed.checkpoint, summary: bound(trimmed.checkpoint.summary, 512) } : null,
    blocker: trimmed.blocker ? { ...trimmed.blocker, detail: bound(trimmed.blocker.detail, 512) } : null,
    operations: trimmed.operations.slice(0, 5),
    pending_commands: trimmed.pending_commands.slice(0, 5)
  };
}

export function createWorkService(deps: WorkServiceDependencies): WorkServiceHandle {
  const { store, runtime } = deps;
  const now = deps.now ?? (() => Date.now());
  const maxDeliveryAttempts = deps.maxDeliveryAttempts ?? DEFAULT_MAX_DELIVERY_ATTEMPTS;

  let pumpTimer: ReturnType<typeof setTimeout> | null = null;
  /** Delay of the outstanding tick; `Infinity` when none is scheduled. */
  let pumpDelay = Number.POSITIVE_INFINITY;
  let pumping = false;
  /** A pump request that arrived while a pass was running; served by the next pass. */
  let wakeRequested = false;
  let closed = false;

  /**
   * Whether this service may still touch the ledger. Both the service and the store can be
   * closed independently (a host shutdown closes the store first), and an async continuation
   * that outlived its owner must stop rather than throw from a finalized statement.
   */
  function alive(): boolean {
    return !closed && !store.isClosed();
  }

  // ---------------------------------------------------------------------------------------
  // Shared helpers
  // ---------------------------------------------------------------------------------------

  function requireWork(workId: string): WorkRow {
    const work = store.getWork(workId);
    if (!work) fail(WORK_ERROR_CODES.workNotFound, 'WORK_NOT_FOUND: no work with that id exists. Work ids are never resolved from the current selection.');
    return work;
  }

  /** Cancellation is terminal: a fenced or already-cancelled work refuses new instructions. */
  function isFenced(work: WorkRow): boolean {
    return work.desired_state === 'cancelled' || work.status === 'cancelled';
  }

  function receiptOf(work: WorkRow, requestId: string): WorkReceipt {
    return {
      request_id: requestId,
      work_id: work.work_id,
      status: work.status,
      revision: work.revision,
      ...(work.integration_branch ? { integration_branch: work.integration_branch } : {}),
      ...(work.integration_worktree ? { integration_worktree: work.integration_worktree } : {}),
      // Present only for a continuation, so a caller can tell "your instruction landed on a new
      // work that continues the completed one" from "the work you named is still the active one".
      ...(work.predecessor_work_id ? { predecessor_work_id: work.predecessor_work_id } : {})
    };
  }

  function priorReceipt(command: WorkCommandRow): WorkReceipt | null {
    if (!command.result_json) return null;
    try {
      const parsed: unknown = JSON.parse(command.result_json);
      if (parsed && typeof parsed === 'object' && 'work_id' in parsed && 'revision' in parsed) {
        return parsed as WorkReceipt;
      }
    } catch {
      /* A damaged receipt row falls through to a fresh projection. */
    }
    return null;
  }

  /**
   * Idempotency: one `request_id` maps to exactly one command row. Same payload returns the
   * prior receipt, a different payload is a conflict. Never executes anything.
   */
  function claimCommand(input: {
    requestId: string;
    workId: string;
    kind: WorkCommandRow['kind'];
    hash: string;
    text: string | null;
  }): { command: WorkCommandRow; replay: WorkReceipt | null } | { conflict: true } {
    const existing = store.getCommand(input.requestId);
    if (existing) {
      if (existing.input_hash !== input.hash || existing.work_id !== input.workId) return { conflict: true };
      return { command: existing, replay: priorReceipt(existing) };
    }
    const at = now();
    const row: WorkCommandRow = {
      request_id: input.requestId,
      work_id: input.workId,
      kind: input.kind,
      input_hash: input.hash,
      text: input.text,
      delivery_state: 'pending',
      outbox_input_id: input.requestId,
      result_json: null,
      attempts: 0,
      last_error: null,
      created_at: at,
      updated_at: at
    };
    try {
      store.insertCommand(row);
    } catch (error) {
      // A concurrent call with the same id won the insert. Re-read and behave like the loser.
      const raced = store.getCommand(input.requestId);
      if (!raced) throw error;
      if (raced.input_hash !== input.hash || raced.work_id !== input.workId) return { conflict: true };
      return { command: raced, replay: priorReceipt(raced) };
    }
    return { command: row, replay: null };
  }

  function recordReceipt(requestId: string, receipt: WorkReceipt): void {
    store.updateCommand(requestId, { result_json: JSON.stringify(receipt) });
  }

  function conflict(requestId: string): never {
    fail(
      WORK_ERROR_CODES.requestIdConflict,
      `REQUEST_ID_CONFLICT: request id ${requestId} was already used for a different request. Nothing was executed; generate a new UUID for the new request.`
    );
  }

/**
 * The active end of a continuation chain.
 *
 * Only recorded successor links are followed — never "the most recent work", never a
 * conversation, never a guess. The chain is finite by construction: each link is written once,
 * by `linkContinuation`, and a work has at most one successor. Termination is therefore proven by
 * the visited set, not by a depth budget: a chain that revisits a work is damage in the ledger
 * and is refused, while a genuinely long chain (a work continued a hundred times) is simply
 * followed to its tip, because a continuation has no generation lifetime.
 */
  function activeEnd(start: WorkRow): WorkRow {
    let current = start;
    const seen = new Set<string>([current.work_id]);
    while (current.successor_work_id) {
      const nextId = current.successor_work_id;
      if (seen.has(nextId)) {
        fail(WORK_ERROR_CODES.continuationConflict, `CONTINUATION_CONFLICT: the continuation chain that starts at ${start.work_id} loops back on ${nextId}. The ledger refuses to route an instruction through a cycle.`);
      }
      const next = store.getWork(nextId);
      if (!next) {
        fail(WORK_ERROR_CODES.continuationConflict, `CONTINUATION_CONFLICT: work ${current.work_id} names successor ${nextId}, which is not in the ledger.`);
      }
      seen.add(next.work_id);
      current = next;
    }
    return current;
  }

  /**
   * Creates the one durable successor of a completed work, inside the caller's transaction.
   *
   * The successor is an ordinary work: its own id, its own prime agent, its own integration
   * branch and worktree, its own start command (whose id is the stable outbox input id for the
   * opening message — never the instruction's, which would make one input row carry two
   * messages). What it inherits is what a continuation needs: the project, the model/effort pair
   * the account already accepted, the worker budget, and the predecessor's link.
   *
   * The predecessor keeps its goal, status and revision history; the only thing written on it is
   * the successor link plus one `work_continued` event.
   */
  function createSuccessor(predecessor: WorkRow, instructionRequestId: string, instructionText: string): { row: WorkRow; start: WorkRuntimeStart; outboxInputId: string } {
    const workId = randomUUID();
    const primeId = randomUUID();
    const startRequestId = randomUUID();
    const { branch, worktree } = integrationPaths(deps.worktreesRoot, workId);
    const at = now();
    const title = preview(`Continue ${predecessor.title}`.trim() || 'Continued work', 200);
    const goal = continuationGoal(predecessor, instructionText);
    const row: WorkRow = {
      work_id: workId,
      title,
      goal,
      project_path: predecessor.project_path,
      project_name: predecessor.project_name,
      base_commit: null,
      integration_branch: branch,
      integration_worktree: worktree,
      status: 'queued',
      desired_state: null,
      prime_agent_id: primeId,
      prime_session_id: null,
      model: predecessor.model,
      reasoning: predecessor.reasoning,
      max_workers: predecessor.max_workers,
      revision: 0,
      blocker: null,
      checkpoint: null,
      integration_intent: null,
      predecessor_work_id: predecessor.work_id,
      successor_work_id: null,
      created_at: at,
      updated_at: at
    };
    // The work row and its prime exist before the link, because `linkContinuation` reads both
    // rows: a link can never point at a work that was only half written.
    store.insertWork(row);
    store.insertAgent({
      agent_id: primeId,
      work_id: workId,
      parent_id: null,
      role: 'prime',
      label: 'prime',
      state: 'pending',
      session_id: null,
      conversation_id: null,
      generation: 0,
      worktree_path: worktree,
      branch,
      base_commit: null,
      model: predecessor.model,
      reasoning: predecessor.reasoning,
      result_ref: null,
      checkpoint_ref: null,
      created_at: at,
      updated_at: at
    });
    store.linkContinuation(predecessor.work_id, workId);
    store.appendEvent(workId, WORK_EVENT_KINDS.workQueued, {
      goal_preview: preview(goal, WORK_GOAL_PREVIEW_CHARS),
      project_path: predecessor.project_path,
      max_workers: predecessor.max_workers,
      predecessor_work_id: predecessor.work_id,
      by_instruction: instructionRequestId
    });
    const start: WorkRuntimeStart = {
      workId,
      requestId: startRequestId,
      projectPath: predecessor.project_path,
      goal,
      title,
      model: predecessor.model,
      reasoning: predecessor.reasoning,
      maxWorkers: predecessor.max_workers,
      integrationBranch: branch,
      integrationWorktree: worktree,
      predecessorWorkId: predecessor.work_id,
      createdAt: at
    };
    // The start command's "delivery" is the admission receipt itself, exactly as in `start`:
    // reconciliation reads the work row to decide whether the stage ran, and the id is what the
    // prime's opening send uses as its stable outbox input id.
    //
    // That outbox input id is the *same* one the user's instruction command carries. The opening
    // send and the instruction are one message: the prime's first turn already contains the full
    // follow-up, so a second send under a different id would deliver the same instruction twice.
    // The instruction row keeps its own request_id as its durable identity; only the outbox input
    // id is shared, and the runtime refuses to send a linked instruction unless the opening row
    // for it already exists.
    store.insertCommand({
      request_id: startRequestId,
      work_id: workId,
      kind: 'start',
      input_hash: requestHash('start', { kind: 'continuation', predecessor_work_id: predecessor.work_id, work_id: workId }),
      text: goal,
      delivery_state: 'delivered',
      outbox_input_id: startRequestId,
      result_json: JSON.stringify(receiptOf(store.getWork(workId)!, startRequestId)),
      attempts: 0,
      last_error: null,
      created_at: at,
      updated_at: at
    });
    return { row: store.getWork(workId)!, start, outboxInputId: startRequestId };
  }

  function summaryOf(work: WorkRow): WorkSummary {
    const prime = work.prime_agent_id ? store.getAgent(work.prime_agent_id) : null;
    return {
      work_id: work.work_id,
      title: work.title,
      status: work.status,
      desired_state: work.desired_state,
      goal_preview: preview(work.goal, WORK_GOAL_PREVIEW_CHARS),
      project_path: work.project_path,
      project_name: work.project_name,
      integration_branch: work.integration_branch,
      integration_worktree: work.integration_worktree,
      base_commit: work.base_commit,
      revision: work.revision,
      max_workers: work.max_workers,
      agent_count: store.countAgents(work.work_id),
      prime_agent_id: prime?.agent_id ?? work.prime_agent_id,
      predecessor_work_id: work.predecessor_work_id,
      successor_work_id: work.successor_work_id,
      blocker: work.blocker,
      created_at: work.created_at,
      updated_at: work.updated_at
    };
  }

  function operationSummary(row: WorkOperationRow) {
    return {
      operation_id: row.operation_id,
      agent_id: row.agent_id,
      tool: row.tool,
      state: row.state,
      result_ref: row.result_ref,
      resolution: row.resolution?.decision ?? null,
      retry_operation_id: row.retry_operation_id,
      updated_at: row.updated_at
    };
  }

  /** The bounded recovery projection. The internal record never leaves the ledger verbatim. */
  function recoveryOf(agentId: string, generation: number) {
    const record = store.loadRecovery<{
      phase?: unknown;
      episodes?: unknown;
      attempts?: unknown;
      next_attempt_at?: unknown;
    }>(agentId, generation);
    if (!record) return null;
    return {
      agent_id: agentId,
      generation,
      phase: typeof record.phase === 'string' ? record.phase : 'idle',
      episodes: typeof record.episodes === 'number' ? record.episodes : 0,
      attempts: typeof record.attempts === 'number' ? record.attempts : 0,
      next_attempt_at: typeof record.next_attempt_at === 'number' ? record.next_attempt_at : 0
    };
  }

  function agentSummary(agent: ReturnType<WorkStore['listAgents']>[number]): WorkAgentSummary {
    const latest = store.listOperationsForAgent(agent.agent_id, agent.generation)[0] ?? null;
    return {
      agent_id: agent.agent_id,
      role: agent.role,
      label: agent.label,
      state: agent.state,
      session_id: agent.session_id,
      conversation_id: agent.conversation_id,
      generation: agent.generation,
      worktree_path: agent.worktree_path,
      branch: agent.branch,
      base_commit: agent.base_commit,
      model: agent.model,
      reasoning: agent.reasoning,
      result_ref: agent.result_ref,
      checkpoint_ref: agent.checkpoint_ref,
      last_operation: latest ? operationSummary(latest) : null,
      recovery: recoveryOf(agent.agent_id, agent.generation),
      created_at: agent.created_at,
      updated_at: agent.updated_at
    };
  }

  // ---------------------------------------------------------------------------------------
  // Delivery pump
  // ---------------------------------------------------------------------------------------

  /**
   * Schedules one pump tick.
   *
   * A pending tick can be *brought forward* by a caller that needs delivery now — a fresh
   * instruction must never wait out a reconciliation interval that was scheduled for an
   * unrelated, unacknowledged send — but it is never pushed later, and only one tick is ever
   * outstanding.
   */
  function schedulePump(delayMs = 0): void {
    if (!alive()) return;
    if (pumpTimer !== null) {
      if (pumpDelay <= delayMs) return;
      clearTimeout(pumpTimer);
    }
    pumpDelay = delayMs;
    pumpTimer = setTimeout(() => {
      pumpTimer = null;
      pumpDelay = Number.POSITIVE_INFINITY;
      void pump();
    }, delayMs);
    pumpTimer.unref?.();
  }

  /**
   * Records a failed admission stage as a retained blocker, unless the user already stopped the
   * work.
   *
   * The stage is asynchronous, so a pause or cancel can land while it is in flight. Overwriting
   * a committed stop with `blocked` would silently reopen work the user ended, so the fence wins:
   * the failure is only recorded while the work is still live and unfenced.
   */
  function markStartFailure(workId: string, error: unknown): void {
    if (store.isClosed()) return;
    const current = store.getWork(workId);
    if (!current) return;
    if (current.desired_state !== null) return;
    if (current.status === 'paused' || current.status === 'cancelled' || current.status === 'completed') return;
    const payloadError = workErrorPayload(error);
    store.setWorkStatus(workId, 'blocked', WORK_EVENT_KINDS.workBlocked);
    store.setBlocker(workId, {
      code: payloadError.code,
      detail: payloadError.message,
      at: now()
    }, WORK_EVENT_KINDS.workBlocked);
  }

  /**
   * Clears the unconfirmed-send blocker once no command of the work is `unknown` any more.
   *
   * Only that exact code is cleared: a work blocked for another reason (a failed operation, a
   * launch failure) keeps its own, more specific reason. The check is against the durable rows,
   * not against the event that prompted it, so a late acknowledgement on one command can never
   * clear the blocker while a *different* command of the same work is still unconfirmed.
   */
  function clearUnknownDeliveryBlocker(workId: string): void {
    const work = store.getWork(workId);
    if (!work || work.blocker?.code !== WORK_BLOCKER_CODES.instructionDeliveryUnknown) return;
    if (store.hasUnacknowledgedDelivery(workId)) return;
    store.setBlocker(workId, null, WORK_EVENT_KINDS.workUnblocked);
  }

  /**
   * Delivers durably recorded commands. A command's delivery state is committed before the
   * attempt, so a crash mid-send leaves a row the next boot can retry under the same outbox
   * input id rather than a second, duplicate send.
   *
   * Only a real acknowledgement is recorded as `delivered`. A `queued` result means the outbox
   * accepted the message and the conversation has not taken it yet, and an `unknown` result means
   * the hand-off was attempted but its outcome cannot be established. Both stay in the pump's
   * work list, because the outbox row itself is the reconciliation: a later tick sees the same
   * stable input id and either observes the real outcome or asks again — it never sends twice.
   */
  async function pump(): Promise<void> {
    // A wake that arrives while a pass is running is a fact about the ledger, not a lost event:
    // it is latched and served by the next pass, so a burst larger than one batch (or an outbox
    // notification landing mid-pass) is never dropped on the floor.
    if (pumping) {
      wakeRequested = true;
      return;
    }
    if (!alive()) return;
    pumping = true;
    let reconcileLater = false;
    let advanced = false;
    let examined = 0;
    try {
      // Fresh commands first, then the ones that are only waiting to be reconciled. The split is
      // what keeps a slow chat from starving a new instruction out of the batch: a never-attempted
      // command is always considered, and the retained group rotates on `updated_at` (bumped by
      // every attempt) so repeated ticks do not re-read the same prefix forever.
      const fresh = store.listDeliverableFreshCommands(PUMP_BATCH);
      const retained = fresh.length >= PUMP_BATCH
        ? []
        : store.listDeliverableRetainedCommands(PUMP_BATCH - fresh.length);
      const commands = [...fresh, ...retained];
      examined = commands.length;
      for (const command of commands) {
        if (!alive()) break;
        const work = store.getWork(command.work_id);
        if (!work) continue;
        // A stopped work starts no new sends. "New" is exactly one case: an instruction that was
        // never admitted to the outbox — still `pending` with no attempt behind it, AND not linked
        // to another command's outbox input. A linked instruction (`outbox_input_id` differs from
        // its own `request_id`) shares the successor's opening send, which the start stage may
        // already have admitted, authorized or delivered before this pump ever saw the row, so its
        // `pending`/0 tells us nothing. Those rows are always polled, because the opening receipt
        // is the only thing that can say whether the message actually went.
        const stopped = work.status === 'paused' || work.status === 'cancelled' || work.desired_state !== null;
        if (stopped && command.delivery_state === 'pending' && command.attempts === 0 &&
            command.outbox_input_id === command.request_id) continue;
        const previousState = command.delivery_state;
        const attempt = command.attempts + 1;
        // The lease is silent: it exists so a crash between here and the outcome leaves a row the
        // next boot can re-arm, not to announce that an attempt started.
        store.leaseCommand(command.request_id, attempt);
        let result: WorkRuntimeDeliveryResult;
        try {
          result = await runtime.deliver({
            workId: command.work_id,
            requestId: command.request_id,
            kind: command.kind,
            text: command.text,
            outboxInputId: command.outbox_input_id,
            attempt,
            // The durable creation instant, so a retried send keeps its original schedule
            // instead of looking like a new message on every attempt.
            commandCreatedAt: command.created_at
          });
        } catch (error) {
          result = { state: 'failed', error: error instanceof Error ? error.message : String(error) };
        }
        if (!alive()) break;
        if (result.state === 'delivered') {
          store.updateCommand(command.request_id, { delivery_state: 'delivered', last_error: null });
          store.appendEvent(command.work_id, WORK_EVENT_KINDS.instructionDelivered, { request_id: command.request_id, kind: command.kind });
          // A late acknowledgement is exactly what the unconfirmed-send blocker was waiting for.
          // This runs on every acknowledgement, not only when this row was observed as `unknown`
          // in this same pass: a restart can reset an unknown row to pending, and the blocker must
          // still clear when the send it doubted is finally confirmed. The helper re-reads the
          // durable rows, so it clears only when nothing of this work is unconfirmed.
          clearUnknownDeliveryBlocker(command.work_id);
          advanced = true;
          continue;
        }
        if (result.state === 'queued') {
          // Held by the outbox, not taken by the conversation. Not an attempt's failure, so the
          // attempt count is not consumed and the row keeps whatever it factually was.
          const detail = result.detail ?? null;
          if (previousState === 'queued' && command.last_error === detail) {
            // The same fact observed again. The row is put back silently: a chat that is slow to
            // take its message must not inflate the work's revision with "still waiting" writes.
            store.releaseCommand(command.request_id, { delivery_state: 'queued', attempts: command.attempts, last_error: detail });
          } else {
            store.updateCommand(command.request_id, { delivery_state: 'queued', attempts: command.attempts, last_error: detail });
            store.appendEvent(command.work_id, WORK_EVENT_KINDS.instructionDeliveryQueued, {
              request_id: command.request_id,
              outbox_input_id: command.outbox_input_id
            });
            advanced = true;
          }
          reconcileLater = true;
          continue;
        }
        if (result.state === 'deferred') {
          // Nothing was attempted and nothing changed: the prime conversation is not bound yet, or
          // the chat is fenced. The row is put back exactly where it was, silently, so a stalled
          // work cannot inflate the revision with "still waiting" writes. This is also not
          // progress, so the retry takes the slow bound rather than an immediate re-run.
          store.releaseCommand(command.request_id, {
            delivery_state: previousState === 'delivering' ? 'pending' : previousState,
            attempts: command.attempts,
            last_error: command.last_error
          });
          reconcileLater = true;
          continue;
        }
        if (result.state === 'cancelled') {
          store.updateCommand(command.request_id, { delivery_state: 'cancelled', last_error: null });
          advanced = true;
          continue;
        }
        const error = result.error;
        if (result.state === 'unknown') {
          // The hand-off was attempted and its outcome cannot be established. This is NOT a
          // failure and NOT a delivery: the row stays in the pump's work list under the same
          // stable outbox input id, so the real outbox row can still resolve it — a late
          // acknowledgement flips it to `delivered`, and nothing is ever sent twice. After the
          // attempt budget it raises a durable blocker instead of being parked, because parking
          // it would silently discard exactly the acknowledgement that makes it knowable.
          const repeated = previousState === 'unknown' && command.last_error === error;
          if (repeated) {
            // The same ambiguity observed again: recorded silently, never as news. The attempt is
            // still counted, because an unconfirmed hand-off is a real attempt and the budget is
            // what eventually raises the visible blocker.
            store.releaseCommand(command.request_id, { delivery_state: 'unknown', attempts: attempt, last_error: error });
          } else {
            store.updateCommand(command.request_id, { delivery_state: 'unknown', last_error: error });
            store.appendEvent(command.work_id, WORK_EVENT_KINDS.instructionDeliveryUnknown, {
              request_id: command.request_id,
              attempt,
              error
            });
            advanced = true;
          }
          const work = store.getWork(command.work_id);
          if (attempt >= maxDeliveryAttempts && work && work.status !== 'cancelled' && work.status !== 'completed' &&
              work.blocker?.code !== WORK_BLOCKER_CODES.instructionDeliveryUnknown) {
            store.setBlocker(work.work_id, {
              code: WORK_BLOCKER_CODES.instructionDeliveryUnknown,
              detail: `An instruction's hand-off could not be confirmed after ${attempt} attempts, so it may or may not have reached the conversation: ${error}. It is still being reconciled against the outbox and will not be sent twice.`,
              at: now()
            }, WORK_EVENT_KINDS.workBlocked);
          }
          reconcileLater = true;
          continue;
        }
        if (attempt >= maxDeliveryAttempts) {
          store.updateCommand(command.request_id, { delivery_state: 'failed', last_error: error });
          store.appendEvent(command.work_id, WORK_EVENT_KINDS.instructionDeliveryFailed, {
            request_id: command.request_id,
            error
          });
          advanced = true;
          const work = store.getWork(command.work_id);
          if (work && work.status !== 'cancelled' && work.status !== 'completed') {
            store.setBlocker(work.work_id, {
              code: WORK_BLOCKER_CODES.instructionDeliveryFailed,
              detail: `An instruction could not be delivered after ${attempt} attempts: ${error}`,
              at: now()
            }, WORK_EVENT_KINDS.workBlocked);
          }
          continue;
        }
        store.updateCommand(command.request_id, { delivery_state: 'pending', last_error: error });
      }
    } finally {
      pumping = false;
    }
    // A wake that arrived during the pass is served immediately: it is a real external fact (a new
    // instruction, or the outbox moving a tracked input row), never this pump's own polling.
    if (!alive()) return;
    if (wakeRequested) {
      wakeRequested = false;
      schedulePump();
      return;
    }
    // An immediate follow-up pass is only honest when this pass actually moved something: a full
    // batch of rows that were consumed (or whose state genuinely changed) means there may be more
    // behind them — a burst of instructions from a phone that was offline, for instance. A batch
    // where every row is merely waiting (`queued`, `unknown`, or nothing attempted at all) makes
    // no progress, and re-running it immediately would spin a full-sync write loop against a work
    // that is simply not ready yet.
    if (reconcileLater) {
      schedulePump(advanced ? 0 : RECONCILE_PUMP_DELAY_MS);
      return;
    }
    if (advanced && examined >= PUMP_BATCH) schedulePump();
  }

  // ---------------------------------------------------------------------------------------
  // Service
  // ---------------------------------------------------------------------------------------

  const service: WorkServiceHandle = {
    async start(input: WorkStart): Promise<WorkReceipt> {
      const parsed = workStartSchema.parse(input);
      // Idempotency is decided from the caller's own payload, before any precondition runs.
      // A replayed request must not depend on the project still existing or the model catalog
      // still offering the same selection: the work was already admitted, and re-admitting it
      // against transient availability would turn a safe retry into MODEL_UNAVAILABLE or a
      // spurious conflict. The canonical path here is pure lexical normalization of what the
      // caller sent; resolving symlinks is an admission precondition, not part of the payload.
      const canonicalProjectPath = path.resolve(parsed.project_path);
      const requestedModel = parsed.model ?? null;
      const requestedReasoning = parsed.reasoning ?? null;
      const requestPayload = {
        kind: 'start',
        project_path: canonicalProjectPath,
        goal: parsed.goal,
        title: parsed.title ?? null,
        model: requestedModel,
        reasoning: requestedReasoning,
        max_workers: parsed.max_workers
      };
      const requestDigest = requestHash('start', requestPayload);

      const replayed = store.getCommand(parsed.request_id);
      if (replayed) {
        if (replayed.input_hash !== requestDigest) conflict(parsed.request_id);
        const receipt = priorReceipt(replayed);
        if (receipt) return receipt;
        return receiptOf(requireWork(replayed.work_id), parsed.request_id);
      }

      const project = await deps.projects.resolve(parsed.project_path);
      if (!project.exists) {
        fail(WORK_ERROR_CODES.projectPathInvalid, `PROJECT_PATH_INVALID: ${project.error ?? 'that project folder does not exist'}. Choose an existing absolute folder.`);
      }
      if (!project.isGit) {
        fail(
          WORK_ERROR_CODES.projectNotGit,
          'PROJECT_NOT_GIT: isolated parallel editing needs a Git project. This folder is not a Git repository, and the app will not initialize one for you.'
        );
      }
      // Model/effort are resolved against what the account actually offers and are never
      // silently downgraded; the *resolved* pair is stored on the work row.
      const selected = await deps.models.resolve({
        ...(parsed.model !== undefined ? { model: parsed.model } : {}),
        ...(parsed.reasoning !== undefined ? { reasoning: parsed.reasoning } : {})
      });

      const workId = randomUUID();
      const primeId = randomUUID();
      const { branch, worktree } = integrationPaths(deps.worktreesRoot, workId);
      const at = now();
      const title = parsed.title ?? preview(parsed.goal.split('\n')[0]?.trim() || 'New work', 200);
      const work: WorkRow = {
        work_id: workId,
        title,
        goal: parsed.goal,
        // The work row keeps the resolved real path (the sandbox and the runtime need it); the
        // idempotency hash above uses the caller's lexical path so a retry cannot be rejected by
        // a symlink resolution that happens to differ.
        project_path: project.path,
        project_name: project.name,
        base_commit: null,
        integration_branch: branch,
        integration_worktree: worktree,
        status: 'queued',
        desired_state: null,
        prime_agent_id: primeId,
        prime_session_id: null,
        model: selected.model,
        reasoning: selected.reasoning,
        max_workers: parsed.max_workers,
        revision: 0,
        blocker: null,
        checkpoint: null,
        integration_intent: null,
        predecessor_work_id: null,
        successor_work_id: null,
        created_at: at,
        updated_at: at
      };

      // Admission is one transaction: the command receipt, the work row, the prime agent row and
      // the first event. A receipt can never be returned for a work that was only half written,
      // and a crash between the steps leaves nothing behind that looks like admitted work.
      //
      // The fast path handles the ordinary retry: the same request id already has a receipt, so
      // it is returned verbatim without touching anything. The transaction handles the race,
      // where two callers with the same id arrive together: the loser rolls its own work row
      // back and returns the winner's receipt.
      const fastPath = store.getCommand(parsed.request_id);
      if (fastPath) {
        if (fastPath.input_hash !== requestDigest) conflict(parsed.request_id);
        const replay = priorReceipt(fastPath);
        if (replay) return replay;
        return receiptOf(requireWork(fastPath.work_id), parsed.request_id);
      }

      let receipt: WorkReceipt;
      try {
        receipt = store.runInTransaction((): WorkReceipt => {
          const raced = store.getCommand(parsed.request_id);
          if (raced) {
            if (raced.input_hash !== requestDigest) throw new AdmissionConflict();
            const replay = priorReceipt(raced);
            return replay ?? receiptOf(requireWork(raced.work_id), parsed.request_id);
          }
        // The work row exists before the command row: `work_commands.work_id` is a real foreign
        // key, so a command can never be durable for a work that is not.
        store.insertWork(work);
        store.insertAgent({
          agent_id: primeId,
          work_id: workId,
          parent_id: null,
          role: 'prime',
          label: 'prime',
          state: 'pending',
          session_id: null,
          conversation_id: null,
          generation: 0,
          worktree_path: worktree,
          branch,
          base_commit: null,
          model: selected.model,
          reasoning: selected.reasoning,
          result_ref: null,
          checkpoint_ref: null,
          created_at: at,
          updated_at: at
        });
        // The deterministic integration assignment is on the agent row before any bootstrap, so
        // a crash right after admission still names the same branch and worktree.
        store.appendEvent(workId, WORK_EVENT_KINDS.workQueued, {
          goal_preview: preview(parsed.goal, WORK_GOAL_PREVIEW_CHARS),
          project_path: project.path,
          max_workers: parsed.max_workers
        });
        const value: WorkReceipt = {
          request_id: parsed.request_id,
          work_id: workId,
          status: 'queued',
          revision: requireWork(workId).revision,
          project_path: project.path,
          integration_branch: branch,
          integration_worktree: worktree
        };
        // The start command's "delivery" is the durable admission receipt itself: it is not an
        // instruction waiting for the browser. Whether the admission *stage* ran is visible on
        // the work row (status plus the prime's session), which is what startup reconciliation
        // reads — never a re-sent input.
        store.insertCommand({
          request_id: parsed.request_id,
          work_id: workId,
          kind: 'start',
          input_hash: requestDigest,
          text: parsed.goal,
          delivery_state: 'delivered',
          outbox_input_id: parsed.request_id,
          result_json: JSON.stringify(value),
          attempts: 0,
          last_error: null,
          created_at: at,
          updated_at: at
        });
        return value;
        });
      } catch (error) {
        if (error instanceof AdmissionConflict) conflict(parsed.request_id);
        throw error;
      }
      void runtime
        .beginStart({
          workId,
          requestId: parsed.request_id,
          projectPath: project.path,
          goal: parsed.goal,
          title,
          model: selected.model,
          reasoning: selected.reasoning,
          maxWorkers: parsed.max_workers,
          integrationBranch: branch,
          integrationWorktree: worktree,
          createdAt: at
        })
        .catch((error: unknown) => markStartFailure(workId, error));

      return receipt;
    },

    async list(input: WorkList): Promise<WorkPage> {
      const parsed = workListSchema.parse(input ?? {});
      const limit = parsed.limit ?? WORK_LIST_DEFAULT_LIMIT;
      const rows = store.listWorks({ limit: limit + 1, cursor: parsed.cursor ?? null });
      const hasMore = rows.length > limit;
      const page = hasMore ? rows.slice(0, limit) : rows;
      const projects = await deps.projects.list().catch(() => [] as WorkProjectOption[]);
      return {
        works: page.map(summaryOf),
        projects,
        next_cursor: hasMore ? (page[page.length - 1]?.work_id ?? null) : null
      };
    },

    async status(input: WorkStatusRequest): Promise<WorkStatus> {
      const parsed = workStatusRequestSchema.parse(input);
      const work = requireWork(parsed.work_id);
      const agents = store.listAgents(work.work_id).map(agentSummary);
      const primeId = work.prime_agent_id ?? agents.find(agent => agent.role === 'prime')?.agent_id ?? null;
      const prime = agents.find(agent => agent.agent_id === primeId) ?? null;
      const operations = store.listOperations(work.work_id, MAX_STATUS_OPERATIONS).map(operationSummary);
      const commands = store.listPendingCommands(work.work_id, MAX_STATUS_COMMANDS).map(command => ({
        request_id: command.request_id,
        kind: command.kind,
        text_preview: command.text === null ? null : preview(command.text, WORK_INSTRUCTION_PREVIEW_CHARS),
        delivery_state: command.delivery_state,
        attempts: command.attempts,
        created_at: command.created_at
      }));
      return boundStatus({
        work_id: work.work_id,
        title: work.title,
        goal: truncate(work.goal, MAX_STATUS_GOAL_CHARS),
        status: work.status,
        desired_state: work.desired_state,
        project_path: work.project_path,
        project_name: work.project_name,
        integration_branch: work.integration_branch,
        integration_worktree: work.integration_worktree,
        base_commit: work.base_commit,
        model: work.model,
        reasoning: work.reasoning,
        max_workers: work.max_workers,
        revision: work.revision,
        prime,
        agents,
        predecessor_work_id: work.predecessor_work_id,
        successor_work_id: work.successor_work_id,
        blocker: work.blocker,
        checkpoint: work.checkpoint,
        recovery: prime ? prime.recovery : agents.find(agent => agent.recovery !== null)?.recovery ?? null,
        operations,
        pending_commands: commands,
        created_at: work.created_at,
        updated_at: work.updated_at
      });
    },

    async instruct(input: WorkInstruction): Promise<WorkReceipt> {
      const parsed = workInstructionSchema.parse(input);
      const requested = requireWork(parsed.work_id);
      if (isFenced(requested)) {
        fail(WORK_ERROR_CODES.workAlreadyCancelled, 'WORK_ALREADY_CANCELLED: this work was cancelled. Its descendants and pending inputs are terminal; start a new work instead.');
      }
      // The hash is computed from the caller's own work id, never from the routed one: routing is
      // a consequence of state, and a replay must hash identically even if the chain grew.
      const payload = {
        kind: 'instruct',
        work_id: parsed.work_id,
        text: parsed.text,
        resolve_operations: parsed.resolve_operations ?? null
      };
      const hash = requestHash('instruct', payload);

      const existing = store.getCommand(parsed.request_id);
      if (existing) {
        if (existing.input_hash !== hash) conflict(parsed.request_id);
        return priorReceipt(existing) ?? receiptOf(requireWork(existing.work_id), parsed.request_id);
      }

      // Everything below is one transaction, and it re-reads the chain inside it: two
      // instructions that arrive together on one completed work must produce exactly one
      // successor, and the loser must see the winner's link rather than create a second one.
      const outcome = store.runInTransaction((): { receipt: WorkReceipt; started: WorkRuntimeStart | null } => {
        const raced = store.getCommand(parsed.request_id);
        if (raced) {
          if (raced.input_hash !== hash) throw new AdmissionConflict();
          return { receipt: priorReceipt(raced) ?? receiptOf(requireWork(raced.work_id), parsed.request_id), started: null };
        }
        const work = requireWork(parsed.work_id);
        if (isFenced(work)) {
          fail(WORK_ERROR_CODES.workAlreadyCancelled, 'WORK_ALREADY_CANCELLED: this work was cancelled. Its descendants and pending inputs are terminal; start a new work instead.');
        }
        // Follow the recorded chain to its active end. This is not a guess about "the latest
        // work": only an explicit successor link is followed, and only from a completed row.
        const active = activeEnd(work);
        // A cancelled tail is terminal wherever it sits in the chain: the user stopped that
        // continuation, so continuing it again is an explicit new start, never a silent revival.
        if (isFenced(active)) {
          fail(WORK_ERROR_CODES.workAlreadyCancelled, `WORK_ALREADY_CANCELLED: work ${active.work_id}, which continues ${work.work_id}, was cancelled. Cancellation is terminal; start a new work instead.`);
        }
        const target = active.status === 'completed' ? createSuccessor(active, parsed.request_id, parsed.text) : null;
        const routed = target?.row ?? active;
        const started = target?.start ?? null;

        // Resolutions belong to the chain being instructed: an operation on the work the caller
        // named, or on the active work that continues it. Anything else is still cross-work.
        const chainIds = new Set([work.work_id, routed.work_id]);
        for (const resolution of parsed.resolve_operations ?? []) {
          const operation = store.getOperation(resolution.operation_id);
          if (!operation) {
            fail(WORK_ERROR_CODES.operationNotFound, `OPERATION_NOT_FOUND: ${resolution.operation_id} is not in the durable ledger.`);
          }
          if (!chainIds.has(operation.work_id)) {
            fail(WORK_ERROR_CODES.operationResolutionConflict, 'OPERATION_RESOLUTION_CONFLICT: that operation belongs to another work. Resolutions are rejected rather than applied across works.');
          }
          if (operation.state !== 'outcome_unknown') {
            fail(WORK_ERROR_CODES.operationResolutionConflict, 'OPERATION_RESOLUTION_CONFLICT: that operation already has a settled outcome; nothing was recorded.');
          }
          if (operation.resolution) {
            fail(WORK_ERROR_CODES.operationResolutionConflict, 'OPERATION_RESOLUTION_CONFLICT: that operation was already resolved. Decide on its current state instead.');
          }
          const retryOperationId = resolution.decision === 'authorize_retry' ? randomUUID() : null;
          store.updateOperation(operation.operation_id, {
            resolution: {
              decision: resolution.decision,
              note: resolution.note.slice(0, 2000),
              at: now(),
              by_command: parsed.request_id
            },
            retry_operation_id: retryOperationId
          });
          store.appendEvent(operation.work_id, 'operation_resolved', {
            operation_id: operation.operation_id,
            decision: resolution.decision,
            retry_operation_id: retryOperationId,
            by_command: parsed.request_id
          });
        }
        if (parsed.resolve_operations?.length &&
            requireWork(routed.work_id).blocker?.code === WORK_BLOCKER_CODES.operationOutcomeUnknown &&
            !store.hasUnresolvedOperations(routed.work_id)) {
          store.setBlocker(routed.work_id, null, 'operation_resolved');
        }
        const at = now();
        store.insertCommand({
          request_id: parsed.request_id,
          work_id: routed.work_id,
          kind: 'instruct',
          input_hash: hash,
          text: parsed.text,
          delivery_state: 'pending',
          // The instruction and the successor's opening message are one message: when this
          // instruction created the successor, its own text is already the successor's opening
          // goal, so both rows name the same outbox input. The instruction keeps its request_id as
          // its durable identity; only the outbox input id is shared, and the runtime refuses to
          // send a linked instruction until the opening row for that id exists.
          outbox_input_id: target?.outboxInputId ?? parsed.request_id,
          result_json: null,
          attempts: 0,
          last_error: null,
          created_at: at,
          updated_at: at
        });
        store.appendEvent(routed.work_id, WORK_EVENT_KINDS.instructionQueued, {
          request_id: parsed.request_id,
          text_preview: preview(parsed.text, WORK_INSTRUCTION_PREVIEW_CHARS),
          ...(work.work_id !== routed.work_id ? { requested_work_id: work.work_id } : {})
        });
        const value = receiptOf(requireWork(routed.work_id), parsed.request_id);
        store.updateCommand(parsed.request_id, { result_json: JSON.stringify(value) });
        return { receipt: value, started };
      });

      // The successor's admission runs after the commit, exactly like `start`: the caller already
      // holds a durable receipt, and a missing login or browser becomes a retained blocker on an
      // admitted work rather than a lost instruction.
      if (outcome.started) {
        const started = outcome.started;
        void runtime.beginStart(started).catch((error: unknown) => markStartFailure(started.workId, error));
      }
      schedulePump();
      return outcome.receipt;
    },

    async control(input: WorkControl): Promise<WorkReceipt> {
      const parsed = workControlSchema.parse(input);
      const work = requireWork(parsed.work_id);
      const payload = { kind: 'control', work_id: work.work_id, action: parsed.action };
      const hash = requestHash('control', payload);

      if (parsed.action === 'pause' || parsed.action === 'cancel') {
        if (work.status === 'completed') {
          fail(WORK_ERROR_CODES.workAlreadyCompleted, 'WORK_ALREADY_COMPLETED: this work already completed. Its terminal state was not changed.');
        }
        if (parsed.action === 'pause' && (work.status === 'cancelled' || work.desired_state === 'cancelled')) {
          fail(WORK_ERROR_CODES.workAlreadyCancelled, 'WORK_ALREADY_CANCELLED: this work was cancelled or is being cancelled. Pause cannot reopen it.');
        }
        // Repeating the same control is idempotent: the second call returns the receipt of the
        // first transition instead of fencing or draining twice.
        const desired: WorkDesiredState = parsed.action === 'pause' ? 'paused' : 'cancelled';
        const alreadyFenced = work.desired_state === desired ||
          (parsed.action === 'cancel' && work.status === 'cancelled') ||
          (parsed.action === 'pause' && work.status === 'paused' && work.desired_state === null);
        if (alreadyFenced) {
          const claimed = claimCommand({
            requestId: parsed.request_id,
            workId: work.work_id,
            kind: 'control',
            hash,
            text: null
          });
          if ('conflict' in claimed) conflict(parsed.request_id);
          if (claimed.replay) return claimed.replay;
          const receipt = receiptOf(requireWork(work.work_id), parsed.request_id);
          recordReceipt(parsed.request_id, receipt);
          return receipt;
        }
        try {
          return await drain(work, parsed.request_id, parsed.action, hash);
        } catch (error) {
          if (error instanceof AdmissionConflict) conflict(parsed.request_id);
          throw error;
        }
      }

      // resume
      if (work.status === 'cancelled' || work.desired_state === 'cancelled') {
        fail(WORK_ERROR_CODES.workNotResumable, 'WORK_NOT_RESUMABLE: this work was cancelled. Cancellation is terminal; start a new work instead.');
      }
      if (work.status === 'completed') {
        fail(WORK_ERROR_CODES.workNotResumable, 'WORK_NOT_RESUMABLE: this work already completed. Nothing is left to resume.');
      }
      if (store.hasUnresolvedOperations(work.work_id)) {
        fail(
          WORK_ERROR_CODES.operationUnknownUnresolved,
          'OPERATION_UNKNOWN_UNRESOLVED: a command may already have taken effect and its result was never recorded. Send an instruction with resolve_operations for each unknown operation; a bare resume is refused so nothing is repeated blindly.'
        );
      }
      // Older hosts could persist a decision without clearing its recovery blocker.
      if (work.blocker?.code === WORK_BLOCKER_CODES.operationOutcomeUnknown)
        store.setBlocker(work.work_id, null, 'operation_resolved');
      const claimed = claimCommand({
        requestId: parsed.request_id,
        workId: work.work_id,
        kind: 'control',
        hash,
        text: null
      });
      if ('conflict' in claimed) conflict(parsed.request_id);
      if (claimed.replay) return claimed.replay;

      let result: WorkRuntimeControlResult;
      try {
        result = await runtime.control({
          workId: work.work_id,
          action: 'resume',
          commandId: parsed.request_id,
          grantRecoveryEpisode: work.blocker?.code === WORK_BLOCKER_CODES.recoveryExhausted
        });
      } catch (error) {
        const detail = workErrorPayload(error);
        store.setBlocker(work.work_id, { code: WORK_BLOCKER_CODES.resumeFailed, detail: detail.message, at: now() }, 'work_blocked');
        fail(WORK_ERROR_CODES.internalError, `RESUME_FAILED: ${detail.message}`);
      }
      store.setDesiredState(work.work_id, null, 'work_updated');
      const next = store.setWorkStatus(work.work_id, result.status, 'work_resumed');
      if (result.blocker) {
        store.setBlocker(work.work_id, { code: result.blocker.code, detail: result.blocker.detail, at: now() }, 'work_blocked');
      } else if (result.status !== 'blocked') {
        store.setBlocker(work.work_id, null, 'work_unblocked');
      }
      const receipt = receiptOf(requireWork(next.work_id), parsed.request_id);
      recordReceipt(parsed.request_id, receipt);
      schedulePump();
      return receipt;
    },

    async events(input: WorkEventsRequest): Promise<WorkEventPage> {
      const parsed = workEventsRequestSchema.parse(input);
      requireWork(parsed.work_id);
      const limit = parsed.limit ?? WORK_EVENTS_DEFAULT_LIMIT;
      const after = parsed.after ?? 0;
      const { events, hasMore } = store.readEvents({ workId: parsed.work_id, after, limit });
      const mapped: WorkEvent[] = events.map(event => ({
        work_id: event.work_id,
        sequence: event.sequence,
        kind: event.kind,
        payload: event.payload,
        at: event.at
      }));
      return {
        events: mapped,
        next_cursor: mapped.length ? mapped[mapped.length - 1]!.sequence : after,
        has_more: hasMore
      };
    },

    async reconcile(): Promise<void> {
      // A command left `delivering` by a crash is retryable under the same outbox input id;
      // the stable id is what makes the retry safe, so this is a reset rather than a replay.
      // Start commands are excluded: their delivery state is the admission stage's outcome,
      // which the runtime reconciles from `unfinishedWorks`, not by re-sending an input.
      const stuck = store.listStuckDeliveringCommands(PUMP_BATCH * 4);
      for (const command of stuck) store.updateCommand(command.request_id, { delivery_state: 'pending' });
      const openOperations = store.listOpenOperations();
      const pendingCommands = store.listUnfinishedCommands(PUMP_BATCH * 4);
      const works = store.listWorks({ limit: WORK_LIST_MAX_LIMIT });
      const unfinishedWorks = works.filter(work => work.status !== 'completed' && work.status !== 'cancelled');
      await runtime.reconcile({ openOperations, pendingCommands, unfinishedWorks });
      // A persisted desired state means the drain never settled: the fence committed but the
      // process died before the transition finished. Finish it now rather than leaving a work
      // that refuses mutations forever with no visible reason.
      for (const work of works) {
        if (!work.desired_state || work.status === 'completed' || work.status === 'cancelled') continue;
        try {
          const result = await runtime.control({
            workId: work.work_id,
            action: work.desired_state === 'cancelled' ? 'cancel' : 'pause',
            commandId: `reconcile:${work.work_id}`,
            grantRecoveryEpisode: false
          });
          store.runInTransaction(() => {
            store.setDesiredState(work.work_id, null, 'work_updated');
            store.setWorkStatus(work.work_id, result.status, work.desired_state === 'cancelled' ? 'work_cancelled' : 'work_paused');
            if (result.blocker) {
              store.setBlocker(work.work_id, { code: result.blocker.code, detail: result.blocker.detail, at: now() }, 'work_blocked');
            }
          });
        } catch (error) {
          const detail = workErrorPayload(error);
          store.setBlocker(work.work_id, {
            code: WORK_BLOCKER_CODES.drainFailed,
            detail: `The ${work.desired_state === 'cancelled' ? 'cancel' : 'pause'} that was in progress at the last shutdown could not finish: ${detail.message}`,
            at: now()
          }, 'work_blocked');
        }
      }
      schedulePump();
    },

    async pumpNow(): Promise<void> {
      await pump();
    },

    close(): void {
      closed = true;
    }
  };

  /**
   * Pause and cancel share one shape: commit the fence and the desired state first, then drain
   * asynchronously through the runtime, and only then move the factual status. Interfaces keep
   * showing the true status plus `desired_state` while the drain is pending.
   */
  async function drain(work: WorkRow, requestId: string, action: 'pause' | 'cancel', hash: string): Promise<WorkReceipt> {
    const desired = action === 'pause' ? 'paused' : 'cancelled';
    // The command receipt, the fence, the desired state and the cancellation of pending inputs
    // are one commit. A half-applied fence would either admit a mutation after the user paused,
    // or leave an instruction queued for a cancelled work — and a retry would then see a
    // command row that never drained.
    const fenced = store.runInTransaction((): WorkReceipt => {
      const raced = store.getCommand(requestId);
      if (raced) {
        if (raced.input_hash !== hash) throw new AdmissionConflict();
        return priorReceipt(raced) ?? receiptOf(requireWork(work.work_id), requestId);
      }
      const at = now();
      store.insertCommand({
        request_id: requestId,
        work_id: work.work_id,
        kind: 'control',
        input_hash: hash,
        text: null,
        delivery_state: 'delivered',
        outbox_input_id: requestId,
        result_json: null,
        attempts: 0,
        last_error: null,
        created_at: at,
        updated_at: at
      });
      store.appendEvent(work.work_id, action === 'pause' ? 'work_pause_requested' : 'work_cancel_requested', {
        request_id: requestId
      });
      store.setDesiredState(work.work_id, desired, 'work_desired_state');
      if (action === 'cancel') {
        // Only rows that provably never left the host are terminalized: `pending` with
        // `attempts = 0`. A `delivering` row may already have authorized the native Send when the
        // process died, an attempted `pending` row was reset after a send that may have landed,
        // and `queued`/`unknown` rows are held or ambiguous by definition. Cancelling the work
        // stops new work; it must not erase the receipt that can still tell the truth about a
        // message that reached the conversation. Those rows stay for the runtime's stop path to
        // reconcile against the durable native receipt, and a late acknowledgement may still
        // deliver them without reopening the work.
        store.cancelUnsentCommands(work.work_id);
      }
      return receiptOf(requireWork(work.work_id), requestId);
    });
    // The fence receipt is durable with the fence itself, so a retried control returns the
    // same transition instead of draining a second time.
    recordReceipt(requestId, fenced);
    let result: WorkRuntimeControlResult;
    try {
      result = await runtime.control({
        workId: work.work_id,
        action,
        commandId: requestId,
        grantRecoveryEpisode: false
      });
    } catch (error) {
      const detail = workErrorPayload(error);
      // The fence stays committed: a failed drain must not silently re-admit mutations.
      store.setBlocker(work.work_id, {
        code: WORK_BLOCKER_CODES.drainFailed,
        detail: `${action === 'pause' ? 'Pause' : 'Cancel'} could not finish draining: ${detail.message}`,
        at: now()
      }, 'work_blocked');
      const receipt = receiptOf(requireWork(work.work_id), requestId);
      recordReceipt(requestId, receipt);
      return receipt;
    }
    store.runInTransaction(() => {
      store.setDesiredState(work.work_id, null, 'work_updated');
      store.setWorkStatus(work.work_id, result.status, action === 'pause' ? 'work_paused' : 'work_cancelled');
      if (result.blocker) {
        store.setBlocker(work.work_id, { code: result.blocker.code, detail: result.blocker.detail, at: now() }, 'work_blocked');
      } else if (action === 'cancel' || result.status !== 'blocked') {
        store.setBlocker(work.work_id, null, 'work_unblocked');
      }
    });
    void fenced;
    const receipt = receiptOf(requireWork(work.work_id), requestId);
    recordReceipt(requestId, receipt);
    return receipt;
  }

  return service;
}

// -----------------------------------------------------------------------------------------
// Host accessor
// -----------------------------------------------------------------------------------------

let current: WorkServiceHandle | null = null;
const serviceListeners = new Set<(service: WorkServiceHandle | null) => void>();
const changeListeners = new Set<(change: WorkChange) => void>();

/**
 * Installs the live service. The host calls this once after storage restoration and before any
 * admission; passing `null` on shutdown makes every adapter fail closed with `HOST_UNAVAILABLE`
 * instead of holding a stale handle to a closed database.
 */
export function setWorkService(service: WorkServiceHandle | null): void {
  current = service;
  for (const listener of serviceListeners) {
    try {
      listener(service);
    } catch {
      /* A broken listener must not break the host. */
    }
  }
}

export function getWorkServiceOrNull(): WorkServiceHandle | null {
  return current;
}

/** Throws a typed error so an adapter can report "host unavailable" instead of crashing. */
export function getWorkService(): WorkServiceHandle {
  if (!current) {
    throw new WorkServiceError(
      WORK_ERROR_CODES.hostUnavailable,
      'HOST_UNAVAILABLE: the host has not started its work ledger yet. Start the app (or run `wgpt host start`) and try again.'
    );
  }
  return current;
}

export function onWorkServiceChange(listener: (service: WorkServiceHandle | null) => void): () => void {
  serviceListeners.add(listener);
  return () => {
    serviceListeners.delete(listener);
  };
}

/**
 * Fires on every committed work change — revision, status, event. The GUI turns this into its
 * `work:changed` push; nothing else polls.
 */
export function subscribeWorkChanges(listener: (change: WorkChange) => void): () => void {
  changeListeners.add(listener);
  return () => {
    changeListeners.delete(listener);
  };
}

/** Bridges a store's change stream into the process-wide subscription. */
export function attachWorkChanges(store: WorkStore): () => void {
  const detach = store.onChanged(change => {
    for (const listener of changeListeners) {
      try {
        listener(change);
      } catch {
        /* See above. */
      }
    }
  });
  return detach;
}
