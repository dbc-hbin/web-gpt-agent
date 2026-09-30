/**
 * The Core external-tool gateway, exercised against real local MCP servers.
 *
 * The two properties this file exists to defend cannot be seen from a mock: that two servers
 * exporting the **same raw tool name** are still reachable unambiguously by installation id, and
 * that a caller working from a superseded schema is refused *before* anything reaches a server.
 * Both are therefore driven here through the real manager, real stdio transports and real
 * fixture servers, with only the browser side of the runtime stubbed.
 *
 * The app-owned native CUA catalog shares this gateway without creating a plugin installation.
 */

import { randomUUID } from 'node:crypto';
import { promises as fs } from 'node:fs';
import path from 'node:path';
import { afterAll, afterEach, beforeAll, expect, it, vi } from 'vitest';
import sharp from 'sharp';
import type { Tool } from '@modelcontextprotocol/client';
import { codeModeCall, codeModeResult } from './code-mode-helpers.js';

const secrets = vi.hoisted(() => new Map<string, string>());
vi.mock('../src/main/secrets.js', () => ({
  getSecret: vi.fn(async (key: string) => secrets.get(key) ?? null),
  setSecret: vi.fn(async (key: string, value: string) => { secrets.set(key, value); }),
  clearSecret: vi.fn(async (key: string) => { secrets.delete(key); })
}));


import { initConfigPath, defaultConfig, getConfig, saveConfig } from '../src/main/config.js';
import { initDurableStore, resetDurableForTests } from '../src/main/durable.js';
import { createSession, initSessionStore, resetSessionStoreForTests } from '../src/main/session/store.js';
import { closeCorrelationStore, observeRequestCorrelation } from '../src/main/session/correlation.js';
import { flushRecorder } from '../src/main/session/recorder.js';
import { createRegistrar, setManagedToolGate, type ToolResult } from '../src/main/mcp/kernel.js';
import { withInboundRequestId } from '../src/main/mcp/inbound.js';
import { startMcpServer, type McpEndpoint } from '../src/main/mcp/server.js';
import type { ToolContext } from '../src/main/mcp/tools.js';
import { pluginManager } from '../src/main/plugins/manager.js';
import { ExternalNotDispatched } from '../src/main/plugins/manager.js';
import * as nativeRuntime from '../src/main/cua/runtime.js';
import * as platform from '../src/main/platform.js';
import { CUA_SERVER_ID, CUA_READ_ONLY_TOOLS, projectCuaCatalog } from '../src/main/cua/catalog.js';
import * as pluginInstaller from '../src/main/plugins/installer.js';
import {
  EXTERNAL_TOOL_NAMES,
  externalCallOutcome,
  registerExternalTools,
  isReadOnlyExternalCall
} from '../src/main/mcp/tools-external.js';
import {
  acquireGuiLease,
  assertCuaSnapshot,
  consumeCuaObservation,
  guiLeaseHolder,
  holdGuiAction,
  noteCuaObservation,
  noteCuaTransportGeneration,
  onGuiLeaseReleased,
  releaseGuiLease,
  resetCuaStateForTests,
  setManagedCallerResolver,
  CuaBusyError,
  type ManagedWorkerIdentity
} from '../src/main/work/cua.js';
import { makeTempDir, removeTempDir, faultGate } from './helpers.js';

/**
 * One deterministic stdio MCP server. `identity` is echoed in every result, so a test can prove
 * *which* server answered rather than only that something did.
 */
function fixtureServer(identity: string, tools: unknown[], logPath?: string): string {
  return `const readline=require('node:readline');
const identity=${JSON.stringify(identity)};
const tools=${JSON.stringify(tools)};
readline.createInterface({input:process.stdin}).on('line',line=>{
  const m=JSON.parse(line);
  if(m.id===undefined)return;
  let result;
  if(m.method==='initialize')result={protocolVersion:'2025-11-25',capabilities:{tools:{}},serverInfo:{name:identity,version:'1'}};
  else if(m.method==='tools/list')result={tools};
  else if(m.method==='tools/call'){
    ${logPath ? `require('node:fs').appendFileSync(${JSON.stringify(logPath)}, m.params.name+'\\n');` : ''}
    const tool=tools.find(t=>t.name===m.params.name);
    if(!tool)result={isError:true,content:[{type:'text',text:'unknown tool'}]};
    else result={content:[{type:'text',text:identity+':'+m.params.name}],structuredContent:{server:identity,tool:m.params.name,args:m.params.arguments}};
  } else result={};
  process.stdout.write(JSON.stringify({jsonrpc:'2.0',id:m.id,result})+'\\n');
});`;
}

const ECHO_SCHEMA = {
  name: 'inspect',
  description: 'Inspect a fixture value',
  inputSchema: { type: 'object', properties: { value: { $ref: '#/$defs/value' } }, $defs: { value: { type: 'string', minLength: 1 } }, required: ['value'], additionalProperties: false },
  outputSchema: { type: 'object', properties: { server: { type: 'string' } }, required: ['server'] },
  annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false }
};

/**
 * The same raw tool name with a different declaration.
 *
 * Used by the queued-replacement race: the caller read the declaration above, and the server it is
 * about to reach now declares this one.
 */
const REVISED_SCHEMA = {
  name: 'inspect',
  description: 'Inspect a revised fixture value',
  inputSchema: { type: 'object', properties: { value: { type: 'string', minLength: 1 }, mode: { type: 'string' } }, required: ['value', 'mode'], additionalProperties: false }
};

/**
 * Models a host that ships the native driver (macOS/Windows). The gateway gates on both the
 * platform verdict and the platform capability projection, which masks native clipboard on Linux.
 */
function supportedDesktopHost(): void {
  vi.spyOn(platform, 'desktopAutomationSupported').mockReturnValue(true);
  vi.spyOn(platform, 'capabilitiesForPlatform').mockImplementation(capabilities => capabilities);
}

/**
 * The first text block of a result.
 *
 * Throws rather than asserting a shape: a result whose first block is not text is a real defect
 * in the case that produced it, and `as { text: string }` would have hidden it behind
 * `undefined` and made a later `toContain` fail for the wrong reason.
 */
function firstText(result: ToolResult): string {
  const block = result.content[0];
  if (!block || block.type !== 'text') throw new Error(`expected a text result, got ${JSON.stringify(block)}`);
  return block.text;
}

