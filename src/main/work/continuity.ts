/**
 * Mobile conversation continuity: one durable controller conversation per work.
 *
 * A phone (or any other ChatGPT conversation the host can authenticate) can drive managed work
 * without a browser page of its own. The user message that arrives there is *not* a tool call, so
 * this module is the only place that turns an authenticated provider observation into a durable
 * instruction, and the only place that turns durable work events back into a message in that same
 * conversation.
 *
 * Five rules carry the whole design, and each exists because the obvious alternative is wrong:
 *
 * 1. **One controller per work, never guessed.** A binding is created only from proven identity:
 *    an explicit local `bindWorkController` call, the first managed prime that owns a work (so a
 *    desktop-started work can be continued from the chat that started it), or a proven MCP
 *    `CallCaller` that started or instructed a work. An observation from an unbound conversation
 *    is refused, never promoted into a binding — a message is not authority.
 * 2. **No duplicate execution.** When the controller *is* the work's live prime, its native
 *    message is already being handled by that prime, so the observation is recorded as a receipt
 *    and nothing is injected. When the controller's own model turn already drove the work (it
 *    called `work start`/`instruct`/`resume` for this exact provider message), the relay maps to
 *    that same durable inbox receipt instead of admitting a second instruction. A generated
 *    report turn may never authorize work at all.
 * 3. **The provider message id is the identity.** The inbox is keyed by
 *    `(session_id, message_id)` with an immutable payload, so a retry after a lost response cannot
 *    queue the instruction twice, and an edited message cannot rewrite what was already accepted.
 * 4. **Ordered, not newest-only.** A controller may write requirements, then a correction, then
 *    "go". A fresh snapshot therefore carries the whole active-branch tail, and every admitted
 *    message on that branch is routed oldest-first. Nothing here ever picks "the latest message".
 * 5. **Reports are addressed, not broadcast.** A status/final report is written only to the
 *    binding's own session *and* conversation, carries its own durable delivery id through the
 *    existing input outbox, and records what that outbox actually established (`queued` is not
 *    `delivered`, and `unknown` is never retried as if it had not happened).
 *
 * Nothing here polls a timer, unpauses work, cancels work, or follows "the latest work". Every
 * send is guarded by `stopped`, every routing decision is guarded by the binding that was durable
 * when the message was observed, and a message that outlived the process must be re-proved by a
 * fresh authenticated snapshot before it may execute.
 */

import { createHash, randomUUID } from 'node:crypto';

import { WORK_EVENT_KINDS, workInstructionSchema } from '../../shared/work.js';
import type { WorkReceipt } from '../../shared/work.js';
import type {
  WorkControllerBinding,
  WorkControllerDelivery,
  WorkControllerMessage,
  WorkControllerObservation,
  WorkControllerSnapshot,
  WorkControllerWatch
} from '../../shared/work-continuity.js';
import { logInfo, logWarn } from '../logger.js';
import { getSession, readCompletedFinal, readEvents, readRecentEvents } from '../session/store.js';
import { requestCorrelation } from '../session/correlation.js';
import type { WorkServiceHandle } from './service.js';
import type { ControllerInboxCursor, WorkRow, WorkStore } from './store.js';

// --------------------------------------------------------------------------- ports

/** One report handed to the durable input outbox. `id` is the durable delivery id. */
export interface ControllerReport {
  id: string;
  sessionId: string;
  /** The conversation this report was produced for, pinned at admission. */
  conversationId: string;
  /** The binding epoch it was admitted under: a later re-bind does not revive it. */
  boundAt: number;
  /** The anchored provider account of that binding. Never null: a report waits for the anchor. */
  providerAccountId: string;
  text: string;
  model: string | null;
  reasoning: string | null;
  /** Stable `dueAt`: the delivery row's own creation time, never a re-derived `Date.now()`. */
  dueAt: number;
  workId: string;
}

/** What the outbox actually established. Mirrors the input outbox's own vocabulary. */
export interface ControllerReportResult {
  state: 'queued' | 'delivered' | 'unknown' | 'failed' | 'cancelled';
  error?: string;
}

/** The input owner's provenance verdict for one exact provider user message. */
export type WorkMessageOrigin = 'generated' | 'human' | 'unknown';

export interface WorkContinuityDeps {
  store: WorkStore;
  /** The live service, or null before the ledger is restored / after it closes. */
  service: () => WorkServiceHandle | null;
  /**
   * Host-side proof that a conversation has no live generation, from the input owner's own
   * policy. Injected rather than re-derived so there is one settle authority.
   */
  conversationSettled: (input: { sessionId: string; conversationId: string }) => Promise<boolean>;
  /** Whether an exact provider user message is an app-generated work report. */
  messageOrigin: (input: { sessionId: string; messageId: string; text?: string }) => Promise<WorkMessageOrigin>;
  /** Delivers one report through the existing input outbox. */
  deliverReport: (input: ControllerReport) => Promise<ControllerReportResult>;
  /** Withdraws one still-unclaimed report row. False means it may already have been sent. */
  cancelReport: (input: { id: string; reason: string }) => Promise<boolean>;
  /**
   * Read-only reconciliation of one report against its durable outbox row.
   *
   * Called for `unknown` deliveries only, and it must never re-send: it answers what the outbox
   * now knows about that same stable input id (`delivered` once its native receipt landed, or
   * `unknown` while the hand-off is still ambiguous). Omitted means unknown stays unknown.
   */
  reconcileReport?: (input: { id: string; sessionId: string }) => Promise<ControllerReportResult | null>;
  /** Wake on committed outbox transitions; omitted in tests, which drive `pumpNow`. */
  onDeliveryChange?: (listener: () => void) => () => void;
  /**
   * Durable proof that one *provider request* already executed managed work for this work.
   *
   * The runtime records one receipt per provider request on the admitted path of the managed gate
   * — after the durable operation receipt, before the handler — so a `true` answer here means an
   * operation was genuinely admitted for that exact request under this work. Nothing weaker is
   * accepted: not an ended turn, not a recorded call, not any historical operation of the prime's
   * session. Omitted means "no proof available", and the manager then relays the message instead of
   * treating it as already handled.
   */
  nativeExecution?: (input: { workId: string; providerRequestId: string }) => boolean;
  now?: () => number;
}

export type WorkControllerObservationResult =
  | { state: 'accepted'; messageId: string; workId: string }
  | { state: 'duplicate'; messageId: string; workId: string | null }
  | { state: 'unbound' }
  | { state: 'generated' }
  | { state: 'stale' }
  | { state: 'unproven' }
  | { state: 'rejected'; error: string };

// --------------------------------------------------------------------------- bounds

/** Reports are one bounded message; a long run coalesces instead of flooding the chat. */
const REPORT_MAX_CHARS = 4000;
const REPORT_EVENT_SAMPLE = 12;
const REPORT_PAGE_LIMIT = 50;
/** Pages read per pass; the walk continues while the store says there is more. */
const REPORT_PAGE_MAX = 500;
/** One report per binding per interval unless the work reached a terminal state. */
const REPORT_MIN_INTERVAL_MS = 5_000;
/**
 * The one-line marker that separates a relayed instruction from the quoted message it follows.
 *
 * The work executes in a different conversation, so the reader has to be able to tell the user's own
 * words from the earlier message they refer to — that is transport, and it is the only thing this
 * line says. It carries no instruction about what to do with either part: authorization, provenance
 * and duplicate suppression are decided by the ledger and by structured fields, never by prose in
 * the payload.
 */
const CONTEXT_LABEL = '--- quoted from the same conversation ---';
/** Provider message ids kept as process-local settle evidence; restart re-proves from a snapshot. */
const EVIDENCE_MAX = 512;
/** Admitted messages routed per call, so a long backlog never outlives its own evidence. */
const SNAPSHOT_ROUTE_CHUNK = 32;
/**
 * Rows read per page while walking pending inbox rows.
 *
 * A page bound, never a page *cap*: every walk continues while the query keeps returning a full page
 * and stops when a page changes nothing, so a long backlog is covered in full rather than silently
 * truncated after an arbitrary number of pages.
 */
const RECOVERY_PAGE_LIMIT = 100;

/**
 * The event kinds that *are* an ending: the work reached a state a final report is owed for.
 *
 * The set is closed and each kind is written by the transition itself, so the *sequence* of one of
 * these events is a stable identity for "this is the ending we already reported", independent of any
 * event appended afterwards — a late acknowledgment, an audit row or an instruction receipt.
 */
const FINAL_EVENT_KINDS = new Set<string>([
  WORK_EVENT_KINDS.workCompleted,
  WORK_EVENT_KINDS.cancelled,
  WORK_EVENT_KINDS.workBlocked,
  WORK_EVENT_KINDS.paused
]);
/**
 * The factual states an ending report answers to.
 *
 * `paused` and `blocked` are endings because they end a run the user was watching, and `resume`
 * leaves them: a work that resumed is running again, so its progress is reported normally. This is
 * checked against the work's *current* status, which is what keeps a historical ending from
 * silencing every later report.
 */
const ENDING_STATUSES = new Set<string>(['completed', 'cancelled', 'paused', 'blocked']);

// --------------------------------------------------------------------------- helpers

/**
 * A deterministic UUID for one durable inbox message.
 *
 * The relay and the controller's own model turn must be able to name the *same* durable request
 * without exchanging anything, so the id is derived from the message identity rather than
 * generated per caller. That is also what makes crash recovery exact: the inbox row's
 * `request_id` is the work command's `request_id`, so the persisted service receipt can be read
 * back for the admission the process died inside.
 */
export function controllerRequestId(sessionId: string, messageId: string): string {
  const digest = createHash('sha256').update(`continuity\0${sessionId}\0${messageId}`, 'utf8').digest();
  const bytes = Buffer.from(digest.subarray(0, 16));
  bytes[6] = (bytes[6]! & 0x0f) | 0x50;
  bytes[8] = (bytes[8]! & 0x3f) | 0x80;
  const hex = bytes.toString('hex');
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}

/**
 * How an observation's provider account relates to the binding's anchor.
 *
 * `conflict` is a different account for an anchored conversation, `unproven` is a missing account
 * where an anchor exists or is being established, `anchor` is the first proof that establishes the
 * anchor, and `match` is the proven same account. An absent account is never treated as matching.
 */
function accountProof(anchor: string | null, observed: string | null): 'match' | 'anchor' | 'conflict' | 'unproven' {
  if (anchor === null) return observed === null ? 'unproven' : 'anchor';
  if (observed === null) return 'unproven';
  return anchor === observed ? 'match' : 'conflict';
}

function bounded(text: string, limit: number): string {
  return text.length <= limit ? text : `${text.slice(0, limit)}…[truncated; the work ledger retains the full text]`;
}

/** Serializes work per binding, so two admissions for one controller cannot interleave. */
function serialize<T>(queues: Map<string, Promise<unknown>>, key: string, run: () => Promise<T>): Promise<T> {
  const work = (queues.get(key) ?? Promise.resolve()).then(run, run);
  const settled = work.then(() => undefined, () => undefined);
  queues.set(key, settled);
  void settled.then(() => { if (queues.get(key) === settled) queues.delete(key); });
  return work;
}

// --------------------------------------------------------------------------- manager

export interface WorkContinuityHandle {
  observe(input: WorkControllerObservation): WorkControllerObservationResult;
  /** A fresh, authenticated page snapshot: the only proof a recovered message may execute on. */
  snapshot(input: WorkControllerSnapshot): Promise<void>;
  /** The enabled bindings this browser must read, each with a fresh observation token. */
  watches(): WorkControllerWatch[];
  /** Retires one binding's read authority, so an in-flight read can no longer be applied. */
  rotateAuthority(sessionId: string): void;
  recover(): Promise<void>;
  pumpNow(): Promise<void>;
  stop(): Promise<void>;
}

/** One binding's live read authority: the token a watch handed out, and the binding it described. */
interface ObservationAuthority {
  token: string;
  conversationId: string;
  boundAt: number;
  workId: string;
}

/**
 * The transport pages of one authenticated read, buffered until the last page arrives.
 *
 * `pages` is indexed by page index, and an entry that is absent means that page has not arrived.
 * `complete` is the read's own answer about whether the provider graph walk was exhaustive — never
 * whether this body holds everything — so a read that said `false` still assembles and still
 * records membership; it just never executes anything.
 */
