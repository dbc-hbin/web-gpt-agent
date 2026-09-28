/**
 * The durable work authority: admission, idempotency, revisions, the delivery pump, the
 * pause/cancel fence and unknown-operation resolutions.
 *
 * Every case here is about a boundary a caller cannot see from the happy path:
 *
 * - a receipt that must survive a restart byte for byte,
 * - the same request id arriving twice (concurrently) and running once,
 * - a control that must fence admission *before* it drains,
 * - a delivery that must not be sent twice because a response was lost,
 * - a damaged database that must never look like an empty new task.
 *
 * The database is a real temp file per case, and the runtime is a real injected port that
 * records exactly what it was asked to do — never a no-op default.
 */

import { promises as fs } from 'node:fs';
import path from 'node:path';
import { createHash, randomUUID } from 'node:crypto';
import { DatabaseSync } from 'node:sqlite';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { makeTempDir, removeTempDir } from './helpers.js';
import {
  WORK_BLOCKER_CODES,
  WORK_ERROR_CODES,
  WorkServiceError,
  workEventPageSchema,
  workPageSchema,
  workReceiptSchema,
  workStatusSchema,
  type WorkProjectOption
} from '../src/shared/work.js';
import type {
  WorkControllerBinding,
  WorkControllerDelivery,
  WorkControllerMessage
} from '../src/shared/work-continuity.js';
import {
  createWorkService,
  type WorkProjectDirectory,
  type WorkRuntimeControl,
  type WorkRuntimeControlResult,
  type WorkRuntimeDelivery,
  type WorkRuntimeDeliveryResult,
  type WorkRuntimePort,
  type WorkRuntimeReconcileInput,
  type WorkRuntimeStart,
  type WorkServiceHandle
} from '../src/main/work/service.js';
import { createWorkStore, type WorkOperationRow, type WorkStore } from '../src/main/work/store.js';
import { capturePatchAfterHashes, capturePatchBeforeHashes, createOperationLedger, hashTextBlob } from '../src/main/work/operations.js';

vi.mock('electron', () => ({
  safeStorage: {
    isAsyncEncryptionAvailable: async () => true,
    getSelectedStorageBackend: () => 'gnome_libsecret',
    encryptStringAsync: async (value: string) => Buffer.from(value, 'utf8'),
    decryptStringAsync: async (buffer: Buffer) => ({ result: buffer.toString('utf8'), shouldReEncrypt: false })
  },
  clipboard: { readText: () => '', writeText: () => undefined },
  shell: { openExternal: async () => undefined }
}));

interface RecordedRuntime {
  port: WorkRuntimePort;
  starts: WorkRuntimeStart[];
  deliveries: WorkRuntimeDelivery[];
  controls: WorkRuntimeControl[];
  reconciles: WorkRuntimeReconcileInput[];
  /** Each entry is consumed by the next delivery; the last one repeats. */
  deliveryResults: WorkRuntimeDeliveryResult[];
  /** Held open by the test to prove the fence precedes the drain. */
  holdControl: boolean;
  releaseControl: (result: WorkRuntimeControlResult) => void;
  controlCalls: number;
  /** Set to fail the admission stage and prove the failure becomes a retained blocker. */
  failStart: Error | null;
}

function makeRuntime(overrides: Partial<RecordedRuntime> = {}): RecordedRuntime {
  const state: RecordedRuntime = {
    starts: [],
    deliveries: [],
    controls: [],
    reconciles: [],
    deliveryResults: [{ state: 'delivered' }],
    holdControl: false,
    releaseControl: () => undefined,
    controlCalls: 0,
    failStart: null,
    port: undefined as unknown as WorkRuntimePort,
    ...overrides
  };
  state.port = {
    async beginStart(input) {
      state.starts.push(input);
      if (state.failStart) throw state.failStart;
    },
    async deliver(input) {
      state.deliveries.push(input);
      const index = Math.min(state.deliveries.length - 1, state.deliveryResults.length - 1);
      return state.deliveryResults[index] ?? { state: 'delivered' };
    },
    async control(input) {
      state.controls.push(input);
      state.controlCalls += 1;
      if (!state.holdControl) return { status: input.action === 'cancel' ? 'cancelled' : 'paused' };
      return new Promise<WorkRuntimeControlResult>(resolve => {
        state.releaseControl = resolve;
      });
    },
    async reconcile(input) {
      state.reconciles.push(input);
    }
  };
  return state;
}

function makeProjects(overrides: Partial<Awaited<ReturnType<WorkProjectDirectory['resolve']>>> = {}): WorkProjectDirectory {
  const listed: WorkProjectOption[] = [{ id: 'proj-1', name: 'fixture', path: '/tmp/fixture' }];
  return {
    async resolve(inputPath) {
      return { path: inputPath, name: path.basename(inputPath), exists: true, isGit: true, ...overrides };
    },
    async list() {
      return listed;
    }
  };
}

interface Harness {
  store: WorkStore;
  service: WorkServiceHandle;
  runtime: RecordedRuntime;
  dir: string;
}

let dirs: string[] = [];

async function harness(options: {
  runtime?: RecordedRuntime;
  projects?: WorkProjectDirectory;
  models?: { resolve(input: { model?: string; reasoning?: string }): Promise<{ model: string | null; reasoning: string | null }> };
  fileName?: string;
  store?: WorkStore;
} = {}): Promise<Harness> {
  const dir = await makeTempDir('wgpt-work-');
  dirs.push(dir);
  const store = options.store ?? createWorkStore({ dataDir: dir, ...(options.fileName ? { fileName: options.fileName } : {}) });
  const runtime = options.runtime ?? makeRuntime();
  const service = createWorkService({
    store,
    runtime: runtime.port,
    projects: options.projects ?? makeProjects(),
    models: options.models ?? { async resolve({ model, reasoning }) { return { model: model ?? 'gpt-5', reasoning: reasoning ?? null }; } },
    worktreesRoot: path.join(dir, 'worktrees'),
    maxDeliveryAttempts: 3
  });
  return { store, service, runtime, dir };
}

function startInput(overrides: Partial<{ request_id: string; project_path: string; goal: string; title: string; max_workers: number }> = {}) {
  return {
    request_id: overrides.request_id ?? randomUUID(),
    project_path: overrides.project_path ?? '/tmp/fixture',
    goal: overrides.goal ?? 'Make the failing suite pass without touching the public contract.',
    ...(overrides.title !== undefined ? { title: overrides.title } : {}),
    ...(overrides.max_workers !== undefined ? { max_workers: overrides.max_workers } : {})
  };
}

/** A durable `outcome_unknown` row, as the mutation ledger would have left it after a crash. */
function insertUnknownOperation(store: WorkStore, workId: string, agentId: string, overrides: Partial<WorkOperationRow> = {}): string {
  const operationId = overrides.operation_id ?? randomUUID();
  const at = Date.now();
  store.insertOperation({
    operation_id: operationId,
    work_id: workId,
    agent_id: agentId,
    generation: 0,
    tool: 'exec_command',
    args_hash: 'a'.repeat(64),
    state: 'outcome_unknown',
    process_id: null,
    result_ref: null,
    result_json: null,
    session_id: null,
    expect_before: null,
    expect_after: null,
    retry_of: null,
    retry_operation_id: null,
    resolution: null,
    created_at: at,
    updated_at: at,
    ...overrides
  });
  return operationId;
}

/**
 * Asserts that a call rejects with a typed work error.
 *
 * A thunk is accepted as well as a promise because the store is synchronous: a refusal it
 * raises happens during argument evaluation, before any promise exists to catch it.
 */
async function rejection(value: Promise<unknown> | (() => unknown)): Promise<WorkServiceError> {
  try {
    await (typeof value === 'function' ? value() : value);
  } catch (error) {
    if (error instanceof WorkServiceError) return error;
    throw error;
  }
  throw new Error('Expected the call to reject, but it resolved.');
}

beforeEach(() => {
  // The delivery pump schedules a tick; tests drive it with `pumpNow()` or advance fake time,
  // so no case depends on real wall-clock timers.
  vi.useFakeTimers();
});

afterEach(async () => {
  vi.useRealTimers();
  const pending = dirs;
  dirs = [];
  for (const dir of pending) await removeTempDir(dir);
});

describe('durable admission', () => {
  it('can recover a landed patch from durable evidence after reopening the ledger', async () => {
    const { store, service, dir } = await harness();
    const work = await service.start(startInput());
    const prime = store.getPrimeAgent(work.work_id)!;
    store.setWorkStatus(work.work_id, 'running', 'work_running');
    const file = path.join(dir, 'target.txt');
    await fs.writeFile(file, 'before\n');
    const ledger = createOperationLedger({ port: store });
    const operationId = randomUUID();
    const admitted = await ledger.admit({
      operationId, workId: work.work_id, agentId: prime.agent_id, generation: prime.generation,
      tool: 'apply_patch',
      args: { patch: `*** Begin Patch\n*** Update File: ${file}\n@@\n-before\n+after\n*** End Patch` },
      sessionId: null
    });
    expect(admitted.kind).toBe('admitted');
    ledger.markRunning(operationId);
    ledger.setExpectations(operationId, {
      before: await capturePatchBeforeHashes([file], dir),
      after: { [file]: hashTextBlob('after\n') }
    });
    await fs.writeFile(file, 'after\n');
    service.close();
    store.close();
    const reopened = createWorkStore({ dataDir: dir });
    try {
      const interrupted = reopened.getOperation(operationId)!;
      const recovered = await capturePatchAfterHashes(interrupted.expect_before ?? {}, dir);
      expect(recovered.summary).toBe('all_after');
      expect(recovered.after).toEqual(interrupted.expect_after);
    } finally {
      reopened.close();
    }
  });

  it('returns a queued receipt with the deterministic integration location, then survives a restart', async () => {
    const { store, service, runtime, dir } = await harness();
    const input = startInput();
    const receipt = await service.start(input);

    expect(receipt.request_id).toBe(input.request_id);
    expect(receipt.status).toBe('queued');
    expect(receipt.integration_branch).toBe(`wgpt/${receipt.work_id}/main`);
    expect(receipt.integration_worktree).toBe(path.join(dir, 'worktrees', receipt.work_id, 'main'));
    expect(receipt.revision).toBeGreaterThan(0);

    // The admission stage runs after the receipt, with the same deterministic location.
    await vi.advanceTimersByTimeAsync(0);
    expect(runtime.starts).toHaveLength(1);
    expect(runtime.starts[0]?.integrationWorktree).toBe(receipt.integration_worktree);

    // The prime row already names its branch and worktree, before any bootstrap.
    const prime = store.getPrimeAgent(receipt.work_id);
    expect(prime?.role).toBe('prime');
    expect(prime?.branch).toBe(receipt.integration_branch);
    expect(prime?.worktree_path).toBe(receipt.integration_worktree);
    expect(store.getWork(receipt.work_id)?.prime_agent_id).toBe(prime?.agent_id);

    // One initial outbox input, with the persisted command id as its stable identity.
    const commands = store.listCommands(receipt.work_id, 10);
    expect(commands).toHaveLength(1);
    expect(commands[0]?.outbox_input_id).toBe(input.request_id);

    store.close();
    const reopened = createWorkStore({ dataDir: dir });
    const restarted = createWorkService({
      store: reopened,
      runtime: makeRuntime().port,
      projects: makeProjects(),
      models: { async resolve() { return { model: 'gpt-5', reasoning: null }; } },
      worktreesRoot: path.join(dir, 'worktrees')
    });
    const status = await restarted.status({ work_id: receipt.work_id });
    expect(status.status).toBe('queued');
    expect(status.integration_worktree).toBe(receipt.integration_worktree);
    expect(status.goal).toBe(input.goal);
    expect(reopened.countWorks()).toBe(1);
    reopened.close();
  });

  it('turns a failed admission stage into a retained blocker instead of a failed receipt', async () => {
    const runtime = makeRuntime({ failStart: new WorkServiceError('AUTH_REQUIRED', 'AUTH_REQUIRED: the ChatGPT account is signed out.') });
    const { service, store } = await harness({ runtime });
    const receipt = await service.start(startInput());
    await vi.advanceTimersByTimeAsync(0);

    const work = store.getWork(receipt.work_id);
    expect(work?.blocker?.code).toBe('AUTH_REQUIRED');
    expect(work?.status).toBe('blocked');
    // The work is still addressable: a blocker is retained state, not a lost admission.
    const status = await service.status({ work_id: receipt.work_id });
    expect(status.blocker?.code).toBe('AUTH_REQUIRED');
  });

  it('refuses a non-Git project and a missing folder without admitting anything', async () => {
    const notGit = await harness({ projects: makeProjects({ isGit: false }) });
    const gitError = await rejection(notGit.service.start(startInput()));
    expect(gitError.code).toBe(WORK_ERROR_CODES.projectNotGit);
    expect(notGit.store.countWorks()).toBe(0);

    const missing = await harness({ projects: makeProjects({ exists: false, isGit: false, error: 'no such folder' }) });
    const pathError = await rejection(missing.service.start(startInput()));
    expect(pathError.code).toBe(WORK_ERROR_CODES.projectPathInvalid);
    expect(missing.store.countWorks()).toBe(0);
  });

  it('never invents a model: an unavailable selection is rejected and nothing is admitted', async () => {
    const { service, store } = await harness({
      models: {
        async resolve() {
          throw new WorkServiceError(WORK_ERROR_CODES.modelUnavailable, 'MODEL_UNAVAILABLE: that model is not offered for this account.');
        }
      }
    });
    const error = await rejection(service.start(startInput()));
    expect(error.code).toBe(WORK_ERROR_CODES.modelUnavailable);
    expect(store.countWorks()).toBe(0);
  });
});

