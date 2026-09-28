/**
 * Which durable local session owns a live `exec_command` process.
 *
 * Codex never needs this. It hangs `UnifiedExecProcessManager` off `session.services`, so a
 * session cannot even name another session's process: the manager it reaches is a
 * different object. This connector is one long-lived main process serving every chat through
 * one manager, so the same session ids are in scope everywhere, and `write_stdin(session_id)`
 * on a numeric id from another chat would otherwise reach that chat's shell.
 *
 * This is an authorization boundary. A proven owner can only be continued by that same durable
 * session, whose frontend attachment may legitimately change from A to B during Compact & Resume.
 * Legacy/single-chat calls that carry no request identity are kept in a separate
 * anonymous bucket so existing terminal semantics still work, but a later proven chat cannot
 * adopt such a session and an anonymous call cannot touch a proven-owned session.
 */

import { requestCorrelation } from '../session/correlation.js';
import { unifiedExecManager } from './manager.js';
import type { BackgroundExecState } from './unified-exec.js';

/**
 * Prevent one caller from indefinitely postponing already-completed command results.
 *
 * A completed result is bounded work — one `write_stdin` poll and it is gone — so a caller that
 * keeps launching commands instead of reading what they printed is refused until it drains them.
 * The budget is a refusal at the *next* launch, never automatic output appended to an unrelated
 * response: retained terminal text is read where it belongs, by polling that exact process id.
 */
export const MAX_UNREAD_EXEC_RESULTS_PER_CONVERSATION = 4;

/** Owners, keyed by the process id `exec_command` handed back as `session_id`. */
const owners = new Map<number, string | null>();
const REQUEST_PRINCIPAL_PREFIX = 'request:';

function requestPrincipal(requestId: string): string {
  return `${REQUEST_PRINCIPAL_PREFIX}${requestId}`;
}

function requestIdOfPrincipal(principal: string | null | undefined): string | null {
  return principal?.startsWith(REQUEST_PRINCIPAL_PREFIX)
    ? principal.slice(REQUEST_PRINCIPAL_PREFIX.length) || null
    : null;
}

function sessionOfPrincipal(principal: string | null | undefined): string | null {
  if (!principal) return null;
  const requestId = requestIdOfPrincipal(principal);
  return requestId ? requestCorrelation(requestId)?.sessionId ?? null : principal;
}

function samePrincipal(left: string | null | undefined, right: string | null | undefined): boolean {
  if (!left || !right) return left === right;
  if (left === right) return true;
  const leftSession = sessionOfPrincipal(left);
  const rightSession = sessionOfPrincipal(right);
  return Boolean(leftSession && rightSession && leftSession === rightSession);
}

/** A request id temporarily owns ordinary terminal state until exact session proof arrives. */
export function executionPrincipal(
  requestId: string | null | undefined,
  sessionId: string | null | undefined,
  allowUnattributed: boolean
): string | null {
  const exact = provenSession(requestId ?? null, sessionId ?? null);
  if (exact) return exact;
  if (allowUnattributed && requestId) return requestPrincipal(requestId);
  return null;
}

function processIdsOwnedBy(principal: string): Set<number> {
  const processIds = new Set<number>();
  for (const [processId, owner] of owners) if (samePrincipal(owner, principal)) processIds.add(processId);
  return processIds;
}

/**
 * The conversation behind an in-flight MCP request, when it is already proven.
 *
 * Never waits. The correlation registry resolves a request id the moment the page reports the
 * matching connector request, and everything here degrades to "unknown" rather than blocking a
 * command on browser evidence.
 */
export function provenConversation(requestId: string | null, conversationId: string | null): string | null {
  if (conversationId) return conversationId;
  return requestCorrelation(requestId)?.conversationId ?? null;
}

/** The stable local session principal behind this exact call, when it is proven. */
export function provenSession(requestId: string | null, sessionId: string | null): string | null {
  if (sessionId) return sessionId;
  return requestCorrelation(requestId)?.sessionId ?? null;
}

/** Records custody for a returned running or completed process id. */
export function noteExecOwner(processId: number | null, principal: string | null): void {
  if (processId === null) return;
  owners.set(processId, principal);
}

/** Drops custody only when the manager discards the process and its retained result. */
export function forgetExecOwner(processId: number | null): void {
  if (processId === null) return;
  owners.delete(processId);
}

/** The exact session or temporary request principal that opened this process. */
export function execOwner(processId: number): string | null {
  return owners.get(processId) ?? null;
}

/** One caller-scoped projection used by reminders, admission and runtime status. */
export function backgroundExecObligations(principal: string | null | undefined): BackgroundExecState {
  if (!principal) return { running: [], exitedUnread: [] };
  return unifiedExecManager.backgroundState(processIdsOwnedBy(principal));
}

/**
 * Whether `principal` may write to `processId`.
 *
 * Proven sessions require the same proven caller. Request principals upgrade lazily when exact
 * correlation arrives. Until then, only the request that opened a process can continue it;
 * knowing a small numeric process id is never ownership proof. Legacy anonymous custody remains
 * separate, and a process with no registry entry is refused.
 */
export function execOwnershipFailure(processId: number, principal: string | null):
  'unavailable' | 'anonymous' | 'unidentified' | 'different-owner' | null {
  if (!owners.has(processId)) return 'unavailable';
  const owner = owners.get(processId);
  if (samePrincipal(owner, principal)) return null;
  if (owner === null) return principal === null ? null : 'anonymous';
  if (!principal) return 'unidentified';
  const ownerSession = sessionOfPrincipal(owner);
  const callerSession = sessionOfPrincipal(principal);
  if (ownerSession && callerSession) return 'different-owner';
  // One side is still request-scoped. Exact correlation may later prove the same durable
  // session, so refuse as unidentified and let that same session_id be retried once. Do not
  // classify it as a foreign owner before the evidence exists, and never admit it by id alone.
  if (requestIdOfPrincipal(owner) || requestIdOfPrincipal(principal)) return 'unidentified';
  return 'different-owner';
}

/** Test seam: the registry is process-global state with no natural lifetime boundary. */
export function resetExecOwnershipForTests(): void {
  owners.clear();
}