interface AssembledRead {
  conversationId: string;
  providerAccountId: string | null;
  complete: boolean;
  settled: boolean;
  lastIndex: number;
  pages: Array<WorkControllerSnapshot['messages'] | undefined>;
}

/** Whether one message is on the active branch, whether the branch settled, and its own context. */
interface Evidence {
  onBranch: boolean;
  /** True proven idle, false proven generating, null unobserved at that moment. */
  settled: boolean | null;
  /** This message's own preceding assistant text, quoted so a reference to "that plan" survives. */
  context: string | null;
  /** The exact assistant message that quotation came from, when the observer proved which. */
  contextAssistantId: string | null;
  /**
   * The provider's own request id for this user message, when the observer could read it.
   *
   * This is the only lineage a chat the host never recorded can offer, and it is what lets the
   * relay ask whether this exact question already executed managed work.
   */
  requestId: string | null;
  /**
   * The branch authority this proof belongs to.
   *
   * A proof is only usable while the branch authority that produced it is still the newest one: a
   * newer authenticated snapshot describes the branch as it is *now*, so a chunk, a route or a
   * pending row still holding the older generation's proof is stale evidence and may not admit
   * anything.
   */
  generation: number;
}

export function createWorkContinuity(deps: WorkContinuityDeps): WorkContinuityHandle {
  const { store } = deps;
  const now = deps.now ?? (() => Date.now());
  const queues = new Map<string, Promise<unknown>>();
  /** One report pump per binding, so concurrent snapshots cannot each create the same report. */
  const pumpQueues = new Map<string, Promise<unknown>>();
  /**
   * Branch/settle evidence for messages proven *in this process*.
   *
   * Admission is positive-evidence only: a pending row may route when this map says it is on the
   * conversation's active branch and the conversation settled. A row recovered from disk has no
   * entry until a fresh authenticated snapshot supplies one, which is what makes a restart safe
   * without depending on having enumerated every durable row.
   */
  const evidence = new Map<string, Evidence>();
  const lastReportAt = new Map<string, number>();
  /**
   * Per-binding snapshot generation.
   *
   * A snapshot admits and routes in awaited chunks, and a newer authenticated snapshot can arrive
   * while an older one is mid-pass. The older pass must then stop: continuing would re-admit
   * messages the newer branch has already rejected and overwrite their evidence with `onBranch`.
   */
  const snapshotGeneration = new Map<string, number>();
  /**
   * Per-binding read authority: the observation token a watch handed out, and the binding facts it
   * described.
   *
   * A watch is a question and the posted snapshot is the answer, so the answer has to prove it is
   * answering the same question. The token is minted here, travels through the status pass to the
   * page and back, and is compared before anything is anchored or executed. It is rotated whenever
   * the binding's authority moves — a rebind, a disable, a re-enable with a new boundary — so a slow
   * network GET cannot be applied against a binding that has since changed under it.
   */
  const authorities = new Map<string, ObservationAuthority>();
  /**
   * Reads in flight, keyed by binding and snapshot id: the transport pages of one authenticated
   * read, buffered until the last one arrives.
   *
   * Only a whole read may be applied. Applying a page on its own would either route half a branch
   * (missing the older half of an offline backlog) or, worse, run off-branch rejection against a
   * window that is not the branch, rejecting every pending message outside it. So pages accumulate,
   * and the read is applied once, in page order, as the complete set the page's own `complete` flag
   * describes.
   */
  const reads = new Map<string, AssembledRead>();
  let stopped = false;
  let detachDeliveries: (() => void) | null = null;

  function alive(): boolean {
    return !stopped && !store.isClosed();
  }

  /** A fresh opaque token. Identity only: compared for equality, never parsed or derived. */
  function mintToken(): string {
    return randomUUID();
  }

  /**
   * The authority for one binding, minted on first use and re-minted when the binding moves.
   *
   * Keyed by the conversation and the boundary — the two facts a *watch* is issued for — rather
   * than by the work id: an automatic successor continuation moves the work forward while keeping
   * the same run, the same boundary and the same backlog, so its read authority must survive. A move
   * that changes the boundary (an explicit rebind, a re-enable) re-mints here and is rotated
   * explicitly as well.
   */
  function authorityFor(binding: WorkControllerBinding): ObservationAuthority {
    const existing = authorities.get(binding.session_id);
    if (existing && existing.conversationId === binding.conversation_id &&
        existing.boundAt === binding.bound_at) {
      return existing;
    }
    const minted: ObservationAuthority = {
      token: mintToken(),
      conversationId: binding.conversation_id,
      boundAt: binding.bound_at,
      workId: binding.work_id
    };
    authorities.set(binding.session_id, minted);
    return minted;
  }

  /**
   * Rotates one binding's read authority, dropping any read still in flight under the old token.
   *
   * Called when a read has been accepted (the question has been answered, so the next read must ask
   * anew) and when the binding's authority moves for any other reason.
   */
  function rotateAuthority(sessionId: string): void {
    authorities.delete(sessionId);
    for (const key of [...reads.keys()]) {
      if (key.startsWith(`${sessionId}\u0000`)) reads.delete(key);
    }
  }

  function evidenceKey(sessionId: string, messageId: string): string {
    return `${sessionId}\u0000${messageId}`;
  }

  /**
   * The newest authenticated branch authority for one binding.
   *
   * Zero means no snapshot has described this conversation in this process yet. Every proof, chunk
   * and route carries the generation it was produced under, and only the newest one may admit
   * anything: a proof that outlived its branch authority describes a branch that no longer exists.
   */
  function branchGeneration(sessionId: string): number {
    return snapshotGeneration.get(sessionId) ?? 0;
  }

  function rememberEvidence(key: string, value: Evidence): void {
    evidence.delete(key);
    evidence.set(key, value);
    while (evidence.size > EVIDENCE_MAX) {
      const oldest = evidence.keys().next().value;
      if (oldest === undefined) break;
      evidence.delete(oldest);
    }
  }

  function bindingFor(sessionId: string): WorkControllerBinding | null {
    if (!alive()) return null;
    return readOne(() => store.getControllerBinding(sessionId));
  }

  // ------------------------------------------------------------------- admission

  /**
   * Records one authenticated observation.
   *
   * Synchronous on purpose: the observer is a page heartbeat, and it must never wait on a model,
   * a worktree or a browser. `accepted` means the message is durably in the inbox and will be
   * routed; it does not mean the instruction has been admitted.
   */
  function observe(input: WorkControllerObservation): WorkControllerObservationResult {
    if (!alive()) return { state: 'rejected', error: 'WORK_CONTINUITY_UNAVAILABLE: the host has not restored work continuity.' };
    if (input.source !== 'user') return { state: 'generated' };
    const binding = bindingFor(input.sessionId);
    if (!binding || !binding.enabled || binding.conversation_id !== input.conversationId) return { state: 'unbound' };
    const existing = readOne(() => store.getControllerMessage(input.sessionId, input.messageId));
    if (existing) return { state: 'duplicate', messageId: input.messageId, workId: existing.work_id };
    // Only messages authored after the binding existed may execute. History that predates the
    // binding is what the user was already looking at when they chose this chat.
    if (input.authoredAt <= binding.bound_at) return { state: 'stale' };
    // The first authenticated snapshot anchors the account; a later differing one is refused,
    // because the same conversation id under another account is a different chat. An *absent*
    // account is unproven, never a match: it is deferred rather than admitted.
    const proof = accountProof(binding.provider_account_id, input.providerAccountId ?? null);
    if (proof === 'conflict') {
      return {
        state: 'rejected',
        error: 'CONTROLLER_ACCOUNT_CONFLICT: that conversation was already observed under a different provider account. The anchor is not replaced.'
      };
    }
    if (proof === 'unproven') {
      return { state: 'unproven' };
    }
    if (proof === 'anchor') {
      try {
        store.putControllerBinding({ ...binding, provider_account_id: input.providerAccountId ?? null });
      } catch (error) {
        return { state: 'rejected', error: `CONTROLLER_ACCOUNT_CONFLICT: ${(error as Error).message}` };
      }
    }
    try {
      const row = store.putControllerMessage({
        session_id: input.sessionId,
        conversation_id: input.conversationId,
        message_id: input.messageId,
        request_id: controllerRequestId(input.sessionId, input.messageId),
        text: input.text,
        authored_at: input.authoredAt,
        state: 'pending',
        work_id: null,
        error: null,
        created_at: now()
      });
      rememberEvidence(evidenceKey(input.sessionId, input.messageId), {
        onBranch: true,
        // `undefined` is "the observer did not say", which is not the same fact as "generating".
        settled: typeof input.settled === 'boolean' ? input.settled : null,
        context: input.context ?? null,
        contextAssistantId: input.precedingAssistantId ?? null,
        requestId: null,
        // An observation does not bump the authority: a second observation is more evidence for the
        // same branch, and it must not fence the first one's route. It attaches to whatever
        // authority is current, so a snapshot that has since replaced this branch still wins.
        generation: branchGeneration(input.sessionId)
      });
      const observationGeneration = branchGeneration(input.sessionId);
      void routeMessages(binding.session_id, [row.message_id], observationGeneration)
        .catch(error => logWarn(`continuity routing failed: ${(error as Error).message}`));
      return { state: 'accepted', messageId: row.message_id, workId: binding.work_id };
    } catch (error) {
      return { state: 'rejected', error: `CONTROLLER_MESSAGE_CONFLICT: ${(error as Error).message}` };
    }
  }

  /**
   * Applies one fresh, authenticated page snapshot.
   *
   * The snapshot is the *only* thing that may (a) admit messages the host never observed — a phone
   * that was offline while the user wrote three messages — and (b) re-prove a message that
   * outlived the process. It carries the active-branch messages in order, so nothing here ever
   * guesses "the newest message": every admitted message on that branch is routed oldest-first.
   *
   * Two facts are refused rather than tolerated:
   *
   *  - a snapshot from a *different* provider account than the binding's anchor, because the same
   *    conversation id under another account is a different chat; and
   *  - an off-branch pending message, but only when this snapshot is `complete`. An incomplete
   *    page proves membership and nothing else, so its omissions never delete evidence.
   */
  async function snapshot(input: WorkControllerSnapshot): Promise<void> {
    if (!alive()) return;
    // --- the echo, checked before anything is anchored, remembered or executed ---------------
    //
    // A watch is a question and this body is the answer, so the answer must prove it answers the
    // same question: the binding that is live *now*, at the same boundary, and the same opaque
    // token the watch handed out. The browser reads a watch, then issues a network GET, then posts
    // the result, and the binding can move in between — disabled, rebound, re-enabled under a new
    // boundary, or rotated by a restart. Checking the echo first is what stops such an answer from
    // anchoring an account, bumping branch authority, writing membership evidence, or routing: a
    // stale answer is dropped whole, and no part of it is allowed to look like fresh authority.
    const binding = readOne(() => store.getControllerBinding(input.sessionId));
    if (!binding || !binding.enabled) return;
    if (binding.conversation_id !== input.conversationId || binding.bound_at !== input.boundAt) {
      // A stale echo is a pure no-op. The binding that is live now has its own authority — minted
      // by `authorityFor` the moment the binding moved — and a slow answer from the *previous*
      // authority must not be able to delete it: doing so would discard the legitimate read the
      // current authority is still assembling.
      return;
    }
    const authority = authorityFor(binding);
    if (authority.token !== input.observationToken) return;
    // --- the account, before anything is consumed -------------------------------------------
    //
    // Same rule as admission: a foreign account is refused, and an unproven one is not enough to
    // admit or to re-prove anything. This is checked *here*, before the read is consumed and before
    // any branch authority is touched, because the refusals are the whole point: a snapshot from
    // another account, or one that cannot prove an account at all, must leave the current branch
    // authority, the current token and every in-flight route exactly as they were. Invalidating them
    // first and refusing afterwards would let an unauthenticated body cancel a valid pass.
    const account = accountProof(binding.provider_account_id, input.providerAccountId);
    if (account === 'conflict' || account === 'unproven') {
      // The read is refused whole, and the authority that produced it is retired so a retry is
      // measured against the current binding rather than replayed against a stale one. The live
      // branch authority is deliberately untouched: nothing about it was disproved.
      reads.delete(`${input.sessionId}\u0000${input.snapshotId}`);
      logWarn(`continuity ignored a snapshot for ${input.conversationId.slice(0, 8)} that ${account === 'conflict' ? 'came from a different provider account' : 'could not prove the provider account'}`);
      return;
    }
    if (account === 'anchor') {
      try {
        store.putControllerBinding({ ...binding, provider_account_id: input.providerAccountId });
      } catch (error) {
        // The account anchor is execution authority, not a cache. If it cannot be committed, this
        // snapshot must not admit work that a restart could later attribute to another account.
        logWarn(`continuity could not persist the provider account anchor: ${(error as Error).message}`);
        return;
      }
    }
    // --- transport paging --------------------------------------------------------------------
    //
    // A branch longer than one transport budget arrives as several pages of one read. No page may
    // be applied on its own: routing a window would execute the newer half of a backlog without the
    // requirements it depends on, and rejecting against a window would mark every pending message
    // outside it as edited away. So pages accumulate here and the read is applied once, in page
    // order, as the whole set its own `complete` flag describes.
    if (!Number.isInteger(input.pageIndex) || input.pageIndex < 0) {
      logWarn(`continuity ignored a snapshot page with an out-of-range index for ${input.conversationId.slice(0, 8)}`);
      return;
    }
    const readKey = `${input.sessionId}\u0000${input.snapshotId}`;
    let read = reads.get(readKey);
    if (!read) {
      read = {
        conversationId: input.conversationId,
        providerAccountId: input.providerAccountId,
        complete: input.complete,
        settled: input.settled,
        lastIndex: -1,
        pages: []
      };
      reads.set(readKey, read);
    }
    // Pages of one read describe one conversation under one account. A body that disagrees is not
    // this read's page, so it is refused instead of being spliced into another read's branch.
    if (read.conversationId !== input.conversationId) return;
    if (read.providerAccountId !== null && input.providerAccountId !== null &&
        read.providerAccountId !== input.providerAccountId) {
      reads.delete(readKey);
      return;
    }
    if (read.providerAccountId === null) read.providerAccountId = input.providerAccountId;
    const held = read.pages[input.pageIndex];
    if (held) {
      // A retried page must be the same page. A different body under the same index is a protocol
      // violation, and the honest answer is to drop the whole read rather than pick a winner.
      const same = held.length === input.messages.length &&
        held.every((message, index) => message.messageId === input.messages[index]!.messageId);
      if (!same) {
        reads.delete(readKey);
        return;
      }
    }
    read.pages[input.pageIndex] = input.messages;
    // The last page is the read's own final word on both flags: it is the only body that knows the
    // walk finished, so `complete` and `settled` are taken from it rather than from page zero.
    if (input.lastPage) {
      read.lastIndex = input.pageIndex;
      read.complete = input.complete;
      read.settled = input.settled;
    }
    if (read.lastIndex < 0) return;
    const messages: WorkControllerSnapshot['messages'] = [];
    for (let index = 0; index <= read.lastIndex; index++) {
      const page = read.pages[index];
      // A gap means this is not yet the whole read: hold everything, apply nothing.
      if (!page) return;
      messages.push(...page);
    }
    // The read is complete in transport terms, so it is consumed here — synchronously, before the
    // first await of the pass below. The token is rotated now, which is what makes a late duplicate
    // page or a slow old GET unable to resurrect a branch this read has already answered for.
    reads.delete(readKey);
    rotateAuthority(input.sessionId);
    await applyRead(binding, {
      conversationId: read.conversationId,
      providerAccountId: read.providerAccountId,
      messages,
      complete: read.complete,
      settled: read.settled
    });
  }

  /**
   * Applies one whole authenticated read: admission, routing, then off-branch rejection.
   *
   * Called only for a read whose transport pages all arrived, so `messages` is the read's complete
   * answer about the branch — never one window of it. Provider order is preserved exactly as the
   * observer reported it: a timestamp sort with a message-id tie-break would silently reorder two
   * messages that share an authored instant ("requirements", "correction", "go" can all be stamped
   * within one second), and reordering a controller's own instructions is a correctness bug, not a
   * presentation detail.
   */
  async function applyRead(
    binding: WorkControllerBinding,
    read: { conversationId: string; providerAccountId: string | null; messages: WorkControllerSnapshot['messages']; complete: boolean; settled: boolean }
  ): Promise<void> {
    const messages = read.messages;
    const onBranch = new Set(messages.map(message => message.messageId));
    {
      if (!alive()) return;
      // --- synchronous supersession, before any await or queue wait -------------------------
      //
      // A read admits and routes in awaited chunks, so an older pass can be paused mid-chunk when a
      // newer authenticated read arrives. Two things therefore happen here, in the synchronous
      // prefix of this call, before this pass awaits anything at all:
      //
      //  1. the generation is bumped, which fences every later chunk and every queued route of the
      //     older pass (a route proven under a superseded generation may not admit anything); and
      //  2. for a *complete* read, the older pass's membership is negated outright, so no stale
      //     `onBranch: true` can survive to be read by a route that was already in flight.
      //
      // Doing this after the new pass finished routing would be exactly the bug: the older pass
      // would have already re-admitted messages the newer branch has replaced, and their
      // instructions would execute.
      //
      // Only a *complete* read replaces branch authority. An incomplete read proves membership of
      // what it lists and nothing else — it cannot say a message is gone — so it must not be able to
      // fence a pass that is still proving the branch it saw. It records its evidence under the
      // current authority instead.
      const generation = read.complete ? branchGeneration(binding.session_id) + 1 : branchGeneration(binding.session_id);
      if (read.complete) snapshotGeneration.set(binding.session_id, generation);
      // Supersession is branch authority *and* binding authority: a pass that outlives a rebind,
      // a disable, or a boundary change is describing a question nobody is asking any more.
      const superseded = (): boolean => {
        if (!alive() || branchGeneration(binding.session_id) !== generation) return true;
        const live = readOne(() => store.getControllerBinding(binding.session_id));
        return !live || !live.enabled || live.conversation_id !== binding.conversation_id ||
          live.bound_at !== binding.bound_at || live.work_id !== binding.work_id;
      };
      if (read.complete) {
        const prefix = `${binding.session_id}\u0000`;
        for (const [key, value] of evidence) {
          if (!key.startsWith(prefix) || value.onBranch === false) continue;
          if (onBranch.has(key.slice(prefix.length))) continue;
          evidence.set(key, { ...value, onBranch: false });
        }
      }
      // ---------------------------------------------------------------------------------------
      // The account was proved in `snapshot`, before this read was consumed: a foreign or unproven
      // account is refused there, so that a refused body can never have invalidated the branch
      // authority or the routes it was never authorized to touch.
      // Admitted and routed in ordered chunks, one chunk at a time. This is what makes a backlog
      // longer than the process-local evidence bound correct: the proof for a message is used while
      // it is still the newest proof, instead of being evicted by the rest of the backlog before
      // anything runs. Execution still waits for a *complete* read — an incomplete one only records
      // membership, because relaying "go" before the requirements it depends on is an ordering bug.
      for (let index = 0; index < messages.length; index += SNAPSHOT_ROUTE_CHUNK) {
        // A newer read supersedes this pass entirely: it describes the branch as it is now.
        if (superseded()) return;
        const chunk = messages.slice(index, index + SNAPSHOT_ROUTE_CHUNK);
        const admitted: string[] = [];
        const remembered: Array<[string, Evidence]> = [];
        // The chunk's admissions are one commit: a crash before it leaves none of them, and the
        // next read admits them again from the same authenticated evidence. Evidence is only
        // remembered once that commit succeeded, so no route can act on a row that never landed.
        try {
          store.runInTransaction(() => {
            for (const message of chunk) {
              if (message.authoredAt <= binding.bound_at) continue;
              const key = evidenceKey(binding.session_id, message.messageId);
              // Each message carries its OWN predecessor quotation: a backlog of plan1/go1/plan2/go2
              // must never attach the newest plan to the earlier instruction.
              remembered.push([key, {
                onBranch: true,
                settled: read.settled,
                generation,
                context: message.context ?? null,
                contextAssistantId: message.precedingAssistantId ?? null,
                requestId: message.requestId ?? null
              }]);
              const existing = readOne(() => store.getControllerMessage(binding.session_id, message.messageId));
              if (existing) {
                if (existing.state === 'pending') admitted.push(existing.message_id);
                continue;
              }
              // A message the host never observed is admitted here, in order, from authenticated
              // evidence — the same shape an observation would have produced. The store's own write is
              // a savepoint here, so one refused row does not undo the rest of the chunk.
              try {
                store.putControllerMessage({
                  session_id: binding.session_id,
                  conversation_id: read.conversationId,
                  message_id: message.messageId,
                  request_id: controllerRequestId(binding.session_id, message.messageId),
                  text: message.text,
                  authored_at: message.authoredAt,
                  state: 'pending',
                  work_id: null,
                  error: null,
                  created_at: now()
                });
                admitted.push(message.messageId);
              } catch (error) {
                logWarn(`continuity could not admit snapshot message ${message.messageId}: ${(error as Error).message}`);
              }
            }
          });
        } catch (error) {
          logWarn(`continuity could not commit snapshot admissions: ${(error as Error).message}`);
          return;
        }
        for (const [key, value] of remembered) rememberEvidence(key, value);
        if (read.complete && admitted.length > 0) {
          await routeMessages(binding.session_id, admitted, generation)
            .catch(error => logWarn(`continuity routing failed: ${(error as Error).message}`));
          if (superseded()) return;
        }
      }
      // Off-branch rejection reads this binding's own pending rows, paged to completion, so it is
      // never limited to what this process happened to observe and never competes with another
      // binding's backlog. Only a *complete* read may say a message is gone, and it may only do so
      // against the whole read: every page of the branch was concatenated above, so a message
      // outside this set is genuinely outside the branch rather than outside one transport window.
      if (read.complete) {
        // Walked by keyset, past the last row read, until this binding's pending inbox is exhausted.
        // The page is a page of the *inbox*, so a run of on-branch rows at the head cannot hide an
        // off-branch row behind them: the next page starts after the last row read rather than at the
        // same head again. Rejection only ever removes rows, so a row already passed is never
        // revisited and never rejected on a stale reading.
        let cursor: ControllerInboxCursor | null = null;
        for (;;) {
          if (superseded()) return;
          const rows = readList(() => store.listPendingControllerMessagesForSession(binding.session_id, RECOVERY_PAGE_LIMIT, cursor));
          if (rows.length === 0) break;
          for (const row of rows) {
            if (row.conversation_id !== read.conversationId || onBranch.has(row.message_id)) continue;
            // A fork or edit between the observation and this complete snapshot: the message the
            // user wrote is no longer what this conversation is answering. It is rejected, never
            // executed.
            rejectRow(row, 'this message is no longer on the conversation\'s active branch, so it was not executed');
          }
          const last = rows[rows.length - 1]!;
          cursor = { created_at: last.created_at, session_id: last.session_id, message_id: last.message_id };
        }
      }
    }
    void pumpNow().catch(error => logWarn(`continuity report pump failed: ${(error as Error).message}`));
  }

  /**
   * Whether the controller conversation's own turn already executed this exact message.
   *
   * The join is exact at both ends, and it is the *provider* request id that ties them together:
   *
   *  - the source question is the message's own recorded turn in this conversation, and that
   *    turn's MCP call carries the provider's request id (`wfr_…`); a chat the host never observed
   *    has no recorded turn at all, and then the only lineage available is the provider request id
   *    the observer read off the message itself;
   *  - the runtime answers, for that exact provider request *under this work*, whether a managed
   *    operation was genuinely admitted (it records one durable receipt per provider request on the
   *    admitted path of the managed gate).
   *
   * Nothing weaker is accepted. An ended turn proves the chat answered, not that it ran work. A
   * historical operation of the prime's session proves some earlier call ran, not that *this*
   * question did. Neither is allowed to suppress the user's instruction.
   *
   * `live` is the third answer and it is deliberately not `executed`: a recorded turn for this
   * exact message that has not ended may still be driving the work right now, so the relay defers
   * rather than injecting a duplicate underneath it.
   */
  async function executionRelation(
    row: WorkControllerMessage,
    work: WorkRow,
    observedRequestId: string | null
  ): Promise<'executed' | 'live' | 'unproven'> {
    const session = await getSession(row.session_id).catch(() => null);
    if (!session || session.conversationId !== row.conversation_id) return 'unproven';
    // The provider request id the observer read off this very message is exact evidence about this
    // very message, so it is checked first and independently of whether the host happens to have
    // recorded a turn for it: a chat whose turn was never recorded here, or whose calls have long
    // since left any bounded window, still proves itself by its own request id.
    if (observedRequestId && provedNative(work, observedRequestId)) return 'executed';
    // Every recorded call whose *correlation* proves this exact message as its human ancestor, and
    // none other. The join is the correlation's own `questionId` — the provider graph's answer for
    // that request — compared to this message id, with a contradiction refusing rather than being
    // resolved.
    //
    // A turn's frozen `questionId` is deliberately NOT used. That field is the newest question at
    // the time the turn opened, so a turn that began before this message was canonical keeps an
    // *older* question id: a later turn's call would then be attributed to this message and its
    // receipt would suppress an instruction that never ran. Turn ownership is sequence; the
    // correlation is ancestry.
    //
    // The whole session log is searched, not a bounded tail: an accepted execution can lie
    // arbitrarily far behind, and a window would answer "no evidence" for a call that really ran —
    // which is how a message that was already handled would be relayed a second time.
    const events = await readEvents(row.session_id, { kinds: ['tool_call'] }).catch(() => []);
    for (const event of events) {
      if (event.kind !== 'tool_call') continue;
      const call = event.call;
      if (!call || call.attribution !== 'request_id' || call.conversationId !== row.conversation_id) continue;
      const providerId = call.requestId;
      if (!providerId) continue;
      const proof = requestCorrelation(providerId);
      if (!proof || proof.questionConflict === true) continue;
      if (proof.questionId !== row.message_id || proof.sessionId !== row.session_id) continue;
      if (provedNative(work, providerId)) return 'executed';
    }
    return 'unproven';
  }

  /** The runtime's own durable answer for one exact provider request, or false without a port. */
  function provedNative(work: WorkRow, providerRequestId: string): boolean {
    if (!deps.nativeExecution) return false;
    try {
      return deps.nativeExecution({ workId: work.work_id, providerRequestId }) === true;
    } catch (error) {
      logWarn(`continuity could not read native execution evidence: ${(error as Error).message}`);
      return false;
    }
  }

  /**
   * One relayed instruction, with the controller's own preceding message quoted when there is one.
   *
   * The work executes in a different conversation, so "go with that plan" is only actionable if the
   * plan travels with it. The quotation is labeled as context and is never cut: a shortened plan
   * executes incomplete requirements, so a pair that cannot compose inside the work instruction's
   * own bound is refused with its own reason instead of being trimmed to fit.
   */
  function relayText(text: string, context: string | null): string {
    if (!context) return text;
    return [text, '', CONTEXT_LABEL, context].join('\n');
  }

  function rejectRow(row: WorkControllerMessage, reason: string): void {
    try {
      store.updateControllerMessage(row.session_id, row.message_id, { state: 'rejected', error: reason.slice(0, 4000) });
    } catch (error) {
      logWarn(`continuity could not reject inbox message ${row.message_id}: ${(error as Error).message}`);
    }
  }

  // ------------------------------------------------------------------- routing

  /**
   * Routes an explicit, ordered set of messages for one binding.
   *
   * Driven by message ids rather than by a global pending query on purpose. Admission requires
   * positive branch evidence for the exact message, and the caller that just produced that
   * evidence is the snapshot or the observation that named the message — so routing from that
   * same list is what keeps a large offline backlog from starving behind any row limit, and what
   * keeps one binding from consuming another's page.
   */
  async function routeMessages(sessionId: string, messageIds: readonly string[], generation: number): Promise<void> {
    if (!alive() || messageIds.length === 0) return;
    const binding = bindingFor(sessionId);
    if (!binding || !binding.enabled) return;
    await serialize(queues, `${binding.session_id}\u0000${binding.conversation_id}`, async () => {
      let remaining = messageIds;
      while (remaining.length > 0) {
        // Every await of a message's routing happens here, in provider order, before anything is
        // written. The admissions are then decided and committed together, synchronously.
        const prepared: PreparedRoute[] = [];
        for (const messageId of remaining) {
          if (!alive()) return;
          // A route proven under a superseded branch authority may not admit anything, however long
          // it waited behind another pass: the branch it was proven against is no longer the branch.
          if (branchGeneration(sessionId) !== generation) return;
          const row = readOne(() => store.getControllerMessage(sessionId, messageId));
          if (!row || row.state !== 'pending') continue;
          const live = bindingFor(sessionId);
          if (!live || !live.enabled) return;
          const route = await prepareRoute(live, row, generation);
          if (route) prepared.push(route);
        }
        if (prepared.length === 0) return;
        const moved = commitRoutes(prepared, generation);
        if (moved === null) return;
        // An admission continued the work into a successor and moved the binding with it. Later
        // messages were prepared against the predecessor, so they are prepared again against the
        // binding as it is now, exactly as if each had been routed after the one before it.
        remaining = remaining.slice(remaining.indexOf(moved) + 1);
      }
    });
  }

  /** One message's routing inputs, gathered across every await and not yet validated. */
  interface PreparedRoute {
    binding: WorkControllerBinding;
    row: WorkControllerMessage;
    relation: 'executed' | 'live' | 'unproven';
    policySettled: boolean;
    context: string | null;
    contextAssistantId: string | null;
  }

  /**
   * Decides and commits one ordered chunk of prepared routes in a single transaction.
   *
   * Every row's acknowledgement (`accepted`) is written in the same commit as its work receipt,
   * so neither exists without the other, and a crash before the commit leaves the whole chunk
   * pending for the next read to route again under the same request ids. Nothing is published —
   * no change notification, no successor start, no pump wake, no log — until that commit
   * succeeded. Returns the message id whose admission moved the binding onto a successor, which
   * ends the chunk there, or null.
   */
  function commitRoutes(prepared: readonly PreparedRoute[], generation: number): string | null {
    const published: Array<() => void> = [];
    let moved: string | null = null;
    try {
      store.runInTransaction(() => {
        for (const route of prepared) {
          // Each route is its own savepoint. A route that throws stops the chunk exactly where
          // routing one message at a time would have stopped, keeping the admissions before it;
          // its own effects are only published when its savepoint survived.
          const effects: Array<() => void> = [];
          let advanced: boolean;
          try {
            advanced = store.runInTransaction(() => commitRoute(route, generation, effects));
          } catch (error) {
            logWarn(`continuity routing failed: ${(error as Error).message}`);
            return;
          }
          published.push(...effects);
          if (advanced) {
            moved = route.row.message_id;
            return;
          }
        }
      });
    } catch (error) {
      // The chunk's COMMIT itself failed: nothing of it is durable, so nothing is published and
      // every row is still pending under its own request id for the next read to route.
      logWarn(`continuity could not commit a routed chunk: ${(error as Error).message}`);
      return null;
    }
    for (const publish of published) publish();
    return moved;
  }

  /**
   * Gathers one pending message's routing inputs, or returns null when it cannot run yet.
   *
   * A message is never injected while the controller's own turn is live: the relay waits for a
   * settled boundary, which is also what stops it from interrupting the model that may be about
   * to drive the work itself.
   *
   * Every await of routing is here, and every await is a window in which the world can change — a
   * fresh snapshot may reject this row as off-branch, the controller's own model call may claim it,
   * or the UI may disable the binding. So nothing here admits anything: `commitRoute` re-reads the
   * binding, the row's pending state and the branch evidence synchronously at the moment of
   * admission, and any disagreement abandons the row rather than admitting an instruction nobody
   * still owns.
   */
  async function prepareRoute(binding: WorkControllerBinding, row: WorkControllerMessage, generation: number): Promise<PreparedRoute | null> {
    const current = bindingFor(binding.session_id);
    if (!current || !current.enabled || current.conversation_id !== binding.conversation_id) return null;
    const key = evidenceKey(row.session_id, row.message_id);
    // Positive evidence only, and only from the newest branch authority. A row the host has not seen
    // on the conversation's active branch in *this* process — including every row recovered from
    // disk — is not admitted on the strength of pre-restart state or a bare session policy, and a
    // proof produced under a branch authority a newer snapshot has replaced is not proof about this
    // branch at all.
    const opening = evidence.get(key);
    if (opening?.onBranch !== true || opening.generation !== generation) return null;
    // A generated report is app output echoed back by the page. It is never an instruction, and
    // it is rejected here even though the observer claimed it was user-authored.
    const origin = await deps.messageOrigin({ sessionId: row.session_id, messageId: row.message_id, text: row.text })
      .catch((): WorkMessageOrigin => 'unknown');
    if (origin === 'generated') {
      rejectRow(row, 'this message was generated by the host as a work report, so it is not an instruction');
      return null;
    }
    if (origin === 'unknown') return null;
    const policySettled = await deps.conversationSettled({ sessionId: row.session_id, conversationId: row.conversation_id })
      .catch(() => false);
    // Whether the controller's own conversation already executed this exact message is resolved
    // here, with the other awaits, so the decision below is made against one coherent reading.
    const executingWork = readOne(() => store.getWork(binding.work_id));
    const relation = executingWork
      ? await executionRelation(row, executingWork, evidence.get(key)?.requestId ?? null)
      : 'unproven';
    // The quotation comes from the provider's own graph, and only from there: the observer reports
    // each message's exact preceding assistant id and text as the provider's parent lineage proves
    // it. There is deliberately no fallback to recorded chronology — "the latest assistant message
    // before this turn's boundary" is sequence, not ancestry, and after an edit the old branch's
    // plan sits *before* the new question's boundary, so that fallback would quote a plan this
    // question never followed. Without the provider's own lineage the context stays absent, and the
    // relay reports that honestly rather than quoting the wrong message.
    const observed = evidence.get(key);
    const context = observed?.context ?? null;
    const contextAssistantId = observed?.context ? observed.contextAssistantId : null;
    return { binding, row, relation, policySettled, context, contextAssistantId };
  }

  /**
   * Admits one prepared message inside the chunk's transaction, or leaves it pending.
   *
   * Everything here is one synchronous validation against the durable state as it is *at the
   * moment of admission*, so a disable, a rebind, a claim by the controller's own model call, or a
   * snapshot that proved a new native turn cannot land in between and still be admitted past.
   * Post-commit effects are appended to `published`. Returns true when the admission moved the
   * binding onto a successor, which invalidates every later route prepared in this chunk.
   */
  function commitRoute(route: PreparedRoute, generation: number, published: Array<() => void>): boolean {
    const { binding, row, relation, policySettled, context, contextAssistantId } = route;
    const key = evidenceKey(row.session_id, row.message_id);
    if (!alive()) return false;
    if (branchGeneration(row.session_id) !== generation) return false;
    const live = bindingFor(binding.session_id);
    if (!live || !live.enabled || live.conversation_id !== binding.conversation_id ||
        live.bound_at !== binding.bound_at || live.work_id !== binding.work_id) return false;
    const held = readOne(() => store.getControllerMessage(row.session_id, row.message_id));
    if (!held || held.state !== 'pending') return false;
    if (held.authored_at <= live.bound_at) {
      rejectRow(held, 'this message predates the controller\'s current boundary, so it was not executed');
      return false;
    }
    const proof = evidence.get(key);
    if (proof?.onBranch !== true || proof.generation !== generation) return false;
    // The in-process observation is the freshest authenticated proof there is, and it can only ever
    // *refuse*: a snapshot that landed after the policy check and said the controller is generating
    // again is the current answer, so an older policy "settled" cannot override it.
    if (proof.settled === false) return false;
    if (!proof.settled && !policySettled) return false;
    // A proven MCP call from this same controller turn may already have admitted this exact
    // message: both paths share one durable request id, so an existing receipt means the admission
    // happened and this row is a receipt, not a second instruction.
    const admitted = admissionReceipt(held.request_id);
    if (admitted) {
      store.updateControllerMessage(held.session_id, held.message_id, {
        state: 'accepted',
        work_id: admitted,
        error: 'admitted by the controller conversation itself'
      });
      return false;
    }
    // A native call has *claimed* this row and has not finished: the claim is the row's in-flight
    // marker, and only its own receipt clears it. Dispatching here would race that call — the relay
    // would run `instruct` under the same request id the native call is about to use for a different
    // action, so whichever lost would be refused as a conflict and the user's actual request would be
    // replaced by the relay's. The row is left exactly as the claim left it, and the claim's own
    // completion or release is what makes it dispatchable again.
    //
    // The marker is deliberately not `work_id`: a native `start` names no work yet, so its claim has
    // `work_id === null` while it is very much in flight.
    if (held.claimed_at !== null) return false;
    const service = deps.service();
    if (!service) return false;
    const work = readOne(() => store.getWork(live.work_id));
    if (!work) {
      rejectRow(held, `the bound work ${live.work_id} no longer exists in the ledger`);
      return false;
    }
    if (work.status === 'cancelled') {
      rejectRow(held, 'the bound work was cancelled. Cancellation is terminal; start a new work instead.');
      return false;
    }
    // The controller *is* the prime conversation, so its own turn may already handle the message.
    // "Handled" is decided by that message's own execution lineage, never by the work's current
    // status or a wall-clock comparison: a user can queue B while the prime is still executing A,
    // and A can finish before B's native turn ever runs. B was authored before the completion and
    // still never executed, so it is a genuine follow-up that must reach the successor.
    //
    // The receipt is also deliberately independent of *which* prime owns the work now: a prime may
    // have been replaced, or the work continued into a successor, and that must not erase the fact
    // that this exact question really did run work here. Requiring the current prime to still be this
    // conversation would discard valid historical evidence and relay a message that was already
    // handled.
    //
    // A recorded turn that has not ended is the third case: the controller's own model may be
    // driving this work right now, so the row is left pending rather than injected underneath it.
    if (relation === 'live') return false;
    if (relation === 'executed') {
      try {
        store.updateControllerMessage(held.session_id, held.message_id, {
          state: 'accepted',
          work_id: work.work_id,
          error: 'handled natively by the controller conversation that owns this work'
        });
      } catch (error) {
        logWarn(`continuity could not record the native-handled receipt: ${(error as Error).message}`);
      }
      return false;
    }
    // The dispatch is frozen in the same commit as the service admission. The service hashes the
    // instruction it is handed, so a replay that recomposed from a recorder that has since recorded
    // more would present a *different* command under the same request id and be refused as a
    // conflict instead of joining the admission that already happened. Frozen with the receipt, the
    // replay reuses exactly these bytes and exactly this hash.
    const dispatch = held.dispatch_text ?? relayText(held.text, context);
    if (held.dispatch_text === null) {
      // The whole instruction and the whole quotation, or nothing: a plan shortened to fit executes
      // incomplete requirements, so an over-budget pair is left pending with its own truthful
      // reason instead of being cut. The exact text stays retrievable in the session that wrote it.
      if (!workInstructionSchema.shape.text.safeParse(dispatch).success) {
        const reason = 'the instruction and its quoted context do not fit the work instruction\'s 64KiB of UTF-8, so nothing was relayed. Shorten the instruction or the quoted message and send it again.';
        try {
          store.updateControllerMessage(held.session_id, held.message_id, { error: reason });
        } catch (error) {
          logWarn(`continuity could not record an oversized dispatch: ${(error as Error).message}`);
        }
        return false;
      }
    }
    // One savepoint per message inside the chunk's transaction: a refused admission rolls back
    // only this message's freeze and receipt, and is recorded as that message's rejection.
    let receipt: WorkReceipt;
    try {
      receipt = store.runInTransaction(() => {
        if (held.dispatch_text === null) {
          store.updateControllerMessage(held.session_id, held.message_id, {
            dispatch_text: dispatch,
            context_assistant_id: contextAssistantId
          });
        }
        const admission = service.admitInstruction({
          request_id: held.request_id,
          work_id: work.work_id,
          text: dispatch
        });
        store.updateControllerMessage(held.session_id, held.message_id, { state: 'accepted', work_id: admission.receipt.work_id, error: null });
        published.push(admission.publish);
        return admission.receipt;
      });
    } catch (error) {
      rejectRow(held, (error as Error).message);
      return false;
    }
    published.push(() => logInfo(`continuity routed controller message ${held.message_id} to work ${receipt.work_id.slice(0, 8)}`));
    if (receipt.work_id === live.work_id) return false;
    // The instruction landed on a successor. The controller keeps its own session and
    // conversation; only the work it drives moves forward.
    //
    // The binding is only moved when it is still the *same authority* this admission ran under:
    // the same conversation, the same boundary, the same account and the same work it started
    // from. A person can rebind that same session to an unrelated work at any point — moving the
    // binding then would silently retarget their new work onto this chain, and even preserve this
    // chain's epoch over theirs. When the authority changed, the admission is recorded as the
    // receipt it is and the binding is left exactly as the user made it.
    const after = bindingFor(held.session_id);
    const sessionId = held.session_id;
    published.push(() => lastReportAt.delete(sessionId));
    if (after && after.enabled && after.conversation_id === live.conversation_id &&
        after.bound_at === live.bound_at && after.work_id === live.work_id) {
      // The chain moves forward without changing who the controller is: the epoch, the account
      // and the conversation are preserved exactly, so the successor's reports answer to the
      // same authority the predecessor's did.
      store.putControllerBinding({ ...after, work_id: receipt.work_id, event_cursor: 0, updated_at: now() });
    }
    // Either way the binding no longer names the work every later route in this chunk was
    // prepared against.
    return true;
  }

  /**
   * Settle proof for one pending row.
   *
   * The session's own policy can prove a settle, but it can never *deny* one: negative branch
   * evidence from a complete snapshot is authoritative, and a policy answer of "not settled" only
   * means this row has to prove itself from the snapshot that admitted it.
   */
  // ------------------------------------------------------------------- reports

  /** The newest work in a continuation chain, walking the durable successor links to the tip. */
  function chainFrom(workId: string): WorkRow[] {
    const chain: WorkRow[] = [];
    const seen = new Set<string>();
    let work = readOne(() => store.getWork(workId));
    // Terminated by the visited set, not by a depth budget: a continuation has no generation
    // lifetime, so a genuinely long chain is followed to its tip, while a chain that revisits a work
    // is damage in the ledger and stops the walk instead of spinning.
    while (work && !seen.has(work.work_id)) {
      seen.add(work.work_id);
      chain.push(work);
      if (!work.successor_work_id) break;
      work = readOne(() => store.getWork(work!.successor_work_id!));
    }
    return chain;
  }

  /**
   * The durable report watermark for one session's work: the highest event sequence a delivery row
   * already covers.
   *
   * It is derived from the delivery rows rather than stored on the binding, and that is
   * deliberate. Writing a cursor back onto the binding is itself a committed work event, which
   * would make every report create the next thing to report — a feedback loop that only ever
   * stopped when the ledger did.
   */
  function reportedThrough(sessionId: string, workId: string): { cursor: number; any: boolean } {
    let cursor = 0;
    let any = false;
    for (const delivery of readList(() => store.listControllerDeliveries(sessionId))) {
      if (delivery.work_id !== workId) continue;
      any = true;
      cursor = Math.max(cursor, delivery.event_sequence);
    }
    return { cursor, any };
  }

  async function pumpNow(): Promise<void> {
    if (!alive()) return;
    // A report describes what the work has already been told. Letting the pump run ahead of an
    // admission still in flight would report a state the conversation has not received yet.
    await Promise.allSettled([...queues.values()]);
    if (!alive()) return;
    for (const binding of readList(() => store.listControllerBindings())) {
      if (!alive()) return;
      if (!binding.enabled) continue;
      // Two snapshots, an outbox transition and a work event can all arrive at once; one pump per
      // binding at a time is what keeps them from each creating the same report.
      await serialize(pumpQueues, binding.session_id, () =>
        pumpBinding(binding).catch(error => logWarn(`continuity report pump failed: ${(error as Error).message}`)));
    }
  }

  async function pumpBinding(binding: WorkControllerBinding): Promise<void> {
    if (!alive()) return;
    // A report is addressed to one conversation *under one account*. Until the binding's account is
    // anchored there is nothing that could authorize a report, so none is created — a placeholder
    // authority would be a report nobody could later prove.
    if (!binding.provider_account_id) return;
    const session = await getSession(binding.session_id).catch(() => null);
    if (!alive()) return;
    // A report is addressed to one conversation. If the binding's session no longer fronts that
    // conversation, the report has nowhere truthful to go: it stays queued in the ledger.
    if (!session || session.conversationId !== binding.conversation_id) return;
    for (const delivery of readList(() => store.listControllerDeliveries(binding.session_id))) {
      if (!alive()) return;
      if (delivery.state === 'unknown') {
        await reconcileUnknown(delivery);
        continue;
      }
      if (delivery.state !== 'pending' && delivery.state !== 'queued') continue;
      await attemptDelivery(binding, delivery);
    }
    if (!alive()) return;
    // Every await above is a window in which the binding can be disabled, rebound to another
    // conversation, or re-anchored to another account. A report is created under the authority that
    // authorizes it, so the binding is re-read here and must still be the same one: creating a
    // delivery from a stale binding would address a report to a conversation or an account that
    // never asked for it.
    const live = bindingFor(binding.session_id);
    if (!live || !live.enabled || live.conversation_id !== binding.conversation_id || live.bound_at !== binding.bound_at) return;
    const chain = chainFrom(binding.work_id);
    for (const work of chain) {
      if (!alive()) return;
      const isTail = work === chain[chain.length - 1];
      const reported = reportedThrough(binding.session_id, work.work_id);
      const page = readPages(work.work_id, reported.cursor);
      const fresh = page.cursor > reported.cursor;
      // An ending — a completion, a cancellation, a block or a pause — is reported exactly *once*
      // per binding authority, and that identity is the ending's own event, not the event watermark.
      // A late acknowledgment, an audit row or an instruction receipt can all append events after
      // the ending, and a watermark-only rule would read each of them as a fresh ending and send the
      // user another final message.
      const endingAt = terminalSequence(work.work_id);
      // An ending is owed when the work is *factually* in an ending state right now — not merely
      // because it once passed through one. A work that was paused or blocked and has since resumed
      // is running again, and its later progress must be reported; a historical ending event alone
      // would suppress every report from then on. The identity is still the ending's own event, so a
      // late acknowledgment after a completion never produces a second final message.
      const ending = endingAt !== null && ENDING_STATUSES.has(work.status);
      const finalOwed = ending && !finalReported(binding, work.work_id, endingAt);
      if (ending && !finalOwed) continue;
      if (!fresh && !finalOwed) continue;
      const final = ending || FINAL_EVENT_KINDS.has(page.events[page.events.length - 1]?.kind ?? '');
      // Coalescing, not queueing: while a report of ours is still waiting to be taken, another
      // status message would only be read after this one and say less. The final report is the
      // exception — it supersedes an outstanding status instead of queueing behind it.
      const outstanding = outstandingReports(binding.session_id, work.work_id);
      if (!final && outstanding.length > 0) continue;
      if (!final && now() - (lastReportAt.get(binding.session_id) ?? 0) < REPORT_MIN_INTERVAL_MS) continue;
      lastReportAt.set(binding.session_id, now());
      const at = now();
      if (final) await supersedeStatusReports(binding, outstanding);
      const row = store.putControllerDelivery({
        delivery_id: randomUUID(),
        session_id: binding.session_id,
        conversation_id: binding.conversation_id,
        work_id: work.work_id,
        // The authority is frozen here, at creation, from the binding that authorized this report.
        bound_at: binding.bound_at,
        provider_account_id: binding.provider_account_id,
        event_sequence: page.cursor,
        text: formatReport(work, page.events, page.total, final),
        state: 'pending',
        error: null,
        created_at: at,
        updated_at: at
      });
      // A completion already visible in the controller's own conversation needs no second
      // message: the final answer *is* the report, proven by its exact recorded message.
      if (final && work.status === 'completed') {
        const prime = work.prime_agent_id ? readOne(() => store.getAgent(work.prime_agent_id!)) : null;
        if (prime?.conversation_id === binding.conversation_id) {
          const recorded = await readCompletedFinal(binding.session_id, binding.conversation_id).catch(() => null);
          if (recorded) {
            store.updateControllerDelivery(row.delivery_id, {
              state: 'delivered',
              error: `already visible in this conversation as final message ${recorded.messageId}`
            });
            continue;
          }
        }
      }
      await attemptDelivery(binding, row);
      // The chain walk continues from the successor only once this work's report is durable.
      if (isTail) break;
    }
  }

  /**
   * The event sequence of one work's own terminal event, or null when it has not reached one.
   *
   * This is the identity of "this work finished": it is written once, by the transition that made
   * the work terminal, and every later event — a late acknowledgment, an audit row, a receipt —
   * has a higher sequence without being a second completion.
   */
  function terminalSequence(workId: string): number | null {
    let cursor = 0;
    let found: number | null = null;
    for (;;) {
      const { events, hasMore } = store.readEvents({ workId, after: cursor, limit: REPORT_PAGE_LIMIT });
      for (const event of events) {
        if (FINAL_EVENT_KINDS.has(event.kind)) found = event.sequence;
      }
      if (events.length > 0) cursor = events[events.length - 1]!.sequence;
      if (!hasMore || events.length === 0) break;
    }
    return found;
  }

  /** Whether this binding already produced the final report for that exact terminal event. */
  function finalReported(binding: WorkControllerBinding, workId: string, terminalAt: number): boolean {
    return readList(() => store.listControllerDeliveries(binding.session_id)).some(delivery =>
      delivery.work_id === workId && delivery.bound_at === binding.bound_at && delivery.event_sequence >= terminalAt);
  }

  /**
   * Reads events up to the work's real head, keeping a bounded sample of what was there.
   *
   * The cursor must reach the head, not the end of one page: a cursor that stopped at a page
   * boundary would make the next pump see the rest of the same unchanged run as "fresh" and emit
   * another report for it. The sampled kinds are bounded because a report is a summary, and the
   * count is what tells the reader how much it summarizes.
   */
  function readPages(workId: string, after: number): { events: WorkEventSample[]; cursor: number; total: number } {
    let cursor = after;
    let total = 0;
    const events: WorkEventSample[] = [];
    // The walk continues while the store says there is more. A page cap would leave the cursor
    // short of the head, and the next pump would then treat the rest of the same unchanged run as
    // fresh and report it again; the cap only bounds the *sample*, never the watermark.
    for (let page = 0; page < REPORT_PAGE_MAX || true; page++) {
      const { events: rows, hasMore } = store.readEvents({ workId, after: cursor, limit: REPORT_PAGE_LIMIT });
      total += rows.length;
      for (const row of rows) {
        events.push({ kind: row.kind, payload: row.payload, at: row.at, sequence: row.sequence });
        if (events.length > REPORT_EVENT_SAMPLE) events.shift();
      }
      if (rows.length > 0) cursor = rows[rows.length - 1]!.sequence;
      if (!hasMore) break;
    }
    return { events, cursor, total };
  }

  /**
   * Delivers one report, recording exactly what the outbox established.
   *
   * A user Stop in the controller conversation withdraws a report that is still unclaimed and
   * marks it cancelled; a report that may already have been sent stays `unknown` and is never
   * resent. Neither path touches work control: stopping the chat is not stopping the work.
   *
   * Every await above this call is a window in which the binding can be disabled, rebound to
   * another conversation, or re-anchored to another account. The binding is therefore re-read here
   * and the delivery's own conversation must still match it, so a report is never queued into a
   * conversation the controller has left.
   */
  async function attemptDelivery(binding: WorkControllerBinding, delivery: WorkControllerDelivery): Promise<void> {
    if (!alive()) return;
    if (delivery.conversation_id !== binding.conversation_id) {
      store.updateControllerDelivery(delivery.delivery_id, {
        state: 'cancelled',
        error: 'the controller conversation changed before this report was sent'
      });
      return;
    }
    if (await conversationStopped(binding)) {
      const withdrawn = await deps.cancelReport({ id: delivery.delivery_id, reason: 'the controller stopped this turn' }).catch(() => false);
      store.updateControllerDelivery(delivery.delivery_id, {
        state: withdrawn ? 'cancelled' : 'unknown',
        error: withdrawn
          ? 'the controller conversation stopped the turn before this report was sent'
          : 'the controller conversation stopped the turn; the report may already have been handed to the browser'
      });
      return;
    }
    if (!alive()) return;
    const live = bindingFor(binding.session_id);
    if (!live || !live.enabled || live.conversation_id !== delivery.conversation_id) return;
    const work = readOne(() => store.getWork(delivery.work_id));
    const result = await deps.deliverReport({
      id: delivery.delivery_id,
      sessionId: live.session_id,
      // The destination is the report's OWN frozen authority, never a later binding read: a
      // controller that moved or was re-enabled since does not inherit someone else's report.
      conversationId: delivery.conversation_id,
      boundAt: delivery.bound_at,
      providerAccountId: delivery.provider_account_id,
      text: delivery.text,
      model: work?.model ?? null,
      reasoning: work?.reasoning ?? null,
      dueAt: delivery.created_at,
      workId: delivery.work_id
    }).catch((error: unknown): ControllerReportResult => ({ state: 'failed', error: (error as Error).message }));
    if (!alive()) return;
    if (result.state === 'queued') {
      store.updateControllerDelivery(delivery.delivery_id, { state: 'queued', error: result.error ?? null });
      return;
    }
    // `unknown` is retained as unknown: the outbox may already have sent it, so it is never
    // rewritten into a success or replayed as if nothing had happened.
    store.updateControllerDelivery(delivery.delivery_id, { state: result.state, error: result.error ?? null });
  }

  /**
   * Reconciles one `unknown` report from the outbox's own durable record, never by resending.
   *
   * A report whose hand-off was ambiguous may already be in the conversation; the only honest way
   * to move it out of `unknown` is for the outbox to prove the same stable input id was delivered.
   * Nothing here ever calls `deliverReport` again for such a row.
   */
  async function reconcileUnknown(delivery: WorkControllerDelivery): Promise<void> {
    if (!deps.reconcileReport) return;
    const verdict = await deps.reconcileReport({ id: delivery.delivery_id, sessionId: delivery.session_id })
      .catch((): ControllerReportResult | null => null);
    if (!alive() || !verdict) return;
    if (verdict.state === 'unknown' || verdict.state === 'queued') return;
    store.updateControllerDelivery(delivery.delivery_id, { state: verdict.state, error: verdict.error ?? delivery.error });
  }

  /** Whether the controller conversation's newest boundary is a user Stop with nothing after it. */
  async function conversationStopped(binding: WorkControllerBinding): Promise<boolean> {
    const events = await readRecentEvents(binding.session_id, 12, { kinds: ['turn_end', 'turn_start', 'user_message'] }).catch(() => []);
    for (let index = events.length - 1; index >= 0; index--) {
      const event = events[index]!;
      if (event.kind === 'turn_end') return event.outcome === 'stopped';
      if (event.kind === 'turn_start' || event.kind === 'user_message') return false;
    }
    return false;
  }

  /** Reports of ours that have not been taken yet: pending, or accepted but unacknowledged. */
  function outstandingReports(sessionId: string, workId: string): WorkControllerDelivery[] {
    return readList(() => store.listControllerDeliveries(sessionId))
      .filter(row => row.work_id === workId && (row.state === 'pending' || row.state === 'queued'));
  }

  /** Withdraws superseded status reports so a final one is the last thing the reader sees. */
  async function supersedeStatusReports(binding: WorkControllerBinding, outstanding: readonly WorkControllerDelivery[]): Promise<void> {
    for (const row of outstanding) {
      const withdrawn = await deps.cancelReport({ id: row.delivery_id, reason: 'superseded by the final work report' }).catch(() => false);
      store.updateControllerDelivery(row.delivery_id, {
        state: withdrawn ? 'cancelled' : 'unknown',
        error: 'superseded by the final work report for this work'
      });
    }
    lastReportAt.delete(binding.session_id);
  }

  /**
   * One report: what the work is doing, what it has actually done, and the references needed to act
   * on it. Nothing else.
   *
   * The goal and the project path are deliberately not repeated here. They are the user's own words
   * from the conversation that started the work, and echoing them back into the controller chat on
   * every status message adds a long block of the same text for no new information. The work id is
   * the reference that identifies the work; `continued from`/`continued by` are included only when
   * the run moved, and the checkpoint and blocker only when they exist.
   */
  function formatReport(work: WorkRow, events: readonly WorkEventSample[], total: number, final: boolean): string {
    const lines = [
      `${final ? '[work-report] final' : '[work-report] status'} — work ${work.work_id}`,
      `title: ${bounded(work.title, 200)}`,
      `status: ${work.status}${work.desired_state ? ` (desired ${work.desired_state})` : ''}`,
      ...(work.predecessor_work_id ? [`continued from: ${work.predecessor_work_id}`] : []),
      ...(work.successor_work_id ? [`continued by: ${work.successor_work_id}`] : []),
      ...(work.blocker ? [`blocker: ${work.blocker.code} — ${bounded(work.blocker.detail, 800)}`] : []),
      ...(work.checkpoint
        ? [
            `checkpoint: revision ${work.checkpoint.revision}${work.checkpoint.host_generated ? ' (host-recorded facts)' : ''}`,
            `checkpoint summary: ${bounded(work.checkpoint.summary, 800)}`
          ]
        : []),
      `events: ${total === 0 ? 'none' : `${total} recorded; latest: ${events.map(event => event.kind).slice(-REPORT_EVENT_SAMPLE).join(', ')}`}`
    ];
    // The report is a factual summary and nothing more. It carries no paragraph telling the reader
    // what it is or what it may not do: the host records this delivery as generated in the ledger,
    // and that structural provenance is what stops it from ever being read back as an instruction.
    return bounded(lines.join('\n'), REPORT_MAX_CHARS);
  }

  // ------------------------------------------------------------------- lifecycle

  async function recover(): Promise<void> {
    if (!alive()) return;
    // A message that outlived the process cannot execute on pre-restart evidence. Its durable
    // admission (if the process died inside one) is reconciled from the persisted receipt first;
    // anything still pending waits for a fresh authenticated snapshot, which is enforced by
    // admission requiring positive in-process branch evidence rather than by enumerating rows.
    let recovered = 0;
    // Walked by keyset, past the last row read, until the query is exhausted. A head-of-list page
    // cannot hide the rows behind it — the page is a page of the *inbox*, not of the rows this pass
    // happens to change — so a run of pending rows whose admission never landed does not stop the
    // walk short of a later row whose admission did.
    let cursor: ControllerInboxCursor | null = null;
    for (;;) {
      const pending = readList(() => store.listPendingControllerMessages(RECOVERY_PAGE_LIMIT, cursor));
      if (pending.length === 0) break;
      for (const row of pending) {
        recovered += 1;
        reconcileAdmission(row);
      }
      const last = pending[pending.length - 1]!;
      cursor = { created_at: last.created_at, session_id: last.session_id, message_id: last.message_id };
    }
    if (recovered > 0) logInfo(`continuity recovered ${recovered} pending controller message(s); each awaits a fresh provider snapshot`);
    await pumpNow();
  }

  /** The work id a durable admission receipt names for one derived request id, or null. */
  function admissionReceipt(requestId: string): string | null {
    const command = readOne(() => store.getCommand(requestId));
    if (!command?.result_json) return null;
    try {
      const parsed: unknown = JSON.parse(command.result_json);
      if (parsed && typeof parsed === 'object' && typeof (parsed as { work_id?: unknown }).work_id === 'string') {
        return (parsed as { work_id: string }).work_id;
      }
    } catch {
      return null;
    }
    return null;
  }

  /**
   * Reconciles one inbox row against the persisted work command it may have admitted.
   *
   * The inbox row's `request_id` *is* the work command's `request_id`, so a crash between the
   * durable admission and the receipt write is recovered from the ledger rather than re-executed.
   * A row with no command receipt stays pending: a claim alone never authorizes work.
   */
  function reconcileAdmission(row: WorkControllerMessage): boolean {
    // A claim found on disk is always orphaned: no in-process call survives a restart, and a claim
    // is only ever written by a call that is about to run the action under it. So a persisted claim
    // is cleared here, and the row is then judged by the ledger's own receipt — the only truth about
    // whether the admission happened.
    if (row.claimed_at !== null) {
      try {
        store.updateControllerMessage(row.session_id, row.message_id, { claimed_at: null });
      } catch (error) {
        logWarn(`continuity could not clear a stale controller claim on ${row.message_id}: ${(error as Error).message}`);
        return false;
      }
    }
    const workId = admissionReceipt(row.request_id);
    if (!workId) return false;
    try {
      store.updateControllerMessage(row.session_id, row.message_id, {
        state: 'accepted',
        work_id: workId,
        error: 'admitted before the host restarted; recovered from the durable work receipt'
      });
      logInfo(`continuity reconciled controller message ${row.message_id} to work ${workId.slice(0, 8)}`);
      return true;
    } catch (error) {
      logWarn(`continuity could not reconcile controller message ${row.message_id}: ${(error as Error).message}`);
      return false;
    }
  }

  async function stop(): Promise<void> {
    stopped = true;
    detachDeliveries?.();
    detachDeliveries = null;
    // Drain the routing queue: nothing may send after stop, and no continuation may slip out
    // while the host is tearing down.
    await Promise.allSettled([...queues.values()]);
    queues.clear();
    await Promise.allSettled([...pumpQueues.values()]);
    pumpQueues.clear();
    evidence.clear();
  }

  /**
   * The enabled bindings, each with the read authority a snapshot must echo back.
   *
   * The token is minted here rather than stored on the binding, and that is deliberate: it is
   * per-process read authority, so a restart naturally invalidates every token a page still holds
   * — a page that posts an answer from before the restart is refused instead of being applied to a
   * ledger that no longer remembers asking. A watch that is not enabled simply stops appearing,
   * which is the whole cancellation protocol.
   */
  function watches(): WorkControllerWatch[] {
    if (!alive()) return [];
    return readList(() => store.listControllerBindings())
      .filter(binding => binding.enabled)
      .map(binding => ({
        sessionId: binding.session_id,
        conversationId: binding.conversation_id,
        boundAt: binding.bound_at,
        providerAccountId: binding.provider_account_id,
        observationToken: authorityFor(binding).token
      }));
  }

  if (deps.onDeliveryChange) detachDeliveries = deps.onDeliveryChange(() => { void pumpNow(); });

  return { observe, snapshot, watches, rotateAuthority, recover, pumpNow, stop };
}

