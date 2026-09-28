import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { defaultConfig, initConfigPath, saveConfig } from '../src/main/config.js';
import { flushDurable, initDurableStore, readDurable, resetDurableForTests } from '../src/main/durable.js';
import { appendEvent, createSession, getSession, initSessionStore, readEvents, rebindSession, resetSessionStoreForTests } from '../src/main/session/store.js';
import type { SessionSummary } from '../src/shared/session.js';
import {
  acknowledgeBrowserInput, acknowledgeToolInput, authorizeBrowserInput, cancelInput, claimBrowserInput, configureInputDelivery,
  enqueueInput, listInputs, offerToolInput, resetInputForTests, type InputEntry
} from '../src/main/session/input.js';
import { recordDeliveredInput } from '../src/main/session/input-history.js';
import {
  cancelWorkInput, deliverWorkInput, findWorkGeneratedInputMessage, isWorkGeneratedInputMessage, onWorkInputChanged,
  readWorkInput, resetWorkInputForTests, setWorkInputBindingQuery, setWorkInputInstructionQuery,
  userVisibleInput, workInputAllowed, workInputOrigin, workInstructionAllowed
} from '../src/main/work/input-outbox.js';

/**
 * The transport is the one part of this contract that needs a live browser. Everything else —
 * admission, the persisted row, its claim, its receipt and the provenance query — is the real
 * outbox under an isolated temp store, so these tests exercise production wiring without ever
 * starting a browser, a connection or a tunnel.
 */
const transport = vi.hoisted(() => ({ sends: [] as Array<{ id: string; text: string; dueAt: number; generatedBy: unknown; sessionId: string | null }> }));
/** The controller binding the fence reads. Each test starts from an enabled binding for this work. */
const controller = vi.hoisted(() => ({ binding: null as null | { workIds: string[]; conversationId: string; providerAccountId: string | null; boundAt: number; enabled: boolean },
  primeSessionId: null as string | null, active: true }));
vi.mock('electron', () => ({
  app: { getPath: () => '', getVersion: () => '0.0.0' },
  safeStorage: {
    isAsyncEncryptionAvailable: async () => true,
    getSelectedStorageBackend: async () => 'gnome_libsecret',
    encryptStringAsync: async (value: string) => Buffer.from(value, 'utf8'),
    decryptStringAsync: async (buffer: Buffer) => ({ result: buffer.toString('utf8'), shouldReEncrypt: false })
  }
}));
vi.mock('../src/main/session/start-input.js', () => ({
  sendDesktopInput: async (input: { id: string; text: string; dueAt: number; sessionId: string | null }, options?: { generatedBy?: unknown; workInput?: unknown }) => {
    transport.sends.push({ id: input.id, text: input.text, dueAt: input.dueAt, generatedBy: options?.generatedBy ?? null, sessionId: input.sessionId });
    return await enqueueInput(input as never, undefined, options?.generatedBy as never, options?.workInput as never);
  },
  retryQueuedInputBrowser: async () => null,
  cancelDesktopInput: async () => false,
  stopInputStartup: () => {},
  resetInputStartupForTests: () => {}
}));

let directory: string;
let session: SessionSummary;
const conversationId = 'conversation-controller';
const account = 'account-1';
const workId = '11111111-2222-4333-8444-555555555555';

const report = (over: Partial<Parameters<typeof deliverWorkInput>[0]> = {}) => ({
  id: randomUUID(), sessionId: session.id, text: 'Worker finished: parser rewritten, tests green.',
  model: 'gpt-6-astra', reasoning: 'high', dueAt: 1_700_000_000_000, kind: 'controller-report' as const, workId,
  conversationId, providerAccountId: account, boundAt: 5, ...over
});

