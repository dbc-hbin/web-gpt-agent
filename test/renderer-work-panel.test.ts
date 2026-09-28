import { JSDOM } from 'jsdom';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { createWorkPanel } from '../src/renderer/work-panel.js';
import { setLanguage, t } from '../src/renderer/i18n.js';
import type { WorkControllerBinding } from '../src/shared/work-continuity.js';
import type { WorkChange, WorkEvent, WorkPage, WorkReceipt, WorkStatus } from '../src/shared/work.js';

/**
 * The durable-work pane, exercised through the preload API it actually calls.
 *
 * These cases defend the claims the pane makes about truthfulness rather than its markup: a
 * blocked work is never shown as finished, a recovery in progress is not completion, an
 * operation whose outcome is unknown offers both human decisions exactly once, and a control
 * carries a request id so the ledger can deduplicate a retry.
 */

let dom: JSDOM;
let host: HTMLElement;
let toggle: HTMLButtonElement;
let changeListener: ((change: WorkChange) => void) | null;

const ok = <T>(data: T) => Promise.resolve({ ok: true as const, data });
const tick = async (): Promise<void> => {
  await Promise.resolve();
  await Promise.resolve();
  await vi.advanceTimersByTimeAsync(0);
};

const status = (overrides: Partial<WorkStatus> = {}): WorkStatus => ({
  work_id: '11111111-1111-4111-8111-111111111111',
  title: 'Fix the parser',
  goal: 'Fix the parser and run the fixture checks.',
  status: 'running',
  desired_state: null,
  project_path: '/tmp/fixture',
  project_name: 'fixture',
  integration_branch: 'wgpt/11111111/main',
  integration_worktree: '/tmp/worktrees/11111111/main',
  base_commit: 'abcdef0123456789',
  model: 'gpt-5.6-sol',
  reasoning: 'high',
  max_workers: 2,
  revision: 7,
  prime: {
    agent_id: '22222222-2222-4222-8222-222222222222',
    role: 'prime',
    label: 'Prime',
    state: 'active',
    session_id: 'session-prime',
    conversation_id: 'conversation-prime',
    generation: 1,
    worktree_path: '/tmp/worktrees/11111111/main',
    branch: 'wgpt/11111111/main',
    base_commit: 'abcdef0123456789',
    model: 'gpt-5.6-sol',
    reasoning: 'high',
    result_ref: null,
    checkpoint_ref: null,
    last_operation: null,
    recovery: null,
    created_at: 1,
    updated_at: 2
  },
  agents: [],
  predecessor_work_id: null,
  successor_work_id: null,
  blocker: null,
  checkpoint: null,
  recovery: null,
  operations: [],
  pending_commands: [],
  created_at: 1,
  updated_at: 2,
  ...overrides
});

const page = (works: WorkPage['works']): WorkPage => ({
  works,
  projects: [{ id: 'project-1', name: 'fixture', path: '/tmp/fixture' }],
  next_cursor: null
});

const summary = (overrides: Partial<WorkPage['works'][number]> = {}) => ({
  work_id: '11111111-1111-4111-8111-111111111111',
  title: 'Fix the parser',
  status: 'running' as const,
  desired_state: null,
  goal_preview: 'Fix the parser and run the fixture checks.',
  project_path: '/tmp/fixture',
  project_name: 'fixture',
  integration_branch: 'wgpt/11111111/main',
  integration_worktree: '/tmp/worktrees/11111111/main',
  base_commit: 'abcdef0123456789',
  revision: 7,
  max_workers: 2,
  agent_count: 1,
  prime_agent_id: '22222222-2222-4222-8222-222222222222',
  predecessor_work_id: null,
  successor_work_id: null,
  blocker: null,
  created_at: 1,
  updated_at: 2,
  ...overrides
});

const event = (overrides: Partial<WorkEvent> = {}): WorkEvent => ({
  work_id: '11111111-1111-4111-8111-111111111111',
  sequence: 1,
  kind: 'work_running',
  payload: { agent_id: '22222222-2222-4222-8222-222222222222' },
  at: 1,
  ...overrides
});

