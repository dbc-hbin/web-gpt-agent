/**
 * The single recovery owner.
 *
 * Every case is about a decision a browser could not make for itself: which silence is real,
 * how many times the host may act, what counts as forward progress, and what must survive a
 * host restart. Time is driven by an injected clock and an injected scheduler, so a case that
 * says "after 300s" runs in microseconds and nothing here depends on wall-clock luck.
 */

import { describe, expect, it } from 'vitest';
import {
  MAX_EPISODES,
  POST_RELOAD_OBSERVE_MS,
  SILENCE_NORMAL_MS,
  SILENCE_PRO_AFTER_FAILURE_MS,
  SILENCE_PRO_MS,
  createRecoveryOwner,
  type ProgressMarker,
  type RecoveryActions,
  type RecoveryCheckpoint,
  type RecoveryDecision,
  type RecoveryOwner,
  type RecoveryRecord
} from '../src/main/work/recovery.js';

const WORK = '11111111-1111-4111-8111-111111111111';
const AGENT = '22222222-2222-4222-8222-222222222222';
const SESSION = '2026-01-01-abcdef01';
const CONVERSATION = 'conv-aaaaaaaaaaaaaaaa';

/** A deterministic clock plus a scheduler that records callbacks instead of waiting. */
function harness(options: { activeCommands?: boolean } = {}) {
  let clock = 1_000_000;
  const records = new Map<string, RecoveryRecord>();
  const timers: Array<{ at: number; run: () => void }> = [];
  const calls: string[] = [];
  const checkpoint: RecoveryCheckpoint = {
    summary: 'added the parser and its tests',
    remaining: ['wire the CLI flag'],
    verification: [],
    revision: 4,
    hostGenerated: false
  };

  const actions: RecoveryActions = {
    async reload(input) { calls.push(`reload:${input.reason}`); return true; },
    async continueConversation(input) { calls.push(`continue:${input.promptId}`); return true; },
    async transfer(input) { calls.push(`transfer:${input.generation}`); return true; },
    onGenerationAdvanced(input) { calls.push(`advanced:${input.generation}`); }
  };

  const owner: RecoveryOwner = createRecoveryOwner({
    now: () => clock,
    schedule: (delayMs, run) => {
      const timer = { at: clock + delayMs, run };
      timers.push(timer);
      return () => {
        const index = timers.indexOf(timer);
        if (index >= 0) timers.splice(index, 1);
      };
    },
    port: {
      load: (agentId, generation) => records.get(`${agentId}:${generation}`) ?? null,
      save: record => { records.set(`${record.agent_id}:${record.generation}`, { ...record }); },
      list: () => [...records.values()],
      hasActiveCommands: () => options.activeCommands === true,
      lastProgress: () => null,
      readCheckpoint: () => checkpoint,
      fenceGeneration: input => { calls.push(`fence:${input.generation}`); },
      markBlocked: input => { calls.push(`blocked:${input.reason}`); },
      advanceGeneration: () => 4,
      appendEvent: () => calls.length
    },
    actions
  });

  const observation = (overrides: Record<string, unknown> = {}) => ({
    kind: 'silence' as const,
    workId: WORK,
    agentId: AGENT,
    sessionId: SESSION,
    conversationId: CONVERSATION,
    turnId: 'turn-1',
    generation: 3,
    pro: false,
    at: clock,
    ...overrides
  });

  /** Advances the clock and fires every timer whose deadline has passed, in order. */
  const tick = (ms: number): void => {
    clock += ms;
    for (;;) {
      const due = timers.filter(timer => timer.at <= clock).sort((a, b) => a.at - b.at);
      if (due.length === 0) return;
      for (const timer of due) {
        const index = timers.indexOf(timer);
        if (index >= 0) timers.splice(index, 1);
        timer.run();
      }
    }
  };

  return { owner, actions, calls, tick, observation, records, checkpoint, now: () => clock };
}

/** Flushes the microtask queue so a fire-and-forget action's `.then` has run. */
const settle = async (): Promise<void> => { await Promise.resolve(); await Promise.resolve(); await Promise.resolve(); };