beforeEach(async () => {
  directory = await fs.mkdtemp(path.join(os.tmpdir(), 'clf-work-outbox-'));
  initConfigPath(directory); initDurableStore(directory); initSessionStore(directory);
  resetInputForTests(); resetWorkInputForTests();
  transport.sends = [];
  controller.binding = { workIds: [workId], conversationId, providerAccountId: account, boundAt: 5, enabled: true };
  setWorkInputBindingQuery(() => controller.binding);
  setWorkInputInstructionQuery(() => controller.primeSessionId ? { primeSessionId: controller.primeSessionId, active: controller.active } : null);
  await saveConfig({ ...defaultConfig(), ui: { ...defaultConfig().ui, finishTool: true } });
  configureInputDelivery({ applyAutomation: async () => {}, changed: () => {}, recordDelivered: (entry, anchor) => recordDeliveredInput(entry, anchor),
    // The production wiring (ipc.ts) registers exactly these two; Goal and the Send fence read them.
    generatedAllowed: workInputAllowed,
    instructionAllowed: workInstructionAllowed,
    messageOrigin: async ({ sessionId, messageId, text }) => workInputOrigin(sessionId, messageId, text) });
  session = await createSession({ title: 'Controller', origin: { kind: 'desktop', fromSessionId: null, agentId: null, task: '' } });
  await rebindSession(session.id, null, conversationId);
  session = (await getSession(session.id))!;
  controller.primeSessionId = session.id; controller.active = true;
});

/** The controller conversation finishes a turn, which is the boundary a report waits for. */
async function settle(turnId = `settled-${Math.random().toString(36).slice(2, 8)}`): Promise<void> {
  await appendEvent(session.id, { kind: 'turn_end', time: Date.now(), turnId, outcome: 'completed', source: 'extension' });
}
afterEach(async () => {
  vi.restoreAllMocks();
  resetInputForTests(); resetWorkInputForTests(); resetSessionStoreForTests(); resetDurableForTests();
  await flushDurable();
  await fs.rm(directory, { recursive: true, force: true });
});

it('admits one durable after-turn row from the command id and stays queued until a native ACK', async () => {
  const result = await deliverWorkInput(report());
  expect(result).toEqual({ state: 'queued' });
  const rows = await listInputs();
  expect(rows).toHaveLength(1);
  expect(rows[0]).toMatchObject({ id: transport.sends[0]!.id, state: 'queued', dueAt: 1_700_000_000_000,
    generatedBy: { kind: 'work-report', workId, conversationId, providerAccountId: account, boundAt: 5 } });
  // A generated result must never be promoted onto the executor's finish-tool route.
  expect(rows[0]!.mode).toBe('after-turn');
  expect(await readWorkInput(rows[0]!.id)).toEqual({ state: 'queued' });

  // The browser's own Send fence reads this exact projection: the claim must hand the page the
  // authority it was admitted under, including a non-null account, so the page can compare it with
  // the live authenticated account and conversation before authorizing Send.
  await settle();
  const claimed = await claimBrowserInput(rows[0]!.id, 'controller-page', conversationId, true);
  expect(claimed).toMatchObject({ generatedBy: { kind: 'work-report', workId, conversationId, providerAccountId: account, boundAt: 5 } });
});

it('recovers the prior row and its persisted dueAt when a retry replays the same command after a crash', async () => {
  const request = report();
  await deliverWorkInput(request);
  const [accepted] = await listInputs();
  // Crash between the ledger write and the browser hand-off: nothing in memory survives.
  resetInputForTests();
  expect(await readDurable<InputEntry[]>('session-input')).toHaveLength(1);

  const retried = await deliverWorkInput({ ...request, dueAt: 1_900_000_000_000 });
  expect(retried).toEqual({ state: 'queued' });
  const rows = await listInputs();
  expect(rows).toHaveLength(1);
  expect(rows[0]!.dueAt).toBe(accepted!.dueAt);
  expect(rows[0]!.createdAt).toBe(accepted!.createdAt);
  expect(transport.sends).toHaveLength(1);
});

