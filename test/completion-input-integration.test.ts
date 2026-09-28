import { afterAll, beforeAll, beforeEach, expect, it, vi } from 'vitest';
import { randomUUID } from 'node:crypto';
import { APP_VERSION, BRIDGE_PROTOCOL } from '../src/main/version.js';
type Handler = (event: unknown, payload: unknown) => Promise<any>;
const handlers = new Map<string, Handler>();
vi.mock('electron', () => ({
  ipcMain: { handle: (name: string, handler: Handler) => handlers.set(name, handler), removeHandler: (name: string) => handlers.delete(name) },
  BrowserWindow: class {}, clipboard: {}, dialog: {}, shell: {}, nativeTheme: { themeSource: 'system' },
  app: { on: vi.fn(), getPath: () => '', getVersion: () => '0.0.0', getAppPath: () => process.cwd(), isPackaged: false },
  safeStorage: {
    isAsyncEncryptionAvailable: async () => true, getSelectedStorageBackend: () => 'gnome_libsecret',
    encryptStringAsync: async (text: string) => Buffer.from(text),
    decryptStringAsync: async (data: Buffer) => ({ result: data.toString(), shouldReEncrypt: false })
  }
}));
vi.mock('../src/main/extension-path.js', () => ({ extensionDir: () => process.cwd() }));
vi.mock('../src/main/connection.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../src/main/connection.js')>();
  return { ...actual, connect: async () => {}, getStatus: () => ({ ...actual.getStatus(), state: 'connected' }) };
});
vi.mock('../src/main/browser.js', () => ({ openInPreferredBrowser: async () => 'chrome.exe', isOwnedBrowserRunning: () => null }));
const { defaultConfig, initConfigPath, saveConfig } = await import('../src/main/config.js');
const { initSecretsPath } = await import('../src/main/secrets.js');
const { initDurableStore, flushDurable, resetDurableForTests, writeDurableNow } = await import('../src/main/durable.js');
const { initSessionStore, resetSessionStoreForTests } = await import('../src/main/session/store.js');
const { registerIpc } = await import('../src/main/ipc.js');
const { bridgePort, startBridge, stopBridge } = await import('../src/main/bridge.js');
const input = await import('../src/main/session/input.js');
const goal = await import('../src/main/goal.js');
const { makeTempDir, removeTempDir } = await import('./helpers.js');
let directory: string;
let bearer: string;
const pushed = vi.fn();
async function post(route: string, body: unknown) {
  const response = await fetch(`http://127.0.0.1:${bridgePort()}${route}`, {
    method: 'POST', headers: { 'content-type': 'application/json', 'x-extension-version': APP_VERSION,
      'x-extension-protocol': String(BRIDGE_PROTOCOL), ...(bearer ? { authorization: `Bearer ${bearer}` } : {}) }, body: JSON.stringify(body)
  });
  return { status: response.status, body: await response.json() as any };
}
async function status(repaired?: string) {
  const response = await fetch(`http://127.0.0.1:${bridgePort()}/status${repaired ? `?repaired=${encodeURIComponent(repaired)}` : ''}`, {
    headers: { 'x-extension-version': APP_VERSION, 'x-extension-protocol': String(BRIDGE_PROTOCOL),
      authorization: `Bearer ${bearer}` }
  });
  expect(response.status).toBe(200);
  return await response.json() as { repairs?: Array<{ conversationId: string; token: string; reason: string }> };
}
beforeAll(async () => {
  directory = await makeTempDir('clf-completion-integration-');
  initConfigPath(directory); initSecretsPath(directory); initDurableStore(directory); initSessionStore(directory);
  await saveConfig(defaultConfig());
  registerIpc(() => ({ isDestroyed: () => false, webContents: { send: pushed } }) as never);
  await startBridge();
  const paired = await post('/pair', {});
  expect(paired.status).toBe(200);
  bearer = paired.body.token;
});
beforeEach(async () => {
  await writeDurableNow('session-input', []);
  await writeDurableNow('plugin-refresh', []);
  goal.resetGoalStateForTests(); input.resetInputForTests(); pushed.mockClear();
  await saveConfig({ ...defaultConfig(), goal: { ...defaultConfig().goal, enabled: false } });
});
afterAll(async () => {
  await stopBridge(); await flushDurable(); resetSessionStoreForTests(); resetDurableForTests();
  await removeTempDir(directory);
});

