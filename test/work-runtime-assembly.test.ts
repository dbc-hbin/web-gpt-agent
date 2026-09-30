import { execFile, execFileSync } from 'node:child_process';
import { promises as fs } from 'node:fs';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, expect, it, vi } from 'vitest';
import { WORK_BLOCKER_CODES, WORK_ERROR_CODES } from '../src/shared/work.js';
import { makeTempDir, removeTempDir, writeTree, SAMPLE_BRIEF } from './helpers.js';
import { defaultConfig, initConfigPath, saveConfig, getConfig } from '../src/main/config.js';
import { flushDurable, initDurableStore, resetDurableForTests } from '../src/main/durable.js';
import { closeCorrelationStore } from '../src/main/session/correlation.js';
import { createSession, getSession, initSessionStore, rebindSession, resetSessionStoreForTests } from '../src/main/session/store.js';
import { attachSummary, beginContinuationSourceSendNow, claimContinuationNow, commitContinuationResult, continuationForSession, continuationByToken, dispatchContinuationSourceSendNow, openContinuationNow, resetContinuationsForTests } from '../src/main/session/continuation.js';
import { createWorkStore, type WorkStore } from '../src/main/work/store.js';
import { createWorktreeManager } from '../src/main/work/worktrees.js';
import {
  assertManagedCaller,
  createWorktreeActivityProbe,
  deliverWorkCommandForTests,
  drainWorkRuntime,
  hasNativeExecution,
  initWorkRuntime,
  installWorkRuntimeForTests,
  reconcileWorkRuntime,
  managedToolGate,
  workCheckpoint,
  workCheckpointSchema,
  workResume,
  resetWorkRuntimeForTests,
  setWatcherDelayForTests
} from '../src/main/work/runtime.js';
import { subscribeWorkChanges } from '../src/main/work/service.js';
import { powerHolders, resetPowerForTests } from '../src/main/power.js';
import { dispatch, ok, setManagedToolGate } from '../src/main/mcp/kernel.js';
import { emptyEvidence, type CallContext } from '../src/main/mcp/call-context.js';
import { bindConversation, onSpawnRequest, resetAgentsForTests, spawn, statusForCaller } from '../src/main/agents.js';

/**
 * The assembled runtime, end to end: a real SQLite ledger, a real Git project, real worktrees,
 * the real service and the real start/stop ownership rules.
 *
 * Nothing here waits on wall-clock time. Progress is awaited through the ledger's own change
 * stream (`store.onChanged` + `Promise.withResolvers`), which fires inside the transaction that
 * commits the change — so a wait cannot race the fact it is waiting for. The one place a timer
 * genuinely matters is the binding watcher's poll interval, and that is driven by fake timers.
 */

let root = '';
let dataDir = '';
let project = '';

/** Resolves as soon as one of `kinds` has been committed for this work, or was already there. */
function waitForEvent(store: WorkStore, workId: string, kinds: readonly string[]): Promise<void> {
  const seen = (): boolean =>
    store.readEvents({ workId, after: 0, limit: 500 }).events.some(event => kinds.includes(event.kind));
  if (seen()) return Promise.resolve();
  const { promise, resolve } = Promise.withResolvers<void>();
  const off = store.onChanged(change => {
    if (change.work_id !== workId || !seen()) return;
    off();
    resolve();
  });
  return promise;
}

beforeAll(async () => {
  root = await makeTempDir('wgpt-assembly-');
  dataDir = path.join(root, 'data');
  project = path.join(root, 'project');
  await fs.mkdir(project, { recursive: true });
  await writeTree(project, { 'src/a.txt': 'a\n', 'package.json': '{"name":"fixture"}\n' });
  const git = async (...args: string[]): Promise<void> => {
    await new Promise<void>((resolve, reject) => {
      execFile('git', args, { cwd: project }, error => (error ? reject(error) : resolve()));
    });
  };
  await git('init', '-q');
  await git('config', 'user.email', 'test@example.com');
  await git('config', 'user.name', 'Test');
  await git('add', '-A');
  await git('commit', '-qm', 'initial');
  initConfigPath(dataDir);
  initDurableStore(dataDir);
  initSessionStore(dataDir);
  const config = defaultConfig();
  await saveConfig({
    ...config,
    roots: [{ name: 'tmp', path: root }],
    capabilities: { ...config.capabilities, read: true, edit: true, create: true, deleteFile: true, command: true },
    multiAgent: { ...config.multiAgent, enabled: true }
  });
});

afterAll(async () => {
  await drainWorkRuntime();
  resetWorkRuntimeForTests();
  await flushDurable();
  resetSessionStoreForTests();
  resetDurableForTests();
  // The request-ownership ledger is a process-wide SQLite handle under this directory; Windows
  // refuses to delete a file a live connection still holds.
  closeCorrelationStore();
  await removeTempDir(root);
});

afterAll(() => resetPowerForTests());

it('projects a committed prime rebind and repairs restart drift without reviving old chat A', async () => {
  const isolated = path.join(root, 'managed-rebind');
  const store = createWorkStore({ dataDir: isolated });
  const worktrees = createWorktreeManager({ userDataDir: isolated, worktreesRoot: path.join(isolated, 'worktrees'),
    store, activity: createWorktreeActivityProbe(store) });
  const runtime = await initWorkRuntime({ dataDir: isolated, store, worktrees,
    worktreesRoot: path.join(isolated, 'worktrees'), deliverOutbox: async () => ({ state: 'delivered' }) });
  resetContinuationsForTests();
  try {
    const work = await runtime.service.start({ request_id: randomUUID(), project_path: project, goal: 'Continue the same managed task' });
    await waitForEvent(store, work.work_id, ['prime_dispatched']);
    const prime = store.getPrimeAgent(work.work_id)!;
    const a = randomUUID();
    const b = randomUUID();
    const c = randomUUID();
    await createSession({ reservedId: prime.session_id!, conversationId: a });
    await waitForEvent(store, work.work_id, ['work_started']);
    const ticket = await openContinuationNow(prime.session_id!, a);
    expect(await attachSummary(ticket.token, SAMPLE_BRIEF)).not.toBeNull();
    expect(await claimContinuationNow(ticket.token, 'managed-rebind')).not.toBeNull();
    expect((await commitContinuationResult(ticket.token, b)).status).toBe('committed');
    expect((await getSession(prime.session_id!))?.conversationId).toBe(b);
    expect(store.getAgent(prime.agent_id)?.conversation_id).toBe(b);

    // An old build or a crash can leave the ledger projection behind. Both hosts call this
    // common startup seam before the recovery owner's A deadlines are armed.
    expect(await rebindSession(prime.session_id!, b, a)).toBe(true);
    await reconcileWorkRuntime();
    expect(store.getAgent(prime.agent_id)?.conversation_id).toBe(a);
    expect((await getSession(prime.session_id!))?.bindingEpoch).toBe(2);

    const next = await openContinuationNow(prime.session_id!, a);
    expect(await attachSummary(next.token, SAMPLE_BRIEF)).not.toBeNull();
    expect(await claimContinuationNow(next.token, 'failed-projection')).not.toBeNull();
    const failed = vi.spyOn(store, 'bindAgentConversation').mockImplementationOnce(() => { throw new Error('ledger unavailable'); });
    expect(await commitContinuationResult(next.token, c)).toMatchObject({ status: 'retryable' });
    failed.mockRestore();
    expect((await getSession(prime.session_id!))?.conversationId).toBe(c);
    expect(store.getAgent(prime.agent_id)?.conversation_id).toBe(a);
    expect(continuationByToken(next.token)?.state).toBe('committing');
    expect((await commitContinuationResult(next.token, c)).status).toBe('already-committed');
    expect(store.getAgent(prime.agent_id)?.conversation_id).toBe(c);
  } finally {
    resetContinuationsForTests();
    await drainWorkRuntime();
    resetWorkRuntimeForTests();
    store.close();
  }
});

