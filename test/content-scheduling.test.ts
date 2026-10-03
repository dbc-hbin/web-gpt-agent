import { readFileSync } from 'node:fs';
import vm from 'node:vm';
import { JSDOM } from 'jsdom';
import { afterEach, expect, it, vi } from 'vitest';

const source = readFileSync(new URL('../extension/content.js', import.meta.url), 'utf8');
const domSource = readFileSync(new URL('../extension/chatgpt-dom.js', import.meta.url), 'utf8');
const scheduler = source.slice(source.indexOf('  function activityPullDelay('), source.indexOf('  // Re-attach immediately when React swaps the composer'));
const adoption = source.slice(source.indexOf('  function adoptOpenTurn('), source.indexOf('  /**\n   * The question the adopted turn'));
const opening = source.slice(source.indexOf('    if (newUserMessage && !generating) {'), source.indexOf('    // Which generation an error first came into view'));
const transcript = source.slice(source.indexOf('  function watchTranscript('), source.indexOf('  const TURN_SECTION = CLF_DOM.TURN_SELECTOR;'));
const finalizing = source.slice(source.indexOf('  function finishGeneration('), source.indexOf('  function observe()'));
const navigation = source.slice(source.indexOf('  function observe()'), source.indexOf('    flushStreamRequestOrigins();')) + '\n}';
const reset = source.slice(source.indexOf('  function retireVisible('), source.indexOf('  const stoppedAppCommands'));
const fiberRequest = source.slice(source.indexOf('  function askFiber()'), source.indexOf('  /**\n   * Refreshes the cache.'));
const fiberCapture = source.slice(source.indexOf('  async function confirmLiveRequestOwners('), source.indexOf('  /** What the page says about this block'));
const fiberRead = source.slice(source.indexOf('  function readTurnCalls('), source.indexOf('  const nativeImageKey'));
const fiberConstants = source.slice(source.indexOf('  const FIBER_VERSION'), source.indexOf('  /** Descriptors from the last successful scan'));
let page: JSDOM | undefined;
afterEach(() => { page?.window.close(); page = undefined; vi.useRealTimers(); });

it.each([10_000, 30_000])('brings an accepted opening/adoption ahead of the %ims idle deadline', async delay => {
  vi.useFakeTimers();
  const pull = vi.fn(async () => undefined);
  const context = vm.createContext({ TEST_MODE: false, generating: false, activityTimer: null,
    later: setTimeout, cancelLater: clearTimeout, recorderHandle: { healthy: () => true }, pullActivity: pull,
    document: { visibilityState: 'visible' }, LIVE_ACTIVITY_MS: 750, ACTIVITY_MS: 2000,
    IDLE_ACTIVITY_MS: 10_000, HIDDEN_ACTIVITY_MS: 30_000, nativeBusy: false, job: null,
    pendingTools: 0, goalDraft: null, goalPhase: '', presentationPending: () => false,
    seedResumeBaseline: () => undefined, anchorAdoptedQuestion: () => undefined, userStopped: false,
    turnId: null, baselineSections: [], baselineMarks: [], noteTurnProgress: () => undefined,
    turnProgressRevision: 1, bindResumeGoalTurn: () => undefined, openedUserMessageId: null,
    newUserMessage: 'accepted-question', genCount: 0, RUN_ID: 'document', epoch: 1, submission: null,
    emit: vi.fn(), Date, WeakSet
  });
  vm.runInContext(`${scheduler}\n${adoption}`, context);
  for (const boundary of ['adoptOpenTurn("exact-local-turn", "accepted-question")', opening]) {
    context.generating = false;
    vm.runInContext(`scheduleActivityPull(${delay});\n${boundary}`, context);
    const before = pull.mock.calls.length;
    await vi.advanceTimersByTimeAsync(0);
    expect(pull).toHaveBeenCalledTimes(before + 1);
    expect(context.generating).toBe(true);
    vm.runInContext('cancelLater(activityTimer); activityTimer = null;', context);
  }
});