describe('idempotency', () => {
  it('returns the same work for a repeated request id, concurrently and after a restart', async () => {
    const { service, store, dir } = await harness();
    const input = startInput();
    const [first, second] = await Promise.all([service.start(input), service.start(input)]);

    expect(second.work_id).toBe(first.work_id);
    expect(second.revision).toBe(first.revision);
    expect(store.countWorks()).toBe(1);
    expect(store.listCommands(first.work_id, 10)).toHaveLength(1);

    store.close();
    const reopened = createWorkStore({ dataDir: dir });
    const restarted = createWorkService({
      store: reopened,
      runtime: makeRuntime().port,
      projects: makeProjects(),
      models: { async resolve() { return { model: 'gpt-5', reasoning: null }; } },
      worktreesRoot: path.join(dir, 'worktrees')
    });
    const third = await restarted.start(input);
    expect(third.work_id).toBe(first.work_id);
    expect(reopened.countWorks()).toBe(1);
    reopened.close();
  });

  it('lets a second connection to the same file see the committed work, and both can write', async () => {
    const { store, service, dir } = await harness();
    const receipt = await service.start(startInput({ goal: 'First connection work' }));

    // A real second connection to the same WAL database, as a restarted host would open.
    const second = createWorkStore({ dataDir: dir });
    expect(second.getWork(receipt.work_id)?.goal).toBe('First connection work');
    const secondService = createWorkService({
      store: second,
      runtime: makeRuntime().port,
      projects: makeProjects(),
      models: { async resolve() { return { model: 'gpt-5', reasoning: null }; } },
      worktreesRoot: path.join(dir, 'worktrees')
    });
    await secondService.instruct({ request_id: randomUUID(), work_id: receipt.work_id, text: 'Written by the second connection.' });

    // The first connection sees the second connection's committed change.
    expect(store.listCommands(receipt.work_id, 10).some(command => command.kind === 'instruct')).toBe(true);
    // And a second work admitted here is visible there.
    const other = await service.start(startInput({ goal: 'Second connection work' }));
    expect(second.getWork(other.work_id)?.goal).toBe('Second connection work');
    second.close();
  });

  it('replays an accepted explicit-model start after restart even when the catalog is empty', async () => {
    const runtime = makeRuntime();
    const accepted = {
      async resolve({ model }: { model?: string }) {
        return { model: model ?? 'gpt-5', reasoning: null };
      }
    };
    const { service, store, dir } = await harness({ runtime, models: accepted });
    const input = startInput();
    const requestId = randomUUID();
    const first = await service.start({ ...input, request_id: requestId, model: 'gpt-5.1-pro' });
    expect(store.getWork(first.work_id)?.model).toBe('gpt-5.1-pro');
    store.close();

    // The restarted host cannot see the model catalog yet (discovery has not run). A replay of
    // the accepted request must still return the same receipt rather than MODEL_UNAVAILABLE, and
    // must not queue a second outbox input.
    const reopened = createWorkStore({ dataDir: dir });
    const restarted = createWorkService({
      store: reopened,
      runtime: makeRuntime().port,
      projects: makeProjects(),
      models: {
        async resolve() {
          throw new WorkServiceError(WORK_ERROR_CODES.modelUnavailable, 'MODEL_UNAVAILABLE: no catalog is available yet.');
        }
      },
      worktreesRoot: path.join(dir, 'worktrees')
    });
    const replayed = await restarted.start({ ...input, request_id: requestId, model: 'gpt-5.1-pro' });
    expect(replayed).toEqual(first);
    expect(reopened.countWorks()).toBe(1);
    expect(reopened.listCommands(first.work_id, 10)).toHaveLength(1);

    // A changed payload with the same id is still a conflict, even though the preconditions
    // would have failed: conflict is decided before availability.
    const changed = await rejection(restarted.start({ ...input, request_id: requestId, model: 'a-different-model' }));
    expect(changed.code).toBe(WORK_ERROR_CODES.requestIdConflict);

    // A genuinely new request with an unavailable model is still refused.
    const fresh = await rejection(restarted.start({ ...input, request_id: randomUUID(), model: 'a-different-model' }));
    expect(fresh.code).toBe(WORK_ERROR_CODES.modelUnavailable);
    expect(reopened.countWorks()).toBe(1);
    reopened.close();
  });

  it('rejects the same request id carrying a different payload', async () => {
    const { service, store } = await harness();
    const requestId = randomUUID();
    const first = await service.start(startInput({ request_id: requestId, goal: 'First goal' }));
    const error = await rejection(service.start(startInput({ request_id: requestId, goal: 'A different goal' })));
    expect(error.code).toBe(WORK_ERROR_CODES.requestIdConflict);
    expect(store.countWorks()).toBe(1);
    expect(store.getWork(first.work_id)?.goal).toBe('First goal');
  });

  it('replays an instruction receipt instead of queueing a second delivery', async () => {
    const { service, store } = await harness();
    const work = await service.start(startInput());
    const requestId = randomUUID();
    const first = await service.instruct({ request_id: requestId, work_id: work.work_id, text: 'Also run the type check.' });
    const second = await service.instruct({ request_id: requestId, work_id: work.work_id, text: 'Also run the type check.' });

    expect(second.revision).toBe(first.revision);
    expect(store.listCommands(work.work_id, 10)).toHaveLength(2);
    const error = await rejection(service.instruct({ request_id: requestId, work_id: work.work_id, text: 'A different instruction.' }));
    expect(error.code).toBe(WORK_ERROR_CODES.requestIdConflict);
  });
});

describe('revisions and events', () => {
  it('allocates the revision and the event in one step, and pages the cursor without gaps', async () => {
    const { service, store } = await harness();
    const work = await service.start(startInput());
    const afterStart = store.getWork(work.work_id)!.revision;

    await service.instruct({ request_id: randomUUID(), work_id: work.work_id, text: 'Check the fixture output.' });
    const afterInstruct = store.getWork(work.work_id)!.revision;
    expect(afterInstruct).toBeGreaterThan(afterStart);

    const all = await service.events({ work_id: work.work_id });
    expect(all.events.map(event => event.kind)).toContain('work_queued');
    expect(all.events.map(event => event.kind)).toContain('instruction_queued');
    expect(all.events[0]?.sequence).toBe(1);
    expect(all.next_cursor).toBe(all.events[all.events.length - 1]!.sequence);
    expect(all.has_more).toBe(false);

    // A cursor is exclusive and monotonic: paging never repeats or skips a sequence.
    const firstPage = await service.events({ work_id: work.work_id, after: 0, limit: 1 });
    expect(firstPage.has_more).toBe(true);
    const secondPage = await service.events({ work_id: work.work_id, after: firstPage.next_cursor, limit: 10 });
    expect(secondPage.events.every(event => event.sequence > firstPage.next_cursor)).toBe(true);
    const seen = [...firstPage.events, ...secondPage.events].map(event => event.sequence);
    expect(seen).toEqual([...new Set(seen)]);

    // The revision is allocated with the change, so a reader that sees revision N has its event.
    const latest = await service.events({ work_id: work.work_id, after: 0, limit: 200 });
    expect(latest.events.length).toBeGreaterThan(0);
    expect(store.getWork(work.work_id)!.revision).toBeGreaterThanOrEqual(latest.next_cursor);
  });

  it('keeps an unknown work id from resolving to anything else', async () => {
    const { service } = await harness();
    const error = await rejection(service.status({ work_id: randomUUID() }));
    expect(error.code).toBe(WORK_ERROR_CODES.workNotFound);
  });

  it('lists the configured projects beside the works so a new caller can choose one', async () => {
    const { service } = await harness();
    await service.start(startInput());
    const page = await service.list({});
    expect(page.works).toHaveLength(1);
    expect(page.projects).toEqual([{ id: 'proj-1', name: 'fixture', path: '/tmp/fixture' }]);
    expect(page.next_cursor).toBeNull();
  });
});

describe('delivery pump', () => {
  it('delivers a queued instruction through the injected runtime under the stable outbox id', async () => {
    const { service, store, runtime } = await harness();
    const work = await service.start(startInput());
    const requestId = randomUUID();
    await service.instruct({ request_id: requestId, work_id: work.work_id, text: 'Run the fixture checks.' });

    // The receipt was durable before any delivery was attempted.
    const queued = store.getCommand(requestId);
    expect(queued?.delivery_state).toBe('pending');
    expect(runtime.deliveries).toHaveLength(0);

    await service.pumpNow();
    expect(runtime.deliveries).toHaveLength(1);
    expect(runtime.deliveries[0]?.outboxInputId).toBe(requestId);
    expect(runtime.deliveries[0]?.attempt).toBe(1);
    expect(store.getCommand(requestId)?.delivery_state).toBe('delivered');
    expect((await service.events({ work_id: work.work_id })).events.map(event => event.kind)).toContain('instruction_delivered');

    // A second pump does not resend a delivered command.
    await service.pumpNow();
    expect(runtime.deliveries).toHaveLength(1);
  });

  it('retries a failed delivery under the same outbox id and then parks it with a blocker', async () => {
    const runtime = makeRuntime({ deliveryResults: [{ state: 'failed', error: 'browser disconnected' }] });
    const { service, store } = await harness({ runtime });
    const work = await service.start(startInput());
    const requestId = randomUUID();
    await service.instruct({ request_id: requestId, work_id: work.work_id, text: 'Run the checks.' });

    await service.pumpNow();
    await service.pumpNow();
    expect(store.getCommand(requestId)?.delivery_state).toBe('pending');
    expect(store.getCommand(requestId)?.attempts).toBe(2);
    expect(runtime.deliveries.map(entry => entry.outboxInputId)).toEqual([requestId, requestId]);

    await service.pumpNow();
    const parked = store.getCommand(requestId);
    expect(parked?.delivery_state).toBe('failed');
    expect(parked?.attempts).toBe(3);
    expect(store.getWork(work.work_id)?.blocker?.code).toBe('INSTRUCTION_DELIVERY_FAILED');
  });

  it('leaves a deferred command pending without burning an attempt', async () => {
    const runtime = makeRuntime({ deliveryResults: [{ state: 'deferred', detail: 'waiting for the next turn boundary' }] });
    const { service, store } = await harness({ runtime });
    const work = await service.start(startInput());
    const requestId = randomUUID();
    await service.instruct({ request_id: requestId, work_id: work.work_id, text: 'Continue.' });
    await service.pumpNow();

    const command = store.getCommand(requestId);
    expect(command?.delivery_state).toBe('pending');
    expect(command?.attempts).toBe(0);
  });

  it('re-arms a command left mid-delivery by a crash, under the same outbox id', async () => {
    const { service, store, dir, runtime } = await harness();
    const work = await service.start(startInput());
    const requestId = randomUUID();
    await service.instruct({ request_id: requestId, work_id: work.work_id, text: 'Run the checks.' });
    // Simulate a crash between the durable delivery intent and the send.
    store.updateCommand(requestId, { delivery_state: 'delivering', attempts: 1 });
    store.close();

    const reopened = createWorkStore({ dataDir: dir });
    const restartedRuntime = makeRuntime();
    const restarted = createWorkService({
      store: reopened,
      runtime: restartedRuntime.port,
      projects: makeProjects(),
      models: { async resolve() { return { model: 'gpt-5', reasoning: null }; } },
      worktreesRoot: path.join(dir, 'worktrees')
    });
    await restarted.reconcile();
    expect(restartedRuntime.reconciles).toHaveLength(1);
    expect(restartedRuntime.reconciles[0]?.pendingCommands.map(command => command.request_id)).toContain(requestId);
    expect(reopened.getCommand(requestId)?.delivery_state).toBe('pending');

    await restarted.pumpNow();
    expect(restartedRuntime.deliveries).toHaveLength(1);
    expect(restartedRuntime.deliveries[0]?.outboxInputId).toBe(requestId);
    expect(reopened.getCommand(requestId)?.delivery_state).toBe('delivered');
    void runtime;
    reopened.close();
  });
});

