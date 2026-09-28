/**
 * The local connection/reconnect backend.
 *
 * What these cases defend is the seam between a caller who asks about a work's *existing* chat and
 * the three authorities that actually know the answer: the durable registry (which agent is bound
 * to which conversation), the authenticated page poll (whether that chat is open), and the saved
 * session (whether a person closed it). Every one of them is injected, because a test may not open
 * a browser or read a real profile — and the ledger under them is the real SQLite store, because
 * "which agent is bound to which conversation" is exactly the fact being reported.
 *
 * The negative cases are the point:
 *
 * - a chat the user closed is `closed`, and the same chat is `ready` again only once a page has
 *   returned *after* that decision — a sighting that predates it must not outvote it;
 * - an expected conversation is a fence: a mismatch is `unavailable` with a reason, never the
 *   registry's current value;
 * - a cancelled work, or a finished agent, is `closed` and `reconnect` does not even ask for a
 *   browser;
 * - `timeout_ms: 0` means "report now", so nothing is opened for a caller who cannot wait;
 * - one chat is one open, however many callers ask at once — and across time too: a repeated
 *   reconnect after a timeout joins the open it already started rather than launching a second
 *   page, because a launch resolving is not evidence that the page returned;
 * - every read after an await is fenced against the registry again, so a generation change or a
 *   rebind that lands while the browser is starting is reported as it now is, never as `ready`
 *   against the binding the call began with.
 */

import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import type { SessionSummary } from '../src/shared/session.js';
import { WorkServiceError, WORK_ERROR_CODES } from '../src/shared/work.js';
import { createWorkStore, type WorkAgentRow, type WorkRow, type WorkStore } from '../src/main/work/store.js';
import { createWorkConnection, type WorkConnectionDeps } from '../src/main/work/connection.js';

const WORK_ID = '11111111-1111-4111-8111-111111111111';
const AGENT_ID = '22222222-2222-4222-8222-222222222222';
const OTHER_AGENT_ID = '33333333-3333-4333-8333-333333333333';
const SESSION = 'session-1';
const CHAT = '0192f0a1-1111-8111-9111-111111111111';
const OTHER_CHAT = '0192f0a1-2222-8222-9222-222222222222';
const CLOCK = 1_700_000_000_000;

let directory = '';
let store: WorkStore;
/** The clock the port reads; `wait` moves it, so no test waits on wall time. */
let clock = CLOCK;
let opened: string[];
let sighting: number | null;
let session: SessionSummary | null;

function workRow(overrides: Partial<WorkRow> = {}): WorkRow {
  return {
    work_id: WORK_ID, title: 'Connection', goal: 'Report the chat.', project_path: directory,
    project_name: 'connection', base_commit: null, integration_branch: `wgpt/${WORK_ID}/main`,
    integration_worktree: path.join(directory, 'worktrees', WORK_ID), status: 'running',
    desired_state: null, prime_agent_id: AGENT_ID, prime_session_id: SESSION, model: null,
    reasoning: null, max_workers: 2, revision: 0, blocker: null, checkpoint: null,
    integration_intent: null,
    predecessor_work_id: null, successor_work_id: null,
    created_at: CLOCK, updated_at: CLOCK,
    ...overrides
  };
}

function agentRow(overrides: Partial<WorkAgentRow> = {}): WorkAgentRow {
  return {
    agent_id: AGENT_ID, work_id: WORK_ID, parent_id: null, role: 'prime', label: 'prime',
    state: 'active', session_id: SESSION, conversation_id: CHAT, generation: 3,
    worktree_path: null, branch: null, base_commit: null, model: null, reasoning: null,
    result_ref: null, checkpoint_ref: null, created_at: CLOCK, updated_at: CLOCK,
    ...overrides
  };
}

/** A saved session attached to `conversationId`, as the session store would report it. */
function savedSession(overrides: Partial<SessionSummary> = {}): SessionSummary {
  return {
    id: SESSION, title: 'Controller', conversationId: CHAT, chatIds: [CHAT],
    startedAt: CLOCK, updatedAt: CLOCK, endedAt: null, events: 0, userMessages: 0, toolCalls: 0,
    lastToolCallAt: null, processExitNonzero: 0, toolRejected: 0, toolInternalErrors: 0,
    errors: 0, estimatedTokens: 0, contextTokens: 0, lastHandoffId: null, lastHandoffAt: null,
    lastTurnOutcome: null, agents: [], origin: null,
    ...overrides
  };
}

function port(overrides: Partial<WorkConnectionDeps> = {}) {
  return createWorkConnection({
    store: () => store,
    pageObservedAt: () => sighting,
    readSession: async () => session,
    open: async conversationId => { opened.push(conversationId); },
    now: () => clock,
    wait: async ms => { clock += Math.max(ms, 1); },
    pollMs: 50,
    ...overrides
  });
}

