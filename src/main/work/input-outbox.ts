import { z } from 'zod';
import { inputArgs, cancelUnsentInput, listInputs, onInputChange, retargetUnsentInput,
  type InputEntry, type InputMessageOrigin } from '../session/input.js';
import { sendDesktopInput, retryQueuedInputBrowser } from '../session/start-input.js';
import { getSession, readUserMessageByMessageId } from '../session/store.js';
import { userPromptText } from '../../shared/user-prompt.js';

/**
 * The work runtime's one door into the durable input outbox.
 *
 * A managed work has two message shapes, and they have opposite routing rules:
 *
 *  - an *instruction* is authored work control. It follows the prime session's current
 *    conversation, because Compact & Resume legitimately moves that session to a new chat.
 *  - a *controller report* is an automatically generated result travelling back to the
 *    conversation that asked for it. It is frozen to that exact conversation, carries durable
 *    generated provenance, and is never treated as a new human requirement.
 *
 * Both are addressed by the persisted command id, which is also the outbox row id. That single
 * identity is what makes a retry after a lost acknowledgement recover the row that already
 * exists instead of admitting a second copy of the same message.
 */

export type WorkInputState = 'queued' | 'delivered' | 'unknown' | 'failed' | 'cancelled';

export interface WorkInputResult {
  state: WorkInputState;
  error?: string;
}

export interface WorkInputRequest {
  /** Persisted command id; also the outbox input id. */
  id: string;
  sessionId: string | null;
  text: string;
  model: string | null;
  reasoning: string | null;
  /** `command.created_at`. Authoritative only for the first admission of this id. */
  dueAt: number;
  /** Omitted means `instruction`; a `workId` without a kind means a controller report. */
  kind?: 'instruction' | 'controller-report';
  /**
   * A controller report MUST supply the authority it was produced under, exactly as the
   * controller recorded it at delivery creation: `workId`, `conversationId`,
   * `providerAccountId` and `boundAt`. None of them is defaulted from the current binding —
   * a report that cannot state its own destination is refused instead of being routed by
   * today's state. Instructions ignore these fields.
   */
  workId?: string | null;
  conversationId?: string | null;
  providerAccountId?: string | null;
  boundAt?: number | null;
}

const workInputArgs = z.object({
  id: inputArgs.shape.id,
  sessionId: inputArgs.shape.sessionId,
  text: inputArgs.shape.text,
  model: inputArgs.shape.model,
  reasoning: inputArgs.shape.reasoningEffort,
  dueAt: inputArgs.shape.dueAt,
  kind: z.enum(['instruction', 'controller-report']).optional(),
  workId: z.uuid().nullable().optional(),
  /** The controller binding epoch this report was produced under, when the caller knows it. */
  boundAt: z.number().nonnegative().nullable().optional(),
  conversationId: z.string().min(8).max(256).nullable().optional(),
  providerAccountId: z.string().min(1).max(256).nullable().optional()
});

type WorkInput = z.infer<typeof workInputArgs>;

/** Reports never interrupt a live generation; they wait for the same settled boundary as a checkpoint. */
const reportMode = 'after-turn' as const;

/**
 * The one projection of an outbox row onto a work delivery outcome.
 *
 * `delivered` requires positive proof of receipt — a native send ACK, or a tool handout whose
 * later exact invocation proved it arrived. A row that has only been *offered* is still queued.
 * A row the browser may already have submitted is `unknown`: that ambiguity is never resolved by
 * guessing, and never resolved by sending again.
 */
