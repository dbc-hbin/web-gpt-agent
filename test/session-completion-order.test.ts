import { promises as fs } from 'node:fs';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { defaultConfig, initConfigPath, saveConfig } from '../src/main/config.js';
import { recordChatObservations, recordToolCall, resetRecorderForTests } from '../src/main/session/recorder.js';
import { appendEvent, flushSessions, getSession, initSessionStore, readActivityEvents, readCompletedFinal,
  readEvents, readRecentEvents, resetSessionStoreForTests, sessionsRoot } from '../src/main/session/store.js';
import { getLog } from '../src/main/logger.js';
import { makeTempDir, removeTempDir } from './helpers.js';

let dir: string;
beforeEach(async () => {
  dir = await makeTempDir('clf-completion-order-');
  initConfigPath(dir);
  initSessionStore(dir);
  resetRecorderForTests();
  await saveConfig(defaultConfig());
});
afterEach(async () => {
  await flushSessions();
  resetRecorderForTests();
  resetSessionStoreForTests();
  vi.restoreAllMocks();
  await removeTempDir(dir);
});

const chat = 'completed-order-chat';
const turn = 'completed-order-turn';
const requestId = 'wfr_completed_order';
const call = (startedAt: number, request = requestId) => recordToolCall({
  conversationId: chat, requestId: request, tool: 'read', args: { paths: ['/project/example.ts'] },
  content: [{ type: 'text', text: 'ok' }], outcome: 'ok', durationMs: 1, startedAt
});

async function completed(native = true) {
  const began = Date.now();
  const clock = vi.spyOn(Date, 'now').mockReturnValue(began);
  const opened = await recordChatObservations(chat, [
    { kind: 'user_message', time: began, messageId: 'question', text: 'Inspect the source.' },
    { kind: 'turn_start', time: began + 1, turnId: turn }
  ]);
  clock.mockReturnValue(began + 10);
  await call(Date.now());
  clock.mockReturnValue(began + 20);
  await recordChatObservations(chat, [
    { kind: 'assistant_message', time: Date.now(), turnId: turn, messageId: 'answer',
      ...(native ? { providerMessageId: '11111111-2222-4333-8444-555555555555' } : {}), text: 'The source is checked.',
      final: true, state: 'final', activeNow: true },
    { kind: 'turn_end', time: Date.now(), turnId: turn, outcome: 'completed' }
  ]);
  return { id: opened.sessionId!, began, clock };
}

