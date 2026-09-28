/**
 * The local connection/reconnect backend behind `work.connection` and `work.reconnect`.
 *
 * The shared contract (`shared/work-connection.ts`) declares the two verbs and the one result
 * shape; this module is what actually answers them, against the durable registry and the app's
 * own browser. It is a *report*, not a control: reconnecting a page never resumes, pauses,
 * cancels or re-binds a work, and it never creates a work, an agent, a session or a conversation.
 *
 * Three rules carry the whole design, and each exists because the obvious alternative lies:
 *
 * 1. **`ready` is one fact, not a feeling.** It requires a current authenticated page sighting
 *    for the exact session *and* conversation the registry holds, with the closed-chat
 *    suppression already cleared by the real page-return path. A bridge heartbeat, recorder
 *    activity, an attributed MCP call and a live turn are all evidence that *something* is
 *    running; none of them is evidence that this chat is open, so none of them is consulted.
 * 2. **Selectors fence, they never redirect.** `agent_id` picks one of this work's agents and
 *    `conversation_id` is an exact expected-CID fence. A mismatch is reported as `unavailable`
 *    with the reason, never repaired into "whatever the registry holds now" — a caller that says
 *    which chat it believes it is talking about is owed the truth when that belief is wrong.
 * 3. **The lifecycle is read, never written.** A cancelled work, or an agent that has finished or
 *    failed, is `closed` and stays that way: nothing here unpauses or resurrects anything. A
 *    paused work is *not* closed — the page can still be reported and opened, and that is all
 *    this module ever claims.
 *
 * `reconnect` differs from `connection` in exactly one way: it may open the exact conversation in
 * the app's own profile and wait for the page to report. `timeout_ms: 0` means "report what is
 * true right now", and a caller who asked for an instant answer is never given a browser it
 * cannot wait for — so no open is started. One chat is one open, across time and across callers:
 * an open is retained until the page it was for is accounted for, because a launch resolving is
 * not evidence that the page returned. A repeated reconnect after a timeout joins that open
 * rather than starting a second tab. Every read after an await is fenced against the registry
 * again, so a target that moved while the browser was starting is refused instead of reported
 * `ready` against a binding this work may no longer own.
 */

import {
  WORK_ERROR_CODES,
  WorkServiceError
} from '../../shared/work.js';
import type { SessionSummary } from '../../shared/session.js';
import type {
  WorkConnectionPort,
  WorkConnectionResult,
  WorkConnectionState,
  WorkConnectionTarget,
  WorkReconnectRequest
} from '../../shared/work-connection.js';
import type { WorkAgentRow, WorkRow, WorkStore } from './store.js';

// --------------------------------------------------------------------------- deps

export interface WorkConnectionDeps {
  /**
   * The durable work ledger, or null before the host has restored it.
   *
   * Null is answered with `STATE_UNAVAILABLE` rather than an invented state: nothing has looked,
   * so nothing is known.
   */
  store: () => WorkStore | null;
  /**
   * Newest authenticated page sighting for one exact conversation, or null when this process has
   * never seen that page report. Written only by the authenticated browser poll path.
   */
  pageObservedAt: (conversationId: string) => number | null;
  /** One local session summary, or null when no such session exists. */
  readSession: (sessionId: string) => Promise<SessionSummary | null>;
  /**
   * Opens exactly this provider conversation in the app's own browser profile.
   *
   * The app-owned profile is not optional: the companion extension and the ChatGPT login live in
   * it, so a launch against the user's own profile would load neither while still looking like it
   * worked. This module never builds a URL — the host's single URL writer does.
   */
  open: (conversationId: string) => Promise<void>;
  now?: () => number;
  /** Waits `ms`. Injected so a test can drive time without a real timer. */
  wait?: (ms: number) => Promise<void>;
  /** How often a wait re-reads the page sighting. */
  pollMs?: number;
}

const DEFAULT_POLL_MS = 250;