/** A complete managed identity, so the runtime's own shape is what the gateway sees. */
function managedIdentity(overrides: Partial<ManagedWorkerIdentity> & { workId: string }): ManagedWorkerIdentity {
  return {
    agentId: randomUUID(),
    generation: 1,
    role: 'prime',
    sessionId: randomUUID(),
    worktreePath: path.join(dir, 'worktree'),
    integrationPath: path.join(dir, 'integration'),
    integrationBranch: `wgpt/${overrides.workId}/main`,
    ...overrides
  };
}

let dir = '';
let first = '';
let second = '';
let callLog = '';

/** Drives one tool through the real registrar → dispatch path, exactly as the Core server does. */
function coreInvoker(): {
  call: (name: string, args: unknown, requestId?: string | null) => Promise<ToolResult>;
  registered: string[];
} {
  const handlers = new Map<string, (args: never, context?: { sessionId?: string | null }) => Promise<ToolResult>>();
  const registrar = createRegistrar({
    registerTool: (name: string, _config: unknown, callback: (args: never, context?: { sessionId?: string | null }) => Promise<ToolResult>) => {
      handlers.set(name, callback);
    }
  } as never, { roots: [{ name: 'fixture', path: dir }], caps: defaultConfig().capabilities, readOnly: false }, 'core');
  registerExternalTools(registrar);
  return {
    registered: registrar.registered(),
    call: async (name, args, requestId = null) => {
      const handler = handlers.get(name);
      if (!handler) throw new Error(`no handler registered for ${name}`);
      return withInboundRequestId(requestId, () => handler(args as never));
    }
  };
}

/**
 * Installs the two same-name fixtures once for the whole file.
 *
 * Every case here needs both of them, and installing per case would leave earlier
 * installations connected (a fresh install never adopts another's record), so the ids are
 * shared. The point of the fixture pair is that they declare the *same* raw name; that is a
 * property of the pair, not of one case.
 */
let fixtureIds: { firstId: string; secondId: string } | null = null;
async function installFixtures(): Promise<{ firstId: string; secondId: string }> {
  if (fixtureIds) {
    const rows = pluginManager.snapshot().plugins;
    expect(rows.find(row => row.id === fixtureIds!.firstId)?.status).toBe('ready');
    return fixtureIds;
  }
  const firstRow = (await pluginManager.install({ name: 'Fixture One', source: { kind: 'command', command: process.execPath, args: [first] } })).plugins.find(row => row.name === 'Fixture One')!;
  const secondRow = (await pluginManager.install({ name: 'Fixture Two', source: { kind: 'command', command: process.execPath, args: [second] } })).plugins.find(row => row.name === 'Fixture Two')!;
  fixtureIds = { firstId: firstRow.id, secondId: secondRow.id };
  await vi.waitFor(() => {
    const rows = pluginManager.snapshot().plugins.filter(row => row.id === firstRow.id || row.id === secondRow.id);
    expect(rows).toHaveLength(2);
    expect(rows.every(row => row.status === 'ready')).toBe(true);
  }, { timeout: 20_000 });
  return fixtureIds;
}

beforeAll(async () => {
  dir = await makeTempDir('wgpt-gateway-');
  initConfigPath(dir);
  initDurableStore(dir);
  initSessionStore(dir);
  const config = defaultConfig();
  await saveConfig({ ...config, multiAgent: { ...config.multiAgent, enabled: false, allowUnattributedCalls: false } });
  first = path.join(dir, 'first.cjs');
  second = path.join(dir, 'second.cjs');
  callLog = path.join(dir, 'calls.log');
  await fs.writeFile(first, fixtureServer('one', [ECHO_SCHEMA], callLog));
  await fs.writeFile(second, fixtureServer('two', [ECHO_SCHEMA], callLog));
  await fs.writeFile(callLog, '');
  await pluginManager.initialize(dir);
});

afterEach(async () => {
  vi.restoreAllMocks();
  setManagedToolGate(null);
  setManagedCallerResolver(null);
  resetCuaStateForTests();
  // A leftover connection from a previous case would make "was it dispatched" meaningless, and a
  // disabled installation from an earlier case must not decide a later one.
  for (const row of pluginManager.snapshot().plugins) {
    if (!row.enabled) await pluginManager.setEnabled(row.id, true);
    else await pluginManager.restart(row.id);
  }
  await fs.writeFile(callLog, '');
});

it('keeps discovery available but refuses external dispatch in read-only mode', async () => {
  const { firstId } = await installFixtures();
  const { call } = coreInvoker();
  const config = getConfig();
  try {
    await saveConfig({ ...config, readOnly: true });
    const discovery = await call('mcp_tools', { server_id: firstId, tool: 'inspect' });
    expect(discovery.isError).not.toBe(true);
    const schema = JSON.parse(firstText(discovery)) as { schema_hash: string };
    const result = await call('mcp_call', { server_id: firstId, tool: 'inspect', arguments: { value: 'read-only' }, schema_hash: schema.schema_hash });
    expect(result.isError).toBe(true);
    expect(await fs.readFile(callLog, 'utf8')).toBe('');
  } finally {
    await saveConfig(config);
  }
});

afterAll(async () => {
  await pluginManager.close();
  await flushRecorder();
  resetSessionStoreForTests();
  resetDurableForTests();
  // The request-ownership ledger is a process-wide SQLite handle under this directory; Windows
  // refuses to delete a file a live connection still holds.
  closeCorrelationStore();
  if (dir) await removeTempDir(dir);
});

