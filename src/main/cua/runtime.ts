import { access } from 'node:fs/promises';
import { Client, type Tool, type CallToolResult } from '@modelcontextprotocol/client';
import { StdioClientTransport } from '@modelcontextprotocol/client/stdio';
import { AjvJsonSchemaValidator } from '@modelcontextprotocol/client/validators/ajv';
import type { EmbeddedCuaDriverHost } from '@trycua/cua-driver/embedded';
import sharp from 'sharp';
import type { MacOSDesktopAccessStatus } from '../../shared/types.js';
import { BUNDLE_ID } from '../identity.js';
import { externalSchemaHash } from '../plugins/external-declaration.js';
import { ExternalNotDispatched, pluginManager } from '../plugins/manager.js';
import { projectCuaCatalog } from './catalog.js';

export interface EmbeddedCuaCatalog { generation: number; tools: readonly Tool[] }
export interface EmbeddedCuaExpectation { schemaHash: string; generation: number }
export interface EmbeddedCuaLocation { binaryPath: string; sdkModule: string }
type Host = EmbeddedCuaDriverHost;
type Live = { host: Host; client: Client; transport: StdioClientTransport; generation: number; hostGeneration: string; tools: Tool[]; users: number; drain: Array<() => void>; verifiedHost: boolean };

const validator = new AjvJsonSchemaValidator() as unknown as { getValidator(schema: Tool['inputSchema']): (args: unknown) => { valid: boolean; errorMessage?: string } };
let live: Live | null = null;
let generation = 0;
let transition: Promise<void> = Promise.resolve();
let closing = false;
let error: string | null = null;
let permissionStatus: MacOSDesktopAccessStatus | null = null;
// Only the Electron backend supplies these paths. Shared MCP discovery stays Node-safe.
let location: EmbeddedCuaLocation | null = null;
const listeners = new Set<() => void>();
const unavailableStatus = (message: string): MacOSDesktopAccessStatus => ({
  screen: 'unknown', accessibility: 'unknown', checkedAt: Date.now(), error: message.slice(0, 300)
});

function changed(): void { for (const listener of listeners) listener(); }
export function onEmbeddedCuaChanged(listener: () => void): () => void {
  listeners.add(listener); return () => listeners.delete(listener);
}
export function embeddedCuaCatalog(): EmbeddedCuaCatalog | null {
  return live ? { generation: live.generation, tools: live.tools } : null;
}
export function embeddedCuaStatus(): { ready: boolean; error: string | null; generation: number } {
  return { ready: live !== null, error, generation };
}
export function getEmbeddedCuaPermissions(): MacOSDesktopAccessStatus | null { return permissionStatus; }

function enqueue(action: () => Promise<void>): Promise<void> {
  const task = transition.then(action, action);
  transition = task.catch(() => undefined);
  return task;
}

async function retire(owner: Live): Promise<void> {
  if (live === owner) { live = null; permissionStatus = null; changed(); }
  if (owner.users) {
    const settled = Promise.withResolvers<void>();
    owner.drain.push(settled.resolve);
    await settled.promise;
  }
  await owner.client.close().catch(() => undefined);
  await owner.host.stop().catch(() => undefined);
  owner.host.uniffiDestroy();
}