interface WorkEventSample {
  kind: string;
  payload: Record<string, unknown>;
  at: number;
  sequence: number;
}

// --------------------------------------------------------------------------- singleton

let manager: WorkContinuityHandle | null = null;
let storeRef: WorkStore | null = null;

export async function initWorkContinuity(deps: WorkContinuityDeps): Promise<void> {
  if (manager) return;
  manager = createWorkContinuity(deps);
  storeRef = deps.store;
}

/** Startup: pending messages are re-proved by a fresh snapshot before they may run. */
export async function recoverWorkContinuity(): Promise<void> {
  await manager?.recover();
}

export async function drainWorkContinuity(): Promise<void> {
  const active = manager;
  manager = null;
  storeRef = null;
  if (active) await active.stop();
}

/** Test seam: forget the manager without touching disk. */
export function resetWorkContinuityForTests(): void {
  manager = null;
  storeRef = null;
}

export function isWorkContinuityReady(): boolean {
  return manager !== null;
}

/** The live manager, for a host that owns its lifecycle (and for tests that drive the pump). */
export function getWorkContinuityHandle(): WorkContinuityHandle | null {
  return manager;
}

/** The live store behind the manager; every exported API fails closed without it. */
function currentStore(): WorkStore | null {
  if (!manager || !storeRef || storeRef.isClosed()) return null;
  return storeRef;
}