it('refuses a retry whose message changed and leaves the existing row untouched', async () => {
  const request = report();
  await deliverWorkInput(request);
  expect(await deliverWorkInput({ ...request, text: 'Different instruction entirely' }))
    .toEqual({ state: 'failed', error: 'Message id already belongs to different work input' });
  const other = await createSession({ title: 'Other controller', origin: { kind: 'desktop', fromSessionId: null, agentId: null, task: '' } });
  expect(await deliverWorkInput({ ...request, sessionId: other.id }))
    .toEqual({ state: 'failed', error: 'Message id already belongs to different work input' });
  expect(await deliverWorkInput({ ...request, model: 'gpt-5.6-sol' }))
    .toEqual({ state: 'failed', error: 'Message id already belongs to different work input' });
  const rows = await listInputs();
  expect(rows).toHaveLength(1);
  expect(rows[0]).toMatchObject({ text: request.text, model: 'gpt-6-astra', sessionId: session.id });
});

it('reports unknown after Send authorization and never replays a possibly submitted claim', async () => {
  const request = report();
  await deliverWorkInput(request);
  await settle();
  const claimed = await claimBrowserInput(request.id, 'controller-page', conversationId, true);
  expect(claimed).not.toBeNull();
  expect(await authorizeBrowserInput(request.id, 'controller-page', conversationId)).toBe(true);

  expect(await deliverWorkInput({ ...request, dueAt: Date.now() })).toEqual({ state: 'unknown' });
  expect(transport.sends).toHaveLength(1);
  const [row] = await listInputs();
  expect(row).toMatchObject({ state: 'browser', owner: 'controller-page', sendAuthorizedAt: expect.any(Number) });

  // The native receipt resolves the ambiguity exactly once.
  expect(await acknowledgeBrowserInput(request.id, 'controller-page', conversationId, 'native-report-1')).toBe(true);
  expect(await readWorkInput(request.id)).toEqual({ state: 'delivered' });
  expect(await deliverWorkInput(request)).toEqual({ state: 'delivered' });
  expect(transport.sends).toHaveLength(1);
});

it('cancels only a provably unsent work message', async () => {
  const queued = report();
  await deliverWorkInput(queued);
  expect(await cancelWorkInput(queued.id)).toBe(true);
  expect(await readWorkInput(queued.id)).toEqual({ state: 'cancelled', error: undefined });
  expect(transport.sends).toHaveLength(1);

  // A claim behind the final Send fence is still ours to withdraw...
  const fenced = report();
  await deliverWorkInput(fenced);
  await settle();
  await claimBrowserInput(fenced.id, 'controller-page', conversationId, true);
  expect(await cancelWorkInput(fenced.id)).toBe(true);
  expect(await readWorkInput(fenced.id)).toEqual({ state: 'cancelled', error: 'Not sent: this delivery was cancelled before Send was authorized.' });

  // ...but once Send authority is granted the outcome is unknown, not cancelled.
  const authorized = report();
  await deliverWorkInput(authorized);
  await settle();
  await claimBrowserInput(authorized.id, 'controller-page', conversationId, true);
  await authorizeBrowserInput(authorized.id, 'controller-page', conversationId);
  expect(await cancelWorkInput(authorized.id)).toBe(false);
  expect(await readWorkInput(authorized.id)).toEqual({ state: 'unknown' });
});

it('keeps a generated report out of the executor tool handout and out of the user-visible outbox', async () => {
  const request = report();
  await deliverWorkInput(request);
  const [claimedRow] = await listInputs();
  expect(userVisibleInput(claimedRow!)).toBe(false);
  expect((await listInputs()).filter(userVisibleInput)).toEqual([]);
  // Even with a finish boundary open, an after-turn report is never handed to the executor.
  expect(await offerToolInput(session.id, conversationId, randomUUID(), Date.now(), true)).toEqual({ messages: [], reminder: '' });
  expect((await listInputs()).find(entry => entry.id === request.id)).toMatchObject({ state: 'queued', mode: 'after-turn' });
});