describe('pause and cancel', () => {
  it.each(['cancelled', 'completed', 'cancelling'] as const)('cannot use pause to reopen %s work', async terminal => {
    const { service, store } = await harness();
    const work = await service.start(startInput());
    if (terminal === 'cancelling') {
      store.setWorkStatus(work.work_id, 'running', 'work_running');
      store.setDesiredState(work.work_id, 'cancelled', 'work_desired_state');
    } else {
      store.setWorkStatus(work.work_id, terminal, terminal === 'completed' ? 'work_completed' : 'work_cancelled');
    }
    const before = store.getWork(work.work_id)!;
    const error = await rejection(service.control({ request_id: randomUUID(), work_id: work.work_id, action: 'pause' }));
    expect(error.code).toBe(terminal === 'completed' ? WORK_ERROR_CODES.workAlreadyCompleted : WORK_ERROR_CODES.workAlreadyCancelled);
    expect(store.getWork(work.work_id)).toMatchObject({ status: before.status, desired_state: before.desired_state, revision: before.revision });
    await expect(service.control({ request_id: randomUUID(), work_id: work.work_id, action: 'resume' })).rejects.toMatchObject({ code: WORK_ERROR_CODES.workNotResumable });
  });

  it('fences admission before draining, then records the factual status', async () => {
    const runtime = makeRuntime({ holdControl: true });
    const { service, store } = await harness({ runtime });
    const work = await service.start(startInput());
    const prime = store.getPrimeAgent(work.work_id)!;
    store.updateAgent(prime.agent_id, { state: 'active' });
    store.setWorkStatus(work.work_id, 'running', 'work_running');

    const control = service.control({ request_id: randomUUID(), work_id: work.work_id, action: 'pause' });
    await vi.advanceTimersByTimeAsync(0);

    // The fence is durable and refuses new mutations while the drain is still settling.
    const fenced = store.getWork(work.work_id)!;
    expect(fenced.desired_state).toBe('paused');
    expect(fenced.status).toBe('running');
    expect(store.admissionContext(prime.agent_id)?.work_status).toBe('paused');

    // Status still answers during the drain, and reports both facts.
    const during = await service.status({ work_id: work.work_id });
    expect(during.status).toBe('running');
    expect(during.desired_state).toBe('paused');

    runtime.releaseControl({ status: 'paused' });
    const receipt = await control;
    expect(receipt.status).toBe('paused');
    const settled = store.getWork(work.work_id)!;
    expect(settled.status).toBe('paused');
    expect(settled.desired_state).toBeNull();
    expect(store.admissionContext(prime.agent_id)?.work_status).toBe('paused');
  });

  it('cancels pending inputs, is terminal, and refuses resume or a second cancel', async () => {
    const { service, store } = await harness();
    const work = await service.start(startInput());
    const instruction = randomUUID();
    await service.instruct({ request_id: instruction, work_id: work.work_id, text: 'Do not run this.' });

    const cancelled = await service.control({ request_id: randomUUID(), work_id: work.work_id, action: 'cancel' });
    expect(cancelled.status).toBe('cancelled');
    expect(store.getCommand(instruction)?.delivery_state).toBe('cancelled');

    // Cancellation is terminal: nothing is delivered, and resume is refused.
    await service.pumpNow();
    const resume = await rejection(service.control({ request_id: randomUUID(), work_id: work.work_id, action: 'resume' }));
    expect(resume.code).toBe(WORK_ERROR_CODES.workNotResumable);
    const instruct = await rejection(service.instruct({ request_id: randomUUID(), work_id: work.work_id, text: 'One more thing.' }));
    expect(instruct.code).toBe(WORK_ERROR_CODES.workAlreadyCancelled);

    // Repeating the same cancel is idempotent rather than a second drain.
    const again = await service.control({ request_id: randomUUID(), work_id: work.work_id, action: 'cancel' });
    expect(again.status).toBe('cancelled');
  });

  it('refuses to cancel completed work', async () => {
    const { service, store } = await harness();
    const work = await service.start(startInput());
    store.setWorkStatus(work.work_id, 'completed', 'work_completed');
    const error = await rejection(service.control({ request_id: randomUUID(), work_id: work.work_id, action: 'cancel' }));
    expect(error.code).toBe(WORK_ERROR_CODES.workAlreadyCompleted);
  });

  it('refuses a bare resume while an unknown operation is unresolved, and grants an episode after exhaustion', async () => {
    const runtime = makeRuntime();
    const { service, store } = await harness({ runtime });
    const work = await service.start(startInput());
    const prime = store.getPrimeAgent(work.work_id)!;
    store.setWorkStatus(work.work_id, 'running', 'work_running');

    const unknownId = insertUnknownOperation(store, work.work_id, prime.agent_id);
    store.setWorkStatus(work.work_id, 'blocked', 'work_blocked');
    store.setBlocker(work.work_id, { code: 'OPERATION_OUTCOME_UNKNOWN', detail: 'A command may have run.', at: Date.now() }, 'work_blocked');

    const refused = await rejection(service.control({ request_id: randomUUID(), work_id: work.work_id, action: 'resume' }));
    expect(refused.code).toBe(WORK_ERROR_CODES.operationUnknownUnresolved);

    // An exhausted recovery is resumable, and that resume grants exactly one more episode.
    store.setBlocker(work.work_id, { code: 'RECOVERY_EXHAUSTED', detail: 'Three attempts produced no progress.', at: Date.now() }, 'work_blocked');
    await expect(service.control({ request_id: randomUUID(), work_id: work.work_id, action: 'resume' }))
      .rejects.toMatchObject({ code: WORK_ERROR_CODES.operationUnknownUnresolved });
    await service.instruct({ request_id: randomUUID(), work_id: work.work_id, text: 'Effects accepted',
      resolve_operations: [{ operation_id: unknownId, decision: 'accept_observed_effects', note: 'Verified' }] });
    await service.control({ request_id: randomUUID(), work_id: work.work_id, action: 'resume' });
    expect(runtime.controls.at(-1)?.grantRecoveryEpisode).toBe(true);
    expect(store.getWork(work.work_id)?.blocker).toBeNull();

    // A second resume request is a new request id but does not re-grant anything implicitly.
    store.setBlocker(work.work_id, { code: 'RECOVERY_EXHAUSTED', detail: 'Again.', at: Date.now() }, 'work_blocked');
    await service.control({ request_id: randomUUID(), work_id: work.work_id, action: 'resume' });
    expect(runtime.controls.at(-1)?.grantRecoveryEpisode).toBe(true);
  });
});

describe('unknown operation resolutions', () => {
  it('records an accepted outcome and attributes it to the resolving command', async () => {
    const runtime = makeRuntime();
    const { service, store } = await harness({ runtime });
    const work = await service.start(startInput());
    const prime = store.getPrimeAgent(work.work_id)!;
    const operationId = insertUnknownOperation(store, work.work_id, prime.agent_id);

    const requestId = randomUUID();
    await service.instruct({
      request_id: requestId,
      work_id: work.work_id,
      text: 'The marker file is there; accept what happened and continue.',
      resolve_operations: [{ operation_id: operationId, decision: 'accept_observed_effects', note: 'Verified the marker by hand.' }]
    });

    const operation = store.getOperation(operationId)!;
    expect(operation.state).toBe('outcome_unknown');
    expect(operation.resolution?.decision).toBe('accept_observed_effects');
    expect(operation.resolution?.by_command).toBe(requestId);
    expect(operation.retry_operation_id).toBeNull();

    const events = await service.events({ work_id: work.work_id });
    expect(events.events.map(event => event.kind)).toContain('operation_resolved');

    // The decision is recorded once; a second, conflicting resolution is refused.
    const conflict = await rejection(service.instruct({
      request_id: randomUUID(),
      work_id: work.work_id,
      text: 'Try again with a different decision.',
      resolve_operations: [{ operation_id: operationId, decision: 'authorize_retry', note: 'changed my mind' }]
    }));
    expect(conflict.code).toBe(WORK_ERROR_CODES.operationResolutionConflict);
  });

  it('allocates one fresh retry operation id and keeps the original record', async () => {
    const runtime = makeRuntime();
    const { service, store } = await harness({ runtime });
    const work = await service.start(startInput());
    const prime = store.getPrimeAgent(work.work_id)!;
    const operationId = insertUnknownOperation(store, work.work_id, prime.agent_id);

    await service.instruct({
      request_id: randomUUID(),
      work_id: work.work_id,
      text: 'Authorize one retry of the same command.',
      resolve_operations: [{ operation_id: operationId, decision: 'authorize_retry', note: 'The marker was absent.' }]
    });

    const operation = store.getOperation(operationId)!;
    expect(operation.resolution?.decision).toBe('authorize_retry');
    expect(operation.retry_operation_id).toMatch(/^[0-9a-f-]{36}$/);
    // The old unknown record is preserved, not rewritten into a success.
    expect(operation.state).toBe('outcome_unknown');
  });

  it('rejects a resolution for another work and for an already settled operation', async () => {
    const { service, store } = await harness();
    const first = await service.start(startInput({ goal: 'First work' }));
    const second = await service.start(startInput({ goal: 'Second work' }));
    const foreign = insertUnknownOperation(store, second.work_id, store.getPrimeAgent(second.work_id)!.agent_id);

    const crossWork = await rejection(service.instruct({
      request_id: randomUUID(),
      work_id: first.work_id,
      text: 'Resolve the other work operation.',
      resolve_operations: [{ operation_id: foreign, decision: 'accept_observed_effects', note: 'wrong work' }]
    }));
    expect(crossWork.code).toBe(WORK_ERROR_CODES.operationResolutionConflict);
    expect(store.getOperation(foreign)?.resolution).toBeNull();

    const settled = store.getPrimeAgent(first.work_id)!;
    const completedId = insertUnknownOperation(store, first.work_id, settled.agent_id, { state: 'completed' });
    const settledError = await rejection(service.instruct({
      request_id: randomUUID(),
      work_id: first.work_id,
      text: 'Resolve a finished operation.',
      resolve_operations: [{ operation_id: completedId, decision: 'accept_observed_effects', note: 'already done' }]
    }));
    expect(settledError.code).toBe(WORK_ERROR_CODES.operationResolutionConflict);

    const unknownId = await rejection(service.instruct({
      request_id: randomUUID(),
      work_id: first.work_id,
      text: 'Resolve a missing operation.',
      resolve_operations: [{ operation_id: randomUUID(), decision: 'accept_observed_effects', note: 'not there' }]
    }));
    expect(unknownId.code).toBe(WORK_ERROR_CODES.operationNotFound);
  });
});

