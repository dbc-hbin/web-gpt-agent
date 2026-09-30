import { DatabaseSync } from 'node:sqlite';
import { chmodSync, existsSync, mkdirSync, statSync } from 'node:fs';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import {
  WORK_ERROR_CODES,
  WORK_EVENT_KINDS,
  WorkServiceError,
  type WorkBlocker,
  type WorkCheckpoint,
  type WorkDeliveryState,
  type WorkDesiredState,
  type WorkOperationDecision,
  type WorkState,
  type WorkAgentRole
} from '../../shared/work.js';
import type {
  WorkControllerBinding,
  WorkControllerDelivery,
  WorkControllerMessage
} from '../../shared/work-continuity.js';

/**
 * The durable work ledger: one SQLite file under the app's data directory, opened only by the
 * host.
 *
 * Every method here is synchronous, because `node:sqlite` is. That is not a shortcut: a work
 * receipt must be durable before it is returned, and the whole point of the ledger is that a
 * caller never has to remember an in-memory queue. Synchronous writes also make the
 * transaction boundaries below obvious, which matters when the same database is being read by
 * the status path while a mutation commits.
 *
 * What lives here and what does not:
 *
 * - Here: identity, lifecycle, revisions, events, command receipts, mutation receipts,
 *   worktree assignments, integration intents, recovery records and artifact metadata.
 * - Not here: conversation transcripts, message bodies, tool output text. Those stay in the
 *   existing session store; this file only ever holds their IDs.
 *
 * Corruption is never silently repaired. If the file is not a database, if the schema does not
 * match what this build writes, or if a migration fails, the store refuses to open with
 * `STATE_UNAVAILABLE` and the host must not execute mutations. An empty new task is exactly
 * what a damaged ledger must never look like.
 */

/** Bumped whenever a migration below changes the on-disk shape. */
const SCHEMA_VERSION = 6;

/** Bound on how many recovery records a single agent keeps, newest generation last. */
const RECOVERY_HISTORY = 8;

/** Event payloads are small typed facts; anything larger is truncated with a marker. */
const MAX_EVENT_PAYLOAD_BYTES = 8 * 1024;

export interface WorkRow {
  work_id: string;
  title: string;
  goal: string;
  project_path: string;
  project_name: string | null;
  base_commit: string | null;
  integration_branch: string | null;
  integration_worktree: string | null;
  status: WorkState;
  /** Committed intent while pause/cancel drains; the factual `status` stays true. */
  desired_state: WorkDesiredState | null;
  prime_agent_id: string | null;
  prime_session_id: string | null;
  model: string | null;
  reasoning: string | null;
  max_workers: number;
  revision: number;
  blocker: WorkBlocker | null;
  checkpoint: WorkCheckpoint | null;
  integration_intent: IntegrationIntentRecord | null;
  /**
   * Durable continuation chain. `predecessor_work_id` is the work this one continues and
   * `successor_work_id` the work that continues it; a completed row keeps its goal and status
   * untouched — the link is the only thing a continuation adds to it.
   */
  predecessor_work_id: string | null;
  successor_work_id: string | null;
  created_at: number;
  updated_at: number;
}

export interface WorkAgentRow {
  agent_id: string;
  work_id: string;
  parent_id: string | null;
  role: WorkAgentRole;
  label: string;
  /** Open machine-readable lifecycle; the runtime owns the vocabulary. */
  state: string;
  session_id: string | null;
  conversation_id: string | null;
  /** Monotonic per binding. A replacement conversation is a new generation. */
  generation: number;
  worktree_path: string | null;
  branch: string | null;
  base_commit: string | null;
  model: string | null;
  reasoning: string | null;
  result_ref: string | null;
  checkpoint_ref: string | null;
  created_at: number;
  updated_at: number;
}

export interface WorkOperationRow {
  operation_id: string;
  work_id: string;
  agent_id: string;
  generation: number;
  tool: string;
  args_hash: string;
  state: 'prepared' | 'running' | 'completed' | 'failed' | 'outcome_unknown';
  process_id: string | null;
  result_ref: string | null;
  result_json: string | null;
  session_id: string | null;
  expect_before: Record<string, string | null> | null;
  expect_after: Record<string, string | null> | null;
  retry_of: string | null;
  retry_operation_id: string | null;
  resolution: WorkOperationResolutionRecord | null;
  created_at: number;
  updated_at: number;
}

export interface WorkOperationResolutionRecord {
  decision: WorkOperationDecision;
  note: string;
  at: number;
  by_command: string;
}

export interface WorkCommandRow {
  request_id: string;
  work_id: string;
  kind: 'start' | 'instruct' | 'control';
  input_hash: string;
  text: string | null;
  delivery_state: WorkDeliveryState;
  /** Stable outbox input id; equals `request_id` so a retry cannot duplicate a send. */
  outbox_input_id: string;
  result_json: string | null;
  attempts: number;
  last_error: string | null;
  created_at: number;
  updated_at: number;
}

export interface WorkEventRow {
  work_id: string;
  sequence: number;
  kind: string;
  payload: Record<string, unknown>;
  at: number;
}

export interface WorkArtifactRow {
  artifact_id: string;
  work_id: string;
  agent_id: string | null;
  session_id: string;
  asset_id: string;
  kind: string;
  query_hash: string | null;
  page_index: number;
  page_count: number;
  hit_count: number;
  total_hits: number;
  truncated_reason: string | null;
  byte_size: number;
  created_at: number;
}

export interface WorkCheckpointRecord {
  revision: number;
  summary: string;
  remaining: string[];
  verification: Array<{ operation_id: string; outcome: 'passed' | 'failed' }>;
  host_generated: boolean;
  updated_at: number;
}

export interface WorktreeAssignmentRecord {
  workId: string;
  agentId: string;
  role: WorkAgentRole;
  branch: string;
  path: string;
  baseCommit: string;
  createdAt: number;
}

export type IntegrationIntentStatus = 'running' | 'merged' | 'conflict' | 'aborted' | 'unknown';

export interface IntegrationIntentRecord {
  workId: string;
  operationId: string;
  workerId: string;
  workerCommit: string;
  mainBefore: string;
  status: IntegrationIntentStatus;
  conflictFiles: string[];
  mainCommit: string | null;
  runId?: string;
  startedAt: number;
  updatedAt: number;
}

export interface WorkChange {
  work_id: string;
  revision: number;
  status: WorkState;
  kind: string;
}

/** The agent/work projection the mutation ledger fences against before executing anything. */
export interface WorkAdmissionContext {
  work_id: string;
  work_status: string;
  agent_id: string;
  agent_generation: number;
  agent_state: string;
}

export interface WorkOperationPatch {
  state?: WorkOperationRow['state'];
  process_id?: string | null;
  result_ref?: string | null;
  result_json?: string | null;
  session_id?: string | null;
  expect_before?: Record<string, string | null> | null;
  expect_after?: Record<string, string | null> | null;
  retry_of?: string | null;
  retry_operation_id?: string | null;
  resolution?: WorkOperationResolutionRecord | null;
  updated_at?: number;
}

export interface WorkAgentPatch {
  parent_id?: string | null;
  role?: WorkAgentRole;
  label?: string;
  state?: string;
  session_id?: string | null;
  conversation_id?: string | null;
  generation?: number;
  worktree_path?: string | null;
  branch?: string | null;
  base_commit?: string | null;
  model?: string | null;
  reasoning?: string | null;
  result_ref?: string | null;
  checkpoint_ref?: string | null;
}

export interface WorkPatch {
  title?: string;
  status?: WorkState;
  desired_state?: WorkDesiredState | null;
  base_commit?: string | null;
  integration_branch?: string | null;
  integration_worktree?: string | null;
  prime_agent_id?: string | null;
  prime_session_id?: string | null;
  model?: string | null;
  reasoning?: string | null;
  project_name?: string | null;
  predecessor_work_id?: string | null;
  successor_work_id?: string | null;
}

/** Inbox mutation. `state` is the only thing the host moves; the payload is immutable. */
export interface WorkControllerMessagePatch {
  state?: WorkControllerMessage['state'];
  work_id?: string | null;
  error?: string | null;
  /**
   * The frozen dispatch, written once at admission.
   *
   * A patch may set it on a row that does not have one yet, and may never change one that does:
   * the frozen bytes are what the service hashed, so overwriting them would make a replay look
   * like a different command.
   */
  dispatch_text?: string | null;
  context_assistant_id?: string | null;
  /**
   * The durable request id of the admission that owns this row.
   *
   * Writable only while the row is *unclaimed*: an observation records a placeholder id derived from
   * the message identity, and the native application's own public UUID must be able to take that
   * placeholder's place, because that UUID is what the caller's own tool call will be replayed
   * under. Once anything has claimed the row (a work id, a frozen dispatch, or a state other than
   * pending) the id is the admission's identity and is never rewritten.
   */
  request_id?: string;
  /**
   * The in-flight native claim on this row, written when a controller tool call takes the message
   * and cleared by that call's own completion or release.
   *
   * It is deliberately separate from `work_id`: `work_id` is the *destination* the claim names,
   * while this is the fact that a call is still running. A released claim restores `work_id` to
   * null but must also clear this, or the relay would refuse a message nobody is handling.
   */
  claimed_at?: number | null;
}

/**
 * A position in the pending inbox, for walking it without skipping rows.
 *
 * The inbox is ordered by `created_at`, then by identity, and a page is taken strictly *after* this
 * position. That is what makes the walk complete: a head-of-list page whose rows all happen to be
 * kept (on-branch, or not yet admitted) cannot hide the row behind them, because the next page
 * starts after the last row read rather than at the same head again.
 */
export interface ControllerInboxCursor {
  created_at: number;
  session_id: string;
  message_id: string;
}

/** Delivery mutation: the relay records what the original conversation actually took. */
export interface WorkControllerDeliveryPatch {
  state?: WorkControllerDelivery['state'];
  error?: string | null;
  event_sequence?: number;
  text?: string;
}

/**
 * A binding write.
 *
 * `provider_account_id` is optional here even though the stored row always has it: an omitted
 * value means "leave the anchored account alone", which is what a re-assertion from a page that
 * cannot see the account must do. `null` is the explicit "no authenticated snapshot yet".
 */
export interface WorkControllerBindingInput extends Omit<WorkControllerBinding, 'provider_account_id' | 'origin'> {
  provider_account_id?: string | null;
  /**
   * The binding's creation kind. Omitted means "leave an existing row's own origin alone", which is
   * the conservative read: only a caller that is creating the automatic prime fallback says so.
   */
  origin?: WorkControllerBinding['origin'];
}

export interface WorkStoreOptions {
  /** Directory that holds `work.sqlite`. Created 0700 when missing. */
  dataDir: string;
  now?: () => number;
  /** Overrides the file name; tests use a scratch file per case. */
  fileName?: string;
}

export interface WorkStore {
  readonly file: string;
  close(): void;
  /** True once `close()` ran; async continuations must stop touching the ledger. */
  isClosed(): boolean;
  onChanged(listener: (change: WorkChange) => void): () => void;
  /**
   * Runs `run` in one SQLite transaction. Nested calls become savepoints, so a caller can wrap
   * several store mutations — admission, for instance — and have them commit or roll back
   * together rather than as a sequence of separately durable steps.
   */
  runInTransaction<T>(run: () => T): T;

  // works
  getWork(workId: string): WorkRow | null;
  listWorks(input: { limit: number; cursor?: string | null }): WorkRow[];
  countWorks(): number;
  insertWork(row: WorkRow): void;
  updateWork(workId: string, patch: WorkPatch): WorkRow;
  setWorkStatus(workId: string, status: WorkState, kind: string): WorkRow;
  setDesiredState(workId: string, desired: WorkDesiredState | null, kind: string): WorkRow;
  setBlocker(workId: string, blocker: WorkBlocker | null, kind: string): WorkRow;
  setCheckpoint(workId: string, checkpoint: WorkCheckpointRecord | null): WorkRow;
  setIntegrationIntent(workId: string, intent: IntegrationIntentRecord | null): WorkRow;
  touchWork(workId: string, kind: string): WorkRow;
  /**
   * Writes both ends of the continuation link in one transaction and appends `work_continued` to
   * each row. The predecessor's status and goal are never touched: a completed work stays
   * completed, and the link is the only thing a continuation adds to it.
   */
  linkContinuation(predecessorId: string, successorId: string): WorkRow;