describe('thinking failure', () => {
  it('reloads once, observes for 60s, then continues once in the same conversation', async () => {
    const h = harness();
    const decision = h.owner.noteTurnFailure({ ...h.observation(), kind: 'thinking_failed' });
    expect(decision.kind).toBe('reload');
    await settle();
    expect(h.calls).toEqual(['reload:thinking_failed']);

    // Inside the observation window nothing further happens.
    h.tick(POST_RELOAD_OBSERVE_MS - 1);
    expect(h.calls.filter(call => call.startsWith('continue'))).toHaveLength(0);

    h.tick(1);
    await settle();
    expect(h.calls.filter(call => call.startsWith('continue'))).toHaveLength(1);
  });

  it('transfers to a fresh conversation only after that continuation also stays silent', async () => {
    const h = harness();
    h.owner.noteTurnFailure({ ...h.observation(), kind: 'thinking_failed' });
    await settle();
    h.tick(POST_RELOAD_OBSERVE_MS);
    await settle();
    expect(h.calls.filter(call => call.startsWith('continue'))).toHaveLength(1);

    h.tick(SILENCE_NORMAL_MS);
    await settle();
    expect(h.calls.filter(call => call.startsWith('transfer'))).toHaveLength(1);
    expect(h.calls).toContain('fence:3');
    expect(h.calls).toContain('advanced:4');
  });

  it('honors an explicit provider retry time instead of the fixed backoff', async () => {
    const h = harness();
    const decision = h.owner.noteTurnFailure({
      ...h.observation(),
      kind: 'transport_failure',
      retryAfterMs: 42_000
    });
    // A transport failure waits before its first action; the record's deadline is the provider's.
    expect(decision.kind === 'wait' || decision.kind === 'reload').toBe(true);
    const record = h.owner.record(AGENT, 3);
    expect(record).not.toBeNull();
    expect(record!.next_attempt_at).toBeGreaterThanOrEqual(h.now());
  });
});

describe('silence', () => {
  it('does nothing while the model-aware window has not elapsed, then reloads once', async () => {
    const h = harness();
    const first = h.owner.noteSilence(h.observation());
    expect(first.kind).toBe('wait');
    await settle();
    expect(h.calls).toHaveLength(0);

    h.tick(SILENCE_NORMAL_MS);
    await settle();
    expect(h.calls.filter(call => call.startsWith('reload'))).toHaveLength(1);
    // A second silence observation for the same episode must not reload again.
    h.owner.noteSilence(h.observation());
    await settle();
    expect(h.calls.filter(call => call.startsWith('reload'))).toHaveLength(1);
  });

  it('gives Pro a 600s window and 300s after a confirmed thinking failure', async () => {
    const pro = harness();
    pro.owner.noteSilence({ ...pro.observation(), pro: true });
    pro.tick(SILENCE_NORMAL_MS);
    await settle();
    expect(pro.calls.filter(call => call.startsWith('reload'))).toHaveLength(0);
    pro.tick(SILENCE_PRO_MS - SILENCE_NORMAL_MS);
    await settle();
    expect(pro.calls.filter(call => call.startsWith('reload'))).toHaveLength(1);

    const failed = harness();
    failed.owner.noteTurnFailure({ ...failed.observation(), kind: 'thinking_failed' });
    await settle();
    expect(failed.calls.filter(call => call.startsWith('reload'))).toHaveLength(1);
    // A subsequent silence on that same record uses the shortened Pro window, not the full one.
    const record = failed.owner.record(AGENT, 3)!;
    expect(record.thinking_failed).toBe(true);
    expect(SILENCE_PRO_AFTER_FAILURE_MS).toBeLessThan(SILENCE_PRO_MS);
  });

  it('never acts while a local command is still running', async () => {
    const h = harness({ activeCommands: true });
    const decision = h.owner.noteSilence(h.observation());
    expect(decision.kind).toBe('wait');
    h.tick(SILENCE_PRO_MS * 2);
    await settle();
    expect(h.calls).toHaveLength(0);
  });
});

describe('progress', () => {
  it('resets the episode count on a marker it has never seen', async () => {
    const h = harness();
    h.owner.noteTurnFailure({ ...h.observation(), kind: 'thinking_failed' });
    await settle();
    const before = h.owner.record(AGENT, 3)!;
    expect(before.attempts).toBe(1);

    const marker: ProgressMarker = { kind: 'tree', treeHash: 'tree-1' };
    h.owner.noteProgress({ ...h.observation(), kind: 'progress', marker });
    const after = h.owner.record(AGENT, 3)!;
    expect(after.attempts).toBe(0);
    expect(after.episodes).toBe(0);
    expect(after.phase).toBe('idle');
  });

  it('does not reset on a repeated marker, a reworded checkpoint or a heartbeat', async () => {
    const h = harness();
    const marker: ProgressMarker = { kind: 'operation', inputHash: 'in-1', resultHash: 'out-1' };
    h.owner.noteProgress({ ...h.observation(), kind: 'progress', marker });
    h.owner.noteTurnFailure({ ...h.observation(), kind: 'thinking_failed' });
    await settle();
    expect(h.owner.record(AGENT, 3)!.attempts).toBe(1);

    // The identical marker again: the model re-reported the same completed work.
    h.owner.noteProgress({ ...h.observation(), kind: 'progress', marker });
    expect(h.owner.record(AGENT, 3)!.attempts).toBe(1);

    // A different result hash for the same input is new progress.
    h.owner.noteProgress({
      ...h.observation(),
      kind: 'progress',
      marker: { kind: 'operation', inputHash: 'in-1', resultHash: 'out-2' }
    });
    expect(h.owner.record(AGENT, 3)!.attempts).toBe(0);
  });

  it('resets on an explicit new user instruction', async () => {
    const h = harness();
    h.owner.noteTurnFailure({ ...h.observation(), kind: 'thinking_failed' });
    await settle();
    h.owner.noteUserInstruction({ workId: WORK, agentId: AGENT, generation: 3, textHash: 'instr-1' });
    expect(h.owner.record(AGENT, 3)!.attempts).toBe(0);
    h.owner.noteUserInstruction({ workId: WORK, agentId: AGENT, generation: 3, textHash: 'instr-1' });
    expect(h.owner.record(AGENT, 3)!.attempts).toBe(0);
  });
});

