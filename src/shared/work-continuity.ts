/** Durable controller identity is independent of the replaceable execution conversation. */
export interface WorkControllerBinding {
  session_id: string;
  conversation_id: string;
  /**
   * The provider account this conversation was first observed under, or null before any
   * authenticated snapshot anchored one.
   *
   * The same conversation id under another account is a different chat, so the first snapshot
   * anchors and a later differing one is refused rather than silently re-anchored.
   */
  provider_account_id: string | null;
  work_id: string;
  bound_at: number;
  enabled: boolean;
  event_cursor: number;
  updated_at: number;
  /**
   * How this binding came to exist.
   *
   * `automatic` is the prime fallback the runtime performs when a work starts: the chat that
   * opened the work becomes its controller so it can receive the work's reports. It is the only
   * kind that may be replaced automatically, and only while the work has no controller at all —
   * the recovery case, where a crash between admission and the fallback left the work unowned.
   *
   * `explicit` is a person's decision: a UI rebind, a takeover, an unbind-and-rebind. It is never
   * replaced by anything but another explicit decision.
   *
   * A row written before this field existed reads as `explicit`. That is the conservative
   * direction: an old row keeps the protection it always had, and nothing already on disk can be
   * taken over by a later start.
   */
  origin: 'automatic' | 'explicit';
}

/** Only authenticated provider observations from an already bound conversation enter this inbox. */
export interface WorkControllerMessage {
  session_id: string;
  conversation_id: string;
  message_id: string;
  request_id: string;
  text: string;
  authored_at: number;
  state: 'pending' | 'accepted' | 'rejected';
  work_id: string | null;
  error: string | null;
  /**
   * The exact instruction text this message is dispatched as, frozen durably *before* the service
   * side effect.
   *
   * The relay composes the user's own words with the controller's preceding message, and a crash
   * between that composition and the durable admission would otherwise recompose it later — from a
   * recorder that has since recorded more, or from a page that has since been reloaded. The
   * service hashes the instruction it is given, so a replay that composed different bytes would be
   * a *different* command under the same request id and would be refused as a conflict instead of
   * joining the admission that already happened. Frozen here, a replay reuses these exact bytes.
   *
   * Null until the message is admitted; written once, and never rewritten.
   */
  dispatch_text?: string | null;
  /**
   * The exact assistant message the dispatched quotation came from, for audit.
   *
   * Null when no quotation travelled (which is the honest answer for a message with no proven
   * preceding assistant message, never a substitute from another turn or another time).
   */
  context_assistant_id?: string | null;
  /**
   * When a *native* call claimed this message, or null when no such call is in flight.
   *
   * A claim is a reservation: the controller conversation's own tool call has taken this message and
   * is about to admit it under its own public request id, but it may still be awaiting its own
   * journal or a path resolution. Until that call finishes — by producing its receipt, or by
   * releasing the claim — the automatic relay must not dispatch the same message, because both
   * paths would use the *same* durable request id for different work and whichever lost would be
   * refused as a conflict. Cleared by the claim's own completion or release, and by startup, since
   * no in-process call survives a restart.
   */
  claimed_at?: number | null;
  created_at: number;
}

export interface WorkControllerDelivery {
  delivery_id: string;
  session_id: string;
  conversation_id: string;
  work_id: string;
  /**
   * The binding authority this report was created under, frozen at creation.
   *
   * A report answers to the controller that produced it. Capturing the epoch and account here — and
   * never re-reading a later binding at send time — is what stops a report from being redirected
   * into a conversation, or an account, that did not ask for it.
   */
  bound_at: number;
  /** The anchored provider account of that binding. Never null: a report waits for the anchor. */
  provider_account_id: string;
  event_sequence: number;
  text: string;
  state: 'pending' | 'queued' | 'delivered' | 'unknown' | 'failed' | 'cancelled';
  error: string | null;
  created_at: number;
  updated_at: number;
}

/** An observation is not authority to bind an arbitrary conversation or change project scope. */
export interface WorkControllerObservation {
  sessionId: string;
  conversationId: string;
  messageId: string;
  text: string;
  authoredAt: number;
  source: 'user' | 'app';
  /**
   * Authenticated provider account that served this page, when the observer could prove it.
   *
   * Optional, and absent means "not observed" — never a guess. The first non-null value anchors
   * the binding; a later differing value is refused, because the same conversation id under
   * another account is a different chat.
   */
  providerAccountId?: string | null;
  /**
   * Whether the observer proved that no generation is live in this conversation.
   *
   * A message is only routed from a settled conversation, so the controller's own turn is never
   * interrupted and a half-typed branch is never executed. Absent means unproven, which defers.
   */
  settled?: boolean;
  /**
   * The controller's own preceding assistant message, when the observer can quote it exactly.
   *
   * See {@link WorkControllerSnapshot.context}: the instruction is relayed to a different
   * conversation, so a reference to "that plan" is only meaningful if the plan travels with it.
   */
  context?: string | null;
  /**
   * The exact provider message id of the assistant message `context` was quoted from.
   *
   * Optional, and absent means "the observer did not prove which message this is" — never a guess.
   * The host records it with the frozen dispatch so a crash replay can be shown to quote the same
   * preceding message rather than the answer to this very question.
   */
  precedingAssistantId?: string | null;
  /** The provider's own node id for this message, when the observer has one. */
  nodeId?: string | null;
}