describe('response contract', () => {
  it('every response parses against the published schema, including after a restart', async () => {
    const { service, store, dir } = await harness();
    const work = await service.start(startInput());
    await service.instruct({ request_id: randomUUID(), work_id: work.work_id, text: 'Check the fixture output.' });
    await service.pumpNow();
    await service.control({ request_id: randomUUID(), work_id: work.work_id, action: 'pause' });

    // A response that does not parse is a broken contract for every interface, not a formatting
    // detail: the GUI, CLI and MCP tools all decode these exact shapes.
    expect(workReceiptSchema.parse(await service.start(startInput({ request_id: work.request_id, goal: 'Make the failing suite pass without touching the public contract.' })))).toBeTruthy();
    workStatusSchema.parse(await service.status({ work_id: work.work_id }));
    workPageSchema.parse(await service.list({}));
    workEventPageSchema.parse(await service.events({ work_id: work.work_id }));

    // The bounded status stays under the response cap even with a maximum goal and checkpoint.
    const long = await service.start(startInput({ goal: 'x'.repeat(60 * 1024) }));
    store.setCheckpoint(long.work_id, {
      revision: 1,
      summary: 'y'.repeat(16 * 1024),
      remaining: ['z'.repeat(200)],
      verification: Array.from({ length: 32 }, () => ({ operation_id: randomUUID(), outcome: 'passed' as const })),
      host_generated: true,
      updated_at: Date.now()
    });
    const status = await service.status({ work_id: long.work_id });
    expect(Buffer.byteLength(JSON.stringify(status), 'utf8')).toBeLessThanOrEqual(64 * 1024);
    workStatusSchema.parse(status);
    expect(status.goal).toContain('truncated');

    store.close();
    const reopened = createWorkStore({ dataDir: dir });
    const restarted = createWorkService({
      store: reopened,
      runtime: makeRuntime().port,
      projects: makeProjects(),
      models: { async resolve() { return { model: 'gpt-5', reasoning: null }; } },
      worktreesRoot: path.join(dir, 'worktrees')
    });
    workStatusSchema.parse(await restarted.status({ work_id: work.work_id }));
    reopened.close();
  });
});

describe('durable state integrity', () => {
  it('reports STATE_UNAVAILABLE for a corrupt database file instead of an empty ledger', async () => {
    const dir = await makeTempDir('wgpt-corrupt-');
    dirs.push(dir);
    const store = createWorkStore({ dataDir: dir });
    const work = createWorkService({
      store,
      runtime: makeRuntime().port,
      projects: makeProjects(),
      models: { async resolve() { return { model: 'gpt-5', reasoning: null }; } },
      worktreesRoot: path.join(dir, 'worktrees')
    });
    await work.start(startInput());
    store.close();

    await fs.writeFile(path.join(dir, 'work.sqlite'), 'this is not a database');
    let thrown: unknown;
    try {
      createWorkStore({ dataDir: dir });
    } catch (error) {
      thrown = error;
    }
    expect(thrown).toBeInstanceOf(WorkServiceError);
    expect((thrown as WorkServiceError).code).toBe(WORK_ERROR_CODES.stateUnavailable);
  });

  it('rolls back and remains usable when COMMIT fails', async () => {
    const dir = await makeTempDir('wgpt-commit-failure-');
    dirs.push(dir);
    const store = createWorkStore({ dataDir: dir });
    const originalExec = DatabaseSync.prototype.exec;
    let failCommit = true;
    const exec = vi.spyOn(DatabaseSync.prototype, 'exec').mockImplementation(function (this: DatabaseSync, sql: string): void {
      if (sql === 'COMMIT' && failCommit) {
        failCommit = false;
        throw new Error('injected COMMIT failure');
      }
      originalExec.call(this, sql);
    });
    try {
      expect(() => store.runInTransaction(() => undefined)).toThrow(/injected COMMIT failure/);
      expect(() => store.runInTransaction(() => undefined)).not.toThrow();
    } finally {
      exec.mockRestore();
      store.close();
    }
  });

  it('refuses a ledger whose schema does not match this build', async () => {
    const dir = await makeTempDir('wgpt-schema-');
    dirs.push(dir);
    const { DatabaseSync } = await import('node:sqlite');
    const db = new DatabaseSync(path.join(dir, 'work.sqlite'));
    db.exec('CREATE TABLE work_schema_migrations (version INTEGER PRIMARY KEY, applied_at INTEGER NOT NULL)');
    db.exec('INSERT INTO work_schema_migrations (version, applied_at) VALUES (1, 0)');
    db.exec('CREATE TABLE works (work_id TEXT PRIMARY KEY)');
    db.close();

    let thrown: unknown;
    try {
      createWorkStore({ dataDir: dir });
    } catch (error) {
      thrown = error;
    }
    expect(thrown).toBeInstanceOf(WorkServiceError);
    expect((thrown as WorkServiceError).code).toBe(WORK_ERROR_CODES.stateUnavailable);
  });

  it('finishes a fence that outlived the host instead of leaving it stuck', async () => {
    const runtime = makeRuntime();
    const { service, store, dir } = await harness({ runtime });
    const work = await service.start(startInput());
    const prime = store.getPrimeAgent(work.work_id)!;
    store.setWorkStatus(work.work_id, 'running', 'work_running');
    // A pause fenced admission, then the host died before the drain settled.
    store.setDesiredState(work.work_id, 'paused', 'work_desired_state');
    expect(store.admissionContext(prime.agent_id)?.work_status).toBe('paused');
    store.close();

    const reopened = createWorkStore({ dataDir: dir });
    const restartedRuntime = makeRuntime();
    const restarted = createWorkService({
      store: reopened,
      runtime: restartedRuntime.port,
      projects: makeProjects(),
      models: { async resolve() { return { model: 'gpt-5', reasoning: null }; } },
      worktreesRoot: path.join(dir, 'worktrees')
    });
    await restarted.reconcile();

    expect(restartedRuntime.controls.at(-1)?.action).toBe('pause');
    const settled = reopened.getWork(work.work_id)!;
    expect(settled.status).toBe('paused');
    expect(settled.desired_state).toBeNull();
    reopened.close();
  });

  it('commits or rolls back a caller-supplied transaction as one unit', async () => {
    const { store } = await harness();
    const at = Date.now();
    expect(() => store.runInTransaction(() => {
      store.insertWork({
        work_id: randomUUID(),
        title: 'rolled back',
        goal: 'never persisted',
        project_path: '/tmp/fixture',
        project_name: 'fixture',
        base_commit: null,
        integration_branch: 'wgpt/x/main',
        integration_worktree: '/tmp/x',
        status: 'queued',
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
        created_at: at,
        updated_at: at
      });
      throw new Error('admission failed halfway');
    })).toThrow('admission failed halfway');
    expect(store.countWorks()).toBe(0);
  });

  it('signals a duplicate operation id so the mutation ledger can join instead of re-running', async () => {
    const { store } = await harness();
    const work = createWorkService({
      store,
      runtime: makeRuntime().port,
      projects: makeProjects(),
      models: { async resolve() { return { model: 'gpt-5', reasoning: null }; } },
      worktreesRoot: '/tmp/worktrees'
    });
    const receipt = await work.start(startInput());
    const prime = store.getPrimeAgent(receipt.work_id)!;
    const operationId = insertUnknownOperation(store, receipt.work_id, prime.agent_id);

    let thrown: unknown;
    try {
      insertUnknownOperation(store, receipt.work_id, prime.agent_id, { operation_id: operationId });
    } catch (error) {
      thrown = error;
    }
    expect(thrown).toBeInstanceOf(WorkServiceError);
    expect((thrown as WorkServiceError).code).toBe('DUPLICATE_OPERATION_ID');
  });

  it('keeps the checkpoint bounded', async () => {
    const { store } = await harness();
    const work = createWorkService({
      store,
      runtime: makeRuntime().port,
      projects: makeProjects(),
      models: { async resolve() { return { model: 'gpt-5', reasoning: null }; } },
      worktreesRoot: '/tmp/worktrees'
    });
    const receipt = await work.start(startInput());
    let thrown: unknown;
    try {
      store.setCheckpoint(receipt.work_id, {
        revision: 1,
        summary: 'x'.repeat(30 * 1024),
        remaining: [],
        verification: [],
        host_generated: true,
        updated_at: Date.now()
      });
    } catch (error) {
      thrown = error;
    }
    expect(thrown).toBeInstanceOf(WorkServiceError);
    expect((thrown as WorkServiceError).code).toBe(WORK_ERROR_CODES.checkpointTooLarge);
    expect(store.getWork(receipt.work_id)?.checkpoint).toBeNull();
  });
});

// -----------------------------------------------------------------------------------------
// Continuation: a completed work is continued by exactly one durable successor
// -----------------------------------------------------------------------------------------