/**
 * Reads one optional row, or null.
 *
 * Every public API goes through this so a closed ledger or a damaged row degrades to "nothing to
 * report" instead of throwing into a page heartbeat or a GUI handler.
 */
function readOne<T>(read: () => T | null): T | null {
  try {
    return read();
  } catch (error) {
    logWarn(`continuity read failed: ${(error as Error).message}`);
    return null;
  }
}

function readList<T>(read: () => T[]): T[] {
  try {
    return read();
  } catch (error) {
    logWarn(`continuity read failed: ${(error as Error).message}`);
    return [];
  }
}

// --------------------------------------------------------------------------- public API

/** The binding for one local session, or null. `sessionId` alone identifies a binding. */
export function getWorkControllerBinding(sessionId: string): WorkControllerBinding | null {
  const store = currentStore();
  return store ? readOne(() => store.getControllerBinding(sessionId)) : null;
}

export function getWorkControllerBindingByConversation(conversationId: string): WorkControllerBinding | null {
  const store = currentStore();
  return store ? readOne(() => store.getControllerBindingByConversation(conversationId)) : null;
}

/**
 * Enables or disables future inbox admission and report sends for one session.
 *
 * Disabling is not cancellation: the work keeps running, and its pending deliveries stay in the
 * ledger untouched. Only an explicit enable admits anything again.
 *
 * The only caller is the Works pane's own connection control, so an *enable* is a person's
 * decision and is stamped `explicit`: a binding the prime fallback created must not stay
 * replaceable by a later automatic handover once somebody has deliberately switched it back on.
 * A *disable* changes nothing but the flag — the origin records how the binding came to exist, and
 * turning the relay off is not a new creation.
 */
