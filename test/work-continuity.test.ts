/**
 * Mobile conversation continuity, over a real SQLite work ledger.
 *
 * The properties here cannot be seen from a single function: that a bound conversation's native
 * message is never executed twice (once by the model that owns the work and once by the relay),
 * that a restart cannot execute a message on pre-restart evidence, that a fork or edit is refused
 * rather than run, and that a completion produces exactly one report instead of one per pump.
 *
 * Nothing waits on wall-clock time. Time is injected, and the pump is driven explicitly.
 */

import { randomUUID } from 'node:crypto';
import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';

import {
  autoBindPrimeController,
  bindWorkController,
  claimWorkControllerTurn,
  controllerRequestId,
  createWorkContinuity,
  drainWorkContinuity,
  getWorkContinuityHandle,
  initWorkContinuity,
  resetWorkContinuityForTests,
  type ControllerReport,
  type ControllerReportResult,
  type WorkContinuityHandle,
  type WorkMessageOrigin
} from '../src/main/work/continuity.js';
import { createWorkService, type WorkRuntimePort, type WorkServiceHandle } from '../src/main/work/service.js';
import { createWorkStore, type WorkRow, type WorkStore } from '../src/main/work/store.js';
import type { WorkControllerSnapshot } from '../src/shared/work-continuity.js';
import { defaultConfig, initConfigPath, saveConfig } from '../src/main/config.js';
import { flushDurable, initDurableStore, resetDurableForTests } from '../src/main/durable.js';
import { observeRequestCorrelation } from '../src/main/session/correlation.js';
import {
  appendEvent,
  upsertMessageEvent,
  createSession,
  initSessionStore,
  rebindSession,
  resetSessionStoreForTests
} from '../src/main/session/store.js';

let directory = '';
let store: WorkStore;
let service: WorkServiceHandle;
let manager: WorkContinuityHandle;
let clock = 1_000_000;
let settled = true;
let origins = new Map<string, WorkMessageOrigin>();
let reports: ControllerReport[] = [];
let cancelled: string[] = [];
let instructed: Array<{ workId: string; text: string; requestId: string }> = [];
let reportResult: ControllerReportResult = { state: 'queued' };
/** The origin port, exposed so one case can race a disable against the routing awaits. */
let deps: Parameters<typeof createWorkContinuity>[0];

let SESSION = '';
const CONVERSATION = 'conversation-controller';
const ACCOUNT = 'account-one';

function work(over: Partial<WorkRow> = {}): WorkRow {
  const id = randomUUID();
  return {
    work_id: id,
    title: 'Continuity fixture',
    goal: 'Make the fixture suite pass.',
    project_path: '/tmp/continuity-project',
    project_name: 'continuity-project',
    base_commit: null,
    integration_branch: `wgpt/${id}/main`,
    integration_worktree: `/tmp/worktrees/${id}/main`,
    status: 'running',
    desired_state: null,
    prime_agent_id: null,
    prime_session_id: null,
    model: null,
    reasoning: null,
    max_workers: 2,
    revision: 0,
    blocker: null,
    checkpoint: null,
    integration_intent: null,
    predecessor_work_id: null,
    successor_work_id: null,
    created_at: clock,
    updated_at: clock,
    ...over
  };
}

/** The browserless half of the runtime port: this fixture is about the ledger, not a browser. */
function browserlessRuntime(): WorkRuntimePort {
  return {
    async beginStart() { /* the fixture drives its own stages */ },
    async deliver() { return { state: 'deferred', detail: 'no browser in this fixture' }; },
    async control(input) { return { status: input.action === 'cancel' ? 'cancelled' : 'paused' }; },
    async reconcile() { /* the ledger is already the source of truth */ }
  };
}

/**
 * Installs the real singleton manager, exactly as the host does.
 *
 * The exported API (`claimWorkControllerTurn`, the binding readers, …) deliberately resolves the
 * ledger through the installed manager, so a test that wants those paths must go through the same
 * installation the host performs.
 */
async function build(): Promise<WorkContinuityHandle> {
  deps = {
    store,
    service: () => service,
    conversationSettled: async () => settled,
    messageOrigin: async ({ messageId }) => origins.get(messageId) ?? 'human',
    deliverReport: async report => { reports.push(report); return reportResult; },
    cancelReport: async ({ id }) => { cancelled.push(id); return reportResult.state !== 'unknown'; },
    reconcileReport: async () => null,
    // The runtime's own evidence, read the same way it writes it: one durable `native_execution`
    // event per provider request, written on the admitted path of the managed gate. The fixture
    // records it through the same store API the runtime uses, so what is proved here is the real
    // join rather than a stubbed boolean.
    nativeExecution: ({ workId, providerRequestId }) => store
      .readEvents({ workId, after: 0, limit: 500 }).events
      .some(event => event.kind === 'native_execution' && event.payload['provider_request_id'] === providerRequestId),
    now: () => clock
  };
  await initWorkContinuity(deps);
  return getWorkContinuityHandle()!;
}

/** Records the managed gate's own evidence: this provider request really executed work here. */
function nativeExecution(workId: string, providerRequestId: string): void {
  store.appendEvent(workId, 'native_execution', {
    provider_request_id: providerRequestId,
    agent_id: 'agent-fixture',
    generation: 0,
    operation_id: randomUUID(),
    tool: 'apply_patch'
  });
}

function bind(workId: string, boundAt = clock - 10_000, over: Partial<{ conversationId: string; enabled: boolean; account: string | null }> = {}): void {
  store.putControllerBinding({
    session_id: SESSION,
    conversation_id: over.conversationId ?? CONVERSATION,
    provider_account_id: over.account === undefined ? ACCOUNT : over.account,
    work_id: workId,
    bound_at: boundAt,
    enabled: over.enabled ?? true,
    event_cursor: 0,
    updated_at: clock
  });
}

function observe(messageId: string, over: Partial<Parameters<WorkContinuityHandle['observe']>[0]> = {}) {
  return manager.observe({
    sessionId: SESSION,
    conversationId: CONVERSATION,
    messageId,
    text: `instruction ${messageId}`,
    authoredAt: clock,
    source: 'user',
    providerAccountId: ACCOUNT,
    ...over
  });
}

/**
 * One whole authenticated read, exactly as the companion posts it.
 *
 * The echo is real, not stubbed: the token comes from the manager's own watch list, which is the
 * same handshake the production status pass performs, so a test that breaks the handshake fails
 * here rather than passing against a fixture that agrees with itself.
 */
function snapshot(over: Partial<WorkControllerSnapshot> = {}): WorkControllerSnapshot {
  const watch = manager.watches().find(entry => entry.conversationId === (over.conversationId ?? CONVERSATION));
  return {
    conversationId: CONVERSATION,
    sessionId: SESSION,
    boundAt: watch?.boundAt ?? clock - 10_000,
    observationToken: watch?.observationToken ?? '',
    snapshotId: randomUUID(),
    pageIndex: 0,
    lastPage: true,
    providerAccountId: ACCOUNT,
    messages: [],
    complete: true,
    settled: true,
    ...over
  };
}

/** Posts one read as several transport pages of one snapshot id, oldest-first. */
async function pagedSnapshot(
  messages: WorkControllerSnapshot['messages'],
  over: { complete?: boolean; settled?: boolean; pages?: number; snapshotId?: string } = {}
): Promise<void> {
  const base = snapshot({ messages: [], complete: over.complete ?? true, settled: over.settled ?? true });
  const pages = over.pages ?? 2;
  const snapshotId = over.snapshotId ?? base.snapshotId;
  const size = Math.ceil(messages.length / pages);
  const chunks: Array<WorkControllerSnapshot['messages']> = [];
  for (let index = 0; index < messages.length; index += Math.max(1, size)) {
    chunks.push(messages.slice(index, index + Math.max(1, size)));
  }
  if (chunks.length === 0) chunks.push([]);
  for (const [index, chunk] of chunks.entries()) {
    await manager.snapshot({
      ...base,
      snapshotId,
      pageIndex: index,
      lastPage: index === chunks.length - 1,
      messages: chunk
    });
  }
}