describe('continuation chain', () => {
  it('routes an instruction on a completed work to exactly one durable successor', async () => {
    const { service, store, runtime } = await harness();
    const first = await service.start(startInput());
    store.setWorkStatus(first.work_id, 'completed', 'work_completed');
    const before = store.getWork(first.work_id)!;

    const requestId = randomUUID();
    const receipt = await service.instruct({ request_id: requestId, work_id: first.work_id, text: 'Add the missing regression test.' });
    workReceiptSchema.parse(receipt);

    // The receipt names the successor, and says which work it continues: a caller holding the
    // old id must be able to tell that its instruction landed on a new work.
    expect(receipt.work_id).not.toBe(first.work_id);
    expect(receipt.predecessor_work_id).toBe(first.work_id);
    expect(receipt.status).toBe('queued');

    const predecessor = store.getWork(first.work_id)!;
    expect(predecessor.successor_work_id).toBe(receipt.work_id);
    // The completed row keeps everything except the link: same status, same goal, same prime.
    expect(predecessor.status).toBe('completed');
    expect(predecessor.goal).toBe(before.goal);
    expect(predecessor.desired_state).toBeNull();
    expect(predecessor.prime_agent_id).toBe(before.prime_agent_id);
    expect(predecessor.created_at).toBe(before.created_at);

    // The successor's opening goal is the user's actual follow-up first: the new prime must act on
    // the request, not on a task that was already finished.
    const successor = store.getWork(receipt.work_id)!;
    expect(successor.predecessor_work_id).toBe(first.work_id);
    expect(successor.successor_work_id).toBeNull();
    expect(successor.status).toBe('queued');
    expect(successor.project_path).toBe(predecessor.project_path);
    expect(successor.integration_branch).toBe(`wgpt/${receipt.work_id}/main`);
    expect(successor.goal.split('\n')[0]).toBe('Add the missing regression test.');
    expect(successor.goal).toContain(first.work_id);
    expect(successor.goal).toContain(before.goal);
    expect(store.getPrimeAgent(receipt.work_id)?.role).toBe('prime');

    // The instruction belongs to the successor, and it shares the successor's START command id as
    // its outbox input id: the opening message already carries this instruction, so both rows name
    // one outbox input and the outbox's own dedup is what prevents a second send.
    expect(store.getCommand(requestId)?.work_id).toBe(receipt.work_id);
    expect(store.getCommand(requestId)?.delivery_state).toBe('pending');
    const startCommand = store.listCommands(receipt.work_id, 10).find(command => command.kind === 'start');
    expect(startCommand?.request_id).not.toBe(requestId);
    expect(startCommand?.outbox_input_id).toBe(startCommand?.request_id);
    expect(store.getCommand(requestId)?.outbox_input_id).toBe(startCommand?.request_id);
    expect(startCommand?.text).toBe(successor.goal);

    const kinds = (await service.events({ work_id: receipt.work_id })).events.map(event => event.kind);
    expect(kinds).toContain('work_continued');
    expect(kinds).toContain('instruction_queued');
    expect((await service.events({ work_id: first.work_id })).events.map(event => event.kind)).toContain('work_continued');

    // The successor's admission stage runs after the receipt, and knows its predecessor.
    await vi.advanceTimersByTimeAsync(0);
    const started = runtime.starts.at(-1)!;
    expect(started.workId).toBe(receipt.work_id);
    expect(started.predecessorWorkId).toBe(first.work_id);
    expect(typeof started.createdAt).toBe('number');

    // A further instruction on the ORIGINAL id follows the recorded link to the same successor.
    const second = await service.instruct({ request_id: randomUUID(), work_id: first.work_id, text: 'And update the changelog.' });
    expect(second.work_id).toBe(receipt.work_id);
    expect(store.countWorks()).toBe(2);
    expect(store.getWork(receipt.work_id)?.predecessor_work_id).toBe(first.work_id);
  });

  it('carries predecessor context without duplicating a large goal', async () => {
    const { service, store } = await harness();
    // A predecessor goal at the contract maximum: it cannot also fit alongside the instruction.
    const goal = 'd'.repeat(64 * 1024);
    const first = await service.start(startInput({ goal }));
    store.setWorkStatus(first.work_id, 'completed', 'work_completed');

    const receipt = await service.instruct({ request_id: randomUUID(), work_id: first.work_id, text: 'Keep going.' });
    const successor = store.getWork(receipt.work_id)!;
    expect(store.getWork(first.work_id)?.goal).toBe(goal);
    expect(successor.goal.split('\n')[0]).toBe('Keep going.');
    expect(successor.goal).toContain(first.work_id);
    // The successor's own goal respects the goal byte budget and carries only an excerpt of the
    // predecessor's: the full text stays on the predecessor row instead of being copied forward.
    expect(Buffer.byteLength(successor.goal, 'utf8')).toBeLessThanOrEqual(64 * 1024);
    expect(successor.goal).toContain('truncated');
    expect(successor.goal).not.toContain(goal);
  });

  it('still reconciles a linked successor instruction after a stop, even though the opening was already sent', async () => {
    // The successor's opening send carries the instruction, so a linked instruction row can be
    // `pending` with attempts 0 while the outbox already has the message. Stopping the work must
    // not suppress that receipt or terminalize it from the ledger alone.
    const runtime = makeRuntime({ deliveryResults: [{ state: 'delivered' }] });
    const { service, store } = await harness({ runtime });
    const first = await service.start(startInput());
    store.setWorkStatus(first.work_id, 'completed', 'work_completed');
    const linked = await service.instruct({ request_id: randomUUID(), work_id: first.work_id, text: 'Follow up on the parser.' });
    const instruction = store.listCommands(linked.work_id, 10).find(command => command.kind === 'instruct')!;
    const opening = store.listCommands(linked.work_id, 10).find(command => command.kind === 'start')!;
    expect(instruction.outbox_input_id).toBe(opening.request_id);
    expect(instruction.outbox_input_id).not.toBe(instruction.request_id);

    // Paused before the pump ever touched the linked instruction: it must still be polled, because
    // the opening row for its outbox input may already be a durable, delivered input.
    await service.control({ request_id: randomUUID(), work_id: linked.work_id, action: 'pause' });
    await service.pumpNow();
    expect(runtime.deliveries.at(-1)?.outboxInputId).toBe(opening.request_id);
    expect(store.getCommand(instruction.request_id)?.delivery_state).toBe('delivered');

    // The same for cancel: a linked instruction is never terminalized from the ledger alone.
    const second = await service.start(startInput());
    store.setWorkStatus(second.work_id, 'completed', 'work_completed');
    const linkedTwo = await service.instruct({ request_id: randomUUID(), work_id: second.work_id, text: 'Another follow-up.' });
    const instructionTwo = store.listCommands(linkedTwo.work_id, 10).find(command => command.kind === 'instruct')!;
    await service.control({ request_id: randomUUID(), work_id: linkedTwo.work_id, action: 'cancel' });
    expect(store.getCommand(instructionTwo.request_id)?.delivery_state).toBe('pending');
    await service.pumpNow();
    expect(store.getCommand(instructionTwo.request_id)?.delivery_state).toBe('delivered');
    expect(store.getWork(linkedTwo.work_id)?.status).toBe('cancelled');
  });

  it('keeps the successor goal inside the goal byte budget when the instruction is itself huge', async () => {
    const { service, store } = await harness();
    // Multibyte text throughout: a UTF-16 slice would overshoot a byte budget by up to 3x, so the
    // bound is only meaningful if it is asserted in bytes on CJK content.
    const first = await service.start(startInput({ goal: '다'.repeat(20_000) }));
    store.setWorkStatus(first.work_id, 'completed', 'work_completed');
    const instruction = '지'.repeat(20_000);
    const receipt = await service.instruct({ request_id: randomUUID(), work_id: first.work_id, text: instruction });
    const successor = store.getWork(receipt.work_id)!;
    expect(Buffer.byteLength(successor.goal, 'utf8')).toBeLessThanOrEqual(64 * 1024);
    // The request survives whole, even though it is what consumes the budget.
    expect(successor.goal.startsWith(instruction)).toBe(true);
    expect(successor.goal).toContain(first.work_id);

    // A maximal instruction (65,535 of the 65,536 bytes) leaves no room for any context at all:
    // the goal is the request alone, and the lineage survives on the row itself.
    store.setWorkStatus(receipt.work_id, 'completed', 'work_completed');
    const maximal = '지'.repeat(21_845);
    expect(Buffer.byteLength(maximal, 'utf8')).toBe(65_535);
    const tight = await service.instruct({ request_id: randomUUID(), work_id: receipt.work_id, text: maximal });
    const tightRow = store.getWork(tight.work_id)!;
    expect(tightRow.goal).toBe(maximal);
    expect(Buffer.byteLength(tightRow.goal, 'utf8')).toBeLessThanOrEqual(64 * 1024);
    expect(tightRow.predecessor_work_id).toBe(receipt.work_id);
    await expect(service.status({ work_id: tight.work_id })).resolves.toMatchObject({ work_id: tight.work_id });
  });

  it('creates one successor for concurrent instructions, with one receipt per request id', async () => {
    const { service, store } = await harness();
    const first = await service.start(startInput());
    store.setWorkStatus(first.work_id, 'completed', 'work_completed');

    const requestId = randomUUID();
    const [a, b] = await Promise.all([
      service.instruct({ request_id: requestId, work_id: first.work_id, text: 'Same instruction.' }),
      service.instruct({ request_id: requestId, work_id: first.work_id, text: 'Same instruction.' })
    ]);
    expect(a).toEqual(b);
    expect(store.countWorks()).toBe(2);
    expect(store.listCommands(a.work_id, 20).filter(command => command.kind === 'instruct')).toHaveLength(1);

    // Two different request ids arriving together on the same completed work still produce
    // exactly one successor: the loser of the race sees the winner's link.
    const [c, d] = await Promise.all([
      service.instruct({ request_id: randomUUID(), work_id: first.work_id, text: 'One more thing.' }),
      service.instruct({ request_id: randomUUID(), work_id: first.work_id, text: 'And another.' })
    ]);
    expect(c.work_id).toBe(a.work_id);
    expect(d.work_id).toBe(a.work_id);
    expect(store.countWorks()).toBe(2);
    expect(store.getWork(first.work_id)?.successor_work_id).toBe(a.work_id);
  });

  it('keeps cancellation terminal across the chain and leaves live work alone', async () => {
    const { service, store } = await harness();
    const running = await service.start(startInput());
    const onRunning = await service.instruct({ request_id: randomUUID(), work_id: running.work_id, text: 'Keep going.' });
    expect(onRunning.work_id).toBe(running.work_id);
    expect(store.countWorks()).toBe(1);

    store.setWorkStatus(running.work_id, 'completed', 'work_completed');
    const continued = await service.instruct({ request_id: randomUUID(), work_id: running.work_id, text: 'Continue.' });
    await service.control({ request_id: randomUUID(), work_id: continued.work_id, action: 'cancel' });

    // The cancelled tail is terminal wherever it sits in the chain: continuing it again would be
    // a silent revival, so the caller must start something new.
    const refused = await rejection(service.instruct({ request_id: randomUUID(), work_id: running.work_id, text: 'One more thing.' }));
    expect(refused.code).toBe(WORK_ERROR_CODES.workAlreadyCancelled);
    expect(store.countWorks()).toBe(2);
  });

  it('refuses a continuation chain that loops instead of walking it forever', async () => {
    const { service, store } = await harness();
    const first = await service.start(startInput());
    const second = await service.start(startInput());
    store.setWorkStatus(first.work_id, 'completed', 'work_completed');
    store.setWorkStatus(second.work_id, 'completed', 'work_completed');
    store.runInTransaction(() => {
      store.updateWork(first.work_id, { successor_work_id: second.work_id });
      store.updateWork(second.work_id, { successor_work_id: first.work_id });
    });

    const error = await rejection(service.instruct({ request_id: randomUUID(), work_id: first.work_id, text: 'Anything.' }));
    expect(error.code).toBe(WORK_ERROR_CODES.continuationConflict);
    expect(store.countWorks()).toBe(2);
  });

  it('follows a long recorded chain to its tip instead of refusing it at an arbitrary depth', async () => {
    const { service, store } = await harness();
    // 40 continuations: more than any fixed hop budget would allow, and a perfectly ordinary
    // history for a work the user kept extending.
    const first = await service.start(startInput());
    let current = first.work_id;
    for (let hop = 0; hop < 40; hop += 1) {
      store.setWorkStatus(current, 'completed', 'work_completed');
      const receipt = await service.instruct({ request_id: randomUUID(), work_id: current, text: `Step ${hop}.` });
      current = receipt.work_id;
    }
    expect(store.countWorks()).toBe(41);

    // One more instruction on the ORIGINAL id walks the whole chain and lands on the live tail.
    const tip = await service.instruct({ request_id: randomUUID(), work_id: first.work_id, text: 'The last step.' });
    expect(tip.work_id).toBe(current);
    expect(store.countWorks()).toBe(41);
    expect(store.getWork(tip.work_id)?.predecessor_work_id).not.toBeNull();
    expect(store.getWork(first.work_id)?.status).toBe('completed');
  });

  it('refuses a link that names a work the ledger does not have', async () => {
    const { service, store } = await harness();
    const work = await service.start(startInput());
    store.setWorkStatus(work.work_id, 'completed', 'work_completed');
    store.updateWork(work.work_id, { successor_work_id: randomUUID() });

    const error = await rejection(service.instruct({ request_id: randomUUID(), work_id: work.work_id, text: 'Anything.' }));
    expect(error.code).toBe(WORK_ERROR_CODES.continuationConflict);
    expect(store.countWorks()).toBe(1);
  });
});

// -----------------------------------------------------------------------------------------
// Delivery acknowledgement: queued and unknown are not delivery
// -----------------------------------------------------------------------------------------