it('reaches two servers that declare the same raw tool name, unambiguously by installation', async () => {
  const { firstId, secondId } = await installFixtures();
  const { call } = coreInvoker();

  const listed = await call('mcp_tools', {});
  const catalog = JSON.parse(firstText(listed)) as { installations: Array<{ server_id: string; name: string }> };
  expect(catalog.installations.map(entry => entry.server_id).sort()).toEqual([firstId, secondId, 'cua-driver'].sort());
  expect(catalog.installations.map(entry => entry.name).sort()).toEqual(['App-owned CUA Driver', 'Fixture One', 'Fixture Two']);

  // The same name is declared by both, and neither is suppressed by the other's claim.
  for (const id of [firstId, secondId]) {
    const tools = JSON.parse(firstText(await call('mcp_tools', { server_id: id }))) as { tools: Array<{ name: string }>; total: number };
    expect(tools.tools.map(tool => tool.name)).toEqual(['inspect']);
    expect(tools.total).toBe(1);
  }

  const exact = JSON.parse(firstText(await call('mcp_tools', { server_id: secondId, tool: 'inspect' }))) as { schema_hash: string; tool: { inputSchema: unknown } };
  // `$ref` bodies and the output schema survive into the published declaration.
  expect(JSON.stringify(exact.tool.inputSchema)).toContain('$defs');

  // Each call reaches the server whose installation id was named, and only that one.
  const reached = await call('mcp_call', { server_id: secondId, tool: 'inspect', arguments: { value: 'x' }, schema_hash: exact.schema_hash });
  expect(reached.isError).not.toBe(true);
  expect(reached.structuredContent).toMatchObject({ server: 'two', tool: 'inspect', args: { value: 'x' } });

  const other = await call('mcp_call', { server_id: firstId, tool: 'inspect', arguments: { value: 'x' }, schema_hash: exact.schema_hash });
  expect(other.structuredContent).toMatchObject({ server: 'one', tool: 'inspect' });
  // Exactly one dispatch per call: no ambiguity, no fan-out, no retry.
  expect(await fs.readFile(callLog, 'utf8')).toBe('inspect\ninspect\n');
});

it('refuses a stale schema hash, a disabled installation and an undeclared tool before dispatch', async () => {
  const { firstId, secondId } = await installFixtures();
  const { call } = coreInvoker();
  const exact = JSON.parse(firstText(await call('mcp_tools', { server_id: firstId, tool: 'inspect' }))) as { schema_hash: string };

  const stale = await call('mcp_call', { server_id: firstId, tool: 'inspect', arguments: { value: 'x' }, schema_hash: 'not-the-current-hash' });
  expect(stale.isError).toBe(true);
  expect(firstText(stale)).toContain('MCP_SCHEMA_CHANGED');

  const undeclared = await call('mcp_call', { server_id: firstId, tool: 'other', arguments: {}, schema_hash: exact.schema_hash });
  expect(undeclared.isError).toBe(true);
  expect(firstText(undeclared)).toContain('MCP_UNKNOWN_TOOL');

  const unknownServer = await call('mcp_call', { server_id: randomUUID(), tool: 'inspect', arguments: {}, schema_hash: exact.schema_hash });
  expect(firstText(unknownServer)).toContain('MCP_UNKNOWN_SERVER');

  // Invalid arguments are refused against the published schema, before anything is sent.
  const invalid = await call('mcp_call', { server_id: firstId, tool: 'inspect', arguments: { value: '' }, schema_hash: exact.schema_hash });
  expect(invalid.isError).toBe(true);
  expect(firstText(invalid)).toContain('MCP_INVALID_ARGUMENTS');
  const extra = await call('mcp_call', { server_id: firstId, tool: 'inspect', arguments: { value: 'ok', unexpected: 1 }, schema_hash: exact.schema_hash });
  expect(firstText(extra)).toContain('MCP_INVALID_ARGUMENTS');
  expect(await fs.readFile(callLog, 'utf8')).toBe('');

  await pluginManager.setEnabled(secondId, false);
  const disabled = await call('mcp_call', { server_id: secondId, tool: 'inspect', arguments: { value: 'x' }, schema_hash: exact.schema_hash });
  expect(firstText(disabled)).toContain('MCP_SERVER_DISABLED');
  expect(await fs.readFile(callLog, 'utf8')).toBe('');
});

it('never dispatches a per-tool disabled Core call even with a still-valid schema hash', async () => {
  const { firstId } = await installFixtures();
  const { call } = coreInvoker();
  // The caller read the declaration while the tool was on, so its hash stays valid across the
  // switch — the refusal must come from policy, not from a stale hash.
  const exact = JSON.parse(firstText(await call('mcp_tools', { server_id: firstId, tool: 'inspect' }))) as { schema_hash: string };

  await pluginManager.setToolEnabled(firstId, 'inspect', false);
  try {
    const catalog = JSON.parse(firstText(await call('mcp_tools', { server_id: firstId }))) as { tools: Array<{ name: string }>; total: number };
    expect(catalog.tools).toEqual([]);
    expect(catalog.total).toBe(0);

    const listing = JSON.parse(firstText(await call('mcp_tools', {}))) as { installations: Array<{ server_id: string; tool_count: number; disabled_tool_count: number }> };
    const entry = listing.installations.find(installation => installation.server_id === firstId);
    expect(entry?.tool_count).toBe(0);
    expect(entry?.disabled_tool_count).toBe(1);

    // Declared but switched off is not "never declared": the refusal names the switch.
    const discovery = await call('mcp_tools', { server_id: firstId, tool: 'inspect' });
    expect(discovery.isError).toBe(true);
    expect(firstText(discovery)).toContain('MCP_TOOL_DISABLED');

    const refused = await call('mcp_call', { server_id: firstId, tool: 'inspect', arguments: { value: 'x' }, schema_hash: exact.schema_hash });
    expect(refused.isError).toBe(true);
    expect(firstText(refused)).toContain('MCP_TOOL_DISABLED');
    expect(await fs.readFile(callLog, 'utf8')).toBe('');
  } finally {
    await pluginManager.setToolEnabled(firstId, 'inspect', true);
  }

  // The hash was valid all along: the same cached value dispatches once the tool is on again.
  const admitted = await call('mcp_call', { server_id: firstId, tool: 'inspect', arguments: { value: 'x' }, schema_hash: exact.schema_hash });
  expect(admitted.isError).not.toBe(true);
  expect(await fs.readFile(callLog, 'utf8')).toBe('inspect\n');
});