/**
 * Lets the routing queue drain, then pumps reports.
 *
 * Routing is triggered by an observation or a snapshot — the production companion heartbeat — so a
 * test that only pumps is testing the report side, not the relay.
 */
async function tick(): Promise<void> {
  await Promise.resolve();
  await new Promise(resolve => setImmediate(resolve));
  await manager.pumpNow();
}

beforeEach(async () => {
  directory = await fs.mkdtemp(path.join(os.tmpdir(), 'clf-continuity-'));
  clock = 1_000_000;
  settled = true;
  origins = new Map();
  reports = [];
  cancelled = [];
  instructed = [];
  reportResult = { state: 'queued' };
  initConfigPath(directory);
  initDurableStore(directory);
  initSessionStore(directory);
  await saveConfig(defaultConfig());
  const session = await createSession({ title: 'Controller', origin: { kind: 'desktop', fromSessionId: null, agentId: null, task: '' } });
  await rebindSession(session.id, null, CONVERSATION);
  SESSION = session.id;
  store = createWorkStore({ dataDir: directory, now: () => clock });
  service = createWorkService({
    store,
    runtime: browserlessRuntime(),
    projects: {
      async resolve(inputPath) { return { path: inputPath, name: path.basename(inputPath), exists: true, isGit: true }; },
      async list() { return []; }
    },
    models: { async resolve() { return { model: null, reasoning: null }; } },
    worktreesRoot: path.join(directory, 'worktrees'),
    now: () => clock
  });
  const real = service.instruct.bind(service);
  service.instruct = async input => {
    instructed.push({ workId: input.work_id, text: input.text, requestId: input.request_id });
    return await real(input);
  };
  manager = await build();
});

afterEach(async () => {
  await drainWorkContinuity();
  resetWorkContinuityForTests();
  service.close();
  store.close();
  resetSessionStoreForTests();
  resetDurableForTests();
  await flushDurable();
  await fs.rm(directory, { recursive: true, force: true });
});

// --------------------------------------------------------------------------- admission

it('admits only an authenticated observation from an already bound conversation', async () => {
  const target = work();
  store.insertWork(target);
  // Unbound, generated, and pre-binding history are all refused for their own reason.
  expect(observe('msg-unbound')).toEqual({ state: 'unbound' });
  bind(target.work_id);
  expect(observe('msg-app', { source: 'app' })).toEqual({ state: 'generated' });
  expect(observe('msg-history', { authoredAt: clock - 20_000 })).toEqual({ state: 'stale' });

  const accepted = observe('msg-1');
  expect(accepted).toEqual({ state: 'accepted', messageId: 'msg-1', workId: target.work_id });
  // The payload is immutable and the identity is the provider message id: a retry is a duplicate,
  // and an edited retry cannot rewrite what was already accepted.
  expect(observe('msg-1')).toEqual({ state: 'duplicate', messageId: 'msg-1', workId: null });
  expect(store.getControllerMessage(SESSION, 'msg-1')!.text).toBe('instruction msg-1');
  expect(store.getControllerMessage(SESSION, 'msg-1')!.request_id).toBe(controllerRequestId(SESSION, 'msg-1'));
});

it('refuses a foreign provider account and never admits an unproven one', async () => {
  const target = work();
  store.insertWork(target);
  bind(target.work_id);
  expect(observe('msg-other-account', { providerAccountId: 'account-two' }))
    .toMatchObject({ state: 'rejected', error: expect.stringContaining('CONTROLLER_ACCOUNT_CONFLICT') });
  expect(store.getControllerMessage(SESSION, 'msg-other-account')).toBeNull();
  expect(observe('msg-no-account', { providerAccountId: null })).toEqual({ state: 'unproven' });
  expect(store.getControllerMessage(SESSION, 'msg-no-account')).toBeNull();
});

// --------------------------------------------------------------------------- no double execution

it('records a receipt instead of injecting when the controller is the work\'s live prime', async () => {
  const target = work();
  store.insertWork(target);
  const primeId = randomUUID();
  store.insertAgent({
    agent_id: primeId, work_id: target.work_id, parent_id: null, role: 'prime', label: 'prime',
    state: 'active', session_id: SESSION, conversation_id: CONVERSATION, generation: 0,
    worktree_path: target.integration_worktree, branch: target.integration_branch, base_commit: null,
    model: null, reasoning: null, result_ref: null, checkpoint_ref: null, created_at: clock, updated_at: clock
  });
  store.updateWork(target.work_id, { prime_agent_id: primeId });
  bind(target.work_id);
  // The exact execution lineage, in the real namespaces: the recorded turn's MCP call carries the
  // PROVIDER request id (`wfr_…`), and that exact request has the runtime's own durable
  // `native_execution` receipt under this work — written on the admitted path of the managed gate.
  // An ended turn alone — prose, or an unrelated call — proves nothing.
  const providerRequest = `wfr_${randomUUID().replace(/-/g, '')}`;
  store.updateAgent(primeId, { session_id: SESSION });
  observeRequestCorrelation({
    requestId: providerRequest, conversationId: CONVERSATION, sessionId: SESSION, messageId: 'msg-native',
    // The provider graph's own answer: this request's turn answers *this* human message.
    questionId: 'msg-native', tool: 'apply_patch', observedAt: clock - 30
  });
  nativeExecution(target.work_id, providerRequest);
  instructed = [];
  await upsertMessageEvent(SESSION, { kind: 'user_message', time: clock - 50, messageId: 'msg-native', source: 'extension', message: { text: 'instruction msg-native', truncated: false, chars: 18 } });
  await appendEvent(SESSION, { kind: 'turn_start', time: clock - 40, turnId: 'turn-native', source: 'extension' });
  await appendEvent(SESSION, {
    kind: 'tool_call', time: clock - 30, turnId: 'turn-native', source: 'mcp',
    call: { callId: 'call-native', tool: 'apply_patch', attribution: 'request_id', requestId: providerRequest,
      conversationId: CONVERSATION, attributionMethod: 'request_id', args: { text: '', truncated: false, chars: 0 },
      result: { text: '', truncated: false, chars: 0 }, outcome: 'ok', durationMs: 1,
      summary: { title: 'patched', tone: 'good', kind: 'edit' } }
  });
  await appendEvent(SESSION, { kind: 'turn_end', time: clock - 20, turnId: 'turn-native', outcome: 'completed', source: 'extension' });

  observe('msg-native');
  await tick();

  // The prime conversation already handled this message: nothing may be injected a second time.
  expect(instructed).toEqual([]);
  const row = store.getControllerMessage(SESSION, 'msg-native')!;
  expect(row.state).toBe('accepted');
  expect(row.error).toContain('handled natively');
});

it('joins the controller\'s own admission receipt instead of admitting the same message twice', async () => {
  const target = work();
  store.insertWork(target);
  bind(target.work_id);
  // The controller's model called the work tool for this exact message and it was admitted: the
  // receipt is durable under the id derived from (session, message).
  const requestId = controllerRequestId(SESSION, 'msg-model');
  const admitted = await service.instruct({ request_id: requestId, work_id: target.work_id, text: 'from the model' });
  instructed = [];

  observe('msg-model');
  await tick();

  expect(instructed).toEqual([]);
  const row = store.getControllerMessage(SESSION, 'msg-model')!;
  expect(row.state).toBe('accepted');
  expect(row.work_id).toBe(admitted.work_id);
});