function workInputResult(row: Pick<InputEntry, 'state' | 'error' | 'sendAuthorizedAt' | 'deliveredAt' | 'messageId' | 'requiresAuthorization' | 'owner'>): WorkInputResult {
  // Positive receipt outranks the local state label: a cancelled row whose later native ACK
  // arrived is delivered, not cancelled, and its ambiguity is over.
  if (row.state === 'sent' || (row.messageId && Number.isFinite(row.deliveredAt))) return { state: 'delivered' };
  // Offered to a tool response is not receipt; the row stays queued until a later call proves it.
  if (row.state === 'tool') return { state: 'queued' };
  // A queued row was never handed to a document, so it is provably unsent — unless it somehow
  // still carries Send authorization, which would mean it may already have been submitted.
  if (row.state === 'queued') return row.sendAuthorizedAt === undefined ? { state: 'queued' } : { state: 'unknown', error: row.error };
  // The only claim that is provably unsent is one still behind its separate final Send
  // authorization. A claim without that fence already carried send authority when it was handed
  // out, and a row that reached Send authorization owns an outcome nobody can prove — reporting
  // either as queued, cancelled or failed would hide a message that may already be in ChatGPT.
  const fenced = row.requiresAuthorization === true && row.sendAuthorizedAt === undefined;
  if (row.state === 'browser') return fenced ? { state: 'queued' } : { state: 'unknown' };
  if (row.sendAuthorizedAt !== undefined) return { state: 'unknown', error: row.error };
  if (!fenced && !!row.owner) return { state: 'unknown', error: row.error };
  return row.state === 'failed'
    ? { state: 'failed', error: row.error ?? 'the message could not be queued' }
    : { state: 'cancelled', error: row.error };
}

/** The kind a row was admitted under, so a retry cannot silently change what it is. */
function kindOf(row: InputEntry): 'instruction' | 'controller-report' {
  return row.generatedBy ? 'controller-report' : 'instruction';
}

function requestedSessionOf(row: InputEntry): string | null {
  return row.opening ? row.requestedSessionId ?? null : row.sessionId;
}

/**
 * The stable semantic identity of one work message.
 *
 * Deliberately excludes mutable delivery projections (`state`, `owner`, `offeredAt`,
 * `sendAuthorizedAt`, `messageId`, …). A retry of the identical command must match its prior row
 * even after that row advanced; a retry carrying *different* content must never be absorbed into
 * the old row, which is why text/model/effort are compared exactly.
 */
function sameWorkMessage(row: InputEntry, input: WorkInput): boolean {
  if (kindOf(row) !== input.kind || row.text !== input.text) return false;
  if ((row.model ?? null) !== input.model || (row.reasoningEffort ?? null) !== input.reasoning) return false;
  // An instruction follows its prime session, and Compact & Resume legitimately rebinds that
  // session while the command is still unacknowledged, so a session-only difference recovers the
  // existing row. A report is frozen to the work, conversation, account and binding epoch that
  // asked for it: any mismatch there is a routing error, and reusing the old row would send
  // another work's result to the wrong authority.
  if (input.kind === 'instruction') return true;
  const pinned = row.generatedBy;
  return requestedSessionOf(row) === input.sessionId &&
    (pinned?.workId ?? null) === input.workId &&
    (pinned?.conversationId ?? null) === input.conversationId &&
    (pinned?.providerAccountId ?? null) === input.providerAccountId &&
    (pinned?.boundAt ?? null) === input.boundAt;
}

/** The controller binding the report owner maintains; read-only, and never invented here. */
export type WorkInputBindingQuery = (sessionId: string) => {
  /** Every work this one controller owns, walking its durable continuation chain in both directions. */
  workIds: readonly string[];
  conversationId: string;
  providerAccountId: string | null;
  boundAt: number;
  enabled: boolean;
} | null;

let bindingQuery: WorkInputBindingQuery | null = null;

/** Installed by the host so one queued report can be fenced against its owner's live authority. */
export function setWorkInputBindingQuery(query: WorkInputBindingQuery | null): void {
  bindingQuery = query;
}

/**
 * Whether a generated work message may still be delivered.
 *
 * A report answers to the controller that produced it: the feature must still be enabled, the
 * work must belong to that controller's continuation chain, and the conversation, anchored
 * provider account and binding epoch must be the exact ones the report was produced under.
 * Normal continuation moves a controller from a work to its successor without changing the chat,
 * and the predecessor's completion report still belongs to that same controller, so the chain —
 * not the current tail alone — is what ownership means. A rebind to an unrelated work, another
 * account, or a conversation whose account is still unproven stays fenced.
 */