it('can adopt during startup before the scheduler declaration site', () => {
  const stateAt = source.indexOf('  let generating = false;');
  const earlyState = source.slice(stateAt, source.indexOf('  /**', stateAt));
  const context = vm.createContext({ TEST_MODE: false, later: vi.fn(() => 1), cancelLater: vi.fn(),
    userStopped: false, turnId: null, seedResumeBaseline: () => undefined, anchorAdoptedQuestion: () => undefined,
    baselineSections: [], baselineMarks: [], noteTurnProgress: () => undefined,
    turnProgressRevision: 0, bindResumeGoalTurn: () => undefined, Date, WeakSet
  });
  vm.runInContext(`${earlyState}\n${adoption}\nadoptOpenTurn('startup-turn');\n${scheduler}`, context);
  expect(context.later).toHaveBeenCalledWith(expect.any(Function), 0);
});

interface ObserverRecord {
  type: string;
  target: Node;
  addedNodes?: Node[];
  removedNodes?: Node[];
}
function observerFixture(hidden = false) {
  vi.useFakeTimers();
  page = new JSDOM('<main><section data-testid="conversation-turn-1"><div class="markdown">Final</div></section></main><form><div id="prompt-textarea" contenteditable="true"></div><button data-testid="stop-button">Stop</button></form>',
    { url: 'https://chatgpt.com/c/aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee', runScripts: 'outside-only' });
  const win = page.window, doc = win.document;
  Object.defineProperty(doc, 'visibilityState', { value: hidden ? 'hidden' : 'visible' });
  Object.defineProperty(win.HTMLElement.prototype, 'getClientRects', { value: () => [{}] });
  win.eval(domSource);
  let delivery: (records: ObserverRecord[]) => void = () => { throw new Error('observer not attached'); };
  class Observer {
    constructor(callback: (records: ObserverRecord[]) => void) { delivery = callback; }
    observe() {}
    disconnect() {}
  }
  const observe = vi.fn(), refresh = vi.fn(async (_owner: unknown) => true);
  const context = vm.createContext({ document: doc, MutationObserver: Observer, setTimeout, clearTimeout,
    recorderHandle: { healthy: () => true }, sameChat: () => true, alive: true, generating: true,
    CLF_DOM: Reflect.get(win, 'CLF_DOM'), TURN_SECTION: 'section[data-testid^="conversation-turn"]',
    TRANSCRIPT_OBSERVE_MS: 250, fiberSettled: null, fiberSettleUntil: 0, epoch: 1,
    observe, refreshFiber: refresh, rememberCleanup: () => undefined, renderStreams: vi.fn(), Promise, Date
  });
  vm.runInContext(`${transcript}\nwatchTranscript();`, context);
  return { doc, context, observe, refresh, deliver: (records: ObserverRecord[]) => delivery(records) };
}

it.each(['removed', 'relabelled', 'hidden', 'styled'])('ignores 100 own deliveries but admits the neighboring genuine composer Stop %s', async change => {
  const h = observerFixture(true), section = h.doc.querySelector('section')!, stop = h.doc.querySelector('button')!;
  // The native Stop is already absent while our local turn is still open.
  stop.remove();
  const own = h.doc.createElement('div'); own.className = 'clf-stream'; section.append(own);
  for (let at = 0; at < 100; at++) {
    h.deliver([{ type: 'childList', target: section, addedNodes: [own] }]);
    h.deliver([{ type: 'characterData', target: own.appendChild(h.doc.createTextNode('presentation')) }]);
    await Promise.resolve();
  }
  expect(h.observe).not.toHaveBeenCalled();
  const composer = h.doc.querySelector('form')!; composer.append(stop);
  if (change === 'removed') stop.remove();
  if (change === 'relabelled') stop.setAttribute('data-testid', 'send-button');
  if (change === 'hidden') stop.setAttribute('aria-hidden', 'true');
  if (change === 'styled') (stop as HTMLElement).style.display = 'none';
  h.deliver([change === 'removed' ? { type: 'childList', target: composer, removedNodes: [stop] }
    : { type: 'attributes', target: stop }]);
  await Promise.resolve();
  expect(h.observe).toHaveBeenCalledTimes(1);
  expect(vi.getTimerCount()).toBe(0);
});

