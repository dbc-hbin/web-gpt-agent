import { describe, expect, it } from 'vitest';
import {
  emptyEvidence,
  inFlightToolCalls,
  runningToolCalls,
  settlingToolCalls,
  trackInFlight,
  type CallContext
} from '../src/main/mcp/call-context.js';

function callFrom(conversationId: string | null): CallContext {
  return {
    startedAt: Date.now(),
    transportKey: null,
    agent: null,
    caller: { transportKey: null, requestId: null, conversationId },
    outcome: null,
    evidence: emptyEvidence()
  };
}

/** Runs `fn` while a call attributed to `conversationId` is in flight. */
async function whileRunning(context: CallContext, fn: () => void): Promise<void> {
  let release = (): void => {};
  const held = new Promise<void>((resolve) => {
    release = resolve;
  });
  const call = trackInFlight(context, async () => {
    await held;
  });
  fn();
  release();
  await call;
}

describe('local calls still running', () => {
  it('does not let one chat’s work hold another chat busy', async () => {
    // The compaction barrier waits for this to reach zero before it submits a settled brief.
    // A swarm runs every chat through this one process, so a global count meant a worker's
    // long build kept the prime's finished compaction waiting until the watch expired and
    // aborted it — blocked by work the prime has nothing to do with and cannot see.
    const worker = callFrom('conversation-b');
    await whileRunning(worker, () => {
      expect(inFlightToolCalls('conversation-a')).toBe(0);
      expect(inFlightToolCalls('conversation-b')).toBe(1);
      expect(runningToolCalls('conversation-b')).toBe(1);
      expect(settlingToolCalls('conversation-b')).toBe(0);
    });
    expect(inFlightToolCalls('conversation-b')).toBe(0);
  });

  it('still holds a chat busy for its own call', async () => {
    // The other half, and the reason the barrier exists: a handoff written while this chat's
    // own edit is mid-flight describes a machine that has changed by the time it is read.
    const own = callFrom('conversation-a');
    await whileRunning(own, () => {
      expect(inFlightToolCalls('conversation-a')).toBe(1);
    });
    expect(inFlightToolCalls('conversation-a')).toBe(0);
  });

  it('charges a call whose chat is not yet known to every chat', async () => {
    // Attribution is proven from page evidence and can still be pending. Until it lands the
    // call could belong to the chat that is asking, so it counts against all of them — the
    // same conservative answer the global count gave, kept for exactly the unproven case.
    const unknown = callFrom(null);
    await whileRunning(unknown, () => {
      expect(inFlightToolCalls('conversation-a')).toBe(1);
      expect(inFlightToolCalls('conversation-b')).toBe(1);
      expect(inFlightToolCalls(null)).toBe(1);
      expect(runningToolCalls('conversation-a')).toBe(1);
      expect(settlingToolCalls('conversation-a')).toBe(0);
    });
  });

  it('follows a call whose chat is identified part-way through it', async () => {
    // trackInFlight holds the context object, not a copy of the id it had at the start, so
    // the moment the caller is proven the count moves with it.
    const late = callFrom(null);
    await whileRunning(late, () => {
      expect(inFlightToolCalls('conversation-a')).toBe(1);
      late.caller.conversationId = 'conversation-b';
      expect(inFlightToolCalls('conversation-a')).toBe(0);
      expect(inFlightToolCalls('conversation-b')).toBe(1);
    });
  });
});