it('classifies a report from durable provenance and never suppresses equal text alone', async () => {
  const request = report();
  await deliverWorkInput(request);
  // Before any hand-out the bytes are still ours to cancel, so equal text is not evidence that
  // this app produced it: a human message may legitimately read exactly the same.
  expect(await workInputOrigin(session.id, null, request.text)).toBe('human');
  expect(await isWorkGeneratedInputMessage(session.id, null, request.text)).toBe(false);
  expect(await findWorkGeneratedInputMessage(session.id, null, request.text)).toBeNull();

  // Pre-ACK, the claim may already have submitted these exact bytes: ambiguous, not human.
  await settle();
  await claimBrowserInput(request.id, 'controller-page', conversationId, true);
  await authorizeBrowserInput(request.id, 'controller-page', conversationId);
  expect(await workInputOrigin(session.id, null, request.text)).toBe('unknown');
  expect(await isWorkGeneratedInputMessage(session.id, null, request.text)).toBe(false);
  expect(await findWorkGeneratedInputMessage(session.id, null, request.text)).toMatchObject({ inputId: request.id, workId, matchedBy: 'pending-echo' });

  expect(await acknowledgeBrowserInput(request.id, 'controller-page', conversationId, 'native-report-1')).toBe(true);
  expect(await isWorkGeneratedInputMessage(session.id, 'native-report-1')).toBe(true);
  expect(await findWorkGeneratedInputMessage(session.id, 'native-report-1')).toEqual({ inputId: request.id, workId, matchedBy: 'message-id' });
  // Provenance is canonical history now, so it survives the outbox row aging out.
  const recorded = await readEvents(session.id, { kinds: ['user_message'] });
  expect(recorded.some(event => event.kind === 'user_message' && event.generated === true && event.messageId === 'native-report-1')).toBe(true);
  expect(await workInputOrigin(session.id, 'native-report-1')).toBe('generated');
  expect(await workInputOrigin(session.id, 'native-report-1', request.text)).toBe('generated');
  // Once the report owns a native id, text alone is no longer authority: only that id (or the
  // canonical recording that carries the outbox identity) can attribute a message to the report.
  expect(await workInputOrigin(session.id, null, request.text)).toBe('human');
  expect(await workInputOrigin(session.id, 'different-native-id', request.text)).toBe('human');

  // Text alone is still not authority: an unrelated human message in another session is human,
  // and an exact byte match no longer names an unresolved row of ours.
  const other = await createSession({ title: 'Other', origin: { kind: 'desktop', fromSessionId: null, agentId: null, task: '' } });
  expect(await workInputOrigin(other.id, null, request.text)).toBe('human');
  expect(await workInputOrigin(session.id, 'someone-elses-message', request.text)).toBe('human');
  expect(await workInputOrigin(session.id, 'unrelated-message', 'Something the user typed themselves')).toBe('human');
});

it('notifies the runtime when a work message reaches a new verdict without any timer', async () => {
  const seen: string[][] = [];
  const unsubscribe = onWorkInputChanged(ids => seen.push([...ids]));
  const request = report();
  await deliverWorkInput(request);
  await settle();
  await claimBrowserInput(request.id, 'controller-page', conversationId, true);
  await authorizeBrowserInput(request.id, 'controller-page', conversationId);
  await vi.waitFor(() => expect(seen.flat()).toContain(request.id));
  const before = seen.length;
  expect(await acknowledgeBrowserInput(request.id, 'controller-page', conversationId, 'native-report-1')).toBe(true);
  await vi.waitFor(() => expect(seen.length).toBeGreaterThan(before));
  expect(await readWorkInput(request.id)).toEqual({ state: 'delivered' });
  unsubscribe();
  expect(seen.flat()).toContain(request.id);
});

it('reports a stopped or deleted work message factually instead of claiming delivery', async () => {
  const request = report();
  await deliverWorkInput(request);
  expect(await cancelInput(request.id)).toBe(true);
  expect(await readWorkInput(request.id)).toEqual({ state: 'cancelled', error: undefined });
  expect(await deliverWorkInput(request)).toEqual({ state: 'cancelled', error: undefined });
  expect(await readWorkInput(randomUUID())).toBeNull();
  expect(await deliverWorkInput({ ...report(), text: '' })).toEqual({ state: 'failed', error: expect.stringContaining('Invalid work input') });
});