export function workInputAllowed(entry: Pick<InputEntry, 'sessionId' | 'generatedBy'>): boolean {
  const pinned = entry.generatedBy;
  if (!pinned) return true;
  const binding = entry.sessionId ? bindingQuery?.(entry.sessionId) ?? null : null;
  if (!binding?.enabled) return false;
  if (pinned.workId !== null && !binding.workIds.includes(pinned.workId)) return false;
  if (pinned.conversationId && binding.conversationId !== pinned.conversationId) return false;
  // The same conversation id under another account is a different chat. A binding whose account is
  // still unproven (null) is *not* a wildcard: an unanchored conversation cannot authorize a
  // report, so this defers until the first authenticated snapshot anchors the account.
  if (!pinned.providerAccountId || binding.providerAccountId !== pinned.providerAccountId) return false;
  return pinned.boundAt === null || binding.boundAt === pinned.boundAt;
}

/** The work runtime's own live authority over one managed instruction; read-only. */
export type WorkInputInstructionQuery = (workId: string) => {
  /** The session the work's prime is bound to right now, or null before it is bound. */
  primeSessionId: string | null;
  /** True while the work is neither paused, cancelled nor finished. */
  active: boolean;
} | null;

let instructionQuery: WorkInputInstructionQuery | null = null;

/** Installed by the host so a queued managed instruction can be fenced against its own work. */
export function setWorkInputInstructionQuery(query: WorkInputInstructionQuery | null): void {
  instructionQuery = query;
}

/**
 * Whether a managed instruction may still be delivered.
 *
 * The work that asked for it stays its authority through the final Send: a pause, cancel or
 * completion withdraws an already-queued row, and a row still addressed to a retired prime session
 * is refused rather than sent into the conversation the user already moved away from. A retry of
 * that same command moves the row to the current prime through the outbox's serialized retarget.
 */
export function workInstructionAllowed(entry: Pick<InputEntry, 'sessionId' | 'workInput'>): boolean {
  const workId = entry.workInput?.workId;
  if (!workId) return true;
  const authority = instructionQuery?.(workId) ?? null;
  if (!authority?.active || !authority.primeSessionId) return false;
  return entry.sessionId === authority.primeSessionId;
}

function requestOf(raw: WorkInputRequest): WorkInput {
  const parsed = workInputArgs.safeParse(raw);
  if (!parsed.success) {
    const issue = parsed.error.issues[0];
    throw new Error(`Invalid work input${issue ? ` at ${issue.path.join('.') || 'value'}: ${issue.message}` : ''}`);
  }
  const value = parsed.data;
  const kind = value.kind ?? (value.workId ? 'controller-report' as const : 'instruction' as const);
  if (kind !== 'controller-report') return { ...value, kind, workId: value.workId ?? null };
  // A report must name the authority it was produced under, exactly as the controller recorded it.
  // Nothing here may fall back to whatever binding the session has now: a report that cannot state
  // its own destination, work, account and epoch would be routed by today's state instead.
  const missing = (['sessionId', 'workId', 'conversationId', 'providerAccountId', 'boundAt'] as const)
    .filter(field => value[field] === null || value[field] === undefined);
  if (missing.length) throw new Error(`A controller report needs its original ${missing.join(', ')}`);
  return { ...value, kind, workId: value.workId! };
}

function toInputArgs(input: WorkInput): z.infer<typeof inputArgs> {
  return inputArgs.parse({
    id: input.id,
    sessionId: input.sessionId,
    text: input.text,
    mode: input.kind === 'controller-report' ? reportMode : 'auto',
    dueAt: input.dueAt,
    model: input.model,
    reasoningEffort: input.reasoning
  });
}

/**
 * Admits, retries or reports one durable work message.
 *
 * Retrying an id that already exists never admits a second row: the prior row's own persisted
 * `dueAt` stands, so a crash between the ledger write and the outbox commit cannot manufacture a
 * new identity conflict out of a fresh clock reading.
 *
 * What a retry may still do is narrow and explicit. A *managed instruction* whose prime session
 * changed — Compact & Resume — has its existing row moved to that session through the outbox's
 * serialized pre-Send retarget, because the message is still owed and only its destination
 * changed. Anything else is a state read, plus the outbox's own browser wake for a row that
 * recorded a startup failure. A report never moves: its authority is frozen, and a mismatch there
 * is a routing error rather than a rebind.
 */