beforeEach(() => {
  vi.useFakeTimers();
  dom = new JSDOM('<body><section id="host"></section><button id="toggle"></button></body>', { url: 'https://local.test/' });
  vi.stubGlobal('window', dom.window);
  vi.stubGlobal('document', dom.window.document);
  vi.stubGlobal('HTMLElement', dom.window.HTMLElement);
  vi.stubGlobal('HTMLButtonElement', dom.window.HTMLButtonElement);
  host = document.getElementById('host')!;
  toggle = document.getElementById('toggle') as HTMLButtonElement;
  changeListener = null;
  Object.assign(dom.window, {
    api: {
      workList: vi.fn(() => ok(page([summary()]))),
      workStatus: vi.fn(() => ok(status())),
      workEvents: vi.fn(({ work_id, after = 0 }: { work_id: string; after?: number }) =>
        ok({ events: after < 1 ? [event({ work_id })] : [], next_cursor: Math.max(after, 1), has_more: false })),
      workStart: vi.fn(() => ok({ request_id: 'r', work_id: '11111111-1111-4111-8111-111111111111', status: 'queued', revision: 1 })),
      workInstruct: vi.fn(() => ok({ request_id: 'r', work_id: '11111111-1111-4111-8111-111111111111', status: 'running', revision: 8 })),
      workControl: vi.fn(() => ok({ request_id: 'r', work_id: '11111111-1111-4111-8111-111111111111', status: 'paused', revision: 9 })),
      workReveal: vi.fn(() => ok(true)),
      workControllerGet: vi.fn(() => ok(null)),
      workControllerSet: vi.fn(() => ok(null)),
      onWorkChanged: vi.fn((listener: (change: WorkChange) => void) => {
        changeListener = listener;
        return () => { if (changeListener === listener) changeListener = null; };
      })
    }
  });
});

