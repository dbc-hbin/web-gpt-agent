/**
 * Types for the shipped provider reader.
 *
 * `provider-conversation.js` is plain ES module JavaScript because it runs inside an MV3 service
 * worker, which has no build step and no dynamic import. This file is the shape the rest of the
 * repository compiles against — the TypeScript project never widens the module to `any`, so the
 * snapshot a caller posts to the host is checked against the contract rather than trusted.
 */

/** One bound controller conversation, exactly as the host's own watch list describes it. */
export interface ProviderWatch {
  conversationId: string;
  /** The binding's own session id, echoed on every page so the host can check the binding. */
  sessionId?: string;
  /** The binding's own `bound_at`, in milliseconds. Only messages authored after it may execute. */
  boundAt: number;
  /** The anchored account, or null while the binding is unanchored. */
  providerAccountId: string | null;
  /**
   * The host's opaque per-binding observation token.
   *
   * Rotated by the host whenever a binding is disabled, rebound or the host restarts, and echoed
   * back on every page so a snapshot whose binding moved during the read is refused rather than
   * applied.
   */
  observationToken?: string | null;
}

/** One active-branch user message, in the shape the host's snapshot parser accepts. */
export interface ProviderSnapshotMessage {
  messageId: string;
  text: string;
  /** The provider's own timestamp in milliseconds. */
  authoredAt: number;
  /** The provider's own node key for this message on the walked branch. */
  nodeId: string;
  /** This message's OWN preceding visible assistant text, when the provider has one. */
  context?: string;
  /** The exact provider message id that `context` was quoted from. */
  precedingAssistantId?: string;
  /** `message.metadata.request_id`, the value the host correlates to a durable session. */
  requestId?: string;
}

/**
 * One page of an active branch: a bounded, ordered slice of its executable messages.
 *
 * Pages are disjoint and oldest-first, and the host applies a read only once every page of it has
 * arrived — so a backlog larger than one transport body is admitted whole. Pages are split by
 * *serialized size*, not by row count: `chars` is the text cost the host charges and `wire` is the
 * UTF-8 size of the rows as JSON, escaping included.
 */
export type ProviderSnapshotPage = ProviderSnapshotMessage[] & { chars: number; wire: number };

/** What one conversation read produced: either a snapshot or the reason there is none. */
export interface ProviderReadFailure {
  conversationId: string;
  ok: false;
  error: string;
  retryable?: boolean;
}

export interface ProviderReadSuccess {
  conversationId: string;
  ok: true;
  /** The account the document was served under, echoed for the host's own anchor check. */
  providerAccountId: string;
  /** The binding the read was made under, echoed so the host can refuse a moved binding. */
  boundAt: number;
  observationToken: string | null;
  /** True only when the branch proves no generation is live. */
  settled: boolean;
  /**
   * True only when the walk read *every* executable row of the branch.
   *
   * Nothing is discarded to fit — an oversized branch travels as several pages — but a message the
   * provider gave no usable timestamp for is still an unread row, and the host must not treat its
   * absence as proof the user edited it away.
   */
  exhaustive: boolean;
  /** Every page of this read, oldest first. */
  pages: ProviderSnapshotPage[];
}

export type ProviderReadResult = ProviderReadSuccess | ProviderReadFailure;

/** The subset of `Response` this module uses. */
export interface ProviderResponse {
  ok: boolean;
  status: number;
  json(): Promise<unknown>;
}

export interface ProviderReadOptions {
  fetchImpl?: (url: string, init?: Record<string, unknown>) => Promise<ProviderResponse>;
  timeoutMs?: number;
}

/** The signed-in account id, and nothing else — never the access token. */
export function readProviderAccountId(
  options?: ProviderReadOptions
): Promise<{ ok: true; accountId: string } | { ok: false; error: string }>;

/**
 * Every watched conversation's active branch, from one session read, at a bounded concurrency.
 *
 * An unanchored watch is read and reports the account it was served under, which is what anchors
 * it; an anchored watch whose account no longer matches is refused before its conversation is
 * requested. A watch this module cannot read comes back named, never silently dropped.
 */
export function readControllerConversations(
  watches: readonly ProviderWatch[],
  options?: ProviderReadOptions & { concurrency?: number }
): Promise<ProviderReadResult[]>;
