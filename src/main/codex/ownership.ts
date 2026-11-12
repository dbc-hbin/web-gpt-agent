/**
 * Request/session identity for code-mode stores and search cursors.
 * Ordinary terminal process IDs are shared across chats and do not require this identity.
 */

import { requestCorrelation } from '../session/correlation.js';

/** A request principal can later resolve to its exact durable session. */
export function executionPrincipal(
  requestId: string | null | undefined,
  sessionId: string | null | undefined,
  allowUnattributed: boolean
): string | null {
  const exact = sessionId || requestCorrelation(requestId ?? null)?.sessionId;
  if (exact) return exact;
  if (allowUnattributed && requestId) return `request:${requestId}`;
  return null;
}
