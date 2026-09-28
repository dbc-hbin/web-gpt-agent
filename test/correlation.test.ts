import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { initDurableStore, resetDurableForTests, writeDurableNow } from '../src/main/durable.js';
import {
  appendEvent,
  createSession,
  initSessionStore,
  resetSessionStoreForTests,
  unsetSessionRootForTests
} from '../src/main/session/store.js';
import {
  observeRequestCorrelation,
  observeRequestCorrelations,
  onRequestCorrelationProof,
  requestCorrelation,
  awaitRequestCorrelation,
  restoreRequestCorrelations,
  resetCorrelationRegistryForTests,
  type RequestCorrelation
} from '../src/main/session/correlation.js';

describe('request correlation ownership', () => {
  beforeEach(() => resetCorrelationRegistryForTests());
  afterEach(() => vi.useRealTimers());

  it('spends grace once per request while accepting late exact evidence', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'performance'] });
    const first = awaitRequestCorrelation('wfr-missing', 60);
    await vi.advanceTimersByTimeAsync(60);
    expect(await first).toBeNull();
    expect(await awaitRequestCorrelation('wfr-missing', 60)).toBeNull();
    expect(vi.getTimerCount()).toBe(0);

    const other = awaitRequestCorrelation('wfr-other', 60);
    expect(vi.getTimerCount()).toBe(1);
    await vi.advanceTimersByTimeAsync(60);
    expect(await other).toBeNull();

    observeRequestCorrelation({ requestId: 'wfr-missing', conversationId: 'conv-late',
      sessionId: 'session-late', messageId: 'message-late', tool: '', observedAt: 1 });
    expect((await awaitRequestCorrelation('wfr-missing', 60))?.conversationId).toBe('conv-late');
  });

  it('shares a deadline across overlapping callers instead of restarting their grace', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'performance'] });
    const first = awaitRequestCorrelation('wfr-overlap', 100);
    await vi.advanceTimersByTimeAsync(40);
    const second = awaitRequestCorrelation('wfr-overlap', 100);
    await vi.advanceTimersByTimeAsync(60);
    expect(await first).toBeNull();
    expect(await second).toBeNull();
    expect(vi.getTimerCount()).toBe(0);
  });

  it('retains the remaining longer recorder grace after a shorter identity timeout', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'performance'] });
    const short = awaitRequestCorrelation('wfr-longer', 15);
    await vi.advanceTimersByTimeAsync(15);
    expect(await short).toBeNull();
    const longer = awaitRequestCorrelation('wfr-longer', 20);
    await vi.advanceTimersByTimeAsync(4);
    expect(vi.getTimerCount()).toBe(1);
    observeRequestCorrelation({ requestId: 'wfr-longer', conversationId: 'conv-proved',
      sessionId: 'session-proved', messageId: 'message-proved', tool: '', observedAt: 1 });
    expect((await longer)?.conversationId).toBe('conv-proved');
    expect(vi.getTimerCount()).toBe(0);
  });

  it('ends the longer grace at its original deadline and leaves zero-time lookups uncharged', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'performance'] });
    expect(await awaitRequestCorrelation('wfr-budget', 0)).toBeNull();
    await vi.advanceTimersByTimeAsync(100);
    const short = awaitRequestCorrelation('wfr-budget', 15);
    await vi.advanceTimersByTimeAsync(15);
    expect(await short).toBeNull();
    const longer = awaitRequestCorrelation('wfr-budget', 20);
    await vi.advanceTimersByTimeAsync(5);
    expect(await longer).toBeNull();
    expect(await awaitRequestCorrelation('wfr-budget', 20)).toBeNull();
    expect(vi.getTimerCount()).toBe(0);
  });

  it('keeps one turn-level request id owned across different MCP messages and tools', () => {
    const requestId = 'wfr_shared_turn';
    const now = Date.now();
    expect(
      observeRequestCorrelation({
        requestId,
        conversationId: 'conv-a',
        sessionId: 'session-a',
        messageId: 'msg-read',
        tool: 'read',
        observedAt: now
      })
    ).toBe('stored');
    expect(
      observeRequestCorrelation({
        requestId,
        conversationId: 'conv-a',
        sessionId: 'session-a-later',
        messageId: 'msg-exec',
        tool: 'exec_command',
        observedAt: now + 1
      })
    ).toBe('same');
    expect(
      observeRequestCorrelation({
        requestId,
        conversationId: 'conv-a',
        sessionId: 'session-a-later',
        messageId: 'msg-session',
        tool: 'session',
        observedAt: now + 2
      })
    ).toBe('same');

    expect(requestCorrelation(requestId)?.conversationId).toBe('conv-a');
    expect(requestCorrelation(requestId)?.sessionId).toBe('session-a');
  });

  /**
   * The rule the whole registry exists to keep: a request id is bound to a chat once, and then
   * it is that chat's for good.
   *
   * A second conversation claiming a proven id is a page that is wrong about itself - a React
   * tree still mounted from the chat before it, a fresh chat whose client thread id has not
   * caught up. Believing it used to cost the id itself: the entry went permanently unresolved,
   * so every further call of a workflow that was still running waited fifteen seconds for
   * evidence that could no longer be accepted, and landed in Unattributed activity. Refusing
   * the claimant costs the claimant nothing that was ever really theirs.
   */
  it('keeps the first proven owner when a second conversation claims the same request id', () => {
    const requestId = 'wfr_cross_chat';
    const now = Date.now();
    observeRequestCorrelation({
      requestId,
      conversationId: 'conv-a',
      sessionId: 'session-a',
      messageId: 'msg-a',
      tool: 'read',
      observedAt: now
    });
    expect(
      observeRequestCorrelation({
        requestId,
        conversationId: 'conv-a',
        sessionId: 'session-a',
        messageId: 'msg-a-refresh',
        tool: 'read',
        observedAt: now + 1
      })
    ).toBe('same');
    expect(
      observeRequestCorrelation({
        requestId,
        conversationId: 'conv-b',
        sessionId: 'session-b',
        messageId: 'msg-b',
        tool: 'read',
        observedAt: now + 2
      })
    ).toBe('refused');
    expect(requestCorrelation(requestId)?.conversationId).toBe('conv-a');
    expect(requestCorrelation(requestId)?.sessionId).toBe('session-a');

    // And the owner is still an owner afterwards, not a survivor in a degraded state: its own
    // later sightings keep being accepted exactly as they were before anyone argued.
    expect(
      observeRequestCorrelation({
        requestId,
        conversationId: 'conv-a',
        sessionId: 'session-a',
        messageId: 'msg-a-later',
        tool: 'exec_command',
        observedAt: now + 3
      })
    ).toBe('same');
    expect(requestCorrelation(requestId)?.observedAt).toBe(now + 3);
  });

  it('does not age a proven request owner out just because the page evidence is old', () => {
    const requestId = 'wfr_long_running_workflow';
    observeRequestCorrelation({
      requestId,
      conversationId: 'conv-a',
      sessionId: 'session-a',
      messageId: 'msg-a',
      tool: 'exec_command',
      // Deliberately ancient. 1.8.1 forgot this after ten minutes and started filing later
      // calls from the same still-running workflow into Unattributed activity.
      observedAt: 1
    });

    expect(requestCorrelation(requestId)?.conversationId).toBe('conv-a');
  });

  /**
   * The bounded cache is a cache, not the verdict. 50k is the RAM ceiling and stays that; what
   * changed is that pushing an id out of it no longer means the request is unproved. A workflow
   * that proved its owner and then sat behind 50k later ids keeps that owner in this process and
   * across a restart, and first-proof-wins still refuses a second conversation claiming the id.
   */
  it('keeps the first exact owner for an id pushed out of the bounded cache, across a restart', async () => {
    const dir = await mkdtemp(path.join(tmpdir(), 'clf-correlation-evict-'));
    try {
      resetDurableForTests();
      initDurableStore(dir);
      const refreshedId = 'wfr_refreshed_old_request';
      const correlation = (requestId: string, observedAt: number) => ({
        requestId,
        conversationId: 'conv-a',
        sessionId: 'session-a',
        messageId: `msg-${requestId}`,
        tool: 'read',
        observedAt
      });

      // One batch past the whole cache, with the id that matters as its first entry.
      observeRequestCorrelations([
        correlation(refreshedId, 1),
        ...Array.from({ length: 60_000 }, (_, index) => correlation(`wfr_fill_${index}`, index + 2))
      ]);

      // Evicted from RAM, still owned: the exact lookup reads the row back instead of reporting
      // the request unproved, and the newest sighting survives the eviction.
      expect(requestCorrelation(refreshedId)?.conversationId).toBe('conv-a');
      expect(requestCorrelation(refreshedId)?.observedAt).toBe(1);
      expect(requestCorrelation('wfr_fill_0')?.conversationId).toBe('conv-a');
      expect(
        observeRequestCorrelation({
          ...correlation(refreshedId, 100_000),
          messageId: 'msg-refreshed'
        })
      ).toBe('same');

      // A fresh process with nothing restored reads the same durable owner, and the claim a
      // second conversation makes for that id is still refused rather than overwriting it.
      resetCorrelationRegistryForTests();
      expect(requestCorrelation(refreshedId)?.conversationId).toBe('conv-a');
      expect(
        observeRequestCorrelation({
          requestId: refreshedId,
          conversationId: 'conv-b',
          sessionId: 'session-b',
          messageId: 'msg-b',
          tool: 'read',
          observedAt: 200_000
        })
      ).toBe('refused');
      expect(requestCorrelation(refreshedId)?.conversationId).toBe('conv-a');
    } finally {
      resetCorrelationRegistryForTests();
      resetDurableForTests();
      await rm(dir, { recursive: true, force: true });
    }
  });

  it('restores proven request ownership from durable state after an app restart', async () => {
    const dir = await mkdtemp(path.join(tmpdir(), 'clf-correlation-'));
    try {
      resetDurableForTests();
      initDurableStore(dir);
      const requestId = 'wfr_survives_restart';
      observeRequestCorrelation({
        requestId,
        conversationId: 'conv-durable',
        sessionId: 'session-durable',
        messageId: 'msg-durable',
        tool: 'read',
        observedAt: 123
      });

      // No flush, no barrier: the observation committed its own transaction before returning.
      resetCorrelationRegistryForTests();
      expect(requestCorrelation(requestId)?.conversationId).toBe('conv-durable');

      await restoreRequestCorrelations();
      expect(requestCorrelation(requestId)?.conversationId).toBe('conv-durable');
      expect(requestCorrelation(requestId)?.sessionId).toBe('session-durable');
    } finally {
      resetCorrelationRegistryForTests();
      resetDurableForTests();
      await rm(dir, { recursive: true, force: true });
    }
  });

  /**
   * ChatGPT publishes `metadata.request_id` before the `api_tool` message that names the tool,
   * and the bridge stores that early sighting with an empty tool on purpose: the join never uses
   * the name, and waiting for it is what used to file the call under Unattributed activity. Two
   * such rows sat in the live 2026-09-01 registry. Both would have been thrown away on the next
   * launch by a validity check stricter than the registry's own answer, taking the proven owner
   * of a workflow whose calls could still be arriving.
   */
  it('restores an owner proved by a request id ChatGPT had not yet given a tool name', async () => {
    const dir = await mkdtemp(path.join(tmpdir(), 'clf-correlation-untooled-'));
    try {
      resetDurableForTests();
      initDurableStore(dir);
      const requestId = 'f0f00012-1111-4111-8111-111111111111';
      observeRequestCorrelation({
        requestId,
        conversationId: 'conv-bare-request-id',
        sessionId: '2026-01-01-00000028',
        messageId: 'f0f00013-1111-4111-8111-111111111111',
        tool: '',
        observedAt: 1_788_276_631_192
      });

      resetCorrelationRegistryForTests();
      await restoreRequestCorrelations();

      expect(requestCorrelation(requestId)?.conversationId).toBe('conv-bare-request-id');
      expect(requestCorrelation(requestId)?.sessionId).toBe('2026-01-01-00000028');
    } finally {
      resetCorrelationRegistryForTests();
      resetDurableForTests();
      await rm(dir, { recursive: true, force: true });
    }
  });

  it('migrates older proven owners and forgets the sticky conflicts those versions wrote', async () => {
    const dir = await mkdtemp(path.join(tmpdir(), 'clf-correlation-v3-conflict-'));
    try {
      resetDurableForTests();
      resetSessionStoreForTests();
      initDurableStore(dir);
      initSessionStore(dir);
      await writeDurableNow('request-correlations', {
        version: 3,
        entries: [
          {
            requestId: 'wfr_v3_proven_owner',
            value: {
              requestId: 'wfr_v3_proven_owner',
              conversationId: 'conv-v3-proven',
              sessionId: 'session-v3-proven',
              messageId: 'message-v3-proven',
              tool: 'read',
              observedAt: 100
            },
            conflicted: false
          },
          {
            requestId: 'wfr_v3_false_conflict',
            value: null,
            conflicted: true
          }
        ]
      });

      resetCorrelationRegistryForTests();
      await restoreRequestCorrelations();
      expect(requestCorrelation('wfr_v3_proven_owner')?.conversationId).toBe('conv-v3-proven');
      // Forgotten, not restored as a verdict: the id is simply unproved again, and the next page
      // that proves it owns it.
      expect(requestCorrelation('wfr_v3_false_conflict')).toBeNull();
      expect(
        observeRequestCorrelation({
          requestId: 'wfr_v3_false_conflict',
          conversationId: 'conv-after-migration',
          sessionId: 'session-after-migration',
          messageId: 'message-after-migration',
          tool: 'read',
          observedAt: 200
        })
      ).toBe('stored');
    } finally {
      resetCorrelationRegistryForTests();
      resetSessionStoreForTests();
      unsetSessionRootForTests();
      resetDurableForTests();
      await rm(dir, { recursive: true, force: true });
    }
  });

  it('rebuilds the first 1.8.2 owner index from already-attributed session history', async () => {
    const dir = await mkdtemp(path.join(tmpdir(), 'clf-correlation-migrate-'));
    try {
      resetDurableForTests();
      resetSessionStoreForTests();
      initDurableStore(dir);
      initSessionStore(dir);

      const session = await createSession({ title: 'old attributed history', conversationId: 'conv-history' });
      await appendEvent(session.id, {
        time: 200,
        source: 'mcp',
        kind: 'tool_call',
        call: {
          callId: 'call-history',
          tool: 'read',
          attribution: 'request_id',
          requestId: 'wfr_history',
          conversationId: 'conv-history',
          attributionMethod: 'request_id',
          args: { text: '{}', truncated: false, chars: 2 },
          result: { text: 'ok', truncated: false, chars: 2 },
          outcome: 'ok',
          durationMs: 1,
          summary: { kind: 'read', tone: 'neutral', title: 'Read history' }
        }
      });

      resetCorrelationRegistryForTests();
      await restoreRequestCorrelations();
      expect(requestCorrelation('wfr_history')?.conversationId).toBe('conv-history');
      expect(requestCorrelation('wfr_history')?.sessionId).toBe(session.id);

      // The rebuilt owners were committed to the ownership index as they were merged, so a
      // restart with no session store at all still resolves them from the durable rows.
      resetCorrelationRegistryForTests();
      resetSessionStoreForTests();
      unsetSessionRootForTests();
      await restoreRequestCorrelations();
      expect(requestCorrelation('wfr_history')?.conversationId).toBe('conv-history');
      expect(requestCorrelation('wfr_history')?.sessionId).toBe(session.id);
    } finally {
      resetCorrelationRegistryForTests();
      resetSessionStoreForTests();
      unsetSessionRootForTests();
      resetDurableForTests();
      await rm(dir, { recursive: true, force: true });
    }
  });

  it('reconciles a valid stale snapshot with newer durable attributed history', async () => {
    const dir = await mkdtemp(path.join(tmpdir(), 'clf-correlation-stale-'));
    try {
      resetDurableForTests();
      resetSessionStoreForTests();
      initDurableStore(dir);
      initSessionStore(dir);
      const conversationId = 'conv-stale-reconcile';
      const session = await createSession({ title: 'stale correlation snapshot', conversationId });
      const toolCall = (callId: string, requestId: string, time: number) => ({
        time,
        source: 'mcp' as const,
        kind: 'tool_call' as const,
        call: {
          callId,
          tool: 'read',
          attribution: 'request_id' as const,
          requestId,
          conversationId,
          attributionMethod: 'request_id' as const,
          args: { text: '{}', truncated: false, chars: 2 },
          result: { text: 'ok', truncated: false, chars: 2 },
          outcome: 'ok' as const,
          durationMs: 1,
          summary: { kind: 'read' as const, tone: 'neutral' as const, title: callId }
        }
      });

      // A legacy JSON snapshot written by an older build, holding only the first request. The
      // index itself is empty, so restore has to take the snapshot as migration input and then
      // reconcile the attributed history that is newer than it.
      await writeDurableNow('request-correlations', {
        version: 5,
        entries: [{
          requestId: 'wfr_old_snapshot',
          conversationId,
          sessionId: session.id,
          messageId: 'msg-old',
          tool: 'read',
          observedAt: 1
        }]
      });
      await appendEvent(session.id, toolCall('call-old', 'wfr_old_snapshot', 1));
      // The newer request exists only in session history: a crash between the page proving it and
      // this process committing it would leave exactly this shape.
      await appendEvent(session.id, toolCall('call-new', 'wfr_new_history', 2));

      resetCorrelationRegistryForTests();
      resetDurableForTests();
      initDurableStore(dir);

      await restoreRequestCorrelations();
      expect(requestCorrelation('wfr_old_snapshot')?.conversationId).toBe(conversationId);
      expect(requestCorrelation('wfr_new_history')?.conversationId).toBe(conversationId);
      expect(requestCorrelation('wfr_new_history')?.sessionId).toBe(session.id);

      // Both are now rows in the ownership index, not a JSON mirror: a restart with no history
      // store at all still resolves them.
      resetCorrelationRegistryForTests();
      resetSessionStoreForTests();
      unsetSessionRootForTests();
      expect(requestCorrelation('wfr_new_history')?.conversationId).toBe(conversationId);
    } finally {
      resetCorrelationRegistryForTests();
      resetSessionStoreForTests();
      unsetSessionRootForTests();
      resetDurableForTests();
      await rm(dir, { recursive: true, force: true });
    }
  });
});