async function create(): Promise<void> {
  if (closing || live || (process.platform !== 'darwin' && process.platform !== 'win32')) return;
  if (!location) throw new Error('Embedded CUA startup has not been configured by the desktop backend.');
  await access(location.binaryPath);
  if (closing) return;
  // Upstream is ESM-only; the backend supplies the unpacked physical module in packages.
  const { EmbeddedCuaDriverHost } = await import(location.sdkModule);
  const host = new EmbeddedCuaDriverHost(location.binaryPath, BUNDLE_ID);
  let client: Client | null = null;
  try {
    const connection = await host.start();
    if (closing) throw new Error('Embedded CUA host is shutting down.');
    const env: Record<string, string> = {};
    for (const [key, value] of Object.entries(process.env)) if (typeof value === 'string') env[key] = value;
    for (const entry of connection.mcp.environment) env[entry.name] = entry.value;
    const transport = new StdioClientTransport({ command: connection.mcp.command, args: connection.mcp.args,
      env, stderr: 'ignore', maxBufferSize: 16 * 1024 * 1024 });
    client = new Client({ name: 'web-gpt-agent-embedded-cua', version: '1' });
    await client.connect(transport, { timeout: 20_000 });
    const discovered: Tool[] = [];
    let cursor: string | undefined;
    do {
      const page = await client.listTools(cursor ? { cursor } : undefined);
      discovered.push(...page.tools);
      if (discovered.length > 256) throw new Error('Bundled CUA Driver advertised more than 256 tools.');
      cursor = page.nextCursor;
    } while (cursor);
    const tools = projectCuaCatalog(discovered);
    if (!tools.length) throw new Error('Bundled CUA Driver declared none of the reviewed native tools.');
    if (tools.some(tool => Buffer.byteLength(JSON.stringify(tool)) > 250_000))
      throw new Error('Bundled CUA Driver advertised an oversized native schema.');
    if (process.platform === 'darwin') {
      // check_permissions alone reports the configured host even when spawned from a plain
      // Node process. The driver's bundle_identity check also proves the *parent application*.
      const health = discovered.find(tool => tool.name === 'health_report');
      if (!health) throw new Error('Driver cannot verify parent application identity.');
      const report = await client.callTool({ name: 'health_report', arguments: { include: ['bundle_identity'] } },
        { timeout: 20_000, toolDefinition: health });
      const data = report.structuredContent as Record<string, unknown> | undefined;
      const checks = Array.isArray(data?.checks) ? data.checks : [];
      const identity = checks.find(check => check && typeof check === 'object' && 'name' in check && check.name === 'bundle_identity');
      if (!identity || typeof identity !== 'object' || !('status' in identity) ||
          identity.status !== 'pass' && identity.status !== 'ok')
        throw new Error('Driver could not verify the parent macOS app bundle identity.');
      const detail = 'data' in identity && identity.data && typeof identity.data === 'object' ? identity.data : null;
      if (!detail || !('configured_bundle_identifier' in detail) || detail.configured_bundle_identifier !== BUNDLE_ID ||
          !('identity_source' in detail) || detail.identity_source !== 'parent_application')
        throw new Error('Driver bundle identity does not belong to this app.');
    }
    const owner: Live = { host, client, transport, generation: ++generation, hostGeneration: connection.generation,
      tools, users: 0, drain: [], verifiedHost: process.platform !== 'darwin' };
    live = owner;
    error = null;
    if (process.platform === 'darwin') {
      const status = await readEmbeddedCuaPermissions();
      if (!owner.verifiedHost) throw new Error(status?.error ?? 'Driver did not verify app TCC responsibility.');
    }
    client.onclose = () => {
      if (live !== owner) return;
      live = null; error = 'Bundled CUA Driver connection closed.'; permissionStatus = unavailableStatus(error); changed();
      void enqueue(() => retire(owner));
    };
    changed();
    void host.waitForExit(connection.generation).then(() => {
      if (live !== owner) return;
      live = null; error = 'Bundled CUA Driver exited unexpectedly.'; permissionStatus = unavailableStatus(error); changed();
      void enqueue(() => retire(owner));
    }).catch(() => undefined);
  } catch (cause) {
    live = null;
    permissionStatus = null;
    await client?.close().catch(() => undefined);
    await host.stop().catch(() => undefined);
    host.uniffiDestroy();
    throw cause;
  }
}

export function startEmbeddedCua(initialLocation: EmbeddedCuaLocation): Promise<void> {
  return enqueue(async () => {
    location ??= { ...initialLocation };
    try { await create(); }
    catch (cause) { error = `Bundled CUA Driver unavailable: ${cause instanceof Error ? cause.message : String(cause)}`.slice(0, 500); await readEmbeddedCuaPermissions(); changed(); }
  });
}
export function restartEmbeddedCua(): Promise<void> {
  return enqueue(async () => {
    const previous = live;
    live = null; permissionStatus = null; changed();
    if (previous) await retire(previous);
    try { await create(); }
    catch (cause) { error = `Bundled CUA Driver unavailable: ${cause instanceof Error ? cause.message : String(cause)}`.slice(0, 500); await readEmbeddedCuaPermissions(); changed(); }
  });
}
export function stopEmbeddedCua(): Promise<void> {
  closing = true;
  if (live) changed();
  return enqueue(async () => {
    const previous = live;
    live = null; permissionStatus = null;
    if (previous) await retire(previous);
    changed();
  });
}

function requireLive(expected: EmbeddedCuaExpectation, name: string): { owner: Live; tool: Tool } {
  const owner = live;
  if (closing || !owner) throw new ExternalNotDispatched(`CUA_DRIVER_UNAVAILABLE: ${error ?? 'the bundled driver is not ready'}.`);
  if (owner.generation !== expected.generation)
    throw new ExternalNotDispatched('MCP_CONNECTION_REPLACED: the embedded driver restarted; observe again before input.');
  const tool = owner.tools.find(candidate => candidate.name === name);
  if (!tool) throw new ExternalNotDispatched(`CUA_TOOL_UNAVAILABLE: ${name} is not declared by the bundled driver.`);
  if (externalSchemaHash(tool) !== expected.schemaHash)
    throw new ExternalNotDispatched('MCP_SCHEMA_CHANGED: read the current native schema before calling.');
  return { owner, tool };
}