it('never admits a host-generated report turn, and never admits an unproven one', async () => {
  const target = work();
  store.insertWork(target);
  bind(target.work_id);
  origins.set('msg-report', 'generated');
  origins.set('msg-echo', 'unknown');

  observe('msg-report');
  observe('msg-echo');
  await tick();

  expect(instructed).toEqual([]);
  expect(store.getControllerMessage(SESSION, 'msg-report')!.state).toBe('rejected');
  expect(store.getControllerMessage(SESSION, 'msg-report')!.error).toContain('generated by the host');
  // An unresolved echo is held, not rejected: it may yet prove to be a real instruction.
  expect(store.getControllerMessage(SESSION, 'msg-echo')!.state).toBe('pending');
});

it('relays an ordinary instruction once the conversation has settled, and only then', async () => {
  const target = work();
  store.insertWork(target);
  bind(target.work_id);
  settled = false;
  observe('msg-1');
  await tick();
  expect(instructed).toEqual([]);

  // The companion's next settled snapshot is what proves the boundary and releases the relay.
  settled = true;
  manager.snapshot(snapshot({ messages: [{ messageId: 'msg-1', text: 'instruction msg-1', authoredAt: clock }] }));
  await tick();
  expect(instructed).toEqual([{ workId: target.work_id, text: 'instruction msg-1', requestId: controllerRequestId(SESSION, 'msg-1') }]);
  expect(store.getControllerMessage(SESSION, 'msg-1')!.state).toBe('accepted');
  // A second pass cannot admit it again.
  await tick();
  expect(instructed).toHaveLength(1);
});

// --------------------------------------------------------------------------- restart proof

it('executes nothing recovered from disk until a fresh snapshot proves the branch', async () => {
  const target = work();
  store.insertWork(target);
  bind(target.work_id);
  store.putControllerMessage({
    session_id: SESSION, conversation_id: CONVERSATION, message_id: 'msg-before-restart',
    request_id: controllerRequestId(SESSION, 'msg-before-restart'), text: 'written before the restart',
    authored_at: clock, state: 'pending', work_id: null, error: null, created_at: clock
  });

  // A brand new manager, as a restarted host would build: no in-process evidence exists.
  await drainWorkContinuity();
  manager = await build();
  await manager.recover();
  settled = true;
  await tick();
  expect(instructed).toEqual([]);

  // A fresh *complete* snapshot that does not contain it proves the message is gone (forked or
  // edited), so it is rejected rather than executed.
  manager.snapshot(snapshot({ messages: [] }));
  await tick();
  expect(store.getControllerMessage(SESSION, 'msg-before-restart')!.state).toBe('rejected');
  expect(instructed).toEqual([]);

  // A later complete snapshot that names a message the host never observed relays it, in order:
  // membership of the active branch is what authorizes a message, and only then.
  manager.snapshot(snapshot({ messages: [{ messageId: 'msg-after-restart', text: 'said after the restart', authoredAt: clock }] }));
  await tick();
  expect(instructed).toEqual([{
    workId: target.work_id,
    text: 'said after the restart',
    requestId: controllerRequestId(SESSION, 'msg-after-restart')
  }]);
});

it('recovers a message whose admission already landed, from the persisted receipt', async () => {
  const target = work();
  store.insertWork(target);
  bind(target.work_id);
  const requestId = controllerRequestId(SESSION, 'msg-crashed');
  const receipt = await service.instruct({ request_id: requestId, work_id: target.work_id, text: 'admitted then the host died' });
  instructed = [];
  store.putControllerMessage({
    session_id: SESSION, conversation_id: CONVERSATION, message_id: 'msg-crashed', request_id: requestId,
    text: 'admitted then the host died', authored_at: clock, state: 'pending', work_id: null, error: null, created_at: clock
  });

  await drainWorkContinuity();
  manager = await build();
  await manager.recover();
  await tick();

  expect(instructed).toEqual([]);
  const row = store.getControllerMessage(SESSION, 'msg-crashed')!;
  expect(row.state).toBe('accepted');
  expect(row.work_id).toBe(receipt.work_id);
});

it('admits an offline backlog in order and never treats an incomplete page as proof', async () => {
  const target = work();
  store.insertWork(target);
  bind(target.work_id);
  // A partial page proves membership of what it lists and nothing else: a message it omits is
  // never treated as edited away, so it stays pending instead of being rejected.
  store.putControllerMessage({
    session_id: SESSION, conversation_id: CONVERSATION, message_id: 'msg-omitted',
    request_id: controllerRequestId(SESSION, 'msg-omitted'), text: 'not on this page',
    authored_at: clock - 300, state: 'pending', work_id: null, error: null, created_at: clock - 300
  });
  manager.snapshot(snapshot({
    complete: false,
    messages: [{ messageId: 'msg-b', text: 'correction', authoredAt: clock - 100 }]
  }));
  await tick();
  expect(store.getControllerMessage(SESSION, 'msg-omitted')!.state).toBe('pending');

  manager.snapshot(snapshot({
    messages: [
      { messageId: 'msg-a', text: 'requirements', authoredAt: clock - 200 },
      { messageId: 'msg-b', text: 'correction', authoredAt: clock - 100 },
      { messageId: 'msg-c', text: 'go', authoredAt: clock }
    ]
  }));
  await tick();
  // The partial page already routed the message it listed; the complete page then admits the rest
  // in provider order. The omitted message stays pending — an incomplete page proves nothing about
  // what it does not contain.
  // Provider order, and nothing executed before the page was complete.
  expect(instructed.map(entry => entry.text)).toEqual(['requirements', 'correction', 'go']);
  // The complete page is what proves the omitted message is gone, so only now is it rejected.
  expect(store.getControllerMessage(SESSION, 'msg-omitted')!.state).toBe('rejected');
});

it('advances the boundary on an explicit re-enable so disabled-period messages never run', async () => {
  const target = work();
  store.insertWork(target);
  bind(target.work_id);
  observe('msg-disabled');
  await drainWorkContinuity();
  manager = await build();
  store.putControllerBinding({ ...store.getControllerBinding(SESSION)!, enabled: false, updated_at: clock });

  // Time passes, the user re-enables, and the old message must not execute.
  clock += 60_000;
  store.putControllerBinding({ ...store.getControllerBinding(SESSION)!, enabled: true, bound_at: clock, updated_at: clock });
  manager.snapshot(snapshot({ messages: [{ messageId: 'msg-disabled', text: 'instruction msg-disabled', authoredAt: clock - 60_000 }] }));
  await tick();
  expect(instructed).toEqual([]);
  expect(store.getControllerMessage(SESSION, 'msg-disabled')!.state).toBe('pending');
});

it('relays a message the prime conversation never executed, even across the work\'s completion', async () => {
  const target = work();
  store.insertWork(target);
  const primeId = randomUUID();
  store.insertAgent({
    agent_id: primeId, work_id: target.work_id, parent_id: null, role: 'prime', label: 'prime',
    state: 'active', session_id: SESSION, conversation_id: CONVERSATION, generation: 0,
    worktree_path: target.integration_worktree, branch: target.integration_branch, base_commit: null,
    model: null, reasoning: null, result_ref: null, checkpoint_ref: null, created_at: clock, updated_at: clock
  });
  store.updateWork(target.work_id, { prime_agent_id: primeId });
  bind(target.work_id);
  // The user queued this message while the prime was executing something else; the work then
  // completed before this message's own turn ever ran. It has no execution lineage at all, so it
  // is a genuine follow-up — the current status must not swallow it.
  store.setWorkStatus(target.work_id, 'completed', 'work_completed');
  observe('msg-queued-during-prime');
  manager.snapshot(snapshot({ messages: [{ messageId: 'msg-queued-during-prime', text: 'instruction msg-queued-during-prime', authoredAt: clock }] }));
  await tick();

  expect(instructed.map(entry => entry.text)).toContain('instruction msg-queued-during-prime');
  expect(store.getControllerMessage(SESSION, 'msg-queued-during-prime')!.state).toBe('accepted');
});