/** Bound on a reported reason, matching the shared result schema's own maximum. */
const MAX_REASON_CHARS = 2000;

// --------------------------------------------------------------------------- resolution

/** One target that resolved to an existing agent with an exact bound conversation. */
interface ResolvedTarget {
  work: WorkRow;
  agent: WorkAgentRow;
  sessionId: string;
  conversationId: string;
  generation: number;
}

type Resolution =
  | { kind: 'resolved'; target: ResolvedTarget }
  | { kind: 'unresolved'; work: WorkRow; reason: string };

/**
 * One launch of one exact chat, retained until the page it was for is accounted for.
 *
 * `failure` is a field rather than a rejection because the launch is shared: a caller that joins
 * an attempt which failed while it was waiting must still be told why, and a rejection nobody is
 * holding would be an unhandled one.
 */
interface Opening {
  /** Settles when the launch settles; never rejects. */
  promise: Promise<void>;
  /** When the launch was started, comparable with the ledger's own timestamps. */
  launchedAt: number;
  failure: string | null;
}

/** One page read taken against the registry as it is at that moment. */
type FreshRead =
  | { kind: 'read'; target: ResolvedTarget; snapshot: PageSnapshot }
  | { kind: 'superseded'; work: WorkRow; reason: string };

/**
 * Resolves one target against the ledger.
 *
 * An unknown *work* is a refusal rather than a result: `work_state` is a required field, and a
 * host that answered it for a work it does not have would be inventing the very lifecycle value
 * this result exists to report honestly. That is the same refusal `work.status` gives.
 */
function resolveTarget(store: WorkStore, target: WorkConnectionTarget): Resolution {
  const work = store.getWork(target.work_id);
  if (!work) {
    throw new WorkServiceError(
      WORK_ERROR_CODES.workNotFound,
      'WORK_NOT_FOUND: no work with that id exists. Work ids are never resolved from the current selection.'
    );
  }
  const agents = store.listAgents(work.work_id);
  const agent = target.agent_id
    ? agents.find(candidate => candidate.agent_id === target.agent_id) ?? null
    : agents.find(candidate => candidate.agent_id === work.prime_agent_id) ??
      agents.find(candidate => candidate.role === 'prime') ?? null;
  if (!agent) {
    return {
      kind: 'unresolved',
      work,
      reason: target.agent_id
        ? 'that agent is not part of this work'
        : 'this work has no prime agent, so there is no page to report'
    };
  }
  const sessionId = agent.session_id;
  const conversationId = agent.conversation_id;
  if (!sessionId || !conversationId) {
    return { kind: 'unresolved', work, reason: 'this agent has no bound ChatGPT conversation yet' };
  }
  // An expected conversation is a fence. A mismatch names both sides and stops there; it is never
  // rewritten into the registry's current value, which is exactly the silent rebind this field
  // exists to prevent.
  if (target.conversation_id && target.conversation_id !== conversationId) {
    return {
      kind: 'unresolved',
      work,
      reason: `the expected conversation does not match the one this agent is bound to (expected ${target.conversation_id})`
    };
  }
  return { kind: 'resolved', target: { work, agent, sessionId, conversationId, generation: agent.generation } };
}

/**
 * Re-resolves a target that has already resolved once, against the ledger as it is *now*.
 *
 * A reconnect awaits a browser launch, and the ledger can move while it does: a continuation can
 * replace the agent's conversation, a generation can be fenced, the work can be cancelled, the
 * agent can finish. Reporting the pre-launch target after that would be an answer about a binding
 * this work may no longer own, so every read that follows an await goes through here.
 *
 * The selector a caller supplied is the one they are owed an answer about, so a mismatch is a
 * refusal naming both sides — the same fence `resolveTarget` applies, applied again to the rows
 * the ledger holds at the later moment. The result is a target that is identical to the original
 * except for the agent's lifecycle fields, which is what makes reporting its `work_state` honest.
 */