it('refuses a call whose declaration was replaced while it waited in the installation queue', async () => {
  const { firstId } = await installFixtures();
  const { call } = coreInvoker();
  const exact = JSON.parse(firstText(await call('mcp_tools', { server_id: firstId, tool: 'inspect' }))) as { schema_hash: string };

  // The replacement declares the same raw name with a different schema. It is staged behind a
  // gate, so the caller's `mcp_call` is admitted against the old declaration and is still waiting
  // in the installation's queue when the new server publishes.
  const original = await fs.readFile(first, 'utf8');
  await fs.writeFile(first, fixtureServer('one', [REVISED_SCHEMA], callLog));
  const gate = faultGate();
  const spy = vi.spyOn(pluginInstaller, 'installSource').mockImplementationOnce(async () => {
    await gate.hold();
    return { command: process.execPath, args: [first], version: 'fixture', license: 'MIT' };
  });
  // Admission runs before dispatch, so observing it proves the call was admitted under the old
  // declaration — the exact window this case exists for.
  const admission = vi.spyOn(pluginManager, 'validateExternalArguments');
  try {
    const updating = pluginManager.update(firstId);
    await gate.entered;
    // While the replacement is in flight the previous catalog is still retained and ready, so
    // this is exactly the hash the caller read — and it still matches at admission.
    const during = JSON.parse(firstText(await call('mcp_tools', { server_id: firstId, tool: 'inspect' }))) as { schema_hash: string };
    expect(during.schema_hash).toBe(exact.schema_hash);
    const queued = call('mcp_call', { server_id: firstId, tool: 'inspect', arguments: { value: 'x' }, schema_hash: exact.schema_hash });
    await vi.waitFor(() => expect(admission).toHaveBeenCalled());

    gate.release();
    await updating;
    const refused = await queued;
    // Arguments shaped for the replaced declaration never reach the new server.
    expect(refused.isError).toBe(true);
    expect(firstText(refused)).toContain('MCP_SCHEMA_CHANGED');
    expect(await fs.readFile(callLog, 'utf8')).toBe('');

    // The new declaration is genuinely callable once the caller re-reads it.
    const revised = JSON.parse(firstText(await call('mcp_tools', { server_id: firstId, tool: 'inspect' }))) as { schema_hash: string };
    expect(revised.schema_hash).not.toBe(exact.schema_hash);
    const reachedNew = await call('mcp_call', { server_id: firstId, tool: 'inspect', arguments: { value: 'x', mode: 'revised' }, schema_hash: revised.schema_hash });
    expect(reachedNew.isError).not.toBe(true);
    expect(await fs.readFile(callLog, 'utf8')).toBe('inspect\n');
  } finally {
    gate.release();
    admission.mockRestore();
    spy.mockRestore();
    await fs.writeFile(first, original);
    await pluginManager.restart(firstId);
    await vi.waitFor(() => expect(pluginManager.snapshot().plugins.find(row => row.id === firstId)?.status).toBe('ready'), { timeout: 20_000 });
    await fs.writeFile(callLog, '');
  }
});


it('paginates one installation catalog with cursors scoped to the catalog revision', async () => {
  const { firstId } = await installFixtures();
  const { call } = coreInvoker();
  const page = JSON.parse(firstText(await call('mcp_tools', { server_id: firstId, limit: 1 }))) as { next_cursor: string | null; revision: string };
  expect(page.next_cursor).toBeNull();

  const bad = await call('mcp_tools', { server_id: firstId, cursor: Buffer.from(JSON.stringify({ v: 1, revision: 'other', server_id: firstId, offset: 1 })).toString('base64url') });
  expect(firstText(bad)).toContain('MCP_CURSOR_INVALID');
  const mangled = await call('mcp_tools', { server_id: firstId, cursor: 'not-a-cursor' });
  expect(firstText(mangled)).toContain('MCP_CURSOR_INVALID');
});

it('preserves a real image through the gateway unchanged', async () => {
  const png = await sharp({ create: { width: 3, height: 2, channels: 4, background: { r: 1, g: 2, b: 3, alpha: 1 } } }).png().toBuffer();
  const base64 = png.toString('base64');
  const imageEntry = path.join(dir, 'image.cjs');
  await fs.writeFile(imageEntry, `const readline=require('node:readline');
const tools=[{name:'snap',description:'snap',inputSchema:{type:'object',properties:{},additionalProperties:false}}];
readline.createInterface({input:process.stdin}).on('line',line=>{const m=JSON.parse(line);if(m.id===undefined)return;let result;
if(m.method==='initialize')result={protocolVersion:'2025-11-25',capabilities:{tools:{}},serverInfo:{name:'img',version:'1'}};
else if(m.method==='tools/list')result={tools};
else if(m.method==='tools/call')result={content:[{type:'text',text:'shot'},{type:'image',mimeType:'image/png',data:${JSON.stringify(base64)}}],structuredContent:{ok:true}};
else result={};process.stdout.write(JSON.stringify({jsonrpc:'2.0',id:m.id,result})+'\\n');});`);
  const row = (await pluginManager.install({ name: 'Image Fixture', source: { kind: 'command', command: process.execPath, args: [imageEntry] } })).plugins.at(-1)!;
  await vi.waitFor(() => expect(pluginManager.snapshot().plugins.find(entry => entry.id === row.id)?.status).toBe('ready'), { timeout: 15_000 });
  const { call } = coreInvoker();
  const schema = JSON.parse(firstText(await call('mcp_tools', { server_id: row.id, tool: 'snap' }))) as { schema_hash: string };
  const result = await call('mcp_call', { server_id: row.id, tool: 'snap', arguments: {}, schema_hash: schema.schema_hash });
  const image = result.content.find(part => part.type === 'image') as { data: string; mimeType: string } | undefined;
  expect(image?.mimeType).toBe('image/png');
  const decoded = Buffer.from(image!.data, 'base64');
  expect(decoded.equals(png)).toBe(true);
  const meta = await sharp(decoded).metadata();
  expect([meta.width, meta.height]).toEqual([3, 2]);
  await pluginManager.uninstall(row.id);
});


it('holds one host-wide GUI lease per work and refuses a second work truthfully', async () => {
  const prime = managedIdentity({ workId: randomUUID() });
  const other = managedIdentity({ workId: randomUUID() });
  const released: string[] = [];
  onGuiLeaseReleased(workId => released.push(workId));

  acquireGuiLease(prime.workId);
  expect(guiLeaseHolder()).toBe(prime.workId);
  // Re-acquiring by the same work is idempotent; a different work is refused with the holder.
  acquireGuiLease(prime.workId);
  expect(() => acquireGuiLease(other.workId)).toThrow(CuaBusyError);
  try { acquireGuiLease(other.workId); } catch (error) { expect((error as CuaBusyError).holderWorkId).toBe(prime.workId); }

  // Release waits for in-flight actions rather than freeing the desktop underneath them.
  const settle = holdGuiAction(prime.workId);
  let done = false;
  const releasing = releaseGuiLease(prime.workId).then(() => { done = true; });
  await Promise.resolve();
  expect(done).toBe(false);
  expect(() => holdGuiAction(prime.workId)).toThrow(CuaBusyError);
  settle();
  await releasing;
  expect(done).toBe(true);
  expect(guiLeaseHolder()).toBeNull();
  expect(released).toEqual([prime.workId]);
  // Idempotent, and a second release never frees someone else's lease.
  await releaseGuiLease(prime.workId);
  acquireGuiLease(other.workId);
  await releaseGuiLease(prime.workId);
  expect(guiLeaseHolder()).toBe(other.workId);
  await releaseGuiLease(other.workId);
});