it('supersedes an older snapshot pass when a newer authenticated snapshot arrives', async () => {
  const target = work();
  store.insertWork(target);
  bind(target.work_id);
  const old = Array.from({ length: 64 }, (_, index) => ({
    messageId: `msg-old-${index}`, text: `old ${index}`, authoredAt: clock + index
  }));
  // The second snapshot lands while the first is still working through its chunks: the newer branch
  // is the truth, so the older pass must stop at its next chunk boundary instead of continuing to
  // admit and execute messages the newer branch has already replaced.
  const first = manager.snapshot(snapshot({ messages: old }));
  await manager.snapshot(snapshot({ messages: [{ messageId: 'msg-new', text: 'new branch', authoredAt: clock + 1 }] }));
  await first;
  await tick();

  const relayed = instructed.map(entry => entry.text);
  expect(relayed).toContain('new branch');
  // No message from the second chunk of the superseded pass may have executed.
  expect(relayed.filter(text => /^old (3[2-9]|[4-5][0-9]|6[0-3])$/.test(text))).toEqual([]);
});

it('relays a mobile message whose turn ended without ever executing this work', async () => {
  const target = work();
  store.insertWork(target);
  const primeId = randomUUID();
  store.insertAgent({
    agent_id: primeId, work_id: target.work_id, parent_id: null, role: 'prime', label: 'prime',
    state: 'active', session_id: SESSION, conversation_id: CONVERSATION, generation: 0,
    worktree_path: target.integration_worktree, branch: target.integration_branch, base_commit: null,
    model: null, reasoning: null, result_ref: null, checkpoint_ref: null, created_at: clock, updated_at: clock
  });
  store.updateWork(target.work_id, { prime_agent_id: primeId });
  bind(target.work_id);
  // The user wrote this in the controller chat while the prime was busy; ChatGPT answered it in
  // prose and the turn ended. No managed operation ever ran for it, so the work must still receive
  // it — an ended turn is not execution.
  await upsertMessageEvent(SESSION, { kind: 'user_message', time: clock - 50, messageId: 'msg-mobile-b', source: 'extension', message: { text: 'instruction msg-mobile-b', truncated: false, chars: 22 } });
  await appendEvent(SESSION, { kind: 'turn_start', time: clock - 40, turnId: 'turn-mobile-b', source: 'extension' });
  await appendEvent(SESSION, { kind: 'turn_end', time: clock - 20, turnId: 'turn-mobile-b', outcome: 'completed', source: 'extension' });

  observe('msg-mobile-b');
  manager.snapshot(snapshot({ messages: [{ messageId: 'msg-mobile-b', text: 'instruction msg-mobile-b', authoredAt: clock }] }));
  await tick();

  expect(instructed.map(entry => entry.text)).toContain('instruction msg-mobile-b');
  expect(store.getControllerMessage(SESSION, 'msg-mobile-b')!.state).toBe('accepted');
});

it("keeps the first owner's request id so a native call and the relay stay one admission", async () => {
  const target = work();
  store.insertWork(target);
  bind(target.work_id);
  const nativeId = randomUUID();
  const claimed = claimWorkControllerTurn({
    sessionId: SESSION,
    conversationId: CONVERSATION,
    messageId: 'msg-native-id',
    text: 'typed in the controller',
    authoredAt: clock,
    workId: target.work_id,
    requestId: nativeId
  });
  expect(claimed!.request_id).toBe(nativeId);
  expect(claimed!.state).toBe('pending');

  // The automatic relay for the same message must not invent a second id: the durable row owns
  // the first owner's id, and that is what both paths admit under.
  const relayId = controllerRequestId(SESSION, 'msg-native-id');
  expect(relayId).not.toBe(nativeId);
  const again = claimWorkControllerTurn({
    sessionId: SESSION,
    conversationId: CONVERSATION,
    messageId: 'msg-native-id',
    text: 'typed in the controller',
    authoredAt: clock,
    workId: target.work_id
  });
  expect(again!.request_id).toBe(nativeId);
  expect(store.getControllerMessage(SESSION, 'msg-native-id')!.request_id).toBe(nativeId);
});

it('carries the controller\'s own preceding message as labeled context', async () => {
  const target = work();
  store.insertWork(target);
  bind(target.work_id);
  // The canonical question row and the assistant answer it quotes, both recorded the way production
  // records them: the relay composes its context from exactly these two.
  await upsertMessageEvent(SESSION, { kind: 'user_message', time: clock - 10, messageId: 'msg-go', source: 'extension',
    message: { text: 'go with that plan', truncated: false, chars: 17 } });
  await manager.snapshot(snapshot({
    messages: [{
      messageId: 'msg-go',
      text: 'go with that plan',
      authoredAt: clock,
      context: 'Plan: rewrite the parser, then run the suite.',
      precedingAssistantId: 'assistant-plan'
    }]
  }));
  await tick();

  // The work runs in a different conversation, so "that plan" is only actionable when the plan
  // travels with the instruction — quoted and labeled, never silently dropped.
  expect(instructed).toHaveLength(1);
  expect(instructed[0]!.text).toContain('go with that plan');
  expect(instructed[0]!.text).toContain('--- quoted from the same conversation ---');
  expect(instructed[0]!.text).toContain('Plan: rewrite the parser, then run the suite.');
  // The durable inbox keeps the user's own words; the quotation is transport, not payload.
  expect(store.getControllerMessage(SESSION, 'msg-go')!.text).toBe('go with that plan');
});

it('relays a backlog longer than the process evidence bound, in provider order', async () => {
  const target = work();
  store.insertWork(target);
  bind(target.work_id);
  // Every message is authored after the binding, so none is pre-binding history.
  const backlog = Array.from({ length: 600 }, (_, index) => ({
    messageId: `msg-${String(index).padStart(4, '0')}`,
    text: `step ${index}`,
    authoredAt: clock + index
  }));
  // Transport pages are pages of one *read*, not windows of authority: the whole branch arrives
  // before anything is applied, and nothing is dropped because it did not fit one body.
  await pagedSnapshot(backlog, { pages: 3 });
  await tick();

  // Every message of the branch runs, oldest first, and none is evicted by the process-local
  // evidence bound: the read routes in awaited ordered chunks instead of remembering all of them
  // before routing any.
  expect(instructed).toHaveLength(600);
  expect(instructed[0]!.text).toBe('step 0');
  expect(instructed[599]!.text).toBe('step 599');
  expect(instructed.map(entry => entry.text)).toEqual(backlog.map(entry => entry.text));
});

it('applies nothing until every transport page of one read has arrived', async () => {
  const target = work();
  store.insertWork(target);
  bind(target.work_id);
  const branch = Array.from({ length: 6 }, (_, index) => ({
    messageId: `msg-page-${index}`,
    text: `paged ${index}`,
    authoredAt: clock + index
  }));
  const base = snapshot({ messages: [] });

  // Page 0 of 2 arrives: the read is not whole, so nothing may be admitted, routed or rejected.
  await manager.snapshot({ ...base, pageIndex: 0, lastPage: false, messages: branch.slice(0, 3) });
  await tick();
  expect(instructed).toEqual([]);
  expect(store.listPendingControllerMessagesForSession(SESSION, 100)).toEqual([]);

  // The last page completes the read: the whole branch is then admitted and routed in order.
  await manager.snapshot({ ...base, pageIndex: 1, lastPage: true, messages: branch.slice(3) });
  await tick();
  expect(instructed.map(entry => entry.text)).toEqual(branch.map(entry => entry.text));
});