function fenceTarget(store: WorkStore, target: ResolvedTarget): Resolution {
  return resolveTarget(store, {
    work_id: target.work.work_id,
    agent_id: target.agent.agent_id,
    conversation_id: target.conversationId
  });
}

// --------------------------------------------------------------------------- page state

/** Whether the work's own lifecycle has already made this agent unusable. */
function lifecycleClosed(target: ResolvedTarget): string | null {
  if (target.work.status === 'cancelled' || target.work.desired_state === 'cancelled') {
    return 'this work was cancelled, so its chat is not usable again';
  }
  if (target.agent.state === 'finished' || target.agent.state === 'failed') {
    return `this work's agent is ${target.agent.state}, so it is not a live page to reconnect`;
  }
  return null;
}

/** One read of everything the page verdict is made of. */
interface PageSnapshot {
  state: WorkConnectionState;
  pageObservedAt: number | null;
  dismissedAt: number | null;
  reason: string | null;
  /** True when waiting cannot change the answer: the lifecycle already ended it. */
  final: boolean;
}

/**
 * The page verdict for one resolved target, from a session the caller has already read.
 *
 * The suppression and the session's own end are both honoured, because a chat the user closed and
 * a chat whose session has moved on are each "known to be closed" — and a sighting that predates
 * either of those decisions must not outvote them.
 *
 * Reading the session is the only thing a page read yields on, so the verdict itself is
 * synchronous: a caller that must not report a stale registry can resolve the target *after* that
 * await and make the verdict out of the rows the ledger holds then, which is what both verbs do —
 * even a plain read has one await in it, and a wait is long enough for the ledger to move under it.
 */
function pageVerdict(
  deps: WorkConnectionDeps,
  target: ResolvedTarget,
  session: SessionSummary | null
): PageSnapshot {
  const closed = lifecycleClosed(target);
  const dismissedAt = session?.browserRecoveryDismissedAt ?? null;
  const pageObservedAt = deps.pageObservedAt(target.conversationId);
  const base = { pageObservedAt, dismissedAt };
  if (closed) return { ...base, state: 'closed', reason: closed, final: true };
  if (!session || session.conversationId !== target.conversationId) {
    // The session is the durable identity and the chat is only its current frontend. A work bound
    // to a chat this session no longer carries has no page to report, and following the session to
    // its new chat would be a rebind dressed up as a reconnect.
    return { ...base, state: 'closed', reason: 'the session is no longer attached to this conversation', final: false };
  }
  if (session.endedAt !== null) {
    return { ...base, state: 'closed', reason: 'the chat was closed', final: false };
  }
  if (dismissedAt !== null && (pageObservedAt === null || pageObservedAt <= dismissedAt)) {
    return {
      ...base,
      state: 'closed',
      reason: 'the chat was closed by the user and no page has returned since',
      final: false
    };
  }
  if (pageObservedAt === null) {
    return {
      ...base,
      state: 'closed',
      reason: 'no page has reported for this conversation since this process started',
      final: false
    };
  }
  return { ...base, state: 'ready', reason: null, final: true };
}

// --------------------------------------------------------------------------- result shape

function resultOf(
  target: ResolvedTarget,
  snapshot: Pick<PageSnapshot, 'state' | 'pageObservedAt' | 'dismissedAt' | 'reason'>
): WorkConnectionResult {
  return {
    work_id: target.work.work_id,
    work_state: target.work.status,
    agent_id: target.agent.agent_id,
    generation: target.generation,
    session_id: target.sessionId,
    conversation_id: target.conversationId,
    state: snapshot.state,
    page_observed_at: snapshot.pageObservedAt,
    browser_recovery_dismissed_at: snapshot.dismissedAt,
    reason: snapshot.reason === null ? null : snapshot.reason.slice(0, MAX_REASON_CHARS)
  };
}