it('keeps a paused work with a missing session fenced while reconciling other primes', async () => {
  const isolated = path.join(root, 'missing-managed-session');
  const store = createWorkStore({ dataDir: isolated });
  const worktrees = createWorktreeManager({ userDataDir: isolated, worktreesRoot: path.join(isolated, 'worktrees'),
    store, activity: createWorktreeActivityProbe(store) });
  const runtime = await initWorkRuntime({ dataDir: isolated, store, worktrees,
    worktreesRoot: path.join(isolated, 'worktrees'), deliverOutbox: async () => ({ state: 'delivered' }) });
  try {
    const missing = await runtime.service.start({ request_id: randomUUID(), project_path: project, goal: 'Paused historical work' });
    await waitForEvent(store, missing.work_id, ['prime_dispatched']);
    const missingPrime = store.getPrimeAgent(missing.work_id)!;
    const oldChat = randomUUID();
    await createSession({ reservedId: missingPrime.session_id!, conversationId: oldChat });
    await waitForEvent(store, missing.work_id, ['work_started']);
    expect((await runtime.service.control({ request_id: randomUUID(), work_id: missing.work_id, action: 'pause' })).status).toBe('paused');
    // An isolated corrupt-ledger case: the historical prime points at a session that is absent.
    store.updateAgent(missingPrime.agent_id, { session_id: randomUUID() });

    const valid = await runtime.service.start({ request_id: randomUUID(), project_path: project, goal: 'Valid managed work' });
    await waitForEvent(store, valid.work_id, ['prime_dispatched']);
    const validPrime = store.getPrimeAgent(valid.work_id)!;
    const a = randomUUID();
    const b = randomUUID();
    await createSession({ reservedId: validPrime.session_id!, conversationId: a });
    await waitForEvent(store, valid.work_id, ['work_started']);
    expect(await rebindSession(validPrime.session_id!, a, b)).toBe(true);

    await reconcileWorkRuntime();
    expect(store.getWork(missing.work_id)?.status).toBe('paused');
    expect(store.getAgent(missingPrime.agent_id)?.conversation_id).toBe(oldChat);
    expect(store.getAgent(validPrime.agent_id)?.conversation_id).toBe(b);
    await expect(runtime.service.control({ request_id: randomUUID(), work_id: missing.work_id, action: 'resume' }))
      .rejects.toThrow(/no readable current session binding/);
    expect(store.getWork(missing.work_id)?.status).toBe('paused');
  } finally {
    await drainWorkRuntime();
    resetWorkRuntimeForTests();
    store.close();
  }
});

it('retire only its own pre-send failed recovery ticket and refuses a retired source', async () => {
  const isolated = path.join(root, 'managed-transfer-failure');
  const store = createWorkStore({ dataDir: isolated });
  const worktrees = createWorktreeManager({ userDataDir: isolated, worktreesRoot: path.join(isolated, 'worktrees'),
    store, activity: createWorktreeActivityProbe(store) });
  const runtime = await initWorkRuntime({ dataDir: isolated, store, worktrees,
    worktreesRoot: path.join(isolated, 'worktrees'), deliverOutbox: async () => ({ state: 'delivered' }) });
  resetContinuationsForTests();
  try {
    const makePrime = async () => {
      const work = await runtime.service.start({ request_id: randomUUID(), project_path: project, goal: 'Recover this managed task' });
      await waitForEvent(store, work.work_id, ['prime_dispatched']);
      const prime = store.getPrimeAgent(work.work_id)!;
      const a = randomUUID();
      await createSession({ reservedId: prime.session_id!, conversationId: a });
      await waitForEvent(store, work.work_id, ['work_started']);
      return { work, prime, a };
    };
    const failed = await makePrime();
    const stale = await makePrime();
    const authorized = await makePrime();
    const userTicket = await openContinuationNow(authorized.prime.session_id!, authorized.a);
    expect((await beginContinuationSourceSendNow(userTicket.token))?.allowed).toBe(true);
    expect(await dispatchContinuationSourceSendNow(userTicket.token)).toBe(true);
    vi.useFakeTimers();
    for (const { work, prime, a } of [failed, stale, authorized]) {
      expect(runtime.recovery.noteTurnFailure({ kind: 'thinking_failed', workId: work.work_id,
        agentId: prime.agent_id, sessionId: prime.session_id!, conversationId: a,
        turnId: randomUUID(), generation: prime.generation, at: Date.now() }).kind).toBe('reload');
    }
    await vi.advanceTimersByTimeAsync(60_000);
    // The work row intentionally still names retired A, reproducing the old restart ledger.
    const b = randomUUID();
    expect(await rebindSession(stale.prime.session_id!, stale.a, b)).toBe(true);
    await vi.advanceTimersByTimeAsync(120_000);
    await waitForEvent(store, failed.work.work_id, ['recovery_transfer_failed']);
    await waitForEvent(store, authorized.work.work_id, ['recovery_transfer_failed']);
    const failures = store.readEvents({ workId: failed.work.work_id, after: 0, limit: 500 }).events
      .filter(event => event.kind === 'recovery_transfer_failed');
    expect(failures.some(event => String(event.payload['reason']).includes('host checkpoint')),
      JSON.stringify({ failures, record: runtime.recovery.record(failed.prime.agent_id, failed.prime.generation),
        ticket: continuationForSession(failed.prime.session_id!) })).toBe(true);
    expect(continuationForSession(failed.prime.session_id!)).toBeNull();
    expect(store.readEvents({ workId: stale.work.work_id, after: 0, limit: 500 }).events
      .some(event => event.kind === 'recovery_transfer')).toBe(false);
    expect(continuationForSession(stale.prime.session_id!)).toBeNull();
    expect((await getSession(stale.prime.session_id!))?.conversationId).toBe(b);
    expect(continuationForSession(authorized.prime.session_id!)).toMatchObject({
      token: userTicket.token, sourceSend: { state: 'dispatched-unresolved' }
    });
  } finally {
    vi.useRealTimers();
    resetContinuationsForTests();
    await drainWorkRuntime();
    resetWorkRuntimeForTests();
    store.close();
  }
});