it('never rejects a pending row against a window rather than the whole read', async () => {
  const target = work();
  store.insertWork(target);
  bind(target.work_id);
  // A message that is genuinely on the branch, but not in the window page 0 happens to carry.
  store.putControllerMessage({
    session_id: SESSION, conversation_id: CONVERSATION, message_id: 'msg-outside-window',
    request_id: controllerRequestId(SESSION, 'msg-outside-window'), text: 'still on the branch',
    authored_at: clock - 500, state: 'pending', work_id: null, error: null, created_at: clock - 500
  });
  const base = snapshot({ messages: [] });

  // A page is not the branch. Rejecting against page 0 alone would mark this message edited away.
  await manager.snapshot({ ...base, pageIndex: 0, lastPage: false, messages: [{ messageId: 'msg-window', text: 'window', authoredAt: clock }] });
  await tick();
  expect(store.getControllerMessage(SESSION, 'msg-outside-window')!.state).toBe('pending');

  // The whole read arrives and does contain it, so it survives and executes.
  await manager.snapshot({
    ...base, pageIndex: 1, lastPage: true,
    messages: [{ messageId: 'msg-outside-window', text: 'still on the branch', authoredAt: clock - 500 }]
  });
  await tick();
  expect(instructed.map(entry => entry.text)).toContain('still on the branch');
  expect(store.getControllerMessage(SESSION, 'msg-outside-window')!.state).toBe('accepted');
});

it('executes nothing from a partial page even when it is longer than one chunk', async () => {
  const target = work();
  store.insertWork(target);
  bind(target.work_id);
  const partial = Array.from({ length: 40 }, (_, index) => ({
    messageId: `msg-partial-${index}`,
    text: `partial ${index}`,
    authoredAt: clock + index
  }));
  await manager.snapshot(snapshot({ complete: false, messages: partial }));
  await tick();

  expect(instructed).toEqual([]);
  expect(store.listPendingControllerMessagesForSession(SESSION, 100)).toHaveLength(40);

  // The complete page then admits the whole branch, in order.
  await manager.snapshot(snapshot({ messages: partial }));
  await tick();
  expect(instructed).toHaveLength(40);
  expect(instructed[0]!.text).toBe('partial 0');
});

it('never executes a partial read even when its pages are all present', async () => {
  const target = work();
  store.insertWork(target);
  bind(target.work_id);
  const partial = Array.from({ length: 40 }, (_, index) => ({
    messageId: `msg-partial-page-${index}`,
    text: `partial page ${index}`,
    authoredAt: clock + index
  }));
  // `complete` is the read's own answer about the provider graph walk, and it is never confused
  // with "this body held every page": a multi-page read that admits the walk was partial still
  // records membership and executes nothing.
  await pagedSnapshot(partial, { complete: false, pages: 2 });
  await tick();
  expect(instructed).toEqual([]);
  expect(store.listPendingControllerMessagesForSession(SESSION, 100)).toHaveLength(40);

  await pagedSnapshot(partial, { complete: true, pages: 2 });
  await tick();
  expect(instructed.map(entry => entry.text)).toEqual(partial.map(entry => entry.text));
});

it('refuses a read whose watch authority has moved, however well it matches otherwise', async () => {
  const target = work();
  store.insertWork(target);
  bind(target.work_id);
  const stale = snapshot({ messages: [{ messageId: 'msg-stale', text: 'stale branch', authoredAt: clock }] });

  // The binding moves while that read is in flight — the user disables and re-enables the
  // controller, which is a fresh consent boundary. The answer still names the same conversation, so
  // only the authority echo can tell it is stale.
  await drainWorkContinuity();
  manager = await build();
  store.putControllerBinding({ ...store.getControllerBinding(SESSION)!, enabled: false, updated_at: clock });
  clock += 60_000;
  store.putControllerBinding({ ...store.getControllerBinding(SESSION)!, enabled: true, bound_at: clock, updated_at: clock });

  await manager.snapshot(stale);
  await tick();
  expect(instructed).toEqual([]);
  expect(store.getControllerMessage(SESSION, 'msg-stale')).toBeNull();

  // A read that echoes the current authority is applied normally, so the refusal is the echo and
  // not a blanket refusal to ever read this conversation again.
  clock += 1_000;
  await manager.snapshot(snapshot({ messages: [{ messageId: 'msg-fresh', text: 'fresh branch', authoredAt: clock }] }));
  await tick();
  expect(instructed.map(entry => entry.text)).toEqual(['fresh branch']);
});

it('refuses a duplicate page of a read that has already been applied', async () => {
  const target = work();
  store.insertWork(target);
  bind(target.work_id);
  const branch = [{ messageId: 'msg-replayed', text: 'once', authoredAt: clock }];
  const read = snapshot({ messages: branch });
  await manager.snapshot(read);
  await tick();
  expect(instructed.map(entry => entry.text)).toEqual(['once']);

  // A slow retry of the same page arrives after the read was consumed: its token is spent, so it
  // cannot re-open a branch this read has already answered for.
  await manager.snapshot(read);
  await tick();
  expect(instructed).toHaveLength(1);
  expect(store.getControllerMessage(SESSION, 'msg-replayed')!.state).toBe('accepted');
});

it('refuses an unproven-account read without invalidating the branch it was never authorized to touch', async () => {
  const target = work();
  store.insertWork(target);
  bind(target.work_id);
  store.putControllerMessage({
    session_id: SESSION, conversation_id: CONVERSATION, message_id: 'msg-live',
    request_id: controllerRequestId(SESSION, 'msg-live'), text: 'still on the branch',
    authored_at: clock - 500, state: 'pending', work_id: null, error: null, created_at: clock - 500
  });

  // A complete read that cannot prove the account must be refused *before* it can negate membership:
  // if it invalidated the branch first and refused afterwards, an unauthenticated body could reject
  // a message the real branch still carries.
  await manager.snapshot(snapshot({ providerAccountId: null, messages: [] }));
  await tick();
  expect(store.getControllerMessage(SESSION, 'msg-live')!.state).toBe('pending');

  // The same is true of a foreign account, and the read that does prove the account still applies.
  await manager.snapshot(snapshot({ providerAccountId: 'account-two', messages: [] }));
  await tick();
  expect(store.getControllerMessage(SESSION, 'msg-live')!.state).toBe('pending');

  await manager.snapshot(snapshot({ messages: [{ messageId: 'msg-live', text: 'still on the branch', authoredAt: clock - 500 }] }));
  await tick();
  expect(store.getControllerMessage(SESSION, 'msg-live')!.state).toBe('accepted');
  expect(instructed.map(entry => entry.text)).toEqual(['still on the branch']);
});

it('never admits a snapshot when its first account anchor cannot be persisted', async () => {
  const target = work();
  store.insertWork(target);
  bind(target.work_id, clock - 10_000, { account: null });
  const put = vi.spyOn(store, 'putControllerBinding').mockImplementation(() => {
    throw new Error('disk full');
  });

  try {
    await manager.snapshot(snapshot({
      messages: [{ messageId: 'msg-unanchored', text: 'must not run', authoredAt: clock }]
    }));
    await tick();

    expect(store.getControllerBinding(SESSION)!.provider_account_id).toBeNull();
    expect(store.getControllerMessage(SESSION, 'msg-unanchored')).toBeNull();
    expect(instructed).toEqual([]);
  } finally {
    put.mockRestore();
  }
});

it('never lets a stale echo retire the authority the current binding is reading under', async () => {
  const target = work();
  store.insertWork(target);
  bind(target.work_id);
  const stale = snapshot({ messages: [] });

  // The binding moves — a re-enable is a fresh consent boundary — so a new read authority exists and
  // its own read is already assembling.
  await drainWorkContinuity();
  manager = await build();
  clock += 60_000;
  store.putControllerBinding({ ...store.getControllerBinding(SESSION)!, enabled: false, updated_at: clock });
  store.putControllerBinding({ ...store.getControllerBinding(SESSION)!, enabled: true, bound_at: clock, updated_at: clock });
  const fresh = snapshot({ messages: [] });
  await manager.snapshot({ ...fresh, pageIndex: 0, lastPage: false, messages: [{ messageId: 'msg-first', text: 'first half', authoredAt: clock + 1 }] });

  // The previous authority's answer finally arrives. It is a no-op: it may not delete the token or
  // the buffered page the current read is holding.
  await manager.snapshot(stale);

  await manager.snapshot({ ...fresh, pageIndex: 1, lastPage: true, messages: [{ messageId: 'msg-second', text: 'second half', authoredAt: clock + 2 }] });
  await tick();
  expect(instructed.map(entry => entry.text)).toEqual(['first half', 'second half']);
});