describe('request proof durability', () => {
  beforeEach(() => resetCorrelationRegistryForTests());

  it('keeps a contradiction refused across a restart that happens right after the observation', async () => {
    const dir = await mkdtemp(path.join(tmpdir(), 'clf-proof-durable-'));
    const conversationId = 'conv-proof-durable';
    try {
      initDurableStore(dir);
      initSessionStore(dir);
      const session = await createSession({ title: 'proof', conversationId });
      // The first proof, then a contradiction: both are answers the page is told about.
      observeRequestCorrelation({
        requestId: 'wfr_proof', conversationId, sessionId: session.id,
        messageId: 'node-1', tool: 'read', observedAt: 1, questionId: 'question-H'
      });
      observeRequestCorrelation({
        requestId: 'wfr_proof', conversationId, sessionId: session.id,
        messageId: 'node-2', tool: 'read', observedAt: 1, questionId: 'question-Q'
      });
      expect(requestCorrelation('wfr_proof')?.questionConflict).toBe(true);

      // Deliberately no flush: the observation's own transaction is what committed it.
      resetCorrelationRegistryForTests();
      resetDurableForTests();
      initDurableStore(dir);

      await restoreRequestCorrelations();
      const restored = requestCorrelation('wfr_proof');
      // Ownership is unchanged, and the contradiction survived the crash.
      expect(restored?.conversationId).toBe(conversationId);
      expect(restored?.questionConflict).toBe(true);
    } finally {
      resetCorrelationRegistryForTests();
      resetSessionStoreForTests();
      unsetSessionRootForTests();
      resetDurableForTests();
      await rm(dir, { recursive: true, force: true });
    }
  });
});