/** A fresh, authenticated provider snapshot for one bound conversation. */
export interface WorkControllerSnapshot {
  conversationId: string;
  /**
   * The binding identity this read was performed for, echoed exactly as the watch handed it out.
   *
   * The browser reads a watch, then issues a network GET, then posts the answer, and the binding
   * can move in between — disabled, rebound to another conversation, re-enabled under a new
   * boundary, or rotated by a restart. Without this echo the host cannot tell a current answer from
   * a stale one: the conversation id alone still matches, so a superseded read would look like
   * fresh authority and could re-admit messages the newer binding has already left behind.
   *
   * The echo is checked before *anything* is anchored, remembered or executed, and a mismatch means
   * the body is ignored outright — a stale answer never bumps branch authority, never writes
   * membership evidence, and never routes.
   */
  sessionId: string;
  /** The binding boundary this read was authorized under, echoed from the watch. */
  boundAt: number;
  /**
   * The watch's opaque observation token, echoed exactly as it was handed out.
   *
   * This is the *authority* half of the echo. It is consumed when a read is accepted and rotated
   * whenever the binding's authority moves, so an answer produced under the previous authority
   * cannot be accepted no matter how well the rest of the echo matches. See
   * {@link WorkControllerWatch.observationToken}.
   */
  observationToken: string;
  /**
   * Which transport page of one read this body is, and which read it belongs to.
   *
   * A branch longer than one transport budget is read and posted as several pages of one snapshot
   * id. `complete` describes the *read* — whether the walk of the provider's own graph was
   * exhaustive — and never whether this body holds every page; the two are deliberately separate
   * facts, so a page of an exhaustive read still says `complete: true` while execution waits for
   * every page of that read. A single-body read is one page: `pageIndex: 0`, `lastPage: true`.
   */
  snapshotId: string;
  pageIndex: number;
  lastPage: boolean;
  providerAccountId: string | null;
  /**
   * The active branch's native user messages, oldest first.
   *
   * Membership of this list *is* the proof: a message that is on the branch may execute. Carrying
   * the whole set rather than only the newest message is what lets a phone's offline backlog
   * (requirements, then a correction, then "go") be admitted in order instead of losing
   * everything before the last one.
   */
  messages: Array<{
    messageId: string;
    text: string;
    authoredAt: number;
    /**
     * This message's OWN exact predecessor assistant text, when the observer can quote it.
     *
     * Per message, never one snapshot-wide quotation: an offline backlog of
     * `A / plan1 / go1 / plan2 / go2` must attach plan1 to go1 and plan2 to go2, and a sibling
     * branch's plan must never be attached after an edit. Absent means no quotation travels.
     */
    context?: string | null;
    /**
     * The exact provider message id of the assistant message `context` was quoted from.
     *
     * See {@link WorkControllerObservation.precedingAssistantId}: the id is what makes the
     * quotation provably the *preceding* visible assistant message, rather than the answer to this
     * same question or a sibling branch's plan.
     */
    precedingAssistantId?: string | null;
    /**
     * The provider's own request id for this user message (`message.metadata.request_id`), when
     * the observer can read it.
     *
     * This is the join the host uses to ask whether this exact question already executed managed
     * work: the runtime records one durable receipt per provider request on the admitted path, so a
     * controller chat whose own turn really ran the work must not be handed a duplicate of its own
     * message. Absent means unproven, and unproven is relayed rather than suppressed.
     */
    requestId?: string | null;
    /** The provider's own node id for this user message: branch identity proof, or null. */
    nodeId?: string | null;
  }>;
  /**
   * Whether `messages` is the *complete* active-branch user-message set for this conversation.
   *
   * Only a complete snapshot may reject a pending message as off-branch. An observer that can
   * only page through the branch sends `false`, and every message it omits stays pending until a
   * complete snapshot proves it: an absent row is never silently treated as edited away.
   */
  complete: boolean;
  /** True only when the observer proved that no generation is live. */
  settled: boolean;
}

/**
 * One conversation a browser is asked to read, and the two facts it must decide with *before*
 * fetching anything.
 *
 * `boundAt` is the binding's own `bound_at` — the instant this conversation became the work's
 * controller. It is deliberately not the binding's `event_cursor`: that is a work *event
 * sequence*, not a provider timestamp, and a watcher cannot use it as a watermark for provider
 * messages. Only provider user messages authored after `boundAt` may ever execute, which is what
 * keeps the history the user was already looking at out of the inbox.
 *
 * `providerAccountId` is the anchored provider account, or null while the binding is still
 * unanchored. It is exposed so the fetch can *refuse* rather than guess: an unanchored binding
 * must not adopt whichever account the browser happens to be signed into, because the same
 * conversation id under another account is a different chat.
 */
export interface WorkControllerWatch {
  sessionId: string;
  conversationId: string;
  boundAt: number;
  providerAccountId: string | null;
  /**
   * Opaque, per-binding authority token for one read.
   *
   * A watch is a *question* — "read this conversation under this authority" — and the browser's
   * answer comes back as a snapshot that must prove it is answering that same question. The token
   * is minted fresh by the host, travels with the watch, is echoed on the snapshot, and is rotated
   * by the host the moment it accepts a complete read (and whenever the binding's authority moves:
   * a rebind, a disable, a re-enable with a new boundary, a restart). An answer that arrives after
   * its token was rotated is therefore refused as stale rather than re-applied, which is what keeps
   * a slow network GET from resurrecting a branch the controller has already left.
   *
   * It carries no meaning beyond identity: it is compared for equality, never parsed, and never
   * derived from the account, the conversation or the clock.
   */
  observationToken: string;
}