it('reports an ending once even when a later event lands on the same work', async () => {
  const target = work();
  store.insertWork(target);
  bind(target.work_id);
  store.setWorkStatus(target.work_id, 'completed', 'work_completed');

  await manager.pumpNow();
  expect(store.listControllerDeliveries(SESSION)).toHaveLength(1);

  // A late acknowledgment, audit row or instruction receipt appends an event *after* the ending.
  // That is not a second completion, and the user must not receive a second final message.
  store.appendEvent(target.work_id, 'operation_completed', { operation_id: randomUUID(), tool: 'apply_patch' });
  await manager.pumpNow();
  await manager.pumpNow();
  expect(store.listControllerDeliveries(SESSION)).toHaveLength(1);
});

it('honours a native execution receipt even after the prime conversation was replaced', async () => {
  const target = work();
  store.insertWork(target);
  const primeId = randomUUID();
  store.insertAgent({
    agent_id: primeId, work_id: target.work_id, parent_id: null, role: 'prime', label: 'prime',
    state: 'active', session_id: SESSION, conversation_id: 'conversation-replacement-prime', generation: 0,
    worktree_path: target.integration_worktree, branch: target.integration_branch, base_commit: null,
    model: null, reasoning: null, result_ref: null, checkpoint_ref: null, created_at: clock, updated_at: clock
  });
  // The work is now driven by a *different* conversation than the controller. That must not erase
  // the fact that this exact question already executed work here: requiring the current prime to
  // still be this conversation would discard valid historical evidence and relay a message that was
  // already handled.
  store.updateWork(target.work_id, { prime_agent_id: primeId });
  bind(target.work_id);
  const providerRequest = `wfr_${randomUUID().replace(/-/g, '')}`;
  observeRequestCorrelation({
    requestId: providerRequest, conversationId: CONVERSATION, sessionId: SESSION, messageId: 'msg-old-prime',
    questionId: 'msg-old-prime', tool: 'apply_patch', observedAt: clock - 30
  });
  nativeExecution(target.work_id, providerRequest);
  instructed = [];

  observe('msg-old-prime');
  manager.snapshot(snapshot({
    messages: [{ messageId: 'msg-old-prime', text: 'instruction msg-old-prime', authoredAt: clock, requestId: providerRequest }]
  }));
  await tick();

  expect(instructed).toEqual([]);
  expect(store.getControllerMessage(SESSION, 'msg-old-prime')!.state).toBe('accepted');
});

it('gives an unrelated rebind a fresh boundary so the old work\'s backlog never executes', async () => {
  const first = work();
  const second = work();
  store.insertWork(first);
  store.insertWork(second);
  bind(first.work_id);
  // A message the user wrote for the first work, not yet routed.
  store.putControllerMessage({
    session_id: SESSION, conversation_id: CONVERSATION, message_id: 'msg-for-first',
    request_id: controllerRequestId(SESSION, 'msg-for-first'), text: 'belongs to the first work',
    authored_at: clock - 500, state: 'pending', work_id: null, error: null, created_at: clock - 500
  });

  // The user explicitly rebinds this conversation to an unrelated work. That is new consent, not a
  // continuation, so the boundary moves and the old work's backlog is history rather than an
  // instruction for a work that never asked for it.
  clock += 1_000;
  const rebound = bindWorkController({ sessionId: SESSION, conversationId: CONVERSATION, workId: second.work_id });
  // The boundary must move: preserving the old one would admit the first work's backlog into a work
  // that never asked for it.
  expect(rebound!.bound_at).toBeGreaterThan(clock - 10_000);

  // The two messages are placed relative to the boundary the rebind actually wrote: one authored
  // before it (pre-consent history) and one after it (a real instruction). A rebind takes its
  // boundary from the wall clock, so anchoring to that value is what makes this fixture honest.
  await upsertMessageEvent(SESSION, { kind: 'user_message', time: clock, messageId: 'msg-for-second', source: 'extension',
    message: { text: 'belongs to the second work', truncated: false, chars: 24 } });
  manager.snapshot(snapshot({
    messages: [
      { messageId: 'msg-for-first', text: 'belongs to the first work', authoredAt: rebound!.bound_at - 1 },
      { messageId: 'msg-for-second', text: 'belongs to the second work', authoredAt: rebound!.bound_at + 1 }
    ]
  }));
  await tick();

  expect(instructed.map(entry => entry.workId)).toEqual([second.work_id]);
  expect(instructed.map(entry => entry.text)).toEqual(['belongs to the second work']);
  // Pre-consent history is never admitted. Whether it is also *marked* rejected is the manager's
  // own policy; what matters here is that it never executes against the work it was not written for.
  expect(store.getControllerMessage(SESSION, 'msg-for-first')!.state).not.toBe('accepted');
});

it('preserves the controller boundary when the work continues into its recorded successor', async () => {
  const first = work();
  const second = work({ predecessor_work_id: first.work_id });
  store.insertWork(first);
  store.insertWork(second);
  store.updateWork(first.work_id, { successor_work_id: second.work_id });
  bind(first.work_id);

  // The successor is the same run continuing, so the boundary and the backlog are preserved: the
  // user's unexecuted message still belongs to the run it was written for.
  const rebound = bindWorkController({ sessionId: SESSION, conversationId: CONVERSATION, workId: second.work_id });
  expect(rebound!.bound_at).toBe(clock - 10_000);

  manager.snapshot(snapshot({ messages: [{ messageId: 'msg-run', text: 'continue the run', authoredAt: clock }] }));
  await tick();
  expect(instructed.map(entry => entry.text)).toEqual(['continue the run']);
});

it('never retargets or downgrades a binding a person made', async () => {
  const first = work();
  const second = work();
  store.insertWork(first);
  store.insertWork(second);
  // A person's own binding for the first work.
  bindWorkController({ sessionId: SESSION, conversationId: CONVERSATION, workId: first.work_id });
  expect(store.getControllerBinding(SESSION)!.origin).toBe('explicit');

  // A later runtime fallback for an unrelated work must not move it onto that work, and must not
  // rewrite its origin to automatic so a future fallback could displace it.
  const untouched = autoBindPrimeController({ sessionId: SESSION, conversationId: CONVERSATION, workId: second.work_id });
  expect(untouched!.work_id).toBe(first.work_id);
  const after = store.getControllerBinding(SESSION)!;
  expect(after.work_id).toBe(first.work_id);
  expect(after.origin).toBe('explicit');
  expect(store.getControllerBindingByConversation(CONVERSATION)!.work_id).toBe(first.work_id);
});

it('never displaces a work\'s controller from a prime transfer, automatic or not', async () => {
  const target = work();
  store.insertWork(target);
  // The desktop-started work's controller, created by the prime fallback itself.
  const first = autoBindPrimeController({ sessionId: 'session-prime-one', conversationId: 'conversation-prime-one', workId: target.work_id });
  expect(first!.origin).toBe('automatic');

  // The prime conversation is replaced, and the runtime runs the same helper from the new chat. The
  // original controller is the whole point of the feature: the fallback gains a controller, it never
  // takes one away.
  expect(autoBindPrimeController({ sessionId: SESSION, conversationId: CONVERSATION, workId: target.work_id })).toBeNull();
  const kept = store.getControllerBinding('session-prime-one')!;
  expect(kept.enabled).toBe(true);
  expect(kept.origin).toBe('automatic');
  expect(store.getControllerBinding(SESSION)).toBeNull();

  // The same holds when the work continues into a successor.
  const successor = work({ predecessor_work_id: target.work_id });
  store.insertWork(successor);
  store.updateWork(target.work_id, { successor_work_id: successor.work_id });
  expect(autoBindPrimeController({ sessionId: SESSION, conversationId: CONVERSATION, workId: successor.work_id })).toBeNull();
  expect(store.getControllerBinding('session-prime-one')!.enabled).toBe(true);
});