export async function setWorkControllerEnabled(sessionId: string, enabled: boolean): Promise<WorkControllerBinding | null> {
  const store = currentStore();
  if (!store) return null;
  const existing = readOne(() => store.getControllerBinding(sessionId));
  if (!existing) return null;
  const at = Date.now();
  // Re-enabling is a fresh consent boundary, not a resume: everything authored while the
  // controller was off is history, so the watermark moves to now and those messages can never be
  // executed. Disabling changes nothing else — the work keeps running.
  const reenabling = enabled && !existing.enabled;
  const updated = store.putControllerBinding({
    ...existing,
    enabled,
    ...(reenabling ? { bound_at: at, event_cursor: 0 } : {}),
    ...(enabled ? { origin: 'explicit' as const } : {}),
    updated_at: at
  });
  // The read authority moves with the binding: a snapshot the page was already carrying when the
  // controller was disabled or re-enabled describes a question nobody is asking any more, so its
  // token is retired and any read still assembling under it is dropped.
  rotateWorkControllerAuthority(sessionId);
  if (enabled) await manager?.pumpNow().catch(() => undefined);
  return updated;
}

/** Retires one binding's read authority in the live manager, if there is one. */
function rotateWorkControllerAuthority(sessionId: string): void {
  manager?.rotateAuthority(sessionId);
}