it('refuses a report that cannot state the authority it was produced under', async () => {
  // Nothing is defaulted from today's binding: a report with missing originals never sends, and
  // the failure names exactly what is missing rather than routing by current state.
  for (const field of ['workId', 'conversationId', 'providerAccountId', 'boundAt'] as const) {
    expect(await deliverWorkInput({ ...report(), [field]: null }))
      .toEqual({ state: 'failed', error: `A controller report needs its original ${field}` });
  }
  expect(await deliverWorkInput({ ...report(), sessionId: null }))
    .toEqual({ state: 'failed', error: 'A controller report needs its original sessionId' });
  expect(await listInputs()).toEqual([]);
  expect(transport.sends).toEqual([]);
});

it('defers a pre-ACK report echo in Goal context instead of reading it as a human request', async () => {
  const goal = await import('../src/main/goal.js');
  const request = report({ text: 'Work 1 finished: the parser rewrite is complete.' });
  await deliverWorkInput(request);
  await settle();
  await claimBrowserInput(request.id, 'controller-page', conversationId, true);
  await authorizeBrowserInput(request.id, 'controller-page', conversationId);
  // The page recorded the message before any receipt linked it back to this outbox row.
  await appendEvent(session.id, { time: Date.now(), source: 'extension', kind: 'user_message', messageId: 'echo-1',
    message: { text: request.text, chars: request.text.length, truncated: false } });

  expect(await workInputOrigin(session.id, 'echo-1', request.text)).toBe('unknown');
  const messages = await goal.conversationMessages(session.id);
  expect(messages).toEqual([{ role: 'user', origin: 'automatic', content: expect.stringContaining(request.text) }]);
  // Goal therefore refuses to continue a task whose only recorded "request" is this app's own
  // automatically generated result.
  goal.resetGoalStateForTests();
  await expect(goal.draftFastFollowup(session.id, undefined, undefined, undefined, 'goal'))
    .rejects.toThrow('No recorded user request is available for Goal');

  // The receipt resolves it: the same message is now proven generated rather than merely unresolved.
  expect(await acknowledgeBrowserInput(request.id, 'controller-page', conversationId, 'echo-1')).toBe(true);
  expect(await workInputOrigin(session.id, 'echo-1', request.text)).toBe('generated');
});

it('withdraws a queued report when its controller binding is off, re-bound, or another work', async () => {
  const request = report({ boundAt: 5 });
  await deliverWorkInput(request);
  await settle();
  const claim = async (): Promise<boolean> => (await claimBrowserInput(request.id, 'controller-page', conversationId, true)) !== null;
  expect(await claim()).toBe(true);
  // Losing the document before Send returns the row to the queue with its claim released.
  const { failBrowserInput } = await import('../src/main/session/input.js');
  expect(await failBrowserInput(request.id, 'controller-page', 'After-turn pickup was withdrawn before Send.')).toBe(true);
  expect((await listInputs()).find(row => row.id === request.id)?.state).toBe('queued');

  // The controller is turned off: the queued report can no longer reach its chat.
  controller.binding = { ...controller.binding!, enabled: false };
  expect(await claim()).toBe(false);
  // A different work on the same controller is not this report's owner either...
  controller.binding = { ...controller.binding!, enabled: true, workIds: ['99999999-8888-4777-8666-555555555555'] };
  expect(await claim()).toBe(false);
  // ...but a normal continuation moves the controller to a successor in the same chat, and the
  // predecessor's completion report still belongs to that same controller.
  controller.binding = { ...controller.binding!, workIds: [workId, '99999999-8888-4777-8666-555555555555'] };
  expect(await claim()).toBe(true);
  expect(await failBrowserInput(request.id, 'controller-page', 'After-turn pickup was withdrawn before Send.')).toBe(true);
  // Re-enabling grants a new binding epoch; the old queued report is not revived by it.
  controller.binding = { ...controller.binding!, boundAt: 6 };
  expect(await claim()).toBe(false);
});