it.each([false, true])('settles the final and sends once after tools drain (owned: %s)', async owned => {
  const { recordToolCall } = await import('../src/main/session/recorder.js');
  const { trackInFlight, emptyEvidence } = await import('../src/main/mcp/call-context.js');
  const { findSessionByConversation, readEvents, getSession } = await import('../src/main/session/store.js');
  const { sessionControlsFor } = await import('../src/main/bridge.js');
  const conversationId = randomUUID(), requestId = randomUUID(), startedAt = Date.now();
  await post('/events', { conversationId, events: [
    { kind: 'model_selection', time: startedAt, model: 'gpt-5-6-pro', reasoningEffort: 'pro' },
    { kind: 'user_message', time: startedAt, messageId: 'question', text: 'Inspect the report' },
    ...(owned ? [{ kind: 'turn_start', time: startedAt + 1, turnId: 'actual-turn' }] : []),
    { kind: 'tool_evidence', time: startedAt + 2, calls: [{ messageId: 'call', tool: 'read', order: 0, answered: false, requestId }] }
  ] });
  await recordToolCall({ tool: 'read', args: {}, content: [{ type: 'text', text: 'ok' }], outcome: 'ok', durationMs: 1, startedAt, requestId });
  const session = (await findSessionByConversation(conversationId, { requireUnique: true }))!;
  expect((await sessionControlsFor(session.id)).canInject).toBe(true);
  const row = await input.enqueueInput({ id: randomUUID(), sessionId: session.id, text: 'Next check', mode: 'auto', dueAt: 0, model: null, reasoningEffort: null });
  await trackInFlight({ startedAt, transportKey: null, agent: null, outcome: null, evidence: emptyEvidence(),
    caller: { conversationId, requestId, transportKey: null } }, async () => {
    expect((await post('/events', { conversationId, events: [{ kind: 'assistant_message', time: startedAt,
      ...(owned ? { turnId: 'actual-turn' } : {}), messageId: 'final', providerMessageId: 'native-final',
      text: 'Complete.', state: 'final', final: true }] })).status).toBe(200);
    expect((await getSession(session.id))?.activeTurnId).toBeNull();
    expect(await input.claimBrowserInput(row.id, 'page', conversationId, true)).toBeNull();
    await recordToolCall({ tool: 'read', args: {}, content: [{ type: 'text', text: 'late result' }],
      outcome: 'ok', durationMs: 50, startedAt, requestId });
  });
  expect((await sessionControlsFor(session.id)).canInject).toBe(false);
  expect(await input.claimBrowserInput(row.id, 'page', conversationId, true)).not.toBeNull();
  expect(await input.authorizeBrowserInput(row.id, 'page', conversationId)).toBe(true);
  expect(await input.acknowledgeBrowserInput(row.id, 'page', conversationId, 'accepted-next')).toBe(true);
  expect(await input.claimBrowserInput(row.id, 'other-page', conversationId, true)).toBeNull();
  if (!owned) expect(await readEvents(session.id, { kinds: ['turn_end'] })).toEqual([]);
});

it('retires an unowned Pro final immediately across reloads without requiring a later tool result', async () => {
  const { recordToolCall } = await import('../src/main/session/recorder.js');
  const { findSessionByConversation, readEvents } = await import('../src/main/session/store.js');
  const { sessionControlsFor } = await import('../src/main/bridge.js');
  const conversationId = randomUUID(), requestId = randomUUID(), at = Date.now();
  await post('/events', { conversationId, events: [
    { kind: 'model_selection', time: at, model: 'gpt-5-6-pro', reasoningEffort: 'pro' },
    { kind: 'user_message', time: at, messageId: 'report-question', text: 'Prepare the report' },
    { kind: 'tool_evidence', time: at, calls: [{ messageId: 'report-call', tool: 'read', order: 0, answered: false, requestId }] }
  ] });
  await recordToolCall({ tool: 'read', args: {}, content: [{ type: 'text', text: 'Report material' }],
    outcome: 'ok', durationMs: 1, startedAt: at, requestId });
  const session = (await findSessionByConversation(conversationId, { requireUnique: true }))!;
  expect((await sessionControlsFor(session.id)).canInject).toBe(true);
  const final = { kind: 'assistant_message', time: at + 1, messageId: 'report-final',
    text: 'The report is complete.', state: 'final', final: true };
  for (let reload = 0; reload < 3; reload++) {
    expect((await post('/events', { conversationId, events: [final] })).status).toBe(200);
    expect((await sessionControlsFor(session.id)).canInject).toBe(false);
  }
  expect(await readEvents(session.id, { kinds: ['turn_start', 'turn_end'] })).toEqual([]);
  // A later authored generation must not be consumed by a replay of the old final.
  await post('/events', { conversationId, events: [
    { kind: 'user_message', time: at + 2, messageId: 'next-question', text: 'Now check the next report', authoredNow: true },
    { kind: 'turn_start', time: at + 3, turnId: 'next-generation' }
  ] });
  await post('/events', { conversationId, events: [final] });
  expect((await sessionControlsFor(session.id)).activeTurnId).toBe('next-generation');
});