it('keeps an explicit controller when the fallback runs for its own work', async () => {
  const target = work();
  store.insertWork(target);
  bindWorkController({ sessionId: 'session-user', conversationId: 'conversation-user', workId: target.work_id });

  // A different chat's fallback must not displace the controller a person chose.
  expect(autoBindPrimeController({ sessionId: SESSION, conversationId: CONVERSATION, workId: target.work_id })).toBeNull();
  const kept = store.getControllerBinding('session-user')!;
  expect(kept.enabled).toBe(true);
  expect(kept.origin).toBe('explicit');
  expect(store.getControllerBinding(SESSION)).toBeNull();
});

it('does not move the binding onto a successor when the authority changed mid-admission', async () => {
  const target = work();
  const unrelated = work();
  store.insertWork(target);
  store.insertWork(unrelated);
  bind(target.work_id);
  // The service is what creates the successor, and the rebind happens while its call is in flight —
  // exactly the window the old code moved the binding in.
  const successor = work({ predecessor_work_id: target.work_id });
  const real = service.instruct.bind(service);
  service.instruct = async input => {
    const receipt = await real(input);
    clock += 1_000;
    bindWorkController({ sessionId: SESSION, conversationId: CONVERSATION, workId: unrelated.work_id });
    store.insertWork(successor);
    return { ...receipt, work_id: successor.work_id };
  };

  manager.snapshot(snapshot({ messages: [{ messageId: 'msg-move', text: 'run it', authoredAt: clock }] }));
  await tick();

  // The admission is recorded as the receipt it is, and the user's own rebind is left exactly as
  // they made it — not retargeted onto this chain, and not given this chain's epoch.
  expect(store.getControllerMessage(SESSION, 'msg-move')!.state).toBe('accepted');
  const binding = store.getControllerBinding(SESSION)!;
  expect(binding.work_id).toBe(unrelated.work_id);
  expect(binding.bound_at).toBeGreaterThan(clock - 10_000);
});

it('reconciles a receipt behind a head of rows that were never admitted', async () => {
  const target = work();
  store.insertWork(target);
  bind(target.work_id);
  // A hundred pending rows whose admission never landed sit at the head of the inbox, and the row
  // whose admission *did* land sorts behind them. A head-of-list walk would never reach it.
  for (let index = 0; index < 100; index++) {
    const messageId = `msg-head-${String(index).padStart(3, '0')}`;
    store.putControllerMessage({
      session_id: SESSION, conversation_id: CONVERSATION, message_id: messageId,
      request_id: controllerRequestId(SESSION, messageId), text: `never admitted ${index}`,
      authored_at: clock - 5_000 + index, state: 'pending', work_id: null, error: null, created_at: clock - 5_000 + index
    });
  }
  const crashed = controllerRequestId(SESSION, 'msg-behind-head');
  const receipt = await service.instruct({ request_id: crashed, work_id: target.work_id, text: 'admitted then the host died' });
  instructed = [];
  store.putControllerMessage({
    session_id: SESSION, conversation_id: CONVERSATION, message_id: 'msg-behind-head', request_id: crashed,
    text: 'admitted then the host died', authored_at: clock, state: 'pending', work_id: null, error: null, created_at: clock
  });

  await drainWorkContinuity();
  manager = await build();
  await manager.recover();

  const row = store.getControllerMessage(SESSION, 'msg-behind-head')!;
  expect(row.state).toBe('accepted');
  expect(row.work_id).toBe(receipt.work_id);
  expect(instructed).toEqual([]);
});

it('rejects an off-branch row behind a head of on-branch pending rows', async () => {
  const target = work();
  store.insertWork(target);
  bind(target.work_id);
  const branch: WorkControllerSnapshot['messages'] = [];
  for (let index = 0; index < 100; index++) {
    const messageId = `msg-on-${String(index).padStart(3, '0')}`;
    store.putControllerMessage({
      session_id: SESSION, conversation_id: CONVERSATION, message_id: messageId,
      request_id: controllerRequestId(SESSION, messageId), text: `on the branch ${index}`,
      authored_at: clock - 5_000 + index, state: 'pending', work_id: null, error: null, created_at: clock - 5_000 + index
    });
    branch.push({ messageId, text: `on the branch ${index}`, authoredAt: clock - 5_000 + index });
  }
  // Edited away, and sorting after every row the walk must keep.
  store.putControllerMessage({
    session_id: SESSION, conversation_id: CONVERSATION, message_id: 'msg-off-branch',
    request_id: controllerRequestId(SESSION, 'msg-off-branch'), text: 'edited away',
    authored_at: clock, state: 'pending', work_id: null, error: null, created_at: clock
  });

  // The read is complete but the branch has not settled, so nothing routes and the on-branch rows
  // stay pending at the head of the walk.
  settled = false;
  await manager.snapshot(snapshot({ settled: false, messages: branch }));
  await tick();

  expect(store.getControllerMessage(SESSION, 'msg-off-branch')!.state).toBe('rejected');
  expect(store.getControllerMessage(SESSION, 'msg-on-000')!.state).toBe('pending');
  expect(instructed).toEqual([]);
});

it('preserves the boundary across a chain more than one successor long', async () => {
  const a = work();
  const b = work({ predecessor_work_id: a.work_id });
  const c = work({ predecessor_work_id: b.work_id });
  store.insertWork(a);
  store.insertWork(b);
  store.insertWork(c);
  store.updateWork(a.work_id, { successor_work_id: b.work_id });
  store.updateWork(b.work_id, { successor_work_id: c.work_id });
  bind(a.work_id);

  // A -> C is the same run continuing, even though C is not A's immediate successor: the walk
  // traverses successors transitively, so the pending backlog is not aged out.
  const rebound = bindWorkController({ sessionId: SESSION, conversationId: CONVERSATION, workId: c.work_id });
  expect(rebound!.bound_at).toBe(clock - 10_000);
  expect(rebound!.work_id).toBe(c.work_id);

  manager.snapshot(snapshot({ messages: [{ messageId: 'msg-deep-run', text: 'continue deeper', authoredAt: clock }] }));
  await tick();
  expect(instructed.map(entry => entry.text)).toEqual(['continue deeper']);
});

it('reports progress again after a paused work resumes', async () => {
  const target = work();
  store.insertWork(target);
  bind(target.work_id);
  // The ending report is actually taken, so the resumed run's status is not coalesced behind it.
  reportResult = { state: 'delivered' };
  store.setWorkStatus(target.work_id, 'paused', 'work_paused');
  await manager.pumpNow();
  expect(reports).toHaveLength(1);
  expect(reports[0]!.text).toContain('[work-report] final');

  // The user resumes, and the work makes progress. The historical pause must not silence the rest of
  // the run: an ending is owed for the state the work is in *now*.
  clock += 6_000;
  store.setWorkStatus(target.work_id, 'running', 'work_running');
  store.appendEvent(target.work_id, 'operation_completed', { operation_id: randomUUID(), tool: 'apply_patch' });
  await manager.pumpNow();

  // The run is reported again: a bounded status message, not a second final one.
  expect(reports.some(report => report.text.includes('[work-report] status'))).toBe(true);
  expect(store.listControllerDeliveries(SESSION).filter(row => row.text.includes('[work-report] final'))).toHaveLength(1);
});

it('sends nothing when the controller is disabled while the context read is in flight', async () => {
  const target = work();
  store.insertWork(target);
  bind(target.work_id);
  // The disable lands during the routing pass's awaits; the final fence must observe it.
  let disabled = false;
  const original = deps.messageOrigin;
  deps.messageOrigin = async input => {
    if (!disabled) {
      disabled = true;
      store.putControllerBinding({ ...store.getControllerBinding(SESSION)!, enabled: false, updated_at: clock });
    }
    return await original(input);
  };
  observe('msg-disable-race');
  await manager.snapshot(snapshot({ messages: [{ messageId: 'msg-disable-race', text: 'instruction msg-disable-race', authoredAt: clock }] }));
  await tick();

  expect(instructed).toEqual([]);
  expect(store.getControllerMessage(SESSION, 'msg-disable-race')!.state).toBe('pending');
});