export async function deliverWorkInput(raw: WorkInputRequest): Promise<WorkInputResult> {
  let input: WorkInput;
  try {
    input = requestOf(raw);
  } catch (error) {
    return { state: 'failed', error: (error as Error).message };
  }
  track(input.id);
  try {
    const prior = (await listInputs()).find(row => row.id === input.id);
    if (prior) {
      if (!sameWorkMessage(prior, input)) return { state: 'failed', error: 'Message id already belongs to different work input' };
      // The only difference an instruction tolerates is its session, and that difference has a
      // real consequence: Compact & Resume moved the prime, so the row must move with it. The
      // move is a serialized pre-Send retarget — never a second admission — and it is refused for
      // anything a document could already have submitted, which then stays a read-only unknown.
      if (input.kind === 'instruction' && requestedSessionOf(prior) !== input.sessionId && input.sessionId) {
        await retargetUnsentInput(prior.id, input.sessionId);
        const moved = (await listInputs()).find(row => row.id === input.id) ?? prior;
        return workInputResult(moved);
      }
      // This id already owns a durable row. The retry is a state read, never a second admission:
      // the only thing it may still do is re-offer the browser wake for a row that recorded a
      // startup failure, which is the same retry path the outbox already exposes.
      if (prior.state === 'queued' && prior.error) await retryQueuedInputBrowser(prior.id).catch(() => null);
      return workInputResult(prior);
    }
    const generatedBy = input.kind === 'controller-report'
      ? { kind: 'work-report' as const, workId: input.workId!, conversationId: input.conversationId!,
          providerAccountId: input.providerAccountId!, boundAt: input.boundAt! }
      : undefined;
    await sendDesktopInput(toInputArgs(input),
      { ...(generatedBy ? { generatedBy } : {}), ...(input.kind === 'instruction' && input.workId ? { workInput: { workId: input.workId } } : {}) });
  } catch (error) {
    return { state: 'failed', error: (error as Error).message };
  }
  const row = (await listInputs()).find(entry => entry.id === input.id);
  if (!row) return { state: 'failed', error: 'the message was not admitted to the outbox' };
  return workInputResult(row);
}

/**
 * Withdraws one work message the user no longer wants sent.
 *
 * Only a row that is provably still ours is cancelled: unclaimed, and either never handed to a
 * document or handed out without a final Send authorization. A row that reached Send keeps its
 * custody — the outcome is genuinely unknown and cancelling it would only hide that.
 */
export async function cancelWorkInput(id: string): Promise<boolean> {
  // The check and the withdrawal happen inside the outbox's own serialized transaction, so a
  // Send authorization racing this call cannot turn a proven-unsent row into a cancelled-but-sent
  // one. `true` therefore always means "provably not delivered".
  return await cancelUnsentInput(id);
}

/**
 * The read-only projection of one work message, keyed by the same id as `deliverWorkInput`.
 *
 * Reconciliation after an ambiguous hand-off needs the outbox's current verdict without waking,
 * re-claiming or re-sending anything: this never touches the transport. It does register the id
 * for change notification, because after a restart this read is the only thing that names the
 * rows the runtime is still waiting on.
 */
export async function readWorkInput(id: string): Promise<WorkInputResult | null> {
  // Registered before the read: an ACK that commits while this awaits must not be missed, and a
  // notification for an id that turns out not to exist is dropped immediately below.
  track(id);
  const row = (await listInputs()).find(entry => entry.id === id);
  if (!row) { untrack(id); return null; }
  return workInputResult(row);
}

// ---------------------------------------------------------------------------------------------
// Generated-origin queries
// ---------------------------------------------------------------------------------------------

/** The input owner's provenance vocabulary, re-exported for the work runtime's ports. */
export type WorkInputOrigin = InputMessageOrigin;

export interface WorkGeneratedInputMatch {
  inputId: string;
  workId: string | null;
  matchedBy: 'message-id' | 'pending-echo';
}