function unresolvedResult(work: WorkRow, reason: string): WorkConnectionResult {
  return {
    work_id: work.work_id,
    work_state: work.status,
    agent_id: null,
    generation: null,
    session_id: null,
    conversation_id: null,
    state: 'unavailable',
    page_observed_at: null,
    browser_recovery_dismissed_at: null,
    reason: reason.slice(0, MAX_REASON_CHARS)
  };
}

// --------------------------------------------------------------------------- port

export interface WorkConnectionHandle extends WorkConnectionPort {
  /** Test seam: forget the in-flight opens without touching any process. */
  reset(): void;
}

export function createWorkConnection(input: WorkConnectionDeps): WorkConnectionHandle {
  const deps: WorkConnectionDeps = input;
  const now = deps.now ?? Date.now;
  const wait = deps.wait ?? ((ms: number) => {
    const { promise, resolve } = Promise.withResolvers<void>();
    const timer = setTimeout(resolve, ms);
    timer.unref?.();
    return promise;
  });
  const pollMs = deps.pollMs ?? DEFAULT_POLL_MS;
  /**
   * Opens in flight, keyed by the exact chat they are opening.
   *
   * An entry is *not* removed when the launch resolves. A browser launch resolving is not evidence
   * that the page returned: a reconnect that times out leaves a tab that is still coming up, and
   * deleting the entry at that point is what let a repeated call launch a second tab for the same
   * chat. An entry is retired only by evidence that it is no longer the open for this chat — the
   * page reported for it, the launch failed, the ledger no longer binds this target, or the user
   * closed the chat after the launch — and a rebind moves the chat to a different key, which is a
   * different opening rather than the same one reused.
   */
  const openings = new Map<string, Opening>();

  function store(): WorkStore {
    const live = deps.store();
    if (live) return live;
    throw new WorkServiceError(
      WORK_ERROR_CODES.stateUnavailable,
      'STATE_UNAVAILABLE: the work ledger is open but its connection state is not restored yet.'
    );
  }

  /** One chat is one open: the key is the exact session/conversation the launch was for. */
  function keyOf(target: ResolvedTarget): string {
    return `${target.sessionId}:${target.conversationId}`;
  }

  /**
   * Starts an open, or joins the one this chat already has.
   *
   * The launch is not tracked as a bare promise, because a promise that settles says only that
   * *the launch* finished. A failure has to be readable after it settles (a caller waiting on a
   * shared attempt must still learn why it failed), and the moment of the launch has to be
   * comparable with the ledger's own timestamps, so both are recorded beside it.
   */
  function openOnce(target: ResolvedTarget): Opening {
    const key = keyOf(target);
    const existing = openings.get(key);
    if (existing) return existing;
    const opening: Opening = { promise: Promise.resolve(), launchedAt: now(), failure: null };
    opening.promise = deps.open(target.conversationId).then(
      () => undefined,
      error => {
        opening.failure = error instanceof Error ? error.message : String(error);
      }
    );
    openings.set(key, opening);
    return opening;
  }

  /**
   * Forgets the open a chat is known by.
   *
   * Used where the retained launch can no longer be joined for the chat it was made for: it
   * failed, the user closed that chat afterwards, or the ledger no longer binds it.
   */
  function forget(target: ResolvedTarget): void {
    openings.delete(keyOf(target));
  }

  /** Whether an unobserved launch may still be reused for this chat. */
  function reusable(opening: Opening, snapshot: PageSnapshot): boolean {
    // A close the user made *after* the launch is a decision about that tab, not about the chat:
    // a caller asking for a reconnect after it gets a launch of its own rather than being joined
    // to the tab the user just closed.
    return snapshot.dismissedAt === null || snapshot.dismissedAt < opening.launchedAt;
  }

  /**
   * One page read against the registry as it is now.
   *
   * Everything a reconnect does after its first await is fenced on this: a browser launch is long
   * enough for a generation change, a rebind or a cancellation to land, and reporting `ready`
   * against a binding that has since been replaced would be an answer about a chat this work may
   * no longer own. A target the ledger no longer holds is reported as `unavailable` with the
   * reason rather than repaired into whatever the registry holds now.
   */
  async function readFresh(target: ResolvedTarget): Promise<FreshRead> {
    const fence = fenceTarget(store(), target);
    if (fence.kind === 'unresolved') return { kind: 'superseded', work: fence.work, reason: fence.reason };
    const session = await deps.readSession(fence.target.sessionId);
    return { kind: 'read', target: fence.target, snapshot: pageVerdict(deps, fence.target, session) };
  }

  return {
    async connection(target: WorkConnectionTarget): Promise<WorkConnectionResult> {
      const resolution = resolveTarget(store(), target);
      if (resolution.kind === 'unresolved') return unresolvedResult(resolution.work, resolution.reason);
      // A read has one await in it, and that is already long enough for the ledger to move, so the
      // verdict is made against the rows the ledger holds when it is made.
      const read = await readFresh(resolution.target);
      return read.kind === 'superseded'
        ? unresolvedResult(read.work, read.reason)
        : resultOf(read.target, read.snapshot);
    },

    async reconnect(request: WorkReconnectRequest): Promise<WorkConnectionResult> {
      const resolution = resolveTarget(store(), request);
      if (resolution.kind === 'unresolved') return unresolvedResult(resolution.work, resolution.reason);
      const initial = await readFresh(resolution.target);
      if (initial.kind === 'superseded') return unresolvedResult(initial.work, initial.reason);
      const current = initial.snapshot;
      if (current.state === 'ready' || current.final) return resultOf(initial.target, current);
      // An instant answer is not a request for a browser nobody will wait for.
      if (request.timeout_ms <= 0) return resultOf(initial.target, current);
      // The fence in front of the launch: the open is started for what the ledger holds now.
      const fenced = fenceTarget(store(), initial.target);
      if (fenced.kind === 'unresolved') {
        forget(initial.target);
        return unresolvedResult(fenced.work, fenced.reason);
      }
      const target = fenced.target;
      const retained = openings.get(keyOf(target));
      if (retained && !reusable(retained, current)) forget(target);

      const deadline = now() + request.timeout_ms;
      const opening = openOnce(target);
      await opening.promise;

      // The open settled; the page may already have reported before it did.
      let latest = await readFresh(target);
      while (opening.failure === null && latest.kind === 'read' &&
             latest.snapshot.state !== 'ready' && !latest.snapshot.final && now() < deadline) {
        await wait(Math.min(pollMs, Math.max(0, deadline - now())));
        latest = await readFresh(target);
      }
      // Whatever happens next, this launch is no longer joinable: it failed, or the target it was
      // made for has been superseded, or the page it was for has been accounted for.
      if (opening.failure !== null || latest.kind === 'superseded' ||
          latest.snapshot.state === 'ready' || latest.snapshot.final) {
        forget(target);
      }
      if (latest.kind === 'superseded') return unresolvedResult(latest.work, latest.reason);
      if (opening.failure !== null) {
        return {
          ...resultOf(latest.target, latest.snapshot),
          state: 'unavailable',
          reason: `the chat could not be opened (${opening.failure})`
        };
      }
      if (latest.snapshot.state === 'ready' || latest.snapshot.final) {
        return resultOf(latest.target, latest.snapshot);
      }
      // The wait legitimately found nothing. It is reported as `opening`, not as a failure: an
      // exact dedicated-profile open *was* started and has not been observed yet, which is the
      // truth, and a caller that wants to keep waiting can ask again. The reason names the wait
      // rather than repeating the pre-open page verdict, which was read before the open existed.
      return {
        ...resultOf(latest.target, latest.snapshot),
        state: 'opening',
        reason: `an open of this chat was started, and no page reported within ${request.timeout_ms}ms`
      };
    },

    reset(): void {
      openings.clear();
    }
  };
}