beforeEach(async () => {
  directory = await fs.mkdtemp(path.join(os.tmpdir(), 'clf-connection-'));
  store = createWorkStore({ dataDir: directory, fileName: `work-${randomUUID()}.sqlite` });
  clock = CLOCK;
  opened = [];
  sighting = null;
  session = savedSession();
  store.insertWork(workRow());
  store.insertAgent(agentRow());
});

afterEach(async () => {
  store.close();
  await fs.rm(directory, { recursive: true, force: true });
});

describe('work connection', () => {
  it('is ready only for a current page sighting of the exact bound chat', async () => {
    // Never seen: "closed" is the truthful answer, and it says which fact is missing.
    const first = await port().connection({ work_id: WORK_ID });
    expect(first).toMatchObject({
      work_id: WORK_ID, work_state: 'running', agent_id: AGENT_ID, generation: 3,
      session_id: SESSION, conversation_id: CHAT, state: 'closed', page_observed_at: null,
      browser_recovery_dismissed_at: null
    });
    expect(first.reason).toContain('no page has reported');

    sighting = CLOCK + 1_000;
    expect(await port().connection({ work_id: WORK_ID })).toMatchObject({
      state: 'ready', page_observed_at: CLOCK + 1_000, reason: null
    });
  });

  it('honours a user close until a page returns after it', async () => {
    sighting = CLOCK + 1_000;
    session = savedSession({ browserRecoveryDismissedAt: CLOCK + 2_000 });
    const closed = await port().connection({ work_id: WORK_ID });
    expect(closed).toMatchObject({ state: 'closed', browser_recovery_dismissed_at: CLOCK + 2_000 });
    expect(closed.reason).toContain('closed by the user');

    // A sighting *after* the dismissal is the real page-return path, and it lifts the suppression.
    sighting = CLOCK + 3_000;
    expect(await port().connection({ work_id: WORK_ID })).toMatchObject({ state: 'ready' });
  });

  it('never follows a session that moved to another chat', async () => {
    sighting = CLOCK + 1_000;
    session = savedSession({ conversationId: OTHER_CHAT, chatIds: [CHAT, OTHER_CHAT] });
    const result = await port().connection({ work_id: WORK_ID });
    expect(result).toMatchObject({ state: 'closed', conversation_id: CHAT, session_id: SESSION });
    expect(result.reason).toContain('no longer attached');
  });

  it('fences an expected conversation instead of rebinding it', async () => {
    sighting = CLOCK + 1_000;
    const result = await port().connection({ work_id: WORK_ID, conversation_id: OTHER_CHAT });
    expect(result).toMatchObject({
      state: 'unavailable', agent_id: null, generation: null, session_id: null, conversation_id: null
    });
    expect(result.reason).toContain('expected conversation');
    // The registry's own chat is unchanged and still reported by the unfenced read.
    expect(store.getAgent(AGENT_ID)!.conversation_id).toBe(CHAT);
  });

  it('selects a named agent, and refuses one that is not in this work', async () => {
    store.insertAgent(agentRow({
      agent_id: OTHER_AGENT_ID, role: 'worker', label: 'worker-1', session_id: null, conversation_id: null
    }));
    sighting = CLOCK + 1_000;
    const worker = await port().connection({ work_id: WORK_ID, agent_id: OTHER_AGENT_ID });
    expect(worker).toMatchObject({ state: 'unavailable', agent_id: null, reason: expect.stringContaining('no bound ChatGPT conversation') });

    const foreign = await port().connection({ work_id: WORK_ID, agent_id: randomUUID() });
    expect(foreign.reason).toContain('not part of this work');
  });

  it('refuses a work the ledger does not have', async () => {
    await expect(port().connection({ work_id: randomUUID() })).rejects.toBeInstanceOf(WorkServiceError);
    await expect(port().connection({ work_id: randomUUID() }))
      .rejects.toMatchObject({ code: WORK_ERROR_CODES.workNotFound });
  });

  it('reports a stopped lifecycle as closed and does not open a browser for it', async () => {
    store.setWorkStatus(WORK_ID, 'cancelled', 'test');
    sighting = CLOCK + 1_000;
    const cancelled = await port().reconnect({ work_id: WORK_ID, timeout_ms: 30_000 });
    expect(cancelled).toMatchObject({ work_state: 'cancelled', state: 'closed' });
    expect(cancelled.reason).toContain('cancelled');
    expect(opened).toEqual([]);

    store.setWorkStatus(WORK_ID, 'running', 'test');
    store.updateAgent(AGENT_ID, { state: 'finished' });
    const finished = await port().reconnect({ work_id: WORK_ID, timeout_ms: 30_000 });
    expect(finished).toMatchObject({ state: 'closed' });
    expect(finished.reason).toContain('finished');
    expect(opened).toEqual([]);
  });

  it('reports a paused work page honestly rather than treating it as closed', async () => {
    store.setWorkStatus(WORK_ID, 'paused', 'test');
    sighting = CLOCK + 1_000;
    expect(await port().connection({ work_id: WORK_ID })).toMatchObject({
      work_state: 'paused', state: 'ready'
    });
  });

  it('reports what is true now, and opens nothing, when the caller cannot wait', async () => {
    const result = await port().reconnect({ work_id: WORK_ID, timeout_ms: 0 });
    expect(result).toMatchObject({ state: 'closed' });
    expect(opened).toEqual([]);
  });

  it('opens the exact chat once and becomes ready when the page reports', async () => {
    const live = port({ open: async conversationId => { opened.push(conversationId); sighting = CLOCK + 500; } });
    const result = await live.reconnect({ work_id: WORK_ID, timeout_ms: 30_000 });
    expect(opened).toEqual([CHAT]);
    expect(result).toMatchObject({ state: 'ready', conversation_id: CHAT, page_observed_at: CLOCK + 500 });
  });

  it('shares one open between concurrent attempts for the same chat', async () => {
    let openedCount = 0;
    const live = port({
      open: async conversationId => {
        openedCount += 1;
        // The open yields before the page can report, which is exactly the window a second caller
        // would otherwise start a second browser in.
        await new Promise<void>(resolve => { queueMicrotask(resolve); });
        opened.push(conversationId);
        sighting = CLOCK + 500;
      }
    });
    const [first, second] = await Promise.all([
      live.reconnect({ work_id: WORK_ID, timeout_ms: 30_000 }),
      live.reconnect({ work_id: WORK_ID, timeout_ms: 30_000 })
    ]);
    expect(openedCount).toBe(1);
    expect(first).toMatchObject({ state: 'ready' });
    expect(second).toMatchObject({ state: 'ready' });
  });

  it('reports a wait that found nothing as opening, and a failed open as unavailable', async () => {
    const pending = await port().reconnect({ work_id: WORK_ID, timeout_ms: 1_000 });
    expect(pending).toMatchObject({ state: 'opening', conversation_id: CHAT });
    expect(pending.reason).toContain('1000ms');
    // The clock advanced by the requested wait, not by a real timer.
    expect(clock).toBeGreaterThanOrEqual(CLOCK + 1_000);

    const failing = port({ open: async () => { throw new Error('Chrome was not found'); } });
    const failed = await failing.reconnect({ work_id: WORK_ID, timeout_ms: 30_000 });
    expect(failed).toMatchObject({ state: 'unavailable' });
    expect(failed.reason).toContain('Chrome was not found');
  });

  it('keeps an unobserved open across a repeated timeout instead of opening a second page', async () => {
    // The launch succeeds and the page has not reported: a timeout says `opening`, which is the
    // truth, and the tab it started is still coming up.
    const live = port();
    const first = await live.reconnect({ work_id: WORK_ID, timeout_ms: 1_000 });
    expect(first).toMatchObject({ state: 'opening' });
    expect(opened).toEqual([CHAT]);

    // A repeated call joins that launch. Opening a second page for one chat is the defect: the
    // launch resolved, but the launch resolving is not evidence that the page returned.
    const second = await live.reconnect({ work_id: WORK_ID, timeout_ms: 1_000 });
    expect(second).toMatchObject({ state: 'opening' });
    expect(opened).toEqual([CHAT]);

    // Fresh page evidence for this exact chat is what retires the retained open: the page is
    // simply reported, with no further launch.
    sighting = CLOCK + 5_000;
    expect(await live.reconnect({ work_id: WORK_ID, timeout_ms: 1_000 })).toMatchObject({
      state: 'ready', conversation_id: CHAT, page_observed_at: CLOCK + 5_000
    });
    expect(opened).toEqual([CHAT]);
  });

  it('fences the registry again after the wait rather than reporting a stale binding ready', async () => {
    // A generation change lands while the browser is starting — the exact window a frozen target
    // would report `ready` across. The chat is the same one, but the binding is a new generation.
    const live = port({
      open: async conversationId => {
        opened.push(conversationId);
        store.advanceAgentGeneration({ workId: WORK_ID, agentId: AGENT_ID });
        sighting = CLOCK + 500;
      }
    });
    const advanced = await live.reconnect({ work_id: WORK_ID, timeout_ms: 30_000 });
    expect(advanced).toMatchObject({
      state: 'ready', agent_id: AGENT_ID, generation: 4, conversation_id: CHAT
    });
    expect(store.getAgent(AGENT_ID)!.generation).toBe(4);

    // And a rebind to another conversation is a refusal, not a report about the chat the caller
    // asked about: the target moved, so the answer names the chat they expected.
    sighting = null;
    opened = [];
    const moved = port({
      open: async conversationId => {
        opened.push(conversationId);
        store.bindAgentConversation({ agentId: AGENT_ID, sessionId: SESSION, conversationId: OTHER_CHAT });
        sighting = CLOCK + 500;
      }
    });
    const stale = await moved.reconnect({ work_id: WORK_ID, timeout_ms: 30_000 });
    expect(stale).toMatchObject({
      state: 'unavailable', generation: null, conversation_id: null, work_state: 'running'
    });
    expect(stale.reason).toContain('expected conversation');
  });
});
