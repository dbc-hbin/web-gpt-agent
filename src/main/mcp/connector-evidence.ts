/**
 * The evidence clocks about the *other* side of the wire, in one place.
 *
 * Every connector card reports three separate facts, and they fail separately:
 *
 *  - discovery — the model's client pulled this connector's `tools/list`,
 *  - execution — a `tools/call` actually reached it,
 *  - a successful work control — a conversation, phone included, really drove work here.
 *
 * They live in their own dependency-free module rather than as module-locals scattered across
 * the endpoint and the work-control registrar because they are one subject read by two
 * writers and one reader (`connection.ts`). Keeping them here also keeps the reader honest:
 * it does not have to import the endpoint's whole graph just to ask what time it is, and a
 * host that replaces one of those modules still gets real answers.
 */

import type { SurfaceId } from './surfaces.js';

const discoveryAt = new Map<SurfaceId, number>();
const executionAt = new Map<SurfaceId, number>();
let workControlAt: number | null = null;

/** When this connector last answered `tools/list`, or null if it never has. */
export function lastDiscoveryAt(surface: SurfaceId): number | null {
  return discoveryAt.get(surface) ?? null;
}

/** When this connector last answered `tools/call`, or null if it never has. */
export function lastExecutionAt(surface: SurfaceId): number | null {
  return executionAt.get(surface) ?? null;
}

/** When one of the six no-DOM work controls last returned a result, or null. */
export function lastWorkControlAt(): number | null {
  return workControlAt;
}

/**
 * Classifies one accepted request body for the discovery/execution clocks.
 *
 * Read from the raw JSON-RPC method rather than from the SDK, because the SDK's handler is
 * built per request while the method is exactly what the wire carried. A batch or an
 * unparsable shape records nothing: these clocks are evidence, and guessing at evidence is
 * worse than leaving it unknown.
 */
export function noteRequestMethod(surface: SurfaceId, body: unknown): void {
  if (!body || typeof body !== 'object' || Array.isArray(body)) return;
  const method = (body as { method?: unknown }).method;
  if (method === 'tools/list') discoveryAt.set(surface, Date.now());
  else if (method === 'tools/call') executionAt.set(surface, Date.now());
}

/** Recorded only for a non-error result; a refusal proves reachability, not work. */
export function noteWorkControl(): void {
  workControlAt = Date.now();
}

/** Cleared with the server, so every answer is about the current endpoint. */
export function resetConnectorEvidence(): void {
  discoveryAt.clear();
  executionAt.clear();
  workControlAt = null;
}