describe('delivery acknowledgement', () => {
  it('records a queued send as queued, not delivered, and reconciles it on the late acknowledgement', async () => {
    const runtime = makeRuntime({ deliveryResults: [{ state: 'queued', detail: 'waiting for the chat to take it' }, { state: 'delivered' }] });
    const { service, store } = await harness({ runtime });
    const work = await service.start(startInput());
    const requestId = randomUUID();
    await service.instruct({ request_id: requestId, work_id: work.work_id, text: 'Run the checks.' });

    await service.pumpNow();
    const queued = store.getCommand(requestId)!;
    expect(queued.delivery_state).toBe('queued');
    // Being held by the outbox is not an attempt's failure, so the budget is not consumed.
    expect(queued.attempts).toBe(0);
    const kinds = async (): Promise<string[]> => (await service.events({ work_id: work.work_id })).events.map(event => event.kind);
    expect(await kinds()).toContain('instruction_delivery_queued');
    expect(await kinds()).not.toContain('instruction_delivered');

    // The row is retried under the same stable outbox id until the real outcome is known.
    await service.pumpNow();
    expect(runtime.deliveries.map(entry => entry.outboxInputId)).toEqual([requestId, requestId]);
    expect(store.getCommand(requestId)?.delivery_state).toBe('delivered');
    expect(await kinds()).toContain('instruction_delivered');

    // A delivered command is never sent again.
    await service.pumpNow();
    expect(runtime.deliveries).toHaveLength(2);
  });

  it('keeps an unconfirmed send reconcilable, raises a blocker, and clears it on the late acknowledgement', async () => {
    const runtime = makeRuntime({
      deliveryResults: [{ state: 'unknown', error: 'the hand-off was interrupted' }, { state: 'unknown', error: 'the hand-off was interrupted' }, { state: 'unknown', error: 'the hand-off was interrupted' }, { state: 'delivered' }]
    });
    const { service, store } = await harness({ runtime });
    const work = await service.start(startInput());
    const requestId = randomUUID();
    await service.instruct({ request_id: requestId, work_id: work.work_id, text: 'Run the checks.' });

    await service.pumpNow();
    expect(store.getCommand(requestId)?.delivery_state).toBe('unknown');
    expect(store.getWork(work.work_id)?.blocker).toBeNull();
    await service.pumpNow();
    await service.pumpNow();

    // Three unconfirmed attempts raise a blocker — but the command is NOT parked as failed: the
    // acknowledgement that makes its outcome knowable can still arrive.
    expect(store.getCommand(requestId)?.delivery_state).toBe('unknown');
    expect(store.getWork(work.work_id)?.blocker?.code).toBe(WORK_BLOCKER_CODES.instructionDeliveryUnknown);

    await service.pumpNow();
    expect(store.getCommand(requestId)?.delivery_state).toBe('delivered');
    expect(store.getWork(work.work_id)?.blocker).toBeNull();
    const unknownEvents = (await service.events({ work_id: work.work_id })).events.filter(event => event.kind === 'instruction_delivery_unknown');
    // The fact is recorded once, on the transition, rather than once per poll.
    expect(unknownEvents).toHaveLength(1);
  });

  it('clears the unconfirmed blocker after a restart re-armed the row and the acknowledgement finally lands', async () => {
    const first = makeRuntime({ deliveryResults: [{ state: 'unknown', error: 'the hand-off was interrupted' }, { state: 'unknown', error: 'the hand-off was interrupted' }, { state: 'unknown', error: 'the hand-off was interrupted' }] });
    const { service, store, dir } = await harness({ runtime: first });
    const work = await service.start(startInput());
    const requestId = randomUUID();
    await service.instruct({ request_id: requestId, work_id: work.work_id, text: 'Run the checks.' });
    for (let i = 0; i < 3; i += 1) await service.pumpNow();
    expect(store.getWork(work.work_id)?.blocker?.code).toBe(WORK_BLOCKER_CODES.instructionDeliveryUnknown);
    // The crash window: the pump committed its intent and died before the result was recorded, so
    // the row is left mid-delivery and the work is blocked on an unconfirmed send.
    store.updateCommand(requestId, { delivery_state: 'delivering' });
    service.close();
    store.close();

    // The host restarts: reconciliation re-arms the interrupted row, so the next attempt that
    // finally succeeds sees `pending`, not `unknown`. The blocker must still clear — the fact it
    // doubted is settled, regardless of which state this process happened to observe first.
    const reopened = createWorkStore({ dataDir: dir });
    const restartedRuntime = makeRuntime({ deliveryResults: [{ state: 'delivered' }] });
    const restarted = createWorkService({
      store: reopened,
      runtime: restartedRuntime.port,
      projects: makeProjects(),
      models: { async resolve() { return { model: 'gpt-5', reasoning: null }; } },
      worktreesRoot: path.join(dir, 'worktrees')
    });
    await restarted.reconcile();
    expect(reopened.getCommand(requestId)?.delivery_state).toBe('pending');
    await restarted.pumpNow();
    expect(reopened.getCommand(requestId)?.delivery_state).toBe('delivered');
    expect(reopened.getWork(work.work_id)?.blocker).toBeNull();
    reopened.close();
  });

  it('never lets a retained send starve a fresh instruction out of the batch', async () => {
    const runtime = makeRuntime({ deliveryResults: [{ state: 'queued', detail: 'busy' }, { state: 'delivered' }, { state: 'delivered' }] });
    const { service, store } = await harness({ runtime });
    const slow = await service.start(startInput());
    const slowRequest = randomUUID();
    await service.instruct({ request_id: slowRequest, work_id: slow.work_id, text: 'For the busy chat.' });
    await service.pumpNow();
    expect(store.getCommand(slowRequest)?.delivery_state).toBe('queued');

    const fresh = await service.start(startInput());
    const freshRequest = randomUUID();
    await service.instruct({ request_id: freshRequest, work_id: fresh.work_id, text: 'For the idle chat.' });
    await service.pumpNow();

    // The fresh instruction is attempted even though the retained one is still in the work list.
    expect(runtime.deliveries.map(entry => entry.outboxInputId)).toEqual([slowRequest, freshRequest, slowRequest]);
    expect(store.getCommand(freshRequest)?.delivery_state).toBe('delivered');
    expect(store.getCommand(slowRequest)?.delivery_state).toBe('delivered');
  });

  it('does not spin an immediate retry loop when a whole batch is only waiting', async () => {
    // Every attempt is deferred (the prime conversation is not bound yet), which is no progress:
    // the follow-up must be the slow reconciliation interval, not an immediate re-run.
    const runtime = makeRuntime({ deliveryResults: [{ state: 'deferred', detail: 'the prime conversation is not bound yet' }] });
    const { service, store } = await harness({ runtime });
    const work = await service.start(startInput());
    const requestId = randomUUID();
    await service.instruct({ request_id: requestId, work_id: work.work_id, text: 'Run the checks.' });

    await service.pumpNow();
    expect(store.getCommand(requestId)?.delivery_state).toBe('pending');
    // The instruction's own admission scheduled one immediate attempt; drain it, then measure the
    // steady state, which is what must not spin.
    await vi.advanceTimersByTimeAsync(0);
    const afterFirstAttempts = runtime.deliveries.length;

    // Nothing further happens while the chat is simply not ready: no timer is churning the ledger.
    await vi.advanceTimersByTimeAsync(10_000);
    expect(runtime.deliveries).toHaveLength(afterFirstAttempts);
    // The slow bound is what eventually asks again.
    await vi.advanceTimersByTimeAsync(5_000);
    expect(runtime.deliveries).toHaveLength(afterFirstAttempts + 1);
  });

  it('leaves the revision and the event log untouched when a poll changes nothing', async () => {
    // A deferred delivery (the prime conversation is not bound yet) is not a fact about the work.
    // Before this, every 15s poll wrote the same `pending`/error back and bumped the revision, so
    // a paused or stalled work grew a revision and a `command_updated` event per tick forever.
    const runtime = makeRuntime({ deliveryResults: [{ state: 'deferred', detail: 'the prime conversation is not bound yet' }] });
    const { service, store } = await harness({ runtime });
    const work = await service.start(startInput());
    const requestId = randomUUID();
    await service.instruct({ request_id: requestId, work_id: work.work_id, text: 'Wait for the chat.' });

    const settle = async (): Promise<void> => {
      await vi.advanceTimersByTimeAsync(0);
      await vi.advanceTimersByTimeAsync(20_000);
    };
    await settle();
    const baseline = store.getWork(work.work_id)!.revision;
    const events = async (): Promise<number> => (await service.events({ work_id: work.work_id })).events.length;
    const baselineEvents = await events();
    expect(store.getCommand(requestId)).toMatchObject({ delivery_state: 'pending', attempts: 0 });

    for (let tick = 0; tick < 5; tick += 1) await settle();
    expect(store.getWork(work.work_id)!.revision).toBe(baseline);
    expect(await events()).toBe(baselineEvents);
    expect(store.getCommand(requestId)).toMatchObject({ delivery_state: 'pending', attempts: 0 });

    // A paused work is not even asked: its waiting instruction is left exactly as it is.
    await service.control({ request_id: randomUUID(), work_id: work.work_id, action: 'pause' });
    const pausedRevision = store.getWork(work.work_id)!.revision;
    const pausedEvents = await events();
    for (let tick = 0; tick < 5; tick += 1) await settle();
    expect(store.getWork(work.work_id)!.revision).toBe(pausedRevision);
    expect(await events()).toBe(pausedEvents);
    expect(store.getCommand(requestId)).toMatchObject({ delivery_state: 'pending', attempts: 0 });
    expect(runtime.deliveries.length).toBeGreaterThan(0);
  });

  it('still reconciles a queued instruction of a stopped work and does not let stopped works starve a runnable one', async () => {
    const runtime = makeRuntime({ deliveryResults: [{ state: 'queued', detail: 'busy' }, { state: 'delivered' }, { state: 'delivered' }, { state: 'delivered' }] });
    const { service, store } = await harness({ runtime });
    const stopped = await service.start(startInput());
    const stoppedRequest = randomUUID();
    await service.instruct({ request_id: stoppedRequest, work_id: stopped.work_id, text: 'Held by the outbox.' });
    await service.pumpNow();
    expect(store.getCommand(stoppedRequest)?.delivery_state).toBe('queued');

    await service.control({ request_id: randomUUID(), work_id: stopped.work_id, action: 'pause' });
    // A queued row exists as a durable outbox input, so it must keep being polled: the work being
    // paused is not evidence about a message that may already have been handed over.
    await service.pumpNow();
    expect(store.getCommand(stoppedRequest)?.delivery_state).toBe('delivered');
    expect(store.getWork(stopped.work_id)?.status).toBe('paused');

    // Twenty paused works with never-admitted instructions must not occupy the batch: the runnable
    // work's fresh instruction is still attempted.
    for (let i = 0; i < 20; i += 1) {
      const paused = await service.start(startInput());
      await service.instruct({ request_id: randomUUID(), work_id: paused.work_id, text: 'Never admitted.' });
      await service.control({ request_id: randomUUID(), work_id: paused.work_id, action: 'pause' });
    }
    const runnable = await service.start(startInput());
    const runnableRequest = randomUUID();
    await service.instruct({ request_id: runnableRequest, work_id: runnable.work_id, text: 'This one must run.' });
    await service.pumpNow();
    expect(runtime.deliveries.at(-1)?.outboxInputId).toBe(runnableRequest);
    expect(store.getCommand(runnableRequest)?.delivery_state).toBe('delivered');
  });

  it('passes the durable command instant as the stable outbox due date', async () => {
    const { service, store, runtime } = await harness();
    const work = await service.start(startInput());
    const requestId = randomUUID();
    await service.instruct({ request_id: requestId, work_id: work.work_id, text: 'Run the checks.' });
    await service.pumpNow();

    const command = store.getCommand(requestId)!;
    expect(runtime.deliveries[0]?.commandCreatedAt).toBe(command.created_at);
    // The due date is the recorded instant, not "now": a retry must not look like a new message.
    expect(command.created_at).toBeLessThanOrEqual(Date.now());
  });
});

// -----------------------------------------------------------------------------------------
// Controller continuity: binding, inbox and delivery rows
// -----------------------------------------------------------------------------------------