  // agents
  getAgent(agentId: string): WorkAgentRow | null;
  getAgentByConversation(conversationId: string): WorkAgentRow | null;
  getAgentBySession(sessionId: string): WorkAgentRow | null;
  listAgents(workId: string): WorkAgentRow[];
  countAgents(workId: string): number;
  getPrimeAgent(workId: string): WorkAgentRow | null;
  insertAgent(row: WorkAgentRow): void;
  releaseAgentReservation(input: { agentId: string; workId: string; parentId: string; createdAt: number }): boolean;
  updateAgent(agentId: string, patch: WorkAgentPatch): WorkAgentRow;
  bindAgentConversation(input: { agentId: string; sessionId: string; conversationId: string; generation?: number }): WorkAgentRow;
  advanceAgentGeneration(input: { workId: string; agentId: string }): number;
  fenceAgentGeneration(input: { workId: string; agentId: string; generation: number }): void;
  assignWorktree(record: WorktreeAssignmentRecord): WorkAgentRow;
  getWorktreeAssignment(workId: string, agentId: string): WorktreeAssignmentRecord | null;
  listWorktreeAssignments(workId: string): WorktreeAssignmentRecord[];
  getIntegrationIntent(workId: string): IntegrationIntentRecord | null;
  clearIntegrationIntent(workId: string): void;

  // operations (the mutation-receipt port)
  getOperation(operationId: string): WorkOperationRow | null;
  insertOperation(row: WorkOperationRow): void;
  updateOperation(operationId: string, patch: WorkOperationPatch): void;
  listOpenOperations(workId?: string): WorkOperationRow[];
  listOperations(workId: string, limit: number): WorkOperationRow[];
  listOperationsForAgent(agentId: string, generation: number): WorkOperationRow[];
  hasUnresolvedOperations(workId: string): boolean;
  countActiveOperations(agentId: string, generation: number): number;
  admissionContext(agentId: string): WorkAdmissionContext | null;

  // commands
  getCommand(requestId: string): WorkCommandRow | null;
  insertCommand(row: WorkCommandRow): void;
  /**
   * Marks a command as mid-attempt, silently.
   *
   * The marker exists for crash recovery only: a process that dies between this write and the
   * outcome leaves a `delivering` row that the next boot re-arms under the same outbox input id.
   * No attempt has produced an outcome yet, so it is not a consumer-visible fact and deliberately
   * moves neither the work's revision nor the event log.
   */
  leaseCommand(requestId: string, attempt: number): void;
  /**
   * Puts a leased command back exactly where it was, silently.
   *
   * Used when an attempt produced no outcome at all — a `deferred` delivery, or a poll that found
   * the same fact again. The row must not stay leased, but nothing happened that a reader should
   * be told about: no revision, no event. A real transition is written with `updateCommand`
   * instead, which is what notifies readers.
   */
  releaseCommand(requestId: string, restore: Pick<WorkCommandRow, 'delivery_state' | 'attempts' | 'last_error'>): WorkCommandRow;
  /**
   * Moves never-leased rows to the back of the pump's rotation in one silent commit.
   *
   * The same effect a `releaseCommand` of a deferred attempt has on `updated_at`, for rows the pump
   * held without attempting because their work already answered `deferred` for the whole work. No
   * state, attempt, revision or event changes.
   */
  rotateCommands(requestIds: readonly string[]): void;
  /**
   * Records a real delivery transition. A patch that would leave every column unchanged is a
   * no-op: it writes nothing, bumps no revision and appends no event.
   */
  updateCommand(requestId: string, patch: Partial<Pick<WorkCommandRow, 'delivery_state' | 'attempts' | 'last_error' | 'result_json'>>): WorkCommandRow;
  listCommands(workId: string, limit: number): WorkCommandRow[];
  listPendingCommands(workId: string, limit: number): WorkCommandRow[];
  /** Never-attempted instructions, oldest first. Always considered before retained ones. */
  listDeliverableFreshCommands(limit: number): WorkCommandRow[];
  /** Instructions still waiting for an acknowledgement or resolution, oldest activity first. */
  listDeliverableRetainedCommands(limit: number): WorkCommandRow[];
  /** Commands left mid-delivery by a crash, which the next boot re-arms under the same id. */
  listStuckDeliveringCommands(limit: number): WorkCommandRow[];
  /** True while any command of this work is in `unknown`: its send may or may not have landed. */
  hasUnacknowledgedDelivery(workId: string): boolean;
  /**
   * Whether this work still has an instruction that has not reached its conversation.
   *
   * Scoped to the work in SQL, before any limit: a caller asking about one work must never get an
   * answer computed from a global page of other works' commands.
   */
  hasOutstandingInstruction(workId: string): boolean;
  /**
   * Terminalizes the commands of one work that provably never left the host.
   *
   * "Provably" is narrow on purpose: the delivery pump increments `attempts` *before* it calls the
   * outbox, so a row that is still `pending` with `attempts = 0` is one no send was ever attempted
   * for. Everything else is left alone —
   *
   * - `delivering` may already have authorized the native Send when the process died;
   * - `pending` with `attempts > 0` was attempted at least once and reset (a failure or a
   *   deferral), so a send may have landed;
   * - `queued` is held by the outbox and `unknown` may already have been sent.
   *
   * Those rows keep their receipt so the runtime can reconcile them against the durable native
   * receipt and a late acknowledgement can still record what actually happened.
   *
   * A *linked* instruction (`outbox_input_id` differs from its own `request_id`) is exempt too: it
   * shares another command's outbox input, which may already have been admitted or delivered by
   * that command's own path, so it is never terminalized from here. Returns how many rows moved.
   */
  cancelUnsentCommands(workId: string): number;
  /** Every command that never reached a terminal delivery state, including start commands. */
  listUnfinishedCommands(limit: number): WorkCommandRow[];

  // events
  appendEvent(workId: string, kind: string, payload: unknown): number;
  readEvents(input: { workId: string; after: number; limit: number }): { events: WorkEventRow[]; hasMore: boolean };

  // artifacts
  insertArtifact(row: WorkArtifactRow): void;
  getArtifact(artifactId: string): WorkArtifactRow | null;
  listArtifacts(input: { workId: string; kind?: string; queryHash?: string }): WorkArtifactRow[];

  // recovery records (generic JSON; the policy lives in recovery.ts)
  loadRecovery<T>(agentId: string, generation: number): T | null;
  saveRecovery(record: { agent_id: string; generation: number }): void;
  listRecovery<T>(agentId?: string): T[];

  // controller continuity: the durable identity of the phone's control conversation
  getControllerBinding(sessionId: string): WorkControllerBinding | null;
  getControllerBindingByConversation(conversationId: string): WorkControllerBinding | null;
  /** Every binding, newest first. Callers filter `enabled`; the store never hides rows. */
  listControllerBindings(): WorkControllerBinding[];
  putControllerBinding(row: WorkControllerBindingInput): WorkControllerBinding;

  // controller inbox: authenticated observations only, deduplicated by message id
  getControllerMessage(sessionId: string, messageId: string): WorkControllerMessage | null;
  putControllerMessage(row: WorkControllerMessage): WorkControllerMessage;
  listPendingControllerMessages(limit?: number, after?: ControllerInboxCursor | null): WorkControllerMessage[];
  /**
   * The pending inbox of one binding, oldest first, walked by keyset.
   *
   * The global list is a bounded page across every session, so a caller that must enumerate one
   * binding's backlog uses this instead: one session's rows cannot crowd another's out, the order is
   * stable (`created_at`, then `message_id`), and `after` continues a walk rather than restarting it
   * at the same head.
   */
  listPendingControllerMessagesForSession(sessionId: string, limit?: number, after?: ControllerInboxCursor | null): WorkControllerMessage[];
  updateControllerMessage(sessionId: string, messageId: string, patch: WorkControllerMessagePatch): WorkControllerMessage;

  // controller deliveries: durable event results back to the original conversation
  getControllerDelivery(deliveryId: string): WorkControllerDelivery | null;
  putControllerDelivery(row: WorkControllerDelivery): WorkControllerDelivery;
  listControllerDeliveries(sessionId?: string): WorkControllerDelivery[];
  updateControllerDelivery(deliveryId: string, patch: WorkControllerDeliveryPatch): WorkControllerDelivery;
}

function fail(code: string, message: string, detail?: string): never {
  throw new WorkServiceError(code, message, detail);
}

function isSqliteError(error: unknown): error is Error & { code?: string; errcode?: number; errstr?: string } {
  return error instanceof Error && (typeof (error as { code?: unknown }).code === 'string' || typeof (error as { errcode?: unknown }).errcode === 'number');
}

/** A uniqueness/foreign-key refusal, as opposed to a real database failure. */
export function isConstraintError(error: unknown): boolean {
  if (!isSqliteError(error)) return false;
  if ((error.errcode ?? 0) >= 19 && (error.errcode ?? 0) <= 23) return true;
  return (error.errstr ?? '').includes('constraint failed') || error.message.includes('constraint failed');
}

function jsonText(value: unknown): string {
  return JSON.stringify(value ?? null);
}

function parseJson<T>(text: string | null | undefined, fallback: T): T {
  if (text === null || text === undefined) return fallback;
  try {
    const parsed: unknown = JSON.parse(text);
    return (parsed === null ? fallback : parsed) as T;
  } catch {
    return fallback;
  }
}

function intOf(value: unknown): number {
  return typeof value === 'number' ? value : Number(value ?? 0);
}

function textOrNull(value: unknown): string | null {
  return typeof value === 'string' ? value : null;
}

/** Private directory for the ledger. Never inherits a wider mode from the parent. */
function ensurePrivateDir(dir: string): void {
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  try {
    const stat = statSync(dir);
    if ((stat.mode & 0o077) !== 0) chmodSync(dir, 0o700);
  } catch {
    /* A directory we cannot stat will fail loudly on open instead. */
  }
}

function sealFile(file: string): void {
  try {
    if (existsSync(file)) chmodSync(file, 0o600);
  } catch {
    /* Best effort: the open itself is what must succeed. */
  }
}