it('requires a fresh observation for snapshot-bound actions and invalidates it on reconnect', async () => {
  const workId = randomUUID();
  const installation = randomUUID();
  const click = { pid: 12, element_token: 's1:4' };

  // No observation at all: the action is refused rather than resolved against whatever exists now.
  expect(assertCuaSnapshot(workId, installation, 1, click)).toContain('CUA_SNAPSHOT_REQUIRED');

  noteCuaObservation(workId, installation, 1, 'get_window_state', {
    content: [], structuredContent: { snapshot_id: 's1', pid: 12, window_id: 7 }
  } as ToolResult);
  expect(assertCuaSnapshot(workId, installation, 1, click)).toBeNull();
  // A token from a different snapshot is never translated to the observed one.
  expect(assertCuaSnapshot(workId, installation, 1, { pid: 12, element_token: 's2:4' })).toContain('CUA_SNAPSHOT_MISMATCH');
  expect(assertCuaSnapshot(workId, installation, 1, { pid: 12, element_token: 's1:4', window_id: 99 })).toContain('CUA_SNAPSHOT_MISMATCH');
  // Desktop and window scopes do not substitute for one another.
  expect(assertCuaSnapshot(workId, installation, 1, { scope: 'desktop', element_token: 's1:4' })).toContain('CUA_SNAPSHOT_MISMATCH');

  // A consumed observation cannot authorize the next input.
  consumeCuaObservation(workId, installation);
  expect(assertCuaSnapshot(workId, installation, 1, click)).toContain('CUA_SNAPSHOT_STALE');

  noteCuaObservation(workId, installation, 1, 'get_window_state', {
    content: [], structuredContent: { snapshot_id: 's1', pid: 12, window_id: 7 }
  } as ToolResult);
  expect(assertCuaSnapshot(workId, installation, 1, click)).toBeNull();
  // A reconnect mints new transport state: the prior observation is unusable.
  noteCuaTransportGeneration(installation, 2);
  expect(assertCuaSnapshot(workId, installation, 1, click)).toContain('CUA_SNAPSHOT_REQUIRED');
});

it('routes the host-native Core server without an installed plugin and protects managed callers', async () => {
  supportedDesktopHost();
  const config = getConfig();
  await saveConfig({ ...config, capabilities: { ...config.capabilities, screen: true, control: true } });
  const tools = projectCuaCatalog([
    { name: 'list_windows', inputSchema: { type: 'object', properties: {}, additionalProperties: false } },
    { name: 'get_window_state', inputSchema: { type: 'object', properties: { pid: { type: 'integer' }, window_id: { type: 'integer' }, session: { type: 'string' } }, additionalProperties: false } },
    { name: 'click', inputSchema: { type: 'object', properties: { pid: { type: 'integer' }, window_id: { type: 'integer' }, snapshot_id: { type: 'string' }, session: { type: 'string' } }, additionalProperties: false } },
    { name: 'check_permissions', inputSchema: { type: 'object', properties: { prompt: { type: 'boolean' } }, additionalProperties: false } },
    { name: 'set_config', inputSchema: { type: 'object' } }
  ] as Tool[]);
  vi.spyOn(nativeRuntime, 'embeddedCuaCatalog').mockReturnValue({ generation: 4, tools });
  const invoke = vi.spyOn(nativeRuntime, 'invokeEmbeddedCua').mockImplementation(async (name, args) => ({
    content: [{ type: 'text', text: name }],
    structuredContent: name === 'get_window_state'
      ? { snapshot_id: 's12', pid: 42, window_id: 7, app_name: 'Notes' }
      : { args }
  }));
  const { call } = coreInvoker();
  const listing = JSON.parse(firstText(await call('mcp_tools', {}))) as { installations: Array<{ server_id: string }> };
  expect(listing.installations.filter(row => row.server_id === CUA_SERVER_ID)).toHaveLength(1);
  expect(pluginManager.snapshot().plugins.some(row => row.catalogId === CUA_SERVER_ID)).toBe(false);
  const permission = JSON.parse(firstText(await call('mcp_tools', { server_id: CUA_SERVER_ID, tool: 'check_permissions' }))) as { tool: { inputSchema: { properties: { prompt: { const: boolean } } } }; schema_hash: string };
  expect(permission.tool.inputSchema.properties.prompt.const).toBe(false);
  expect(firstText(await call('mcp_call', { server_id: CUA_SERVER_ID, tool: 'check_permissions', arguments: { prompt: true }, schema_hash: permission.schema_hash }))).toContain('MCP_INVALID_ARGUMENTS');
  expect(invoke).not.toHaveBeenCalled();
  expect(CUA_READ_ONLY_TOOLS).toContain('list_windows');
  expect(isReadOnlyExternalCall({ server_id: CUA_SERVER_ID, tool: 'list_windows', arguments: {}, schema_hash: 'x' })).toBe(true);
  expect(isReadOnlyExternalCall({ server_id: CUA_SERVER_ID, tool: 'click', arguments: {}, schema_hash: 'x' })).toBe(false);
  const windowSchema = JSON.parse(firstText(await call('mcp_tools', { server_id: CUA_SERVER_ID, tool: 'get_window_state' }))) as { schema_hash: string };
  const absent = await call('mcp_call', { server_id: CUA_SERVER_ID, tool: 'get_window_state', arguments: { pid: 42, window_id: 7 }, schema_hash: windowSchema.schema_hash });
  expect(firstText(absent)).toContain('WORK_SERVICE_UNAVAILABLE');
  const holder = managedIdentity({ workId: randomUUID() });
  setManagedCallerResolver(() => ({ ...holder, role: 'worker' }));
  expect(firstText(await call('mcp_call', { server_id: CUA_SERVER_ID, tool: 'get_window_state', arguments: { pid: 42, window_id: 7 }, schema_hash: windowSchema.schema_hash }))).toContain('CUA_PRIME_ONLY');
  setManagedCallerResolver(() => holder);
  const observed = await call('mcp_call', { server_id: CUA_SERVER_ID, tool: 'get_window_state', arguments: { pid: 42, window_id: 7 }, schema_hash: windowSchema.schema_hash });
  expect(observed.isError).not.toBe(true);
  expect(invoke.mock.calls[0]?.[1].session).toMatch(/^wga-[a-f0-9]{24}$/);
  const clickSchema = JSON.parse(firstText(await call('mcp_tools', { server_id: CUA_SERVER_ID, tool: 'click' }))) as { schema_hash: string };
  expect(firstText(await call('mcp_call', { server_id: CUA_SERVER_ID, tool: 'click', arguments: { pid: 42, window_id: 7, snapshot_id: 's12', session: 'forged' }, schema_hash: clickSchema.schema_hash }))).toContain('CUA_SESSION_OWNED');
  const challenger = managedIdentity({ workId: randomUUID() });
  setManagedCallerResolver(() => challenger);
  expect(firstText(await call('mcp_call', { server_id: CUA_SERVER_ID, tool: 'get_window_state', arguments: { pid: 42, window_id: 7 }, schema_hash: windowSchema.schema_hash }))).toContain('CUA_BUSY');
  expect(invoke).toHaveBeenCalledTimes(1);
  const entered = Promise.withResolvers<void>(), resume = Promise.withResolvers<void>();
  invoke.mockImplementation(async () => { entered.resolve(); await resume.promise; return { content: [{ type: 'text', text: 'private window tree' }] }; });
  setManagedCallerResolver(() => holder);
  const inFlight = call('mcp_call', { server_id: CUA_SERVER_ID, tool: 'get_window_state', arguments: { pid: 42, window_id: 7 }, schema_hash: windowSchema.schema_hash });
  await entered.promise;
  setManagedCallerResolver(() => ({ ...holder, role: 'worker' }));
  resume.resolve();
  const withheld = await inFlight;
  expect(firstText(withheld)).toContain('CUA_AUTHORITY_CHANGED');
  expect(JSON.stringify(withheld)).not.toContain('private window tree');
  await releaseGuiLease(holder.workId);
  await saveConfig(config);
});

