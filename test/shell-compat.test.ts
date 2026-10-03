/** Focused adaptation of @ehkogh's observed shell fixtures in #318 (c18f289c).
 * Only page identity, authored messages, tool evidence and the native picker.
 * No cache-derived message history, invented receipts or alternate presentation. */
import { readFileSync } from 'node:fs';
import { JSDOM } from 'jsdom';
import { afterEach, expect, it, vi } from 'vitest';

const domSource = readFileSync(new URL('../extension/chatgpt-dom.js', import.meta.url), 'utf8');
const fiberSource = readFileSync(new URL('../extension/fiber.js', import.meta.url), 'utf8');
const contentSource = readFileSync(new URL('../extension/content.js', import.meta.url), 'utf8');
const usageSource = readFileSync(new URL('../extension/usage.js', import.meta.url), 'utf8');
const THREAD = 'aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee';
const USER = '11111111-1111-4111-8111-111111111111';
const TURN = '22222222-2222-4222-8222-222222222222';
const CALL = '33333333-3333-4333-8333-333333333333';
const ANSWER = '44444444-4444-4444-8444-444444444444';
const OTHER = '55555555-5555-4555-8555-555555555555';
let page: JSDOM;
afterEach(() => page?.window.close());

function fixture() {
  page = new JSDOM(`<div id="root"><aside id="app-shell-sidebar"></aside><main data-app-shell-main-surface>
    <div data-thread-find-target="conversation"><div data-turn-key="${USER}"><div data-content-search-turn-key="${TURN}">
      <div data-content-search-unit-key="${TURN}:0:user"><div data-user-message-bubble><div class="whitespace-pre-wrap">hello</div></div></div>
      <div><span hidden data-chatgpt-agent-turn-start></span><button aria-expanded="true">Worked for 1s</button>
        <div data-markdown-text-style="assistant-message">Commentary without a provider message id</div></div>
      <div data-content-search-unit-key="${TURN}:2:assistant"><div data-markdown-text-style="assistant-message">Answer</div></div>
    </div></div></div>
    <form data-chatgpt-composer><div data-composer-body><div contenteditable="true" role="textbox" data-composer-markdown><p><br></p></div>
      <button type="button" data-composer-navigation-target="add-context">+</button>
      <button type="button" aria-haspopup="menu" data-codex-intelligence-trigger="true" data-composer-navigation-target="reasoning" data-selected-reasoning-effort="medium">Mittel</button>
      <button type="submit" aria-label="Senden">Senden</button>
    </div></form></main></div>`, { url: `https://chatgpt.com/c/${THREAD}`, runScripts: 'outside-only', pretendToBeVisual: true });
  const win = page.window, doc = win.document;
  Object.defineProperty(win.HTMLElement.prototype, 'getClientRects', { value() { return this.hidden ? [] : [{}]; } });
  win.postMessage = data => queueMicrotask(() => win.dispatchEvent(new win.MessageEvent('message', { data, source: win as any, origin: win.location.origin })));
  const chain = (props: any, parent: any = null) => ({ memoizedProps: props, return: parent });
  const queries: any[] = [];
  const cache = { getAll: () => queries };
  const top = chain({ client: { getQueryCache: () => cache } });
  const entry = { id: TURN, conversationId: THREAD, turn: { status: 'in_progress', messageIds: [USER, CALL, ANSWER], items: [
    { type: 'user-message', messageId: USER, serverMessageId: USER, message: 'hello' },
    { type: 'chatgpt-reasoning-group', items: [
      { type: 'reasoning', presentation: 'preamble', content: 'Commentary without a provider message id' },
      { type: 'mcp-tool-call', callId: CALL, completed: false, invocation: { server: 'Web GPT Agent', tool: 'link_x/read', arguments: { private: 'NEVER_COPY_TOOL_ARGS' } }, result: null }
    ] },
    { type: 'assistant-message', messageId: ANSWER, content: 'Answer', phase: 'final_answer', completed: false }
  ] as any[] } };
  const row = chain({ entry }, top);
  (doc.querySelector('[data-turn-key]') as any).__reactFiber$fixture = row;
  (doc.querySelector('[data-content-search-unit-key$=":assistant"] [data-markdown-text-style]') as any).__reactFiber$fixture = chain({ item: entry.turn.items[2], conversationId: THREAD }, row);
  const versions = [{ id: '5.6', label: 'GPT-5.6 Sol', selected: true }, { id: 'future', label: '未来モデル', selected: false }];
  const selections = [
    [ { model: 'gpt-5-6-thinking', modelLabel: '5.6 Sol', reasoningEffort: 'medium', powerSettingIndex: 1 },
      { model: 'gpt-5-6-thinking', modelLabel: '5.6 Sol', reasoningEffort: 'high', powerSettingIndex: 2 } ],
    [ { model: 'future-thinking', modelLabel: '未来モデル', reasoningEffort: 'high', powerSettingIndex: 1 },
      { model: 'future-pro', modelLabel: '未来 Pro', reasoningEffort: 'pro', powerSettingIndex: 2 } ]
  ];
  const props: any = { powerSelections: selections[0], selectedLabelCandidate: selections[0]![0], selectedPowerSelection: null,
    modelListConfig: { options: versions }, modelSelectionDisabled: false };
  const trigger = doc.querySelector('[data-codex-intelligence-trigger]') as HTMLButtonElement;
  (trigger as any).__reactFiber$fixture = chain(props, top);
  const actions = vi.fn();
  const render = () => {
    let panel = doc.querySelector('[data-model-picker-view]') as HTMLElement;
    if (!panel) { panel = doc.createElement('div'); panel.setAttribute('data-model-picker-view', 'simple'); panel.setAttribute('role', 'menu'); doc.body.append(panel); }
    // The portal intentionally has no picker owner; only the trigger does.
    panel.innerHTML = '<div role="menuitem" data-model-picker-view-toggle>Version</div><div role="menuitem" aria-keyshortcuts="ArrowLeft ArrowRight"></div>';
    panel.querySelector('[data-model-picker-view-toggle]')!.addEventListener('click', () => {
      panel.replaceChildren();
      for (const [index, version] of versions.entries()) {
        const option = doc.createElement('div'); option.setAttribute('role', 'menuitemradio'); option.textContent = version.label;
        option.addEventListener('keydown', (event: any) => { if (event.key !== 'Enter') return;
          actions('version'); versions.forEach(v => { v.selected = v === version; }); props.powerSelections = selections[index];
          props.selectedPowerSelection = selections[index]![0]; render(); }); panel.append(option);
      }
    });
    panel.querySelector('[aria-keyshortcuts]')!.addEventListener('keydown', (event: any) => {
      const selected = props.selectedPowerSelection ?? props.selectedLabelCandidate;
      const at = props.powerSelections.indexOf(selected) + (event.key === 'ArrowRight' ? 1 : -1);
      if (!props.powerSelections[at]) return; actions('effort'); props.selectedPowerSelection = props.powerSelections[at]; render();
    });
  };
  trigger.addEventListener('keydown', event => { if (event.key === 'Enter') render(); });
  doc.addEventListener('keydown', event => { if (event.key === 'Escape') doc.querySelector('[data-model-picker-view]')?.remove(); });
  win.eval(fiberSource); win.eval(domSource);
  let serial = 0;
  const ask = (source = 'clf-fiber-ask') => new Promise<any>((resolve, reject) => {
    const nonce = `shell-${++serial}`, expected = source.replace('-ask', '-reply');
    const timer = setTimeout(() => { win.removeEventListener('message', receive as any); reject(new Error('Missing helper reply')); }, 2500);
    const receive = (event: MessageEvent) => { if (event.data?.source !== expected || event.data.nonce !== nonce) return;
      clearTimeout(timer); win.removeEventListener('message', receive as any); resolve(event.data); };
    win.addEventListener('message', receive as any); win.postMessage({ source, nonce }, win.location.origin);
  });
  return { api: (win as any).CLF_DOM, doc, win, entry, row, top, props, versions, selections, trigger, actions, queries, ask, chain };
}

// Models the observed Markdown editor's native text/break serialization, not
// the app's receipt check. No exported scripts, credentials or chat text are used.
it('retires cloned shell proof but preserves a replacement with readable Fiber', async () => {
  const f = fixture();
  await f.ask();
  const original = f.doc.querySelector('[data-turn-key]')!;
  expect(original.getAttribute('data-clf-fiber-turn')).not.toBeNull();
  expect(f.api.generating()).toBe(true);
  const clone = original.cloneNode(true);
  original.replaceWith(clone);
  const empty = await f.ask();
  expect(empty).toMatchObject({ scanOk: true, turns: [] });
  expect(f.doc.querySelectorAll('[data-clf-fiber-turn], [data-clf-fiber-message], [data-clf-fiber-thought], [data-clf-fiber-image], [data-clf-shell-running]')).toHaveLength(0);
  expect(f.api.generating()).toBe(false);
  expect(f.api.messages()).toEqual([]);
  Reflect.set(clone, '__reactFiber$fixture', f.row);
  const readable = await f.ask();
  expect(readable).toMatchObject({ scanOk: true, turns: [{ turnId: TURN }] });
  expect(f.api.generating()).toBe(true);
  expect(f.api.messages().map((message: { id: string }) => message.id)).toEqual([USER, ANSWER]);
});