export function createWorkStore(options: WorkStoreOptions): WorkStore {
  const now = options.now ?? (() => Date.now());
  const file = path.join(options.dataDir, options.fileName ?? 'work.sqlite');
  const fresh = !existsSync(file);
  if (!fresh) {
    const stat = statSync(file);
    if (stat.isDirectory()) fail(WORK_ERROR_CODES.stateUnavailable, 'STATE_UNAVAILABLE: the work ledger path is a directory, not a database file.');
  }
  ensurePrivateDir(path.dirname(file));

  let db: DatabaseSync;
  try {
    db = new DatabaseSync(file);
  } catch (error) {
    fail(
      WORK_ERROR_CODES.stateUnavailable,
      'STATE_UNAVAILABLE: the work ledger could not be opened. Durable work state is not usable, so no mutations will run.',
      error instanceof Error ? error.message : String(error)
    );
  }
  const database: DatabaseSync = db;

  try {
    database.exec('PRAGMA foreign_keys = ON');
    database.exec('PRAGMA busy_timeout = 5000');
    // WAL keeps the status path readable while a mutation commits; FULL makes a returned
    // receipt survive a power loss rather than only a process crash.
    database.exec('PRAGMA journal_mode = WAL');
    database.exec('PRAGMA synchronous = FULL');
  } catch (error) {
    database.close();
    fail(
      WORK_ERROR_CODES.stateUnavailable,
      'STATE_UNAVAILABLE: the work ledger could not be configured for durable writes.',
      error instanceof Error ? error.message : String(error)
    );
  }

  sealFile(file);

  // ---------------------------------------------------------------------------------------
  // Migrations
  // ---------------------------------------------------------------------------------------

  function applyMigrations(): void {
    database.exec(`CREATE TABLE IF NOT EXISTS work_schema_migrations (
      version INTEGER PRIMARY KEY,
      applied_at INTEGER NOT NULL
    )`);
    const appliedRows = database.prepare('SELECT version FROM work_schema_migrations').all() as Array<{ version: unknown }>;
    const applied = new Set(appliedRows.map(row => intOf(row.version)));
    const highest = applied.size ? Math.max(...applied) : 0;
    if (highest > SCHEMA_VERSION) {
      fail(
        WORK_ERROR_CODES.stateUnavailable,
        `STATE_UNAVAILABLE: this work ledger was written by a newer version (schema ${highest}, this build knows ${SCHEMA_VERSION}). Refusing to downgrade durable work state.`
      );
    }
    for (const migration of MIGRATIONS) {
      if (applied.has(migration.version)) continue;
      transaction(() => {
        migration.apply(database);
        database.prepare('INSERT INTO work_schema_migrations (version, applied_at) VALUES (?, ?)').run(migration.version, now());
      });
    }
  }

  const MIGRATIONS: Array<{ version: number; apply: (target: DatabaseSync) => void }> = [
    {
      version: 1,
      apply: target => {
        target.exec(`
          CREATE TABLE works (
            work_id TEXT PRIMARY KEY,
            title TEXT NOT NULL,
            goal TEXT NOT NULL,
            project_path TEXT NOT NULL,
            project_name TEXT,
            base_commit TEXT,
            integration_branch TEXT,
            integration_worktree TEXT,
            status TEXT NOT NULL,
            desired_state TEXT,
            prime_agent_id TEXT,
            prime_session_id TEXT,
            model TEXT,
            reasoning TEXT,
            max_workers INTEGER NOT NULL,
            revision INTEGER NOT NULL DEFAULT 0,
            blocker_json TEXT,
            checkpoint_json TEXT,
            integration_intent_json TEXT,
            created_at INTEGER NOT NULL,
            updated_at INTEGER NOT NULL
          );
          CREATE INDEX works_recent ON works (created_at DESC, work_id DESC);

          CREATE TABLE work_agents (
            agent_id TEXT PRIMARY KEY,
            work_id TEXT NOT NULL REFERENCES works(work_id) ON DELETE CASCADE,
            parent_id TEXT,
            role TEXT NOT NULL,
            label TEXT NOT NULL,
            state TEXT NOT NULL,
            session_id TEXT,
            conversation_id TEXT,
            generation INTEGER NOT NULL DEFAULT 0,
            worktree_path TEXT,
            branch TEXT,
            base_commit TEXT,
            model TEXT,
            reasoning TEXT,
            result_ref TEXT,
            checkpoint_ref TEXT,
            recovery_json TEXT,
            created_at INTEGER NOT NULL,
            updated_at INTEGER NOT NULL
          );
          CREATE INDEX work_agents_work ON work_agents (work_id, created_at);
          CREATE UNIQUE INDEX work_agents_conversation ON work_agents (conversation_id) WHERE conversation_id IS NOT NULL;
          CREATE INDEX work_agents_session ON work_agents (session_id) WHERE session_id IS NOT NULL;
          CREATE UNIQUE INDEX work_agents_single_prime ON work_agents (work_id) WHERE role = 'prime';

          CREATE TABLE work_operations (
            operation_id TEXT PRIMARY KEY,
            work_id TEXT NOT NULL REFERENCES works(work_id) ON DELETE CASCADE,
            agent_id TEXT NOT NULL,
            generation INTEGER NOT NULL,
            tool TEXT NOT NULL,
            args_hash TEXT NOT NULL,
            state TEXT NOT NULL,
            process_id TEXT,
            result_ref TEXT,
            result_json TEXT,
            session_id TEXT,
            expect_before_json TEXT,
            expect_after_json TEXT,
            retry_of TEXT,
            retry_operation_id TEXT,
            resolution_json TEXT,
            created_at INTEGER NOT NULL,
            updated_at INTEGER NOT NULL
          );
          CREATE INDEX work_operations_work ON work_operations (work_id, created_at DESC);
          CREATE INDEX work_operations_agent ON work_operations (agent_id, generation, created_at DESC);
          CREATE INDEX work_operations_state ON work_operations (state);

          CREATE TABLE work_commands (
            request_id TEXT PRIMARY KEY,
            work_id TEXT NOT NULL REFERENCES works(work_id) ON DELETE CASCADE,
            kind TEXT NOT NULL,
            input_hash TEXT NOT NULL,
            text TEXT,
            delivery_state TEXT NOT NULL,
            outbox_input_id TEXT NOT NULL,
            result_json TEXT,
            attempts INTEGER NOT NULL DEFAULT 0,
            last_error TEXT,
            created_at INTEGER NOT NULL,
            updated_at INTEGER NOT NULL
          );
          CREATE INDEX work_commands_work ON work_commands (work_id, created_at);
          CREATE INDEX work_commands_delivery ON work_commands (delivery_state, created_at);

          CREATE TABLE work_events (
            work_id TEXT NOT NULL REFERENCES works(work_id) ON DELETE CASCADE,
            sequence INTEGER NOT NULL,
            kind TEXT NOT NULL,
            payload_json TEXT NOT NULL,
            at INTEGER NOT NULL,
            PRIMARY KEY (work_id, sequence)
          );

          CREATE TABLE work_artifacts (
            artifact_id TEXT PRIMARY KEY,
            work_id TEXT NOT NULL REFERENCES works(work_id) ON DELETE CASCADE,
            agent_id TEXT,
            session_id TEXT NOT NULL,
            asset_id TEXT NOT NULL,
            kind TEXT NOT NULL,
            query_hash TEXT,
            page_index INTEGER NOT NULL DEFAULT 0,
            page_count INTEGER NOT NULL DEFAULT 1,
            hit_count INTEGER NOT NULL DEFAULT 0,
            total_hits INTEGER NOT NULL DEFAULT 0,
            truncated_reason TEXT,
            byte_size INTEGER NOT NULL DEFAULT 0,
            created_at INTEGER NOT NULL
          );
          CREATE INDEX work_artifacts_query ON work_artifacts (work_id, kind, query_hash, page_index);
        `);
      }
    },
    {
      version: 2,
      apply: target => {
        // Continuation chain. Existing rows are left NULL: a work written before this build is
        // not retroactively claimed to be part of any chain, and no status is rewritten — an
        // already-completed row keeps its completed status, its goal and its revision history.
        target.exec(`
          ALTER TABLE works ADD COLUMN predecessor_work_id TEXT;
          ALTER TABLE works ADD COLUMN successor_work_id TEXT;
          CREATE INDEX works_successor ON works (successor_work_id) WHERE successor_work_id IS NOT NULL;
        `);

        // The controller: the durable identity of the conversation the phone controls work from.
        // `session_id` is the ledger's own key and never changes; the conversation is
        // replaceable, so the unique index below is what keeps one conversation from being
        // claimed by two sessions at once.
        target.exec(`
          CREATE TABLE work_controller_bindings (
            session_id TEXT PRIMARY KEY,
            conversation_id TEXT NOT NULL,
            provider_account_id TEXT,
            work_id TEXT NOT NULL,
            bound_at INTEGER NOT NULL,
            enabled INTEGER NOT NULL DEFAULT 1,
            event_cursor INTEGER NOT NULL DEFAULT 0,
            updated_at INTEGER NOT NULL
          );
          CREATE UNIQUE INDEX work_controller_bindings_conversation ON work_controller_bindings (conversation_id);
          CREATE INDEX work_controller_bindings_work ON work_controller_bindings (work_id);

          CREATE TABLE work_controller_messages (
            session_id TEXT NOT NULL,
            message_id TEXT NOT NULL,
            conversation_id TEXT NOT NULL,
            request_id TEXT NOT NULL,
            text TEXT NOT NULL,
            authored_at INTEGER NOT NULL,
            state TEXT NOT NULL,
            work_id TEXT,
            error TEXT,
            created_at INTEGER NOT NULL,
            PRIMARY KEY (session_id, message_id)
          );
          CREATE INDEX work_controller_messages_pending ON work_controller_messages (state, created_at);

          CREATE TABLE work_controller_deliveries (
            delivery_id TEXT PRIMARY KEY,
            session_id TEXT NOT NULL,
            conversation_id TEXT NOT NULL,
            work_id TEXT NOT NULL,
            event_sequence INTEGER NOT NULL,
            text TEXT NOT NULL,
            state TEXT NOT NULL,
            error TEXT,
            bound_at INTEGER NOT NULL,
            provider_account_id TEXT NOT NULL,
            created_at INTEGER NOT NULL,
            updated_at INTEGER NOT NULL
          );
          CREATE INDEX work_controller_deliveries_session ON work_controller_deliveries (session_id, created_at);
          CREATE INDEX work_controller_deliveries_state ON work_controller_deliveries (state, created_at);
        `);
      }
    },
    {
      version: 3,
      apply: target => {
        // The frozen dispatch of a controller message.
        //
        // `dispatch_text` is the exact instruction the relay composes from the user's own words and
        // the controller's preceding message, written durably *before* the service side effect.
        // Without it, a crash between the composition and the admission would recompose the text
        // from a recorder that has since recorded more — and because the service hashes the
        // instruction it is given, a differently composed replay is a *different* command under the
        // same request id, which is refused as a conflict instead of joining the admission that
        // already happened. With it, the replay reuses the original bytes and the original hash.
        //
        // `context_assistant_id` records which assistant message that quotation came from, so the
        // frozen context can be shown to be the *preceding* visible message rather than the answer
        // to this very question. Both stay NULL for every row recorded before this build: an
        // already-admitted message keeps its history and is never rewritten, and a row with no
        // frozen dispatch is composed once, by the same rule, when it is first admitted.
        target.exec(`
          ALTER TABLE work_controller_messages ADD COLUMN dispatch_text TEXT;
          ALTER TABLE work_controller_messages ADD COLUMN context_assistant_id TEXT;
        `);
      }
    },
    {
      version: 5,
      apply: target => {
        // How a controller binding was created. Existing rows are `explicit`: an old binding was
        // never proven to be the automatic prime fallback, and reading it conservatively is what
        // keeps a later start from taking over a controller nobody re-created.
        target.exec(`
          ALTER TABLE work_controller_bindings ADD COLUMN origin TEXT NOT NULL DEFAULT 'explicit';
        `);
      }
    },
    {
      version: 6,
      apply: target => {
        // The in-flight native claim on one inbox row.
        //
        // A controller conversation's own tool call reserves the message it is about to admit, and
        // that reservation has to be durable for as long as the call is running: the relay reads the
        // same row, and without this fact a message whose native admission is still awaiting its own
        // journal looks exactly like a message nobody has touched. NULL for every row recorded before
        // this build, which is the honest answer — no in-process call survives a restart.
        target.exec(`ALTER TABLE work_controller_messages ADD COLUMN claimed_at INTEGER;`);
      }
    }
  ];

  // ---------------------------------------------------------------------------------------
  // Transactions and change notifications
  // ---------------------------------------------------------------------------------------

  let depth = 0;
  let queued: WorkChange[] = [];
  let closed = false;

  function transaction<T>(run: () => T): T {
    if (depth > 0) {
      const savepoint = `sp_${depth}`;
      database.exec(`SAVEPOINT ${savepoint}`);
      depth += 1;
      // Notifications queued by this savepoint belong to it: a rolled-back savepoint must not
      // publish a change the enclosing commit no longer contains.
      const mark = queued.length;
      try {
        const result = run();
        depth -= 1;
        database.exec(`RELEASE ${savepoint}`);
        return result;
      } catch (error) {
        depth -= 1;
        queued.length = mark;
        try {
          database.exec(`ROLLBACK TO ${savepoint}`);
          database.exec(`RELEASE ${savepoint}`);
        } catch {
          /* The outer transaction still decides the final outcome. */
        }
        throw error;
      }
    }
    database.exec('BEGIN IMMEDIATE');
    depth = 1;
    let result: T;
    try {
      result = run();
      // COMMIT can fail (deferred constraints, I/O, or a full disk). It belongs inside the same
      // recovery boundary as the callback: until it succeeds, no queued change is publishable
      // and SQLite may still have the transaction open.
      database.exec('COMMIT');
    } catch (error) {
      depth = 0;
      queued = [];
      try {
        database.exec('ROLLBACK');
      } catch {
        /* Nothing useful to add; the original failure is what matters. */
      }
      throw error;
    }
    depth = 0;
    flushChanges();
    return result;
  }

  const listeners = new Set<(change: WorkChange) => void>();

  function flushChanges(): void {
    if (!queued.length) return;
    const pending = queued;
    queued = [];
    for (const change of pending) emit(change);
  }

  function emit(change: WorkChange): void {
    for (const listener of listeners) {
      try {
        listener(change);
      } catch {
        /* A broken listener must never roll back a committed mutation. */
      }
    }
  }

  function notify(workId: string, kind: string, revision: number, status: WorkState): void {
    const change: WorkChange = { work_id: workId, revision, status, kind };
    // Inside a transaction the notification waits for the commit; a listener must never be told
    // about a change that could still roll back.
    if (depth > 0) queued.push(change);
    else emit(change);
  }

  // ---------------------------------------------------------------------------------------
  // Row mapping
  // ---------------------------------------------------------------------------------------

  type Raw = Record<string, unknown>;

  function workFrom(row: Raw): WorkRow {
    return {
      work_id: String(row['work_id']),
      title: String(row['title']),
      goal: String(row['goal']),
      project_path: String(row['project_path']),
      project_name: textOrNull(row['project_name']),
      base_commit: textOrNull(row['base_commit']),
      integration_branch: textOrNull(row['integration_branch']),
      integration_worktree: textOrNull(row['integration_worktree']),
      status: String(row['status']) as WorkState,
      desired_state: textOrNull(row['desired_state']) as WorkDesiredState | null,
      prime_agent_id: textOrNull(row['prime_agent_id']),
      prime_session_id: textOrNull(row['prime_session_id']),
      model: textOrNull(row['model']),
      reasoning: textOrNull(row['reasoning']),
      max_workers: intOf(row['max_workers']),
      revision: intOf(row['revision']),
      blocker: parseJson<WorkBlocker | null>(textOrNull(row['blocker_json']), null),
      checkpoint: parseJson<WorkCheckpoint | null>(textOrNull(row['checkpoint_json']), null),
      integration_intent: parseJson<IntegrationIntentRecord | null>(textOrNull(row['integration_intent_json']), null),
      predecessor_work_id: textOrNull(row['predecessor_work_id']),
      successor_work_id: textOrNull(row['successor_work_id']),
      created_at: intOf(row['created_at']),
      updated_at: intOf(row['updated_at'])
    };
  }

  function agentFrom(row: Raw): WorkAgentRow {
    return {
      agent_id: String(row['agent_id']),
      work_id: String(row['work_id']),
      parent_id: textOrNull(row['parent_id']),
      role: String(row['role']) as WorkAgentRole,
      label: String(row['label']),
      state: String(row['state']),
      session_id: textOrNull(row['session_id']),
      conversation_id: textOrNull(row['conversation_id']),
      generation: intOf(row['generation']),
      worktree_path: textOrNull(row['worktree_path']),
      branch: textOrNull(row['branch']),
      base_commit: textOrNull(row['base_commit']),
      model: textOrNull(row['model']),
      reasoning: textOrNull(row['reasoning']),
      result_ref: textOrNull(row['result_ref']),
      checkpoint_ref: textOrNull(row['checkpoint_ref']),
      created_at: intOf(row['created_at']),
      updated_at: intOf(row['updated_at'])
    };
  }

  function operationFrom(row: Raw): WorkOperationRow {
    return {
      operation_id: String(row['operation_id']),
      work_id: String(row['work_id']),
      agent_id: String(row['agent_id']),
      generation: intOf(row['generation']),
      tool: String(row['tool']),
      args_hash: String(row['args_hash']),
      state: String(row['state']) as WorkOperationRow['state'],
      process_id: textOrNull(row['process_id']),
      result_ref: textOrNull(row['result_ref']),
      result_json: textOrNull(row['result_json']),
      session_id: textOrNull(row['session_id']),
      expect_before: parseJson<Record<string, string | null> | null>(textOrNull(row['expect_before_json']), null),
      expect_after: parseJson<Record<string, string | null> | null>(textOrNull(row['expect_after_json']), null),
      retry_of: textOrNull(row['retry_of']),
      retry_operation_id: textOrNull(row['retry_operation_id']),
      resolution: parseJson<WorkOperationResolutionRecord | null>(textOrNull(row['resolution_json']), null),
      created_at: intOf(row['created_at']),
      updated_at: intOf(row['updated_at'])
    };
  }

  function commandFrom(row: Raw): WorkCommandRow {
    return {
      request_id: String(row['request_id']),
      work_id: String(row['work_id']),
      kind: String(row['kind']) as WorkCommandRow['kind'],
      input_hash: String(row['input_hash']),
      text: textOrNull(row['text']),
      delivery_state: String(row['delivery_state']) as WorkDeliveryState,
      outbox_input_id: String(row['outbox_input_id']),
      result_json: textOrNull(row['result_json']),
      attempts: intOf(row['attempts']),
      last_error: textOrNull(row['last_error']),
      created_at: intOf(row['created_at']),
      updated_at: intOf(row['updated_at'])
    };
  }

  function eventFrom(row: Raw): WorkEventRow {
    return {
      work_id: String(row['work_id']),
      sequence: intOf(row['sequence']),
      kind: String(row['kind']),
      payload: parseJson<Record<string, unknown>>(textOrNull(row['payload_json']), {}),
      at: intOf(row['at'])
    };
  }

  function artifactFrom(row: Raw): WorkArtifactRow {
    return {
      artifact_id: String(row['artifact_id']),
      work_id: String(row['work_id']),
      agent_id: textOrNull(row['agent_id']),
      session_id: String(row['session_id']),
      asset_id: String(row['asset_id']),
      kind: String(row['kind']),
      query_hash: textOrNull(row['query_hash']),
      page_index: intOf(row['page_index']),
      page_count: intOf(row['page_count']),
      hit_count: intOf(row['hit_count']),
      total_hits: intOf(row['total_hits']),
      truncated_reason: textOrNull(row['truncated_reason']),
      byte_size: intOf(row['byte_size']),
      created_at: intOf(row['created_at'])
    };
  }

  function bindingFrom(row: Raw): WorkControllerBinding {
    return {
      session_id: String(row['session_id']),
      conversation_id: String(row['conversation_id']),
      provider_account_id: textOrNull(row['provider_account_id']),
      work_id: String(row['work_id']),
      bound_at: intOf(row['bound_at']),
      enabled: intOf(row['enabled']) !== 0,
      event_cursor: intOf(row['event_cursor']),
      updated_at: intOf(row['updated_at']),
      origin: row['origin'] === 'automatic' ? 'automatic' : 'explicit'
    };
  }

  function controllerMessageFrom(row: Raw): WorkControllerMessage {
    return {
      session_id: String(row['session_id']),
      conversation_id: String(row['conversation_id']),
      message_id: String(row['message_id']),
      request_id: String(row['request_id']),
      text: String(row['text']),
      authored_at: intOf(row['authored_at']),
      state: String(row['state']) as WorkControllerMessage['state'],
      work_id: textOrNull(row['work_id']),
      error: textOrNull(row['error']),
      dispatch_text: textOrNull(row['dispatch_text']),
      context_assistant_id: textOrNull(row['context_assistant_id']),
      claimed_at: row['claimed_at'] === null || row['claimed_at'] === undefined ? null : intOf(row['claimed_at']),
      created_at: intOf(row['created_at'])
    };
  }

  function controllerDeliveryFrom(row: Raw): WorkControllerDelivery {
    return {
      delivery_id: String(row['delivery_id']),
      session_id: String(row['session_id']),
      conversation_id: String(row['conversation_id']),
      work_id: String(row['work_id']),
      event_sequence: intOf(row['event_sequence']),
      text: String(row['text']),
      state: String(row['state']) as WorkControllerDelivery['state'],
      error: textOrNull(row['error']),
      bound_at: intOf(row['bound_at']),
      provider_account_id: String(row['provider_account_id'] ?? ''),
      created_at: intOf(row['created_at']),
      updated_at: intOf(row['updated_at'])
    };
  }

  // ---------------------------------------------------------------------------------------
  // Statements
  // ---------------------------------------------------------------------------------------

  // The schema must exist before any statement is prepared: a damaged or newer database is
  // refused here, while nothing has been read or written yet.
  try {
    applyMigrations();
    verifySchema();
  } catch (error) {
    try {
      database.close();
    } catch {
      /* Ignore. */
    }
    if (error instanceof WorkServiceError) throw error;
    throw new WorkServiceError(
      WORK_ERROR_CODES.stateUnavailable,
      'STATE_UNAVAILABLE: the work ledger could not be prepared. Durable work state is not usable.',
      error instanceof Error ? error.message : String(error)
    );
  }

  const stmt = {
    getWork: database.prepare('SELECT * FROM works WHERE work_id = ?'),
    listWorks: database.prepare('SELECT * FROM works ORDER BY created_at DESC, work_id DESC LIMIT ?'),
    listWorksAfter: database.prepare(
      `SELECT * FROM works WHERE (created_at, work_id) < (SELECT created_at, work_id FROM works WHERE work_id = ?)
       ORDER BY created_at DESC, work_id DESC LIMIT ?`
    ),
    countWorks: database.prepare('SELECT COUNT(*) AS n FROM works'),
    insertWork: database.prepare(`INSERT INTO works (
        work_id, title, goal, project_path, project_name, base_commit, integration_branch, integration_worktree,
        status, desired_state, prime_agent_id, prime_session_id, model, reasoning, max_workers, revision,
        blocker_json, checkpoint_json, integration_intent_json, predecessor_work_id, successor_work_id,
        created_at, updated_at
      ) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`),
    getAgent: database.prepare('SELECT * FROM work_agents WHERE agent_id = ?'),
    getAgentByConversation: database.prepare('SELECT * FROM work_agents WHERE conversation_id = ?'),
    getAgentBySession: database.prepare('SELECT * FROM work_agents WHERE session_id = ? ORDER BY generation DESC LIMIT 1'),
    listAgents: database.prepare('SELECT * FROM work_agents WHERE work_id = ? ORDER BY created_at ASC'),
    countAgents: database.prepare('SELECT COUNT(*) AS n FROM work_agents WHERE work_id = ?'),
    getPrimeAgent: database.prepare("SELECT * FROM work_agents WHERE work_id = ? AND role = 'prime' LIMIT 1"),
    insertAgent: database.prepare(`INSERT INTO work_agents (
        agent_id, work_id, parent_id, role, label, state, session_id, conversation_id, generation,
        worktree_path, branch, base_commit, model, reasoning, result_ref, checkpoint_ref, recovery_json,
        created_at, updated_at
      ) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`),
    releaseAgentReservation: database.prepare(
      `DELETE FROM work_agents
       WHERE agent_id = ? AND work_id = ? AND parent_id = ? AND role = 'worker' AND state = 'pending'
         AND session_id IS NULL AND conversation_id IS NULL AND worktree_path IS NULL AND branch IS NULL
         AND created_at = ?`
    ),
    getOperation: database.prepare('SELECT * FROM work_operations WHERE operation_id = ?'),
    insertOperation: database.prepare(`INSERT INTO work_operations (
        operation_id, work_id, agent_id, generation, tool, args_hash, state, process_id, result_ref, result_json,
        session_id, expect_before_json, expect_after_json, retry_of, retry_operation_id, resolution_json,
        created_at, updated_at
      ) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`),
    listOpenOperations: database.prepare("SELECT * FROM work_operations WHERE state IN ('prepared','running') ORDER BY created_at ASC"),
    listOpenOperationsForWork: database.prepare(
      "SELECT * FROM work_operations WHERE work_id = ? AND state IN ('prepared','running') ORDER BY created_at ASC"
    ),
    listOperations: database.prepare('SELECT * FROM work_operations WHERE work_id = ? ORDER BY created_at DESC LIMIT ?'),
    hasUnresolvedOperations: database.prepare("SELECT 1 FROM work_operations WHERE work_id = ? AND state = 'outcome_unknown' AND resolution_json IS NULL LIMIT 1"),
    listOperationsForAgent: database.prepare(
      'SELECT * FROM work_operations WHERE agent_id = ? AND generation = ? ORDER BY created_at DESC'
    ),
    countActiveOperations: database.prepare(
      "SELECT COUNT(*) AS n FROM work_operations WHERE agent_id = ? AND generation = ? AND state IN ('prepared','running')"
    ),
    getCommand: database.prepare('SELECT * FROM work_commands WHERE request_id = ?'),
    insertCommand: database.prepare(`INSERT INTO work_commands (
        request_id, work_id, kind, input_hash, text, delivery_state, outbox_input_id, result_json, attempts, last_error,
        created_at, updated_at
      ) VALUES (?,?,?,?,?,?,?,?,?,?,?,?)`),
    listCommands: database.prepare('SELECT * FROM work_commands WHERE work_id = ? ORDER BY created_at DESC LIMIT ?'),
    listPendingCommands: database.prepare(
      "SELECT * FROM work_commands WHERE work_id = ? AND delivery_state IN ('pending','delivering','queued','unknown') ORDER BY created_at ASC LIMIT ?"
    ),
    // Fairness: a command that has never been attempted is always considered before one that is
    // merely waiting for reconciliation, so a chat that is slow to acknowledge can never starve a
    // fresh instruction (even on another work) out of the batch. Both groups rotate on
    // `updated_at`, which every attempt bumps, so a processed row moves to the back instead of
    // being re-read at the head of the next batch — and nothing is starved indefinitely.
    //
    // A never-admitted instruction of a stopped work is excluded here, in SQL, rather than skipped
    // after the page was chosen: the pump leaves those rows exactly as they are, and selecting them
    // would let a pile of paused works occupy every slot in the batch forever, starving the works
    // that are actually runnable. A LINKED instruction (`outbox_input_id` differs from its own
    // `request_id`) is exempt: it shares a successor's opening send, so its `pending`/0 does not
    // prove it was never admitted, and its receipt must keep being read.
    listDeliverableFresh: database.prepare(
      `SELECT * FROM work_commands WHERE kind = 'instruct' AND delivery_state IN ('pending','delivering') AND attempts = 0
         AND NOT (delivery_state = 'pending' AND outbox_input_id = request_id AND work_id IN (
           SELECT work_id FROM works WHERE status IN ('paused','cancelled') OR desired_state IS NOT NULL
         ))
       ORDER BY updated_at ASC, created_at ASC LIMIT ?`
    ),
    listDeliverableRetained: database.prepare(
      `SELECT * FROM work_commands WHERE kind = 'instruct'
         AND (delivery_state IN ('queued','unknown') OR (delivery_state IN ('pending','delivering') AND attempts > 0))
       ORDER BY updated_at ASC, created_at ASC LIMIT ?`
    ),
    listUnfinishedCommands: database.prepare(
      "SELECT * FROM work_commands WHERE delivery_state IN ('pending','delivering','queued','unknown') ORDER BY created_at ASC LIMIT ?"
    ),
    listStuckDeliveringCommands: database.prepare(
      "SELECT * FROM work_commands WHERE kind = 'instruct' AND delivery_state = 'delivering' ORDER BY created_at ASC LIMIT ?"
    ),
    hasUnacknowledgedDelivery: database.prepare(
      "SELECT 1 FROM work_commands WHERE work_id = ? AND delivery_state = 'unknown' LIMIT 1"
    ),
    hasOutstandingInstruction: database.prepare(
      `SELECT 1 FROM work_commands WHERE work_id = ? AND kind = 'instruct'
         AND delivery_state IN ('pending','delivering','queued','unknown') LIMIT 1`
    ),
    cancelUnsentCommands: database.prepare(
      `UPDATE work_commands SET delivery_state = 'cancelled', updated_at = ?
         WHERE work_id = ? AND delivery_state = 'pending' AND attempts = 0 AND outbox_input_id = request_id`
    ),
    getArtifact: database.prepare('SELECT * FROM work_artifacts WHERE artifact_id = ?'),
    listArtifacts: database.prepare('SELECT * FROM work_artifacts WHERE work_id = ? ORDER BY page_index ASC'),
    listArtifactsForQuery: database.prepare(
      'SELECT * FROM work_artifacts WHERE work_id = ? AND kind = ? AND query_hash = ? ORDER BY page_index ASC'
    ),
    nextEventSequence: database.prepare('SELECT COALESCE(MAX(sequence), 0) + 1 AS next FROM work_events WHERE work_id = ?'),
    insertEvent: database.prepare('INSERT INTO work_events (work_id, sequence, kind, payload_json, at) VALUES (?,?,?,?,?)'),
    readEvents: database.prepare('SELECT * FROM work_events WHERE work_id = ? AND sequence > ? ORDER BY sequence ASC LIMIT ?'),
    getControllerBinding: database.prepare('SELECT * FROM work_controller_bindings WHERE session_id = ?'),
    getControllerBindingByConversation: database.prepare('SELECT * FROM work_controller_bindings WHERE conversation_id = ?'),
    listControllerBindings: database.prepare('SELECT * FROM work_controller_bindings ORDER BY updated_at DESC'),
    insertControllerBinding: database.prepare(`INSERT INTO work_controller_bindings (
        session_id, conversation_id, provider_account_id, work_id, bound_at, enabled, event_cursor, updated_at, origin
      ) VALUES (?,?,?,?,?,?,?,?,?)`),
    updateControllerBinding: database.prepare(`UPDATE work_controller_bindings
        SET conversation_id = ?, provider_account_id = ?, work_id = ?, bound_at = ?, enabled = ?, event_cursor = ?, updated_at = ?, origin = ?
        WHERE session_id = ?`),
    getControllerMessage: database.prepare('SELECT * FROM work_controller_messages WHERE session_id = ? AND message_id = ?'),
    insertControllerMessage: database.prepare(`INSERT INTO work_controller_messages (
        session_id, message_id, conversation_id, request_id, text, authored_at, state, work_id, error,
        dispatch_text, context_assistant_id, claimed_at, created_at
      ) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?)`),
    listPendingControllerMessages: database.prepare(
      "SELECT * FROM work_controller_messages WHERE state = 'pending' AND (created_at > ? OR (created_at = ? AND (session_id > ? OR (session_id = ? AND message_id > ?)))) ORDER BY created_at ASC, session_id ASC, message_id ASC LIMIT ?"
    ),
    listPendingControllerMessagesForSession: database.prepare(
      "SELECT * FROM work_controller_messages WHERE session_id = ? AND state = 'pending' AND (created_at > ? OR (created_at = ? AND message_id > ?)) ORDER BY created_at ASC, message_id ASC LIMIT ?"
    ),
    getControllerDelivery: database.prepare('SELECT * FROM work_controller_deliveries WHERE delivery_id = ?'),
    insertControllerDelivery: database.prepare(`INSERT INTO work_controller_deliveries (
        delivery_id, session_id, conversation_id, work_id, event_sequence, text, state, error,
        bound_at, provider_account_id, created_at, updated_at
      ) VALUES (?,?,?,?,?,?,?,?,?,?,?,?)`),
    listControllerDeliveries: database.prepare('SELECT * FROM work_controller_deliveries ORDER BY created_at ASC, delivery_id ASC'),
    listControllerDeliveriesForSession: database.prepare(
      'SELECT * FROM work_controller_deliveries WHERE session_id = ? ORDER BY created_at ASC, delivery_id ASC'
    )
  };

  // ---------------------------------------------------------------------------------------
  // Implementation
  // ---------------------------------------------------------------------------------------

  /** Revision bump and event append share one transaction, so a cursor never skips a change. */
  function bump(workId: string, kind: string, extra?: Record<string, unknown>): WorkRow {
    const current = getWork(workId);
    if (!current) fail(WORK_ERROR_CODES.workNotFound, 'WORK_NOT_FOUND: no work with that id exists in the ledger.');
    const revision = current.revision + 1;
    const at = now();
    database.prepare('UPDATE works SET revision = ?, updated_at = ? WHERE work_id = ?').run(revision, at, workId);
    const sequence = nextSequence(workId);
    stmt.insertEvent.run(workId, sequence, kind, jsonText({ revision, ...extra }), at);
    const status = (database.prepare('SELECT status FROM works WHERE work_id = ?').get(workId) as Raw | undefined)?.['status'];
    notify(workId, kind, revision, (typeof status === 'string' ? status : current.status) as WorkState);
    return { ...current, revision, updated_at: at };
  }

  function nextSequence(workId: string): number {
    const row = stmt.nextEventSequence.get(workId) as Raw | undefined;
    return intOf(row?.['next'] ?? 1);
  }

  function getWork(workId: string): WorkRow | null {
    const row = stmt.getWork.get(workId) as Raw | undefined;
    return row ? workFrom(row) : null;
  }

  function requireWork(workId: string): WorkRow {
    const row = getWork(workId);
    if (!row) fail(WORK_ERROR_CODES.workNotFound, 'WORK_NOT_FOUND: no work with that id exists in the ledger.');
    return row;
  }

  function updateWork(workId: string, patch: WorkPatch): WorkRow {
    return transaction(() => {
      requireWork(workId);
      const columns: string[] = [];
      const values: Array<string | number | null> = [];
      const assign = (column: string, value: string | number | null): void => {
        columns.push(`${column} = ?`);
        values.push(value);
      };
      if (patch.title !== undefined) assign('title', patch.title);
      if (patch.status !== undefined) assign('status', patch.status);
      if (patch.desired_state !== undefined) assign('desired_state', patch.desired_state);
      if (patch.base_commit !== undefined) assign('base_commit', patch.base_commit);
      if (patch.integration_branch !== undefined) assign('integration_branch', patch.integration_branch);
      if (patch.integration_worktree !== undefined) assign('integration_worktree', patch.integration_worktree);
      if (patch.prime_agent_id !== undefined) assign('prime_agent_id', patch.prime_agent_id);
      if (patch.prime_session_id !== undefined) assign('prime_session_id', patch.prime_session_id);
      if (patch.model !== undefined) assign('model', patch.model);
      if (patch.reasoning !== undefined) assign('reasoning', patch.reasoning);
      if (patch.project_name !== undefined) assign('project_name', patch.project_name);
      if (patch.predecessor_work_id !== undefined) assign('predecessor_work_id', patch.predecessor_work_id);
      if (patch.successor_work_id !== undefined) assign('successor_work_id', patch.successor_work_id);
      if (columns.length) {
        database.prepare(`UPDATE works SET ${columns.join(', ')} WHERE work_id = ?`).run(...values, workId);
      }
      bump(workId, 'work_updated');
      return requireWork(workId);
    });
  }

  const store: WorkStore = {
    file,

    close() {
      closed = true;
      try {
        database.close();
      } catch {
        /* Already closed. */
      }
    },

    isClosed() {
      return closed;
    },

    onChanged(listener) {
      listeners.add(listener);
      return () => {
        listeners.delete(listener);
      };
    },

    runInTransaction<T>(run: () => T): T {
      return transaction(run);
    },

    getWork,
    listWorks({ limit, cursor }) {
      const rows = cursor
        ? (stmt.listWorksAfter.all(cursor, limit) as Raw[])
        : (stmt.listWorks.all(limit) as Raw[]);
      return rows.map(workFrom);
    },
    countWorks() {
      const row = stmt.countWorks.get() as Raw | undefined;
      return intOf(row?.['n']);
    },
    insertWork(row) {
      transaction(() => {
        stmt.insertWork.run(
          row.work_id, row.title, row.goal, row.project_path, row.project_name, row.base_commit,
          row.integration_branch, row.integration_worktree, row.status, row.desired_state, row.prime_agent_id,
          row.prime_session_id, row.model, row.reasoning, row.max_workers, row.revision,
          row.blocker ? jsonText(row.blocker) : null,
          row.checkpoint ? jsonText(row.checkpoint) : null,
          row.integration_intent ? jsonText(row.integration_intent) : null,
          row.predecessor_work_id, row.successor_work_id,
          row.created_at, row.updated_at
        );
      });
    },
    updateWork,

    setWorkStatus(workId, status, kind) {
      return transaction(() => {
        database.prepare('UPDATE works SET status = ? WHERE work_id = ?').run(status, workId);
        bump(workId, kind);
        return requireWork(workId);
      });
    },

    setDesiredState(workId, desired, kind) {
      return transaction(() => {
        database.prepare('UPDATE works SET desired_state = ? WHERE work_id = ?').run(desired, workId);
        bump(workId, kind);
        return requireWork(workId);
      });
    },

    setBlocker(workId, blocker, kind) {
      return transaction(() => {
        database.prepare('UPDATE works SET blocker_json = ? WHERE work_id = ?').run(blocker ? jsonText(blocker) : null, workId);
        bump(workId, kind);
        return requireWork(workId);
      });
    },

    setCheckpoint(workId, checkpoint) {
      return transaction(() => {
        if (checkpoint) {
          const bytes = Buffer.byteLength(JSON.stringify(checkpoint), 'utf8');
          if (bytes > 24 * 1024) {
            fail(
              WORK_ERROR_CODES.checkpointTooLarge,
              'CHECKPOINT_TOO_LARGE: the checkpoint exceeds 24KiB. Keep the summary and remaining steps bounded and put detail in the session assets.'
            );
          }
        }
        database.prepare('UPDATE works SET checkpoint_json = ? WHERE work_id = ?').run(checkpoint ? jsonText(checkpoint) : null, workId);
        bump(workId, 'checkpoint_updated');
        return requireWork(workId);
      });
    },

    setIntegrationIntent(workId, intent) {
      return transaction(() => {
        database.prepare('UPDATE works SET integration_intent_json = ? WHERE work_id = ?').run(intent ? jsonText(intent) : null, workId);
        bump(workId, 'integration_intent');
        return requireWork(workId);
      });
    },

    touchWork(workId, kind) {
      return transaction(() => {
        bump(workId, kind);
        return requireWork(workId);
      });
    },

    /**
     * The one writer of the continuation link.
     *
     * Both columns and both events commit together, so a reader can never see a successor that
     * names a predecessor which does not name it back — the pair is the routing table `instruct`
     * follows. A predecessor that already has a successor is refused rather than silently
     * re-pointed: two successors for one completed work would make routing ambiguous, and the
     * caller resolves the existing chain instead.
     */
    linkContinuation(predecessorId, successorId) {
      return transaction(() => {
        const predecessor = requireWork(predecessorId);
        const successor = requireWork(successorId);
        if (predecessor.successor_work_id && predecessor.successor_work_id !== successorId) {
          fail(
            WORK_ERROR_CODES.continuationConflict,
            `CONTINUATION_CONFLICT: work ${predecessorId} already has successor ${predecessor.successor_work_id}. A completed work has exactly one successor.`
          );
        }
        if (successor.predecessor_work_id && successor.predecessor_work_id !== predecessorId) {
          fail(
            WORK_ERROR_CODES.continuationConflict,
            `CONTINUATION_CONFLICT: work ${successorId} already continues ${successor.predecessor_work_id}.`
          );
        }
        if (predecessorId === successorId) {
          fail(WORK_ERROR_CODES.continuationConflict, 'CONTINUATION_CONFLICT: a work cannot continue itself.');
        }
        database.prepare('UPDATE works SET successor_work_id = ? WHERE work_id = ?').run(successorId, predecessorId);
        database.prepare('UPDATE works SET predecessor_work_id = ? WHERE work_id = ?').run(predecessorId, successorId);
        bump(predecessorId, WORK_EVENT_KINDS.workContinued, { successor_work_id: successorId, role: 'predecessor' });
        bump(successorId, WORK_EVENT_KINDS.workContinued, { predecessor_work_id: predecessorId, role: 'successor' });
        return requireWork(successorId);
      });
    },

    getAgent(agentId) {
      const row = stmt.getAgent.get(agentId) as Raw | undefined;
      return row ? agentFrom(row) : null;
    },
    getAgentByConversation(conversationId) {
      const row = stmt.getAgentByConversation.get(conversationId) as Raw | undefined;
      return row ? agentFrom(row) : null;
    },
    getAgentBySession(sessionId) {
      const row = stmt.getAgentBySession.get(sessionId) as Raw | undefined;
      return row ? agentFrom(row) : null;
    },
    listAgents(workId) {
      return (stmt.listAgents.all(workId) as Raw[]).map(agentFrom);
    },
    countAgents(workId) {
      const row = stmt.countAgents.get(workId) as Raw | undefined;
      return intOf(row?.['n']);
    },
    getPrimeAgent(workId) {
      const row = stmt.getPrimeAgent.get(workId) as Raw | undefined;
      return row ? agentFrom(row) : null;
    },
    insertAgent(row) {
      transaction(() => {
        stmt.insertAgent.run(
          row.agent_id, row.work_id, row.parent_id, row.role, row.label, row.state, row.session_id,
          row.conversation_id, row.generation, row.worktree_path, row.branch, row.base_commit, row.model,
          row.reasoning, row.result_ref, row.checkpoint_ref, null, row.created_at, row.updated_at
        );
      });
    },

    releaseAgentReservation({ agentId, workId, parentId, createdAt }) {
      return transaction(() =>
        Number(stmt.releaseAgentReservation.run(agentId, workId, parentId, createdAt).changes ?? 0) === 1
      );
    },

    updateAgent(agentId, patch) {
      return transaction(() => {
        const columns: string[] = [];
        const values: Array<string | number | null> = [];
        const assign = (column: string, value: string | number | null): void => {
          columns.push(`${column} = ?`);
          values.push(value);
        };
        for (const key of [
          'parent_id', 'role', 'label', 'state', 'session_id', 'conversation_id', 'generation',
          'worktree_path', 'branch', 'base_commit', 'model', 'reasoning', 'result_ref', 'checkpoint_ref'
        ] as const) {
          const value = patch[key];
          if (value !== undefined) assign(key, value as string | number | null);
        }
        if (columns.length) {
          database.prepare(`UPDATE work_agents SET ${columns.join(', ')}, updated_at = ? WHERE agent_id = ?`).run(...values, now(), agentId);
        }
        const row = store.getAgent(agentId);
        if (!row) fail(WORK_ERROR_CODES.workNotFound, 'WORK_NOT_FOUND: no agent with that id exists in the ledger.');
        bump(row.work_id, 'agent_updated');
        return store.getAgent(agentId)!;
      });
    },

    bindAgentConversation({ agentId, sessionId, conversationId, generation }) {
      return transaction(() => {
        const current = store.getAgent(agentId);
        if (!current) fail(WORK_ERROR_CODES.workNotFound, 'WORK_NOT_FOUND: no agent with that id exists in the ledger.');
        // Replacement updates the binding only: the agent id and its worktree are unchanged.
        database.prepare('UPDATE work_agents SET session_id = ?, conversation_id = ?, generation = ?, updated_at = ? WHERE agent_id = ?')
          .run(sessionId, conversationId, generation ?? current.generation, now(), agentId);
        bump(current.work_id, 'agent_rebound');
        return store.getAgent(agentId)!;
      });
    },

    advanceAgentGeneration({ workId, agentId }) {
      return transaction(() => {
        const current = store.getAgent(agentId);
        if (!current) fail(WORK_ERROR_CODES.workNotFound, 'WORK_NOT_FOUND: no agent with that id exists in the ledger.');
        if (current.work_id !== workId) {
          fail(WORK_ERROR_CODES.workNotFound, 'WORK_NOT_FOUND: that agent does not belong to this work.');
        }
        const generation = current.generation + 1;
        database.prepare('UPDATE work_agents SET generation = ?, updated_at = ? WHERE agent_id = ?').run(generation, now(), agentId);
        bump(workId, 'agent_generation');
        return generation;
      });
    },

    fenceAgentGeneration({ workId, agentId, generation }) {
      transaction(() => {
        const current = store.getAgent(agentId);
        if (!current) fail(WORK_ERROR_CODES.workNotFound, 'WORK_NOT_FOUND: no agent with that id exists in the ledger.');
        if (current.work_id !== workId) fail(WORK_ERROR_CODES.workNotFound, 'WORK_NOT_FOUND: that agent does not belong to this work.');
        // Fencing never lowers a generation: the newest binding always wins.
        if (current.generation < generation) {
          database.prepare('UPDATE work_agents SET generation = ?, updated_at = ? WHERE agent_id = ?').run(generation, now(), agentId);
          bump(workId, 'agent_fenced');
        }
      });
    },

    assignWorktree(record) {
      return transaction(() => {
        const existing = store.getAgent(record.agentId);
        if (!existing) fail(WORK_ERROR_CODES.workNotFound, 'WORK_NOT_FOUND: no agent with that id exists in the ledger.');
        if (existing.work_id !== record.workId) fail(WORK_ERROR_CODES.workNotFound, 'WORK_NOT_FOUND: that agent does not belong to this work.');
        database.prepare(
          'UPDATE work_agents SET role = ?, worktree_path = ?, branch = ?, base_commit = ?, updated_at = ? WHERE agent_id = ?'
        ).run(record.role, record.path, record.branch, record.baseCommit, now(), record.agentId);
        if (record.role === 'prime') {
          database.prepare('UPDATE works SET prime_agent_id = ?, prime_session_id = ? WHERE work_id = ?')
            .run(record.agentId, existing.session_id, record.workId);
        }
        bump(record.workId, 'worktree_assigned');
        return store.getAgent(record.agentId)!;
      });
    },

    getWorktreeAssignment(workId, agentId) {
      const agent = store.getAgent(agentId);
      if (!agent || agent.work_id !== workId || !agent.worktree_path || !agent.branch) return null;
      return {
        workId,
        agentId,
        role: agent.role,
        branch: agent.branch,
        path: agent.worktree_path,
        baseCommit: agent.base_commit ?? '',
        createdAt: agent.created_at
      };
    },

    listWorktreeAssignments(workId) {
      return store.listAgents(workId)
        .filter(agent => agent.worktree_path !== null && agent.branch !== null)
        .map(agent => ({
          workId,
          agentId: agent.agent_id,
          role: agent.role,
          branch: agent.branch!,
          path: agent.worktree_path!,
          baseCommit: agent.base_commit ?? '',
          createdAt: agent.created_at
        }));
    },

    getIntegrationIntent(workId) {
      return store.getWork(workId)?.integration_intent ?? null;
    },

    clearIntegrationIntent(workId) {
      transaction(() => {
        database.prepare('UPDATE works SET integration_intent_json = NULL WHERE work_id = ?').run(workId);
        bump(workId, 'integration_cleared');
      });
    },

    getOperation(operationId) {
      const row = stmt.getOperation.get(operationId) as Raw | undefined;
      return row ? operationFrom(row) : null;
    },

    insertOperation(row) {
      try {
        stmt.insertOperation.run(
          row.operation_id, row.work_id, row.agent_id, row.generation, row.tool, row.args_hash, row.state,
          row.process_id, row.result_ref, row.result_json, row.session_id,
          row.expect_before ? jsonText(row.expect_before) : null,
          row.expect_after ? jsonText(row.expect_after) : null,
          row.retry_of, row.retry_operation_id,
          row.resolution ? jsonText(row.resolution) : null,
          row.created_at, row.updated_at
        );
      } catch (error) {
        // The caller relies on this exact signal to distinguish "id already used" from a real
        // database failure: it re-reads the row and joins the winner instead of running twice.
        if (isConstraintError(error)) {
          throw new WorkServiceError('DUPLICATE_OPERATION_ID', 'DUPLICATE_OPERATION_ID: that operation id already exists in the ledger.');
        }
        throw error;
      }
    },

    updateOperation(operationId, patch) {
      transaction(() => {
        const columns: string[] = [];
        const values: Array<string | number | null> = [];
        const assign = (column: string, value: string | number | null): void => {
          columns.push(`${column} = ?`);
          values.push(value);
        };
        if (patch.state !== undefined) assign('state', patch.state);
        if (patch.process_id !== undefined) assign('process_id', patch.process_id);
        if (patch.result_ref !== undefined) assign('result_ref', patch.result_ref);
        if (patch.result_json !== undefined) assign('result_json', patch.result_json);
        if (patch.session_id !== undefined) assign('session_id', patch.session_id);
        if (patch.expect_before !== undefined) assign('expect_before_json', patch.expect_before ? jsonText(patch.expect_before) : null);
        if (patch.expect_after !== undefined) assign('expect_after_json', patch.expect_after ? jsonText(patch.expect_after) : null);
        if (patch.retry_of !== undefined) assign('retry_of', patch.retry_of);
        if (patch.retry_operation_id !== undefined) assign('retry_operation_id', patch.retry_operation_id);
        if (patch.resolution !== undefined) assign('resolution_json', patch.resolution ? jsonText(patch.resolution) : null);
        assign('updated_at', patch.updated_at ?? now());
        database.prepare(`UPDATE work_operations SET ${columns.join(', ')} WHERE operation_id = ?`).run(...values, operationId);
        const row = store.getOperation(operationId);
        if (row) bump(row.work_id, 'operation_updated');
      });
    },

    listOpenOperations(workId) {
      const rows = workId
        ? (stmt.listOpenOperationsForWork.all(workId) as Raw[])
        : (stmt.listOpenOperations.all() as Raw[]);
      return rows.map(operationFrom);
    },

    listOperations(workId, limit) {
      return (stmt.listOperations.all(workId, limit) as Raw[]).map(operationFrom);
    },

    listOperationsForAgent(agentId, generation) {
      return (stmt.listOperationsForAgent.all(agentId, generation) as Raw[]).map(operationFrom);
    },
    hasUnresolvedOperations(workId) {
      return stmt.hasUnresolvedOperations.get(workId) !== undefined;
    },

    countActiveOperations(agentId, generation) {
      const row = stmt.countActiveOperations.get(agentId, generation) as Raw | undefined;
      return intOf(row?.['n']);
    },

    admissionContext(agentId) {
      const agent = store.getAgent(agentId);
      if (!agent) return null;
      const work = store.getWork(agent.work_id);
      if (!work) return null;
      return {
        work_id: work.work_id,
        // A committed pause/cancel fence must refuse new mutations immediately, even while the
        // drain is still settling and the factual status is unchanged.
        work_status: work.desired_state ?? work.status,
        agent_id: agent.agent_id,
        agent_generation: agent.generation,
        agent_state: agent.state
      };
    },

    getCommand(requestId) {
      const row = stmt.getCommand.get(requestId) as Raw | undefined;
      return row ? commandFrom(row) : null;
    },

    insertCommand(row) {
      transaction(() => {
        stmt.insertCommand.run(
          row.request_id, row.work_id, row.kind, row.input_hash, row.text, row.delivery_state,
          row.outbox_input_id, row.result_json, row.attempts, row.last_error, row.created_at, row.updated_at
        );
      });
    },

    leaseCommand(requestId, attempt) {
      // Silent by design: a lease is bookkeeping for crash recovery, not a fact about delivery.
      database.prepare("UPDATE work_commands SET delivery_state = 'delivering', attempts = ?, updated_at = ? WHERE request_id = ?")
        .run(attempt, now(), requestId);
    },

    releaseCommand(requestId, restore) {
      return transaction(() => {
        const current = store.getCommand(requestId);
        if (!current) fail(WORK_ERROR_CODES.workNotFound, 'WORK_NOT_FOUND: no command with that request id exists in the ledger.');
        database.prepare('UPDATE work_commands SET delivery_state = ?, attempts = ?, last_error = ?, updated_at = ? WHERE request_id = ?')
          .run(restore.delivery_state, restore.attempts, restore.last_error, now(), requestId);
        // Silent by construction: the lease it undoes was silent too, and an attempt that produced
        // no outcome is not a fact about the work. `updated_at` moves only so the pump's rotation
        // can advance without re-reading the same rows first every time.
        return store.getCommand(requestId)!;
      });
    },

    rotateCommands(requestIds) {
      if (requestIds.length === 0) return;
      const at = now();
      const touch = database.prepare('UPDATE work_commands SET updated_at = ? WHERE request_id = ?');
      transaction(() => {
        for (const requestId of requestIds) touch.run(at, requestId);
      });
    },

    updateCommand(requestId, patch) {
      return transaction(() => {
        const current = store.getCommand(requestId);
        if (!current) fail(WORK_ERROR_CODES.workNotFound, 'WORK_NOT_FOUND: no command with that request id exists in the ledger.');
        // A patch that would write back exactly what is already stored is not a transition. It is
        // skipped entirely — no row write, no revision, no event — so a repeated observation can
        // never be mistaken for news by a reader or by the manager's report coalescing.
        const same = (patch.delivery_state === undefined || patch.delivery_state === current.delivery_state) &&
          (patch.attempts === undefined || patch.attempts === current.attempts) &&
          (patch.last_error === undefined || patch.last_error === current.last_error) &&
          (patch.result_json === undefined || patch.result_json === current.result_json);
        if (same) return current;
        const columns: string[] = [];
        const values: Array<string | number | null> = [];
        const assign = (column: string, value: string | number | null): void => {
          columns.push(`${column} = ?`);
          values.push(value);
        };
        if (patch.delivery_state !== undefined) assign('delivery_state', patch.delivery_state);
        if (patch.attempts !== undefined) assign('attempts', patch.attempts);
        if (patch.last_error !== undefined) assign('last_error', patch.last_error);
        if (patch.result_json !== undefined) assign('result_json', patch.result_json);
        assign('updated_at', now());
        database.prepare(`UPDATE work_commands SET ${columns.join(', ')} WHERE request_id = ?`).run(...values, requestId);
        bump(current.work_id, 'command_updated');
        return store.getCommand(requestId)!;
      });
    },

    listCommands(workId, limit) {
      return (stmt.listCommands.all(workId, limit) as Raw[]).map(commandFrom);
    },

    listPendingCommands(workId, limit) {
      return (stmt.listPendingCommands.all(workId, limit) as Raw[]).map(commandFrom);
    },

    listDeliverableFreshCommands(limit) {
      return (stmt.listDeliverableFresh.all(limit) as Raw[]).map(commandFrom);
    },

    listDeliverableRetainedCommands(limit) {
      return (stmt.listDeliverableRetained.all(limit) as Raw[]).map(commandFrom);
    },

    listStuckDeliveringCommands(limit) {
      return (stmt.listStuckDeliveringCommands.all(limit) as Raw[]).map(commandFrom);
    },

    hasUnacknowledgedDelivery(workId) {
      return stmt.hasUnacknowledgedDelivery.get(workId) !== undefined;
    },

    hasOutstandingInstruction(workId) {
      return stmt.hasOutstandingInstruction.get(workId) !== undefined;
    },

    cancelUnsentCommands(workId) {
      return Number(stmt.cancelUnsentCommands.run(now(), workId).changes ?? 0);
    },

    listUnfinishedCommands(limit) {
      return (stmt.listUnfinishedCommands.all(limit) as Raw[]).map(commandFrom);
    },

    appendEvent(workId, kind, payload) {
      return transaction(() => {
        const current = store.getWork(workId);
        if (!current) fail(WORK_ERROR_CODES.workNotFound, 'WORK_NOT_FOUND: no work with that id exists in the ledger.');
        const at = now();
        const sequence = nextSequence(workId);
        // Events are cursors and small typed facts, never log storage: an oversized payload is
        // truncated with an explicit marker here rather than silently bloating every poll.
        const body = jsonText(payload ?? {});
        const bounded = Buffer.byteLength(body, 'utf8') <= MAX_EVENT_PAYLOAD_BYTES
          ? body
          : jsonText({ truncated: true, reason: 'event payload exceeded the ledger bound', kind, size: Buffer.byteLength(body, 'utf8') });
        stmt.insertEvent.run(workId, sequence, kind, bounded, at);
        // The revision and the event are one transaction: a reader that sees revision N has
        // every event up to N, so a cursor can never skip a change.
        const revision = current.revision + 1;
        database.prepare('UPDATE works SET revision = ?, updated_at = ? WHERE work_id = ?').run(revision, at, workId);
        notify(workId, kind, revision, current.status);
        return sequence;
      });
    },

    readEvents({ workId, after, limit }) {
      const rows = stmt.readEvents.all(workId, after, limit + 1) as Raw[];
      const hasMore = rows.length > limit;
      return { events: rows.slice(0, limit).map(eventFrom), hasMore };
    },

    insertArtifact(row) {
      transaction(() => {
        database.prepare(`INSERT INTO work_artifacts (
            artifact_id, work_id, agent_id, session_id, asset_id, kind, query_hash, page_index, page_count,
            hit_count, total_hits, truncated_reason, byte_size, created_at
          ) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?)`).run(
          row.artifact_id, row.work_id, row.agent_id, row.session_id, row.asset_id, row.kind, row.query_hash,
          row.page_index, row.page_count, row.hit_count, row.total_hits, row.truncated_reason, row.byte_size, row.created_at
        );
        bump(row.work_id, 'artifact_recorded');
      });
    },

    getArtifact(artifactId) {
      const row = stmt.getArtifact.get(artifactId) as Raw | undefined;
      return row ? artifactFrom(row) : null;
    },

    listArtifacts({ workId, kind, queryHash }) {
      const rows = kind !== undefined && queryHash !== undefined
        ? (stmt.listArtifactsForQuery.all(workId, kind, queryHash) as Raw[])
        : (stmt.listArtifacts.all(workId) as Raw[]);
      return rows.map(artifactFrom);
    },

    loadRecovery<T>(agentId: string, generation: number): T | null {
      const agent = store.getAgent(agentId);
      if (!agent) return null;
      const history = parseJson<Array<Record<string, unknown>>>(agentRecoveryJson(agentId), []);
      const match = history.find(entry => intOf(entry['generation']) === generation);
      return (match as T | undefined) ?? null;
    },

    saveRecovery(record) {
      transaction(() => {
        const agent = store.getAgent(record.agent_id);
        if (!agent) fail(WORK_ERROR_CODES.workNotFound, 'WORK_NOT_FOUND: no agent with that id exists in the ledger.');
        const history = parseJson<Array<Record<string, unknown>>>(agentRecoveryJson(record.agent_id), []);
        const next = history.filter(entry => intOf(entry['generation']) !== record.generation);
        next.push(record as unknown as Record<string, unknown>);
        next.sort((a, b) => intOf(a['generation']) - intOf(b['generation']));
        const bounded = next.slice(-RECOVERY_HISTORY);
        database.prepare('UPDATE work_agents SET recovery_json = ? WHERE agent_id = ?').run(jsonText(bounded), record.agent_id);
        bump(agent.work_id, 'recovery_updated');
      });
    },

    listRecovery<T>(agentId?: string): T[] {
      const agents = agentId ? [store.getAgent(agentId)].filter((row): row is WorkAgentRow => row !== null) : allAgents();
      const out: T[] = [];
      for (const agent of agents) {
        out.push(...parseJson<T[]>(agentRecoveryJson(agent.agent_id), []));
      }
      return out;
    },

    // -------------------------------------------------------------------------------------
    // Controller continuity
    // -------------------------------------------------------------------------------------

    getControllerBinding(sessionId) {
      const row = stmt.getControllerBinding.get(sessionId) as Raw | undefined;
      return row ? bindingFrom(row) : null;
    },

    getControllerBindingByConversation(conversationId) {
      const row = stmt.getControllerBindingByConversation.get(conversationId) as Raw | undefined;
      return row ? bindingFrom(row) : null;
    },

    listControllerBindings() {
      return (stmt.listControllerBindings.all() as Raw[]).map(bindingFrom);
    },

    /**
     * Upsert one binding.
     *
     * Three refusals protect the identity, and each one is a different real mistake:
     *
     * - a conversation already claimed by a *different* session would make one chat two
     *   controllers, so it is refused rather than silently stolen;
     * - an omitted `provider_account_id` on an existing row keeps the anchored account instead of
     *   erasing the evidence that anchored it;
     * - a *different* account for an already anchored conversation is refused, because the same
     *   conversation id under another account is a different chat.
     *
     * The change notification is emitted after the commit (the transaction queue guarantees it),
     * so a listener that re-enters the store can only ever see committed state.
     */
    putControllerBinding(input) {
      const existing = store.getControllerBinding(input.session_id);
      const claimed = store.getControllerBindingByConversation(input.conversation_id);
      if (claimed && claimed.session_id !== input.session_id) {
        fail(
          WORK_ERROR_CODES.controllerBindingConflict,
          `CONTROLLER_BINDING_CONFLICT: conversation ${input.conversation_id} is already bound to another controller session. Unbind it there first; a conversation never becomes two controllers.`
        );
      }
      const requestedAccount = input.provider_account_id;
      const anchored = existing?.provider_account_id ?? null;
      if (requestedAccount !== undefined && requestedAccount !== null && anchored !== null && anchored !== requestedAccount) {
        fail(
          WORK_ERROR_CODES.controllerAccountConflict,
          'CONTROLLER_ACCOUNT_CONFLICT: that conversation was already observed under a different provider account. The same conversation id under another account is a different chat, so the anchor is not replaced.'
        );
      }
      const account = requestedAccount === undefined
        ? anchored
        : (requestedAccount ?? (existing ? anchored : null));
      const enabled = input.enabled;
      // Only an identity change notifies. A cursor advance is the *reader's own* progress — a
      // report that moved its cursor is not a change to the binding, and notifying it would make
      // every report generate the next event to report, forever.
      const changed = !existing ||
        existing.conversation_id !== input.conversation_id ||
        existing.work_id !== input.work_id ||
        existing.enabled !== enabled ||
        existing.origin !== (input.origin ?? existing.origin) ||
        anchored !== account;
      const at = now();
      return transaction(() => {
        // The origin is the *creation* fact: an existing row keeps whatever it was created as, and
        // only a caller that deliberately says otherwise moves it.
        const origin = input.origin ?? existing?.origin ?? 'explicit';
        if (existing) {
          stmt.updateControllerBinding.run(
            input.conversation_id, account, input.work_id, input.bound_at,
            enabled ? 1 : 0, input.event_cursor, at, origin, input.session_id
          );
        } else {
          stmt.insertControllerBinding.run(
            input.session_id, input.conversation_id, account, input.work_id,
            input.bound_at, enabled ? 1 : 0, input.event_cursor, at, origin
          );
        }
        // Only a real change notifies, and only for a work that exists: the binding is
        // session-scoped, so a work row is not required for it to be durable.
        if (changed && store.getWork(input.work_id)) {
          bump(input.work_id, WORK_EVENT_KINDS.controllerBindingChanged, {
            session_id: input.session_id,
            conversation_id: input.conversation_id,
            enabled
          });
        }
        return store.getControllerBinding(input.session_id)!;
      });
    },

    getControllerMessage(sessionId, messageId) {
      const row = stmt.getControllerMessage.get(sessionId, messageId) as Raw | undefined;
      return row ? controllerMessageFrom(row) : null;
    },

    /**
     * Records one authenticated observation.
     *
     * `(session_id, message_id)` is the identity: replaying the same message returns the stored
     * row, so a companion that retries after a lost response cannot queue the instruction twice.
     * What is immutable is the *message* — its conversation, text and authored instant. A rewrite
     * of any of those is a conflict rather than an overwrite, because an edited message must not
     * be able to change what the host already accepted.
     *
     * `request_id` is deliberately NOT part of that comparison. It is the claim of whoever first
     * recorded the message: the native application's own UUID when the app claimed it first, or
     * the relay's derived UUID otherwise. A later observation of the same message from the other
     * source arrives with a *different* derived id, and the honest answer is to adopt the
     * persisted receipt id — one message is one durable instruction, and its identity cannot
     * depend on which observer happened to see it first.
     */
    putControllerMessage(row) {
      const existing = store.getControllerMessage(row.session_id, row.message_id);
      if (existing) {
        if (existing.conversation_id !== row.conversation_id ||
            existing.text !== row.text || existing.authored_at !== row.authored_at) {
          fail(
            WORK_ERROR_CODES.controllerMessageConflict,
            `CONTROLLER_MESSAGE_CONFLICT: message ${row.message_id} is already recorded with different content. Message payloads are immutable once accepted.`
          );
        }
        return existing;
      }
      transaction(() => {
        stmt.insertControllerMessage.run(
          row.session_id, row.message_id, row.conversation_id, row.request_id, row.text,
          row.authored_at, row.state, row.work_id, row.error,
          row.dispatch_text ?? null, row.context_assistant_id ?? null, row.claimed_at ?? null, row.created_at
        );
      });
      return store.getControllerMessage(row.session_id, row.message_id)!;
    },

    listPendingControllerMessages(limit, after) {
      const bound = limit ?? 100;
      const cursor = after ?? { created_at: 0, session_id: '', message_id: '' };
      return (stmt.listPendingControllerMessages.all(
        cursor.created_at, cursor.created_at, cursor.session_id, cursor.session_id, cursor.message_id, bound
      ) as Raw[]).map(controllerMessageFrom);
    },

    listPendingControllerMessagesForSession(sessionId, limit, after) {
      const bound = limit ?? 100;
      const cursor = after ?? { created_at: 0, session_id: '', message_id: '' };
      return (stmt.listPendingControllerMessagesForSession.all(
        sessionId, cursor.created_at, cursor.created_at, cursor.message_id, bound
      ) as Raw[]).map(controllerMessageFrom);
    },

    updateControllerMessage(sessionId, messageId, patch) {
      return transaction(() => {
        const current = store.getControllerMessage(sessionId, messageId);
        if (!current) {
          fail(WORK_ERROR_CODES.workNotFound, 'WORK_NOT_FOUND: no controller message with that session and message id exists.');
        }
        const columns: string[] = [];
        const values: Array<string | number | null> = [];
        const assign = (column: string, value: string | number | null): void => {
          columns.push(`${column} = ?`);
          values.push(value);
        };
        if (patch.state !== undefined) assign('state', patch.state);
        if (patch.work_id !== undefined) assign('work_id', patch.work_id);
        if (patch.error !== undefined) assign('error', patch.error);
        // The native application's own public UUID replaces the placeholder an observation recorded,
        // and only while nothing has claimed the row: `request_id` is the admission's identity, so
        // rewriting it after a claim would let a replay present a different command under the id the
        // ledger already committed. Unclaimed means pending, no work, and no frozen dispatch.
        if (patch.request_id !== undefined && patch.request_id !== current.request_id &&
            current.state === 'pending' && current.work_id === null && current.dispatch_text === null &&
            current.claimed_at === null) {
          assign('request_id', patch.request_id);
        }
        // The claim marker. A native call sets it when it takes the row and clears it when it lets
        // go; a released claim clears it together with the destination, so the row becomes
        // dispatchable again rather than looking claimed by a call that already gave up.
        if (patch.claimed_at !== undefined && patch.claimed_at !== current.claimed_at) {
          assign('claimed_at', patch.claimed_at);
        }
        // The frozen dispatch is write-once. A row that already carries one keeps exactly the
        // bytes the service hashed, so a replay under the same request id joins that command
        // instead of presenting a differently composed instruction as a conflict.
        if (patch.dispatch_text !== undefined && current.dispatch_text === null) {
          assign('dispatch_text', patch.dispatch_text);
          assign('context_assistant_id', patch.context_assistant_id ?? null);
        } else if (patch.context_assistant_id !== undefined && current.dispatch_text !== null && current.context_assistant_id === null) {
          // The quotation's provenance may be filled in by a later, better-informed pass, but only
          // while nothing has claimed it: it never changes the dispatch bytes themselves.
          assign('context_assistant_id', patch.context_assistant_id);
        }
        if (columns.length) {
          database.prepare(`UPDATE work_controller_messages SET ${columns.join(', ')} WHERE session_id = ? AND message_id = ?`)
            .run(...values, sessionId, messageId);
        }
        return store.getControllerMessage(sessionId, messageId)!;
      });
    },

    getControllerDelivery(deliveryId) {
      const row = stmt.getControllerDelivery.get(deliveryId) as Raw | undefined;
      return row ? controllerDeliveryFrom(row) : null;
    },

    /**
     * Records one event result destined for the original controller conversation.
     *
     * The `delivery_id` is derived from (work, event sequence) by the caller, so this is an
     * upsert in effect: an identical replay returns the stored row and a conflicting one is
     * refused, which is what keeps the relay from inventing a second copy of the same event.
     *
     * The binding authority — `bound_at` and the anchored `provider_account_id`, alongside the
     * session, conversation and work — is part of that comparison, not merely stored beside it. A
     * report is created for the binding that authorized it, and a later send must not be able to
     * adopt a newer binding (a rebound conversation, or a different signed-in account) by writing
     * the same delivery id again. The refusal is the point: silently re-pointing an already
     * recorded report would send work output to a chat the user never authorized for it.
     */
    putControllerDelivery(row) {
      const existing = store.getControllerDelivery(row.delivery_id);
      if (existing) {
        if (existing.session_id !== row.session_id || existing.conversation_id !== row.conversation_id ||
            existing.work_id !== row.work_id || existing.event_sequence !== row.event_sequence ||
            existing.text !== row.text || existing.bound_at !== row.bound_at ||
            existing.provider_account_id !== row.provider_account_id) {
          fail(
            WORK_ERROR_CODES.controllerDeliveryConflict,
            `CONTROLLER_DELIVERY_CONFLICT: delivery ${row.delivery_id} already exists with different content or a different binding authority. A delivery id identifies exactly one event result, for the binding that authorized it.`
          );
        }
        return existing;
      }
      transaction(() => {
        stmt.insertControllerDelivery.run(
          row.delivery_id, row.session_id, row.conversation_id, row.work_id, row.event_sequence,
          row.text, row.state, row.error, row.bound_at, row.provider_account_id, row.created_at, row.updated_at
        );
      });
      return store.getControllerDelivery(row.delivery_id)!;
    },

    listControllerDeliveries(sessionId) {
      const rows = sessionId === undefined
        ? (stmt.listControllerDeliveries.all() as Raw[])
        : (stmt.listControllerDeliveriesForSession.all(sessionId) as Raw[]);
      return rows.map(controllerDeliveryFrom);
    },

    updateControllerDelivery(deliveryId, patch) {
      return transaction(() => {
        if (!store.getControllerDelivery(deliveryId)) {
          fail(WORK_ERROR_CODES.workNotFound, 'WORK_NOT_FOUND: no controller delivery with that id exists.');
        }
        const columns: string[] = [];
        const values: Array<string | number | null> = [];
        const assign = (column: string, value: string | number | null): void => {
          columns.push(`${column} = ?`);
          values.push(value);
        };
        if (patch.state !== undefined) assign('state', patch.state);
        if (patch.error !== undefined) assign('error', patch.error);
        if (patch.event_sequence !== undefined) assign('event_sequence', patch.event_sequence);
        if (patch.text !== undefined) assign('text', patch.text);
        assign('updated_at', now());
        database.prepare(`UPDATE work_controller_deliveries SET ${columns.join(', ')} WHERE delivery_id = ?`)
          .run(...values, deliveryId);
        return store.getControllerDelivery(deliveryId)!;
      });
    }
  };

  function agentRecoveryJson(agentId: string): string | null {
    const row = database.prepare('SELECT recovery_json FROM work_agents WHERE agent_id = ?').get(agentId) as Raw | undefined;
    return textOrNull(row?.['recovery_json']);
  }

  function allAgents(): WorkAgentRow[] {
    return (database.prepare('SELECT * FROM work_agents ORDER BY created_at ASC').all() as Raw[]).map(agentFrom);
  }

  // A schema that no longer matches this build is damage, not an empty ledger.
  function verifySchema(): void {
    const required: Record<string, string[]> = {
      works: ['work_id', 'goal', 'status', 'revision', 'checkpoint_json', 'desired_state', 'predecessor_work_id', 'successor_work_id'],
      work_agents: ['agent_id', 'work_id', 'role', 'generation', 'conversation_id'],
      work_operations: ['operation_id', 'work_id', 'agent_id', 'args_hash', 'state'],
      work_commands: ['request_id', 'work_id', 'delivery_state', 'outbox_input_id'],
      work_events: ['work_id', 'sequence', 'kind', 'payload_json'],
      work_artifacts: ['artifact_id', 'work_id', 'session_id', 'asset_id'],
      work_controller_bindings: ['session_id', 'conversation_id', 'provider_account_id', 'work_id', 'enabled', 'event_cursor', 'origin'],
      work_controller_messages: ['session_id', 'message_id', 'conversation_id', 'request_id', 'state', 'authored_at', 'dispatch_text', 'context_assistant_id', 'claimed_at'],
      work_controller_deliveries: ['delivery_id', 'session_id', 'conversation_id', 'work_id', 'event_sequence', 'state', 'bound_at', 'provider_account_id']
    };
    for (const [table, columns] of Object.entries(required)) {
      const rows = database.prepare(`PRAGMA table_info(${table})`).all() as Raw[];
      if (!rows.length) {
        fail(WORK_ERROR_CODES.stateUnavailable, `STATE_UNAVAILABLE: the work ledger is missing its ${table} table. Refusing to treat damaged state as a new task.`);
      }
      const present = new Set(rows.map(row => String(row['name'])));
      for (const column of columns) {
        if (!present.has(column)) {
          fail(WORK_ERROR_CODES.stateUnavailable, `STATE_UNAVAILABLE: the work ledger's ${table} table is missing the ${column} column.`);
        }
      }
    }
    const quick = database.prepare('PRAGMA quick_check').get() as Raw | undefined;
    const verdict = String(quick?.['quick_check'] ?? '');
    if (verdict && verdict !== 'ok') {
      fail(WORK_ERROR_CODES.stateUnavailable, `STATE_UNAVAILABLE: the work ledger failed its integrity check (${verdict}).`);
    }
  }

  // The ledger file is 0600 and lives in a 0700 directory. The directory mode is the real
  // boundary: `-wal`/`-shm` siblings are created by SQLite on first write, after this point,
  // and are unreachable to other users because they cannot traverse the directory.
  sealFile(file);

  return store;
}

/** A random UUID for any ledger identity. Kept here so callers never invent their own. */
export function newLedgerId(): string {
  return randomUUID();
}