/**
 * Binds one local session's conversation as the durable controller of a work.
 *
 * Trusted local callers only: the conversation is resolved by the host from the session, never
 * supplied by a renderer, and the work must exist.
 *
 * One work has one controller. A second session may only take it over through an explicit
 * `takeover`, which disables the previous controller in the same step — otherwise two chats would
 * both relay into one work and both receive its reports, and neither would be the "original
 * conversation" this feature is defined by. The check walks the continuation chain, so a successor
 * cannot be claimed out from under the controller that owns its predecessor.
 *
 * An existing binding keeps its enabled flag: re-binding a disabled controller must not silently
 * reactivate it.
 */
export function bindWorkController(input: {
  sessionId: string;
  conversationId: string;
  workId: string;
  boundAt?: number;
  /** Explicitly move ownership away from the current controller of this chain. */
  takeover?: boolean;
  /**
   * How this binding is being created. Omitted means the caller did not say, which reads as the
   * conservative `explicit` — a binding is only `automatic` when the prime fallback itself says so.
   */
  origin?: 'automatic' | 'explicit';
}): WorkControllerBinding | null {
  const store = currentStore();
  if (!store) return null;
  if (!readOne(() => store.getWork(input.workId))) return null;
  const existing = readOne(() => store.getControllerBinding(input.sessionId));
  const owner = controllerOwnerOf(input.workId);
  if (owner && owner.session_id !== input.sessionId && !input.takeover) {
    // A work's controller stands, whatever created it. The prime fallback is how a work *gains* a
    // controller, never how it loses one, and recovery of a work that lost its controller is a
    // proven native original-start replay rather than an implicit handover here.
    logWarn(`continuity refused to bind session ${input.sessionId.slice(0, 8)}: work ${input.workId.slice(0, 8)} already has controller ${owner.session_id.slice(0, 8)}`);
    return null;
  }
  if (owner && owner.session_id !== input.sessionId && input.takeover) {
    // The old controller is disabled, not deleted: its account anchor and delivery history stay
    // honest, and it keeps its own work so its reports stop rather than duplicate.
    store.putControllerBinding({ ...owner, enabled: false, updated_at: Date.now() });
  }
  // The boundary is preserved when the move is the same run: a re-bind of the *same* work (the
  // controller's conversation changing while the run does not), or a move along the ledger's own
  // continuation chain. Moving the boundary forward in those cases would make a message the user
  // already wrote — but which the host has not routed yet — silently stale, and a prime transfer or
  // a successor must not be able to erase the controller's own history.
  //
  // Every other move is a different question and gets a fresh boundary. Binding this conversation to
  // an unrelated work is new consent, and it must invalidate everything authored for the old one:
  // with the old boundary preserved, an unreached backlog from work A would be admitted and executed
  // against work B, which never asked for it. The same applies to a first binding and to a takeover.
  const continues = existing !== null &&
    (existing.work_id === input.workId || continuationChain(existing.work_id).has(input.workId));
  const boundAt = input.boundAt ?? (continues ? existing!.bound_at : Date.now());
  try {
    const row = store.putControllerBinding({
      session_id: input.sessionId,
      conversation_id: input.conversationId,
      provider_account_id: existing?.provider_account_id ?? null,
      work_id: input.workId,
      bound_at: boundAt,
      enabled: existing?.enabled ?? true,
      // A new binding starts at the work's current head, so history that predates the binding is
      // never replayed as a report.
      event_cursor: existing && existing.work_id === input.workId ? existing.event_cursor : 0,
      updated_at: boundAt,
      ...(input.origin ? { origin: input.origin } : {})
    });
    // The conversation, the boundary or the work moved, so the read authority moves with it: a
    // snapshot still in flight under the old token answers a question nobody is asking now.
    rotateWorkControllerAuthority(input.sessionId);
    if (owner && owner.session_id !== input.sessionId && input.takeover) rotateWorkControllerAuthority(owner.session_id);
    logInfo(`continuity bound controller session ${input.sessionId.slice(0, 8)} to work ${input.workId.slice(0, 8)}`);
    return row;
  } catch (error) {
    logWarn(`continuity could not bind controller: ${(error as Error).message}`);
    return null;
  }
}