function editing(f: ReturnType<typeof fixture>) {
  const box = f.api.composer() as HTMLElement;
  const serialize = (node: Node, literal = false, display = false): string => {
    if (node.nodeType === 3) return literal || display ? node.textContent || '' : (node.textContent || '').replace(/[\\*_`#]/g, '\\$&');
    if (!(node instanceof f.win.HTMLElement)) return '';
    if (node.tagName === 'BR') return literal || display ? '\n' : '\\\n';
    return [...node.childNodes].map(child => serialize(child, literal || node.matches('span[data-prompt-literal-paste]'), display)).join('');
  };
  Object.defineProperty(box, 'innerText', { get: () => serialize(box, false, true) });
  f.doc.execCommand = vi.fn((command, _ui, html) => {
    const selection = f.doc.getSelection();
    if (f.doc.activeElement !== box || !selection) return false;
    if (command === 'selectAll') { selection.selectAllChildren(box); return true; }
    if (!['insertHTML', 'delete'].includes(command) || !selection.rangeCount) return false;
    const range = selection.getRangeAt(0); range.deleteContents();
    if (command === 'insertHTML') {
      const template = f.doc.createElement('template'); template.innerHTML = html || ''; range.insertNode(template.content);
    }
    return true;
  });
  return { box, serialize: () => serialize(box) };
}

async function recorder(f: ReturnType<typeof fixture>, replies: Record<string, (m: any) => any> = {}) {
  const win = f.win as any, sent: any[] = [];
  let hook: any, listener: any;
  win.CLF_TEST_HOOK = (value: any) => { hook = value; };
  win.setInterval = () => 0;
  win.chrome = { runtime: { id: 'shell-fixture', onMessage: { addListener(value: any) { listener = value; }, removeListener() {} },
    sendMessage: async (message: any) => {
      sent.push(message);
      if (replies[message.type]) return replies[message.type]!(message);
      if (message.type === 'status') return { connected: true, paired: true, pending: 0 };
      if (message.type === 'activity') return { ok: true, data: { entries: [], stream: [], pendingTools: 0 } };
      if (message.type === 'correlate') return { ok: true, data: { conversationId: THREAD, confirmed: message.calls.map((call: any) => call.requestId) } };
      return { ok: true, pending: 0, durable: true };
    } }, storage: { onChanged: { addListener() {}, removeListener() {} } } };
  win.eval(contentSource);
  await vi.waitFor(() => expect(hook).toBeTruthy());
  await hook.refreshFiber(); await hook.pullActivity(); hook.observe(); await hook.flush();
  return { sent, hook, runtime: (message: any) => new Promise<any>(resolve => listener(message, {}, resolve)),
    events: () => sent.filter(m => m.type === 'events').flatMap(m => m.entries.map((entry: any) => entry.event)) };
}

function addExchange(f: ReturnType<typeof fixture>, ordinal: number, text: string) {
  const id = (part: number) => `99999999-1111-4111-8111-${String(ordinal * 10 + part).padStart(12, '0')}`;
  const userId = id(1), turnId = id(2), answerId = id(3);
  const node = f.doc.createElement('div'); node.setAttribute('data-turn-key', userId);
  node.innerHTML = `<div data-content-search-turn-key="${turnId}"><div data-content-search-unit-key="${turnId}:0:user"><div data-user-message-bubble><div class="whitespace-pre-wrap"></div></div></div><span hidden data-chatgpt-agent-turn-start></span><div data-content-search-unit-key="${turnId}:1:assistant"><div data-markdown-text-style="assistant-message"></div></div></div>`;
  node.querySelector('.whitespace-pre-wrap')!.textContent = text;
  const entry = { id: turnId, conversationId: THREAD, turn: { status: 'in_progress', messageIds: [userId, answerId], items: [
    { type: 'user-message', messageId: userId, serverMessageId: userId, message: text },
    { type: 'assistant-message', messageId: answerId, content: 'Working', phase: 'final_answer', completed: false }
  ] } };
  (node as any).__reactFiber$fixture = f.chain({ entry }, f.top);
  f.doc.querySelector('[data-thread-find-target]')!.append(node);
  return { userId, answerId, entry, finish() { entry.turn.status = 'complete'; entry.turn.items[1]!.completed = true;
    entry.turn.items[1]!.content = 'Finished'; node.querySelector('[data-markdown-text-style]')!.textContent = 'Finished'; } };
}

function firstMissingPicker(f: ReturnType<typeof fixture>) {
  return new Promise<void>(resolve => {
    const receive = (event: MessageEvent) => {
      if (event.data?.source !== 'clf-picker-reply' || event.data.picker !== null) return;
      f.win.removeEventListener('message', receive as any); resolve();
    };
    f.win.addEventListener('message', receive as any);
  });
}

it('reads the real shell composer, messages and tools through existing contracts without a cache', async () => {
  const f = fixture();
  expect(f.api.composer()).toBe(f.doc.querySelector('[contenteditable]'));
  expect(f.api.messages()).toEqual([]); // Slot keys alone are not provider identities.
  const { turns, rows } = await f.ask();
  expect(rows).toEqual([]); expect(turns).toHaveLength(1);
  expect(turns[0]).toMatchObject({ turnId: TURN, conversationId: THREAD, conversationConflict: false, endMessageId: null });
  expect(turns[0].messages.map((m: any) => [m.role, m.rawMessageId, m.rawText])).toEqual([['user', USER, 'hello'], ['assistant', ANSWER, 'Answer']]);
  // No mapping is mounted, so no question is proven and the field is simply absent.
  expect(turns[0].calls).toEqual([{ messageId: CALL, tool: 'read', order: 0, answered: false,
    requestId: null, createTime: null }]);
  expect(JSON.stringify(turns)).not.toContain('NEVER_COPY_TOOL_ARGS');
  expect(JSON.stringify(turns)).not.toContain('Commentary without a provider');
  expect(f.api.turns().map((t: any) => t.role)).toEqual(['user', 'assistant']);
  expect(f.api.messages().map((m: any) => [m.id, m.role, m.text])).toEqual([[USER, 'user', 'hello'], [ANSWER, 'assistant', 'Answer']]);
  expect(f.api.presentationTurns()).toEqual([]); // No alternate Overwrite/UI implementation.
});

it.each(['in_progress', 'cancelled', 'complete', 'unknown', undefined])('does not invent a tool receipt from turn status %s', async status => {
  const f = fixture(); (f.entry.turn as any).status = status;
  const turn = (await f.ask()).turns[0];
  expect(turn.calls[0].answered).toBe(false); expect(turn.endMessageId).toBeNull();
});
it('requires the final item and successful turn, while retaining exact messages on reload', async () => {
  const f = fixture(); f.entry.turn.items[2].completed = true;
  expect((await f.ask()).turns[0].endMessageId).toBeNull();
  f.entry.turn.status = 'complete';
  const completed = (await f.ask()).turns[0]; expect(completed.endMessageId).toBe(ANSWER);
  expect(completed.calls[0].answered).toBe(false);
  expect((await f.ask()).turns[0].messages.map((m: any) => m.messageId)).toEqual(completed.messages.map((m: any) => m.messageId));
  f.entry.turn.items.push({ type: 'assistant-message', messageId: OTHER, content: 'retry underway', phase: 'final_answer', completed: false });
  expect((await f.ask()).turns[0].endMessageId).toBeNull();
});
it('reports an explicit per-call completion without a synthetic result message', async () => {
  const f = fixture(); f.entry.turn.items[1].items[1].completed = true;
  const turn = (await f.ask()).turns[0]; expect(turn.calls[0].answered).toBe(true);
  expect(turn.messages).toHaveLength(2); expect(turn.endMessageId).toBeNull();
});
it('reads request metadata only for the mounted shell message ids in the exact native cache', async () => {
  const f = fixture();
  const message = { id: CALL, author: { role: 'assistant' }, recipient: 'api_tool.call_tool',
    metadata: { request_id: OTHER }, create_time: 1700000000,
    content: { content_type: 'code', text: '{"path":"/Web GPT Agent/link_x/read","args":{"secret":"NEVER_COPY"}}' } };
  f.queries.push({ queryKey: ['chatgpt-conversation', THREAD], state: { data: { mapping: {
    [CALL]: { id: CALL, message },
    [OTHER]: { id: OTHER, message: { ...message, id: OTHER, metadata: { request_id: 'wfr_UNSELECTED' } } }
  } } } });
  const turn = (await f.ask()).turns[0];
  expect(turn.requests).toEqual([{ requestId: OTHER, messageId: CALL, createTime: 1700000000 }]);
  expect(turn.calls[0]).toMatchObject({ messageId: CALL, requestId: OTHER, answered: false });
  expect(JSON.stringify(turn)).not.toContain('NEVER_COPY');
  expect(JSON.stringify(turn)).not.toContain('wfr_UNSELECTED');
  const recorded = await recorder(f);
  await vi.waitFor(() => expect(recorded.sent).toContainEqual(expect.objectContaining({ type: 'correlate',
    conversationId: THREAD, calls: expect.arrayContaining([expect.objectContaining({ requestId: OTHER })]) })));
  (f.win as any).__CLF_CONTENT_RECORDER__.stop();
  f.queries[0].queryKey[1] = OTHER;
  expect((await f.ask()).turns[0].requests).toEqual([]);
  f.queries[0].queryKey[1] = THREAD; f.queries[0].state.data.mapping[CALL].message.id = OTHER;
  expect((await f.ask()).turns[0].requests).toEqual([]);
});
it('proves each connector request against the user question its own parent chain reaches', async () => {
  // `metadata.request_id` sits on the connector node, never on the human's message, so which
  // question a request answers is only knowable from the provider's own graph. This walks that
  // chain and reports the exact user message; a time or turn-order guess would have attributed
  // the request to whichever user message happened to be nearby.
  const f = fixture();
  const text = (id: string, role: string, extra: Record<string, unknown> = {}) =>
    ({ id, author: { role }, content: { content_type: 'text', parts: ['x'] }, ...extra });
  f.queries.push({ queryKey: ['chatgpt-conversation', THREAD], state: { data: { conversation_id: THREAD, mapping: {
    [USER]: { id: USER, parent: null, message: text(USER, 'user') },
    [CALL]: { id: CALL, parent: USER, message: text(CALL, 'assistant', { metadata: { request_id: OTHER } }) },
    [ANSWER]: { id: ANSWER, parent: CALL, message: text(ANSWER, 'assistant') }
  } } } });
  const turn = (await f.ask()).turns[0];
  expect(turn.calls[0]).toMatchObject({ messageId: CALL, requestId: OTHER, questionId: USER });
  // The private connector payload never travels with it.
  expect(JSON.stringify(turn)).not.toContain('NEVER_COPY');
});

it('carries both proofs when the graph contradicts itself, and none when the chain breaks', async () => {
  const f = fixture();
  const text = (id: string, role: string, extra: Record<string, unknown> = {}) =>
    ({ id, author: { role }, content: { content_type: 'text', parts: ['x'] }, ...extra });
  // One request id proven against two different questions. Both proofs travel — the app records the
  // contradiction and refuses — rather than the first answer standing unchallenged.
  f.queries.push({ queryKey: ['chatgpt-conversation', THREAD], state: { data: { conversation_id: THREAD, mapping: {
    [USER]: { id: USER, parent: null, message: text(USER, 'user') },
    [CALL]: { id: CALL, parent: USER, message: text(CALL, 'assistant', { metadata: { request_id: OTHER } }) },
    [ANSWER]: { id: ANSWER, parent: 'second-question', message: text(ANSWER, 'assistant', { metadata: { request_id: OTHER } }) },
    'second-question': { id: 'second-question', parent: null, message: text('second-question', 'user') }
  } } } });
  const contradictory = (await f.ask()).turns[0];
  expect(contradictory.requests.map((r: any) => r.questionId).sort()).toEqual([USER, 'second-question'].sort());
  expect(contradictory.calls[0].questionId).toBe(USER);

  // A chain whose ancestor link leaves the mapping proves nothing about any question, so the call
  // carries no proof at all rather than a guessed one.
  f.queries[0].state.data.mapping[CALL].parent = 'gone';
  const broken = (await f.ask()).turns[0];
  expect(broken.calls[0]).not.toHaveProperty('questionId');
  // Only the broken chain lost its proof. The other message carrying the same request id still
  // proves its own ancestor, because the walk is per-node — nothing here falls back to message
  // order or to another row's answer.
  expect(broken.requests.map((r: any) => r.questionId)).toEqual([undefined, 'second-question']);
});

it.each(['duplicate-cache', 'conflicting-conversation', 'duplicate-id', 'unavailable-cache'])('keeps the transcript without ambiguous optional request metadata (%s)', async kind => {
  const f = fixture();
  const query = { queryKey: ['chatgpt-conversation', THREAD], state: { data: { conversation_id: THREAD, mapping: {
    [CALL]: { id: CALL, message: { id: CALL, metadata: { request_id: OTHER } } }
  } } } };
  f.queries.push(query);
  if (kind === 'duplicate-cache') f.queries.push(query);
  if (kind === 'conflicting-conversation') query.state.data.conversation_id = OTHER;
  if (kind === 'duplicate-id') f.entry.turn.messageIds.push(CALL);
  if (kind === 'unavailable-cache') f.top.memoizedProps.client.getQueryCache = () => { throw new Error('retired'); };
  const turn = (await f.ask()).turns[0];
  expect(turn.requests).toEqual([]); expect(turn.messages).toHaveLength(2); expect(turn.endMessageId).toBeNull();
});

// Live 2026-09-27: the shell's conversation view subscribes (useSyncExternalStore) to the graph the
// stream writes. The `chatgpt-conversation` query entry is only its page-load snapshot, so calls
// issued after load had no request id until a reload. Shapes mirror that view; values are synthetic.
const RESULT = '66666666-6666-4666-8666-666666666666', EXEC = '77777777-7777-4777-8777-777777777777';
const graphNode = (id: string, parent: string | null, message: Record<string, unknown>, children: string[] = []) =>
  ({ id, parent, children, message: { id, status: 'finished_successfully', ...message } });
function liveGraph() {
  return {
    [USER]: graphNode(USER, null, { author: { role: 'user' }, content: { content_type: 'text', parts: ['hello'] } }, [CALL]),
    [CALL]: graphNode(CALL, USER, { author: { role: 'assistant' }, recipient: 'api_tool.call_tool', create_time: 1700000000,
      metadata: { request_id: OTHER, connector_tool_payload: 'NEVER_COPY_PAYLOAD' }, content: { content_type: 'code', text: '{"path":"/Web GPT Agent/link_x/read"}' } }, [ANSWER]),
    [ANSWER]: graphNode(ANSWER, CALL, { author: { role: 'assistant' }, recipient: 'all', content: { content_type: 'text', parts: ['Answer'] } })
  } as Record<string, any>;
}
function mountStore(f: ReturnType<typeof fixture>, mapping: Record<string, any>, parent: any = f.top) {
  const hooks = { memoizedState: null, queue: null, next: { memoizedState: mapping, queue: { value: mapping, getSnapshot: () => mapping }, next: null } };
  const view = { memoizedProps: { conversationId: THREAD }, memoizedState: hooks, return: parent };
  f.row.return = view;
  return view;
}
const exactResult = (graph: Record<string, any>, extra: Record<string, any> = {}) => {
  graph[RESULT] = graphNode(RESULT, CALL, { author: { role: 'tool', name: 'api_tool.call_tool' }, recipient: 'all',
    metadata: { parent_id: CALL, request_id: OTHER, invoked_resource: { app_name: 'Web GPT Agent', resource_uri: '/asdk_app_x/link_x/read' } },
    content: { content_type: 'text', parts: ['NEVER_COPY_RESULT'] }, ...extra });
  graph[CALL].children = [ANSWER, RESULT];
};
it('attributes a request streamed after load from the live shell conversation store', async () => {
  const f = fixture(), graph = liveGraph();
  mountStore(f, graph);
  const turn = (await f.ask()).turns[0];
  expect(f.queries).toEqual([]);
  expect(turn.calls[0]).toMatchObject({ messageId: CALL, requestId: OTHER, createTime: 1700000000, questionId: USER, answered: false });
  expect(turn.requests).toContainEqual(expect.objectContaining({ requestId: OTHER, messageId: CALL, questionId: USER }));
  expect(JSON.stringify(turn)).not.toContain('NEVER_COPY');
  const recorded = await recorder(f);
  await vi.waitFor(() => expect(recorded.sent).toContainEqual(expect.objectContaining({ type: 'correlate',
    conversationId: THREAD, calls: expect.arrayContaining([expect.objectContaining({ requestId: OTHER, questionId: USER })]) })));
  (f.win as any).__CLF_CONTENT_RECORDER__.stop();
});
it('reads the original shell user text from its exact mounted provider message, not Markdown presentation', async () => {
  const f = fixture(), graph = liveGraph();
  const original = '[[CONTEXT:13]]\nPrivate setup\n[[/CONTEXT]]\n\n# Keep **literal** text and C:\\work\\*.ts.';
  f.entry.turn.items[0].message = original.replace(/[\\*_#]/g, '\\$&').replace(/\n/g, '\\\n');
  graph[USER].message.content.parts = [original];
  // Only the mounted exact user id may supply source. Cached answers stay outside this read.
  graph[ANSWER].message.content.parts = ['UNMOUNTED_SOURCE_ANSWER'];
  mountStore(f, graph);
  const turn = (await f.ask()).turns[0];
  expect(turn.messages).toContainEqual(expect.objectContaining({ role: 'user', messageId: USER, rawText: original }));
  expect(JSON.stringify(turn)).not.toContain('UNMOUNTED_SOURCE_ANSWER');
});
it.each(['cache', 'live'])('reads only authored string parts of a mounted multimodal shell user from the %s graph', async source => {
  const f = fixture(), graph = liveGraph();
  const original = '[[COS_CONTEXT:13]]\nPrivate setup\n[[/COS_CONTEXT]]\n\n# Keep **literal** C:\\work\\*.ts.';
  f.entry.turn.items[0].message = original.replace(/[\\*_#]/g, '\\$&').replace(/\n/g, '\\\n');
  const split = original.lastIndexOf('\n');
  graph[USER].message.content = { content_type: 'multimodal_text', parts: [
    original.slice(0, split), { content_type: 'image_asset_pointer', asset_pointer: 'sediment://NEVER_COPY_POINTER' },
    original.slice(split + 1), { content_type: 'text', text: 'NEVER_COPY_OBJECT_TEXT' }
  ] };
  if (source === 'live') mountStore(f, graph);
  else f.queries.push({ queryKey: ['chatgpt-conversation', THREAD], state: { data: { mapping: graph } } });
  const turn = (await f.ask()).turns[0];
  expect(turn.messages).toContainEqual(expect.objectContaining({ role: 'user', messageId: USER, rawText: original }));
  expect(JSON.stringify(turn)).not.toContain('NEVER_COPY_POINTER');
  expect(JSON.stringify(turn)).not.toContain('NEVER_COPY_OBJECT_TEXT');
});
it.each(['foreign-conversation', 'wrong-node', 'wrong-message', 'wrong-role', 'unmounted-id', 'wrong-type', 'object-only'])('does not borrow original shell user text from unproved graph identity/content (%s)', async kind => {
  const f = fixture(), graph = liveGraph();
  const presentation = '# Literal presentation';
  f.entry.turn.items[0].message = presentation;
  graph[USER].message.content.parts = ['FOREIGN_SOURCE_TEXT'];
  if (kind === 'wrong-node') graph[USER].id = OTHER;
  if (kind === 'wrong-message') graph[USER].message.id = OTHER;
  if (kind === 'wrong-role') graph[USER].message.author.role = 'assistant';
  if (kind === 'unmounted-id') f.entry.turn.messageIds = [CALL, ANSWER];
  if (kind === 'wrong-type') graph[USER].message.content.content_type = 'code';
  if (kind === 'object-only') graph[USER].message.content = { content_type: 'multimodal_text', parts: [{ content_type: 'text', text: 'FOREIGN_SOURCE_TEXT' }] };
  f.queries.push({ queryKey: ['chatgpt-conversation', kind === 'foreign-conversation' ? OTHER : THREAD],
    state: { data: { mapping: graph } } });
  const turn = (await f.ask()).turns[0];
  expect(turn.messages).toContainEqual(expect.objectContaining({ role: 'user', messageId: USER, rawText: presentation }));
  expect(JSON.stringify(turn)).not.toContain('FOREIGN_SOURCE_TEXT');
});
it('abstains when the live store disagrees with the load-time cache or another mounted graph', async () => {
  const f = fixture(), graph = liveGraph();
  mountStore(f, graph);
  const stale = liveGraph(); stale[CALL].message.metadata = { request_id: 'wfr_STALE' };
  f.queries.push({ queryKey: ['chatgpt-conversation', THREAD], state: { data: { conversation_id: THREAD, mapping: stale } } });
  const disputed = (await f.ask()).turns[0];
  expect(disputed.requests).toEqual([]); expect(disputed.calls[0].requestId).toBeNull();
  expect(JSON.stringify(disputed)).not.toContain('wfr_STALE');
  // The load-time snapshot simply lacking the later call is agreement, not a contradiction.
  delete stale[CALL]; stale[USER].children = [];
  expect((await f.ask()).turns[0].calls[0].requestId).toBe(OTHER);
  f.queries.length = 0;
  const other = liveGraph(); other[CALL].message.metadata = { request_id: 'wfr_SECOND_GRAPH' };
  mountStore(f, graph, { memoizedProps: { conversationId: THREAD }, memoizedState: { memoizedState: other, queue: { getSnapshot: () => other }, next: null }, return: f.top });
  const ambiguous = (await f.ask()).turns[0];
  expect(ambiguous.requests).toEqual([]); expect(ambiguous.calls[0].requestId).toBeNull();
});
it('answers a shell call only from its own exact result, never from completed:false or the turn ending', async () => {
  const f = fixture(), graph = liveGraph();
  mountStore(f, graph);
  f.entry.turn.status = 'complete'; f.entry.turn.items[2].completed = true;
  const pending = (await f.ask()).turns[0];
  expect(pending.endMessageId).toBe(ANSWER); expect(pending.calls[0].answered).toBe(false);
  exactResult(graph);
  expect(f.entry.turn.items[1].items[1].completed).toBe(false);
  const answered = (await f.ask()).turns[0];
  expect(answered.calls[0].answered).toBe(true); expect(JSON.stringify(answered)).not.toContain('NEVER_COPY_RESULT');
  for (const change of [
    (g: Record<string, any>) => { g[RESULT].message.metadata.invoked_resource.app_name = 'Web GPT Agent Backup'; },
    (g: Record<string, any>) => { g[RESULT].message.metadata.invoked_resource.resource_uri = '/asdk_app_x/link_x/write'; },
    (g: Record<string, any>) => { g[RESULT].message.metadata.request_id = 'wfr_OTHER_REQUEST'; },
    (g: Record<string, any>) => { g[RESULT].message.metadata.parent_id = ANSWER; },
    (g: Record<string, any>) => { g[ANSWER].message.author = { role: 'tool', name: 'api_tool.call_tool' }; }
  ]) {
    exactResult(graph); change(graph);
    expect((await f.ask()).turns[0].calls[0].answered).toBe(false);
  }
});
it('answers a Code Mode child call from its enclosing exec reply only under the same request scope', async () => {
  const f = fixture(), graph = liveGraph(), scope = { request_id: OTHER, working_turn_id: 'work-1', turn_exchange_id: 'exchange-1' };
  graph[EXEC] = graphNode(EXEC, USER, { author: { role: 'assistant' }, recipient: 'functions.exec', metadata: scope,
    content: { content_type: 'code', text: 'NEVER_COPY_CODE' } }, [CALL]);
  graph[USER].children = [EXEC];
  Object.assign(graph[CALL], { parent: EXEC, children: [RESULT] });
  graph[CALL].message.metadata = { ...scope, parent_id: EXEC };
  // Live, the reply's metadata parent names a node outside the mounted graph; its tree link is exact.
  graph[RESULT] = graphNode(RESULT, CALL, { author: { role: 'tool', name: 'functions.exec' }, recipient: 'all',
    metadata: { ...scope, parent_id: 'outside-the-graph' }, content: { content_type: 'text', parts: ['x'] } });
  mountStore(f, graph);
  const turn = (await f.ask()).turns[0];
  expect(turn.calls[0]).toMatchObject({ messageId: CALL, requestId: OTHER, questionId: USER, answered: true });
  graph[RESULT].message.metadata.working_turn_id = 'work-2';
  expect((await f.ask()).turns[0].calls[0].answered).toBe(false);
  graph[RESULT].message.metadata.working_turn_id = 'work-1'; graph[EXEC].message.status = 'in_progress';
  expect((await f.ask()).turns[0].calls[0].answered).toBe(false);
});
it('recognizes the shell recipient spelling without admitting similarly named connectors', async () => {
  const f = fixture(), step = f.entry.turn.items[1].items[1];
  step.invocation.server = 'Web_GPT_Agent'; step.invocation.tool = 'read';
  expect((await f.ask()).turns[0].calls).toHaveLength(1);
  step.invocation.server = 'Web_GPT_Agent_Backup';
  expect((await f.ask()).turns[0].calls).toEqual([]);
  // The retired Core-suffixed name is not an alias: this app publishes the bare brand.
  step.invocation.server = 'Web_GPT_Agent_Core';
  expect((await f.ask()).turns[0].calls).toEqual([]);
});
it('retires shell busy evidence when its owner becomes unreadable or another question is mounted', async () => {
  const f = fixture(); await f.ask(); expect(f.api.generating()).toBe(true);
  f.entry.id = OTHER; await f.ask(); expect(f.api.generating()).toBe(false);
  f.entry.id = TURN; await f.ask(); expect(f.api.generating()).toBe(true);
  const next = addExchange(f, 5, 'Another question'); next.finish(); await f.ask();
  expect(f.api.generating()).toBe(false);
});
it('never takes message content or final status from an unrelated cached branch', async () => {
  const f = fixture();
  f.queries.push({ queryKey: ['chatgpt-conversation', THREAD], state: { data: { mapping: { [USER]: {
    id: USER, children: [OTHER], message: { id: USER, author: { role: 'user' }, content: { content_type: 'text', parts: ['hello'] } }
  }, [OTHER]: { id: OTHER, children: [], message: { id: OTHER, author: { role: 'assistant' }, content: { content_type: 'text', parts: ['UNSELECTED BRANCH'] }, end_turn: true, status: 'finished_successfully' } } } } } });
  const turn = (await f.ask()).turns[0]; expect(JSON.stringify(turn)).not.toContain('UNSELECTED BRANCH'); expect(turn.endMessageId).toBeNull();
});
it('requires the exact local-to-server identity and refuses conflicting native owners', async () => {
  const f = fixture(), local = `local-chatgpt:${OTHER}`;
  f.entry.conversationId = local;
  expect((await f.ask()).turns[0].conversationId).toBeNull();
  f.queries.push({ queryKey: ['chatgpt-conversation-details', { clientConversationId: local, serverConversationId: THREAD }], state: {} });
  expect((await f.ask()).turns[0].conversationId).toBe(THREAD);
  f.queries.push({ queryKey: ['chatgpt-conversation-details', { clientConversationId: local, serverConversationId: OTHER }], state: {} });
  const disputed = (await f.ask()).turns[0]; expect(disputed.conversationId).toBeNull(); expect(disputed.conversationConflict).toBe(true);
});
it('invalidates reused DOM stamps when the typed row changes identity or contains duplicate message ids', async () => {
  const f = fixture(); await f.ask();
  f.entry.id = OTHER;
  expect((await f.ask()).turns).toEqual([]); expect(f.api.messages()).toEqual([]);
  f.entry.id = TURN; f.entry.turn.items.push({ ...f.entry.turn.items[2], content: 'different answer' });
  expect((await f.ask()).turns).toEqual([]);
});
it('uses typed running state rather than a translated Stop caption', async () => {
  const f = fixture(); const send = f.doc.querySelector('button[type="submit"]')!;
  send.outerHTML = '<button type="button" aria-label="Anhalten">Anhalten</button>';
  await f.ask(); expect(f.api.generating()).toBe(true); expect(f.api.composerSubmitReady()).toBe(false);
  expect(f.api.stopButton()).toBeNull(); // No guessed action target.
});
// Live 2026-09-27 shell: Send and Stop are one localized primary action whose element
// owner is keyed 'send' | 'stop'; switching mode remounts the button.
const keyedAction = (f: ReturnType<typeof fixture>, type: 'button' | 'submit', label: string, key: string) => {
  const button = f.doc.createElement('button'); button.type = type; button.setAttribute('aria-label', label);
  (button as any).__reactFiber$fixture = { key: null, memoizedProps: { type }, return: { key, memoizedProps: { ariaLabel: label, type }, return: null } };
  return button;
};
it('projects the shell Send/Stop mode key onto the exact current control and drops it on remount', async () => {
  const f = fixture(); f.entry.turn.status = 'complete';
  const send = keyedAction(f, 'submit', '보내기', 'send');
  f.doc.querySelector('form [type="submit"]')!.replaceWith(send);
  await f.ask();
  expect(send.getAttribute('data-clf-shell-action')).toBe('send');
  expect(f.api.sendButton()).toBe(send); expect(f.api.stopButton()).toBeNull(); expect(f.api.generating()).toBe(false);
  const stop = keyedAction(f, 'button', '중지', 'stop'); send.replaceWith(stop);
  expect(f.api.stopButton()).toBeNull(); // An unprojected replacement is unknown, not Stop.
  await f.ask();
  expect(f.api.stopButton()).toBe(stop); expect(f.api.generating()).toBe(true); expect(f.api.composerSubmitReady()).toBe(false);
  const again = keyedAction(f, 'submit', '보내기', 'send'); stop.replaceWith(again);
  expect(f.api.stopButton()).toBeNull(); // The detached stamped Stop is not in the composer.
  await f.ask();
  expect(again.getAttribute('data-clf-shell-action')).toBe('send'); expect(f.api.stopButton()).toBeNull();
  // Two keyed actions are ambiguous: every stamp is withdrawn, including the connected one.
  again.after(keyedAction(f, 'button', '중지', 'stop'));
  await f.ask();
  expect(f.doc.querySelectorAll('[data-clf-shell-action]')).toHaveLength(0); expect(f.api.stopButton()).toBeNull();
});
it('keeps classic Stop discovery unstamped by the shell projection', async () => {
  const f = fixture(), form = f.doc.querySelector('form')!;
  form.removeAttribute('data-chatgpt-composer');
  form.innerHTML = '<div id="prompt-textarea" contenteditable="true"></div><button type="button" data-testid="stop-button" aria-label="Stop streaming"></button>';
  (form.querySelector('button') as any).__reactFiber$fixture = { key: null, memoizedProps: {}, return: { key: 'stop', memoizedProps: {}, return: null } };
  await f.ask();
  expect(f.doc.querySelectorAll('[data-clf-shell-action]')).toHaveLength(0);
  expect(f.api.stopButton()).toBe(form.querySelector('[data-testid="stop-button"]'));
});
it('proves shell Temporary Chat from the typed header toggle owner for this exact route only', async () => {
  const f = fixture();
  page.reconfigure({ url: 'https://chatgpt.com/?temporary-chat=true' });
  const bar = f.doc.createElement('div'); bar.setAttribute('data-app-shell-main-titlebar', 'true');
  const toggle = f.doc.createElement('button'); toggle.type = 'button'; toggle.setAttribute('aria-label', '임시 채팅 끄기');
  const owner = { isTemporaryChat: true, conversationId: 'local-chatgpt:synthetic', onToggle() {} };
  (toggle as any).__reactFiber$fixture = f.chain({ 'aria-label': '임시 채팅 끄기' }, f.chain({ tooltipContent: '임시 채팅 끄기' }, f.chain(owner)));
  bar.append(toggle); f.doc.body.prepend(bar);
  expect(f.api.temporaryChatReady()).toBe(false); // No projection yet: unknown.
  await f.ask();
  expect(toggle.getAttribute('data-clf-temporary-chat')).toBe('/?temporary-chat=true');
  expect(f.api.temporaryChatReady()).toBe(true);
  f.win.history.pushState({}, '', '/?temporary-chat=true&other=1');
  expect(f.api.temporaryChatReady()).toBe(false); // The stale route stamp expires before the next scan.
  f.win.history.pushState({}, '', '/?temporary-chat=true');
  owner.isTemporaryChat = false;
  await f.ask();
  expect(toggle.hasAttribute('data-clf-temporary-chat')).toBe(false); expect(f.api.temporaryChatReady()).toBe(false);
});
// Live 2026-09-27 (900/1260/1600 px): aside[data-app-shell-left-panel-appearance] > div#app-shell-sidebar
// > nav > New Chat, beside an inert rail copy without the typed owner. A peer saw the aside without the id.
it.each([true, false])('elects the shell sidebar New Chat by its typed owner on the current route (sidebar id=%s)', async withId => {
  const f = fixture();
  const aside = f.doc.createElement('aside'); aside.setAttribute('data-app-shell-left-panel-appearance', 'default');
  aside.innerHTML = `<div${withId ? ' id="app-shell-sidebar"' : ''}><div inert><nav data-app-navigation-rail="true"><button type="button" aria-label="새 채팅"></button></nav></div><nav aria-label="채팅 기록"><button type="button" aria-current="page"></button></nav></div>`;
  f.doc.querySelector('aside#app-shell-sidebar')!.replaceWith(aside);
  const button = aside.querySelector('nav[aria-label] button') as HTMLButtonElement;
  (button as any).__reactFiber$fixture = f.chain({ type: 'button' }, f.chain({ animatedIcon: 'sidebar-new-chat', isActive: false }));
  (aside.querySelector('[data-app-navigation-rail] button') as any).__reactFiber$fixture = f.chain({ type: 'button' }, f.chain({ hideLabel: true, label: '새 채팅' }));
  expect(await f.api.newChatControl()).toBeNull();
  await f.ask();
  expect(button.getAttribute('data-clf-new-chat')).toBe(`/c/${THREAD}`);
  expect(await f.api.newChatControl()).toBe(button);
  f.win.history.pushState({}, '', '/c/other');
  expect(await f.api.newChatControl()).toBeNull();
  // A second typed owner is ambiguous: the projection is withdrawn, never picked by order.
  const twin = f.doc.createElement('button'); (twin as any).__reactFiber$fixture = (button as any).__reactFiber$fixture;
  button.after(twin);
  await f.ask();
  expect(f.doc.querySelectorAll('[data-clf-new-chat]')).toHaveLength(0);
  expect(await f.api.newChatControl()).toBeNull();
});
// Live 2026-09-27 shell upload: React-id inputs in the composer form (image/*,video/* | image/* | any).
// Each tile's remove button has a localized caption; its owner chain carries `attachment { name, status }`.
it.each(['image', 'file'])('uploads through the exact shell %s input and waits for every typed tile to be ready', async kind => {
  const f = fixture(), form = f.doc.querySelector('form')!, body = f.doc.querySelector('[data-composer-body]')!;
  class Transfer { files: File[] = []; items = { add: (file: File) => { this.files.push(file); } }; }
  Object.defineProperty(f.win, 'DataTransfer', { value: Transfer });
  const inputs = ['image/*,video/*', 'image/*', null].map((accept, index) => {
    const input = f.doc.createElement('input'); input.type = 'file'; input.id = `_r_f${index}_`; if (accept) input.setAttribute('accept', accept);
    Object.defineProperty(input, 'files', { writable: true, value: [] }); form.append(input); return input;
  });
  const records: any[] = [];
  const target = kind === 'image' ? inputs[1]! : inputs[2]!;
  for (const input of inputs) input.addEventListener('change', () => {
    if (input !== target) throw new Error('wrong input');
    const tray = f.doc.createElement('div'); tray.setAttribute('data-composer-attachments', '');
    for (const file of (input as any).files as File[]) {
      // The provider may display a renamed copy; the typed record keeps the requested name.
      const record = { name: file.name, status: 'uploading', uploadId: 'synthetic' }; records.push(record);
      const tile = f.doc.createElement('span'); tile.innerHTML = `<span role="progressbar" aria-label="${file.name} 업로드 중"></span><button type="button" aria-label="${file.name}"></button><button type="button" aria-label="${file.name} 제거"></button>`;
      const remove = tile.querySelector('button:last-child')!;
      remove.addEventListener('click', () => tray.remove());
      (remove as any).__reactFiber$fixture = f.chain({ type: 'button' }, f.chain({ ariaLabel: `${file.name} 제거`, onRemove() {} }, f.chain({ attachment: record })));
      tray.append(tile);
    }
    body.before(tray);
  });
  const file = kind === 'image' ? [] : [new f.win.File(['synthetic'], 'notes.txt', { type: 'text/plain' })];
  const images = kind === 'image' ? [{ name: 'pixel.webp', dataUrl: 'data:image/webp;base64,YQ==' }] : [];
  let settled: boolean | null = null;
  const uploading = f.api.uploadImages(images, () => true, null, file).then((value: boolean) => { settled = value; });
  const name = kind === 'image' ? 'pixel.webp' : 'notes.txt';
  await vi.waitFor(() => expect(f.doc.querySelector('[data-clf-attachment]')?.getAttribute('data-clf-attachment')).toBe(`uploading:${name}`));
  expect(f.api.composerAttachmentNames()).toEqual([name]); expect(f.api.hasComposerAttachments()).toBe(true);
  f.doc.querySelector('[role="progressbar"]')!.remove(); // A finished spinner alone is not the typed receipt.
  await new Promise(resolve => setTimeout(resolve, 20));
  expect(settled).toBeNull();
  records[0].status = 'ready'; f.doc.querySelector('[data-composer-attachments]')!.setAttribute('data-state', 'ready');
  await uploading;
  expect(settled).toBe(true);
  expect(f.doc.querySelector('[data-clf-attachment]')!.getAttribute('data-clf-attachment')).toBe(`ready:${name}`);
  (f.doc.querySelector('[data-clf-attachment]') as HTMLButtonElement).click();
  expect(f.api.hasComposerAttachments()).toBe(false); expect(f.api.composerAttachmentNames()).toEqual([]);
});
it('anchors companion controls in the shell trailing voice group with or without a draft', () => {
  const f = fixture(), body = f.doc.querySelector('[data-composer-body]')!;
  f.doc.querySelector('button[type="submit"]')!.remove();
  // Live 2026-09-30 empty composer: leading / input / trailing groups; no Send until a draft exists.
  const footer = f.doc.createElement('div'); footer.setAttribute('data-composer-footer-responsive', '');
  footer.innerHTML = '<div><button type="button">+</button></div><div data-composer-layout="single-line"></div>' +
    '<div><div><div><button type="button" aria-label="모델">m</button></div><div id="voice"><div><button type="button" aria-label="음성 입력"></button></div><div><button type="button" aria-label="음성 대화 시작"></button></div></div></div></div>';
  body.append(footer);
  const voice = f.doc.getElementById('voice')!;
  expect(f.api.composerActions()).toEqual({ host: voice, before: null });
  const send = f.doc.createElement('div'); send.innerHTML = '<button type="submit" aria-label="보내기"></button>';
  voice.lastElementChild!.replaceWith(send);
  expect(f.api.composerActions()).toEqual({ host: voice, before: send });
});
it('treats a shown shell attachment tray with tiles as an unsent draft', () => {
  const f = fixture(), body = f.doc.querySelector('[data-composer-body]')!;
  // Live 2026-09-30: the empty tray stays mounted, hidden and childless.
  const tray = f.doc.createElement('div'); tray.setAttribute('data-composer-attachments', ''); tray.hidden = true;
  body.before(tray);
  expect(f.api.hasComposerAttachments()).toBe(false);
  tray.innerHTML = '<div role="button" aria-label="report.md"></div><button aria-label="report.md 제거"></button>'; tray.hidden = false;
  expect(f.api.hasComposerAttachments()).toBe(true);
  tray.replaceChildren(); tray.hidden = true; expect(f.api.hasComposerAttachments()).toBe(false);
});
it('preserves prepared multiline text through the shell editor serializer', () => {
  const f = fixture(), edit = editing(f);
  const value = '[[COS_CONTEXT:42]]\n# Worker instructions\n- Keep **literal** text, C:\\work and `<tag>`.\n[[/COS_CONTEXT]]\n\nContinue the task.';
  expect(f.api.insertPrompt(value, true)).toBe(true);
  expect(edit.serialize()).toBe(value);
  expect(f.doc.execCommand).toHaveBeenCalledOnce();
  expect(edit.box.querySelector('tag')).toBeNull();
});
it('hides only a verified shell prompt frame and restores a recycled user bubble', async () => {
  const f = fixture(), unit = f.doc.querySelector('[data-content-search-unit-key$=":user"]')!;
  const raw = unit.querySelector('.whitespace-pre-wrap')!;
  const full = '[[COS_CONTEXT:13]]\nPrivate setup\n[[/COS_CONTEXT]]\n\nAuthored request';
  f.entry.turn.items[0].message = full; raw.textContent = full;
  f.api.presentUserPrompts();
  expect(unit.querySelector('[data-clf-user-text]')).toBeNull(); // A layout key cannot authorize rewriting.
  await f.ask();
  f.api.presentUserPrompts((message: { id: string }) => message.id === USER ? full : null);
  expect(unit.querySelector('[data-clf-user-text]')?.textContent).toBe('Authored request');
  expect(raw.hasAttribute('data-clf-prompt-hidden')).toBe(true);
  expect(f.api.messages().find((message: any) => message.id === USER)?.text).toBe(full);
  f.entry.turn.items[0].message = 'A new question'; raw.textContent = 'A new question';
  f.api.presentUserPrompts(() => 'A new question');
  expect(unit.querySelector('[data-clf-user-text]')).toBeNull();
  expect(raw.hasAttribute('data-clf-prompt-hidden')).toBe(false);
});
it('delivers three successive shell inputs with exact receipts and completed answers', async () => {
  const f = fixture(), edit = editing(f);
  const graph = liveGraph();
  f.queries.push({ queryKey: ['chatgpt-conversation', THREAD], state: { data: { mapping: graph } } });
  f.entry.turn.status = 'complete'; f.entry.turn.items[2].completed = true;
  let offered: any, latest: ReturnType<typeof addExchange>, count = 0;
  const submitted: string[] = [];
  f.doc.querySelector('button[type="submit"]')!.addEventListener('click', event => {
    event.preventDefault(); const text = edit.serialize(); submitted.push(text);
    latest = addExchange(f, ++count, text); edit.box.replaceChildren();
    latest.entry.turn.items[0]!.message = text.replace(/[\\*_#]/g, '\\$&').replace(/\n/g, '\\\n');
  });
  const r = await recorder(f, { desktop_input: m => ({ ok: true, data: m.authorize || m.ack || m.fail ? { ok: true } : { input: offered } }) });
  for (let at = 1; at <= 3; at++) {
    const text = at === 1 ? '[[COS_CONTEXT:13]]\nPrivate setup\n[[/COS_CONTEXT]]\n\n# First **request**' : `Follow-up ${at}\nKeep C:\\work and **literal** text.`;
    offered = { id: `88888888-1111-4111-8111-${String(at).padStart(12, '0')}`, owner: `owner-${at}`, text,
      model: 'gpt-5-6-thinking', reasoningEffort: 'high', purpose: 'user', images: [] };
    const pending = r.runtime({ type: 'clf-desktop-input', id: offered.id, conversationId: THREAD });
    await vi.waitFor(() => expect(submitted).toHaveLength(at), { timeout: 5000 });
    await r.hook.refreshFiber(); r.hook.observe();
    // The opening frame requires canonical source, not its displayed Markdown
    // copy. Late evidence settles the same click without authorizing another one.
    if (at === 1) expect(r.sent.filter(m => m.type === 'desktop_input' && m.ack && m.id === offered.id)).toEqual([]);
    graph[latest!.userId] = graphNode(latest!.userId, null, { author: { role: 'user' }, content: at === 1
      ? { content_type: 'multimodal_text', parts: [text, { content_type: 'image_asset_pointer', asset_pointer: 'sediment://NEVER_COPY_OPENING_IMAGE' }] }
      : { content_type: 'text', parts: [text] } });
    if (at === 1) {
      const source = (await f.ask()).turns.find((turn: { turnId: string }) => turn.turnId === latest!.entry.id);
      expect(source?.messages).toContainEqual(expect.objectContaining({ role: 'user', messageId: latest!.userId, rawText: text }));
      expect(JSON.stringify(source)).not.toContain('NEVER_COPY_OPENING_IMAGE');
    }
    await r.hook.refreshFiber(); r.hook.observe();
    expect(await pending).toEqual({ ok: true });
    expect(submitted).toHaveLength(at); // Late canonical evidence settles the one native click.
    expect(submitted.at(-1)).toBe(text);
    expect(r.sent.filter(m => m.type === 'desktop_input' && m.ack && m.id === offered.id)).toHaveLength(1);
    expect(JSON.stringify(r.events())).not.toContain('NEVER_COPY_OPENING_IMAGE');
    latest!.finish(); await r.hook.refreshFiber(); r.hook.observe(); await r.hook.flush();
    await vi.waitFor(() => expect(r.events()).toContainEqual(expect.objectContaining({ kind: 'assistant_message', providerMessageId: latest!.answerId, final: true })), { timeout: 3000 });
    expect(f.api.generating()).toBe(false); expect(edit.box.textContent).toBe('');
  }
  expect(r.sent.filter(m => m.type === 'desktop_input' && m.fail)).toEqual([]);
  expect(r.events().filter((e: any) => e.kind === 'turn_end' && e.outcome === 'completed')).toHaveLength(3);
  (f.win as any).__CLF_CONTENT_RECORDER__.stop();
}, 15000);
it.each([false, true])('bootstraps a shell worker with literal instructions and the exact native conversation (cold=%s)', async cold => {
  const f = fixture(), edit = editing(f), commandId = 'shell-worker-command';
  const options = f.props.modelListConfig;
  const missing = cold ? firstMissingPicker(f) : null;
  if (cold) f.props.modelListConfig = null;
  f.doc.querySelector('[data-thread-find-target]')!.replaceChildren();
  page.reconfigure({ url: `https://chatgpt.com/?clf=${commandId}` });
  const text = '[[COS_CONTEXT:13]]\nPrivate setup\n[[/COS_CONTEXT]]\n\n# Worker\nRead **one** file.';
  const submitted: string[] = [];
  f.doc.querySelector('button[type="submit"]')!.addEventListener('click', event => {
    event.preventDefault(); submitted.push(edit.serialize()); addExchange(f, 4, submitted[0]!); edit.box.replaceChildren();
    f.win.history.pushState({}, '', `/c/${THREAD}`);
  });
  const recording = recorder(f, { redeem: () => ({ ok: true, command: { id: commandId, type: 'worker', text,
    agent: 'worker-1', model: 'gpt-5-6-thinking', reasoningEffort: 'high' } }) });
  if (missing) {
    await missing; expect(submitted).toEqual([]);
    f.props.modelListConfig = options; f.trigger.setAttribute('data-state', 'closed');
  }
  const r = await recording;
  await vi.waitFor(() => expect(r.sent).toContainEqual(expect.objectContaining({ type: 'ack', id: commandId, status: 'sent', conversationId: THREAD, agent: 'worker-1' })), { timeout: 5000 });
  expect(submitted).toEqual([text]);
  expect(r.sent.filter(m => m.type === 'ack' && m.status === 'failed')).toEqual([]);
  (f.win as any).__CLF_CONTENT_RECORDER__.stop();
}, 10000);
it('opens a local project from a cold shell page and binds its exact first send before recording', async () => {
  const f = fixture(), edit = editing(f), inputId = '88888888-1111-4111-8111-000000000001';
  const options = f.props.modelListConfig; f.props.modelListConfig = null;
  const missing = firstMissingPicker(f);
  f.doc.querySelector('[data-thread-find-target]')!.replaceChildren();
  page.reconfigure({ url: `https://chatgpt.com/?cos-input=${inputId}` });
  const setup = '# Project instructions\n' + 'Preserve **literal** paths and project ownership.\n'.repeat(300);
  const text = `[[COS_CONTEXT:${setup.length}]]\n${setup}\n[[/COS_CONTEXT]]\n\nInspect the project.`;
  const input = { id: inputId, owner: 'project-owner', opening: true, projectId: OTHER, text,
    model: 'gpt-5-6-thinking', reasoningEffort: 'high', purpose: 'user', images: [] };
  const submitted: string[] = [];
  f.doc.querySelector('button[type="submit"]')!.addEventListener('click', event => {
    event.preventDefault(); submitted.push(edit.serialize());
    const exchange = addExchange(f, 7, submitted[0]!);
    exchange.entry.conversationId = `local-chatgpt:${OTHER}`;
    f.queries.push({ queryKey: ['chatgpt-conversation-details', { clientConversationId: exchange.entry.conversationId, serverConversationId: THREAD }] });
    edit.box.replaceChildren(); f.win.history.pushState({}, '', `/c/${THREAD}`);
  });
  const r = await recorder(f, {
    desktop_input: m => ({ ok: true, data: m.authorize || m.ack || m.fail ? { ok: true } : { input } }),
    bind: m => ({ ok: true, bound: 0, projectBound: m.projectInput?.id })
  });
  const delivery = r.runtime({ type: 'clf-desktop-input', id: inputId, conversationId: null });
  await missing; expect(submitted).toEqual([]);
  f.props.modelListConfig = options; f.trigger.setAttribute('data-state', 'closed');
  await vi.waitFor(() => expect(submitted).toHaveLength(1));
  await r.hook.refreshFiber(); r.hook.observe();
  expect(await delivery).toEqual({ ok: true });
  expect(submitted).toEqual([text]);
  expect(r.sent.filter(m => m.type === 'desktop_input' && m.authorize)).toHaveLength(1);
  expect(r.sent.filter(m => m.type === 'desktop_input' && m.ack)).toHaveLength(1);
  expect(r.sent.filter(m => m.type === 'desktop_input' && m.fail)).toEqual([]);
  expect(r.sent.filter(m => m.type === 'bind')).toContainEqual(expect.objectContaining({
    conversationId: THREAD, projectInput: { id: inputId, owner: 'project-owner' }
  }));
  expect(r.hook.desktopProjectInputForTest()).toBeNull();
  (f.win as any).__CLF_CONTENT_RECORDER__.stop();
}, 10000);
it('correlates an early shell stream request through the real observer and recorder without cached messages', async () => {
  const f = fixture(), win = f.win as any;
  const r = await recorder(f);
  const frames = ['event: delta_encoding\ndata: "v1"\n\n',
    `event: delta\ndata: ${JSON.stringify({ v: { conversation_id: THREAD, message: { metadata: { request_id: OTHER }, content: { parts: ['NEVER_COPY_STREAM_TEXT'] } } } })}\n\n`];
  let index = 0;
  win.TextDecoder = TextDecoder;
  win.fetch = async () => ({ ok: true, url: 'https://chatgpt.com/backend-api/f/conversation',
    headers: { get: () => 'text/event-stream' }, clone: () => ({ body: { getReader: () => ({
      read: async () => index < frames.length ? { done: false, value: new TextEncoder().encode(frames[index++]!) } : { done: true },
      cancel: async () => undefined
    }) } }) });
  win.eval(usageSource);
  await win.fetch('/backend-api/f/conversation', { method: 'POST' });
  await vi.waitFor(() => expect(r.sent.filter(m => m.type === 'correlate')).toContainEqual(expect.objectContaining({
    conversationId: THREAD, calls: expect.arrayContaining([expect.objectContaining({ requestId: OTHER })])
  })));
  expect(f.queries).toEqual([]);
  expect(JSON.stringify(r.sent)).not.toContain('NEVER_COPY_STREAM_TEXT');
  win.__CLF_CONTENT_RECORDER__.stop();
});
it('sends a marked shell handoff once and captures its exact completed brief instead of the preceding answer', async () => {
  const f = fixture(), edit = editing(f), token = '0123456789abcdef0123456789abcdef';
  f.entry.turn.status = 'complete'; f.entry.turn.items[2].completed = true;
  const prompt = `[[CLF-HANDOFF:${token}]]\n\nWrite the brief. Keep **Markdown** and C:\\work intact.`;
  const brief = 'TASK: retain the requested project. RESULT: completed the first change. NEXT: verify the remaining work.';
  const submitted: string[] = [], summaries: string[] = [];
  let source: ReturnType<typeof addExchange>, state = 'not-attempted';
  f.doc.querySelector('button[type="submit"]')!.addEventListener('click', event => {
    event.preventDefault(); submitted.push(edit.serialize()); source = addExchange(f, 8, submitted[0]!); edit.box.replaceChildren();
  });
  const r = await recorder(f, { compact: m => {
    if (m.sourceAttempt) { state = 'attempted-unresolved'; return { ok: true, data: { allowed: true } }; }
    if (m.sourceDispatch) { state = 'dispatched-unresolved'; return { ok: true, data: { armed: true } }; }
    if (m.sourceMessageId) { state = 'sent'; return { ok: true, data: {} }; }
    if (typeof m.summary === 'string') { summaries.push(m.summary); return { ok: true, data: { job: { stage: 'opening', busy: true } } }; }
    return { ok: true, data: { token, ...(m.ticket ? {} : { prompt }), sourceSend: { state },
      job: { stage: 'handoff-pending', busy: true, automatic: false, sourceSend: { state } } } };
  } });
  const pending = r.hook.startCompact();
  await vi.waitFor(() => expect(submitted).toEqual([prompt]), { timeout: 3000 });
  await r.hook.refreshFiber(); r.hook.observe(); await pending;
  expect(summaries).toEqual([]);
  source!.finish(); source!.entry.turn.items[1]!.content = brief;
  await r.hook.refreshFiber(); r.hook.observe();
  await vi.waitFor(() => expect(summaries).toEqual([brief]));
  expect(r.sent.filter(m => m.sourceDispatch)).toHaveLength(1);
  expect(r.sent).toContainEqual(expect.objectContaining({ type: 'compact', token, sourceMessageId: source!.userId }));
  await r.hook.refreshFiber(); r.hook.observe();
  expect(submitted).toEqual([prompt]); expect(summaries).toEqual([brief]);
  (f.win as any).__CLF_CONTENT_RECORDER__.stop();
}, 10000);

it.each(['streaming', 'cancelled', 'conflicting-conversation'])('does not promote an unproven shell final identity: %s', async scenario => {
  const f = fixture();
  f.entry.turn.status = scenario === 'cancelled' ? 'cancelled' : 'complete';
  f.entry.turn.items[2].completed = scenario !== 'streaming';
  if (scenario === 'conflicting-conversation') f.row.memoizedProps.conversationId = OTHER;
  const { turns } = await f.ask();
  expect(turns[0].messages.filter((message: any) => message.role === 'assistant').every((message: any) => message.stable === false)).toBe(true);
});

it('commits a shell resume through its exact native marker before releasing recorded history', async () => {
  const f = fixture(), edit = editing(f), commandId = 'shell-resume-command', token = '0123456789abcdef0123456789abcdef';
  f.doc.querySelector('[data-thread-find-target]')!.replaceChildren();
  page.reconfigure({ url: `https://chatgpt.com/?clf=${commandId}` });
  const text = `[[CLF-RESUME:${token}]]\n\nTASK: continue **the project**. NEXT: verify the remaining work.`;
  let committed = false, historyBeforeCommit = false;
  const submitted: string[] = [];
  f.doc.querySelector('button[type="submit"]')!.addEventListener('click', event => {
    event.preventDefault(); submitted.push(edit.serialize()); addExchange(f, 9, submitted[0]!); edit.box.replaceChildren();
    f.win.history.pushState({}, '', `/c/${THREAD}`);
  });
  const r = await recorder(f, {
    redeem: () => ({ ok: true, command: { id: commandId, type: 'resume', text, agent: null,
      model: 'gpt-5-6-thinking', reasoningEffort: 'high' } }),
    compact: m => {
      if (m.destinationAttempt) return { ok: true, data: { allowed: true } };
      if (m.destinationDispatch) return { ok: true, data: { armed: true } };
      if (m.destinationMessageId && m.token === token && m.conversationId === THREAD) committed = true;
      return { ok: true, data: { committed, conversationId: THREAD, commandId } };
    },
    events: m => { if (!committed && m.entries.some((entry: any) => entry.event?.kind === 'user_message')) historyBeforeCommit = true;
      return { ok: true, pending: 0, durable: true }; }
  });
  await vi.waitFor(() => expect(r.sent).toContainEqual(expect.objectContaining({ type: 'ack', id: commandId, status: 'sent', conversationId: THREAD })), { timeout: 5000 });
  expect(submitted).toEqual([text]); expect(committed).toBe(true); expect(historyBeforeCommit).toBe(false);
  expect(r.sent.filter(m => m.destinationDispatch)).toHaveLength(1);
  expect(r.sent).toContainEqual(expect.objectContaining({ type: 'compact', token, destinationMessageId: '99999999-1111-4111-8111-000000000091' }));
  (f.win as any).__CLF_CONTENT_RECORDER__.stop();
}, 10000);

it('leaves classic messages readable when quoted markup contains shell-looking attributes', () => {
  const f = fixture(); f.doc.body.innerHTML = '<section data-testid="conversation-turn-1" data-turn="assistant"><div data-message-id="actual" data-message-author-role="assistant"><div class="markdown">real answer<div id="app-shell-sidebar"></div><div data-turn-key="quoted"></div></div></div></section>';
  expect(f.api.turns()).toHaveLength(1); expect(f.api.messages()[0].text).toContain('real answer');
});
it('does not borrow a shell row owner for a nested exchange inside authored prose', async () => {
  const f = fixture();
  const quote = f.doc.createElement('div'); quote.setAttribute('data-turn-key', 'quoted');
  quote.innerHTML = `<div data-content-search-turn-key="${TURN}"><div data-content-search-unit-key="${TURN}:0:user">quoted user</div></div>`;
  (quote as any).__reactFiber$fixture = f.row;
  f.doc.querySelector('[data-content-search-unit-key$=":assistant"] [data-markdown-text-style]')!.append(quote);
  expect((await f.ask()).turns).toHaveLength(1);
  expect(f.api.turns()).toHaveLength(2);
  expect(quote.hasAttribute('data-clf-fiber-turn')).toBe(false);
});
it('discovers both native versions, selects exact worker lanes and restores the original setting', async () => {
  const f = fixture();
  const original = await f.ask('clf-picker-ask'); expect(original.picker.currentBucket).toBe(1);
  const models = await f.api.inspectModelSettings(); expect(models).toHaveLength(3);
  expect(models.map((m: any) => m.id)).toEqual(['gpt-5-6-thinking', 'future-thinking', 'future-pro']);
  expect(await f.api.selectModelSettings('future-pro', 'pro')).toBe(true);
  expect(f.api.visibleModelSelection()).toEqual({ model: 'future-pro', reasoningEffort: 'pro' });
  expect(await f.api.selectModelSettings('future-pro', 'high')).toBe(false);
  expect(f.doc.querySelector('[data-model-picker-view]')).toBeNull();
  expect(f.api.visibleModelSelection()).toEqual({ model: 'future-pro', reasoningEffort: 'pro' });
});
it('publishes the observed Latest/5.6/5.5 shell catalog with GPT labels, Extra High and Pro lanes', async () => {
  // Shape observed on a signed-in Korean account (2026-09-27): bare version labels, `max`
  // as the Extra High step and Pro slugs carrying the request effort `medium`.
  const f = fixture();
  const power = (model: string, modelLabel: string, reasoningEffort: string, powerSettingIndex: number) => ({ model, modelLabel, reasoningEffort, powerSettingIndex });
  const thinking = (label: string, slug: string, instant: string) => [power(instant, label, 'none', 0),
    power(`${slug}-thinking`, label, 'medium', 1), power(`${slug}-thinking`, label, 'high', 2), power(`${slug}-thinking`, label, 'max', 3)];
  f.versions.splice(0, f.versions.length, { id: 'latest', label: '최신', selected: true },
    { id: '5.6', label: 'GPT-5.6 Sol', selected: false }, { id: '5.5', label: 'GPT-5.5', selected: false });
  f.selections.splice(0, f.selections.length,
    [...thinking('5.6', 'gpt-5-6', 'gpt-5-6'), power('gpt-6-pro', '6', 'medium', 4)],
    [...thinking('5.6', 'gpt-5-6', 'gpt-5-6'), power('gpt-5-6-pro', '5.6', 'medium', 4)],
    [...thinking('5.5', 'gpt-5-5', 'gpt-5-5-instant'), power('gpt-5-5-pro', '5.5', 'medium', 4)]);
  f.props.powerSelections = f.selections[0]; f.props.selectedLabelCandidate = f.selections[0]![1]; f.props.selectedPowerSelection = null;
  expect((await f.ask('clf-picker-ask')).picker.currentBucket).toBe(1);
  // Version-owned powers form the version family (classic modelVersion); Latest does not.
  const models = await f.api.inspectModelSettings();
  expect(models.map((m: any) => [m.id, m.label, m.efforts, m.aliases])).toEqual([
    ['5.6', 'GPT-5.6 Sol', ['none', 'medium', 'high', 'xhigh', 'pro'], ['gpt-5-6', 'gpt-5-6-thinking', 'gpt-5-6-pro']],
    ['gpt-6-pro', 'GPT-6', ['pro'], ['gpt-6-pro']],
    ['5.5', 'GPT-5.5', ['none', 'medium', 'high', 'xhigh', 'pro'], ['gpt-5-5-instant', 'gpt-5-5-thinking', 'gpt-5-5-pro']]]);
  expect(f.api.visibleModelSelection()).toEqual({ model: 'gpt-5-6-thinking', reasoningEffort: 'medium' });
  expect(await f.api.selectModelSettings('gpt-6-pro', 'pro')).toBe(true);
  expect(f.api.visibleModelSelection()).toEqual({ model: 'gpt-6-pro', reasoningEffort: 'pro' });
  expect(await f.api.selectModelSettings('5.6', 'pro')).toBe(true);
  expect(f.api.visibleModelSelection()).toEqual({ model: 'gpt-5-6-pro', reasoningEffort: 'pro' });
  expect(await f.api.selectModelSettings('gpt-5-6-thinking', 'xhigh')).toBe(true);
  expect(f.api.visibleModelSelection()).toEqual({ model: 'gpt-5-6-thinking', reasoningEffort: 'xhigh' });
  // A request effort is not a Pro lane on a non-Pro slug, and `max` beside a native `xhigh` stays Max.
  f.selections[0]!.push(power('gpt-5-6-thinking', '5.6', 'xhigh', 5));
  f.props.powerSelections = f.selections[0];
  const efforts = (await f.ask('clf-picker-ask')).picker.choices.map((c: any) => c.effort);
  expect(efforts).toEqual(['none', 'medium', 'high', 'max', 'pro', 'xhigh']);
});
it.each([false, true])('rechecks the cold shell picker owner when its account state hydrates (cancelled=%s)', async cancelled => {
  const f = fixture(), options = f.props.modelListConfig;
  f.props.modelListConfig = null;
  const edit = editing(f); edit.box.textContent = 'Preserve this existing draft';
  const missing = firstMissingPicker(f);
  let current = true;
  const result = f.api.selectModelSettings('gpt-5-6-thinking', 'high', () => current);
  await missing;
  current = !cancelled;
  f.props.modelListConfig = options;
  f.trigger.setAttribute('data-state', 'closed');
  expect(await result).toBe(!cancelled);
  expect(edit.box.textContent).toBe('Preserve this existing draft');
  expect(f.doc.querySelector('[data-model-picker-view]')).toBeNull();
  if (cancelled) expect(f.actions).not.toHaveBeenCalled();
});
it.each(['duplicate-version', 'duplicate-bucket', 'contradictory-selection', 'unknown-effort', 'disabled'])('rejects unknown/ambiguous picker evidence: %s', async mode => {
  const f = fixture();
  if (mode === 'duplicate-version') f.versions[1]!.selected = true;
  if (mode === 'duplicate-bucket') f.selections[0]![1]!.powerSettingIndex = 1;
  if (mode === 'contradictory-selection') f.props.selectedPowerSelection = { ...f.selections[0]![0], powerSettingIndex: 99 };
  if (mode === 'unknown-effort') f.selections[0]![0]!.reasoningEffort = 'made-up';
  if (mode === 'disabled') f.props.modelSelectionDisabled = true;
  const picker = (await f.ask('clf-picker-ask')).picker;
  expect(mode === 'disabled' ? picker?.choices.some((c: any) => c.available) : picker).toBe(mode === 'disabled' ? false : null);
  expect(f.actions).not.toHaveBeenCalled();
});
it('records a native shell conversation and UUID tool origin through the real isolated recorder', async () => {
  const f = fixture(), win = f.win as any, sent: any[] = [];
  f.entry.turn.status = 'complete'; f.entry.turn.items[2].completed = true;
  let hook: any, runtime: any;
  win.CLF_TEST_HOOK = (value: any) => { hook = value; };
  win.setInterval = () => 0;
  win.chrome = { runtime: { id: 'shell-fixture', onMessage: { addListener(value: any) { runtime = value; }, removeListener() {} },
    sendMessage: async (message: any) => {
      sent.push(message);
      if (message.type === 'status') return { connected: true, paired: true, pending: 0 };
      if (message.type === 'activity') return { ok: true, data: { entries: [], stream: [] } };
      if (message.type === 'correlate') return { ok: true, data: { conversationId: THREAD, confirmed: message.calls.map((call: any) => call.requestId) } };
      return { ok: true, pending: 0, durable: true };
    } }, storage: { onChanged: { addListener() {}, removeListener() {} } } };
  win.eval(contentSource);
  await vi.waitFor(() => expect(hook).toBeTruthy());
  await hook.refreshFiber(); await hook.pullActivity(); hook.observe(); await hook.flush();
  const events = () => sent.filter(m => m.type === 'events').flatMap(m => m.entries.map((entry: any) => entry.event));
  await vi.waitFor(() => {
    expect(events()).toContainEqual(expect.objectContaining({ kind: 'user_message', messageId: USER, text: 'hello' }));
    expect(events()).toContainEqual(expect.objectContaining({ kind: 'assistant_message', providerMessageId: ANSWER, text: 'Answer', final: true }));
    expect(events()).toContainEqual(expect.objectContaining({ kind: 'tool_evidence', calls: expect.arrayContaining([expect.objectContaining({ messageId: CALL, tool: 'read', answered: false })]) }));
  });
  win.postMessage({ type: 'cos-request-origin', conversationId: THREAD, requestIds: [OTHER], observedAt: Date.now() }, win.location.origin);
  await vi.waitFor(() => expect(sent.some(m => m.type === 'correlate' && JSON.stringify(m).includes(OTHER))).toBe(true));
  const catalog = await new Promise(resolve => runtime({ type: 'clf-model-catalog', nonce: OTHER, expiresAt: Date.now() + 10000 }, {}, resolve));
  expect(catalog).toEqual({ ok: true });
  expect(sent.find(m => m.type === 'model_catalog')?.models).toHaveLength(3);
  hook.setRenderStream(true); hook.renderStreams();
  expect(f.doc.querySelector('[data-turn-key] .clf-stream')).toBeNull();
  expect(JSON.stringify(events())).not.toContain('NEVER_COPY_TOOL_ARGS');
  win.__CLF_CONTENT_RECORDER__.stop();
});