describe('controller continuity', () => {
  const binding = (overrides: Partial<WorkControllerBinding> = {}): WorkControllerBinding => ({
    session_id: 'session-1',
    conversation_id: 'conversation-1',
    provider_account_id: null,
    work_id: '11111111-1111-4111-8111-111111111111',
    bound_at: 10,
    enabled: true,
    event_cursor: 0,
    updated_at: 10,
    origin: 'explicit',
    ...overrides
  });

  it('round-trips a binding, anchors the provider account, and refuses a second controller', async () => {
    const { store } = await harness();
    const created = store.putControllerBinding(binding());
    expect(created).toMatchObject({ session_id: 'session-1', conversation_id: 'conversation-1', provider_account_id: null, enabled: true });
    expect(store.getControllerBinding('session-1')?.conversation_id).toBe('conversation-1');
    expect(store.getControllerBindingByConversation('conversation-1')?.session_id).toBe('session-1');
    expect(store.listControllerBindings().map(row => row.session_id)).toEqual(['session-1']);

    // The first authenticated snapshot anchors the account; a later write that cannot see the
    // account leaves the anchor alone instead of erasing the evidence that anchored it.
    expect(store.putControllerBinding(binding({ provider_account_id: 'account-1' })).provider_account_id).toBe('account-1');
    expect(store.putControllerBinding(binding()).provider_account_id).toBe('account-1');

    // The same conversation id under another account is a different chat.
    const other = await rejection(() => store.putControllerBinding(binding({ provider_account_id: 'account-2' })));
    expect(other.code).toBe(WORK_ERROR_CODES.controllerAccountConflict);
    expect(store.getControllerBinding('session-1')?.provider_account_id).toBe('account-1');

    // One conversation never becomes two controllers.
    const claimed = await rejection(() => store.putControllerBinding(binding({ session_id: 'session-2' })));
    expect(claimed.code).toBe(WORK_ERROR_CODES.controllerBindingConflict);
    expect(store.getControllerBinding('session-2')).toBeNull();

    // Rebinding the same session to a new conversation moves it.
    const moved = store.putControllerBinding(binding({ conversation_id: 'conversation-2', event_cursor: 5 }));
    expect(moved.conversation_id).toBe('conversation-2');
    expect(store.getControllerBindingByConversation('conversation-1')).toBeNull();
    expect(store.getControllerBindingByConversation('conversation-2')?.event_cursor).toBe(5);
  });

  it('notifies an identity change but never a cursor advance, so a reporter cannot feed itself', async () => {
    const { store } = await harness();
    const workId = randomUUID();
    const at = Date.now();
    store.insertWork({
      work_id: workId, title: 'bound', goal: 'keep the phone in the loop', project_path: '/tmp/fixture',
      project_name: null, base_commit: null, integration_branch: 'wgpt/x/main', integration_worktree: '/tmp/x',
      status: 'running', desired_state: null, prime_agent_id: null, prime_session_id: null, model: null,
      reasoning: null, max_workers: 2, revision: 0, blocker: null, checkpoint: null, integration_intent: null,
      predecessor_work_id: null, successor_work_id: null, created_at: at, updated_at: at
    });
    const changes: string[] = [];
    const detach = store.onChanged(change => changes.push(change.kind));
    store.putControllerBinding(binding({ work_id: workId, session_id: 'session-1', conversation_id: 'conversation-1' }));
    expect(changes).toEqual(['controller_binding_changed']);
    const revision = store.getWork(workId)!.revision;

    // Reporting progress is the reader's own bookkeeping: it must not create the next event.
    store.putControllerBinding(binding({ work_id: workId, session_id: 'session-1', conversation_id: 'conversation-1', event_cursor: 9 }));
    expect(changes).toEqual(['controller_binding_changed']);
    expect(store.getWork(workId)!.revision).toBe(revision);
    expect(store.getControllerBinding('session-1')?.event_cursor).toBe(9);

    // Disabling is an identity change, and it is how a stopped controller is observed.
    store.putControllerBinding(binding({ work_id: workId, session_id: 'session-1', conversation_id: 'conversation-1', enabled: false }));
    expect(changes).toEqual(['controller_binding_changed', 'controller_binding_changed']);
    expect(store.getControllerBinding('session-1')?.enabled).toBe(false);
    detach();
  });

  it('deduplicates inbox messages by identity and refuses a rewritten payload', async () => {
    const { store } = await harness();
    const message = (overrides: Partial<WorkControllerMessage> = {}): WorkControllerMessage => ({
      session_id: 'session-1',
      conversation_id: 'conversation-1',
      message_id: 'message-1',
      request_id: '22222222-2222-4222-8222-222222222222',
      text: 'Please also run the type check.',
      authored_at: 100,
      state: 'pending',
      work_id: null,
      error: null,
      created_at: 100,
      ...overrides
    });
    const stored = store.putControllerMessage(message());
    expect(stored.state).toBe('pending');
    expect(store.putControllerMessage(message())).toEqual(stored);
    expect(store.listPendingControllerMessages()).toHaveLength(1);

    const rewritten = await rejection(() => store.putControllerMessage(message({ text: 'Something else entirely.' })));
    expect(rewritten.code).toBe(WORK_ERROR_CODES.controllerMessageConflict);
    expect(store.getControllerMessage('session-1', 'message-1')?.text).toBe('Please also run the type check.');

    // The other observer of the SAME message derives its own request id (relay-first vs
    // native-first). One message is one durable instruction, so the later source adopts the
    // persisted receipt id rather than conflicting with it.
    const adopted = store.putControllerMessage(message({ request_id: randomUUID() }));
    expect(adopted.request_id).toBe(stored.request_id);
    expect(store.listPendingControllerMessages()).toHaveLength(1);

    const accepted = store.updateControllerMessage('session-1', 'message-1', { state: 'accepted', work_id: '33333333-3333-4333-8333-333333333333' });
    expect(accepted).toMatchObject({ state: 'accepted', work_id: '33333333-3333-4333-8333-333333333333' });
    expect(store.listPendingControllerMessages()).toHaveLength(0);

    const rejected = store.putControllerMessage(message({ message_id: 'message-2', request_id: randomUUID(), state: 'rejected', error: 'not an instruction' }));
    expect(rejected.state).toBe('rejected');
    expect(store.listPendingControllerMessages()).toHaveLength(0);
  });

  it('answers whether one work has an outstanding instruction without another work hiding it', async () => {
    const { store } = await harness();
    const work = (): string => {
      const workId = randomUUID();
      const at = Date.now();
      store.insertWork({
        work_id: workId, title: 'fixture', goal: 'goal', project_path: '/tmp/fixture', project_name: null,
        base_commit: null, integration_branch: `wgpt/${workId}/main`, integration_worktree: null, status: 'running',
        desired_state: null, prime_agent_id: null, prime_session_id: null, model: null, reasoning: null,
        max_workers: 2, revision: 0, blocker: null, checkpoint: null, integration_intent: null,
        predecessor_work_id: null, successor_work_id: null, created_at: at, updated_at: at
      });
      return workId;
    };
    const command = (workId: string, kind: 'start' | 'instruct' | 'control', delivery: 'delivered' | 'pending' | 'queued' | 'unknown' | 'delivering'): void => {
      const requestId = randomUUID();
      store.insertCommand({
        request_id: requestId, work_id: workId, kind, input_hash: 'x', text: 'text', delivery_state: delivery,
        outbox_input_id: requestId, result_json: null, attempts: 0, last_error: null, created_at: Date.now(), updated_at: Date.now()
      });
    };

    // 51 other works with instructions in flight, so a global page would be entirely theirs.
    const others = Array.from({ length: 51 }, () => work());
    for (const other of others) command(other, 'instruct', 'queued');

    const target = work();
    command(target, 'start', 'delivered');
    // A delivered control row is not an outstanding instruction, and an undelivered one is.
    expect(store.hasOutstandingInstruction(target)).toBe(false);
    command(target, 'control', 'pending');
    expect(store.hasOutstandingInstruction(target)).toBe(false);
    for (const state of ['pending', 'delivering', 'queued', 'unknown'] as const) {
      const isolated = work();
      command(isolated, 'instruct', state);
      expect(store.hasOutstandingInstruction(isolated)).toBe(true);
      expect(store.hasOutstandingInstruction(target)).toBe(false);
    }
  });

  it('cancels only the instruction that provably never left, keeping an authorized or recovered send reconcilable', async () => {
    const runtime = makeRuntime({ deliveryResults: [{ state: 'unknown', error: 'the hand-off was interrupted' }, { state: 'delivered' }, { state: 'delivered' }] });
    const { service, store } = await harness({ runtime });
    const work = await service.start(startInput());

    // 1) An ambiguous send: the outbox was called, so a native Send may already be authorized.
    const uncertain = randomUUID();
    await service.instruct({ request_id: uncertain, work_id: work.work_id, text: 'This one may have gone.' });
    await service.pumpNow();
    expect(store.getCommand(uncertain)?.delivery_state).toBe('unknown');

    // 2) An attempted-then-reset row: `pending` with attempts > 0 is a send that may have landed.
    const attempted = randomUUID();
    await service.instruct({ request_id: attempted, work_id: work.work_id, text: 'This one was attempted.' });
    store.updateCommand(attempted, { delivery_state: 'pending', attempts: 1 });

    // 3) A never-attempted row: no port call was ever made for it.
    const neverSent = randomUUID();
    await service.instruct({ request_id: neverSent, work_id: work.work_id, text: 'This one never left.' });

    await service.control({ request_id: randomUUID(), work_id: work.work_id, action: 'cancel' });

    expect(store.getWork(work.work_id)?.status).toBe('cancelled');
    expect(store.getCommand(neverSent)?.delivery_state).toBe('cancelled');
    // The ambiguous and the attempted rows keep their receipts: the work is stopped, but each may
    // already be in the conversation, and only the outbox can say so.
    expect(store.getCommand(uncertain)?.delivery_state).toBe('unknown');
    expect(store.getCommand(attempted)?.delivery_state).toBe('pending');
    expect(store.getCommand(attempted)?.attempts).toBe(1);

    // A late acknowledgement records the truth without reopening the cancelled work.
    await service.pumpNow();
    expect(store.getCommand(uncertain)?.delivery_state).toBe('delivered');
    expect(store.getWork(work.work_id)?.status).toBe('cancelled');
    expect(store.getWork(work.work_id)?.desired_state).toBeNull();
  });

  it('keeps a mid-delivery row reconcilable after a restart re-arms it, even on a cancelled work', async () => {
    const { service, store, dir } = await harness();
    const work = await service.start(startInput());
    const requestId = randomUUID();
    await service.instruct({ request_id: requestId, work_id: work.work_id, text: 'Send this before the stop.' });
    // The crash window: the pump committed `delivering` (a native Send may already be authorized)
    // and died before the result was recorded.
    store.updateCommand(requestId, { delivery_state: 'delivering', attempts: 1 });
    await service.control({ request_id: randomUUID(), work_id: work.work_id, action: 'cancel' });
    expect(store.getCommand(requestId)?.delivery_state).toBe('delivering');
    service.close();
    store.close();

    const reopened = createWorkStore({ dataDir: dir });
    const restartedRuntime = makeRuntime({ deliveryResults: [{ state: 'delivered' }] });
    const restarted = createWorkService({
      store: reopened,
      runtime: restartedRuntime.port,
      projects: makeProjects(),
      models: { async resolve() { return { model: 'gpt-5', reasoning: null }; } },
      worktreesRoot: path.join(dir, 'worktrees')
    });
    await restarted.reconcile();
    expect(reopened.getCommand(requestId)?.delivery_state).toBe('pending');
    expect(reopened.getWork(work.work_id)?.status).toBe('cancelled');
    await restarted.pumpNow();
    expect(reopened.getCommand(requestId)?.delivery_state).toBe('delivered');
    expect(reopened.getWork(work.work_id)?.status).toBe('cancelled');
    reopened.close();
  });

  it('lists one binding’s pending inbox without another binding crowding it out', async () => {
    const { store } = await harness();
    const row = (sessionId: string, messageId: string, createdAt: number): WorkControllerMessage => ({
      session_id: sessionId,
      conversation_id: `conversation-${sessionId}`,
      message_id: messageId,
      request_id: randomUUID(),
      text: `instruction ${messageId}`,
      authored_at: createdAt,
      state: 'pending',
      work_id: null,
      error: null,
      created_at: createdAt
    });
    // Session B's older backlog fills the global page first; session A's own rows must still be
    // enumerable, in their own order, without being starved out of it.
    store.putControllerMessage(row('session-b', 'b-1', 1));
    store.putControllerMessage(row('session-b', 'b-2', 2));
    store.putControllerMessage(row('session-a', 'a-1', 3));
    store.putControllerMessage(row('session-a', 'a-2', 4));
    store.putControllerMessage(row('session-a', 'a-3', 5));

    expect(store.listPendingControllerMessages(2).map(entry => entry.message_id)).toEqual(['b-1', 'b-2']);
    expect(store.listPendingControllerMessagesForSession('session-a').map(entry => entry.message_id)).toEqual(['a-1', 'a-2', 'a-3']);
    expect(store.listPendingControllerMessagesForSession('session-a', 2).map(entry => entry.message_id)).toEqual(['a-1', 'a-2']);

    store.updateControllerMessage('session-a', 'a-1', { state: 'accepted', work_id: randomUUID() });
    expect(store.listPendingControllerMessagesForSession('session-a').map(entry => entry.message_id)).toEqual(['a-2', 'a-3']);
  });

  it('records each event result once and tracks what the original conversation took', async () => {
    const { store } = await harness();
    const delivery = (overrides: Partial<WorkControllerDelivery> = {}): WorkControllerDelivery => ({
      delivery_id: 'delivery-1',
      session_id: 'session-1',
      conversation_id: 'conversation-1',
      work_id: '11111111-1111-4111-8111-111111111111',
      bound_at: 10,
      provider_account_id: 'account-1',
      event_sequence: 4,
      text: 'Work started.',
      state: 'pending',
      error: null,
      created_at: 100,
      updated_at: 100,
      ...overrides
    });
    expect(store.putControllerDelivery(delivery()).state).toBe('pending');
    expect(store.putControllerDelivery(delivery())).toEqual(delivery());

    const conflicting = await rejection(() => store.putControllerDelivery(delivery({ text: 'A different report.' })));
    expect(conflicting.code).toBe(WORK_ERROR_CODES.controllerDeliveryConflict);

    // The binding authority is frozen with the report: a send that re-reads a later binding (a
    // rebound conversation, or another signed-in account) must not be able to re-point it.
    const rebound = await rejection(() => store.putControllerDelivery(delivery({ bound_at: 99, provider_account_id: 'account-2' })));
    expect(rebound.code).toBe(WORK_ERROR_CODES.controllerDeliveryConflict);
    expect(store.getControllerDelivery('delivery-1')).toMatchObject({ bound_at: 10, provider_account_id: 'account-1' });

    store.putControllerDelivery(delivery({ delivery_id: 'delivery-2', session_id: 'session-2', conversation_id: 'conversation-2', event_sequence: 5 }));
    expect(store.listControllerDeliveries().map(row => row.delivery_id)).toEqual(['delivery-1', 'delivery-2']);
    expect(store.listControllerDeliveries('session-2').map(row => row.delivery_id)).toEqual(['delivery-2']);

    const delivered = store.updateControllerDelivery('delivery-1', { state: 'delivered', event_sequence: 6, error: null });
    expect(delivered).toMatchObject({ state: 'delivered', event_sequence: 6 });
    expect(store.getControllerDelivery('delivery-1')?.state).toBe('delivered');
  });

  it('survives a restart with its binding, inbox and delivery rows intact', async () => {
    const { store, dir } = await harness();
    store.putControllerBinding(binding({ provider_account_id: 'account-1' }));
    store.putControllerMessage({
      session_id: 'session-1', conversation_id: 'conversation-1', message_id: 'message-1',
      request_id: '22222222-2222-4222-8222-222222222222', text: 'Continue.', authored_at: 100,
      state: 'pending', work_id: null, error: null, created_at: 100
    });
    store.putControllerDelivery({
      delivery_id: 'delivery-1', session_id: 'session-1', conversation_id: 'conversation-1',
      work_id: '11111111-1111-4111-8111-111111111111', bound_at: 10, provider_account_id: 'account-1',
      event_sequence: 1, text: 'Started.', state: 'queued',
      error: null, created_at: 100, updated_at: 100
    });
    store.close();

    const reopened = createWorkStore({ dataDir: dir });
    try {
      expect(reopened.getControllerBinding('session-1')).toMatchObject({ conversation_id: 'conversation-1', provider_account_id: 'account-1' });
      expect(reopened.listPendingControllerMessages().map(row => row.text)).toEqual(['Continue.']);
      expect(reopened.getControllerDelivery('delivery-1')).toMatchObject({ state: 'queued', bound_at: 10, provider_account_id: 'account-1' });
    } finally {
      reopened.close();
    }
  });
});