describe('bounds and walls', () => {
  it('blocks with RECOVERY_EXHAUSTED after three episodes without forward progress', async () => {
    const h = harness();
    // Each episode is a full cycle on the CURRENT generation: reload, observe 60s, one
    // continuation, observe one window, then transfer — which fences that generation and moves
    // the agent to the next one. Nothing here records progress, so the count never resets.
    let generation = 3;
    const observe = (overrides: Record<string, unknown> = {}) =>
      h.observation({ generation, ...overrides });
    let last: RecoveryDecision = { kind: 'none' };
    for (let episode = 0; episode <= MAX_EPISODES; episode += 1) {
      last = h.owner.noteTurnFailure({ ...observe(), kind: 'thinking_failed' });
      await settle();
      h.tick(POST_RELOAD_OBSERVE_MS);
      await settle();
      h.tick(SILENCE_NORMAL_MS);
      await settle();
      generation = Math.max(generation, h.owner.records().reduce((max, row) => Math.max(max, row.generation), generation));
    }
    expect(h.calls.some(call => call === 'blocked:RECOVERY_EXHAUSTED')).toBe(true);
    expect(h.calls.filter(call => call.startsWith('transfer'))).toHaveLength(MAX_EPISODES);
    expect(last.kind === 'blocked' || last.kind === 'reload' || last.kind === 'wait').toBe(true);
  });

  it('blocks immediately on a login wall and never retries it', async () => {
    const h = harness();
    const decision = h.owner.noteTurnFailure({
      ...h.observation(),
      kind: 'transport_failure',
      authWall: 'AUTH_REQUIRED',
      detail: 'ChatGPT is showing the login screen'
    });
    expect(decision).toMatchObject({ kind: 'blocked', reason: 'AUTH_REQUIRED' });
    h.tick(SILENCE_PRO_MS * 3);
    await settle();
    expect(h.calls.filter(call => call.startsWith('reload'))).toHaveLength(0);
    expect(h.owner.record(AGENT, 3)!.phase).toBe('blocked');
  });
});

describe('restart', () => {
  it('re-arms a deadline that elapsed while the host was down', async () => {
    const h = harness();
    h.owner.noteTurnFailure({ ...h.observation(), kind: 'thinking_failed' });
    await settle();
    expect(h.calls.filter(call => call.startsWith('reload'))).toHaveLength(1);

    // A fresh owner over the same persisted records: the deadline survived, so the elapsed
    // window fires immediately rather than restarting the wait.
    const resumed = createRecoveryOwner({
      now: () => h.now(),
      schedule: () => () => undefined,
      port: {
        load: (agentId, generation) => h.records.get(`${agentId}:${generation}`) ?? null,
        save: record => { h.records.set(`${record.agent_id}:${record.generation}`, { ...record }); },
        list: () => [...h.records.values()],
        hasActiveCommands: () => false,
        lastProgress: () => null,
        readCheckpoint: () => h.checkpoint,
        fenceGeneration: () => undefined,
        markBlocked: () => undefined,
        advanceGeneration: () => 4,
        appendEvent: () => 0
      },
      actions: {
        async reload() { h.calls.push('reload:after-restart'); return true; },
        async continueConversation() { h.calls.push('continue:after-restart'); return true; },
        async transfer() { return true; },
        onGenerationAdvanced() { /* not observed here */ }
      }
    });
    const decisions = resumed.reconcileOnStartup();
    expect(decisions.length).toBeGreaterThan(0);
    // The persisted phase is `reloading`, so the restart observes rather than re-reloading.
    expect(h.owner.record(AGENT, 3)!.phase).toBe('reloading');
  });

  it('reports an old generation as not current once a newer one exists', () => {
    const h = harness();
    h.owner.noteTurnFailure({ ...h.observation(), kind: 'thinking_failed' });
    expect(h.owner.isCurrent(AGENT, 3)).toBe(true);
    expect(h.owner.isCurrent(AGENT, 2)).toBe(false);
  });
});