it('quotes only the provider-proven preceding assistant message, never a chronology guess', async () => {
  const target = work();
  store.insertWork(target);
  bind(target.work_id);
  // The old branch's plan is recorded in this session, and the user's new question is an *edit* of
  // an earlier turn: its own turn boundary sits after that plan, so "the latest assistant message
  // before the boundary" would quote a plan this question never followed. Sequence is not ancestry.
  await appendEvent(SESSION, {
    kind: 'assistant_message', time: clock - 300, messageId: 'assistant-old-plan', source: 'extension', final: false,
    message: { text: 'Plan: rewrite the parser, then run the suite.', truncated: false, chars: 44 }
  });
  await appendEvent(SESSION, { kind: 'user_message', time: clock - 200, messageId: 'msg-edit', source: 'extension', message: { text: 'go with that plan', truncated: false, chars: 17 } });
  await appendEvent(SESSION, { kind: 'turn_start', time: clock - 100, turnId: 'turn-edit', source: 'extension' });
  await appendEvent(SESSION, { kind: 'turn_end', time: clock - 90, turnId: 'turn-edit', outcome: 'completed', source: 'extension' });

  // Without the provider's own parent lineage there is no context at all: the relay must not quote
  // the old branch's plan.
  manager.snapshot(snapshot({ messages: [{ messageId: 'msg-edit', text: 'go with that plan', authoredAt: clock - 200 }] }));
  await tick();
  expect(instructed).toHaveLength(1);
  expect(instructed[0]!.text).toBe('go with that plan');
  expect(store.getControllerMessage(SESSION, 'msg-edit')!.context_assistant_id).toBeNull();

  // With it, the exact predecessor travels — quoted, labeled, and frozen with its provenance.
  manager.snapshot(snapshot({
    messages: [{
      messageId: 'msg-plan-go',
      text: 'go with that plan',
      authoredAt: clock - 200,
      context: 'Plan: rewrite the parser, then run the suite.',
      precedingAssistantId: 'assistant-provider-plan'
    }]
  }));
  await tick();
  const routed = instructed.find(entry => entry.text.includes('go with that plan') && entry.text.includes('--- quoted from the same conversation ---'));
  expect(routed).toBeDefined();
  expect(routed!.text).toContain('Plan: rewrite the parser, then run the suite.');
  const row = store.getControllerMessage(SESSION, 'msg-plan-go')!;
  expect(row.dispatch_text).toBe(routed!.text);
  expect(row.context_assistant_id).toBe('assistant-provider-plan');
  expect(row.text).toBe('go with that plan');
});

it('holds an instruction whose composed context cannot fit the work instruction bound', async () => {
  const target = work();
  store.insertWork(target);
  bind(target.work_id);
  const huge = 'x'.repeat(70 * 1024);
  manager.snapshot(snapshot({
    messages: [{ messageId: 'msg-oversized', text: 'go', authoredAt: clock, context: huge }]
  }));
  await tick();

  // Nothing is cut to fit: a shortened plan executes incomplete requirements, so the row stays
  // pending with a truthful reason and the user's own words remain intact and retrievable.
  expect(instructed).toEqual([]);
  const row = store.getControllerMessage(SESSION, 'msg-oversized')!;
  expect(row.state).toBe('pending');
  expect(row.text).toBe('go');
  expect(row.error).toContain('do not fit');
});

it('captures a report under the binding authority that created it', async () => {
  const target = work();
  store.insertWork(target);
  bind(target.work_id);
  store.setWorkStatus(target.work_id, 'completed', 'work_completed');
  await manager.pumpNow();

  const [delivery] = store.listControllerDeliveries(SESSION);
  expect(delivery!.bound_at).toBe(clock - 10_000);
  expect(delivery!.provider_account_id).toBe(ACCOUNT);
  expect(delivery!.conversation_id).toBe(CONVERSATION);
  expect(reports[0]!.boundAt).toBe(delivery!.bound_at);
  expect(reports[0]!.providerAccountId).toBe(ACCOUNT);

  // A late acknowledgment on the same work does not produce a second final message.
  store.appendEvent(target.work_id, 'operation_completed', { operation_id: randomUUID(), tool: 'apply_patch' });
  await manager.pumpNow();
  expect(store.listControllerDeliveries(SESSION)).toHaveLength(1);
});

// --------------------------------------------------------------------------- reports

it('reports a completion exactly once and records what the outbox established', async () => {
  const target = work();
  store.insertWork(target);
  bind(target.work_id);
  store.setWorkStatus(target.work_id, 'completed', 'work_completed');

  await manager.pumpNow();
  const deliveries = store.listControllerDeliveries(SESSION);
  expect(deliveries).toHaveLength(1);
  expect(reports[0]!.sessionId).toBe(SESSION);
  expect(reports[0]!.text).toContain('[work-report] final');
  // The body is the facts a reader needs and nothing else: no policy sentence, no restatement of
  // the user's own goal or project path, and the work id is the reference that identifies it.
  expect(reports[0]!.text).toContain(`work ${target.work_id}`);
  expect(reports[0]!.text).toContain('status: completed');
  expect(reports[0]!.text).not.toContain(target.project_path);
  expect(reports[0]!.text).not.toContain(target.goal);
  // The outbox accepted it but has not acknowledged it, so the factual state is `queued`.
  expect(deliveries[0]!.state).toBe('queued');
  expect(deliveries[0]!.conversation_id).toBe(CONVERSATION);

  // A second pump over the same terminal watermark must not create another final message: the
  // watermark is durable, so the completion is reported exactly once.
  await manager.pumpNow();
  await manager.pumpNow();
  expect(store.listControllerDeliveries(SESSION)).toHaveLength(1);
});

it('addresses a report only to the binding\'s own conversation and sends nothing after stop', async () => {
  const target = work();
  store.insertWork(target);
  bind(target.work_id);
  store.setWorkStatus(target.work_id, 'completed', 'work_completed');

  // A delivery already owed to another conversation is cancelled rather than sent elsewhere.
  store.putControllerDelivery({
    delivery_id: randomUUID(), session_id: SESSION, conversation_id: 'conversation-elsewhere',
    work_id: target.work_id, bound_at: clock - 10_000, provider_account_id: ACCOUNT,
    event_sequence: 0, text: 'stale report', state: 'pending', error: null,
    created_at: clock, updated_at: clock
  });
  await manager.pumpNow();
  const stale = store.listControllerDeliveries(SESSION).find(row => row.conversation_id === 'conversation-elsewhere')!;
  expect(stale.state).toBe('cancelled');
  expect(reports.every(report => report.sessionId === SESSION)).toBe(true);

  await drainWorkContinuity();
  const before = store.listControllerDeliveries(SESSION).length;
  store.setWorkStatus(target.work_id, 'running', 'work_running');
  await manager.pumpNow();
  expect(store.listControllerDeliveries(SESSION)).toHaveLength(before);
});

it('withdraws a report the controller stopped instead of resending it', async () => {
  const target = work();
  store.insertWork(target);
  bind(target.work_id);
  store.setWorkStatus(target.work_id, 'completed', 'work_completed');
  reportResult = { state: 'unknown' };

  await manager.pumpNow();
  // An ambiguous hand-off is retained as unknown, and a later pump reconciles rather than resends.
  const [delivery] = store.listControllerDeliveries(SESSION);
  expect(delivery!.state).toBe('unknown');
  const before = reports.length;
  await manager.pumpNow();
  expect(reports.length).toBe(before);
  expect(store.listControllerDeliveries(SESSION)).toHaveLength(1);
});
