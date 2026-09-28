import type { McpServer } from '@modelcontextprotocol/server';
import { z } from 'zod';
import type { PluginToolSchema } from '../../shared/plugin-refresh.js';
import { fail, ok, type ToolResult } from './kernel.js';
import { toolSchema, toolSchemaJson } from './tool-declarations.js';

const SEARCH_BYTES = 64 * 1024;
interface CatalogIndex {
  names: string[];
  descriptions: string[];
  available: Set<string>;
  ordered: Array<{ position: number; searchText: string }>;
}
// Only names/order/search text are retained. Schemas and membership always come from
// this request's live catalog; editing a schema in place cannot serve stale arguments.
const catalogIndexes: CatalogIndex[] = [];
const searchSchema = z.object({
  query: z.string().trim().min(1).max(256).optional().describe('Match tool names and descriptions; returns exact schemas.'),
  names: z.array(z.string().min(1).max(256)).min(1).max(20).optional().describe('Exact tool names whose schemas are needed.'),
  limit: z.number().int().min(1).max(20).default(5),
  offset: z.number().int().min(0).max(10000).default(0)
}).strict().refine(input => !(input.query && input.names), 'Use query or names, not both.');

/** Metadata only: connector authentication applies, but no worker or backend invocation is needed. */
export function registerToolSearch(server: McpServer, getTools: () => PluginToolSchema[]): PluginToolSchema {
  const description = 'Discover this connector’s JavaScript tools. No query/names lists bounded summaries; query or exact names returns full input/output schemas. Then call tools["name"](value) inside exec: an object schema takes one argument object, a string schema takes the raw string itself. Repeat the same selection with next_offset to continue. Never guesses arguments or executes tools.';
  const annotations = { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false };
  server.registerTool('tools_search', { title: 'Find tool schemas', description, inputSchema: toolSchema(searchSchema), annotations }, async args => {
    const parsed = searchSchema.safeParse(args);
    if (!parsed.success) return fail('INVALID_ARGUMENTS: use query or names, limit 1–20 and a nonnegative offset.');
    const { query, names, limit, offset } = parsed.data;
    const catalog = getTools();
    let index = catalogIndexes.find(candidate => candidate.names.length === catalog.length &&
      catalog.every((tool, position) => tool.name === candidate.names[position] && tool.description === candidate.descriptions[position]));
    if (!index) {
      const names = catalog.map(tool => tool.name);
      const descriptions = catalog.map(tool => tool.description);
      index = { names, descriptions, available: new Set(names),
        ordered: catalog.map((tool, position) => ({ position, searchText: `${tool.name} ${tool.description}`.toLocaleLowerCase() }))
          .sort((a, b) => names[a.position]! < names[b.position]! ? -1 : names[a.position]! > names[b.position]! ? 1 : 0) };
      // Bound retention across connectors and permission/catalog revisions. Larger
      // catalogs still work, but do not become permanent process memory.
      if (catalog.length <= 256 && names.reduce((size, name, position) => size + name.length + descriptions[position]!.length, 0) <= SEARCH_BYTES) {
        if (catalogIndexes.length === 4) catalogIndexes.shift();
        catalogIndexes.push(index);
      }
    }
    const wanted = names ? new Set(names) : null;
    if (wanted) {
      const missing = [...wanted].filter(name => !index.available.has(name));
      if (missing.length) return fail(`TOOL_SEARCH_UNKNOWN: not available on this connector: ${missing.map(name => JSON.stringify(name)).join(', ')}.`);
    }
    const words = query?.toLocaleLowerCase().split(/\s+/);
    const matching = index.ordered.filter(entry => wanted ? wanted.has(catalog[entry.position]!.name) : !words || words.every(word => entry.searchText.includes(word)));
    const full = Boolean(query || names);
    const page: string[] = [];
    let pageBytes = 0;
    const prefix = '{"tools":[';
    const suffix = `],"total":${matching.length},"limit":${limit},"offset":${offset},"next_offset":`;
    for (const entry of matching.slice(offset, offset + limit)) {
      const tool = catalog[entry.position]!;
      // The name alone: how the argument is shaped is the schema's own `type` (string versus object),
      // and a fixed `(args)` snippet would be actively wrong for the one raw-string tool.
      const call = `tools[${JSON.stringify(tool.name)}]`;
      const row = JSON.stringify(full ? { ...tool, call } : { name: tool.name, description: tool.description.slice(0, 600), call });
      const rowBytes = Buffer.byteLength(row, 'utf8') + (page.length ? 1 : 0);
      const next = offset + page.length + 1 < matching.length ? String(offset + page.length + 1) : 'null';
      if (prefix.length + pageBytes + rowBytes + suffix.length + next.length + 1 > SEARCH_BYTES) {
        if (!page.length) return fail(`TOOL_SEARCH_TOO_LARGE: the complete schema for ${JSON.stringify(tool.name)} exceeds ${SEARCH_BYTES} bytes. No schema was truncated.`);
        break;
      }
      page.push(row);
      pageBytes += rowBytes;
    }
    const next = offset + page.length < matching.length ? String(offset + page.length) : 'null';
    return ok(prefix + page.join(',') + suffix + next + '}') satisfies ToolResult;
  });
  return { name: 'tools_search', title: 'Find tool schemas', description, inputSchema: toolSchemaJson(searchSchema), annotations };
}