it.each(['nested', 'direct'])('ignores the bootstrap wrapper/header but admits its moved native %s body', async mode => {
  const h = observerFixture(true), section = h.doc.querySelector('section')!;
  h.doc.querySelector('button')!.remove();
  const native = mode === 'nested' ? h.doc.querySelector('.markdown')! : h.doc.createTextNode('Native bootstrap text');
  const text = native.nodeType === 3 ? native : native.firstChild!;
  const fold = h.doc.createElement('details'); fold.className = 'clf-boot';
  const header = h.doc.createElement('summary'); header.className = 'clf-boot-head';
  header.textContent = 'App handoff label'; fold.append(header, native); section.append(fold);
  h.deliver([{ type: 'childList', target: section, addedNodes: [fold] },
    { type: 'characterData', target: header.firstChild! }]);
  await Promise.resolve();
  expect(h.observe).not.toHaveBeenCalled();
  text.textContent = 'Native bootstrap text revision';
  h.deliver([{ type: 'characterData', target: text }]);
  await Promise.resolve();
  expect(h.observe).toHaveBeenCalledTimes(1);
});

it('debounces settled visible-tab deliveries into one exact final capture', async () => {
  const h = observerFixture(), owner = { localTurnId: 'settled-exact' };
  h.context.generating = false; h.context.fiberSettled = owner;
  const text = h.doc.querySelector('.markdown')!.firstChild!;
  for (let at = 0; at < 100; at++) {
    text.textContent = `final revision ${at}`;
    h.deliver([{ type: 'characterData', target: text }]);
    await Promise.resolve();
  }
  expect(h.observe).not.toHaveBeenCalled(); expect(h.refresh).not.toHaveBeenCalled();
  await vi.advanceTimersByTimeAsync(249);
  expect(h.observe).not.toHaveBeenCalled();
  await vi.advanceTimersByTimeAsync(1);
  expect(h.observe).toHaveBeenCalledTimes(1); expect(h.refresh).toHaveBeenCalledExactlyOnceWith(owner);
});

it.each([false, true])('coalesces hidden settled revisions without carrying dirty work across epochs (epoch changed=%s)', async epochChanged => {
  const h = observerFixture(true), owner = { localTurnId: 'settled-exact' };
  h.context.generating = false; h.context.fiberSettled = owner;
  const work = Promise.withResolvers<boolean>();
  h.refresh.mockImplementationOnce(() => work.promise);
  const text = h.doc.querySelector('.markdown')!.firstChild!;
  h.deliver([{ type: 'characterData', target: text }]);
  await Promise.resolve();
  expect(h.refresh).toHaveBeenCalledTimes(1);
  for (let at = 0; at < 100; at++) {
    text.textContent = `complete final revision ${at}`;
    h.deliver([{ type: 'characterData', target: text }]);
    await Promise.resolve();
  }
  expect(h.observe).toHaveBeenCalledTimes(1); expect(h.refresh).toHaveBeenCalledTimes(1);
  if (epochChanged) h.context.epoch++;
  work.resolve(true);
  for (let at = 0; at < 5; at++) await Promise.resolve();
  expect(h.refresh).toHaveBeenCalledTimes(epochChanged ? 1 : 2);
  expect(h.refresh.mock.calls.every(([captured]) => captured === owner)).toBe(true);
  expect(vi.getTimerCount()).toBe(0);
});