export function validateEmbeddedCuaArguments(tool: Tool, args: Record<string, unknown>): { ok: true } | { ok: false; detail: string } {
  try {
    const result = validator.getValidator(tool.inputSchema)(args);
    return result.valid ? { ok: true } : { ok: false, detail: String(result.errorMessage ?? 'schema mismatch').slice(0, 600) };
  } catch (cause) {
    return { ok: false, detail: cause instanceof Error ? cause.message.slice(0, 200) : String(cause).slice(0, 200) };
  }
}

/** Validation and generation proof occur again immediately before dispatch, after caller admission. */
export async function invokeEmbeddedCua(name: string, args: Record<string, unknown>, expected: EmbeddedCuaExpectation,
  admitted?: () => Promise<boolean>): Promise<CallToolResult> {
  const { owner, tool } = requireLive(expected, name);
  if (process.platform === 'darwin' && !owner.verifiedHost && name !== 'check_permissions')
    throw new ExternalNotDispatched('CUA_HOST_IDENTITY_UNVERIFIED: the child did not prove this app owns its TCC grant.');
  const validation = validateEmbeddedCuaArguments(tool, args);
  if (!validation.ok) throw new ExternalNotDispatched(`CUA_INVALID_ARGUMENTS: ${validation.detail}`);
  owner.users++;
  try {
    if (admitted && !(await admitted())) throw new ExternalNotDispatched('CUA_PERMISSION_OR_IDENTITY_CHANGED: caller authority changed.');
    requireLive(expected, name);
    if (process.platform === 'darwin' && !owner.verifiedHost && name !== 'check_permissions')
      throw new ExternalNotDispatched('CUA_HOST_IDENTITY_UNVERIFIED: the child did not prove this app owns its TCC grant.');
    const result = await owner.client.callTool({ name, arguments: args }, { timeout: 120_000, toolDefinition: tool });
    if (Buffer.byteLength(JSON.stringify(result)) > 16 * 1024 * 1024)
      return pluginManager.redactResult({ isError: true, content: [{ type: 'text', text: 'CUA_RESULT_TOO_LARGE: Result exceeds 16 MiB.' }] });
    for (const block of result.content) if (block.type === 'image') {
      const image = Buffer.from(block.data, 'base64');
      const info = await sharp(image, { limitInputPixels: 36_000_000 }).metadata();
      if (!info.width || !info.height || info.width * info.height > 36_000_000 ||
          block.mimeType !== `image/${info.format === 'svg' ? 'svg+xml' : info.format}`)
        return pluginManager.redactResult({ isError: true, content: [{ type: 'text', text: 'CUA_IMAGE_INVALID: Image bounds or MIME type are invalid.' }] });
    }
    if (live !== owner) throw new Error('Embedded CUA generation changed after dispatch; effect may have occurred.');
    return pluginManager.redactResult(result);
  } finally {
    owner.users--;
    if (!owner.users) for (const resolve of owner.drain.splice(0)) resolve();
  }
}

export async function readEmbeddedCuaPermissions(): Promise<MacOSDesktopAccessStatus | null> {
  if (process.platform !== 'darwin') return null;
  const owner = live;
  let status: MacOSDesktopAccessStatus;
  if (!owner) status = unavailableStatus(error ?? 'Bundled CUA Driver is not ready.');
  else try {
    const tool = owner.tools.find(candidate => candidate.name === 'check_permissions');
    if (!tool) throw new Error('Driver does not declare check_permissions.');
    const result = await invokeEmbeddedCua('check_permissions', { prompt: false },
      { schemaHash: externalSchemaHash(tool), generation: owner.generation });
    const data = result.structuredContent as Record<string, unknown> | undefined;
    const source = data && typeof data === 'object' && 'source' in data ? data.source : null;
    const attribution = source && typeof source === 'object' && 'attribution' in source ? source.attribution : null;
    const host = source && typeof source === 'object' && 'host_bundle_id' in source ? source.host_bundle_id : null;
    if (result.isError || attribution !== 'host' || host !== BUNDLE_ID ||
        typeof data?.screen_recording !== 'boolean' || typeof data?.accessibility !== 'boolean')
      throw new Error('Driver did not verify this host bundle as its TCC owner.');
    owner.verifiedHost = true;
    status = { screen: data.screen_recording ? 'granted' : 'missing', accessibility: data.accessibility ? 'granted' : 'missing',
      checkedAt: Date.now(), error: null };
  } catch (cause) { status = unavailableStatus(cause instanceof Error ? cause.message : String(cause)); }
  if (live === owner) { permissionStatus = status; changed(); }
  return status;
}