it('starts a work, creates real worktrees, fences pause/resume/cancel and reconciles', async () => {
  const store = createWorkStore({ dataDir });
  const deliveries: Array<{ id: string; sessionId: string | null; workId: string }> = [];
  const worktrees = createWorktreeManager({
    userDataDir: dataDir,
    worktreesRoot: path.join(dataDir, 'worktrees'),
    store,
    activity: createWorktreeActivityProbe(store)
  });
  const runtime = await initWorkRuntime({
    dataDir,
    worktreesRoot: path.join(dataDir, 'worktrees'),
    worktrees,
    store,
    deliverOutbox: async input => {
      deliveries.push({ id: input.id, sessionId: input.sessionId, workId: input.workId });
      return { state: 'queued' };
    }
  });

  // The GUI/CLI change bus must see real commits, not just be constructible.
  const changes: Array<{ work_id: string; revision: number; kind: string }> = [];
  const detach = subscribeWorkChanges(change => changes.push({ work_id: change.work_id, revision: change.revision, kind: change.kind }));

  // A non-Git folder is refused before admission.
  await expect(runtime.service.start({ request_id: randomUUID(), project_path: root, goal: 'x' }))
    .rejects.toThrow(/PROJECT_NOT_GIT/);

  const receipt = await runtime.service.start({ request_id: randomUUID(), project_path: project, goal: 'add a line to src/a.txt', max_workers: 2 });
  expect(receipt.status).toBe('queued');
  expect(receipt.integration_branch).toBe(`wgpt/${receipt.work_id}/main`);

  // The start stage is fire-and-forget from the receipt: await its own committed facts.
  const integration = receipt.integration_worktree!;
  await waitForEvent(store, receipt.work_id, ['worktree_assigned']);
  // `worktree_assigned` is committed after the baseline, so the checkout is already populated.
  // Git's own checkout of the baseline blob, so a host that converts line endings on checkout
  // (`core.autocrlf=true` on Windows) is compared against the bytes Git itself would write.
  const readGit = (args: string[]): string => execFileSync('git', args, { cwd: integration, encoding: 'utf8' });
  expect(readGit(['show', 'HEAD:src/a.txt'])).toBe('a\n');
  expect(await fs.readFile(path.join(integration, 'src/a.txt'), 'utf8')).toBe(readGit(['cat-file', '--filters', 'HEAD:src/a.txt']));
  const work = store.getWork(receipt.work_id)!;
  expect(work.base_commit).toMatch(/^[0-9a-f]{40}$/);
  // The assigned folder must resolve through the sandbox.
  expect(getConfig().roots.length).toBeGreaterThan(0);
  expect(deliveries).toHaveLength(1);
  // The opening send names its work, so the outbox's own Send authority can fence it: a managed
  // instruction must not reach a work the user has stopped.
  expect(deliveries[0]!.workId).toBe(receipt.work_id);

  // The prime binds when its reserved session shows a conversation.
  const prime = store.getPrimeAgent(receipt.work_id)!;
  await createSession({ reservedId: prime.session_id!, conversationId: 'conv-smoke-aaaaaaaa' });
  await waitForEvent(store, receipt.work_id, ['work_started']);
  expect(store.getWork(receipt.work_id)!.status).toBe('running');
  expect(store.getAgent(prime.agent_id)!.conversation_id).toBe('conv-smoke-aaaaaaaa');

  // A managed call from that exact conversation resolves; an unrelated one is refused.
  const callerContext = (conversationId: string | null, sessionId: string | null) => ({
    startedAt: Date.now(), transportKey: null, agent: null, outcome: null,
    evidence: { changes: [], assets: [], count: null, detail: null, exitCode: null, timedOut: false, durationMs: null, running: null, processSessionId: null },
    caller: { transportKey: null, requestId: null, conversationId, sessionId }
  }) as never;
  const identity = assertManagedCaller(callerContext('conv-smoke-aaaaaaaa', prime.session_id));
  expect(identity.workId).toBe(receipt.work_id);
  expect(identity.worktreePath).toBe(integration);
  expect(() => assertManagedCaller(callerContext('conv-unrelated', null))).toThrow(/WORKER_CONNECTION_REQUIRED/);

  const boundResume = await workResume({}, callerContext('conv-smoke-aaaaaaaa', prime.session_id));
  expect(boundResume.isError).not.toBe(true);
  const boundText = boundResume.content.filter(block => block.type === 'text').map(block => block.text).join('\n');
  expect(boundText).toContain('managed_connection: bound');
  expect(boundText).toContain('target_source: conversation');
  expect(boundText).toContain(`agent_id: ${prime.agent_id}`);
  expect(boundText).toContain(`role: ${prime.role}`);
  expect(boundText).toContain(`generation: ${prime.generation}`);

  const unboundResume = await workResume({}, callerContext('conv-unrelated', null));
  expect(unboundResume.isError).not.toBe(true);
  const unboundText = unboundResume.content.filter(block => block.type === 'text').map(block => block.text).join('\n');
  expect(unboundText).toContain('managed_connection: unbound');

  expect(unboundText).not.toContain('work_id:');

  const unboundCheckpoint = await workCheckpoint({
    operation_id: randomUUID(), summary: 'ordinary checkpoint', remaining: [], verification: []
  }, callerContext('conv-unrelated', null));
  expect(unboundCheckpoint.isError).toBe(true);
  expect(unboundCheckpoint.content.some(block => block.type === 'text' && block.text.startsWith('WORK_NOT_BOUND:'))).toBe(true);
  expect(store.getWork(receipt.work_id)!.checkpoint).toBeNull();

  // A bound, running work must not impose operation ids on ordinary coding.
  const mutationPath = path.join(integration, 'receipt.txt');
  const codingResult = await managedToolGate(
    { name: 'apply_patch', surface: 'core', args: { patch: `*** Begin Patch\n*** Add File: ${mutationPath}\n+written\n*** End Patch` },
      context: callerContext('conv-smoke-aaaaaaaa', prime.session_id) },
    async () => { await fs.writeFile(mutationPath, 'written\n'); return ok('written'); }
  );
  expect(codingResult.isError).not.toBe(true);
  expect(await fs.readFile(mutationPath, 'utf8')).toBe('written\n');
  expect(store.listOperationsForAgent(prime.agent_id, prime.generation)).toEqual([]);

  // Pause fences the *work lifecycle*, not the coding tools. A chat whose work is paused — or
  // stale, superseded or gone — still reads, runs and patches; only a command that is *about*
  // the work is refused by name. This is the whole point of the gate being about work.
  const paused = await runtime.service.control({ request_id: randomUUID(), work_id: receipt.work_id, action: 'pause' });
  expect(paused.status).toBe('paused');
  expect(store.getWork(receipt.work_id)!.status).toBe('paused');
  expect(() => assertManagedCaller(callerContext('conv-smoke-aaaaaaaa', prime.session_id))).toThrow(/WORK_NOT_RUNNING/);
  const pausedResume = await workResume({}, callerContext('conv-smoke-aaaaaaaa', prime.session_id));
  expect(pausedResume.isError).toBe(true);
  expect(pausedResume.content.some(block => block.type === 'text' && block.text.startsWith('WORK_NOT_RUNNING:'))).toBe(true);
  {
    const bound = callerContext('conv-smoke-aaaaaaaa', prime.session_id);
    let codingRan = false;
    const coding = await managedToolGate(
      { name: 'exec_command', surface: 'core', args: { cmd: 'echo fixture', workdir: integration }, context: bound },
      () => { codingRan = true; return Promise.resolve(ok('ran while the work was paused')); }
    );
    expect(coding.isError, JSON.stringify(coding.content)).not.toBe(true);
    expect(codingRan).toBe(true);
    // It earns no receipt, because it is not an operation of any work.
    expect(store.listOperations(receipt.work_id, 500).filter(row => row.tool === 'exec_command')).toEqual([]);

    const lifecycle = await managedToolGate(
      { name: 'agents', surface: 'core', args: { action: 'status' }, context: bound },
      () => Promise.resolve(ok('must not run'))
    );
    expect(lifecycle.isError).toBe(true);
    expect(JSON.stringify(lifecycle.content)).toContain('WORK_NOT_RUNNING');
  }

  // Resume lifts the fence and the agent is active again.
  const resumed = await runtime.service.control({ request_id: randomUUID(), work_id: receipt.work_id, action: 'resume' });
  expect(resumed.status).toBe('running');
  expect(store.getWork(receipt.work_id)!.status).toBe('running');

  // A managed instruction reaches the outbox through the REAL port, and the row it creates names
  // the work it answers to. That is what lets the outbox's own final Send refuse a stopped work
  // instead of delivering into it.
  await runtime.service.instruct({ request_id: randomUUID(), work_id: receipt.work_id, text: 'run the focused suite' });
  await runtime.service.pumpNow();
  expect(deliveries).toHaveLength(2);
  expect(deliveries[1]!.workId).toBe(receipt.work_id);
  expect(deliveries[1]!.sessionId).toBe(prime.session_id);

  // Reconciliation is idempotent and creates no second opening input.
  await runtime.service.reconcile();
  expect(deliveries).toHaveLength(2);

  // The power assertion follows the durable lifecycle; two works hold independently.
  expect(powerHolders()).toContain(`work:${receipt.work_id}`);
  const second = await runtime.service.start({ request_id: randomUUID(), project_path: project, goal: 'second work', max_workers: 1 });
  expect(powerHolders()).toContain(`work:${second.work_id}`);
  expect(powerHolders().filter(name => name.startsWith('work:'))).toHaveLength(2);
  await runtime.service.control({ request_id: randomUUID(), work_id: second.work_id, action: 'pause' });
  expect(powerHolders()).not.toContain(`work:${second.work_id}`);
  expect(powerHolders()).toContain(`work:${receipt.work_id}`);

  // The first-login path: a work blocked before its prime chat opened retries the SAME opening
  // outbox row on resume rather than flipping the status with an unbound prime.
  const pending = await runtime.service.start({ request_id: randomUUID(), project_path: project, goal: 'await first login', max_workers: 1 });
  await waitForEvent(store, pending.work_id, ['prime_dispatched']);
  const pendingPrime = store.getPrimeAgent(pending.work_id)!;
  store.setWorkStatus(pending.work_id, 'blocked', 'work_blocked');
  store.setBlocker(pending.work_id, { code: 'AUTH_REQUIRED', detail: 'sign in required', at: Date.now() }, 'work_blocked');
  const resumedPending = await runtime.service.control({ request_id: randomUUID(), work_id: pending.work_id, action: 'resume' });
  if (store.getAgent(pendingPrime.agent_id)!.conversation_id === null && store.getWork(pending.work_id)!.status === 'running') {
    throw new Error('resume reported running with an unbound prime');
  }
  expect(['running', 'blocked', 'starting', 'recovering']).toContain(resumedPending.status);
  expect(store.readEvents({ workId: pending.work_id, after: 0, limit: 500 }).events
    .some(event => ['resume_retry', 'resume_retry_refused', 'resume_restart_admission'].includes(event.kind))).toBe(true);

  // An early pause that lands before the prime's opening row exists must stop the opening, and
  // the resume must repeat admission under the ORIGINAL start command id.
  const early = await runtime.service.start({ request_id: randomUUID(), project_path: project, goal: 'pause mid start', max_workers: 1 });
  const pausedEarly = await runtime.service.control({ request_id: randomUUID(), work_id: early.work_id, action: 'pause' });
  expect(pausedEarly.status).toBe('paused');
  const earlyPrime = store.getPrimeAgent(early.work_id)!;
  const earlyWorktree = store.getWorktreeAssignment(early.work_id, earlyPrime.agent_id);
  const resumedEarly = await runtime.service.control({ request_id: randomUUID(), work_id: early.work_id, action: 'resume' });
  expect(['running', 'starting', 'recovering', 'blocked']).toContain(resumedEarly.status);
  const earlyAfter = store.getWork(early.work_id)!;
  if (earlyAfter.status === 'recovering') {
    // A resume may never leave a work recovering with no way to open its prime.
    expect(store.getPrimeAgent(early.work_id)!.session_id).not.toBeNull();
  }
  expect(store.readEvents({ workId: early.work_id, after: 0, limit: 500 }).events
    .some(event => event.kind === 'resume_restart_admission' || event.kind === 'resume_retry')).toBe(true);
  if (earlyWorktree) {
    expect(store.getWorktreeAssignment(early.work_id, earlyPrime.agent_id)!.path).toBe(earlyWorktree.path);
  }
  // Cancel is terminal and survives reconciliation.
  expect((await runtime.service.control({ request_id: randomUUID(), work_id: early.work_id, action: 'cancel' })).status).toBe('cancelled');
  await runtime.service.reconcile();
  expect(store.getWork(early.work_id)!.status).toBe('cancelled');

  // The change bus saw this work's committed transitions with its own revision.
  expect(changes.some(change => change.work_id === receipt.work_id && change.revision > 0)).toBe(true);
  expect(new Set(changes.map(change => change.kind)).size).toBeGreaterThan(2);

  // A work admitted but never started (the host died between the receipt and the prime binding)
  // is redispatched by reconciliation under its ORIGINAL start command id.
  const interruptedId = randomUUID();
  const interruptedRequest = randomUUID();
  const at = Date.now();
  store.insertWork({
    work_id: interruptedId, title: 'interrupted', goal: 'finish the interrupted work',
    project_path: project, project_name: 'project', base_commit: null,
    integration_branch: `wgpt/${interruptedId}/main`,
    integration_worktree: path.join(dataDir, 'worktrees', interruptedId, 'main'),
    status: 'queued', desired_state: null, prime_agent_id: null, prime_session_id: null,
    model: null, reasoning: null, max_workers: 2, revision: 0, blocker: null,
    checkpoint: null, integration_intent: null, predecessor_work_id: null, successor_work_id: null,
    created_at: at, updated_at: at
  });
  store.insertAgent({
    agent_id: randomUUID(), work_id: interruptedId, parent_id: null, role: 'prime', label: 'prime',
    state: 'pending', session_id: interruptedRequest, conversation_id: null, generation: 0,
    worktree_path: null, branch: null, base_commit: null, model: null, reasoning: null,
    result_ref: null, checkpoint_ref: null, created_at: at, updated_at: at
  });
  store.insertCommand({
    request_id: interruptedRequest, work_id: interruptedId, kind: 'start', input_hash: 'x',
    text: 'finish the interrupted work', delivery_state: 'delivered', outbox_input_id: interruptedRequest,
    result_json: null, attempts: 1, last_error: null, created_at: at, updated_at: at
  });
  await runtime.service.reconcile();
  await waitForEvent(store, interruptedId, ['worktree_assigned']);
  expect(deliveries.map(delivery => delivery.id)).toContain(interruptedRequest);
  expect(store.getWork(interruptedId)!.base_commit).toMatch(/^[0-9a-f]{40}$/);
  // The host-quit contract: an explicit stop pauses the work and names the reason, so the user
  // knows it must be resumed — while a cancelled work keeps its terminal status and a work with
  // a more specific blocker keeps that blocker.
  const quit = await runtime.service.start({ request_id: randomUUID(), project_path: project, goal: 'host quit contract', max_workers: 1 });
  await waitForEvent(store, quit.work_id, ['prime_dispatched']);
  await drainWorkRuntime();
  resetWorkRuntimeForTests();
  const quitAfter = store.getWork(quit.work_id)!;
  expect(quitAfter.status).toBe('paused');
  expect(quitAfter.blocker?.code).toBe('HOST_STOPPED');
  expect(powerHolders().filter(name => name.startsWith('work:'))).toHaveLength(0);
  // The cancelled work from earlier is untouched by the same drain.
  expect(store.getWork(early.work_id)!.status).toBe('cancelled');
  // A work whose blocker is an unresolved operation keeps that blocker rather than HOST_STOPPED.
  const unknown = await runtime.service.start({ request_id: randomUUID(), project_path: project, goal: 'unknown op', max_workers: 1 });
  await waitForEvent(store, unknown.work_id, ['prime_dispatched']);
  store.setBlocker(unknown.work_id, {
    code: 'OPERATION_OUTCOME_UNKNOWN',
    detail: 'a command may already have taken effect',
    at: Date.now()
  }, 'work_blocked');
  await drainWorkRuntime();
  resetWorkRuntimeForTests();
  expect(store.getWork(unknown.work_id)!.blocker?.code).toBe('OPERATION_OUTCOME_UNKNOWN');

  detach();
  store.close();
});