it('filters native discovery, exact schemas, receipts and dispatch by each live capability', async () => {
  supportedDesktopHost();
  const tools = projectCuaCatalog(['list_windows', 'launch_app', 'clipboard_read', 'clipboard_write'].map(name =>
    ({ name, inputSchema: { type: 'object', properties: {}, additionalProperties: false } })) as Tool[]);
  vi.spyOn(nativeRuntime, 'embeddedCuaCatalog').mockReturnValue({ generation: 4, tools });
  const invoke = vi.spyOn(nativeRuntime, 'invokeEmbeddedCua').mockResolvedValue({ content: [{ type: 'text', text: 'private' }] });
  const { call } = coreInvoker();
  const config = getConfig();
  const holder = managedIdentity({ workId: randomUUID() });
  setManagedCallerResolver(() => holder);
  try {
    for (const [capability, name] of [
      ['screen', 'list_windows'], ['control', 'launch_app'],
      ['clipboardRead', 'clipboard_read'], ['clipboardWrite', 'clipboard_write']
    ] as const) {
      await saveConfig({ ...config, capabilities: { ...config.capabilities, screen: true, control: true,
        clipboardRead: true, clipboardWrite: true } });
      const schema = JSON.parse(firstText(await call('mcp_tools', { server_id: CUA_SERVER_ID, tool: name }))) as { schema_hash: string };
      await saveConfig({ ...getConfig(), capabilities: { ...getConfig().capabilities, [capability]: false } });
      const listing = JSON.parse(firstText(await call('mcp_tools', { server_id: CUA_SERVER_ID }))) as { tools: Array<{ name: string }> };
      expect(listing.tools.map(tool => tool.name), capability).not.toContain(name);
      expect(firstText(await call('mcp_tools', { server_id: CUA_SERVER_ID, tool: name }))).toContain('TOOL_DISABLED');
      expect(isReadOnlyExternalCall({ server_id: CUA_SERVER_ID, tool: name, schema_hash: schema.schema_hash })).toBe(false);
      const refused = await call('mcp_call', { server_id: CUA_SERVER_ID, tool: name, arguments: {}, schema_hash: schema.schema_hash });
      expect(firstText(refused), capability).toContain('TOOL_DISABLED');
      expect(externalCallOutcome(refused)).toBe('completed');
      expect(invoke).not.toHaveBeenCalled();
    }
    await saveConfig({ ...getConfig(), readOnly: true, capabilities: { ...getConfig().capabilities, screen: true } });
    const readOnly = await call('mcp_call', { server_id: CUA_SERVER_ID, tool: 'list_windows', arguments: {}, schema_hash: 'unneeded' });
    expect(firstText(readOnly)).toContain('TOOL_DISABLED');
    expect(invoke).not.toHaveBeenCalled();
  } finally { await saveConfig(config); await releaseGuiLease(holder.workId); }
});

it('refuses native dispatch after an awaited admission is revoked', async () => {
  supportedDesktopHost();
  vi.spyOn(nativeRuntime, 'embeddedCuaCatalog').mockReturnValue({ generation: 4, tools: projectCuaCatalog([
    { name: 'clipboard_write', inputSchema: { type: 'object', properties: {}, additionalProperties: false } }
  ] as Tool[]) });
  const beforeGuard = Promise.withResolvers<void>(), resume = Promise.withResolvers<void>();
  let dispatched = false;
  vi.spyOn(nativeRuntime, 'invokeEmbeddedCua').mockImplementation(async (_name, _args, _expectation, admitted) => {
    beforeGuard.resolve(); await resume.promise;
    if (!await admitted?.()) throw new ExternalNotDispatched('CUA_PERMISSION_OR_IDENTITY_CHANGED');
    dispatched = true;
    return { content: [{ type: 'text', text: 'effect happened' }] };
  });
  const config = getConfig(), holder = managedIdentity({ workId: randomUUID() });
  setManagedCallerResolver(() => holder);
  try {
    await saveConfig({ ...config, capabilities: { ...config.capabilities, clipboardWrite: true } });
    const { call } = coreInvoker();
    const schema = JSON.parse(firstText(await call('mcp_tools', { server_id: CUA_SERVER_ID, tool: 'clipboard_write' }))) as { schema_hash: string };
    const pending = call('mcp_call', { server_id: CUA_SERVER_ID, tool: 'clipboard_write', arguments: {}, schema_hash: schema.schema_hash });
    await beforeGuard.promise;
    await saveConfig({ ...getConfig(), capabilities: { ...getConfig().capabilities, clipboardWrite: false } });
    resume.resolve();
    const result = await pending;
    expect(firstText(result)).toContain('CUA_PERMISSION_OR_IDENTITY_CHANGED');
    expect(externalCallOutcome(result)).toBe('completed');
    expect(dispatched).toBe(false);
  } finally { resume.resolve(); await saveConfig(config); await releaseGuiLease(holder.workId); }
});