describe('completed request ownership', () => {
  it.each([false, true])('retains the final and call order after trailing work (restart %s)', async restart => {
    const { id, began, clock } = await completed();
    if (restart) {
      await flushSessions(); resetRecorderForTests(); resetSessionStoreForTests();
    }
    clock.mockReturnValue(began + 30);
    await call(Date.now());
    const events = await readEvents(id);
    const calls = events.filter(event => event.kind === 'tool_call');
    expect(calls).toHaveLength(2);
    expect(calls[1]).toMatchObject({ turnId: turn, time: began + 30 });
    expect(events.indexOf(calls[1]!)).toBeLessThan(events.findIndex(event => event.kind === 'assistant_message'));
    expect(await readCompletedFinal(id, chat)).toMatchObject({ messageId: 'answer', completedAt: began + 20 });
    expect((await getSession(id))?.activeTurnId).toBeNull();
  });

  it('projects legacy unowned calls from exact earlier request proof without rewriting events', async () => {
    const { id, began, clock } = await completed();
    const first = (await readEvents(id, { kinds: ['tool_call'] }))[0]!;
    if (first.kind !== 'tool_call') throw new Error('Expected recorded tool');
    clock.mockReturnValue(began + 30);
    const late = await appendEvent(id, { kind: 'tool_call', source: 'mcp', time: Date.now(),
      call: { ...first.call, callId: 'legacy-trailing-call' } });
    await flushSessions();
    const journalPath = path.join(sessionsRoot()!, id, 'events.jsonl');
    const original = await fs.readFile(journalPath, 'utf8');
    // Reproduce a current-watermark checkpoint from before request ownership was projected.
    for (const name of ['meta.json', 'meta.backup.json']) {
      const file = path.join(sessionsRoot()!, id, name);
      const meta = JSON.parse(await fs.readFile(file, 'utf8'));
      delete meta.requestTurns;
      await fs.writeFile(file, JSON.stringify(meta));
    }
    resetRecorderForTests(); resetSessionStoreForTests();
    const summary = await getSession(id);
    const origin = summary!.timelineTurns![turn]!.origin;
    const tail = await readRecentEvents(id, 3);
    expect(tail[0]).toMatchObject({ seq: late.seq, time: began + 30, turnOrigin: origin });
    expect(tail[1]?.kind).toBe('assistant_message');
    expect((await readActivityEvents(id, late.seq)).events[0]).toMatchObject({ seq: late.seq, turnOrigin: origin });
    expect((await readEvents(id, { from: late.seq }))[0]).toMatchObject({ seq: late.seq, turnOrigin: origin });
    expect(await readCompletedFinal(id, chat)).toMatchObject({ messageId: 'answer' });
    expect(await fs.readFile(journalPath, 'utf8')).toBe(original);
  });

  it('does not assign an old request to a newer generation', async () => {
    const { id, began, clock } = await completed();
    clock.mockReturnValue(began + 30);
    await recordChatObservations(chat, [
      { kind: 'user_message', time: Date.now(), messageId: 'next-question', text: 'Inspect another file.' },
      { kind: 'turn_start', time: Date.now(), turnId: 'next-turn' }
    ]);
    clock.mockReturnValue(began + 40);
    await call(Date.now());
    const events = await readEvents(id);
    const oldCall = events.find(event => event.kind === 'tool_call' && event.time === began + 40)!;
    expect(oldCall.turnId).toBe(turn);
    expect(events.indexOf(oldCall)).toBeLessThan(events.findIndex(event => event.kind === 'assistant_message'));
    expect((await getSession(id))?.activeTurnId).toBe('next-turn');
    expect(await readCompletedFinal(id, chat)).toBeNull();
  });

  it('treats a new request after the final as new work', async () => {
    const { id, began, clock } = await completed();
    clock.mockReturnValue(began + 30);
    await call(Date.now(), 'wfr_new_request');
    expect(await readCompletedFinal(id, chat)).toBeNull();
    const events = await readEvents(id);
    expect(events.at(-1)).toMatchObject({ kind: 'tool_call', call: { requestId: 'wfr_new_request' } });
  });

  /**
   * Upstream #1931, 2.1.48 release round (Windows VM, GPT-5.6): the model wrote a progress note before its tool calls,
   * and the page first reported it after the turn had ended, when ChatGPT drew the turn's steps as one
   * collapsed group, as "just appeared". Recorded after the final, it read as new work, and Goal waited for good.
   */
  const lateNote = (turnId = turn) => recordChatObservations(chat, [
    { kind: 'assistant_message', time: Date.now(), turnId, messageId: 'progress-note',
      providerMessageId: '66666666-7777-4888-8999-000000000000', text: 'I’ll inspect the source first.', state: 'streaming', activeNow: true }
  ]);

  it.each([false, true])('keeps a final complete when its turn’s progress note is reported after the turn ended (restart %s)', async restart => {
    const { id, began, clock } = await completed();
    const noted = () => getLog().filter(entry => entry.message ===
      `session recorder: ${chat} reported a message of turn ${turn} after that turn ended; kept in history, not counted as new work`).length;
    const before = noted();
    clock.mockReturnValue(began + 30);
    await lateNote();
    await lateNote();
    // Kept in the chat's history, as before, and logged once however often the page repeats it.
    expect((await readEvents(id)).some(event => event.kind === 'assistant_message' && event.messageId === 'progress-note')).toBe(true);
    expect(noted() - before).toBe(1);
    if (restart) { await flushSessions(); resetRecorderForTests(); resetSessionStoreForTests(); }
    expect(await readCompletedFinal(id, chat, turn)).toMatchObject({ messageId: 'answer', turnId: turn });
    expect(await readCompletedFinal(id, chat)).toMatchObject({ messageId: 'answer' });
  });

  it('still counts a progress note as work once the same request reopened its turn', async () => {
    // No native final: the same request calling tools after the end reopens the turn.
    const { id, began, clock } = await completed(false);
    clock.mockReturnValue(began + 30);
    await call(Date.now());
    expect((await getSession(id))?.activeTurnId).toBe(turn);
    clock.mockReturnValue(began + 40);
    await lateNote();
    const note = (await readEvents(id)).find(event => event.kind === 'assistant_message' && event.messageId === 'progress-note');
    expect(note).toMatchObject({ state: 'streaming' });
    expect((note as { contentSeq?: number }).contentSeq).toBeGreaterThan(0);
  });

  // CodeRabbit on #1931: a fresh note of a turn whose view failed while thinking reopens that turn,
  // and is new work that a later Goal decision must see.
  it('counts a fresh progress note of a turn that failed while thinking as work, and reopens the turn', async () => {
    const began = Date.now();
    const clock = vi.spyOn(Date, 'now').mockReturnValue(began);
    const opened = await recordChatObservations(chat, [
      { kind: 'user_message', time: began, messageId: 'question', text: 'Inspect the source.' },
      { kind: 'turn_start', time: began + 1, turnId: turn }
    ]);
    clock.mockReturnValue(began + 10);
    await recordChatObservations(chat, [{ kind: 'turn_end', time: Date.now(), turnId: turn, outcome: 'failed', reason: 'thinking_failed' }]);
    clock.mockReturnValue(began + 30);
    await lateNote();
    const note = (await readEvents(opened.sessionId!)).find(event => event.kind === 'assistant_message' && event.messageId === 'progress-note');
    expect((note as { contentSeq?: number }).contentSeq).toBeGreaterThan(0);
    expect((await getSession(opened.sessionId!))?.activeTurnId).toBe(turn);
    expect((await getSession(opened.sessionId!))?.finishTurn?.workSeq).toBe((note as { contentSeq?: number }).contentSeq);
  });

  // CodeRabbit on #1931: decided again when reading, from the stored records, so a note saved before
  // this fix, a turn older than the recorder's memory, and a note re-reported without its turn id all settle.
  const savedNote = (id: string, turnId: string, contentSeq: number) => appendEvent(id, {
    source: 'extension', time: Date.now(), turnId, kind: 'assistant_message', messageId: `saved-note-${turnId}`,
    message: { text: 'I’ll inspect the source first.', truncated: false, chars: 30 }, state: 'streaming', final: false,
    providerMessageId: '66666666-7777-4888-8999-000000000001', contentSeq
  } as never);

  it('settles a final whose turn’s late note was saved as work before this fix', async () => {
    const { id, began, clock } = await completed();
    const work = (await getSession(id))?.finishTurn?.workSeq;
    clock.mockReturnValue(began + 30);
    await savedNote(id, turn, 999);
    // Nor is it work for the finish decision, so Goal decides nothing again (CodeRabbit on #1931).
    expect((await getSession(id))?.finishTurn?.workSeq).toBe(work);
    await flushSessions(); resetRecorderForTests(); resetSessionStoreForTests();
    expect(await readCompletedFinal(id, chat, turn)).toMatchObject({ messageId: 'answer', turnId: turn });
    expect((await getSession(id))?.finishTurn?.workSeq).toBe(work);
  });

  it('settles a newer final when a late note of an older, ended turn is saved as work', async () => {
    const { id, began, clock } = await completed();
    clock.mockReturnValue(began + 40);
    await recordChatObservations(chat, [
      { kind: 'user_message', time: Date.now(), messageId: 'second-question', text: 'And the tests?' },
      { kind: 'turn_start', time: Date.now() + 1, turnId: 'second-turn' }
    ]);
    clock.mockReturnValue(began + 50);
    await recordChatObservations(chat, [
      { kind: 'assistant_message', time: Date.now(), turnId: 'second-turn', messageId: 'second-answer',
        providerMessageId: '22222222-2222-4333-8444-555555555555', text: 'The tests pass.', final: true, state: 'final', activeNow: true },
      { kind: 'turn_end', time: Date.now(), turnId: 'second-turn', outcome: 'completed' }
    ]);
    clock.mockReturnValue(began + 60);
    await savedNote(id, turn, 999);
    expect(await readCompletedFinal(id, chat)).toMatchObject({ messageId: 'second-answer', turnId: 'second-turn' });
  });

  it('settles a final when its turn’s note is re-reported without a turn id after the turn ended', async () => {
    const began = Date.now();
    const clock = vi.spyOn(Date, 'now').mockReturnValue(began);
    const opened = await recordChatObservations(chat, [
      { kind: 'user_message', time: began, messageId: 'question', text: 'Inspect the source.' },
      { kind: 'turn_start', time: began + 1, turnId: turn }
    ]);
    clock.mockReturnValue(began + 5);
    await recordChatObservations(chat, [{ kind: 'assistant_message', time: Date.now(), turnId: turn, messageId: 'progress-note',
      providerMessageId: '66666666-7777-4888-8999-000000000000', text: 'I’ll inspect', state: 'streaming', activeNow: true }]);
    clock.mockReturnValue(began + 20);
    await recordChatObservations(chat, [
      { kind: 'assistant_message', time: Date.now(), turnId: turn, messageId: 'answer',
        providerMessageId: '11111111-2222-4333-8444-555555555555', text: 'The source is checked.', final: true, state: 'final', activeNow: true },
      { kind: 'turn_end', time: Date.now(), turnId: turn, outcome: 'completed' }
    ]);
    clock.mockReturnValue(began + 30);
    await recordChatObservations(chat, [{ kind: 'assistant_message', time: Date.now(), messageId: 'progress-note',
      providerMessageId: '66666666-7777-4888-8999-000000000000', text: 'I’ll inspect the source first.', state: 'streaming', activeNow: true }]);
    expect(await readCompletedFinal(opened.sessionId!, chat, turn)).toMatchObject({ messageId: 'answer', turnId: turn });
  });

  it('still treats a message of another turn after the final as new work', async () => {
    const { id, began, clock } = await completed();
    clock.mockReturnValue(began + 30);
    await lateNote('another-turn');
    expect(await readCompletedFinal(id, chat, turn)).toBeNull();
  });

  it('still reopens a falsely completed view without native final proof', async () => {
    const { id, began, clock } = await completed(false);
    clock.mockReturnValue(began + 30);
    await call(Date.now());
    expect((await getSession(id))?.activeTurnId).toBe(turn);
    expect(await readCompletedFinal(id, chat)).toBeNull();
  });

  it('leaves contradictory request-to-turn proof unowned after reconstruction', async () => {
    const { id, began } = await completed();
    const first = (await readEvents(id, { kinds: ['tool_call'] }))[0]!;
    if (first.kind !== 'tool_call') throw new Error('Expected recorded tool');
    await appendEvent(id, { kind: 'turn_start', source: 'extension', time: began + 25, turnId: 'conflicting-turn' });
    await appendEvent(id, { kind: 'tool_call', source: 'mcp', time: began + 26, turnId: 'conflicting-turn',
      call: { ...first.call, callId: 'conflicting-call' } });
    await appendEvent(id, { kind: 'tool_call', source: 'mcp', time: began + 27,
      call: { ...first.call, callId: 'unowned-call' } });
    await flushSessions(); resetRecorderForTests(); resetSessionStoreForTests();
    expect((await getSession(id))?.requestTurns?.[requestId]).toBeNull();
    const rows = await readEvents(id);
    expect(rows.find(event => event.kind === 'tool_call' && event.call.callId === 'unowned-call')?.turnOrigin).toBeNull();
    expect(await readCompletedFinal(id, chat)).toBeNull();
  });
});