it('does not bind an ordinary broker worker into a managed row with the same local id', async () => {
  const hookData = path.join(root, 'hook-provenance');
  const store = createWorkStore({ dataDir: hookData });
  const worktrees = createWorktreeManager({ userDataDir: hookData,
    worktreesRoot: path.join(hookData, 'worktrees'), store, activity: createWorktreeActivityProbe(store) });
  const runtime = await initWorkRuntime({ dataDir: hookData, store, worktrees,
    worktreesRoot: path.join(hookData, 'worktrees'), deliverOutbox: async () => ({ state: 'delivered' }) });
  let removeSpawnHook: (() => void) | null = null;
  try {
    const work = await runtime.service.start({ request_id: randomUUID(), project_path: project, goal: 'Hook provenance fixture' });
    await waitForEvent(store, work.work_id, ['prime_dispatched']);
    const prime = store.getPrimeAgent(work.work_id)!;
    const primeConversation = 'conv-hook-prime';
    await createSession({ reservedId: prime.session_id!, conversationId: primeConversation });
    await waitForEvent(store, work.work_id, ['work_started']);

    const prepared = Promise.withResolvers<Array<{ id: string; task: string }>>();
    removeSpawnHook = onSpawnRequest(workers => {
      const managed = workers.filter(worker => worker.primeConversationId === primeConversation);
      if (managed.length > 0) prepared.resolve(managed.map(worker => ({ id: worker.id, task: worker.task })));
    });
    const managedRun = spawn({ workers: [{ label: 'managed worker', task: 'managed task' }], caller: { conversationId: primeConversation } });
    const managedBootstrap = await prepared.promise;
    expect(managedBootstrap[0]?.id).toBe('worker-1');
    expect(managedBootstrap[0]?.task).toContain(`Work: ${work.work_id}`);
    const managedAgent = store.getAgent('worker-1');
    expect(managedAgent).toMatchObject({
      work_id: work.work_id,
      parent_id: prime.agent_id,
      role: 'worker',
      state: 'pending'
    });
    expect(managedAgent?.worktree_path).toBe(path.join(hookData, 'worktrees', work.work_id, 'worker-1'));
    expect(managedAgent?.branch).toBe(`wgpt/${work.work_id}/worker-1`);
    await waitForEvent(store, work.work_id, ['agent_registered']);

    const ordinaryRun = spawn({ workers: [{ label: 'ordinary worker', task: 'ordinary task' }], caller: { conversationId: 'conv-hook-ordinary-prime' } });
    expect(bindConversation('worker-1', 'conv-hook-ordinary-worker', ordinaryRun.runId)).toBe(true);
    expect(store.getAgent('worker-1')?.conversation_id).toBeNull();

    expect(bindConversation('worker-1', 'conv-hook-managed-worker', managedRun.runId)).toBe(true);
    expect(store.getAgent('worker-1')?.conversation_id).toBe('conv-hook-managed-worker');
  } finally {
    removeSpawnHook?.();
    await drainWorkRuntime();
    resetWorkRuntimeForTests();
    resetAgentsForTests();
    store.close();
  }
});

