import { randomUUID } from 'node:crypto';
import { afterAll, afterEach, beforeAll, expect, it, vi } from 'vitest';
import type { Tool } from '@modelcontextprotocol/client';
import { defaultConfig, getConfig, initConfigPath, saveConfig } from '../src/main/config.js';
import { initDurableStore, flushDurable, resetDurableForTests } from '../src/main/durable.js';
import { initSessionStore, createSession, getSession, rebindSession, resetSessionStoreForTests } from '../src/main/session/store.js';
import { flushRecorder } from '../src/main/session/recorder.js';
import { closeCorrelationStore, observeRequestCorrelation } from '../src/main/session/correlation.js';
import { startMcpServer } from '../src/main/mcp/server.js';
import type { ToolContext } from '../src/main/mcp/kernel.js';
import { emptyEvidence, type CallContext } from '../src/main/mcp/call-context.js';
import { desktopCuaCatalog, invokeDesktopCua } from '../src/main/mcp/tools-desktop.js';
import { projectCuaCatalog } from '../src/main/cua/catalog.js';
import * as nativeRuntime from '../src/main/cua/runtime.js';
import * as platform from '../src/main/platform.js';
import { makeTempDir, removeTempDir } from './helpers.js';

let directory: string;
// A real 64×64 PNG keeps the tested screenshot coordinates inside the image.
const png = 'iVBORw0KGgoAAAANSUhEUgAAAEAAAABACAYAAACqaXHeAAAACXBIWXMAAAPoAAAD6AG1e1JrAAAAeklEQVR4nOXOIQEAAAwEIfqX/sWYOIEHFmdxFmdxFmdxFmdxFmdxFmdxFmdxFmdxFmdxFmdxFmdxFmdxFmdxFmdxFmdxFmdxFmdxFmdxFmdxFmdxFmdxFmdxFmdxFmdxFmdxFmdxFmdxFmdxFmdxFmdxFmdxFmdxFuc78OoAWHzw4mYi9U0AAAAASUVORK5CYII=';
// The reviewed 0.31 action contract: output indices/snapshot IDs are not action inputs.
const targetProperties = { pid: { type: 'integer' }, window_id: { type: 'integer' },
  session: { type: 'string' }, element_token: { type: 'string' }, delivery_mode: { type: 'string' } };
const pixelProperties = { x: { type: 'number' }, y: { type: 'number' } };
const cursorDeclaration: Tool = { name: 'get_agent_cursor_state', inputSchema: { type: 'object',
  properties: { session: { type: 'string' } }, required: ['session'], additionalProperties: false } };
const declarations: Tool[] = [
  cursorDeclaration,
  { name: 'get_window_state', inputSchema: { type: 'object', properties: { pid: { type: 'integer' },
    window_id: { type: 'integer' }, session: { type: 'string' }, include_accessibility_tree: { type: 'boolean' },
    include_screenshot: { type: 'boolean' } }, required: ['pid', 'window_id'], additionalProperties: false } },
  { name: 'click', inputSchema: { type: 'object', properties: { ...targetProperties, ...pixelProperties,
    capture_id: { type: 'string' } }, additionalProperties: false } },
  ...['double_click', 'right_click'].map(name => ({ name, inputSchema: { type: 'object' as const,
    properties: { ...targetProperties, ...pixelProperties }, required: ['pid'], additionalProperties: false } })),
  { name: 'type_text', inputSchema: { type: 'object', properties: { ...targetProperties, ...pixelProperties,
    text: { type: 'string' } }, required: ['text'], additionalProperties: false } },
  { name: 'press_key', inputSchema: { type: 'object', properties: { ...targetProperties, ...pixelProperties,
    key: { type: 'string' }, modifiers: { type: 'array', items: { type: 'string' } } }, required: ['key'], additionalProperties: false } },
  { name: 'hotkey', inputSchema: { type: 'object', properties: { ...targetProperties, ...pixelProperties,
    keys: { type: 'array', items: { type: 'string' }, minItems: 2 } }, required: ['keys'], additionalProperties: false } },
  { name: 'scroll', inputSchema: { type: 'object', properties: { ...targetProperties, ...pixelProperties,
    direction: { type: 'string' } }, required: ['direction'], additionalProperties: false } },
  { name: 'drag', inputSchema: { type: 'object', properties: { ...targetProperties,
    from_x: { type: 'number' }, from_y: { type: 'number' }, to_x: { type: 'number' }, to_y: { type: 'number' } },
    required: ['from_x', 'from_y', 'to_x', 'to_y'], additionalProperties: false } },
  { name: 'clipboard_write', inputSchema: { type: 'object', properties: { text: { type: 'string' } }, additionalProperties: false } },
  { name: 'launch_app', inputSchema: { type: 'object', properties: { name: { type: 'string' } }, additionalProperties: false } }
];
const firstText = (result: { content: Array<{ type: string; text?: string }> }) =>
  result.content.filter(part => part.type === 'text').map(part => part.text).join('\n');