it.each([false, true])('settles the last injected message from its exact final across restart and admits a new browser message (legacy=%s)', async legacy => {
  const { recordToolCall } = await import('../src/main/session/recorder.js');
  const { trackInFlight, emptyEvidence } = await import('../src/main/mcp/call-context.js');
  const { findSessionByConversation, upsertMessageEvent } = await import('../src/main/session/store.js');
  const conversationId = randomUUID(), requestId = randomUUID(), at = Date.now();
  await post('/events', { conversationId, events: [
    { kind: 'model_selection', time: at, model: 'gpt-5.6-sol', reasoningEffort: 'high' },
    { kind: 'user_message', time: at, messageId: 'question', text: 'Inspect this' },
    { kind: 'turn_start', time: at + 1, turnId: 'injected-turn' },
    { kind: 'tool_evidence', time: at + 2, calls: [{ messageId: 'last-call', tool: 'read', order: 0, answered: false, requestId }] }
  ] });
  const session = (await findSessionByConversation(conversationId, { requireUnique: true }))!;
  const row = await input.enqueueInput({ id: randomUUID(), sessionId: session.id, text: 'One correction', mode: 'auto', dueAt: 0, model: null, reasoningEffort: null });
  await input.offerToolInput(session.id, conversationId, requestId, at);
  if (legacy) {
    const rows = await input.listInputs();
    const offered = rows.find(entry => entry.id === row.id)!;
    await writeDurableNow('session-input', rows.map(entry => ({ ...entry, toolTurnId: undefined })));
    input.resetInputForTests();
    await upsertMessageEvent(session.id, { kind: 'user_message', source: 'app', time: offered.offeredAt!,
      messageId: `input:${row.id}`, inputId: row.id, inputDelivery: 'offered', message: { text: row.text, chars: row.text.length, truncated: false } });
  }
  await recordToolCall({ tool: 'read', args: {}, content: [{ type: 'text', text: 'Result with correction' }], outcome: 'ok', durationMs: 1, startedAt: at, requestId });
  expect((await input.listInputs()).find(entry => entry.id === row.id)?.state).toBe('tool');
  await post('/events', { conversationId, events: [{ kind: 'assistant_message', time: Date.now(), turnId: 'injected-turn', messageId: 'interim', text: 'Working on it', final: false }] });
  expect((await input.listInputs()).find(entry => entry.id === row.id)?.state).toBe('tool');
  await trackInFlight({ startedAt: at, transportKey: null, agent: null, outcome: null, evidence: emptyEvidence(),
    caller: { conversationId, requestId, transportKey: null } }, async () => {
    await post('/events', { conversationId, events: [
      { kind: 'assistant_message', time: Date.now(), turnId: 'injected-turn', messageId: 'final', text: 'Finished.', state: 'final', final: true },
      { kind: 'turn_end', time: Date.now(), turnId: 'injected-turn', outcome: 'completed' }
    ] });
    expect((await input.listInputs()).find(entry => entry.id === row.id)?.state).toBe('tool');
  });
  input.resetInputForTests();
  expect((await input.listInputs()).find(entry => entry.id === row.id)).toMatchObject({ state: 'sent', messageId: `input:${row.id}` });
  const followup = await input.enqueueInput({ id: randomUUID(), sessionId: session.id, text: 'Next task', mode: 'auto', dueAt: 0, model: null, reasoningEffort: null });
  expect(await input.claimBrowserInput(followup.id, 'page', conversationId, true)).not.toBeNull();
});