it('withholds native replies and driver errors after revocation, marking possible write effects uncertain', async () => {
  supportedDesktopHost();
  vi.spyOn(nativeRuntime, 'embeddedCuaCatalog').mockReturnValue({ generation: 4, tools: projectCuaCatalog([
    { name: 'list_windows', inputSchema: { type: 'object', properties: {}, additionalProperties: false } },
    { name: 'clipboard_write', inputSchema: { type: 'object', properties: {}, additionalProperties: false } }
  ] as Tool[]) });
  const invoke = vi.spyOn(nativeRuntime, 'invokeEmbeddedCua');
  const config = getConfig(), holder = managedIdentity({ workId: randomUUID() });
  setManagedCallerResolver(() => holder);
  const { call } = coreInvoker();
  try {
    for (const [name, capability] of [['list_windows', 'screen'], ['clipboard_write', 'clipboardWrite']] as const) {
      for (const fails of [false, true]) {
        await saveConfig({ ...getConfig(), capabilities: { ...getConfig().capabilities, [capability]: true } });
        const schema = JSON.parse(firstText(await call('mcp_tools', { server_id: CUA_SERVER_ID, tool: name }))) as { schema_hash: string };
        const entered = Promise.withResolvers<void>(), resume = Promise.withResolvers<void>();
        invoke.mockImplementationOnce(async () => {
          entered.resolve(); await resume.promise;
          if (fails) throw new Error('private driver diagnostic');
          return { content: [{ type: 'text', text: 'private native result' }] };
        });
        const pending = call('mcp_call', { server_id: CUA_SERVER_ID, tool: name, arguments: {}, schema_hash: schema.schema_hash });
        await entered.promise;
        await saveConfig({ ...getConfig(), capabilities: { ...getConfig().capabilities, [capability]: false } });
        resume.resolve();
        const result = await pending;
        expect(firstText(result)).toContain('CUA_AUTHORITY_CHANGED');
        expect(JSON.stringify(result)).not.toMatch(/private native result|private driver diagnostic/);
        expect(externalCallOutcome(result)).toBe(name === 'clipboard_write' ? 'outcome_unknown' : 'completed');
      }
    }
  } finally { await saveConfig(config); await releaseGuiLease(holder.workId); }
});

it('registers exactly the two gateway names on the Core registrar', async () => {
  const { call, registered } = coreInvoker();
  // Nothing but the gateway is added to Core, and no external tool is ever registered by name.
  expect(registered).toEqual([...EXTERNAL_TOOL_NAMES]);
  const listed = await call('mcp_tools', {});
  expect(listed.isError).not.toBe(true);
});

it('serves both gateway names and an unambiguous call over the real Core endpoint', async () => {
  const { firstId, secondId } = await installFixtures();
  const conversationId = randomUUID(), requestId = randomUUID();
  const session = await createSession({ conversationId });
  observeRequestCorrelation({ requestId, conversationId, sessionId: session.id, messageId: randomUUID(), tool: 'exec', observedAt: Date.now() });
  const ctx: ToolContext = {
    roots: [{ name: 'fixture', path: dir }],
    caps: { ...defaultConfig().capabilities, read: true, search: true },
    readOnly: false
  };
  const endpoint: McpEndpoint = await startMcpServer(() => ctx);
  let sequence = 0;
  const rpc = async (method: string, params: { name?: string; arguments?: unknown } = {}, surface: 'core' | 'plugins' = 'core'): Promise<Record<string, unknown>> => {
    const response = await fetch(endpoint.urls[surface], {
      method: 'POST',
      headers: { 'content-type': 'application/json', accept: 'application/json, text/event-stream', 'x-request-id': requestId },
      body: JSON.stringify({ jsonrpc: '2.0', id: ++sequence, method, params: method === 'tools/call' ? codeModeCall(params.name!, params.arguments ?? {}) : params })
    });
    const raw = await response.text();
    const reply = JSON.parse(raw.startsWith('{') ? raw : [...raw.matchAll(/^data:\s*(.+)$/gm)].at(-1)![1]!);
    return method === 'tools/call' ? { ...reply, result: codeModeResult(reply.result).result } : reply;
  };
  const resultOf = (reply: Record<string, unknown>): { text: string; payload: string; structured: Record<string, unknown> | undefined; isError: boolean } => {
    const result = reply.result as { content?: Array<{ text?: string }>; structuredContent?: Record<string, unknown>; isError?: boolean } | undefined;
    const parts = (result?.content ?? []).map(part => part.text ?? '');
    // The dispatcher appends its own app-authored blocks (an unattributed notice, worker inbox
    // text) after the handler's result. The handler's own JSON is the first block.
    return { text: parts.join('\n'), payload: parts[0] ?? '', structured: result?.structuredContent, isError: result?.isError === true };
  };
  try {
    const listed = await rpc('tools/list');
    const names = ((listed.result as { tools: Array<{ name: string }> }).tools).map(tool => tool.name);
    expect(names).not.toContain('mcp_tools');
    expect(names).not.toContain('mcp_call');
    expect(names).toContain('exec');
    expect(names).toContain('tools_search');
    // The external servers' own tool names are never advertised on Core.
    expect(names).not.toContain('inspect');

    const catalog = JSON.parse(resultOf(await rpc('tools/call', { name: 'mcp_tools', arguments: {} })).payload) as { installations: Array<{ server_id: string }> };
    expect(catalog.installations.map(entry => entry.server_id)).toEqual(expect.arrayContaining([firstId, secondId]));

    const schema = JSON.parse(resultOf(await rpc('tools/call', { name: 'mcp_tools', arguments: { server_id: secondId, tool: 'inspect' } })).payload) as { schema_hash: string };
    const reached = resultOf(await rpc('tools/call', {
      name: 'mcp_call',
      arguments: { server_id: secondId, tool: 'inspect', arguments: { value: 'over-http' }, schema_hash: schema.schema_hash }
    }));
    expect(reached.isError).toBe(false);
    // The external server's own structured result survives the envelope, including its identity.
    expect(reached.structured).toMatchObject({ server: 'two', tool: 'inspect', args: { value: 'over-http' } });

    // A stale hash over the same transport invokes nothing.
    const stale = resultOf(await rpc('tools/call', {
      name: 'mcp_call',
      arguments: { server_id: secondId, tool: 'inspect', arguments: { value: 'x' }, schema_hash: 'stale' }
    }));
    expect(stale.isError).toBe(true);
    expect(stale.text).toContain('MCP_SCHEMA_CHANGED');
    expect(await fs.readFile(callLog, 'utf8')).toBe('inspect\n');
    const rawFixture = path.join(dir, 'raw-envelope.cjs');
    await fs.writeFile(rawFixture, fixtureServer('raw', [{ ...ECHO_SCHEMA, name: 'inspect_raw' }], callLog));
    const installed = await pluginManager.install({ name: 'Raw Envelope Fixture', source: { kind: 'command', command: process.execPath, args: [rawFixture] } });
    const rawId = installed.plugins.find(entry => entry.name === 'Raw Envelope Fixture')!.id;
    const ready = Promise.withResolvers<void>();
    const off = pluginManager.onChanged(() => {
      if (pluginManager.tools().some(tool => tool.name === 'inspect_raw')) ready.resolve();
    });
    if (pluginManager.tools().some(tool => tool.name === 'inspect_raw')) ready.resolve();
    try {
      await ready.promise;
      const raw = resultOf(await rpc('tools/call', { name: 'inspect_raw',
        arguments: { arguments: { value: 'raw-envelope' }, operation_id: randomUUID() } }, 'plugins'));
      expect(raw.isError, raw.text).toBe(false);
      expect(raw.structured).toMatchObject({ server: 'raw', args: { value: 'raw-envelope' } });
      expect(raw.structured?.args).toEqual({ value: 'raw-envelope' });
      expect(await fs.readFile(callLog, 'utf8')).toBe('inspect\ninspect_raw\n');
    } finally { off(); await pluginManager.uninstall(rawId); }
  } finally {
    await endpoint.stop();
  }
});