export function unbindWorkController(input: { sessionId: string; conversationId: string }): boolean {
  const store = currentStore();
  if (!store) return false;
  const existing = readOne(() => store.getControllerBinding(input.sessionId));
  if (!existing || existing.conversation_id !== input.conversationId) return false;
  // Unbinding is disabling with the conversation released: the ledger has no delete, and a
  // disabled row keeps the account anchor and the delivery history honest.
  try {
    store.putControllerBinding({ ...existing, enabled: false, updated_at: Date.now() });
    rotateWorkControllerAuthority(input.sessionId);
    return true;
  } catch (error) {
    logWarn(`continuity could not unbind controller: ${(error as Error).message}`);
    return false;
  }
}

/**
 * The controller that owns one work, from the binding registry rather than from the work's own
 * agent list.
 *
 * The original conversation is deliberately *not* one of the work's agents: the phone that started
 * the work never joins the run, so an agent scan cannot find it. Ownership is the binding, and the
 * binding is what this answers with.
 */
export function workControllerOwner(workId: string): WorkControllerBinding | null {
  return controllerOwnerOf(workId);
}

/**
 * The persisted admission receipt of one work command, exactly as the service wrote it.
 *
 * A caller joining an admission that already happened must answer with the bytes that admission
 * committed — the request id the ledger really used, the revision it really produced — rather than
 * a receipt rebuilt from current state under the joining caller's own id. Null when this request id
 * has no command, or when its command has not produced a receipt yet.
 */