it('preempts an older capture for a terminal edge without clearing the successor capture', async () => {
  const h = observerFixture(true), owner = { localTurnId: 'older-settled' };
  h.context.generating = false; h.context.fiberSettled = owner;
  const work = Promise.withResolvers<boolean>();
  h.refresh.mockImplementationOnce(() => work.promise);
  h.deliver([{ type: 'characterData', target: h.doc.querySelector('.markdown')!.firstChild! }]);
  await Promise.resolve();
  expect(h.observe).toHaveBeenCalledTimes(1);
  h.context.generating = true; h.context.fiberSettled = null;
  const stop = h.doc.querySelector('button')!, composer = stop.parentNode!; stop.remove();
  h.deliver([{ type: 'childList', target: composer, removedNodes: [stop] }]);
  await Promise.resolve();
  expect(h.observe).toHaveBeenCalledTimes(2);
  const successor = { localTurnId: 'newer-settled' }, nextWork = Promise.withResolvers<boolean>();
  h.context.generating = false; h.context.fiberSettled = successor;
  h.refresh.mockImplementationOnce(() => nextWork.promise);
  const text = h.doc.querySelector('.markdown')!.firstChild!;
  h.deliver([{ type: 'characterData', target: text }]);
  await Promise.resolve();
  expect(h.refresh.mock.calls.map(([captured]) => captured)).toEqual([owner, successor]);
  work.resolve(true);
  for (let at = 0; at < 5; at++) await Promise.resolve();
  text.textContent = 'newer final revision';
  h.deliver([{ type: 'characterData', target: text }]);
  for (let at = 0; at < 5; at++) await Promise.resolve();
  expect(h.refresh).toHaveBeenCalledTimes(2);
  nextWork.resolve(true);
  for (let at = 0; at < 5; at++) await Promise.resolve();
  expect(h.refresh.mock.calls.map(([captured]) => captured)).toEqual([owner, successor, successor]);
  expect(vi.getTimerCount()).toBe(0);
});

it('captures the next settled turn final while the previous hidden capture is pending', async () => {
  vi.useFakeTimers();
  page = new JSDOM('<main><section data-testid="conversation-turn-1"><div class="markdown">A final</div></section><section data-testid="conversation-turn-2"><div class="markdown">B initial</div></section></main><form><div id="prompt-textarea" contenteditable="true"></div></form>',
    { url: 'https://chatgpt.com/c/aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee', runScripts: 'outside-only' });
  const win = page.window, doc = win.document;
  Object.defineProperty(doc, 'visibilityState', { value: 'hidden' });
  win.eval(domSource);
  const work = Promise.withResolvers<boolean>();
  const captures: Array<{ owner: string; text: string | null }> = [];
  const context = vm.createContext({ document: doc, MutationObserver: win.MutationObserver, setTimeout, clearTimeout,
    recorderHandle: { healthy: () => true }, sameChat: () => true, alive: true, generating: false,
    CLF_DOM: Reflect.get(win, 'CLF_DOM'), TURN_SECTION: 'section[data-testid^="conversation-turn"]',
    TRANSCRIPT_OBSERVE_MS: 250, fiberSettled: { localTurnId: 'A' }, fiberSettleUntil: 0, epoch: 1,
    observe: vi.fn(), refreshFiber(owner: { localTurnId: string }) {
      captures.push({ owner: owner.localTurnId, text: doc.querySelector(owner.localTurnId === 'A'
        ? '[data-testid="conversation-turn-1"] .markdown' : '[data-testid="conversation-turn-2"] .markdown')!.textContent });
      return owner.localTurnId === 'A' ? work.promise : Promise.resolve(true);
    }, rememberCleanup: () => undefined, renderStreams: vi.fn(), Promise, Date, turnId: 'A',
    quietSince: 0, quietTurn: null, quietOutcome: null, settledGenerations: new WeakMap(), sectionMark: () => '',
    NATIVE_TERMINAL_REASONS: new Set(), STALL_MS: 600_000, FIBER_SETTLE_MS: 90_000,
    emit: vi.fn(), noteGoalTurn: vi.fn(), turnStartedAt: 0, unwitnessedGeneration: false, genNode: null
  });
  vm.runInContext(`${transcript}\n${finalizing}\nwatchTranscript();`, context);
  doc.querySelector('[data-testid="conversation-turn-1"] .markdown')!.firstChild!.textContent = 'A hydrated';
  for (let at = 0; at < 12; at++) await Promise.resolve();
  expect(captures).toEqual([{ owner: 'A', text: 'A hydrated' }]);
  context.generating = true; context.turnId = 'B'; context.fiberSettled = null;
  vm.runInContext('finishGeneration({node:document.querySelector("[data-testid=conversation-turn-2]"),id:"B"},{outcome:"completed"});', context);
  for (let at = 0; at < 12; at++) await Promise.resolve();
  expect(captures).toEqual([{ owner: 'A', text: 'A hydrated' }, { owner: 'B', text: 'B initial' }]);
  doc.querySelector('[data-testid="conversation-turn-2"] .markdown')!.firstChild!.textContent = 'B complete';
  for (let at = 0; at < 12; at++) await Promise.resolve();
  expect(captures).toHaveLength(2);
  work.resolve(true);
  for (let at = 0; at < 12; at++) await Promise.resolve();
  expect(captures).toEqual([{ owner: 'A', text: 'A hydrated' }, { owner: 'B', text: 'B initial' },
    { owner: 'B', text: 'B complete' }]);
  expect(vi.getTimerCount()).toBe(0);
});