// --------------------------------------------------------------------------- ambiguity

/**
 * A server that receives the call and then dies before answering.
 *
 * This is the case the whole `outcome_unknown` path exists for: the side effect may well have
 * happened, so the caller must be told the outcome is unknown rather than that it failed, and
 * nothing may be replayed on its behalf.
 */
it('reports an ambiguous disconnect as outcome_unknown and never replays the call', async () => {
  const dying = path.join(dir, 'dying.cjs');
  const dyingLog = path.join(dir, 'dying.log');
  await fs.writeFile(dying, `const readline=require('node:readline');
const fs=require('node:fs');
const tools=[{name:'mutate',description:'mutate',inputSchema:{type:'object',properties:{},additionalProperties:false}}];
readline.createInterface({input:process.stdin}).on('line',line=>{
  const m=JSON.parse(line);
  if(m.id===undefined)return;
  if(m.method==='initialize'){process.stdout.write(JSON.stringify({jsonrpc:'2.0',id:m.id,result:{protocolVersion:'2025-11-25',capabilities:{tools:{}},serverInfo:{name:'dying',version:'1'}}})+'\\n');return;}
  if(m.method==='tools/list'){process.stdout.write(JSON.stringify({jsonrpc:'2.0',id:m.id,result:{tools}})+'\\n');return;}
  if(m.method==='tools/call'){fs.appendFileSync(${JSON.stringify(dyingLog)}, 'mutate\\n');process.exit(9);}
});`);
  await fs.writeFile(dyingLog, '');
  const row = (await pluginManager.install({ name: 'Dying Fixture', source: { kind: 'command', command: process.execPath, args: [dying] } })).plugins.find(entry => entry.name === 'Dying Fixture')!;
  await vi.waitFor(() => expect(pluginManager.snapshot().plugins.find(entry => entry.id === row.id)?.status).toBe('ready'), { timeout: 15_000 });
  const { call } = coreInvoker();
  const schema = JSON.parse(firstText(await call('mcp_tools', { server_id: row.id, tool: 'mutate' }))) as { schema_hash: string };
  const args = { server_id: row.id, tool: 'mutate', arguments: {}, schema_hash: schema.schema_hash };

  const first = await call('mcp_call', args);
  expect(first.isError).toBe(true);
  // Ambiguous, not failed: the runtime records this as outcome_unknown and offers resolution.
  expect(externalCallOutcome(first)).toBe('outcome_unknown');
  expect(firstText(first)).toContain('MCP_CALL_FAILED');

  // The ambiguous failure retires the connection, so an immediate repeat is refused rather than
  // silently dispatching a second effect. The gateway has no retry of its own.
  const repeat = await call('mcp_call', args);
  expect(repeat.isError).toBe(true);
  expect(externalCallOutcome(repeat)).toBe('completed');
  expect(firstText(repeat)).toContain('MCP_SERVER_UNAVAILABLE');
  expect(await fs.readFile(dyingLog, 'utf8')).toBe('mutate\n');

  // A refusal is never ambiguous either: it was never dispatched.
  const refused = await call('mcp_call', { ...args, schema_hash: 'stale' });
  expect(externalCallOutcome(refused)).toBe('completed');
  await pluginManager.uninstall(row.id);
});

it('refuses a removed installation before any dispatch', async () => {
  const { firstId, secondId } = await installFixtures();
  const { call } = coreInvoker();
  const schema = JSON.parse(firstText(await call('mcp_tools', { server_id: secondId, tool: 'inspect' }))) as { schema_hash: string };
  await pluginManager.uninstall(secondId);
  fixtureIds = { firstId, secondId: '' };
  const removed = await call('mcp_call', { server_id: secondId, tool: 'inspect', arguments: { value: 'x' }, schema_hash: schema.schema_hash });
  expect(removed.isError).toBe(true);
  expect(firstText(removed)).toContain('MCP_UNKNOWN_SERVER');
  expect(await fs.readFile(callLog, 'utf8')).toBe('');
  // Restore the shared pair for later cases in this file.
  const restored = (await pluginManager.install({ name: 'Fixture Two', source: { kind: 'command', command: process.execPath, args: [second] } })).plugins.find(entry => entry.name === 'Fixture Two')!;
  fixtureIds = { firstId, secondId: restored.id };
  await vi.waitFor(() => expect(pluginManager.snapshot().plugins.find(entry => entry.id === restored.id)?.status).toBe('ready'), { timeout: 20_000 });
});

// --------------------------------------------------------------------------- GUI contention