function caller(sessionId: string, conversationId: string): CallContext {
  return { startedAt: Date.now(), transportKey: null, agent: null,
    caller: { transportKey: null, requestId: null, sessionId, conversationId }, outcome: null, evidence: emptyEvidence() };
}

function nativeFixture() {
  vi.spyOn(platform, 'desktopAutomationSupported').mockReturnValue(true);
  vi.spyOn(nativeRuntime, 'embeddedCuaCatalog').mockReturnValue({ generation: 1, tools: projectCuaCatalog(declarations) });
  const dispatched: Array<{ name: string; args: Record<string, unknown> }> = [];
  const cursors = new Map<string, { x: number; y: number }>();
  let nextSnapshot = 42;
  vi.spyOn(nativeRuntime, 'invokeEmbeddedCua').mockImplementation(async (name, args) => {
    dispatched.push({ name, args });
    if (name === 'get_agent_cursor_state') {
      const valid = nativeRuntime.validateEmbeddedCuaArguments(cursorDeclaration, args);
      if (!valid.ok || typeof args.session !== 'string') throw new Error('Driver requires a lifecycle session');
      return { content: [], structuredContent: { position: cursors.get(args.session) ?? null } };
    }
    if (name === 'get_window_state') {
      const snapshotId = 's' + (nextSnapshot++).toString(16).padStart(8, '0');
      return { content: [...(args.include_accessibility_tree === false ? [] : [{ type: 'text' as const, text: 'tree' }]),
        ...(args.include_screenshot === false ? [] : [{ type: 'image' as const, mimeType: 'image/png', data: png }])], structuredContent: {
      ...(args.include_accessibility_tree === false ? {} : { snapshot_id: snapshotId }),
      capture_id: 'c-' + snapshotId, pid: args.pid, window_id: args.window_id,
      app_name: args.pid === 700 ? 'Google Chrome' : 'Notes'
    } };
    }
    if (name === 'click' && typeof args.session === 'string') cursors.set(args.session, { x: 100, y: 200 });
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
afterEach(() => { vi.restoreAllMocks(); vi.useRealTimers(); });
afterAll(async () => {
  vi.restoreAllMocks();
  await flushRecorder(); await flushDurable(); resetSessionStoreForTests(); resetDurableForTests(); closeCorrelationStore(); await removeTempDir(directory);
});

it('binds exact chat sessions and refuses cross-chat, browser, foreground and paths', async () => {
  const dispatched = nativeFixture();
  const chatA = randomUUID(), chatB = randomUUID();
  const a = await createSession({ conversationId: chatA, title: 'Desktop A' });
  const b = await createSession({ conversationId: chatB, title: 'Desktop B' });
  const owner = caller(a.id, chatA), stranger = caller(b.id, chatB);
  const target = { pid: 500, window_id: 7 };
  expect((await invokeDesktopCua('get_window_state', target, owner)).isError).not.toBe(true);
  expect(dispatched[0]?.args.session).toMatch(/^wga-[a-f0-9]{24}$/);
  const action = { ...target, element_token: 's0000002a:14' };
  expect(firstText(await invokeDesktopCua('click', action, stranger))).toContain('CUA_SNAPSHOT_STALE');
  expect(firstText(await invokeDesktopCua('click', { ...action, session: 'forged' }, owner))).toContain('CUA_SESSION_OWNED');
  expect(firstText(await invokeDesktopCua('click', { ...action, delivery_mode: 'foreground' }, owner))).toContain('CUA_FOREGROUND_DENIED');
  expect(firstText(await invokeDesktopCua('click', { ...action, file_path: '/private/data' }, owner))).toContain('CUA_FILE_PATH_DENIED');
  expect((await invokeDesktopCua('click', action, owner)).isError).not.toBe(true);
  expect(dispatched[1]?.args.session).toBe(dispatched[0]?.args.session);
  expect(firstText(await invokeDesktopCua('click', action, owner))).toContain('CUA_SNAPSHOT_STALE');
  await invokeDesktopCua('get_window_state', { pid: 700, window_id: 8 }, owner);
  expect(firstText(await invokeDesktopCua('click', { pid: 700, window_id: 8, element_token: 's0000002b:14' }, owner))).toContain('CUA_PROTECTED_BROWSER');
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
  const observed = await invokeDesktopCua('get_window_state', { pid: 500, window_id: 7 }, fresh);
  expect(dispatched[1]?.args.session).not.toBe(firstLabel);
  expect((await invokeDesktopCua('click', { ...action, element_token: `${observed.structuredContent?.snapshot_id}:14` }, fresh)).isError).not.toBe(true);
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

it('admits a token-owned window without obsolete fields and rejects cross-window or cross-session tokens', async () => {
  const dispatched = nativeFixture();
  const chatA = randomUUID(), chatB = randomUUID();
  const a = await createSession({ conversationId: chatA, title: 'Token owner' });
  const b = await createSession({ conversationId: chatB, title: 'Other token owner' });
  const owner = caller(a.id, chatA), other = caller(b.id, chatB);
  await invokeDesktopCua('get_window_state', { pid: 500, window_id: 7 }, owner);
  await invokeDesktopCua('get_window_state', { pid: 500, window_id: 8 }, other);
  expect(firstText(await invokeDesktopCua('click', { pid: 500, window_id: 8, element_token: 's0000002a:14' }, other)))
    .toContain('CUA_SNAPSHOT_MISMATCH');
  expect(firstText(await invokeDesktopCua('click', { pid: 500, window_id: 8, element_token: 's0000002a:14' }, owner)))
    .toContain('CUA_SNAPSHOT_STALE');
  for (const removed of [{ snapshot_id: 's0000002a' }, { element_index: 14 }]) {
    expect(firstText(await invokeDesktopCua('click', { pid: 500, element_token: 's0000002a:14', ...removed }, owner)))
      .toContain('CUA_INVALID_ARGUMENTS');
  }
  const accepted = await invokeDesktopCua('click', { pid: 500, element_token: 's0000002a:14' }, owner);
  expect(accepted.structuredContent?.effect).toBe('confirmed');
  expect(dispatched.filter(call => call.name === 'click')).toHaveLength(1);
  expect(firstText(await invokeDesktopCua('click', { pid: 500, element_token: 's0000002a:14' }, owner)))
    .toContain('CUA_SNAPSHOT_STALE');
});

it('binds pixel click to a delivered capture and refuses missing, foreign, superseded and spent captures', async () => {
  const dispatched = nativeFixture();
  const chat = randomUUID(), session = await createSession({ conversationId: chat, title: 'Capture owner' });
  const owner = caller(session.id, chat), target = { pid: 500, window_id: 7 };
  await invokeDesktopCua('get_window_state', { ...target, include_accessibility_tree: false }, owner);
  const pixels = { ...target, x: 12.5, y: 24.5 };
  expect(firstText(await invokeDesktopCua('click', pixels, owner))).toContain('CUA_CAPTURE_REQUIRED');
  expect(firstText(await invokeDesktopCua('click', { ...pixels, capture_id: 'foreign' }, owner))).toContain('CUA_CAPTURE_MISMATCH');
  await invokeDesktopCua('get_window_state', target, owner);
  expect(firstText(await invokeDesktopCua('click', { ...pixels, capture_id: 'c-s0000002a' }, owner))).toContain('CUA_CAPTURE_MISMATCH');
  const action = { ...pixels, capture_id: 'c-s0000002b' };
  expect(firstText(await invokeDesktopCua('click', { ...action, window_id: 8 }, owner))).toContain('CUA_SNAPSHOT_STALE');
  expect((await invokeDesktopCua('click', action, owner)).structuredContent?.effect).toBe('confirmed');
  expect(firstText(await invokeDesktopCua('click', action, owner))).toContain('CUA_SNAPSHOT_STALE');
  expect(dispatched.filter(call => call.name === 'click')).toHaveLength(1);
});

it('admits a screenshot-only click without snapshot authority and binds it to its exact owner', async () => {
  const dispatched = nativeFixture();
  const chat = randomUUID(), otherChat = randomUUID();
  const session = await createSession({ conversationId: chat, title: 'Screenshot owner' });
  const otherSession = await createSession({ conversationId: otherChat, title: 'Other screenshot owner' });
  const owner = caller(session.id, chat), other = caller(otherSession.id, otherChat);
  const target = { pid: 500, window_id: 7 };
  const observed = await invokeDesktopCua('get_window_state', { ...target, include_accessibility_tree: false }, owner);
  expect(observed.structuredContent?.snapshot_id).toBeUndefined();
  expect(observed.content).toContainEqual({ type: 'image', mimeType: 'image/png', data: png });
  const action = { ...target, x: 12.5, y: 24.5, capture_id: observed.structuredContent?.capture_id };
  expect(firstText(await invokeDesktopCua('click', action, other))).toContain('CUA_SNAPSHOT_STALE');
  await invokeDesktopCua('get_window_state', { ...target, include_accessibility_tree: false }, other);
  expect(firstText(await invokeDesktopCua('click', { ...action, window_id: 8 }, owner))).toContain('CUA_SNAPSHOT_STALE');
  expect(firstText(await invokeDesktopCua('click', { ...action, pid: 501 }, owner))).toContain('CUA_SNAPSHOT_STALE');
  expect(firstText(await invokeDesktopCua('click', { ...action, delivery_mode: 'foreground' }, owner))).toContain('CUA_FOREGROUND_DENIED');
  expect((await invokeDesktopCua('click', action, owner)).structuredContent?.effect).toBe('confirmed');
  expect(firstText(await invokeDesktopCua('click', action, other))).toContain('CUA_CAPTURE_MISMATCH');
  expect(firstText(await invokeDesktopCua('click', action, owner))).toContain('CUA_SNAPSHOT_STALE');
  expect(dispatched.filter(call => call.name === 'click')).toHaveLength(1);
  await invokeDesktopCua('get_window_state', { pid: 700, window_id: 8, include_accessibility_tree: false }, owner);
  expect(firstText(await invokeDesktopCua('click', { pid: 700, window_id: 8, x: 1, y: 2, capture_id: 'c-s0000002c' }, owner)))
    .toContain('CUA_PROTECTED_BROWSER');
});

it('does not infer a window or accept old or forged tokens from a screenshot-only observation', async () => {
  const dispatched = nativeFixture();
  const chat = randomUUID(), session = await createSession({ conversationId: chat, title: 'Pixel-only tokens' });
  const owner = caller(session.id, chat), target = { pid: 500, window_id: 7 };
  await invokeDesktopCua('get_window_state', target, owner);
  await invokeDesktopCua('get_window_state', { ...target, include_accessibility_tree: false }, owner);
  for (const token of ['s0000002a:14', 's0000002b:14', ':14']) {
    expect(firstText(await invokeDesktopCua('click', { ...target, element_token: token }, owner))).toContain('CUA_TREE_REQUIRED');
    expect(firstText(await invokeDesktopCua('click', { pid: 500, element_token: token }, owner))).toContain('CUA_EXACT_WINDOW_REQUIRED');
  }
  // Even a returned snapshot ID cannot grant tokens when the read disabled the tree.
  vi.mocked(nativeRuntime.invokeEmbeddedCua).mockResolvedValueOnce({ content: [{ type: 'image', mimeType: 'image/png', data: png }],
    structuredContent: { ...target, snapshot_id: 's0000002c', capture_id: 'c-s0000002c', app_name: 'Notes' } });
  await invokeDesktopCua('get_window_state', { ...target, include_accessibility_tree: false }, owner);
  expect(firstText(await invokeDesktopCua('click', { ...target, element_token: 's0000002c:14' }, owner))).toContain('CUA_TREE_REQUIRED');
  expect(firstText(await invokeDesktopCua('click', { pid: 500, element_token: 's0000002c:14' }, owner))).toContain('CUA_EXACT_WINDOW_REQUIRED');
  expect(dispatched.every(call => call.name === 'get_window_state')).toBe(true);
  // Requesting a tree is not snapshot authority if the driver delivers only pixels.
  vi.mocked(nativeRuntime.invokeEmbeddedCua).mockResolvedValueOnce({ content: [{ type: 'image', mimeType: 'image/png', data: png }],
    structuredContent: { ...target, capture_id: 'c-no-snapshot', app_name: 'Notes' } });
  await invokeDesktopCua('get_window_state', target, owner);
  expect(firstText(await invokeDesktopCua('click', { ...target, element_token: 's0000002c:14' }, owner))).toContain('CUA_TREE_REQUIRED');
  expect(firstText(await invokeDesktopCua('click', { pid: 500, element_token: 's0000002c:14' }, owner))).toContain('CUA_EXACT_WINDOW_REQUIRED');
  expect((await invokeDesktopCua('click', { ...target, x: 1, y: 2, capture_id: 'c-no-snapshot' }, owner)).structuredContent?.effect).toBe('confirmed');
});

it.each([
  { label: 'image without capture', image: true, metadata: { capture_id: undefined } },
  { label: 'capture without image', image: false, metadata: {} },
  { label: 'metadata only', image: false, metadata: { capture_id: undefined } },
  { label: 'empty capture', image: true, metadata: { capture_id: '' } },
  { label: 'blank capture', image: true, metadata: { capture_id: ' ' } },
  { label: 'empty snapshot without capture', image: true, metadata: { capture_id: undefined, snapshot_id: '' } },
  { label: 'blank snapshot without capture', image: true, metadata: { capture_id: undefined, snapshot_id: ' ' } },
  { label: 'wrong returned pid', image: true, metadata: { pid: 501 } },
  { label: 'wrong returned window', image: true, metadata: { window_id: 8 } },
  { label: 'missing application identity', image: true, metadata: { app_name: undefined } }
])('rejects screenshot-only input from $label', async ({ image, metadata }) => {
  const dispatched = nativeFixture();
  const chat = randomUUID(), session = await createSession({ conversationId: chat, title: 'Incomplete capture' });
  const owner = caller(session.id, chat), target = { pid: 500, window_id: 7 };
  await invokeDesktopCua('get_window_state', target, owner);
  vi.mocked(nativeRuntime.invokeEmbeddedCua).mockResolvedValueOnce({
    content: image ? [{ type: 'image', mimeType: 'image/png', data: png }] : [{ type: 'text', text: 'capture metadata' }],
    structuredContent: { ...target, capture_id: 'c-incomplete', app_name: 'Notes', ...metadata }
  });
  await invokeDesktopCua('get_window_state', { ...target, include_accessibility_tree: false }, owner);
  expect(firstText(await invokeDesktopCua('click', { ...target, x: 1, y: 2, capture_id: 'c-incomplete' }, owner))).toContain('CUA_SNAPSHOT_STALE');
  expect(firstText(await invokeDesktopCua('press_key', { ...target, key: 'return' }, owner))).toContain('CUA_SNAPSHOT_STALE');
  expect(firstText(await invokeDesktopCua('click', { ...target, element_token: 's0000002a:14' }, owner))).toContain('CUA_SNAPSHOT_STALE');
  expect(dispatched.every(call => call.name === 'get_window_state')).toBe(true);
});

it('keeps the newest screenshot-only observation when an older window read finishes later', async () => {
  nativeFixture();
  const chat = randomUUID(), session = await createSession({ conversationId: chat, title: 'Newest screenshot' });
  const owner = caller(session.id, chat), target = { pid: 500, window_id: 7 };
  await invokeDesktopCua('get_window_state', target, owner);
  const entered = Promise.withResolvers<void>(), release = Promise.withResolvers<void>();
  vi.mocked(nativeRuntime.invokeEmbeddedCua).mockImplementationOnce(async () => {
    entered.resolve(); await release.promise;
    return { content: [{ type: 'image', mimeType: 'image/png', data: png }],
      structuredContent: { ...target, capture_id: 'c-old', app_name: 'Notes' } };
  });
  const pending = invokeDesktopCua('get_window_state', { ...target, include_accessibility_tree: false }, owner);
  await entered.promise;
  let latest;
  try {
    expect(firstText(await invokeDesktopCua('click', { ...target, element_token: 's0000002a:14' }, owner))).toContain('CUA_SNAPSHOT_STALE');
    latest = await invokeDesktopCua('get_window_state', { ...target, include_accessibility_tree: false }, owner);
  } finally { release.resolve(); }
  await pending;
  const pixels = { ...target, x: 1, y: 2 };
  expect(firstText(await invokeDesktopCua('click', { ...pixels, capture_id: 'c-old' }, owner))).toContain('CUA_CAPTURE_MISMATCH');
  expect((await invokeDesktopCua('click', { ...pixels, capture_id: latest.structuredContent?.capture_id }, owner)).structuredContent?.effect).toBe('confirmed');
});

it('refuses screenshot-only authority after its runtime generation changes', async () => {
  const dispatched = nativeFixture();
  const chat = randomUUID(), session = await createSession({ conversationId: chat, title: 'Capture generation' });
  const owner = caller(session.id, chat), target = { pid: 500, window_id: 7 };
  const observed = await invokeDesktopCua('get_window_state', { ...target, include_accessibility_tree: false }, owner);
  vi.mocked(nativeRuntime.embeddedCuaCatalog).mockReturnValue({ generation: 2, tools: projectCuaCatalog(declarations) });
  expect(firstText(await invokeDesktopCua('click', { ...target, x: 1, y: 2, capture_id: observed.structuredContent?.capture_id }, owner)))
    .toContain('CUA_SNAPSHOT_STALE');
  expect(dispatched.every(call => call.name === 'get_window_state')).toBe(true);
});

it('uses the current exact-window read for tools without a capture argument', async () => {
  const dispatched = nativeFixture();
  const chat = randomUUID(), session = await createSession({ conversationId: chat, title: 'Window input' });
  const owner = caller(session.id, chat), target = { pid: 500, window_id: 7 };
  const actions: Array<{ name: string; args: Record<string, unknown> }> = [
    { name: 'double_click', args: { x: 10, y: 20 } },
    { name: 'right_click', args: { x: 10, y: 20 } },
    { name: 'type_text', args: { x: 10, y: 20, text: 'native field' } },
    { name: 'press_key', args: { key: 'return' } },
    { name: 'hotkey', args: { keys: ['cmd', 'c'] } },
    { name: 'scroll', args: { direction: 'down', x: 10, y: 20 } },
    { name: 'drag', args: { from_x: 10, from_y: 20, to_x: 30, to_y: 40 } }
  ];
  for (const { name, args } of actions) {
    await invokeDesktopCua('get_window_state', target, owner);
    const action = { ...target, ...args };
    expect(firstText(await invokeDesktopCua(name, { ...action, capture_id: 'invented' }, owner)), name).toContain('CUA_INVALID_ARGUMENTS');
    expect(firstText(await invokeDesktopCua(name, { ...action, window_id: 8 }, owner)), name).toContain('CUA_SNAPSHOT_STALE');
    expect((await invokeDesktopCua(name, action, owner)).structuredContent?.effect, name).toBe('confirmed');
    expect(firstText(await invokeDesktopCua(name, action, owner)), name).toContain('CUA_SNAPSHOT_STALE');
  }
  expect(dispatched.filter(call => call.name !== 'get_window_state').map(call => call.name)).toEqual(actions.map(action => action.name));
});

it('requires actual image grounding and expires an otherwise current observation', async () => {
  const dispatched = nativeFixture();
  const chat = randomUUID(), session = await createSession({ conversationId: chat, title: 'Image grounding' });
  const owner = caller(session.id, chat), target = { pid: 500, window_id: 7 };
  await invokeDesktopCua('get_window_state', { ...target, include_screenshot: false }, owner);
  expect(firstText(await invokeDesktopCua('right_click', { ...target, x: 10, y: 20 }, owner))).toContain('CUA_SCREENSHOT_REQUIRED');
  await invokeDesktopCua('get_window_state', target, owner);
  vi.useFakeTimers({ toFake: ['Date'] });
  vi.setSystemTime(Date.now() + 30_001);
  expect(firstText(await invokeDesktopCua('press_key', { ...target, key: 'return' }, owner))).toContain('CUA_SNAPSHOT_STALE');
  expect(dispatched.every(call => call.name === 'get_window_state')).toBe(true);
});

it('reserves input authority before an async action and does not restore it after an uncertain failure', async () => {
  nativeFixture();
  const chat = randomUUID(), session = await createSession({ conversationId: chat, title: 'Reserved input' });
  const owner = caller(session.id, chat), target = { pid: 500, window_id: 7 };
  await invokeDesktopCua('get_window_state', target, owner);
  const entered = Promise.withResolvers<void>(), release = Promise.withResolvers<void>();
  vi.mocked(nativeRuntime.invokeEmbeddedCua).mockImplementationOnce(async () => {
    entered.resolve(); await release.promise; throw new Error('transport lost after dispatch');
  });
  const action = { ...target, element_token: 's0000002a:14' };
  const pending = invokeDesktopCua('click', action, owner);
  await entered.promise;
  try {
    expect(firstText(await invokeDesktopCua('click', action, owner))).toContain('CUA_SNAPSHOT_STALE');
  } finally { release.resolve(); }
  expect(firstText(await pending)).toContain('CUA_OUTCOME_UNKNOWN');
  expect(firstText(await invokeDesktopCua('click', action, owner))).toContain('CUA_SNAPSHOT_STALE');
});

it('reads only the exact chat cursor without spending or invalidating its observed input', async () => {
  const dispatched = nativeFixture();
  const chatA = randomUUID(), chatB = randomUUID();
  const a = await createSession({ conversationId: chatA, title: 'Active cursor' });
  const b = await createSession({ conversationId: chatB, title: 'Unrelated cursor' });
  const owner = caller(a.id, chatA), other = caller(b.id, chatB), target = { pid: 500, window_id: 7 };
  await invokeDesktopCua('get_window_state', target, owner);
  await invokeDesktopCua('click', { ...target, element_token: 's0000002a:14' }, owner);
  await invokeDesktopCua('get_window_state', target, owner);
  const position = await invokeDesktopCua('get_agent_cursor_state', {}, owner);
  expect(position.structuredContent?.position).toEqual({ x: 100, y: 200 });
  expect((await invokeDesktopCua('get_agent_cursor_state', {}, other)).structuredContent?.position).toBeNull();
  const foreignSession = dispatched[0]!.args.session;
  expect(firstText(await invokeDesktopCua('get_agent_cursor_state', { session: foreignSession }, other))).toContain('CUA_SESSION_OWNED');
  expect((await invokeDesktopCua('click', { ...target, element_token: 's0000002b:14' }, owner)).structuredContent?.effect).toBe('confirmed');
  expect(dispatched.filter(call => call.name === 'get_agent_cursor_state')).toHaveLength(2);
});

it('keeps cursor state screen/read-only gated and withholds an in-flight read after screen revocation', async () => {
  nativeFixture();
  const config = getConfig();
  const chat = randomUUID(), session = await createSession({ conversationId: chat, title: 'Cursor permissions' });
  const owner = caller(session.id, chat);
  const entered = Promise.withResolvers<void>(), release = Promise.withResolvers<void>();
  try {
    await saveConfig({ ...config, readOnly: true });
    expect(desktopCuaCatalog().some(tool => tool.name === 'get_agent_cursor_state')).toBe(true);
    expect((await invokeDesktopCua('get_agent_cursor_state', {}, owner)).structuredContent?.position).toBeNull();
    vi.mocked(nativeRuntime.invokeEmbeddedCua).mockImplementationOnce(async () => {
      entered.resolve(); await release.promise; return { content: [], structuredContent: { private_cursor_position: [100, 200] } };
    });
    const pending = invokeDesktopCua('get_agent_cursor_state', {}, owner);
    await entered.promise;
    await saveConfig({ ...getConfig(), capabilities: { ...getConfig().capabilities, screen: false } });
    release.resolve();
    const withheld = await pending;
    expect(firstText(withheld)).toContain('CUA_AUTHORITY_CHANGED');
    expect(JSON.stringify(withheld)).not.toContain('private_cursor_position');
    expect(desktopCuaCatalog().some(tool => tool.name === 'get_agent_cursor_state')).toBe(false);
    expect(firstText(await invokeDesktopCua('get_agent_cursor_state', {}, owner))).toContain('TOOL_DISABLED');
  } finally { release.resolve(); await saveConfig(config); }
});

it('keeps Desktop exec/wait wrappers and returns the native envelope in exec', async () => {
  nativeFixture();
  vi.mocked(nativeRuntime.invokeEmbeddedCua).mockResolvedValue({
    content: [{ type: 'text', text: 'native tree' }, { type: 'image', mimeType: 'image/png', data: png }],
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
    const chat = randomUUID(), requestId = 'wfr_' + randomUUID().replaceAll('-', '');
    const session = await createSession({ conversationId: chat, title: 'Desktop exec' });
    expect(observeRequestCorrelation({ requestId, conversationId: chat, sessionId: session.id,
      messageId: randomUUID(), tool: 'exec', observedAt: Date.now() })).toBe('stored');
    const executed = await rpc('tools/call', { name: 'exec', arguments: {
      code: 'const r=await tools.get_window_state({pid:500,window_id:7}); text(JSON.stringify(r));'
    } }, requestId);
    const result = JSON.parse(firstText(executed.result)) as { content: Array<{ type: string; data?: string }>; structuredContent: { snapshot_id: string } };
    expect(result.structuredContent.snapshot_id).toBe('s0000002a');
    expect(result.content[1]).toMatchObject({ type: 'image', data: png });
  } finally { await endpoint.stop(); }
});
