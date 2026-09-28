/**
 * Canonical identity for external declarations and catalogs.
 *
 * Two modules need to agree on what "this exact declaration" means: the Core gateway publishes a
 * `schema_hash` a caller must echo back, and the plugin manager re-derives that hash under its
 * serial queue to prove the declaration a caller was admitted against is still the one being
 * dispatched. Both sides therefore hash with this one function, over this one canonical form.
 */

import { createHash } from 'node:crypto';
import type { Tool } from '@modelcontextprotocol/client';

/** Canonical JSON with sorted keys, so a hash never depends on property order. */
export function canonicalize(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(canonicalize);
  if (value && typeof value === 'object')
    return Object.fromEntries(
      Object.entries(value as Record<string, unknown>)
        .filter(([, entry]) => entry !== undefined)
        .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
        .map(([key, entry]) => [key, canonicalize(entry)])
    );
  return value;
}

export function canonicalSha256(value: unknown): string {
  return createHash('sha256').update(JSON.stringify(canonicalize(value))).digest('hex');
}

/**
 * The schema hash a caller must echo back on `mcp_call`.
 *
 * It covers the complete declaration — input schema, output schema and annotations — because a
 * caller that has the current input shape but a stale output shape would misread the result, and
 * because annotations are what a caller uses to decide whether it may omit a receipt. `$ref`
 * bodies are part of the value, so a schema that moved a definition into `$defs` hashes
 * differently even when its rendered shape is unchanged.
 */
export function externalSchemaHash(tool: Tool): string {
  return canonicalSha256({
    name: tool.name,
    description: tool.description ?? '',
    inputSchema: tool.inputSchema,
    ...(tool.outputSchema ? { outputSchema: tool.outputSchema } : {}),
    ...(tool.annotations ? { annotations: tool.annotations } : {}),
    ...(tool.title ? { title: tool.title } : {})
  });
}
