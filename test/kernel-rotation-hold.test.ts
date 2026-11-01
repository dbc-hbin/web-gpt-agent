import { beforeEach, expect, it, vi } from 'vitest';
import { z } from 'zod';
// #1662: a fresh-turn continue is sent while the call it is due at is still being answered.
// The rotation decision is made while the call is recorded and may make its answer wait.
const recorded = vi.hoisted(() => ({ during: null as null | ((conversationId: string | null) => void) }));
vi.mock('../src/main/agents.js', async (original) => ({
  ...await original<typeof import('../src/main/agents.js')>(),
  agentForCaller: () => null, agentForFinishCaller: () => null,
  offerMessagesForCaller: () => null, acknowledgeOffersForCaller: () => null,
  offerMessages: () => [], acknowledgeOffers: () => null,
  currentRunId: () => null, currentRunForCaller: () => null,
  releaseQuiescentRun: () => undefined, noteAgentAlive: () => null
}));
vi.mock('../src/main/session/recorder.js', async (original) => ({
  ...await original<typeof import('../src/main/session/recorder.js')>(),
  freshCallOrigin: (_tool: string, _at: number, request: string | null) => request?.startsWith('req-') ? request.slice(4) : null,
  recordToolCall: async (input: { conversationId: string | null }) => { recorded.during?.(input.conversationId); return null; }
}));
vi.mock('../src/main/session/store.js', async (original) => ({
  ...await original<typeof import('../src/main/session/store.js')>(), conversationAttachment: async () => 'current'
}));
vi.mock('../src/main/session/input.js', () => ({ offerToolInput: async () => ({ messages: [], reminder: '' }), acknowledgeToolInput: async () => undefined, TOOL_INPUT_HEADER: '\n--- New instructions from the user ---\n' }));
import { createRegistrar, ok } from '../src/main/mcp/kernel.js';
import { withInboundRequestId } from '../src/main/mcp/inbound.js';
import { defaultConfig } from '../src/main/config.js';
import { callHoldOpen, holdCalls, resetCallHoldsForTests } from '../src/main/rotation-hold.js';

function handler() {
  let call!: (args: object) => Promise<{ content: Array<{ text?: string }> }>;
  const server = { registerTool: (_name: string, _schema: unknown, callback: typeof call) => { call = callback; } };
  const registrar = createRegistrar(server as never, { roots: [], caps: defaultConfig().capabilities, readOnly: true }, 'core');
  registrar.register('read', { description: 'fixture', inputSchema: z.object({}) }, async () => ok('result'));
  return (requestId: string | null) => withInboundRequestId(requestId, () => call({}));
}
beforeEach(() => { resetCallHoldsForTests(); recorded.during = null; });

it('keeps a call\'s answer back while the continue it is due for is being sent, then answers', async () => {
  const sending = Promise.withResolvers<void>();
  const reached = Promise.withResolvers<void>();
  const seen: Array<{ conversationId: string | null; open: boolean }> = [];
  recorded.during = conversationId => {
    seen.push({ conversationId, open: conversationId ? callHoldOpen(conversationId) : false });
    if (conversationId) holdCalls(conversationId, sending.promise);
    reached.resolve();
  };
  let answered = false;
  const result = handler()('req-chat-a').then(value => { answered = true; return value; });
  // The call is being recorded and its hold has the continue's send attached.
  await reached.promise;
  expect(seen).toEqual([{ conversationId: 'chat-a', open: true }]);
  // Let everything the answer could run before the hold settles: it still has not answered.
  await new Promise(resolve => setImmediate(resolve));
  expect(answered).toBe(false);
  sending.resolve();
  expect(JSON.stringify(await result)).toContain('result');
  expect(callHoldOpen('chat-a')).toBe(false);
});

it('opens no hold for a call whose chat is not known while it is answered', async () => {
  const seen: boolean[] = [];
  recorded.during = conversationId => { seen.push(conversationId !== null && callHoldOpen(conversationId)); };
  expect(JSON.stringify(await handler()(null))).toContain('result');
  expect(seen.every(open => !open)).toBe(true);
});