it.each([
  ['thinking_failed', 'failed', 'gpt-5.6-sol', 120_000],
  ['thinking_stopped', 'interrupted', 'gpt-6-pro', 300_000]
] as const)('files one ordinary Continue for exact native %s before MCP, then revokes on a new question', async (reason, outcome, model, wait) => {
  const { findSessionByConversation, turnHasMcpCall } = await import('../src/main/session/store.js');
  const { sweepStaleSwarm } = await import('../src/main/bridge.js');
  vi.useFakeTimers();
  try {
    const conversationId = randomUUID(), turnId = `native-${reason}`, at = Date.now();
    expect((await post('/events', { conversationId, events: [
      { kind: 'user_message', messageId: `question-${reason}`, text: 'Finish the requested work', time: at },
      { kind: 'model_selection', model, reasoningEffort: model === 'gpt-6-pro' ? 'pro' : 'high', time: at },
      { kind: 'turn_start', turnId, time: at + 1 }
    ] })).status).toBe(200);
    const session = (await findSessionByConversation(conversationId, { requireUnique: true }))!;
    expect(await turnHasMcpCall(session.id, conversationId, turnId)).toBe(false);
    const failure = { kind: 'turn_end', turnId, outcome, reason, time: at + 2 };
    expect((await post('/events', { conversationId, events: [failure] })).status).toBe(200);
    await vi.advanceTimersByTimeAsync(wait - 1);
    await sweepStaleSwarm(Date.now());
    expect((await status()).repairs?.filter(repair => repair.conversationId === conversationId) ?? []).toEqual([]);
    await vi.advanceTimersByTimeAsync(3);
    await sweepStaleSwarm(Date.now());
    const repairs = (await status()).repairs ?? [];
    expect(repairs).toHaveLength(1);
    expect(repairs[0]).toMatchObject({ conversationId, reason: 'silence' });
    expect((await status(repairs[0]!.token)).repairs ?? []).toEqual([]);
    const tickets = (await input.listInputs()).filter(row => row.sessionId === session.id && row.recovery);
    expect(tickets).toHaveLength(1);
    expect(tickets[0]).toMatchObject({ state: 'queued', silenceBoundary: { turnId, conversationId } });
    expect((await post('/events', { conversationId, events: [failure] })).status).toBe(200);
    expect((await input.listInputs()).filter(row => row.sessionId === session.id && row.recovery)).toHaveLength(1);
    expect((await status()).repairs ?? []).toEqual([]);
    expect((await post('/events', { conversationId, events: [
      { kind: 'user_message', messageId: 'new-question', text: 'A different task now', time: Date.now(), authoredNow: true },
      { kind: 'turn_start', turnId: 'new-turn', time: Date.now() }
    ] })).status).toBe(200);
    expect((await input.listInputs()).find(row => row.id === tickets[0]!.id)?.state).toBe('cancelled');
  } finally { vi.useRealTimers(); }
});

it.each(['silence', 'manual-stop', 'native-final'] as const)(
  'does not grant a tool-free Continue after %s', async ending => {
    const { findSessionByConversation } = await import('../src/main/session/store.js');
    const { sweepStaleSwarm } = await import('../src/main/bridge.js');
    vi.useFakeTimers();
    try {
      const conversationId = randomUUID(), turnId = `no-mcp-${ending}`, at = Date.now();
      await post('/events', { conversationId, events: [
        { kind: 'user_message', messageId: 'question', text: 'Finish this', time: at },
        { kind: 'turn_start', turnId, time: at + 1 }
      ] });
      const session = (await findSessionByConversation(conversationId, { requireUnique: true }))!;
      if (ending !== 'silence') {
        await post('/events', { conversationId, events: [
          { kind: 'turn_end', turnId, outcome: 'failed', reason: 'thinking_failed', time: at + 2 }
        ] });
        await post('/events', { conversationId, events: ending === 'manual-stop'
          ? [{ kind: 'turn_end', turnId, outcome: 'stopped', time: at + 3 }]
          : [{ kind: 'assistant_message', turnId, messageId: 'answer', providerMessageId: randomUUID(),
            text: 'The task is finished.', final: true, state: 'final', time: at + 3 }] });
      }
      await vi.advanceTimersByTimeAsync(120_003);
      await sweepStaleSwarm(Date.now());
      expect((await status()).repairs?.filter(repair => repair.conversationId === conversationId) ?? []).toEqual([]);
      expect((await input.listInputs()).filter(row => row.sessionId === session.id && row.recovery)).toEqual([]);
    } finally { vi.useRealTimers(); }
  }
);