it('retires only failed managed preparations and never dispatches their raw tasks', async () => {
  const failureData = path.join(root, 'worker-prepare-failure');
  const store = createWorkStore({ dataDir: failureData });
  const worktreesRoot = path.join(failureData, 'worktrees');
  const worktrees = createWorktreeManager({ userDataDir: failureData, worktreesRoot, store, activity: createWorktreeActivityProbe(store) });
  const runtime = await initWorkRuntime({ dataDir: failureData, store, worktrees, worktreesRoot,
    deliverOutbox: async () => ({ state: 'delivered' }) });
  let removeSpawnHook: (() => void) | null = null;
  try {
    const work = await runtime.service.start({ request_id: randomUUID(), project_path: project, goal: 'Preparation failure fixture' });
    await waitForEvent(store, work.work_id, ['prime_dispatched']);
    const prime = store.getPrimeAgent(work.work_id)!;
    const primeConversation = 'conv-prepare-failure-prime';
    await createSession({ reservedId: prime.session_id!, conversationId: primeConversation });
    await waitForEvent(store, work.work_id, ['work_started']);

    const blockedPath = path.join(worktreesRoot, work.work_id, 'worker-1');
    await fs.mkdir(blockedPath, { recursive: true });
    await fs.writeFile(path.join(blockedPath, 'owned-by-user'), 'do not delete');

    const dispatched = Promise.withResolvers<Array<{ id: string; task: string }>>();
    removeSpawnHook = onSpawnRequest(workers => dispatched.resolve(workers.map(worker => ({ id: worker.id, task: worker.task }))));
    const run = spawn({ workers: [
      { label: 'blocked worker', task: 'raw blocked task' },
      { label: 'prepared worker', task: 'safe managed task' }
    ], caller: { conversationId: primeConversation } });

    const bootstraps = await dispatched.promise;
    expect(bootstraps.map(worker => worker.id)).toEqual(['worker-2']);
    expect(bootstraps[0]?.task).toContain(`Work: ${work.work_id}`);
    expect(bootstraps.some(worker => worker.task === 'raw blocked task')).toBe(false);
    expect(store.getAgent('worker-1')).toBeNull();
    expect(store.getWorktreeAssignment(work.work_id, 'worker-1')).toBeNull();
    expect(await fs.readFile(path.join(blockedPath, 'owned-by-user'), 'utf8')).toBe('do not delete');
    expect(store.getWorktreeAssignment(work.work_id, 'worker-2')).toMatchObject({
      workId: work.work_id,
      agentId: 'worker-2',
      role: 'worker'
    });

    const broker = statusForCaller({ conversationId: primeConversation, runId: run.runId });
    expect(broker.state.agents.find(agent => agent.id === 'worker-1')).toMatchObject({
      state: 'failed',
      result: expect.stringContaining('already exists but is not a worktree')
    });
  } finally {
    removeSpawnHook?.();
    await drainWorkRuntime();
    resetWorkRuntimeForTests();
    resetAgentsForTests();
    store.close();
  }
});

it('completes through its own checkpoint receipt but refuses any other live mutation', async () => {
  const checkpointData = path.join(root, 'checkpoint');
  const store = createWorkStore({ dataDir: checkpointData });
  const worktrees = createWorktreeManager({ userDataDir: checkpointData,
    worktreesRoot: path.join(checkpointData, 'worktrees'), store, activity: createWorktreeActivityProbe(store) });
  const runtime = await initWorkRuntime({ dataDir: checkpointData, store, worktrees,
    worktreesRoot: path.join(checkpointData, 'worktrees'), deliverOutbox: async () => ({ state: 'delivered' }) });
  try {
    const work = await runtime.service.start({ request_id: randomUUID(), project_path: project, goal: 'Verify checkpoint completion' });
    await waitForEvent(store, work.work_id, ['prime_dispatched']);
    const prime = store.getPrimeAgent(work.work_id)!;
    const conversationId = 'conv-checkpoint-completion';
    await createSession({ reservedId: prime.session_id!, conversationId });
    await waitForEvent(store, work.work_id, ['work_started']);
    const context: CallContext = { startedAt: Date.now(), transportKey: null, agent: null, outcome: null,
      evidence: emptyEvidence(), caller: { transportKey: null, requestId: null, conversationId, sessionId: prime.session_id } };
    const identity = assertManagedCaller(context);
    const other = randomUUID();
    const admission = await runtime.operations.admit({ operationId: other, workId: work.work_id, agentId: prime.agent_id,
      generation: identity.generation, tool: 'apply_patch', args: { patch: 'pending' }, sessionId: prime.session_id });
    expect(admission.kind).toBe('admitted');
    runtime.operations.markRunning(other);
    const input = workCheckpointSchema.parse({ operation_id: randomUUID(), summary: 'done', remaining: [], verification: [], complete: true });
    const refused = await managedToolGate({ name: 'work_checkpoint', surface: 'core', args: input, context },
      () => workCheckpoint(input, context));
    expect(refused.isError).toBe(true);
    expect(refused.content.some(block => block.type === 'text' && block.text.startsWith('OPERATIONS_OUTSTANDING:'))).toBe(true);
    expect(store.getWork(work.work_id)!.status).toBe('running');
    await runtime.operations.complete({ operationId: other, result: ok('settled'), sessionId: prime.session_id });
    const uncertain = randomUUID();
    await runtime.operations.admit({ operationId: uncertain, workId: work.work_id, agentId: prime.agent_id,
      generation: identity.generation, tool: 'mcp_call', args: {}, sessionId: prime.session_id });
    runtime.operations.markRunning(uncertain);
    runtime.operations.markUnknown(uncertain, 'reply lost');
    const unresolved = randomUUID();
    await runtime.operations.admit({ operationId: unresolved, workId: work.work_id, agentId: prime.agent_id,
      generation: identity.generation, tool: 'mcp_call', args: { next: true }, sessionId: prime.session_id });
    runtime.operations.markRunning(unresolved);
    runtime.operations.markUnknown(unresolved, 'another reply lost');
    store.setBlocker(work.work_id, { code: WORK_BLOCKER_CODES.operationOutcomeUnknown, detail: 'Inspect unknown effects', at: Date.now() }, 'work_blocked');
    await runtime.service.control({ request_id: randomUUID(), work_id: work.work_id, action: 'pause' });
    await runtime.service.instruct({ request_id: randomUUID(), work_id: work.work_id, text: 'Accept observed effects',
      resolve_operations: [{ operation_id: uncertain, decision: 'accept_observed_effects', note: 'effect verified' }] });
    expect(store.getWork(work.work_id)!.blocker?.code).toBe(WORK_BLOCKER_CODES.operationOutcomeUnknown);
    await expect(runtime.service.control({ request_id: randomUUID(), work_id: work.work_id, action: 'resume' }))
      .rejects.toMatchObject({ code: WORK_ERROR_CODES.operationUnknownUnresolved });
    await runtime.service.instruct({ request_id: randomUUID(), work_id: work.work_id, text: 'Authorize the remaining retry',
      resolve_operations: [{ operation_id: unresolved, decision: 'authorize_retry', note: 'user authorized' }] });
    expect(store.getWork(work.work_id)!.blocker).toBeNull();
    expect(store.getOperation(uncertain)!.resolution?.decision).toBe('accept_observed_effects');
    expect((await runtime.service.control({ request_id: randomUUID(), work_id: work.work_id, action: 'resume' })).status).toBe('running');
    // The two resolution instructions above are real user instructions, so completion refuses while
    // they have not reached the conversation. Drive the pump to their factual delivery — that is
    // the production precondition, not something the guard should be relaxed for.
    await runtime.service.pumpNow();
    expect(store.listPendingCommands(work.work_id, 10).filter(command => command.kind === 'instruct')).toEqual([]);
    const final = { ...input, operation_id: randomUUID() };
    const completed = await managedToolGate({ name: 'work_checkpoint', surface: 'core', args: final, context },
      () => workCheckpoint(final, context));
    expect(completed.isError).not.toBe(true);
    expect(store.getWork(work.work_id)!.status).toBe('completed');
    expect(store.getOperation(final.operation_id)!.state).toBe('completed');
  } finally {
    await drainWorkRuntime();
    resetWorkRuntimeForTests();
    store.close();
  }
});