describe('request proof acknowledgment', () => {
  beforeEach(() => resetCorrelationRegistryForTests());

  /**
   * A proof is only an answer once it is durable, so the observation commits it before it
   * returns and a storage fault must surface as a throw - the page then keeps re-sending the
   * evidence instead of being told a proof landed that never reached disk.
   *
   * The fault is real, not a mock: an external connection holds the write lock past this
   * process's busy timeout, which is exactly what a competing writer or a stalled disk looks
   * like. Nothing may be published as a side effect of the failed attempt - neither a proof
   * listener wake nor a partial row.
   */
  it('refuses a proof whose transaction cannot commit, and commits it on retry', async () => {
    const dir = await mkdtemp(path.join(tmpdir(), 'clf-proof-fail-'));
    const conversationId = 'conv-proof-fail';
    const indexFile = path.join(dir, 'state', 'request-correlations.sqlite');
    let blocker: DatabaseSync | null = null;
    try {
      initDurableStore(dir);
      initSessionStore(dir);
      const session = await createSession({ title: 'proof fail', conversationId });

      // Open the index with a throwaway connection first so the blocker locks the same file.
      observeRequestCorrelation({
        requestId: 'wfr_warm', conversationId, sessionId: session.id,
        messageId: 'node-warm', tool: 'read', observedAt: 1
      });
      blocker = new DatabaseSync(indexFile);
      blocker.exec('BEGIN IMMEDIATE');

      const proofs: RequestCorrelation[] = [];
      const unsubscribe = onRequestCorrelationProof((owner) => proofs.push(owner));
      try {
        expect(() =>
          observeRequestCorrelation({
            requestId: 'wfr_fail', conversationId, sessionId: session.id,
            messageId: 'node-1', tool: 'read', observedAt: 2, questionId: 'question-H'
          })
        ).toThrow();
        expect(proofs).toEqual([]);
        expect(requestCorrelation('wfr_fail')).toBeNull();
      } finally {
        unsubscribe();
      }

      // Release the competing writer: the same proof now commits, and its wake is delivered.
      blocker.exec('COMMIT');
      blocker.close();
      blocker = null;

      const heard: RequestCorrelation[] = [];
      const stop = onRequestCorrelationProof((owner) => heard.push(owner));
      try {
        expect(
          observeRequestCorrelation({
            requestId: 'wfr_fail', conversationId, sessionId: session.id,
            messageId: 'node-2', tool: 'read', observedAt: 3, questionId: 'question-H'
          })
        ).toBe('stored');
        expect(heard.map((owner) => owner.questionId)).toEqual(['question-H']);
      } finally {
        stop();
      }

      resetCorrelationRegistryForTests();
      resetDurableForTests();
      initDurableStore(dir);
      await restoreRequestCorrelations();
      expect(requestCorrelation('wfr_fail')?.questionId).toBe('question-H');
    } finally {
      blocker?.close();
      resetCorrelationRegistryForTests();
      resetSessionStoreForTests();
      unsetSessionRootForTests();
      resetDurableForTests();
      await rm(dir, { recursive: true, force: true });
    }
  });
});
