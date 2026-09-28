import { z } from 'zod';
import { workStateSchema } from './work.js';

/**
 * The local connection/reconnect contract, declared once.
 *
 * This is a *local* surface: the CLI and the desktop app ask whether a work's existing
 * conversation is still usable, and ask for it to be brought back. It deliberately does not
 * appear in the MCP `work` action union — a model cannot reconnect a page — and it never
 * creates a work, an agent, a session or a conversation.
 *
 * Everything here is addressed to a target that must already exist:
 *
 *  - `work_id` names durable work.
 *  - `agent_id` selects one of that work's agents. Omitted means the work's current prime.
 *  - `conversation_id` is an **exact expected-CID fence**, never a rebind target: a caller that
 *    says which chat it believes it is talking about is told the truth when that belief is
 *    wrong, instead of being quietly pointed at whatever the registry holds now.
 *
 * A target that cannot be resolved — no such work, no such agent in it, a generation that is no
 * longer current, an expected conversation that does not match — is reported as an explicit
 * `unavailable` result with a reason. It is never repaired into a different target.
 */

/**
 * A provider conversation id, exactly as loosely as the host's own wire validator accepts it.
 *
 * ChatGPT conversation ids are uuid-shaped, and a real one is a v4 *or* v8 uuid; the bridge
 * accepts that shape rather than one version, so this does too. Being stricter here than the
 * host would refuse a legitimate chat for no reason.
 */
const conversationIdSchema = z.string().min(8).max(64).regex(/^[0-9a-f-]+$/i);

/** One existing work plus optional selectors. Selectors narrow; they never redirect. */
export const workConnectionTargetSchema = z.object({
  work_id: z.uuid(),
  /** Omitted means the work's current prime agent. */
  agent_id: z.uuid().optional(),
  /** Exact expected conversation id. A mismatch is a refusal, not a rebind. */
  conversation_id: conversationIdSchema.optional()
}).strict();
export type WorkConnectionTarget = z.infer<typeof workConnectionTargetSchema>;

/**
 * How long a reconnect may wait for the page to become ready.
 *
 * `0` is legal and means "report what is true right now" — a caller that must not open a tab
 * can still ask. The ceiling is bounded so a hung wait cannot outlive the CLI's own deadline.
 */
export const WORK_RECONNECT_DEFAULT_TIMEOUT_MS = 30_000;
export const WORK_RECONNECT_MAX_TIMEOUT_MS = 60_000;

export const workReconnectRequestSchema = workConnectionTargetSchema.extend({
  timeout_ms: z.number().int().min(0).max(WORK_RECONNECT_MAX_TIMEOUT_MS)
    .default(WORK_RECONNECT_DEFAULT_TIMEOUT_MS)
}).strict();
export type WorkReconnectRequest = z.infer<typeof workReconnectRequestSchema>;

/**
 * What one connection/reconnect attempt established.
 *
 * `state` is about the *page*, and it is the only field that is ever `ready`:
 *
 *  - `ready` — a current authenticated page sighting for this exact session/conversation, with
 *    the closed-chat suppression already cleared by the real page-return path. Nothing weaker
 *    counts: a bridge heartbeat, recorder activity or an attributed MCP call are all evidence
 *    that *something* is running, and none of them is evidence that this chat is open.
 *  - `opening` — an exact dedicated-profile open was started (or is already in flight) and has
 *    not been observed yet.
 *  - `closed` — this chat is not usable now, and waiting cannot change it: the work's own
 *    lifecycle ended the agent (cancelled, or a finished/failed agent), the session no longer
 *    carries this conversation, the chat was closed, or no page has reported for this
 *    conversation since this host process started. A paused work is **not** closed: it is still
 *    a page that can be reported and reopened, and reconnecting never resumes it.
 *  - `unavailable` — the target could not be resolved, or the attempt failed. `reason` says why.
 *    A selector that names another agent's chat, or an agent with no bound conversation, lands
 *    here rather than being repaired into a different target.
 *
 * `work_state` is the ledger's own lifecycle value and is reported unchanged: reconnecting a
 * page never resumes, pauses or cancels work.
 *
 * `page_observed_at` and `browser_recovery_dismissed_at` are the two raw facts behind `ready`,
 * so a caller can tell "never seen" from "seen, but suppressed". `page_observed_at` is
 * process-local — it is the authenticated page poll path of *this* host — so `null` means "not
 * since this process started", never "never in this app's life". Both are `null` when the
 * registry holds no such value for this agent.
 */
export const WORK_CONNECTION_STATES = ['closed', 'opening', 'ready', 'unavailable'] as const;
export const workConnectionStateSchema = z.enum(WORK_CONNECTION_STATES);
export type WorkConnectionState = z.infer<typeof workConnectionStateSchema>;

export const workConnectionResultSchema = z.object({
  work_id: z.uuid(),
  /** The ledger's lifecycle value, reported unchanged. */
  work_state: workStateSchema,
  /** Explicitly null when the registry holds no binding for this work/agent. */
  agent_id: z.uuid().nullable(),
  generation: z.number().int().nonnegative().nullable(),
  session_id: z.string().nullable(),
  conversation_id: conversationIdSchema.nullable(),
  state: workConnectionStateSchema,
  /** Last authenticated page sighting for this exact session/conversation, or null. */
  page_observed_at: z.number().int().nonnegative().nullable(),
  /** When a person dismissed this chat's recovery prompt, or null. */
  browser_recovery_dismissed_at: z.number().int().nonnegative().nullable(),
  /** Why this is not `ready`. Null only for `ready`. */
  reason: z.string().max(2000).nullable()
}).strict();
export type WorkConnectionResult = z.infer<typeof workConnectionResultSchema>;

/**
 * The backend port the CLI socket and the app's IPC both call.
 *
 * One shape for both verbs, because they differ only in whether they may wait: `connection`
 * reports what is true now, `reconnect` may wait up to the request's own `timeout_ms`. A host
 * that has not restored its work authority answers `unavailable` rather than throwing.
 */
export interface WorkConnectionPort {
  connection(target: WorkConnectionTarget): Promise<WorkConnectionResult>;
  reconnect(request: WorkReconnectRequest): Promise<WorkConnectionResult>;
}