it('notifies after a restart when reconciliation is the only thing that named the row', async () => {
  const request = report();
  await deliverWorkInput(request);
  await settle();
  await claimBrowserInput(request.id, 'controller-page', conversationId, true);
  await authorizeBrowserInput(request.id, 'controller-page', conversationId);
  // Restart: nothing in memory survives, and the runtime reconciles from the durable row alone.
  resetInputForTests(); resetWorkInputForTests();
  const seen: string[][] = [];
  onWorkInputChanged(ids => seen.push([...ids]));
  expect(await readWorkInput(request.id)).toEqual({ state: 'unknown' });
  expect(await acknowledgeBrowserInput(request.id, 'controller-page', conversationId, 'native-report-1')).toBe(true);
  await vi.waitFor(() => expect(seen.flat()).toContain(request.id));
  expect(await readWorkInput(request.id)).toEqual({ state: 'delivered' });
});

it('refuses a report retry that changes its work, destination or account', async () => {
  const request = report();
  await deliverWorkInput(request);
  const conflict = { state: 'failed', error: 'Message id already belongs to different work input' };
  expect(await deliverWorkInput({ ...request, workId: '99999999-8888-4777-8666-555555555555' })).toEqual(conflict);
  expect(await deliverWorkInput({ ...request, text: 'A different result' })).toEqual(conflict);
  expect((await listInputs()).find(row => row.id === request.id)).toMatchObject({
    text: request.text, generatedBy: { workId, conversationId, providerAccountId: account, boundAt: 5 }
  });
});

it('refuses to send a report whose pinned conversation or account no longer matches', async () => {
  const request = report();
  await deliverWorkInput(request);
  await settle();
  const claim = async (): Promise<boolean> => (await claimBrowserInput(request.id, 'controller-page', conversationId, true)) !== null;
  expect(await claim()).toBe(true);
  const { failBrowserInput } = await import('../src/main/session/input.js');
  expect(await failBrowserInput(request.id, 'controller-page', 'After-turn pickup was withdrawn before Send.')).toBe(true);

  // The same conversation under another provider account is a different chat, and an account the
  // binding has not proven yet is not a wildcard: both defer rather than sending.
  controller.binding = { ...controller.binding!, providerAccountId: 'account-2' };
  expect(await claim()).toBe(false);
  controller.binding = { ...controller.binding!, providerAccountId: null };
  expect(await claim()).toBe(false);
  controller.binding = { ...controller.binding!, providerAccountId: account };

  // A session rebound to another conversation cannot reroute the queued result either: there is
  // no destination for it, and the outbox retires it visibly rather than sending it into the
  // wrong chat.
  await rebindSession(session.id, conversationId, 'conversation-moved');
  expect(await claim()).toBe(false);
  const retired = (await listInputs()).find(row => row.id === request.id)!;
  expect(retired).toMatchObject({ state: 'cancelled', error: 'This generated result was not delivered because its conversation changed.' });
  expect(await readWorkInput(request.id)).toEqual({ state: 'cancelled', error: retired.error });
});

it('keeps a report identified after hundreds of later messages and outbox retirement', async () => {
  const request = report();
  await deliverWorkInput(request);
  await settle();
  await claimBrowserInput(request.id, 'controller-page', conversationId, true);
  await authorizeBrowserInput(request.id, 'controller-page', conversationId);
  await acknowledgeBrowserInput(request.id, 'controller-page', conversationId, 'native-report-1');
  expect(await isWorkGeneratedInputMessage(session.id, 'native-report-1')).toBe(true);

  // Hundreds of later messages, and the receipt itself has aged out of the retained outbox
  // history: only the canonical provenance and the exact id remain, so a bounded tail window
  // would have lost this answer.
  for (let index = 0; index < 80; index++) {
    await appendEvent(session.id, { time: Date.now(), source: 'extension', kind: 'user_message', messageId: `later-${index}`,
      message: { text: `later message ${index}`, chars: 16, truncated: false } });
  }
  const { writeDurableNow } = await import('../src/main/durable.js');
  await writeDurableNow('session-input', []);
  resetInputForTests(); resetWorkInputForTests();
  expect(await listInputs()).toEqual([]);
  expect(await isWorkGeneratedInputMessage(session.id, 'native-report-1')).toBe(true);
  expect(await workInputOrigin(session.id, 'native-report-1')).toBe('generated');
  expect(await findWorkGeneratedInputMessage(session.id, 'native-report-1')).toEqual({ inputId: request.id, workId: null, matchedBy: 'message-id' });
});

