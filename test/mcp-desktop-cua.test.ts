import { randomUUID } from 'node:crypto';
import { afterAll, afterEach, beforeAll, expect, it, vi } from 'vitest';
import type { Tool } from '@modelcontextprotocol/client';
import { defaultConfig, getConfig, initConfigPath, saveConfig } from '../src/main/config.js';
import { initDurableStore, flushDurable, resetDurableForTests } from '../src/main/durable.js';
import { initSessionStore, createSession, getSession, rebindSession, resetSessionStoreForTests } from '../src/main/session/store.js';
import { flushRecorder } from '../src/main/session/recorder.js';
import { observeRequestCorrelation } from '../src/main/session/correlation.js';
import { startMcpServer } from '../src/main/mcp/server.js';
import type { ToolContext } from '../src/main/mcp/kernel.js';
import { emptyEvidence, type CallContext } from '../src/main/mcp/call-context.js';
import { desktopCuaCatalog, invokeDesktopCua } from '../src/main/mcp/tools-desktop.js';
import * as nativeRuntime from '../src/main/cua/runtime.js';
import * as platform from '../src/main/platform.js';
import { makeTempDir, removeTempDir } from './helpers.js';

let directory: string;
const schema = { type: 'object' as const, properties: {
  pid: { type: 'integer' }, window_id: { type: 'integer' }, snapshot_id: { type: 'string' },
  session: { type: 'string' }, element_token: { type: 'string' }, x: { type: 'integer' },
  y: { type: 'integer' }, delivery_mode: { type: 'string' }, name: { type: 'string' },
  file_path: { type: 'string' }, include_accessibility_tree: { type: 'boolean' }
}, additionalProperties: false };
const declarations: Tool[] = ['get_window_state', 'click', 'clipboard_write', 'launch_app'].map(name =>
  ({ name, description: `native ${name}`, inputSchema: schema }));
const firstText = (result: { content: Array<{ type: string; text?: string }> }) =>
  result.content.filter(part => part.type === 'text').map(part => part.text).join('\n');

function caller(sessionId: string, conversationId: string): CallContext {
  return { startedAt: Date.now(), transportKey: null, agent: null,
    caller: { transportKey: null, requestId: null, sessionId, conversationId }, outcome: null, evidence: emptyEvidence() };
}

function nativeFixture() {
  vi.spyOn(platform, 'desktopAutomationSupported').mockReturnValue(true);
  vi.spyOn(nativeRuntime, 'embeddedCuaCatalog').mockReturnValue({ generation: 1, tools: declarations });
  const dispatched: Array<{ name: string; args: Record<string, unknown> }> = [];
  vi.spyOn(nativeRuntime, 'invokeEmbeddedCua').mockImplementation(async (name, args) => {
    dispatched.push({ name, args });
    if (name === 'get_window_state') return { content: [{ type: 'text', text: 'tree' }], structuredContent: {
      snapshot_id: 's0000002a', pid: args.pid, window_id: args.window_id,
      app_name: args.pid === 700 ? 'Google Chrome' : 'Notes'
    } };
    return { content: [{ type: 'text', text: 'clicked' }], structuredContent: { effect: 'confirmed' } };
  });
  return dispatched;
}

beforeAll(async () => {
  directory = await makeTempDir('wgpt-desktop-cua-');
  initConfigPath(directory); initDurableStore(directory); initSessionStore(directory);
  const config = defaultConfig();
  await saveConfig({ ...config, capabilities: { ...config.capabilities, screen: true, control: true, clipboardWrite: true } });
});
afterEach(() => vi.restoreAllMocks());
afterAll(async () => {
  vi.restoreAllMocks();
  await flushRecorder(); await flushDurable(); resetSessionStoreForTests(); resetDurableForTests(); await removeTempDir(directory);
});

it('keeps native schemas, binds exact chat sessions and refuses cross-chat, browser, foreground and paths', async () => {
  const dispatched = nativeFixture();
  expect(desktopCuaCatalog().find(tool => tool.name === 'click')?.inputSchema).toEqual(schema);
  const chatA = randomUUID(), chatB = randomUUID();
  const a = await createSession({ conversationId: chatA, title: 'Desktop A' });
  const b = await createSession({ conversationId: chatB, title: 'Desktop B' });
  const owner = caller(a.id, chatA), stranger = caller(b.id, chatB);
  const target = { pid: 500, window_id: 7 };
  expect((await invokeDesktopCua('get_window_state', target, owner)).isError).not.toBe(true);
  expect(dispatched[0]?.args.session).toMatch(/^wga-[a-f0-9]{24}$/);
  const action = { ...target, element_token: 's0000002a:14', snapshot_id: 's0000002a' };
  expect(firstText(await invokeDesktopCua('click', action, stranger))).toContain('CUA_SNAPSHOT_STALE');
  expect(firstText(await invokeDesktopCua('click', { ...action, session: 'forged' }, owner))).toContain('CUA_SESSION_OWNED');
  expect(firstText(await invokeDesktopCua('click', { ...action, delivery_mode: 'foreground' }, owner))).toContain('CUA_FOREGROUND_DENIED');
  expect(firstText(await invokeDesktopCua('click', { ...action, file_path: '/private/data' }, owner))).toContain('CUA_FILE_PATH_DENIED');
  expect((await invokeDesktopCua('click', action, owner)).isError).not.toBe(true);
  expect(dispatched[1]?.args.session).toBe(dispatched[0]?.args.session);
  expect(firstText(await invokeDesktopCua('click', action, owner))).toContain('CUA_SNAPSHOT_STALE');
  await invokeDesktopCua('get_window_state', { pid: 700, window_id: 8 }, owner);
  expect(firstText(await invokeDesktopCua('click', { pid: 700, window_id: 8, element_token: 's0000002a:14' }, owner))).toContain('CUA_PROTECTED_BROWSER');
  expect(firstText(await invokeDesktopCua('launch_app', { name: 'Google Chrome' }, owner))).toContain('CUA_PROTECTED_BROWSER');
  expect(dispatched).toHaveLength(3);
});