it('emits the latest settled final across A→B→A while old and successor captures overlap', async () => {
  vi.useFakeTimers();
  const chatA = 'aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee', chatB = 'bbbbbbbb-cccc-4ddd-8eee-ffffffffffff';
  const pageTurn = '11111111-2222-4333-8444-555555555555', messageId = '66666666-7777-4888-8999-aaaaaaaaaaaa';
  page = new JSDOM('<main><section data-testid="conversation-turn-1" data-turn-id="' + pageTurn + '"><div class="markdown">A initial</div></section></main><form><div id="prompt-textarea" contenteditable="true"></div></form>',
    { url: 'https://chatgpt.com/c/' + chatA, runScripts: 'outside-only' });
  const win = page.window, doc = win.document;
  Object.defineProperty(doc, 'visibilityState', { value: 'hidden' });
  win.eval(domSource);
  // The old final has a provisional provider thread; hold its ownership handshake.
  const oldCapture = Promise.withResolvers<{ ok: boolean }>();
  const emitted = vi.fn(), confirmation = vi.fn(() => oldCapture.promise);
  const requests: Array<{ reply: () => void }> = [];
  win.postMessage = (request: { nonce: string }) => {
    const text = doc.querySelector('.markdown')!.textContent;
    const data = { source: 'clf-fiber-reply', v: 18, nonce: request.nonce, scanToken: request.nonce, scanOk: true,
      rows: [], turns: [{ index: 0, turnId: pageTurn, conversationId: text?.startsWith('A ') ? chatB : chatA,
        requests: text?.startsWith('A ') ? [{ requestId: 'request-A' }] : [],
        endMessageId: messageId, messages: [{ messageId, rawMessageId: messageId, role: 'assistant', rawText: text }] }] };
    const reply = new win.MessageEvent('message', { data });
    Object.defineProperty(reply, 'source', { value: win });
    requests.push({ reply: () => win.dispatchEvent(reply) });
  };
  const context = vm.createContext({ document: doc, window: win, location: win.location,
    MutationObserver: win.MutationObserver, setTimeout, clearTimeout, Promise, Date,
    CLF_DOM: Reflect.get(win, 'CLF_DOM'), TURN_SECTION: 'section[data-testid^="conversation-turn"]',
    TRANSCRIPT_OBSERVE_MS: 250, recorderHandle: { healthy: () => true }, sameChat: () => true, alive: true,
    conversationId: chatA, epoch: 1, generating: false, fiberSettled: null, fiberSettleUntil: 0,
    fiberAsking: null, fiberRepairing: null, fiberRepairAt: -Infinity, fiberPresent: null, fiberScanToken: null,
    FIBER_ASK: 'clf-fiber-ask', FIBER_REPLY: 'clf-fiber-reply',
    cap: (value: unknown, limit: number) => typeof value === 'string' ? value.slice(0, limit) : '',
    stampedFiberTurn: () => null, markedAs: () => null, markedContinuationTurns: () => [],
    reconcileContinuationMarkers: () => null, settledTurnOwner: () => null,
    currentGenerationOwner: () => null, goalTerminalCandidate: () => false, notePresentation: () => false,
    completeDesktopDecision: () => undefined, publishDesktopDecisionPartial: () => undefined,
    userMessageSource: () => null, renderStreams: () => undefined, flush: () => undefined, emit: emitted,
    rememberCleanup: () => undefined, foldBootstrap: () => undefined, setGoalPhase: () => undefined,
    removeStagePanel: () => undefined, pullActivity: () => undefined,
    ask: (request: { type: string }) => request.type === 'correlate' ? confirmation() : Promise.resolve({ ok: true }),
    desktopProjectInput: null, traceStage: () => undefined, retireBoundProjectInput: () => undefined,
    commandAttempt: null, pendingObjectiveSend: null, pendingObjective: '', openedUserMessageId: null,
    pageViewChecks: [], observed: {}, settledGenerations: new WeakMap(), staleNodes: new WeakSet(),
    retiredMessages: new Set(), seenMessages: new Set(), seenTurns: new Set(),
    turnId: null, quietSince: 0, quietTurn: null, quietOutcome: null, sectionMark: () => '',
    NATIVE_TERMINAL_REASONS: new Set(), STALL_MS: 600_000, FIBER_SETTLE_MS: 90_000,
    noteGoalTurn: () => undefined, turnStartedAt: 0, unwitnessedGeneration: false, genNode: null
  });
  for (const key of ['fiberRows', 'fiberTurns', 'streamBySeq', 'streamRootsByKey', 'detailCache', 'detailInflight',
    'streamMessageSeq', 'userAnchorByMessage', 'streamRequestTurnOwners', 'pageToolsReported', 'nativeImagesReported',
    'nativeImageCaptures', 'nativeImageCaptureQueue', 'nativeImageCaptureActiveTasks', 'callsReported',
    'requestOwnersConfirmed', 'requestOwnersProven', 'pendingStreamOrigins', 'requestOwnerRetryAt',
    'requestOwnerAttempts', 'messagesReported', 'userAuthoredTimesReported']) context[key] = new Map();
  context.requestOwnersPending = new Set();
  vm.runInContext([fiberConstants, fiberRead, fiberRequest, fiberCapture, reset, navigation, finalizing, transcript,
    'turnId = "A"; finishGeneration(CLF_DOM.turns()[0], {outcome: "completed"}, false); watchTranscript();'].join('\n'), context);
  const text = doc.querySelector('.markdown')!.firstChild!;
  text.textContent = 'A held snapshot';
  for (let at = 0; at < 12; at++) await Promise.resolve();
  requests[0]!.reply();
  for (let at = 0; at < 12; at++) await Promise.resolve();
  expect(confirmation).toHaveBeenCalledTimes(1);
  for (const chat of [chatB, chatA]) {
    win.history.replaceState(null, '', '/c/' + chat);
    vm.runInContext('observe();', context);
  }
  expect(context.epoch).toBe(3);
  text.textContent = 'C initial';
  vm.runInContext('turnId = "C"; finishGeneration(CLF_DOM.turns()[0], {outcome: "completed"});', context);
  for (let at = 0; at < 12; at++) await Promise.resolve();
  requests[1]!.reply();
  for (let at = 0; at < 12; at++) await Promise.resolve();
  expect(emitted).toHaveBeenCalledWith(expect.objectContaining({ kind: 'assistant_message', turnId: 'C', text: 'C initial', final: true }));
  text.textContent = 'C intermediate';
  for (let at = 0; at < 12; at++) await Promise.resolve();
  // C must start even though A is held. Keep C's immutable intermediate snapshot pending.
  text.textContent = 'C complete';
  for (let at = 0; at < 12; at++) await Promise.resolve();
  text.textContent = 'C complete latest';
  for (let at = 0; at < 12; at++) await Promise.resolve();
  oldCapture.resolve({ ok: true });
  for (let at = 0; at < 12; at++) await Promise.resolve();
  expect(emitted.mock.calls.filter(([event]) => event.kind === 'assistant_message').map(([event]) => event.text)).toEqual(['C initial']);
  // Completing A must neither unlock C nor discard its latest trailing revision.
  requests[2]?.reply();
  for (let at = 0; at < 12; at++) await Promise.resolve();
  requests[3]?.reply();
  for (let at = 0; at < 12; at++) await Promise.resolve();
  expect(emitted.mock.calls.filter(([event]) => event.kind === 'assistant_message').map(([event]) =>
    ({ turnId: event.turnId, text: event.text, final: event.final }))).toEqual([
    { turnId: 'C', text: 'C initial', final: true }, { turnId: 'C', text: 'C intermediate', final: true },
    { turnId: 'C', text: 'C complete latest', final: true }
  ]);
  expect(requests).toHaveLength(4);
  await vi.advanceTimersByTimeAsync(1500);
  expect(vi.getTimerCount()).toBe(0);
});