it('moves a provably-unsent instruction to the prime that now owns it, without sending it to the old one', async () => {
  const request = { id: randomUUID(), sessionId: session.id, text: 'Instruct the prime to keep going.',
    model: 'gpt-6-astra', reasoning: 'high', dueAt: 1_700_000_000_000, kind: 'instruction' as const, workId };
  await deliverWorkInput(request);
  expect(transport.sends).toHaveLength(1);

  // Compact & Resume moved the prime to a different session while this command was unacknowledged.
  const moved = await createSession({ title: 'Moved prime', origin: { kind: 'desktop', fromSessionId: session.id, agentId: null, task: '' } });
  await rebindSession(moved.id, null, 'conversation-moved');
  controller.primeSessionId = moved.id;
  expect(await deliverWorkInput({ ...request, sessionId: moved.id })).toEqual({ state: 'queued' });

  // One row, moved: it now belongs to the new prime, and the old claim left nothing behind that
  // could still send it into the retired conversation.
  const rows = await listInputs();
  expect(rows).toHaveLength(1);
  expect(rows[0]).toMatchObject({ id: request.id, sessionId: moved.id, conversationId: 'conversation-moved',
    owner: null, offeredAt: undefined, sendAuthorizedAt: undefined, state: 'queued' });
  expect(transport.sends).toHaveLength(1);

  // The old conversation can no longer claim it, and the new prime can.
  expect(await claimBrowserInput(request.id, 'old-page', conversationId, true)).toBeNull();
  await appendEvent(moved.id, { kind: 'turn_end', time: Date.now(), turnId: 'moved-turn', outcome: 'completed', source: 'extension' });
  expect(await claimBrowserInput(request.id, 'new-page', 'conversation-moved', true)).not.toBeNull();

  // Content is still the identity: a different instruction under the same id is refused.
  resetInputForTests();
  expect(await deliverWorkInput({ ...request, sessionId: moved.id, text: 'Something else entirely' }))
    .toEqual({ state: 'failed', error: 'Message id already belongs to different work input' });
});

