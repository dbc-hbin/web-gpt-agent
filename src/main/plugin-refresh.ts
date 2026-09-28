import { createHash, randomUUID } from 'node:crypto';
import { z } from 'zod';
import { readDurable, writeDurableNow } from './durable.js';
import { wakeBrowserWork } from './browser-wake.js';
import { logInfo, logWarn } from './logger.js';
import { surfaceDefinition } from './mcp/surfaces.js';
import { pluginManager } from './plugins/manager.js';
import { PLUGIN_MAX_TOOLS } from './plugins/exposure.js';
import type { PluginPublication, PluginRefreshRequest, PluginSurface, PluginToolSchema } from '../shared/plugin-refresh.js';

const app = z.string().regex(/^asdk_app_[a-zA-Z0-9_-]{1,160}$/);
const legacyCodeInput = z.object({ type: z.literal('object'), properties: z.object({ code: z.object({ type: z.literal('string') }) }) });
/**
 * The largest declaration list each connector can legitimately hold.
 *
 * One bound has to answer two different questions. What a connector publishes *now* is small
 * and fixed — Core's public list, or Desktop's and Plugins' two wrappers — but a connector
 * already installed in ChatGPT may still be holding the declaration set of a release from
 * before the code-first cutover, and a refresh that could not recognize that set could never
 * migrate it. So the bound is the larger historical contract per surface: Core's twenty
 * (nineteen plus the optional `session_finish`), Windows Desktop's twenty-four (eight browser,
 * thirteen Window2, two clipboard, `exec`) and Plugins' plugin-manager ceiling plus its local
 * `exec`. The same three numbers bound the provider-page reader in `extension/chatgpt-dom.js`.
 */
const DECLARATION_CEILING: Record<PluginSurface, number> = {
  core: 20,
  desktop: 24,
  plugins: PLUGIN_MAX_TOOLS + 1
};
/**
 * Core names a pre-cutover connector could hold that this release no longer publishes.
 *
 * Six `work_*` controls collapsed into the single `work` tool, and `session` and
 * `keep_astra_on_forever` were retired before that. They are evidence for identifying an older
 * installed surface during enrollment only: nothing here is ever registered, and completion
 * still requires the exact current declaration set.
 */
const RETIRED_CORE_TOOLS = [
  'work_start', 'work_list', 'work_status', 'work_instruct', 'work_control', 'work_events',
  'session', 'keep_astra_on_forever'
] as const;
/** Every Core name any release has published, public or internal. */
function coreToolNames(): Set<string> {
  const core = surfaceDefinition('core');
  return new Set<string>([...core.tools, ...core.capabilities, ...RETIRED_CORE_TOOLS]);
}
/**
 * The Core names that only ever appear in this connector's internal inventory.
 *
 * A pre-cutover Core connector published these outright, so their presence is what
 * distinguishes it from a same-named foreign connector: no other surface and no upstream
 * plugin declares them, and the two entry points every surface does publish are excluded so
 * a wrapper-only list can never qualify.
 */