const GENERATED = 'generated' as const;

/** Rows that own the delivery of an app-generated work message in one session. */
function reportRows(rows: readonly InputEntry[], sessionId: string): InputEntry[] {
  return rows.filter(row => row.generatedBy && row.sessionId === sessionId);
}

/** The exact bytes a row would put on the wire, before or after its claim froze them. */
function wireBytes(row: InputEntry): string[] {
  return row.deliveryText && row.deliveryText !== row.text ? [row.deliveryText, row.text] : [row.text];
}

function sameBytes(left: string, right: string): boolean {
  if (left === right) return true;
  const authoredLeft = userPromptText(left) ?? left;
  const authoredRight = userPromptText(right) ?? right;
  return authoredLeft === authoredRight || authoredLeft === right || left === authoredRight;
}

/**
 * Whether a report row could have produced this message *before* its native id was known.
 *
 * Text equality alone is never enough — a human message that happens to read like an unsent
 * report must not be suppressed. The row must also be ours and causally able to have been
 * submitted: a document was handed it, it is still awaiting its receipt, and it is bound to the
 * same conversation this message was observed in. The claim's frozen wire text is compared too,
 * because a transport-only suffix is not part of what the user would have typed.
 */
function pendingEchoRow(row: InputEntry, text: string, conversationId: string | null): boolean {
  if (row.messageId) return false;
  // Only a row the page could plausibly have submitted is ambiguous. That means it was actually
  // handed to a document: either behind the separate final Send authorization, or under a legacy
  // claim that carried send authority immediately. A row still waiting in the queue was never
  // submitted, so a message with the same words is somebody else's and stays human.
  const handedOut = row.sendAuthorizedAt !== undefined || (!!row.owner && row.requiresAuthorization !== true);
  if (!handedOut) return false;
  if (conversationId && row.conversationId && row.conversationId !== conversationId) return false;
  return wireBytes(row).some(bytes => sameBytes(bytes, text));
}

/**
 * Classifies one recorded user message as app-generated work, a human requirement, or an
 * unresolved echo.
 *
 * `unknown` is the honest answer for a message whose bytes match a report we are still waiting to
 * have acknowledged: the message may be the page echoing our own send, or it may be a human who
 * typed the same words. Callers defer on it and re-check once the native id or input id lands.
 */
export async function workInputOrigin(sessionId: string, messageId: string | null | undefined, text?: string): Promise<WorkInputOrigin> {
  // A storage failure is never "no generated rows": reporting `human` from an unreadable outbox
  // would silently promote an app-generated result into a new user requirement. The read errors
  // propagate so the caller defers instead.
  const [event, rows, session] = await Promise.all([
    // The exact canonical row, not a tail window: a report's provenance must still answer after
    // hundreds of later messages, when its outbox row has long been retired.
    messageId ? readUserMessageByMessageId(sessionId, messageId) : Promise.resolve(null),
    listInputs(),
    getSession(sessionId)
  ]);
  // Canonical provenance outlives the outbox row that produced it: a delivered report carries
  // `generated` on the recorded message itself.
  if (event?.generated === true) return GENERATED;
  const reports = reportRows(rows, sessionId);
  if (!reports.length) return 'human';
  const ids = new Set(reports.map(row => row.id));
  if (event?.inputId && ids.has(event.inputId)) return GENERATED;
  if (messageId && reports.some(row => row.messageId === messageId)) return GENERATED;
  if (!text) return 'human';
  const conversationId = session?.conversationId ?? null;
  // A row that was already resolved with a different native id cannot be the source of this one.
  if (reports.some(row => pendingEchoRow(row, text, conversationId))) return 'unknown';
  return 'human';
}

/** True only for proven generated origin; `unknown` never suppresses a message. */
export async function isWorkGeneratedInputMessage(sessionId: string, messageId: string | null | undefined, text?: string): Promise<boolean> {
  return await workInputOrigin(sessionId, messageId, text) === GENERATED;
}

/** The exact report row behind a proven generated message, for audit and work-control fencing.
 *
 * The canonical recording is consulted first: it is the durable provenance and survives the
 * outbox row being retired, so an old report is still identified by its native id long after any
 * bounded tail window has moved past it. */