export function workCommandReceipt(requestId: string): WorkReceipt | null {
  const store = currentStore();
  if (!store) return null;
  const command = readOne(() => store.getCommand(requestId));
  if (!command?.result_json) return null;
  try {
    const parsed: unknown = JSON.parse(command.result_json);
    return parsed && typeof parsed === 'object' && 'work_id' in parsed ? (parsed as WorkReceipt) : null;
  } catch {
    return null;
  }
}

/**
 * The set of works reachable from one work by its recorded predecessor/successor links.
 *
 * This is the ledger's own answer to "is this the same run continuing?", and it is deliberately
 * bounded: a corrupt cycle must not spin, and a chain that deep is not a continuation anybody
 * recorded. Membership here is what authorizes preserving a controller's boundary across a move.
 */
function continuationChain(workId: string): Set<string> {
  const chain = new Set<string>();
  const seen = new Set<string>();
  const pending = [workId];
  // Walked in both directions, transitively, and terminated by the visited set rather than a depth
  // budget. A continuation has no generation lifetime, so a long chain is followed in full: from
  // A -> B -> C, `continuationChain(A)` must contain C, or a controller that moved to C would look
  // unrelated to A and its pending backlog would be aged out instead of continuing. A chain that
  // revisits a work stops the walk instead of spinning.
  while (pending.length > 0) {
    const next = pending.pop()!;
    if (seen.has(next)) continue;
    seen.add(next);
    chain.add(next);
    const work = readOne(() => currentStore()?.getWork(next) ?? null);
    if (!work) continue;
    if (work.successor_work_id) pending.push(work.successor_work_id);
    if (work.predecessor_work_id) pending.push(work.predecessor_work_id);
  }
  return chain;
}

/**
 * The controller that owns one work, walking its continuation chain in both directions.
 *
 * A successor continues its predecessor's controller: whoever drove the predecessor drives the
 * chain, so a bind attempt on any work in the chain meets the same owner.
 */
/**
 * The controller *slot* of one work's chain, enabled or not.
 *
 * `controllerOwnerOf` answers "who is driving this now", which is why it ignores a disabled row.
 * This answers the different question a start must ask before it binds: whether this chain already
 * has a controller slot at all. A disabled binding is a person's decision to turn the feature off,
 * and it reserves the slot — a start that created a fresh enabled binding beside it would silently
 * reverse that decision, which is the same rule the requesting session's own disabled row gets.
 */
export function workControllerReservation(workId: string): WorkControllerBinding | null {
  const store = currentStore();
  if (!store) return null;
  const chain = continuationChain(workId);
  const inChain = readList(() => store.listControllerBindings()).filter(binding => chain.has(binding.work_id));
  return inChain.find(binding => binding.enabled) ?? inChain[0] ?? null;
}

function controllerOwnerOf(workId: string): WorkControllerBinding | null {
  const store = currentStore();
  if (!store) return null;
  const bindings = readList(() => store.listControllerBindings()).filter(binding => binding.enabled);
  if (bindings.length === 0) return null;
  const chain = continuationChain(workId);
  return bindings.find(binding => chain.has(binding.work_id)) ?? null;
}

/**
 * Every conversation this browser must read, with the watermark, the account anchor and the read
 * authority the fetcher decides with before it issues a request.
 *
 * `boundAt` is the binding's `bound_at`, never its `event_cursor`: a work event sequence is not a
 * provider timestamp, so it cannot order or filter provider messages. `providerAccountId` travels
 * with the watch so an unanchored binding is refused *before* the GET instead of anchoring itself
 * on whatever account the browser is signed into. `observationToken` is the authority the answer
 * must echo: it is minted here, rotated when a read is accepted or the binding moves, and compared
 * before any part of an answer is applied.
 */
export function listWorkControllerWatches(): WorkControllerWatch[] {
  if (!manager) return [];
  return manager.watches();
}

export function observeWorkControllerMessage(input: WorkControllerObservation): WorkControllerObservationResult {
  if (!manager) return { state: 'rejected', error: 'WORK_CONTINUITY_UNAVAILABLE: the host has not restored work continuity.' };
  return manager.observe(input);
}

export function observeWorkControllerSnapshot(input: WorkControllerSnapshot): void {
  void manager?.snapshot(input).catch(error => logWarn(`continuity snapshot failed: ${(error as Error).message}`));
}

/**
 * Binds the first managed prime of a work as that work's controller.
 *
 * This is what lets a desktop-started work be continued from the same chat after it completes.
 * A work that already has a controller keeps it — a prime transfer or a successor must not steal
 * the original controller — and an existing *disabled* binding is never reactivated.
 */
export function autoBindPrimeController(input: { sessionId: string; conversationId: string; workId: string }): WorkControllerBinding | null {
  const store = currentStore();
  if (!store || !input.sessionId || !input.conversationId) return null;
  const bindings = readList(() => store.listControllerBindings());
  const foreign = bindings.find(binding => binding.work_id === input.workId && binding.session_id !== input.sessionId);
  // A work's controller stands, whatever created it. The prime fallback is how a work *gains* a
  // controller, never how it loses one: a prime transfer or a successor runs this same helper from
  // the new execution conversation, and if it could displace the existing binding the original chat
  // would silently stop being the work's controller — the exact invariant this feature exists for.
  //
  // Recovery of a work that lost its controller is not this helper's job: that is a proven native
  // original-start replay, which owns the durable intent and rebinds deliberately.
  if (foreign) return null;
  const existing = bindings.find(binding => binding.session_id === input.sessionId);
  if (existing) {
    // The controller already exists for this session: keep its conversation (a prime transfer
    // must not drag the controller into the replacement chat) and keep its enabled flag.
    if (!existing.enabled) return existing;
    if (existing.work_id === input.workId && existing.conversation_id === input.conversationId) return existing;
    // A binding this session already holds for *another* work is a decision — a person's, or an
    // earlier start's. Retargeting it here would silently move that chat's controller onto this work
    // and, for an explicit binding, downgrade it to automatic so a later fallback could displace it.
    // Only a ledger-proven successor continuation may move it, which `bindWorkController` decides.
    if (existing.origin !== 'automatic') return existing;
    if (!continuationChain(existing.work_id).has(input.workId)) return existing;
    return bindWorkController({ sessionId: input.sessionId, conversationId: existing.conversation_id, workId: input.workId, origin: 'automatic' });
  }
  return bindWorkController({ ...input, origin: 'automatic' });
}

/** The input owner's provenance verdict for one exact provider user message. */
export async function workControllerMessageOrigin(input: {
  sessionId: string;
  messageId: string;
  text?: string;
}): Promise<WorkMessageOrigin> {
  return messageOriginFor(input.sessionId, input.messageId, input.text);
}

let originQuery: WorkContinuityDeps['messageOrigin'] | null = null;

async function messageOriginFor(sessionId: string, messageId: string, text?: string): Promise<WorkMessageOrigin> {
  if (!originQuery) return 'unknown';
  return originQuery({ sessionId, messageId, ...(text !== undefined ? { text } : {}) })
    .catch((): WorkMessageOrigin => 'unknown');
}

/** Installed by the host so continuity can answer the generated-message question. */
export function setWorkContinuityOriginQuery(query: WorkContinuityDeps['messageOrigin'] | null): void {
  originQuery = query;
}

/**
 * Records that the controller conversation's own model call is handling one provider message.
 *
 * The row deliberately stays `pending`. Two things make that safe and correct:
 *
 *  - The row's `request_id` is *derived* from the message identity, so the relay and the model's
 *    own call name the same durable work command. Even if both run, `service.instruct` is
 *    idempotent per request id and the second call joins the first instead of executing again.
 *  - `work_id` is written as the in-flight marker, and `completeWorkControllerTurnClaim` moves the
 *    row to `accepted` only after the work receipt exists. A crash in between therefore leaves a
 *    pending row that `recover` reconciles from the persisted receipt, rather than an `accepted`
 *    row that nothing would ever look at again.
 */
export function claimWorkControllerTurn(input: {
  sessionId: string;
  conversationId: string;
  messageId: string;
  text: string;
  authoredAt: number;
  workId: string | null;
  /**
   * The request id the caller itself supplied, kept when this call is the first to claim the
   * message.
   *
   * The first owner wins: a caller that already named its own request id keeps it as the durable
   * id, and a later caller for the same message is told that id rather than being allowed to
   * invent a second one. That is what makes a native call and the automatic relay one admission
   * instead of two.
   */
  requestId?: string | null;
}): WorkControllerMessage | null {
  const store = currentStore();
  if (!store) return null;
  const existing = readOne(() => store.getControllerMessage(input.sessionId, input.messageId));
  if (existing) {
    // The persisted row's own request id is returned unchanged: this caller joins that admission.
    if (existing.state !== 'pending') return existing;
    // An *unclaimed* row still carries the placeholder an observation derived from the message
    // identity. The native application's own public UUID is the authoritative id for this message:
    // it is the id the caller's tool call is replayed under and the id the user's retry names, so it
    // takes the placeholder's place while nothing has claimed the row. Once a work id or a frozen
    // dispatch exists, the id is the admission's identity and is left exactly as it is.
    // A row another native call has already taken keeps its id: the first owner's public UUID is what
    // that call is replaying under, and a second call in the same turn is a different change. The
    // claim marker is part of that test because a native `start` names no work yet, so `work_id` alone
    // would let the second caller steal the first one's identity.
    const adopt = input.requestId && existing.work_id === null && existing.dispatch_text === null &&
      existing.claimed_at === null && input.requestId !== existing.request_id;
    try {
      return store.updateControllerMessage(input.sessionId, input.messageId, {
        work_id: input.workId ?? existing.work_id,
        ...(adopt ? { request_id: input.requestId! } : {}),
        // The reservation itself: the row is now visibly in the hands of a native call that has not
        // finished, so the relay leaves it alone until this call reports its receipt or lets go.
        claimed_at: Date.now(),
        error: 'claimed by the controller conversation; its work receipt owns this message'
      });
    } catch (error) {
      logWarn(`continuity could not claim controller turn: ${(error as Error).message}`);
      return null;
    }
  }
  try {
    return store.putControllerMessage({
      session_id: input.sessionId,
      conversation_id: input.conversationId,
      message_id: input.messageId,
      request_id: input.requestId ?? controllerRequestId(input.sessionId, input.messageId),
      text: input.text,
      authored_at: input.authoredAt,
      state: 'pending',
      work_id: input.workId,
      claimed_at: Date.now(),
      error: 'claimed by the controller conversation; its work receipt owns this message',
      created_at: Date.now()
    });
  } catch (error) {
    logWarn(`continuity could not claim controller turn: ${(error as Error).message}`);
    return null;
  }
}

/** Records the successful admission of a claimed controller turn. */
export function completeWorkControllerTurnClaim(input: { sessionId: string; messageId: string; workId: string }): void {
  const store = currentStore();
  if (!store) return;
  try {
    store.updateControllerMessage(input.sessionId, input.messageId, {
      state: 'accepted',
      work_id: input.workId,
      // The claim is finished: its receipt is durable, so the reservation ends with it.
      claimed_at: null,
      error: 'admitted by the controller conversation itself'
    });
  } catch (error) {
    logWarn(`continuity could not complete controller turn claim: ${(error as Error).message}`);
  }
}

/**
 * Returns a claim to the relay after the caller's own admission failed.
 *
 * A refused admission must not leave the message claimed: the relay is the only thing that can
 * still deliver the user's instruction, and it may only do so from a `pending` row.
 */
export function releaseWorkControllerTurnClaim(input: { sessionId: string; messageId: string; error: string }): void {
  const store = currentStore();
  if (!store) return;
  try {
    store.updateControllerMessage(input.sessionId, input.messageId, {
      state: 'pending',
      work_id: null,
      // Letting go releases the reservation too: the relay is the only thing that can still deliver
      // the user's instruction, and it may only do so from a pending row nobody is holding.
      claimed_at: null,
      error: input.error.slice(0, 4000)
    });
  } catch (error) {
    logWarn(`continuity could not release controller turn claim: ${(error as Error).message}`);
  }
}