it('does not terminalize a stopped instruction whose row is not in the outbox yet', async () => {
  const stopData = path.join(root, 'stop-before-admission');
  const store = createWorkStore({ dataDir: stopData });
  const worktrees = createWorktreeManager({ userDataDir: stopData,
    worktreesRoot: path.join(stopData, 'worktrees'), store, activity: createWorktreeActivityProbe(store) });
  const rows = new Map<string, { state: 'queued' | 'delivered' | 'unknown' | 'failed' | 'cancelled' }>();
  let readsFail = false;
  const runtime = await initWorkRuntime({ dataDir: stopData, store, worktrees,
    worktreesRoot: path.join(stopData, 'worktrees'),
    deliverOutbox: async input => {
      const existing = rows.get(input.id);
      if (existing) return { state: existing.state };
      rows.set(input.id, { state: 'queued' });
      return { state: 'queued' };
    },
    readOutbox: async id => {
      if (readsFail) throw new Error('outbox unreadable');
      return rows.get(id) ?? null;
    }
  });
  try {
    const work = await runtime.service.start({ request_id: randomUUID(), project_path: project, goal: 'Stop before admission fixture' });
    await waitForEvent(store, work.work_id, ['prime_dispatched']);
    const prime = store.getPrimeAgent(work.work_id)!;
    await createSession({ reservedId: prime.session_id!, conversationId: 'conv-stop-before-admission' });
    await waitForEvent(store, work.work_id, ['work_started']);
    const opening = store.getWork(work.work_id)!.prime_session_id!;
    rows.delete(opening);

    // A successful read that finds nothing is "not admitted yet" — the start stage may be inside its
    // own send, so the command stays pending for a later pump rather than being terminalized.
    await runtime.service.control({ request_id: randomUUID(), work_id: work.work_id, action: 'cancel' });
    expect(store.getWork(work.work_id)!.status).toBe('cancelled');
    const absent = await deliverWorkCommandForTests({ workId: work.work_id, requestId: randomUUID(),
      kind: 'instruct', text: 'raced with the opening', outboxInputId: opening, attempt: 1, commandCreatedAt: Date.now() });
    expect(absent).toEqual({ state: 'deferred', detail: 'the instruction has not reached the outbox yet, so its outcome cannot be settled' });
    expect(rows.size).toBe(0);

    // A read that *failed* proves nothing at all, so it stays unresolved instead of being called
    // cancelled — the two cases are different facts.
    readsFail = true;
    const unreadable = await deliverWorkCommandForTests({ workId: work.work_id, requestId: randomUUID(),
      kind: 'instruct', text: 'raced with the opening', outboxInputId: opening, attempt: 1, commandCreatedAt: Date.now() });
    expect(unreadable).toMatchObject({ state: 'unknown' });
    expect(String((unreadable as { error?: string }).error)).toContain('could not be read');
  } finally {
    await drainWorkRuntime();
    resetWorkRuntimeForTests();
    store.close();
  }
});

it('never lets a linked instruction claim the successor opening input id', async () => {
  const linkedData = path.join(root, 'linked-opening');
  const store = createWorkStore({ dataDir: linkedData });
  const worktrees = createWorktreeManager({ userDataDir: linkedData,
    worktreesRoot: path.join(linkedData, 'worktrees'), store, activity: createWorktreeActivityProbe(store) });
  /** The rows this fixture's outbox actually holds, keyed by input id. */
  const rows = new Map<string, { state: 'queued' | 'delivered' | 'unknown' | 'failed' | 'cancelled'; text: string }>();
  const runtime = await initWorkRuntime({ dataDir: linkedData, store, worktrees,
    worktreesRoot: path.join(linkedData, 'worktrees'),
    deliverOutbox: async input => {
      const existing = rows.get(input.id);
      // An existing id is a pure read, exactly as the real outbox behaves.
      if (existing) return { state: existing.state };
      rows.set(input.id, { state: 'queued', text: input.text });
      return { state: 'queued' };
    },
    readOutbox: async id => rows.get(id) ?? null
  });
  try {
    const work = await runtime.service.start({ request_id: randomUUID(), project_path: project, goal: 'Linked opening fixture' });
    await waitForEvent(store, work.work_id, ['prime_dispatched']);
    const prime = store.getPrimeAgent(work.work_id)!;
    await createSession({ reservedId: prime.session_id!, conversationId: 'conv-linked-opening' });
    await waitForEvent(store, work.work_id, ['work_started']);
    const opening = store.getWork(work.work_id)!.prime_session_id!;
    expect(rows.get(opening)?.state).toBe('queued');

    // A linked instruction (its outbox id is the opening's, not its own request id) must only read
    // and reconcile the opening: no second row, and `queued` — never `delivered` — until the
    // opening is actually acknowledged.
    const linkedRequest = randomUUID();
    const linked = await deliverWorkCommandForTests({ workId: work.work_id, requestId: linkedRequest,
      kind: 'instruct', text: 'the followup', outboxInputId: opening, attempt: 1, commandCreatedAt: Date.now() });
    expect(linked.state).toBe('queued');
    expect(rows.size).toBe(1);
    expect(rows.get(opening)!.text).not.toBe('the followup');

    // An unadmitted opening is a wait, never a claim: the start stage owns that row.
    const absent = await deliverWorkCommandForTests({ workId: work.work_id, requestId: randomUUID(),
      kind: 'instruct', text: 'orphan followup', outboxInputId: randomUUID(), attempt: 1, commandCreatedAt: Date.now() });
    expect(absent).toEqual({ state: 'deferred', detail: 'the opening message has not been admitted yet' });
    expect(rows.size).toBe(1);

    // Once the opening is acknowledged, the linked command reads that receipt.
    rows.set(opening, { state: 'delivered', text: rows.get(opening)!.text });
    const after = await deliverWorkCommandForTests({ workId: work.work_id, requestId: linkedRequest,
      kind: 'instruct', text: 'the followup', outboxInputId: opening, attempt: 2, commandCreatedAt: Date.now() });
    expect(after).toEqual({ state: 'delivered' });
    expect(rows.size).toBe(1);
  } finally {
    await drainWorkRuntime();
    resetWorkRuntimeForTests();
    store.close();
  }
});