const CORE_INTERNAL_NAMES = new Set<string>([
  ...surfaceDefinition('core').capabilities,
  ...RETIRED_CORE_TOOLS
].filter(name => !surfaceDefinition('core').tools.includes(name)));
const rowSchema = z.object({ surface: z.enum(['core', 'desktop', 'plugins']), schemaId: z.string(), id: z.string().uuid(), appId: app.nullable(), completedSchemaId: z.string().nullable(), attempted: z.boolean(), manual: z.boolean().optional().default(false), error: z.string().max(200).optional(), versionId: z.string().max(200).optional() });
type Row = z.infer<typeof rowSchema>;
const publications = new Map<PluginSurface, PluginPublication>();
const settling = new Map<PluginSurface, { schemaId: string; readyAt: number; timer?: ReturnType<typeof setTimeout> }>();
export const PLUGIN_REFRESH_DEBOUNCE_MS = 20_000;
let chain: Promise<unknown> = Promise.resolve();
function serial<T>(work: () => Promise<T>): Promise<T> { const result = chain.then(work, work); chain = result.catch(() => undefined); return result; }
async function rows(): Promise<Row[]> {
  const result = z.array(rowSchema).max(3).parse(await readDurable('plugin-refresh') ?? []);
  if (new Set(result.map(row => row.surface)).size !== result.length) throw new Error('Duplicate plugin surface mapping');
  // Legacy fail() marked discovery failures as clicks. A real claim always commits a
  // concrete appId, so null proves these rows never crossed the refresh boundary.
  let repaired = false;
  for (const row of result) if (row.attempted && row.appId === null) {
    row.attempted = false; delete row.error; repaired = true;
  }
  if (repaired) await writeDurableNow('plugin-refresh', result);
  return result;
}
function canonical(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonical).join(',')}]`;
  if (value && typeof value === 'object') return `{${Object.entries(value).filter(([, v]) => v !== undefined).sort(([a], [b]) => a.localeCompare(b)).map(([k, v]) => `${JSON.stringify(k)}:${canonical(v)}`).join(',')}}`;
  return JSON.stringify(value);
}
const hash = (value: unknown) => createHash('sha256').update(canonical(value)).digest('hex');
/**
 * The fields of one declaration that the wire actually carries.
 *
 * `annotations`, `outputSchema` and `title` are part of it: ChatGPT reads them, and a change
 * to any of them is a change the user can observe in their connector. They are therefore in
 * the publication hash, so a change confined to one of them still schedules a refresh.
 */
const WIRE_FIELDS = ['name', 'description', 'inputSchema', 'title', 'annotations', 'outputSchema', '_meta'] as const;
type WireField = (typeof WIRE_FIELDS)[number];
/**
 * The declaration as ChatGPT's own settings page can show it.
 *
 * The page exposes the name, the description and the input schema of each installed tool and
 * nothing else, so an observation read from it legitimately carries fewer fields than we
 * published. Comparing a whole declaration against such an observation would never match, so
 * the comparison below runs over exactly the fields the observation carries — never fewer
 * than these three — and a field the page cannot see is simply not part of the comparison.
 */
const OBSERVED_FIELDS: readonly WireField[] = ['name', 'description', 'inputSchema'];
/** The wire fields present on an observation, so a richer reader is compared field for field. */
function observedFields(tools: PluginToolSchema[]): WireField[] {
  const present = new Set<WireField>();
  for (const tool of tools) for (const field of WIRE_FIELDS) if (tool[field] !== undefined) present.add(field);
  for (const field of OBSERVED_FIELDS) present.add(field);
  return WIRE_FIELDS.filter(field => present.has(field));
}
const declaration = (tools: PluginToolSchema[], fields: readonly WireField[] = WIRE_FIELDS) =>
  tools.map(tool => Object.fromEntries(fields.filter(field => tool[field] !== undefined).map(field => [field, tool[field]])))
    .sort((a, b) => String(a.name).localeCompare(String(b.name)));
function recognizable(tools: unknown, surface: PluginSurface = 'core'): tools is PluginToolSchema[] {
  // An installed Plugins connector with every upstream tool disabled legitimately shows no
  // declarations, and that observation is what a migration away from it is verified against,
  // so only Core and Desktop reject an empty list outright.
  if (!Array.isArray(tools) || (!tools.length && surface !== 'plugins') || tools.length > DECLARATION_CEILING[surface] || JSON.stringify(tools).length > 300000) return false;
  if (tools.some(tool => !tool || typeof tool.name !== 'string' || typeof tool.description !== 'string' || !tool.inputSchema || typeof tool.inputSchema !== 'object')) return false;
  return tools.every(tool => tool.inputSchema.type === 'object') && new Set(tools.map(tool => tool.name)).size === tools.length;
}
function enrollable(tools: unknown, publication: PluginPublication): boolean {
  if (!recognizable(tools, publication.surface)) return false;
  const fields = observedFields(tools);
  const names = (items: PluginToolSchema[]) => canonical(items.map(tool => tool.name).sort());
  if (names(tools) === names(publication.tools)) return true;
  // Legacy installs contain any number of backend declarations plus an optional composer.
  // Require at least one exact manager-owned backend; a generic exec alone cannot enroll
  // an unknown app. Already-mapped app IDs are handled separately by claimPluginRefresh.
  if (publication.surface === 'plugins') {
    const catalog = pluginManager.tools().map(tool => ({ ...tool, description: tool.description ?? '' }));
    const expected = new Map(catalog.map(tool => [tool.name, hash(declaration([tool], fields))]));
    let knownBackends = 0;
    const recognized = tools.every(tool => {
      if (expected.get(tool.name) === hash(declaration([tool], fields))) { knownBackends++; return true; }
      return tool.name === 'exec' && legacyCodeInput.safeParse(tool.inputSchema).success;
    });
    return recognized && knownBackends > 0;
  }
  if (publication.surface === 'desktop') {
    const desktop = surfaceDefinition('desktop');
    const known = new Set([...desktop.tools, ...desktop.capabilities]);
    return tools.every(tool => known.has(tool.name)) && tools.some(tool => desktop.capabilities.includes(tool.name));
  }
  // Enabling or disabling Core capabilities can change the set before enrollment, and a
  // connector installed before the code-first cutover holds Core names this release no longer
  // publishes — `work_start` and its five siblings became one `work`, and `session` and
  // `keep_astra_on_forever` were retired before that.
  //
  // Core's internal declarations are not on the wire any more, so they cannot be compared
  // declaration by declaration the way they were when the whole Core list was published.
  // What identifies an older Core instead is its vocabulary: every installed name must be one
  // Core has ever published, and at least two must be names only Core's internal inventory
  // carries. A foreign connector would have to be named exactly `Web GPT Agent`, be routed as
  // one of this app's own apps, and populate its list entirely from this vocabulary to join
  // that evidence — and completion still requires the exact current public declaration set.
  return publication.surface === 'core' && tools.every(tool => coreToolNames().has(tool.name)) &&
    tools.filter(tool => CORE_INTERNAL_NAMES.has(tool.name)).length >= 2;
}
function matches(tools: unknown, expected: PluginToolSchema[], surface: PluginSurface = 'core'): boolean {
  if (!recognizable(tools, surface)) return false;
  const fields = observedFields(tools);
  return hash(declaration(tools, fields)) === hash(declaration(expected, fields));
}
/** Refresh can invalidate existing ChatGPT chats. Only a changed visible tool contract warrants it. */
export function publishPluginSurface(surface: PluginSurface, connectorName: string, _version: string, _instructions: string, tools: PluginToolSchema[]): void {
  const publication = { surface, connectorName, tools, schemaId: hash(declaration(tools)) };
  const previous = settling.get(surface);
  const changed = previous?.schemaId !== publication.schemaId;
  const restored = !publications.has(surface);
  publications.set(surface, publication);
  if (changed) {
    if (previous?.timer) clearTimeout(previous.timer);
    // Initial enrollment is immediate. Changes to an existing declaration wait for
    // the last tool-shape edit, including edits that reconnect the endpoint.
    const next = { schemaId: publication.schemaId, readyAt: previous ? Date.now() + PLUGIN_REFRESH_DEBOUNCE_MS : 0, timer: undefined as ReturnType<typeof setTimeout> | undefined };
    settling.set(surface, next);
    logInfo(`plugin refresh scheduled surface=${surface} schema=${publication.schemaId.slice(0, 12)} delayMs=${previous ? PLUGIN_REFRESH_DEBOUNCE_MS : 0}`);
    if (previous) {
      next.timer = setTimeout(() => {
        next.timer = undefined;
        logInfo(`plugin refresh due surface=${surface} schema=${publication.schemaId.slice(0, 12)} published=${publications.has(surface)}`);
        if (publications.has(surface)) wakeBrowserWork();
      }, PLUGIN_REFRESH_DEBOUNCE_MS);
      next.timer.unref();
    } else wakeBrowserWork();
  } else if (restored && previous.readyAt <= Date.now()) {
    // A reconnect can outlast the debounce. Its timer intentionally skipped the
    // absent surface; restoring that same now-due declaration must deliver the wake.
    wakeBrowserWork();
  }
}
export function unpublishPluginSurface(surface: PluginSurface): void { publications.delete(surface); }
export function pluginRefreshPublications(): PluginPublication[] { return structuredClone([...publications.values()]); }
/** App IDs are stable connector identities. The browser must prove current installation. */
export function pendingPluginRefreshes(): Promise<PluginRefreshRequest[]> {
  return serial(async () => {
    const current = await rows();
    let changed = false;
    for (const publication of publications.values()) {
      const found = current.find(row => row.surface === publication.surface);
      if (found?.schemaId === publication.schemaId) continue;
      const next: Row = { surface: publication.surface, schemaId: publication.schemaId, id: randomUUID(), appId: found?.appId ?? null, completedSchemaId: found?.completedSchemaId ?? null, attempted: false, manual: false };
      if (found) current[current.indexOf(found)] = next; else current.push(next);
      changed = true;
    }
    if (changed) {
      await writeDurableNow('plugin-refresh', current);
      logInfo(`plugin refresh pending observed ${current.filter(row => !row.manual && row.completedSchemaId !== row.schemaId).map(row => `surface=${row.surface} schema=${row.schemaId.slice(0, 12)} dueInMs=${Math.max(0, (settling.get(row.surface)?.readyAt ?? 0) - Date.now())}`).join(' ')}`);
    }
    return current.flatMap(row => {
      const publication = publications.get(row.surface);
      return publication && (settling.get(row.surface)?.readyAt ?? 0) <= Date.now() && publication.schemaId === row.schemaId && !row.attempted && !row.manual && row.completedSchemaId !== row.schemaId
        ? [{ ...structuredClone(publication), id: row.id, appId: row.appId }] : [];
    });
  });
}
type Identity = { id: string; appId: string };
function exact(current: Row[], identity: Identity): Row | undefined {
  if (!app.safeParse(identity.appId).success) return;
  return current.find(row => row.id === identity.id && publications.get(row.surface)?.schemaId === row.schemaId && (settling.get(row.surface)?.readyAt ?? 0) <= Date.now());
}
/** Commit one attempted click before the browser acts. A crash never re-arms it. */
export function claimPluginRefresh(input: Identity & { connectorName: string; tools: unknown; alreadyCurrent?: boolean }): Promise<boolean> {
  return serial(async () => {
    const current = await rows(); const row = exact(current, input);
    if (!row || row.attempted || row.manual || row.completedSchemaId === row.schemaId || !recognizable(input.tools, row.surface)) return false;
    const publication = publications.get(row.surface)!;
    // Unique-name discovery is initial enrollment only. Stale definitions can still
    // identify the surface; the complete post-refresh declarations must match below.
    if (row.appId ? row.appId !== input.appId : input.connectorName !== publication.connectorName || !enrollable(input.tools, publication)) return false;
    if (current.some(other => other !== row && other.appId === input.appId)) return false;
    const isCurrent = matches(input.tools, publication.tools, row.surface);
    if (input.alreadyCurrent === true ? !isCurrent : isCurrent) return false;
    row.appId = input.appId; row.attempted = true;
    delete row.error;
    // Enrollment/migration may find the installed declaration already current. Record
    // that observation without clicking Refresh or manufacturing a new plugin version.
    if (input.alreadyCurrent) row.completedSchemaId = row.schemaId;
    await writeDurableNow('plugin-refresh', current); return true;
  });
}
/**
 * Records a changed provider snapshot that this ChatGPT workspace cannot refresh in place.
 *
 * This is intentionally neither a completed refresh nor an attempted click. The same schema stays
 * visible as requiring manual recreation/republishing, but automatic browser maintenance stops
 * reopening its settings page. A later local schema change creates a fresh row and may be tried
 * again normally.
 */
export function requireManualPluginRefresh(input: Identity & { connectorName: string; tools: unknown; error: string }): Promise<boolean> {
  return serial(async () => {
    const current = await rows(); const row = exact(current, input);
    if (!row || row.attempted || row.manual || row.completedSchemaId === row.schemaId || !recognizable(input.tools, row.surface)) return false;
    const publication = publications.get(row.surface)!;
    if (row.appId ? row.appId !== input.appId : input.connectorName !== publication.connectorName || !enrollable(input.tools, publication)) return false;
    if (current.some(other => other !== row && other.appId === input.appId) || matches(input.tools, publication.tools, row.surface)) return false;
    row.appId = input.appId;
    row.manual = true;
    row.error = input.error.slice(0, 200);
    await writeDurableNow('plugin-refresh', current);
    logWarn(`plugin refresh requires manual action surface=${row.surface}: ${row.error}`);
    return true;
  });
}
export function completePluginRefresh(input: Identity & { tools: unknown; versionId?: string }): Promise<boolean> {
  return serial(async () => {
    const current = await rows(); const row = exact(current, input);
    if (!row || row.manual || !row.attempted || row.appId !== input.appId || !matches(input.tools, publications.get(row.surface)!.tools, row.surface)) return false;
    row.completedSchemaId = row.schemaId; delete row.error;
    if (input.versionId) row.versionId = input.versionId.slice(0, 200);
    await writeDurableNow('plugin-refresh', current); return true;
  });
}
export function failPluginRefresh(input: { id: string; error: string }): Promise<boolean> {
  return serial(async () => {
    const current = await rows(); const row = current.find(row => row.id === input.id);
    if (!row || publications.get(row.surface)?.schemaId !== row.schemaId || row.completedSchemaId === row.schemaId) return false;
    // Only claimPluginRefresh records an attempted click. Pre-claim failures remain
    // diagnostic errors, distinct from an ambiguous post-click outcome. Existing
    // maintenance may reobserve the same owned page until a claim actually succeeds.
    row.error = input.error.slice(0, 200); await writeDurableNow('plugin-refresh', current); return true;
  });
}
export function resetPluginRefreshForTests(): void { for (const row of settling.values()) if (row.timer) clearTimeout(row.timer); settling.clear(); publications.clear(); chain = Promise.resolve(); }