it('withdraws a queued managed instruction when its own work is stopped or its prime moved', async () => {
  const request = { id: randomUUID(), sessionId: session.id, text: 'Instruct the prime to keep going.',
    model: 'gpt-6-astra', reasoning: 'high', dueAt: 1_700_000_000_000, kind: 'instruction' as const, workId };
  await deliverWorkInput(request);
  expect((await listInputs())[0]).toMatchObject({ workInput: { workId } });
  await settle();
  const claim = async (): Promise<boolean> => (await claimBrowserInput(request.id, 'prime-page', conversationId, true)) !== null;
  expect(await claim()).toBe(true);
  const { failBrowserInput } = await import('../src/main/session/input.js');
  expect(await failBrowserInput(request.id, 'prime-page', 'After-turn pickup was withdrawn before Send.')).toBe(true);

  // Pause/cancel after admission withdraws the queued instruction at the final Send fence.
  controller.active = false;
  expect(await claim()).toBe(false);
  // A paused work keeps its instruction: ordinary startup/preparation expiry must not consume a
  // message the user never withdrew, because resume retries the same command. The contrast below
  // shows the ordinary deadline is still exactly what it was for everything else.
  const later = Date.now() + 30 * 60_000;
  vi.spyOn(Date, 'now').mockReturnValue(later);
  const ordinary: InputEntry = { id: randomUUID(), sessionId: session.id, text: 'An ordinary queued message',
    mode: 'auto', dueAt: 1_700_000_000_000, model: null, reasoningEffort: null, transportIntent: 'browser',
    state: 'queued', owner: null, createdAt: Date.now() - 120_000, conversationId };
  const { writeDurableNow } = await import('../src/main/durable.js');
  await writeDurableNow('session-input', [...await listInputs(), ordinary]);
  resetInputForTests();
  const rows = await listInputs();
  expect(rows.find(row => row.id === request.id)).toMatchObject({ state: 'queued', workInput: { workId } });
  expect(rows.find(row => row.id === ordinary.id)).toMatchObject({ state: 'failed' });
  expect(await deliverWorkInput({ ...request, dueAt: later })).toEqual({ state: 'queued' });
  vi.mocked(Date.now).mockRestore();
  // A row still addressed to a retired prime session is refused rather than sent there.
  controller.active = true; controller.primeSessionId = 'session-elsewhere';
  expect(await claim()).toBe(false);
  controller.active = true; controller.primeSessionId = session.id;
  expect(await claim()).toBe(true);
  expect(await failBrowserInput(request.id, 'prime-page', 'After-turn pickup was withdrawn before Send.')).toBe(true);

  // The tool transport is the other half: a queued managed instruction must not be handed to the
  // executor's response while its work is stopped, and the row survives for the resume.
  const mcp = { kind: 'turn_end' as const, time: Date.now(), turnId: 'prime-turn', outcome: 'completed' as const, source: 'extension' as const };
  await appendEvent(session.id, { ...mcp, kind: 'turn_start' });
  await appendEvent(session.id, mcp);
  expect((await offerToolInput(session.id, conversationId, randomUUID(), Date.now(), true)).messages)
    .toEqual([{ text: expect.stringContaining(request.text), images: [] }]);
  expect((await listInputs()).find(row => row.id === request.id)?.state).toBe('tool');
  await acknowledgeToolInput(session.id, conversationId, randomUUID(), Date.now() + 1);
  resetInputForTests();

  const second = { ...request, id: randomUUID() };
  await deliverWorkInput(second);
  controller.active = false;
  expect((await offerToolInput(session.id, conversationId, randomUUID(), Date.now(), true)).messages).toEqual([]);
  expect((await listInputs()).find(row => row.id === second.id)).toMatchObject({ state: 'queued', workInput: { workId } });
  controller.active = true;
  expect((await offerToolInput(session.id, conversationId, randomUUID(), Date.now(), true)).messages)
    .toEqual([{ text: expect.stringContaining(second.text), images: [] }]);
});

it('never lets an automatically generated report become the human requirement Goal continues', async () => {
  const goal = await import('../src/main/goal.js');
  const request = report({ text: 'Work 1 finished: the parser rewrite is complete and its tests pass.' });
  await deliverWorkInput(request);
  await settle();
  await claimBrowserInput(request.id, 'controller-page', conversationId, true);
  await authorizeBrowserInput(request.id, 'controller-page', conversationId);
  await acknowledgeBrowserInput(request.id, 'controller-page', conversationId, 'native-report-1');
  goal.resetGoalStateForTests();
  await saveConfig({ ...defaultConfig(), goal: { ...defaultConfig().goal, enabled: true, backend: 'templates', loopBackend: 'chatgpt' } });

  // The recorded row exists, but Goal must see it as an automatically produced result rather than
  // as the request it is supposed to continue.
  const messages = await goal.conversationMessages(session.id);
  expect(messages).toEqual([{ role: 'user', origin: 'automatic', content: expect.stringContaining(request.text) }]);
  await expect(goal.draftFastFollowup(session.id, undefined, undefined, undefined, 'goal'))
    .rejects.toThrow('No recorded user request is available for Goal');

  // With the user's own request recorded, Goal proceeds again.
  await appendEvent(session.id, { time: Date.now(), source: 'extension', kind: 'user_message', messageId: 'human-question',
    message: { text: 'Rewrite the parser', chars: 19, truncated: false } });
  await appendEvent(session.id, { time: Date.now(), source: 'extension', kind: 'assistant_message', messageId: 'human-answer', final: true,
    message: { text: 'Parser rewritten.\n[[COS_GOAL:CONTINUE]]', chars: 33, truncated: false } });
  const withRequest = await goal.conversationMessages(session.id);
  expect(withRequest.filter(message => message.role === 'user').map(message => message.origin)).toEqual(['automatic', undefined]);
  await expect(goal.draftFastFollowup(session.id, undefined, undefined, undefined, 'goal')).resolves.toBeTypeOf('string');
});