it('records native-execution evidence only for a provider request that really admitted managed work', async () => {
  const evidenceData = path.join(root, 'native-evidence');
  const store = createWorkStore({ dataDir: evidenceData });
  const worktrees = createWorktreeManager({ userDataDir: evidenceData,
    worktreesRoot: path.join(evidenceData, 'worktrees'), store, activity: createWorktreeActivityProbe(store) });
  const runtime = await initWorkRuntime({ dataDir: evidenceData, store, worktrees,
    worktreesRoot: path.join(evidenceData, 'worktrees'), deliverOutbox: async () => ({ state: 'delivered' }) });
  try {
    const work = await runtime.service.start({ request_id: randomUUID(), project_path: project, goal: 'Prove native execution evidence' });
    await waitForEvent(store, work.work_id, ['prime_dispatched']);
    const prime = store.getPrimeAgent(work.work_id)!;
    const conversationId = 'conv-native-evidence';
    await createSession({ reservedId: prime.session_id!, conversationId });
    await waitForEvent(store, work.work_id, ['work_started']);
    // The provider's own request id, exactly as the connector carries it.
    const providerRequest = `wfr_${randomUUID().replace(/-/g, '')}`;
    const context: CallContext = { startedAt: Date.now(), transportKey: null, agent: null, outcome: null,
      evidence: emptyEvidence(), caller: { transportKey: null, requestId: providerRequest, conversationId, sessionId: prime.session_id } };

    // A refused call admits nothing, so it records nothing.
    const missing = await managedToolGate({ name: 'work_checkpoint', surface: 'core', args: { summary: 'Checkpoint', work_id: work.work_id }, context },
      () => Promise.resolve(ok('never runs')));
    expect(missing.isError).toBe(true);
    expect(hasNativeExecution({ workId: work.work_id, providerRequestId: providerRequest })).toBe(false);

    // An admitted mutation is the evidence: it carries this provider request id under this work.
    const operationId = randomUUID();
    const admitted = await managedToolGate({ name: 'work_checkpoint', surface: 'core', args: { summary: 'Checkpoint', work_id: work.work_id, operation_id: operationId }, context },
      () => Promise.resolve(ok('patched')));
    expect(admitted.isError).not.toBe(true);
    expect(hasNativeExecution({ workId: work.work_id, providerRequestId: providerRequest })).toBe(true);

    const events = store.readEvents({ workId: work.work_id, after: 0, limit: 500 }).events
      .filter(event => event.kind === 'native_execution');
    expect(events).toHaveLength(1);
    expect(events[0]!.payload).toMatchObject({
      provider_request_id: providerRequest,
      agent_id: prime.agent_id,
      operation_id: operationId
    });

    // The same provider request stays one evidence row however many calls it covers.
    await managedToolGate({ name: 'work_checkpoint', surface: 'core', args: { summary: 'Checkpoint', work_id: work.work_id, operation_id: randomUUID() }, context },
      () => Promise.resolve(ok('patched again')));
    expect(store.readEvents({ workId: work.work_id, after: 0, limit: 500 }).events
      .filter(event => event.kind === 'native_execution')).toHaveLength(1);

    // An accepted execution can lie arbitrarily far behind: bury it under unrelated events and the
    // proof must still be found, because a bounded tail would report "never ran" for a request that
    // really did — and that is exactly how an already-handled message gets relayed twice.
    for (let index = 0; index < 700; index++) store.appendEvent(work.work_id, 'noise', { index });
    expect(hasNativeExecution({ workId: work.work_id, providerRequestId: providerRequest })).toBe(true);

    // A failed evidence write refuses the call outright: the receipt is the duplicate-prevention
    // authority, so a mutation must never run without it, and nothing may be cached. A fresh
    // provider request is used so the write is genuinely attempted.
    const unwrittenRequest = `wfr_${randomUUID().replace(/-/g, '')}`;
    const unwrittenContext: CallContext = { ...context,
      caller: { ...context.caller, requestId: unwrittenRequest } };
    // Only the evidence write fails: the admission's own event must still land, so this refuses the
    // call rather than breaking the ledger.
    const realAppend = store.appendEvent.bind(store);
    const failing = vi.spyOn(store, 'appendEvent').mockImplementation((workId, kind, payload) => {
      if (kind === 'native_execution') throw new Error('ledger write failed');
      return realAppend(workId, kind, payload);
    });
    const refused = await managedToolGate({ name: 'work_checkpoint', surface: 'core', args: { summary: 'Checkpoint', work_id: work.work_id, operation_id: randomUUID() }, context: unwrittenContext },
      () => Promise.resolve(ok('must not run')));
    failing.mockRestore();
    expect(refused.isError).toBe(true);
    expect(refused.content.some(block => block.type === 'text' && block.text.startsWith('NATIVE_EVIDENCE_UNAVAILABLE:'))).toBe(true);
    expect(store.readEvents({ workId: work.work_id, after: 0, limit: 2_000 }).events
      .filter(event => event.kind === 'native_execution' && event.payload['provider_request_id'] === providerRequest)).toHaveLength(1);

    // The refusal did not poison the cache: the same provider request can retry and now records.
    expect(hasNativeExecution({ workId: work.work_id, providerRequestId: unwrittenRequest })).toBe(false);
    const retried = await managedToolGate({ name: 'work_checkpoint', surface: 'core', args: { summary: 'Checkpoint', work_id: work.work_id, operation_id: randomUUID() }, context: unwrittenContext },
      () => Promise.resolve(ok('ran after the refusal')));
    expect(retried.isError).not.toBe(true);
    expect(hasNativeExecution({ workId: work.work_id, providerRequestId: unwrittenRequest })).toBe(true);

    // A restart empties the in-process set, so the durable row is what proves it — and re-proving
    // must not append a duplicate.
    resetWorkRuntimeForTests();
    installWorkRuntimeForTests(runtime);
    expect(hasNativeExecution({ workId: work.work_id, providerRequestId: providerRequest })).toBe(true);
    await managedToolGate({ name: 'work_checkpoint', surface: 'core', args: { summary: 'Checkpoint', work_id: work.work_id, operation_id: randomUUID() }, context },
      () => Promise.resolve(ok('patched after restart')));
    expect(store.readEvents({ workId: work.work_id, after: 0, limit: 2_000 }).events
      .filter(event => event.kind === 'native_execution' && event.payload['provider_request_id'] === providerRequest)).toHaveLength(1);
  } finally {
    await drainWorkRuntime();
    resetWorkRuntimeForTests();
    store.close();
  }
});



it('never lets a stage or watcher that was already in flight overwrite a stop', async () => {
  // A controlled delivery: the start stage parks inside its own await, so the stop is
  // guaranteed to land there rather than depending on timing.
  const entered = Promise.withResolvers<void>();
  const release = Promise.withResolvers<void>();
  // A controlled poll interval: the watcher asks for its next tick and this test decides when
  // it happens, so "one more poll after the cancel" is a fact rather than a sleep.
  const polls = Promise.withResolvers<void>();
  const pollRequested = Promise.withResolvers<void>();
  setWatcherDelayForTests(async () => {
    pollRequested.resolve();
    await polls.promise;
  });
  resetWorkRuntimeForTests();
  try {
    const heldData = path.join(root, 'held');
    await fs.mkdir(heldData, { recursive: true });
    const store = createWorkStore({ dataDir: heldData });
    const worktrees = createWorktreeManager({
      userDataDir: heldData,
      worktreesRoot: path.join(heldData, 'worktrees'),
      store,
      activity: createWorktreeActivityProbe(store)
    });
    const runtime = await initWorkRuntime({
      dataDir: heldData,
      worktreesRoot: path.join(heldData, 'worktrees'),
      worktrees,
      store,
      deliverOutbox: async () => {
        entered.resolve();
        await release.promise;
        return { state: 'queued' };
      }
    });

    // The reserved prime session exists up front (its id is the start request id).
    const request = randomUUID();
    await createSession({
      reservedId: request,
      title: 'prime',
      conversationId: 'conv-held-original',
      origin: { kind: 'desktop', fromSessionId: null, agentId: null, task: '' }
    });

    const started = await runtime.service.start({ request_id: request, project_path: project, goal: 'cancel during start', max_workers: 1 });
    await entered.promise;
    const prime = store.getPrimeAgent(started.work_id)!;

    // Stop while the stage is parked on the delivery.
    expect((await runtime.service.control({ request_id: randomUUID(), work_id: started.work_id, action: 'cancel' })).status).toBe('cancelled');
    release.resolve();
    // The stage's own post-dispatch fence records the abandonment; awaiting that committed event
    // is what proves the stage finished rather than sleeping on it.
    await waitForEvent(store, started.work_id, ['prime_dispatch_abandoned']);

    expect(store.getWork(started.work_id)!.status).toBe('cancelled');
    expect(store.readEvents({ workId: started.work_id, after: 0, limit: 500 }).events
      .some(event => event.kind === 'work_started')).toBe(false);
    // The worktree the stage had already created survives, so a later admission reuses it.
    expect(store.getWorktreeAssignment(started.work_id, prime.agent_id)).not.toBeNull();

    // This stage was abandoned before it ever started a watcher, so there is no poll to wait
    // for; the chat that appears afterwards must still not be bound.
    expect(await rebindSession(request, 'conv-held-original', 'conv-held-late')).toBe(true);
    polls.resolve();
    await Promise.resolve();
    expect(store.getWork(started.work_id)!.status).toBe('cancelled');
    expect(store.getAgent(prime.agent_id)!.conversation_id).toBeNull();
    await drainWorkRuntime();
    resetWorkRuntimeForTests();
    store.close();
  } finally {
    setWatcherDelayForTests(null);
  }
});