it('rejects stale A cells and snapshots after A→B→A reattachment', async () => {
  const dispatched = nativeFixture();
  const chatA = randomUUID(), chatB = randomUUID();
  const session = await createSession({ conversationId: chatA, title: 'Rebinding Desktop' });
  const stale = caller(session.id, chatA);
  await invokeDesktopCua('get_window_state', { pid: 500, window_id: 7 }, stale);
  const firstLabel = dispatched[0]?.args.session;
  expect(await rebindSession(session.id, chatA, chatB)).toBe(true);
  expect(await rebindSession(session.id, chatB, chatA)).toBe(true);
  const action = { pid: 500, window_id: 7, element_token: 's0000002a:14' };
  expect(firstText(await invokeDesktopCua('click', action, stale))).toContain('CUA_IDENTITY_REQUIRED');
  const fresh = caller(session.id, chatA);
  fresh.startedAt = (await getSession(session.id))!.retiredChatAt![chatA]! + 1;
  expect(firstText(await invokeDesktopCua('click', action, fresh))).toContain('CUA_SNAPSHOT_STALE');
  await invokeDesktopCua('get_window_state', { pid: 500, window_id: 7 }, fresh);
  expect(dispatched[1]?.args.session).not.toBe(firstLabel);
  expect((await invokeDesktopCua('click', action, fresh)).isError).not.toBe(true);
});

it('withholds in-flight screen observations after the capability is revoked', async () => {
  nativeFixture();
  const entered = Promise.withResolvers<void>(), release = Promise.withResolvers<void>();
  vi.mocked(nativeRuntime.invokeEmbeddedCua).mockImplementation(async () => {
    entered.resolve(); await release.promise;
    return { content: [{ type: 'text', text: 'sensitive pixels' }],
      structuredContent: { snapshot_id: 's0000002a', pid: 500, window_id: 7, app_name: 'Notes' } };
  });
  const chat = randomUUID(), session = await createSession({ conversationId: chat, title: 'Revoked Desktop' });
  const pending = invokeDesktopCua('get_window_state', { pid: 500, window_id: 7 }, caller(session.id, chat));
  await entered.promise;
  const config = getConfig();
  try {
    await saveConfig({ ...config, capabilities: { ...config.capabilities, screen: false } });
    release.resolve();
    const withheld = await pending;
    expect(firstText(withheld)).toContain('CUA_AUTHORITY_CHANGED');
    expect(JSON.stringify(withheld)).not.toContain('sensitive pixels');
  } finally { release.resolve(); await saveConfig(config); }
});

it('keeps Desktop exec/wait wrappers and returns the native envelope in exec', async () => {
  nativeFixture();
  vi.mocked(nativeRuntime.invokeEmbeddedCua).mockResolvedValue({
    content: [{ type: 'text', text: 'native tree' }, { type: 'image', mimeType: 'image/png', data: 'aW1hZ2U=' }],
    structuredContent: { snapshot_id: 's0000002a', pid: 500, window_id: 7, app_name: 'Notes' }
  });
  const config = getConfig();
  const ctx: ToolContext = { roots: [], caps: config.capabilities, readOnly: false };
  const endpoint = await startMcpServer(() => ctx);
  try {
    const rpc = async (method: string, params: object, requestId?: string) => {
      const response = await fetch(endpoint.urls.desktop, { method: 'POST', headers: {
        'content-type': 'application/json', accept: 'application/json, text/event-stream',
        ...(requestId ? { 'x-request-id': requestId + '/attempt' } : {})
      }, body: JSON.stringify({ jsonrpc: '2.0', id: randomUUID(), method, params }) });
      const raw = await response.text();
      return JSON.parse(raw.startsWith('{') ? raw : [...raw.matchAll(/^data: (.+)$/gm)].at(-1)![1]!) as { result: { tools?: Array<{ name: string }>; content: Array<{ type: string; text?: string }> } };
    };
    const listed = await rpc('tools/list', {});
    expect(listed.result.tools?.map(tool => tool.name).sort()).toEqual(['exec', 'tools_search', 'wait']);
    const search = await rpc('tools/call', { name: 'tools_search', arguments: { names: ['get_window_state'] } });
    const found = JSON.parse(firstText(search.result)) as { tools: Array<{ inputSchema: unknown; call: string }> };
    expect(found.tools[0]?.inputSchema).toEqual(schema);
    const chat = randomUUID(), requestId = 'wfr_' + randomUUID().replaceAll('-', '');
    const session = await createSession({ conversationId: chat, title: 'Desktop exec' });
    expect(observeRequestCorrelation({ requestId, conversationId: chat, sessionId: session.id,
      messageId: randomUUID(), tool: 'exec', observedAt: Date.now() })).toBe('stored');
    const executed = await rpc('tools/call', { name: 'exec', arguments: {
      code: 'const r=await tools.get_window_state({pid:500,window_id:7}); text(JSON.stringify(r));'
    } }, requestId);
    const result = JSON.parse(firstText(executed.result)) as { content: Array<{ type: string; data?: string }>; structuredContent: { snapshot_id: string } };
    expect(result.structuredContent.snapshot_id).toBe('s0000002a');
    expect(result.content[1]).toMatchObject({ type: 'image', data: 'aW1hZ2U=' });
  } finally { await endpoint.stop(); }
});