afterEach(() => {
  // The i18n module is process-wide state; a case that switches language must not leak it into
  // the next one, and a failing case must not either.
  setLanguage('en');
  dom.window.close();
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

const openPanel = async (options: { openChat?: (id: string) => void; currentSession?: () => string | null } = {}) => {
  const panel = createWorkPanel({
    host, toggle,
    openChat: options.openChat ?? vi.fn(),
    // Default: this window is not showing a recorded chat, which is what a fresh window looks like.
    currentSession: options.currentSession ?? (() => null)
  });
  toggle.click();
  await tick();
  return panel;
};

/** The binding shape the host answers with, for one chat and one work. */
const binding = (overrides: Partial<WorkControllerBinding> = {}): WorkControllerBinding => ({
  session_id: 'session-prime',
  conversation_id: 'conversation-prime',
  provider_account_id: null,
  work_id: '11111111-1111-4111-8111-111111111111',
  bound_at: 1,
  enabled: true,
  event_cursor: 0,
  updated_at: 2,
  origin: 'explicit',
  ...overrides
});

it('preserves all drafts and the focused selection through a ledger push and refused submission', async () => {
  vi.mocked(window.api.workStatus).mockImplementation(() => ok(status({ operations: [{
    operation_id: '33333333-3333-4333-8333-333333333333', agent_id: status().prime!.agent_id,
    tool: 'exec_command', state: 'outcome_unknown', result_ref: null, resolution: null,
    retry_operation_id: null, updated_at: 3
  }] })));
  await openPanel();
  const instruction = host.querySelector<HTMLTextAreaElement>('.work-form textarea')!;
  instruction.value = 'Keep this instruction';
  const audit = host.querySelector<HTMLInputElement>('.work-blocker.is-open input')!;
  audit.value = 'Verified the working tree';
  const toggleNew = [...host.querySelectorAll('button')].find(button => button.textContent === 'New work')!;
  toggleNew.click();
  const form = host.querySelector<HTMLFormElement>('.work-form')!;
  const fields = form.querySelectorAll<HTMLInputElement>('input[type="text"]');
  fields[0]!.value = '/tmp/another-project';
  fields[1]!.value = 'Unsent title';
  const goal = form.querySelector<HTMLTextAreaElement>('textarea')!;
  goal.value = '한국어 작업 초안';
  const workers = form.querySelector<HTMLInputElement>('input[type="number"]')!;
  workers.value = '5';
  goal.focus(); goal.setSelectionRange(1, 4);
  changeListener!({ work_id: status().work_id, revision: 8, status: 'running', kind: 'work_running' });
  await tick();
  expect(document.activeElement).toBe(goal);
  expect([goal.selectionStart, goal.selectionEnd]).toEqual([1, 4]);
  expect(goal.value).toBe('한국어 작업 초안');
  expect([fields[0]!.value, fields[1]!.value, workers.value]).toEqual(['/tmp/another-project', 'Unsent title', '5']);
  expect(audit.value).toBe('Verified the working tree');
  toggleNew.click();
  expect(host.querySelector<HTMLTextAreaElement>('.work-form textarea')!.value).toBe('Keep this instruction');
  vi.mocked(window.api.workInstruct).mockResolvedValueOnce({ ok: false, error: 'WORK_NOT_RUNNING' });
  instruction.form!.dispatchEvent(new dom.window.Event('submit', { bubbles: true, cancelable: true }));
  await tick();
  expect(instruction.value).toBe('Keep this instruction');
});

it.each(['accepted', 'refused'] as const)('keeps work B displayed and actionable after a late %s control reply for A', async outcome => {
  const a = status().work_id;
  const b = '99999999-9999-4999-8999-999999999999';
  vi.mocked(window.api.workList).mockImplementation(() => ok(page([summary(), summary({ work_id: b, title: 'Second work' })])));
  vi.mocked(window.api.workStatus).mockImplementation(({ work_id }) => ok(status({ work_id, title: work_id === b ? 'Second work' : 'Fix the parser' })));
  const pending = Promise.withResolvers<{ ok: true; data: WorkReceipt } | { ok: false; error: string }>();
  vi.mocked(window.api.workControl).mockImplementationOnce(() => pending.promise);
  await openPanel();
  [...host.querySelectorAll('button')].find(button => button.textContent === 'Pause')!.click();
  [...host.querySelectorAll<HTMLButtonElement>('.work-list-row')].find(button => button.textContent?.includes('Second work'))!.click();
  await tick();
  pending.resolve(outcome === 'accepted' ? { ok: true, data: { request_id: 'r', work_id: a, status: 'paused', revision: 9 } }
    : { ok: false, error: 'A_ONLY_FAILURE' });
  await tick();
  expect(host.querySelector('h2')!.textContent).toBe('Second work');
  expect(host.textContent).not.toContain('A_ONLY_FAILURE');
  const cancel = [...host.querySelectorAll('button')].find(button => button.textContent === 'Cancel')!;
  expect(cancel.disabled).toBe(false);
  cancel.click(); await tick();
  expect(vi.mocked(window.api.workControl).mock.calls.at(-1)?.[0]).toMatchObject({ work_id: b, action: 'cancel' });
});

it('follows event cursors and keeps the newest bounded activity window advancing', async () => {
  const ledger = Array.from({ length: 260 }, (_, index) => event({ sequence: index + 1, payload: { detail: `event-${index + 1}` } }));
  vi.mocked(window.api.workEvents).mockImplementation(({ after = 0, limit = 50 }) => {
    const remaining = ledger.filter(item => item.sequence > after);
    const events = remaining.slice(0, limit);
    return ok({ events, next_cursor: events.at(-1)?.sequence ?? after, has_more: remaining.length > events.length });
  });
  await openPanel();
  let feed = host.querySelector('.work-events')!;
  expect(feed.textContent).toContain('event-260');
  expect(feed.textContent).toContain('event-211');
  expect(feed.textContent).not.toContain('event-210');
  ledger.push(event({ sequence: 261, payload: { detail: 'event-261' } }));
  changeListener!({ work_id: status().work_id, revision: 8, status: 'running', kind: 'work_running' });
  await tick();
  feed = host.querySelector('.work-events')!;
  expect(feed.textContent).toContain('event-261');
  expect(feed.textContent).not.toContain('event-211');
});

it('shows the result location from admission and never invents completion from silence', async () => {
  const panel = await openPanel();
  expect(host.textContent).toContain('wgpt/11111111/main');
  expect(host.textContent).toContain('/tmp/worktrees/11111111/main');
  expect(host.textContent).not.toContain('Completed');

  // A recovering work is a wait state, not a success and not a failure.
  (window.api.workStatus as any).mockImplementation(() => ok(status({
    status: 'recovering',
    recovery: { agent_id: '22222222-2222-4222-8222-222222222222', generation: 1, phase: 'reloading', episodes: 1, attempts: 1, next_attempt_at: Date.now() + 60_000 }
  })));
  panel.hide();
  toggle.click();
  await tick();
  expect(host.textContent).toContain('Recovering');
  expect(host.textContent).toContain('Reloading');
  expect(host.textContent).not.toContain('Completed');
});

it('renders a blocker with its machine code and keeps the work visible as blocked', async () => {
  (window.api.workStatus as any).mockImplementation(() => ok(status({
    status: 'blocked',
    blocker: { code: 'RECOVERY_EXHAUSTED', detail: 'Three recovery episodes produced no forward progress.', at: Date.now() }
  })));
  await openPanel();
  expect(host.textContent).toContain('RECOVERY_EXHAUSTED');
  expect(host.textContent).toContain('Three recovery episodes produced no forward progress.');
  expect(host.textContent).toContain('Blocked');
  expect(host.textContent).not.toContain('Completed');
});

it('offers both decisions once for an unresolved unknown outcome and shows a recorded decision instead', async () => {
  const unresolved = {
    operation_id: '33333333-3333-4333-8333-333333333333',
    agent_id: '22222222-2222-4222-8222-222222222222',
    tool: 'exec_command',
    state: 'outcome_unknown' as const,
    result_ref: null,
    resolution: null,
    retry_operation_id: null,
    updated_at: 3
  };
  (window.api.workStatus as any).mockImplementation(() => ok(status({ operations: [unresolved] })));
  await openPanel();

  const accept = [...host.querySelectorAll('button')].find(button => button.textContent === 'Accept observed effects')!;
  const retry = [...host.querySelectorAll('button')].find(button => button.textContent === 'Authorize one retry')!;
  expect(accept).toBeDefined();
  expect(retry).toBeDefined();

  retry.click();
  await tick();
  const request = (window.api.workInstruct as any).mock.calls[0][0];
  expect(request.resolve_operations).toEqual([{
    operation_id: unresolved.operation_id,
    decision: 'authorize_retry',
    note: expect.any(String)
  }]);
  expect(request.resolve_operations[0].note.length).toBeGreaterThan(0);
  expect(request.request_id).toMatch(/^[0-9a-f-]{36}$/);

  // Once the ledger records the decision, the same operation stops offering a second one.
  (window.api.workStatus as any).mockImplementation(() => ok(status({
    operations: [{ ...unresolved, resolution: 'authorize_retry', retry_operation_id: '44444444-4444-4444-8444-444444444444' }]
  })));
  changeListener!({ work_id: status().work_id, revision: 10, status: 'running', kind: 'operation_resolved' });
  await tick();
  expect(host.textContent).toContain('One retry was authorized for this operation.');
  expect([...host.querySelectorAll('button')].some(button => button.textContent === 'Authorize one retry')).toBe(false);
});

it('carries a request id on every control and reports the accepted revision', async () => {
  const panel = await openPanel();
  const pause = [...host.querySelectorAll('button')].find(button => button.textContent === 'Pause')!;
  pause.click();
  await tick();
  const request = (window.api.workControl as any).mock.calls[0][0];
  expect(request.action).toBe('pause');
  expect(request.work_id).toBe(status().work_id);
  expect(request.request_id).toMatch(/^[0-9a-f-]{36}$/);
  expect(host.textContent).toContain('revision 9');
  panel.hide();
  expect(host.querySelector('.work-panel')!.hasAttribute('hidden')).toBe(true);
});

it('sends an instruction with a request id and never supplies a path for the result folder', async () => {
  await openPanel();
  const reveal = [...host.querySelectorAll('button')].find(button => button.textContent === 'Open result folder')!;
  reveal.click();
  await tick();
  expect((window.api.workReveal as any)).toHaveBeenCalledWith({ work_id: status().work_id });

  const field = host.querySelector<HTMLTextAreaElement>('.work-form textarea')!;
  field.value = 'Also update the changelog.';
  host.querySelector<HTMLFormElement>('.work-form')!.dispatchEvent(new dom.window.Event('submit', { bubbles: true, cancelable: true }));
  await tick();
  const request = (window.api.workInstruct as any).mock.calls[0][0];
  expect(request.text).toBe('Also update the changelog.');
  expect(request.request_id).toMatch(/^[0-9a-f-]{36}$/);
  expect(request.resolve_operations).toBeUndefined();
});

it('surfaces a refused control inline instead of losing it', async () => {
  (window.api.workControl as any).mockImplementation(() => Promise.resolve({ ok: false as const, error: 'WORK_ALREADY_COMPLETED: this work already completed.' }));
  await openPanel();
  [...host.querySelectorAll('button')].find(button => button.textContent === 'Pause')!.click();
  await tick();
  expect(host.textContent).toContain('WORK_ALREADY_COMPLETED');
});

it('opens the prime conversation through the recorded session id', async () => {
  const openChat = vi.fn();
  await openPanel({ openChat });
  [...host.querySelectorAll('button')].find(button => button.textContent === 'Open main chat')!.click();
  expect(openChat).toHaveBeenCalledWith('session-prime');
});

it('starts a work with the chosen project, goal and worker count', async () => {
  await openPanel();
  [...host.querySelectorAll('button')].find(button => button.textContent === 'New work')!.click();
  const form = host.querySelector<HTMLFormElement>('.work-form')!;
  form.querySelector<HTMLInputElement>('input[type="text"]')!.value = '/tmp/fixture';
  form.querySelector<HTMLTextAreaElement>('textarea')!.value = 'Split the refactor and integrate it.';
  form.querySelector<HTMLInputElement>('input[type="number"]')!.value = '4';
  form.dispatchEvent(new dom.window.Event('submit', { bubbles: true, cancelable: true }));
  await tick();
  const request = (window.api.workStart as any).mock.calls[0][0];
  expect(request.project_path).toBe('/tmp/fixture');
  expect(request.goal).toBe('Split the refactor and integrate it.');
  expect(request.max_workers).toBe(4);
  expect(request.request_id).toMatch(/^[0-9a-f-]{36}$/);
});

it('refetches only while the pane is open when the ledger reports a change', async () => {
  const panel = await openPanel();
  const before = (window.api.workList as any).mock.calls.length;
  changeListener!({ work_id: '99999999-9999-4999-8999-999999999999', revision: 4, status: 'running', kind: 'work_running' });
  await tick();
  expect((window.api.workList as any).mock.calls.length).toBe(before + 1);

  panel.hide();
  const hidden = (window.api.workList as any).mock.calls.length;
  changeListener!({ work_id: '99999999-9999-4999-8999-999999999999', revision: 5, status: 'running', kind: 'work_running' });
  await tick();
  expect((window.api.workList as any).mock.calls.length).toBe(hidden);
});

it('reports the host as unavailable rather than showing an empty list', async () => {
  (window.api.workList as any).mockImplementation(() => Promise.resolve({
    ok: false as const,
    error: 'HOST_UNAVAILABLE: the host has not started its work ledger yet.'
  }));
  await openPanel();
  expect(host.textContent).toContain('HOST_UNAVAILABLE');
  expect(host.textContent).not.toContain('No work yet');
});

/**
 * Labels the pane writes from ledger values are app copy: a language change has to re-read them
 * in place. Rebuilding the pane would do that, but it would also throw away the draft, the
 * selection and the focus the user has in the instruction box — so the bindings refresh the
 * existing nodes instead. Everything the ledger recorded (machine codes, tool names, paths and
 * the recorded blocker detail) is rendered verbatim and must survive the same change untouched.
 */
it('retranslates its own labels on a live language change without losing a draft, focus or machine values', async () => {
  const unresolved = {
    operation_id: '33333333-3333-4333-8333-333333333333',
    agent_id: '22222222-2222-4222-8222-222222222222',
    tool: 'exec_command',
    state: 'outcome_unknown' as const,
    result_ref: null,
    resolution: null,
    retry_operation_id: null,
    updated_at: 3
  };
  vi.mocked(window.api.workStatus).mockImplementation(() => ok(status({
    status: 'blocked',
    blocker: { code: 'RECOVERY_EXHAUSTED', detail: 'Three recovery episodes produced no forward progress.', at: Date.now() },
    operations: [unresolved]
  })));
  await openPanel();

  setLanguage('ko');
  const badgeText = (): string[] => [...host.querySelectorAll('.work-badge')].map(node => node.textContent ?? '');
  expect(t('Blocked')).not.toBe('Blocked');
  expect(badgeText()).toContain(t('Blocked'));
  expect(badgeText()).toContain(t('Running'));

  // A draft typed into the pane's own instruction box, with focus and selection, is exactly the
  // state a repaint-on-language-change would destroy.
  const field = host.querySelector<HTMLTextAreaElement>('.work-form textarea')!;
  const draft = '/review\n한국어 초안 🙂 <script>literal</script>';
  field.value = draft;
  field.focus();
  field.setSelectionRange(2, 8);
  expect([...host.querySelectorAll('button')].some(button => button.textContent === t('Accept observed effects'))).toBe(true);

  setLanguage('ja');
  expect(host.querySelector<HTMLTextAreaElement>('.work-form textarea')).toBe(field);
  expect(field.value).toBe(draft);
  expect([field.selectionStart, field.selectionEnd]).toEqual([2, 8]);
  expect(document.activeElement).toBe(field);
  expect(badgeText()).toContain(t('Blocked'));

  // Machine and user values stay verbatim through the change: the ledger's blocker code, the
  // tool name, the paths and the recorded blocker detail are not app copy.
  expect(host.textContent).toContain('RECOVERY_EXHAUSTED');
  expect(host.textContent).toContain('exec_command');
  expect(host.textContent).toContain('/tmp/worktrees/11111111/main');
  expect(host.textContent).toContain('Three recovery episodes produced no forward progress.');

  setLanguage('en');
  expect(badgeText()).toContain('Blocked');
  expect(host.querySelector<HTMLTextAreaElement>('.work-form textarea')).toBe(field);
  expect(field.value).toBe(draft);
});

/**
 * The push path can overlap: a list read and the selected work's detail read are both in flight,
 * and the ledger answers them out of order. What the user must end up looking at is the NEWEST
 * answer for each, never a stale one that happened to arrive last.
 *
 * This is asserted on the rendered pane — the row's revision and the detail's revision — because
 * that is what the user sees. A shared request counter used to let the older detail reply retire
 * the newer list reply, leaving the row showing a revision the ledger had already moved past.
 */
it('keeps the newest list and detail when the ledger answers out of order', async () => {
  const listReplies: Array<(value: unknown) => void> = [];
  (window.api.workList as any).mockImplementation(() => new Promise(resolve => { listReplies.push(resolve); }));
  const detailReplies: Array<(value: unknown) => void> = [];
  (window.api.workStatus as any).mockImplementation(() => new Promise(resolve => { detailReplies.push(resolve); }));
  (window.api.workEvents as any).mockImplementation(() => ok({ events: [], next_cursor: 0, has_more: false }));

  // Opening the pane is enough; the change listener the panel registers is what this case drives.
  await openPanel();
  expect(listReplies).toHaveLength(1);

  // The first list answer arrives and selects the work, which starts its detail read.
  listReplies[0]!(ok(page([summary({ revision: 3 })])));
  await tick();
  expect(detailReplies).toHaveLength(1);
  expect(host.textContent).toContain('revision 3');

  // A durable change arrives. The pane starts a new list read AND a new detail read for the
  // selected work, so two overlapping requests are now in flight.
  changeListener!({ work_id: '11111111-1111-4111-8111-111111111111', revision: 9, status: 'running', kind: 'work_running' });
  await tick();
  expect(listReplies).toHaveLength(2);

  // The newer list answer lands first and must survive: with one shared request counter this
  // reply was retired by the detail read that the same push had already started, leaving the
  // row frozen at revision 3.
  listReplies[1]!(ok(page([summary({ revision: 9 })])));
  await tick();
  expect(host.textContent).toContain('revision 9');

  // The stale detail answer then arrives; it must not drag the pane back.
  detailReplies[0]!(ok(status({ revision: 3 })));
  await tick();
  expect(host.textContent).toContain('revision 9');
  expect(host.textContent).not.toContain('revision 3');

  // The newest detail answer owns the detail area.
  expect(detailReplies.length).toBeGreaterThanOrEqual(2);
  detailReplies.at(-1)!(ok(status({ revision: 9 })));
  await tick();
  expect(host.textContent).toContain('revision 9');
  expect(host.textContent).not.toContain('revision 3');
});

/**
 * The connection section states one fact the user cannot check anywhere else: whether the chat
 * this window is *displaying* is the conversation that drives the selected work. These cases pin
 * that down through the pane's real controls, including the two answers that are easy to fake —
 * "not connected" and "the host has not answered yet" — and the copy that separates stopping the
 * relay from stopping the work.
 */

it('says no chat is open instead of offering a connection for a conversation it cannot name', async () => {
  await openPanel();
  expect(host.textContent).toContain('Chat connection');
  expect(host.textContent).toContain(t('No chat is open in this window. Open the chat this work should be driven from, then connect it here.'));
  // Nothing is claimed about a conversation this window cannot see, and no control is offered.
  expect(host.textContent).not.toContain(t('Not connected'));
  expect([...host.querySelectorAll('button')].some(button => button.textContent === t('Connect this chat'))).toBe(false);
  // No chat means no pair to ask about: the pane must not invent one from the work's prime agent.
  expect(window.api.workControllerGet).not.toHaveBeenCalled();
});

it('connects the displayed chat to the selected work and states what that authorizes', async () => {
  await openPanel({ currentSession: () => 'session-prime' });
  expect(window.api.workControllerGet).toHaveBeenCalledWith({ session_id: 'session-prime' });
  expect(host.textContent).toContain(t('Not connected'));
  // The copy separates the relay from the work, in both directions.
  expect(host.textContent).toContain(t('New messages in this chat are relayed to this work while it is connected. Disconnecting stops new automatic relay and report delivery; it does not cancel the work.'));

  const connect = [...host.querySelectorAll('button')].find(button => button.textContent === t('Connect this chat'))!;
  connect.click();
  await tick();
  const request = (window.api.workControllerSet as any).mock.calls[0][0];
  expect(request).toEqual({
    session_id: 'session-prime',
    work_id: status().work_id,
    enabled: true
  });
});

it('shows the connection the host reports and keeps a refusal from reading as connected', async () => {
  vi.mocked(window.api.workControllerGet).mockImplementation(() => ok(binding()));
  await openPanel({ currentSession: () => 'session-prime' });
  expect(host.textContent).toContain(t('Connected'));
  expect(host.textContent).toContain('conversation-prime');
  expect(host.textContent).toContain(t('Connected work'));

  // A refused press is shown where every other refusal is, and the pane keeps saying "not
  // connected" rather than pretending the connection was made.
  vi.mocked(window.api.workControllerSet).mockImplementation(() =>
    Promise.resolve({ ok: false as const, error: 'STATE_UNAVAILABLE: the continuity state is not restored yet.' }));
  const off = [...host.querySelectorAll('button')].find(button => button.textContent === t('Disconnect this chat'))!;
  off.click();
  await tick();
  expect(host.textContent).toContain('STATE_UNAVAILABLE');
});

it('disconnects the displayed chat without cancelling the work', async () => {
  vi.mocked(window.api.workControllerGet).mockImplementation(() => ok(binding()));
  vi.mocked(window.api.workControllerSet).mockImplementation(() => ok(binding({ enabled: false, updated_at: 9 })));
  await openPanel({ currentSession: () => 'session-prime' });
  const off = [...host.querySelectorAll('button')].find(button => button.textContent === t('Disconnect this chat'))!;
  off.click();
  await tick();
  expect((window.api.workControllerSet as any).mock.calls[0][0]).toEqual({
    session_id: 'session-prime', work_id: status().work_id, enabled: false
  });
  expect(host.textContent).toContain(t('Disconnected. Automatic relay and report delivery are stopped for this chat.'));
  expect(host.textContent).toContain(t('Not connected'));
  // Disconnecting is not a work control: nothing was paused, resumed or cancelled.
  expect(window.api.workControl).not.toHaveBeenCalled();
});

it('names the other work when the displayed chat drives something else, and releases it there', async () => {
  const owner = '99999999-9999-4999-8999-999999999999';
  vi.mocked(window.api.workControllerGet).mockImplementation(() => ok(binding({ work_id: owner })));
  vi.mocked(window.api.workControllerSet).mockImplementation(() => ok(binding({ work_id: owner, enabled: false })));
  await openPanel({ currentSession: () => 'session-prime' });
  expect(host.textContent).toContain(t('Connected to another work'));
  expect(host.textContent).not.toContain(t('Connect this chat'));
  // The relay sentence must not claim this work is being driven by a chat that drives another.
  expect(host.textContent).toContain(t('This chat is connected to another work, so its messages are not relayed here. Disconnect it there to connect it to this work.'));

  const release = [...host.querySelectorAll('button')].find(button => button.textContent === t('Disconnect this chat'))!;
  release.click();
  await tick();
  // The release targets the work the chat actually drives — not the work on screen.
  expect((window.api.workControllerSet as any).mock.calls[0][0]).toEqual({
    session_id: 'session-prime', work_id: owner, enabled: false
  });
  // The user stays where they were: the note is about the chat, not a reason to navigate.
  expect(host.querySelector('h2')!.textContent).toBe('Fix the parser');
});

it('keeps the displayed chat’s answer when the host answers an earlier chat late', async () => {
  const first = Promise.withResolvers<{ ok: true; data: WorkControllerBinding | null }>();
  let session = 'session-a';
  vi.mocked(window.api.workControllerGet).mockImplementation(() => first.promise);
  const panel = await openPanel({ currentSession: () => session });
  expect(window.api.workControllerGet).toHaveBeenCalledWith({ session_id: 'session-a' });

  // The user switches to another chat, and its answer arrives first.
  session = 'session-b';
  vi.mocked(window.api.workControllerGet).mockImplementation(() => ok(binding({ session_id: 'session-b' })));
  panel.sync();
  await tick();
  expect(window.api.workControllerGet).toHaveBeenLastCalledWith({ session_id: 'session-b' });
  expect(host.textContent).toContain(t('Connected'));

  // The earlier chat's answer then lands. It is not an answer about this chat.
  first.resolve(ok(null));
  await tick();
  expect(host.textContent).toContain(t('Connected'));
  expect(host.textContent).not.toContain(t('Connect this chat'));
});

it('re-reads the connection when the ledger reports a binding change for this chat', async () => {
  await openPanel({ currentSession: () => 'session-prime' });
  const before = (window.api.workControllerGet as any).mock.calls.length;
  vi.mocked(window.api.workControllerGet).mockImplementation(() => ok(binding()));
  changeListener!({ work_id: status().work_id, revision: 11, status: 'running', kind: 'controller_binding_changed' });
  await tick();
  expect((window.api.workControllerGet as any).mock.calls.length).toBeGreaterThan(before);
  expect(host.textContent).toContain(t('Connected'));
});

it('re-asks the connection after the pane is closed and reopened', async () => {
  const panel = await openPanel({ currentSession: () => 'session-prime' });
  const before = (window.api.workControllerGet as any).mock.calls.length;
  panel.hide();
  vi.mocked(window.api.workControllerGet).mockImplementation(() => ok(binding()));
  toggle.click();
  await tick();
  expect((window.api.workControllerGet as any).mock.calls.length).toBeGreaterThan(before);
  expect(host.textContent).toContain(t('Connected'));
});

it('re-asks a refused connection read when the user refreshes', async () => {
  vi.mocked(window.api.workControllerGet).mockImplementation(() =>
    Promise.resolve({ ok: false as const, error: 'HOST_UNAVAILABLE: the ledger is not open.' }));
  await openPanel({ currentSession: () => 'session-prime' });
  // A refused read is not an answer of "not connected": the pane says it does not know.
  expect(host.textContent).toContain(t('Checking…'));
  expect(host.textContent).not.toContain(t('Connect this chat'));
  expect(host.textContent).toContain('HOST_UNAVAILABLE');

  // The explicit refresh is the user's retry, and it must actually re-ask.
  const before = (window.api.workControllerGet as any).mock.calls.length;
  vi.mocked(window.api.workControllerGet).mockImplementation(() => ok(binding()));
  [...host.querySelectorAll('button')].find(button => button.getAttribute('aria-label') === t('Refresh works'))!.click();
  await tick();
  expect((window.api.workControllerGet as any).mock.calls.length).toBeGreaterThan(before);
  expect(host.textContent).toContain(t('Connected'));
});

it('keeps a half-typed instruction, its focus and its selection while a connection read lands', async () => {
  const pending = Promise.withResolvers<{ ok: true; data: WorkControllerBinding | null }>();
  vi.mocked(window.api.workControllerGet).mockImplementation(() => pending.promise);
  await openPanel({ currentSession: () => 'session-prime' });
  const field = host.querySelector<HTMLTextAreaElement>('.work-form textarea')!;
  field.value = 'Keep this follow-up';
  field.focus();
  field.setSelectionRange(2, 6);

  pending.resolve(ok(binding()));
  await tick();
  expect(host.textContent).toContain(t('Connected'));
  expect(host.querySelector('.work-form textarea')).toBe(field);
  expect(field.value).toBe('Keep this follow-up');
  expect([field.selectionStart, field.selectionEnd]).toEqual([2, 6]);
  expect(document.activeElement).toBe(field);
});

it('reports a queued and an unconfirmed hand-off as what they are, not as failures', async () => {
  vi.mocked(window.api.workStatus).mockImplementation(() => ok(status({
    pending_commands: [
      { request_id: '55555555-5555-4555-8555-555555555555', kind: 'instruct', text_preview: 'Held one', delivery_state: 'queued', attempts: 1, created_at: 1 },
      { request_id: '66666666-6666-4666-8666-666666666666', kind: 'instruct', text_preview: 'Ambiguous one', delivery_state: 'unknown', attempts: 2, created_at: 2 }
    ]
  })));
  await openPanel();
  expect(host.textContent).toContain(t('Pending instructions'));
  expect(host.textContent).toContain(t('Held by the outbox; the chat has not taken this instruction yet.'));
  expect(host.textContent).toContain(t('The hand-off is unconfirmed and still being reconciled. It is not a failure.'));
  expect(host.textContent).not.toContain(t('Failed'));
});

it('shows the durable continuation chain in both directions', async () => {
  const predecessor = '77777777-7777-4777-8777-777777777777';
  const successor = '88888888-8888-4888-8888-888888888888';
  vi.mocked(window.api.workStatus).mockImplementation(() => ok(status({
    predecessor_work_id: predecessor, successor_work_id: successor
  })));
  await openPanel();
  expect(host.textContent).toContain(t('Continues work'));
  expect(host.textContent).toContain(predecessor);
  expect(host.textContent).toContain(t('Continued by'));
  expect(host.textContent).toContain(successor);
});

it('follows the successor a routed instruction actually landed on, and keeps a newer draft', async () => {
  const successor = '88888888-8888-4888-8888-888888888888';
  vi.mocked(window.api.workList).mockImplementation(() => ok(page([
    summary({ status: 'completed' }), summary({ work_id: successor, title: 'Continued work' })
  ])));
  vi.mocked(window.api.workStatus).mockImplementation(({ work_id }) =>
    ok(status({
      work_id,
      title: work_id === successor ? 'Continued work' : 'Fix the parser',
      status: work_id === successor ? 'running' : 'completed',
      // The successor is the work the instruction landed on, and the ledger records what it
      // continues; the pane renders that link so the user can see where they were moved to.
      ...(work_id === successor ? { predecessor_work_id: status().work_id } : {})
    })));

  const pending = Promise.withResolvers<{ ok: true; data: WorkReceipt } | { ok: false; error: string }>();
  vi.mocked(window.api.workInstruct).mockImplementation(() => pending.promise);
  await openPanel();
  const field = host.querySelector<HTMLTextAreaElement>('.work-form textarea')!;
  field.value = 'Do the next part';
  host.querySelector<HTMLFormElement>('.work-form')!.dispatchEvent(new dom.window.Event('submit', { bubbles: true, cancelable: true }));
  await tick();

  // The user types the next instruction while the first is still being recorded.
  field.value = 'And a second, half-typed follow-up';
  pending.resolve(ok({ request_id: 'r', work_id: successor, status: 'queued', revision: 4, predecessor_work_id: status().work_id }));
  await tick();
  expect(host.textContent).toContain(t('Queued for the continuation of this work · revision {0}', [4]));
  // Following would destroy the follow-up the user is typing, so the pane stays where they are.
  expect(host.querySelector('h2')!.textContent).toBe('Fix the parser');
  expect(host.querySelector('.work-form textarea')).toBe(field);
  expect(field.value).toBe('And a second, half-typed follow-up');

  // With nothing newer typed, the same receipt does move the pane to the work it landed on.
  field.value = 'A third instruction';
  vi.mocked(window.api.workInstruct).mockImplementation(() => ok({
    request_id: 'r', work_id: successor, status: 'queued', revision: 5, predecessor_work_id: status().work_id
  }));
  host.querySelector<HTMLFormElement>('.work-form')!.dispatchEvent(new dom.window.Event('submit', { bubbles: true, cancelable: true }));
  await tick();
  expect(host.querySelector('h2')!.textContent).toBe('Continued work');
  // The pane is now on the work the instruction landed on, and that work's own record says what
  // it continues — which is how the user sees they were moved rather than retargeted.
  expect(host.textContent).toContain(t('Continues work'));
  expect(host.textContent).toContain(status().work_id);
});