it('a watcher whose prime was dispatched cannot resurrect a cancelled work', async () => {
  const polls = Promise.withResolvers<void>();
  const pollRequested = Promise.withResolvers<void>();
  setWatcherDelayForTests(async () => {
    pollRequested.resolve();
    await polls.promise;
  });
  resetWorkRuntimeForTests();
  try {
    const store = createWorkStore({ dataDir });
    const worktrees = createWorktreeManager({
      userDataDir: dataDir,
      worktreesRoot: path.join(dataDir, 'worktrees'),
      store,
      activity: createWorktreeActivityProbe(store)
    });
    const runtime = await initWorkRuntime({
      dataDir,
      worktreesRoot: path.join(dataDir, 'worktrees'),
      worktrees,
      store,
      deliverOutbox: async () => ({ state: 'queued' })
    });

    const request = randomUUID();
    await createSession({
      reservedId: request,
      title: 'prime',
      conversationId: null,
      origin: { kind: 'desktop', fromSessionId: null, agentId: null, task: '' }
    });

    const started = await runtime.service.start({ request_id: request, project_path: project, goal: 'cancel while watching', max_workers: 1 });
    await waitForEvent(store, started.work_id, ['prime_dispatched']);
    const prime = store.getPrimeAgent(started.work_id)!;
    // The watcher is now parked in its first poll interval.
    await pollRequested.promise;
    expect((await runtime.service.control({ request_id: randomUUID(), work_id: started.work_id, action: 'cancel' })).status).toBe('cancelled');

    // The chat becomes visible only after the cancel, while the watcher is still parked.
    expect(await rebindSession(request, null, 'conv-watched-late')).toBe(true);
    polls.resolve();
    await Promise.resolve();

    expect(store.getWork(started.work_id)!.status).toBe('cancelled');
    expect(store.getAgent(prime.agent_id)!.conversation_id).toBeNull();
    expect(store.readEvents({ workId: started.work_id, after: 0, limit: 500 }).events
      .some(event => event.kind === 'work_started')).toBe(false);
    await drainWorkRuntime();
    resetWorkRuntimeForTests();
    store.close();
  } finally {
    setWatcherDelayForTests(null);
  }
});

it('checkpoints and reads a work by explicit id with no conversation of its own', async () => {
  // The remote shape: a client whose page is deliberately closed names the work it is acting on.
  // No conversation, no attachment, no browser — the ids decide, and the ledger's own refusals are
  // the whole admission.
  const remoteData = path.join(root, 'remote-checkpoint');
  const store = createWorkStore({ dataDir: remoteData });
  const worktrees = createWorktreeManager({ userDataDir: remoteData,
    worktreesRoot: path.join(remoteData, 'worktrees'), store, activity: createWorktreeActivityProbe(store) });
  const runtime = await initWorkRuntime({ dataDir: remoteData, store, worktrees,
    worktreesRoot: path.join(remoteData, 'worktrees'), deliverOutbox: async () => ({ state: 'delivered' }) });
  try {
    const work = await runtime.service.start({ request_id: randomUUID(), project_path: project, goal: 'Remote checkpoint fixture' });
    await waitForEvent(store, work.work_id, ['prime_dispatched']);
    const prime = store.getPrimeAgent(work.work_id)!;
    await createSession({ reservedId: prime.session_id!, conversationId: 'conv-remote-checkpoint' });
    await waitForEvent(store, work.work_id, ['work_started']);

    // No call context at all: the explicit work_id is the only target there is.
    const saved = workCheckpointSchema.parse({
      operation_id: randomUUID(), summary: 'Halfway.', remaining: ['finish the fixture'], verification: [],
      work_id: work.work_id
    });
    const written = await workCheckpoint(saved, null);
    expect(written.isError).not.toBe(true);
    expect(store.getWork(work.work_id)!.checkpoint?.summary).toBe('Halfway.');
    // The checkpoint lands on the work's prime, which is the agent an id-only call names.
    expect(store.getAgent(prime.agent_id)!.checkpoint_ref).toBe(`${work.work_id}:1`);

    const read = await workResume({ work_id: work.work_id }, null);
    expect(read.isError).not.toBe(true);
    const text = read.content.filter(block => block.type === 'text').map(block => (block as { text: string }).text).join('\n');
    expect(text).toContain('Halfway.');
    expect(text).toContain('target_source: explicit');
    expect(text).not.toContain('managed_connection: bound');

    // An id that is not in the ledger, an agent that is not part of the named work, and a call that
    // names neither form all refuse by name rather than resolving to whatever is running.
    const unknown = await workCheckpoint({ ...saved, operation_id: randomUUID(), work_id: randomUUID() }, null);
    expect(unknown.isError).toBe(true);
    expect(unknown.content.some(block => block.type === 'text' && block.text.startsWith('STATE_UNAVAILABLE:'))).toBe(true);
    const foreign = await workResume({ work_id: work.work_id, agent_id: randomUUID() }, null);
    expect(foreign.isError).toBe(true);
    expect(foreign.content.some(block => block.type === 'text' && block.text.startsWith('STATE_UNAVAILABLE:'))).toBe(true);
    const untargeted = await workResume({}, null);
    expect(untargeted.isError).toBe(true);
    expect(untargeted.content.some(block => block.type === 'text' && block.text.startsWith('WORKER_CONNECTION_REQUIRED:'))).toBe(true);
    expect(store.getWork(work.work_id)!.checkpoint?.revision).toBe(1);
  } finally {
    await drainWorkRuntime();
    resetWorkRuntimeForTests();
    store.close();
  }
});

it('admits a remote checkpoint through the managed gate with a durable receipt', async () => {
  // The gate is what makes an explicit `work_id` first-class: the call has no conversation, so
  // without the explicit target it would be ordinary coding with no receipt at all. With it, the
  // checkpoint is admitted against the ledger exactly like an in-chat one — same operation id, same
  // generation fence — which is what the ticket means by preserving ledger constraints.
  const gateData = path.join(root, 'remote-gate');
  const store = createWorkStore({ dataDir: gateData });
  const worktrees = createWorktreeManager({ userDataDir: gateData,
    worktreesRoot: path.join(gateData, 'worktrees'), store, activity: createWorktreeActivityProbe(store) });
  const runtime = await initWorkRuntime({ dataDir: gateData, store, worktrees,
    worktreesRoot: path.join(gateData, 'worktrees'), deliverOutbox: async () => ({ state: 'delivered' }) });
  try {
    const work = await runtime.service.start({ request_id: randomUUID(), project_path: project, goal: 'Remote gate fixture' });
    await waitForEvent(store, work.work_id, ['prime_dispatched']);
    const prime = store.getPrimeAgent(work.work_id)!;
    await createSession({ reservedId: prime.session_id!, conversationId: 'conv-remote-gate' });
    await waitForEvent(store, work.work_id, ['work_started']);
    // No conversation and no request id: the explicit work_id is the whole target.
    const context: CallContext = { startedAt: Date.now(), transportKey: null, agent: null, outcome: null,
      evidence: emptyEvidence(), caller: { transportKey: null, requestId: null, conversationId: null, sessionId: null } };
    const args = { operation_id: randomUUID(), summary: 'Remote gate.', remaining: [], verification: [], work_id: work.work_id };
    setManagedToolGate(managedToolGate);
    const result = await dispatch('work_checkpoint', args, null, null, 'core', () =>
      workCheckpoint(workCheckpointSchema.parse(args), context), context);
    expect(result.isError, JSON.stringify(result)).not.toBe(true);
    // The receipt is durable and settled: the same call is a replay, not a second checkpoint.
    expect(store.getOperation(args.operation_id)!.state).toBe('completed');
    expect(store.getOperation(args.operation_id)!.work_id).toBe(work.work_id);
    expect(store.getWork(work.work_id)!.checkpoint?.revision).toBe(1);

    // An id the ledger does not have is refused by the gate's own resolution, before the handler.
    const foreign = await dispatch('work_checkpoint', { ...args, operation_id: randomUUID(), work_id: randomUUID() },
      null, null, 'core', () => Promise.resolve(ok('should not run')), context);
    expect(foreign.isError).toBe(true);
    expect(foreign.content.some(block => block.type === 'text' && block.text.startsWith('STATE_UNAVAILABLE:'))).toBe(true);
    expect(store.getWork(work.work_id)!.checkpoint?.revision).toBe(1);
  } finally {
    setManagedToolGate(null);
    await drainWorkRuntime();
    resetWorkRuntimeForTests();
    store.close();
  }
});