export async function findWorkGeneratedInputMessage(sessionId: string, messageId: string | null | undefined, text?: string): Promise<WorkGeneratedInputMatch | null> {
  const [rows, event] = await Promise.all([
    listInputs(),
    messageId ? readUserMessageByMessageId(sessionId, messageId) : Promise.resolve(null)
  ]);
  const reports = reportRows(rows, sessionId);
  if (messageId && event?.inputId) {
    const byCanonical = reports.find(row => row.id === event.inputId);
    // The canonical row is authoritative even after its outbox row was retired, so the identity is
    // still reported — with no work id left to attribute it to.
    if (byCanonical) return { inputId: byCanonical.id, workId: byCanonical.generatedBy!.workId, matchedBy: 'message-id' };
    if (event.generated === true) return { inputId: event.inputId, workId: null, matchedBy: 'message-id' };
  }
  if (!reports.length) return null;
  if (messageId) {
    const byId = reports.find(row => row.messageId === messageId);
    if (byId) return { inputId: byId.id, workId: byId.generatedBy!.workId, matchedBy: 'message-id' };
  }
  if (!text) return null;
  const session = await getSession(sessionId);
  const pending = reports.find(row => pendingEchoRow(row, text, session?.conversationId ?? null));
  return pending ? { inputId: pending.id, workId: pending.generatedBy!.workId, matchedBy: 'pending-echo' } : null;
}

/** The renderer's outbox never shows app-generated work as if the user had written it. */
export function userVisibleInput(row: Pick<InputEntry, 'purpose' | 'generatedBy'>): boolean {
  return row.purpose !== 'decision' && !row.generatedBy;
}

// ---------------------------------------------------------------------------------------------
// Change notification
// ---------------------------------------------------------------------------------------------

const tracked = new Set<string>();
const verdicts = new Map<string, string>();
const listeners = new Set<(ids: readonly string[]) => void>();
let attached = false;
let publishing: Promise<void> | null = null;
let pending = false;

/** The mapping's own answer: a listener is notified exactly when that answer can change. */
function verdictOf(row: InputEntry): string {
  const result = workInputResult(row);
  return `${result.state}\u0000${result.error ?? ''}`;
}

/**
 * Publishes committed outbox transitions for work messages the runtime is still waiting on.
 *
 * This observes the existing durable commit — it invents no retry timer and no second ledger. A
 * listener re-reads the rows it cares about; a lost notification is never lost state.
 */
export function onWorkInputChanged(listener: (ids: readonly string[]) => void): () => void {
  attach();
  listeners.add(listener);
  return () => { listeners.delete(listener); };
}

function track(id: string): void {
  tracked.add(id);
  attach();
}

function untrack(id: string): void {
  tracked.delete(id);
  verdicts.delete(id);
}

function attach(): void {
  if (attached) return;
  attached = true;
  onInputChange(schedule);
}

/**
 * One publish at a time, and always one more after a commit that arrived mid-run.
 *
 * `listInputs` itself can commit (materializing checkpoints), which re-enters this observer; the
 * coalescing keeps that bounded while still guaranteeing the newest state is published.
 */
function schedule(): void {
  if (publishing) { pending = true; return; }
  publishing = (async () => {
    do { pending = false; await publish(); } while (pending);
  })().finally(() => { publishing = null; });
}

async function publish(): Promise<void> {
  if (!tracked.size) return;
  let rows: InputEntry[];
  try { rows = await listInputs(); } catch { return; }
  const present = new Map(rows.map(row => [row.id, row]));
  const changed: string[] = [];
  for (const id of tracked) {
    const row = present.get(id);
    const verdict = row ? verdictOf(row) : 'absent';
    if (verdicts.get(id) === verdict) continue;
    verdicts.set(id, verdict);
    changed.push(id);
  }
  if (!changed.length) return;
  for (const listener of listeners) { try { listener(changed); } catch { /* observer only */ } }
}

export function resetWorkInputForTests(): void {
  tracked.clear(); verdicts.clear(); listeners.clear(); pending = false;
}