// -----------------------------------------------------------------------------------------
// Upgrade: a ledger written by the previous build
// -----------------------------------------------------------------------------------------

/** The on-disk shape of the build before continuation existed, verbatim. */
const V1_SCHEMA = `
  CREATE TABLE works (
    work_id TEXT PRIMARY KEY, title TEXT NOT NULL, goal TEXT NOT NULL, project_path TEXT NOT NULL,
    project_name TEXT, base_commit TEXT, integration_branch TEXT, integration_worktree TEXT,
    status TEXT NOT NULL, desired_state TEXT, prime_agent_id TEXT, prime_session_id TEXT,
    model TEXT, reasoning TEXT, max_workers INTEGER NOT NULL, revision INTEGER NOT NULL DEFAULT 0,
    blocker_json TEXT, checkpoint_json TEXT, integration_intent_json TEXT,
    created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL
  );
  CREATE INDEX works_recent ON works (created_at DESC, work_id DESC);
  CREATE TABLE work_agents (
    agent_id TEXT PRIMARY KEY, work_id TEXT NOT NULL REFERENCES works(work_id) ON DELETE CASCADE,
    parent_id TEXT, role TEXT NOT NULL, label TEXT NOT NULL, state TEXT NOT NULL, session_id TEXT,
    conversation_id TEXT, generation INTEGER NOT NULL DEFAULT 0, worktree_path TEXT, branch TEXT,
    base_commit TEXT, model TEXT, reasoning TEXT, result_ref TEXT, checkpoint_ref TEXT, recovery_json TEXT,
    created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL
  );
  CREATE INDEX work_agents_work ON work_agents (work_id, created_at);
  CREATE UNIQUE INDEX work_agents_conversation ON work_agents (conversation_id) WHERE conversation_id IS NOT NULL;
  CREATE INDEX work_agents_session ON work_agents (session_id) WHERE session_id IS NOT NULL;
  CREATE UNIQUE INDEX work_agents_single_prime ON work_agents (work_id) WHERE role = 'prime';
  CREATE TABLE work_operations (
    operation_id TEXT PRIMARY KEY, work_id TEXT NOT NULL REFERENCES works(work_id) ON DELETE CASCADE,
    agent_id TEXT NOT NULL, generation INTEGER NOT NULL, tool TEXT NOT NULL, args_hash TEXT NOT NULL,
    state TEXT NOT NULL, process_id TEXT, result_ref TEXT, result_json TEXT, session_id TEXT,
    expect_before_json TEXT, expect_after_json TEXT, retry_of TEXT, retry_operation_id TEXT,
    resolution_json TEXT, created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL
  );
  CREATE INDEX work_operations_work ON work_operations (work_id, created_at DESC);
  CREATE INDEX work_operations_agent ON work_operations (agent_id, generation, created_at DESC);
  CREATE INDEX work_operations_state ON work_operations (state);
  CREATE TABLE work_commands (
    request_id TEXT PRIMARY KEY, work_id TEXT NOT NULL REFERENCES works(work_id) ON DELETE CASCADE,
    kind TEXT NOT NULL, input_hash TEXT NOT NULL, text TEXT, delivery_state TEXT NOT NULL,
    outbox_input_id TEXT NOT NULL, result_json TEXT, attempts INTEGER NOT NULL DEFAULT 0, last_error TEXT,
    created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL
  );
  CREATE INDEX work_commands_work ON work_commands (work_id, created_at);
  CREATE INDEX work_commands_delivery ON work_commands (delivery_state, created_at);
  CREATE TABLE work_events (
    work_id TEXT NOT NULL REFERENCES works(work_id) ON DELETE CASCADE, sequence INTEGER NOT NULL,
    kind TEXT NOT NULL, payload_json TEXT NOT NULL, at INTEGER NOT NULL, PRIMARY KEY (work_id, sequence)
  );
  CREATE TABLE work_artifacts (
    artifact_id TEXT PRIMARY KEY, work_id TEXT NOT NULL REFERENCES works(work_id) ON DELETE CASCADE,
    agent_id TEXT, session_id TEXT NOT NULL, asset_id TEXT NOT NULL, kind TEXT NOT NULL, query_hash TEXT,
    page_index INTEGER NOT NULL DEFAULT 0, page_count INTEGER NOT NULL DEFAULT 1, hit_count INTEGER NOT NULL DEFAULT 0,
    total_hits INTEGER NOT NULL DEFAULT 0, truncated_reason TEXT, byte_size INTEGER NOT NULL DEFAULT 0,
    created_at INTEGER NOT NULL
  );
  CREATE INDEX work_artifacts_query ON work_artifacts (work_id, kind, query_hash, page_index);
`;

/** The previous build's `requestHash('start', …)`, replicated so the on-disk digest is pinned. */
function legacyStartHash(payload: Record<string, unknown>): string {
  const canonical = (value: unknown): unknown => {
    if (value === null || typeof value !== 'object') return value;
    if (Array.isArray(value)) return value.map(canonical);
    const source = value as Record<string, unknown>;
    const out: Record<string, unknown> = {};
    for (const key of Object.keys(source).sort()) {
      if (source[key] === undefined) continue;
      out[key] = canonical(source[key]);
    }
    return out;
  };
  return createHash('sha256').update(JSON.stringify({ kind: 'start', payload: canonical(payload) }), 'utf8').digest('hex');
}

describe('upgrade from the previous ledger', () => {
  it('adds the continuation columns and tables without rewriting what was already recorded', async () => {
    const dir = await makeTempDir('wgpt-upgrade-');
    dirs.push(dir);
    const { DatabaseSync } = await import('node:sqlite');
    const legacy = new DatabaseSync(path.join(dir, 'work.sqlite'));
    legacy.exec('CREATE TABLE work_schema_migrations (version INTEGER PRIMARY KEY, applied_at INTEGER NOT NULL)');
    legacy.exec('INSERT INTO work_schema_migrations (version, applied_at) VALUES (1, 0)');
    legacy.exec(V1_SCHEMA);

    const at = 1_700_000_000_000;
    const workId = randomUUID();
    const primeId = randomUUID();
    const requestId = randomUUID();
    const goal = 'Finish the v1 work.';
    legacy.prepare(`INSERT INTO works (work_id, title, goal, project_path, project_name, status, max_workers, revision, created_at, updated_at)
      VALUES (?,?,?,?,?,?,?,?,?,?)`).run(workId, 'v1 work', goal, '/tmp/fixture', 'fixture', 'completed', 2, 7, at, at);
    legacy.prepare(`INSERT INTO work_agents (agent_id, work_id, role, label, state, generation, created_at, updated_at)
      VALUES (?,?,?,?,?,?,?,?)`).run(primeId, workId, 'prime', 'prime', 'finished', 0, at, at);
    legacy.prepare(`INSERT INTO work_commands (request_id, work_id, kind, input_hash, text, delivery_state, outbox_input_id, attempts, created_at, updated_at)
      VALUES (?,?,?,?,?,?,?,?,?,?)`).run(
      requestId, workId, 'start',
      legacyStartHash({
        kind: 'start',
        project_path: path.resolve('/tmp/fixture'),
        goal,
        title: null,
        model: null,
        reasoning: null,
        max_workers: 2
      }),
      goal, 'delivered', requestId, 0, at, at
    );
    legacy.close();

    const store = createWorkStore({ dataDir: dir });
    try {
      // The recorded row is exactly what it was, and the link columns are simply absent.
      const work = store.getWork(workId)!;
      expect(work).toMatchObject({ status: 'completed', goal, revision: 7, created_at: at, prime_agent_id: null });
      expect(work.predecessor_work_id).toBeNull();
      expect(work.successor_work_id).toBeNull();
      expect(store.getCommand(requestId)?.delivery_state).toBe('delivered');

      // The continuity tables exist and are usable after the migration.
      expect(store.listControllerBindings()).toEqual([]);
      expect(store.putControllerBinding({
        session_id: 'session-1', conversation_id: 'conversation-1', provider_account_id: null,
        work_id: workId, bound_at: at, enabled: true, event_cursor: 0, updated_at: at
      }).session_id).toBe('session-1');

      // The old start command is not re-sent, and its request id still replays: the idempotency
      // hash of an ordinary start did not change with the new schema.
      const runtime = makeRuntime();
      const service = createWorkService({
        store,
        runtime: runtime.port,
        projects: makeProjects(),
        models: { async resolve() { return { model: 'gpt-5', reasoning: null }; } },
        worktreesRoot: path.join(dir, 'worktrees')
      });
      await service.pumpNow();
      expect(runtime.deliveries).toHaveLength(0);
      const replayed = await service.start({ request_id: requestId, project_path: '/tmp/fixture', goal });
      expect(replayed.work_id).toBe(workId);
      expect(replayed.status).toBe('completed');
      expect(store.countWorks()).toBe(1);
    } finally {
      store.close();
    }
  });
});
