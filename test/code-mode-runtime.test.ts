import { expect, it, vi } from 'vitest';
import sharp from 'sharp';
import {
  CODE_MODE_LIMITS, interruptCodeModeConversation, parseCodeModeExecSource, runCodeMode, shutdownCodeModeRuntime,
  waitCodeMode, type CodeModeOptions, type CodeModeWaitOptions
} from '../src/main/mcp/code-mode-runtime.js';
import type { ToolResult } from '../src/main/mcp/kernel.js';
import { currentCall, emptyEvidence, runInCallContext, type CallContext } from '../src/main/mcp/call-context.js';

const result = (value: string): ToolResult => ({ content: [{ type: 'text', text: value }] });
const tools = [{ name: 'lookup', description: 'Fixture lookup returning a normal MCP result.' }];
const limits = { ...CODE_MODE_LIMITS, wallMs: 2000, cpuMs: 100 };
const rendered = (value: ToolResult) => JSON.stringify(value.content);
const cellIdOf = (value: ToolResult): string => {
  const notice = value.content.find(part => part.type === 'text' && /cell_id "[^"]+"/.test(part.text));
  const id = notice?.type === 'text' ? notice.text.match(/cell_id "([^"]+)"/)?.[1] : undefined;
  if (!id) throw new Error('expected a running cell id in the result content');
  return id;
};

it('runs concurrent tools, keeps intermediates private, and returns only explicit filtered output', async () => {
  let release!: () => void;
  const gate = new Promise<void>(resolve => { release = resolve; });
  let entered = 0;
  const invoke = vi.fn(async (_name, args) => {
    if (++entered === 2) release();
    await gate;
    return result('PRIVATE-' + args.id);
  });
  const output = await runCodeMode(`
    const rows = await Promise.all([tools.lookup({id:1}), tools.lookup({id:2})]);
    text(rows.map((row, index) => ({index, chars:row.content[0].text.length})));
  `, tools, invoke, limits);
  expect(output.isError).not.toBe(true);
  expect(invoke).toHaveBeenCalledTimes(2);
  expect(output.content).toEqual([{ type: 'text', text: '[{"index":0,"chars":9},{"index":1,"chars":9}]' }]);
  expect(rendered(output)).not.toContain('PRIVATE');
  expect((await runCodeMode('await tools.lookup({id:3})', tools, invoke, limits)).content).toEqual([]);
});

it('propagates a thrown nested failure into the isolate and keeps a returned envelope intact', async () => {
  const invoke = vi.fn(async (name: string) => {
    if (name === 'explode') throw new Error('CHILD_FAILED: permission denied');
    return { content: [{ type: 'text', text: 'plain envelope' }], isError: true };
  });
  const thrown = await runCodeMode('try { await tools.explode({}); } catch (error) { text(error.message); }',
    [{ name: 'explode', description: 'fixture' }], invoke, limits);
  expect(rendered(thrown)).toContain('CHILD_FAILED: permission denied');
  // A returned error envelope stays a value: the trusted adapter, not this runtime, decides failures.
  const envelope = await runCodeMode('const r = await tools.explode({}); text([r.isError, r.content[0].text]);',
    [{ name: 'explode', description: 'fixture' }], async () => ({ content: [{ type: 'text', text: 'kept' }], isError: true }), limits);
  expect(envelope.content).toEqual([{ type: 'text', text: '[true,"kept"]' }]);
});

it('has no host authority or state shared with the next invocation', async () => {
  const code = `text([typeof process, typeof require, typeof fetch, typeof console, typeof WebAssembly, typeof __bridge]); globalThis.privateValue=42;`;
  const output = await runCodeMode(code, [], async () => result('unused'), limits);
  expect(output.content).toEqual([{ type: 'text', text: '["undefined","undefined","undefined","undefined","undefined","undefined"]' }]);
  expect((await runCodeMode('text(typeof privateValue)', [], async () => result('unused'), limits)).content).toEqual([{ type: 'text', text: 'undefined' }]);
  expect((await runCodeMode(`import fs from 'node:fs'; text(fs)`, [], async () => result('unused'), limits)).isError).toBe(true);
  expect(rendered(await runCodeMode(`throw new Error('UNEMITTED_SECRET')`, [], async () => result('unused'), limits))).not.toContain('UNEMITTED_SECRET');
});

it('binds a warm reserved worker to the current request context, not its creator', async () => {
  const context = (requestId: string): CallContext => ({
    startedAt: Date.now(), transportKey: requestId, agent: null,
    caller: { transportKey: requestId, requestId, conversationId: requestId },
    outcome: null, evidence: emptyEvidence()
  });
  await runInCallContext(context('request-a'), () => runCodeMode(
    'await tools.lookup({});', tools,
    async () => {
      const { promise, resolve } = Promise.withResolvers<void>();
      setImmediate(resolve);
      await promise;
      return result('ready');
    }, limits
  ));
  const seen: Array<string | null | undefined> = [];
  await runInCallContext(context('request-b'), () => runCodeMode(
    'await tools.lookup({});', tools,
    async () => { seen.push(currentCall()?.caller.requestId); return result('done'); }, limits
  ));
  expect(seen).toEqual(['request-b']);
});

it('retires the idle reserve on shutdown and gives an explicit later host start a fresh interpreter', async () => {
  expect((await runCodeMode('globalThis.beforeShutdown=42; text("first")', [], async () => result('unused'), limits)).isError).not.toBe(true);
  await shutdownCodeModeRuntime();
  expect((await runCodeMode('text(typeof beforeShutdown)', [], async () => result('unused'), limits)).content)
    .toEqual([{ type: 'text', text: 'undefined' }]);
});

it('explains malformed source without echoing source strings or dispatching a child', async () => {
  const invoke = vi.fn(async () => result('unused'));
  const output = await runCodeMode("await tools.lookup({text:'PRIVATE_SOURCE", tools, invoke, limits);
  expect(rendered(output)).toContain('CODE_MODE_PARSE_ERROR');
  expect(rendered(output)).toContain('quoting');
  expect(rendered(output)).not.toContain('PRIVATE_SOURCE');
  expect(invoke).not.toHaveBeenCalled();
});

it('clips only response text, retains the full emission and continues later actions', async () => {
  const invoke = vi.fn(async () => result('done'));
  const onTruncatedOutput = vi.fn();
  const output = await runCodeMode('text("界".repeat(100)); await tools.lookup({id:1}); text("tail");', tools, invoke,
    { ...limits, textBytes: 100 }, { onTruncatedOutput });
  expect(output.isError).not.toBe(true);
  expect(output.content.slice(1)).toEqual([
    { type: 'text', text: '界'.repeat(33) }
  ]);
  expect(output.content[0]).toMatchObject({ text: expect.stringContaining('truncated') });
  expect(invoke).toHaveBeenCalledExactlyOnceWith('lookup', { id: 1 });
  expect(onTruncatedOutput.mock.calls[0]?.[0].slice(1)).toEqual([
    { type: 'text', text: '界'.repeat(100) }, { type: 'text', text: 'tail' }
  ]);
  expect(JSON.stringify(output)).not.toContain('界'.repeat(34));
  const escaped = await runCodeMode('text("\\n".repeat(90));', tools, invoke, { ...limits, textBytes: 100 });
  expect(escaped.content).toEqual([{ type: 'text', text: '\n'.repeat(90) }]);
});

it('bounds CPU, unresolved promises, memory, output and call admission', async () => {
  const invoke = vi.fn(async () => result('yes'));
  expect(rendered(await runCodeMode('while(true) {}', [], invoke, limits))).toContain('CPU_LIMIT');
  expect(rendered(await runCodeMode('await new Promise(()=>{})', [], invoke, { ...limits, wallMs: 250 }))).toContain('TIME_LIMIT');
  expect((await runCodeMode('const a=[]; while(true) a.push(new Array(50000).fill("x"));', [], invoke, { ...limits, cpuMs: 1000, memoryBytes: 2 * 1024 * 1024 })).isError).toBe(true);
  expect(rendered(await runCodeMode('text("x".repeat(10000))', [], invoke, { ...limits, outputBytes: 100 }))).toContain('OUTPUT_LIMIT');
  expect((await runCodeMode('await Promise.all(Array.from({length:40},()=>tools.lookup({})))', tools, invoke, limits)).isError).toBe(true);
  expect(invoke.mock.calls.length).toBeLessThanOrEqual(limits.concurrentCalls);
});

it('excludes synchronous host state resolution from the guest CPU budget', async () => {
  let resolutions = 0;
  let checksum = 0;
  const output = await runCodeMode('store("k", 1); text(load("k"));', [], async () => result('unused'),
    { ...limits, cpuMs: 10 }, {
      owner: 'core:cpu-wait',
      resolveOwner: owner => {
        // Resolution 1 is admission, before the worker starts. Resolution 2 is the canonical-owner
        // lookup that opens the first state request, which runs while the worker is blocked in
        // Atomics.wait; later ones (other owners' buckets, the load) depend on global store state.
        if (++resolutions === 2) {
          // Fixed work avoids a real timer while still exceeding the guest budget by a wide margin
          // on the broken path.
          for (let index = 0; index < 100_000_000; index++) checksum = (checksum + index) | 0;
        }
        return owner;
      }
    });
  // Content first: a cell that died before its first state request reports why here.
  expect(output.content).toEqual([{ type: 'text', text: '1' }]);
  expect(output.isError).not.toBe(true);
  expect(checksum).not.toBe(0);
});

it('rejects circular or oversized host results without leaking them or hanging', async () => {
  const circular = result('INTERNAL'); (circular as any).cycle = circular;
  const invalid = await runCodeMode('text(await tools.lookup({}))', tools, async () => circular, limits);
  expect(invalid.isError).toBe(true);
  expect(rendered(invalid)).toContain('RESULT_INVALID');
  const output = await runCodeMode('text(await tools.lookup({}))', tools, async () => result('PRIVATE'.repeat(100)), { ...limits, resultBytes: 100 });
  expect(rendered(output)).toContain('RESULT_LIMIT');
  expect(rendered(output)).not.toContain('PRIVATE');
});

it('keeps a caught nested failure readable and surfaces an uncaught one without echoing source', async () => {
  const invoke = vi.fn(async (name: string) => {
    if (name === 'explode') throw new Error('PATCH_REJECTED: context mismatch');
    return result('ok');
  });
  const caught = await runCodeMode('try { await tools.explode({}); } catch (error) { text("caught:" + error.message); }',
    [{ name: 'explode', description: 'fixture' }], invoke, limits);
  expect(caught.content).toEqual([{ type: 'text', text: 'caught:PATCH_REJECTED: context mismatch' }]);
  const uncaught = await runCodeMode('await tools.explode({});',
    [{ name: 'explode', description: 'fixture' }], invoke, limits);
  expect(uncaught.isError).toBe(true);
  expect(rendered(uncaught)).toContain('CODE_MODE_SCRIPT_ERROR: PATCH_REJECTED: context mismatch');
  const own = await runCodeMode('throw new Error("PRIVATE_SOURCE_TEXT")', [], invoke, limits);
  expect(rendered(own)).toContain('CODE_MODE_SCRIPT_ERROR');
  expect(rendered(own)).not.toContain('PRIVATE_SOURCE_TEXT');
});

it('latches a worker limit even when the script catches it and tries another tool', async () => {
  const invoke = vi.fn(async () => result('unexpected'));
  const output = await runCodeMode('for(let i=0;i<33;i++){try{text("a")}catch{}} await tools.lookup({});', tools, invoke, limits);
  expect(rendered(output)).toContain('OUTPUT_LIMIT');
  expect(invoke).not.toHaveBeenCalled();
});

it('keeps the emission-count guard across waits after delivered output is released', async () => {
  const gate = Promise.withResolvers<ToolResult>();
  const owner: CodeModeOptions = { owner: 'core:many-emissions', fullOutputByDefault: true, skipEmittedByteLimits: true };
  try {
    const first = await runCodeMode('text("first"); yield_control(); await tools.gate({}); for(let i=1;i<33;i++) text(String(i));',
      [{ name: 'gate', description: 'fixture gate' }], () => gate.promise, limits, owner);
    const cellId = cellIdOf(first);
    expect(first.content[0]).toEqual({ type: 'text', text: 'first' });
    gate.resolve(result('released'));
    const second = await waitCodeMode({ cell_id: cellId, yield_time_ms: 1_000 }, owner);
    expect(second.isError).toBe(true);
    expect(rendered(second)).toContain('CODE_MODE_OUTPUT_LIMIT');
    expect(second.content.filter(part => part.type === 'text' && /^\d+$/.test(part.text))).toHaveLength(31);
  } finally {
    gate.resolve(result('released'));
    await shutdownCodeModeRuntime();
  }
});

it('retains Desktop and Plugins emission byte guards', async () => {
  const output = await runCodeMode('text("x".repeat(1000));', [], async () => result('unused'),
    { ...limits, resultBytes: 100 });
  expect(output.isError).toBe(true);
  expect(rendered(output)).toContain('CODE_MODE_OUTPUT_LIMIT');
  expect(rendered(output)).toContain('100 bytes per emission');
  expect(rendered(output)).not.toContain('x'.repeat(100));
});

it('emits valid native images and rejects malformed or remote image payloads', async () => {
  const data = (await sharp({ create: { width: 2, height: 2, channels: 3, background: 'red' } }).png().toBuffer()).toString('base64');
  const img: ToolResult = { content: [{ type: 'image', mimeType: 'image/png', data }] };
  const output = await runCodeMode('const r=await tools.lookup({}); image(r.content[0]);', tools, async () => img, limits);
  expect(output).toEqual(img);
  for (const value of ['https://example.com/image.png', 'data:image/png;base64,YWJj', { type: 'image', mimeType: 'image/jpeg', data }]) {
    expect((await runCodeMode(`image(${JSON.stringify(value)})`, [], async () => img, limits)).isError).toBe(true);
  }
});

it('expires a cell that completes while yielded output is being decoded', async () => {
  const data = (await sharp({ create: { width: 2, height: 2, channels: 3, background: 'blue' } }).png().toBuffer()).toString('base64');
  vi.useFakeTimers();
  try {
    // The script reports its own continuation after the yield, so the terminal message that arms the
    // idle deadline is already queued behind a host-visible one when the loop below starts advancing.
    const settled = Promise.withResolvers<void>();
    const output = await runCodeMode(`image({type:"image",mimeType:"image/png",data:${JSON.stringify(data)}}); yield_control(); notify("settled");`,
      [], async () => result('unused'), { ...limits, cellIdleMs: 25 },
      { owner: 'core:image-retention', onNotify: () => settled.resolve() });
    const cellId = cellIdOf(output);
    expect(output.content[0]).toMatchObject({ type: 'image', mimeType: 'image/png' });
    await settled.promise;
    // Each advance runs on a native timer, so the event loop delivers whatever is still queued, and
    // the deadline armed on any of those turns is reached by the next advance.
    for (let attempt = 0; attempt < 20; attempt += 1) await vi.advanceTimersByTimeAsync(25);
    expect(rendered(await waitCodeMode({ cell_id: cellId }, { owner: 'core:image-retention' }))).toContain('CODE_MODE_UNKNOWN_CELL');
  } finally {
    vi.useRealTimers();
    await shutdownCodeModeRuntime();
  }
});

it('delivers a claimed cell across idle expiry and still expires an unclaimed one', async () => {
  const owner: CodeModeOptions = { owner: 'core:idle-claim' };
  const streaming = { ...limits, cellIdleMs: 25 };
  // Produces a cell that has ended (interrupted) while two host-owned emissions are still undelivered,
  // and reports the id only once both are buffered: emit('second') strictly precedes notify('buffered'),
  // so the notify side channel is the signal that the undelivered output is really on the cell.
  const seedEndedCellWithBufferedOutput = async (conversationId: string): Promise<string> => {
    const gate = Promise.withResolvers<ToolResult>();
    const buffered = Promise.withResolvers<void>();
    const run = runCodeMode('text("first"); yield_control(); await tools.gate({}); text("second"); notify("buffered"); await new Promise(() => {});',
      [{ name: 'gate', description: 'fixture gate' }], () => gate.promise, streaming,
      { ...owner, conversationId: () => conversationId, onNotify: () => buffered.resolve() });
    const cellId = cellIdOf(await run);
    gate.resolve(result('released'));
    await buffered.promise;
    interruptCodeModeConversation(conversationId);
    return cellId;
  };
  vi.useFakeTimers();
  try {
    const cellId = await seedEndedCellWithBufferedOutput('conversation-claimed');
    const validation = Promise.withResolvers<boolean>();
    // The claim is taken synchronously; the owner gate and the drain below are both asynchronous.
    const waiting = waitCodeMode({ cell_id: cellId, yield_time_ms: 1_000 }, { ...owner, canAccessOwner: () => validation.promise });
    // The idle window elapses in full while the waiter validates ownership. A removal here would free
    // the buffered emissions (and delete the cell) under the claimant.
    await vi.advanceTimersByTimeAsync(30);
    validation.resolve(true);
    expect((await waiting).content).toEqual([
      { type: 'text', text: expect.stringContaining('CODE_MODE_INTERRUPTED') },
      { type: 'text', text: 'second' },
      { type: 'text', text: 'buffered' }
    ]);
    // The same end state without a claim still expires, dropping its undelivered output.
    const expiredCell = await seedEndedCellWithBufferedOutput('conversation-expired');
    await vi.advanceTimersByTimeAsync(30);
    expect(rendered(await waitCodeMode({ cell_id: expiredCell }, owner))).toContain('CODE_MODE_UNKNOWN_CELL');
  } finally {
    vi.useRealTimers();
    await shutdownCodeModeRuntime();
  }
});

it('stops new admission on timeout while an accepted tool finishes under its own owner', async () => {
  let resolve!: (value: ToolResult) => void;
  const invoke = vi.fn(() => new Promise<ToolResult>(done => { resolve = done; }));
  const output = await runCodeMode('text("retained"); await tools.lookup({}); await tools.lookup({});', tools, invoke, { ...limits, wallMs: 500 });
  expect(rendered(output)).toContain('TIME_LIMIT');
  expect(output.content.slice(0, 2)).toEqual([
    { type: 'text', text: expect.stringContaining('CODE_MODE_TIME_LIMIT') },
    { type: 'text', text: expect.stringContaining('CODE_MODE_UNAWAITED_CALLS') }
  ]);
  expect(output.content[2]).toEqual({ type: 'text', text: 'retained' });
  expect(invoke).toHaveBeenCalledTimes(1);
  resolve(result('late private value'));
  await new Promise(done => setImmediate(done));
  expect(invoke).toHaveBeenCalledTimes(1);
});

it('defaults a direct result to one MiB and honours a larger pragma budget', async () => {
  const onTruncatedOutput = vi.fn();
  // The guest CPU budget is a wall-clock slice, so a loaded packaging runner can burn the shared
  // fixture's 100 ms on a mebibyte of guest work. Give this emission production-sized headroom.
  const heavy = { ...limits, cpuMs: 2_000, wallMs: 10_000 };
  const output = await runCodeMode('text("x".repeat(1048577));', [], async () => result('unused'), heavy, { onTruncatedOutput });
  expect(output.isError).not.toBe(true);
  expect(output.content[0]).toMatchObject({ text: expect.stringContaining('truncated') });
  expect(output.content[1]).toEqual({ type: 'text', text: 'x'.repeat(1_048_576) });
  expect(onTruncatedOutput).toHaveBeenCalledOnce();
  const full = await runCodeMode('// @exec: {"max_output_tokens": 300000}\ntext("x".repeat(1048577));', [], async () => result('unused'), heavy);
  expect(full.content).toEqual([{ type: 'text', text: 'x'.repeat(1_048_577) }]);
  const narrow = await runCodeMode('// @exec: {"max_output_tokens": 10}\ntext("x".repeat(100));', [], async () => result('unused'), limits);
  expect(narrow.content[1]).toEqual({ type: 'text', text: 'x'.repeat(40) });
});

it('returns all admitted Core text after a yield unless the caller explicitly limits that wait', async () => {
  const gate = Promise.withResolvers<ToolResult>();
  const owner: CodeModeOptions = { owner: 'core:full-output', fullOutputByDefault: true };
  try {
    const first = await runCodeMode('yield_control(); await tools.gate({}); text("界".repeat(100));',
      [{ name: 'gate', description: 'fixture gate' }], () => gate.promise,
      { ...limits, textBytes: 100 }, owner);
    const cellId = cellIdOf(first);
    gate.resolve(result('released'));
    const full = await waitCodeMode({ cell_id: cellId, yield_time_ms: 1_000 }, owner);
    expect(full.isError).not.toBe(true);
    expect(full.content).toEqual([{ type: 'text', text: '界'.repeat(100) }]);
    const narrow = await runCodeMode('// @exec: {"max_output_tokens": 10}\ntext("界".repeat(100));',
      [], async () => result('unused'), { ...limits, textBytes: 100 }, owner);
    expect(narrow.content[1]).toEqual({ type: 'text', text: '界'.repeat(13) });
  } finally {
    gate.resolve(result('released'));
    await shutdownCodeModeRuntime();
  }
});

it('does not hide a later script failure behind response truncation', async () => {
  const onTruncatedOutput = vi.fn();
  const output = await runCodeMode('text("x".repeat(101)); await Promise.resolve(); throw new Error("PRIVATE");', [], async () => result('unused'),
    { ...limits, textBytes: 100 }, { onTruncatedOutput });
  expect(output.isError).toBe(true);
  expect(output.content[0]).toMatchObject({ text: expect.stringContaining('CODE_MODE_SCRIPT_ERROR') });
  expect(output.content[1]).toMatchObject({ text: expect.stringContaining('truncated') });
  expect(output.content[2]).toEqual({ type: 'text', text: 'x'.repeat(100) });
  expect(onTruncatedOutput.mock.calls[0]?.[0][2]).toEqual({ type: 'text', text: 'x'.repeat(101) });
  expect(JSON.stringify(output)).not.toContain('PRIVATE');
});

it('puts invalid-output diagnostics before the validated emissions without changing their order', async () => {
  const output = await runCodeMode('text("first"); text("second"); image("data:image/png;base64,YWJj");', [], async () => result('unused'), limits);
  expect(output.isError).toBe(true);
  expect(output.content[0]).toMatchObject({ type: 'text', text: expect.stringContaining('CODE_MODE_OUTPUT_INVALID') });
  expect(output.content.slice(1)).toEqual([{ type: 'text', text: 'first' }, { type: 'text', text: 'second' }]);
});

it('validates and emits native audio and generated images with their output hint', async () => {
  const png = (await sharp({ create: { width: 3, height: 3, channels: 3, background: 'blue' } }).png().toBuffer()).toString('base64');
  const audio = Buffer.from('abcd').toString('base64');
  const output = await runCodeMode(`audio("data:audio/wav;base64,${audio}"); generatedImage({image_url:"data:image/png;base64,${png}", output_hint:"hint text"});`,
    [], async () => result('unused'), limits);
  expect(output.content).toEqual([
    { type: 'audio', data: audio, mimeType: 'audio/wav' },
    { type: 'image', data: png, mimeType: 'image/png' },
    { type: 'text', text: 'hint text' }
  ]);
  for (const value of ['https://example.com/a.wav', 'data:audio/wav;base64,', { type: 'audio', mimeType: 'video/mp4', data: audio }]) {
    const rejected = await runCodeMode(`audio(${JSON.stringify(value)})`, [], async () => result('unused'), limits);
    expect(rejected.isError).toBe(true);
    expect(rendered(rejected)).toContain('CODE_MODE_OUTPUT_INVALID');
  }
  // Audio shares the encoded-output budget rather than the decoded-image bound.
  const manyAudio = Array.from({ length: 6 }, () => `audio("data:audio/wav;base64,${audio}");`).join('');
  const audioOutput = await runCodeMode(manyAudio, [], async () => result('unused'), limits);
  expect(audioOutput.isError).not.toBe(true);
  expect(audioOutput.content.filter(part => part.type === 'audio')).toHaveLength(6);
  expect(rendered(await runCodeMode('generatedImage({image_url:"https://example.com/i.png"})', [], async () => result('unused'), limits)))
    .toContain('CODE_MODE_OUTPUT_INVALID');
});

it('buffers every notify payload into the next result even when the side channel succeeds', async () => {
  const seen: string[] = [];
  const onNotify = vi.fn((content: { type: string; text?: string }) => { seen.push(content.text ?? ''); });
  const output = await runCodeMode('notify("status-1"); text("body");', [], async () => result('unused'), limits, { onNotify });
  expect(output.content).toEqual([{ type: 'text', text: 'status-1' }, { type: 'text', text: 'body' }]);
  expect(onNotify).toHaveBeenCalledWith({ type: 'text', text: 'status-1' });
  expect(seen).toEqual(['status-1']);
  const silent = await runCodeMode('notify({step:2});', [], async () => result('unused'), limits);
  expect(silent.content).toEqual([{ type: 'text', text: '{"step":2}' }]);
});

it('runs guest timers on the host clock and cancels them with clearTimeout', async () => {
  vi.useFakeTimers();
  try {
    const armed = Promise.withResolvers<void>();
    const run = runCodeMode(`
      setTimeout(() => text("fired"), 5);
      const cancelled = setTimeout(() => text("cancelled"), 5);
      clearTimeout(cancelled);
      // Arm the awaited guest timer before notifying the host that it may advance the fake clock.
      const completed = new Promise(resolve => setTimeout(resolve, 20));
      notify("armed");
      await completed;
      text("after");
    `, [], async () => result('unused'), limits, { onNotify: () => armed.resolve() });
    await armed.promise;
    await vi.advanceTimersByTimeAsync(20);
    const output = await run;
    expect(output.isError).not.toBe(true);
    expect(output.content).toEqual([{ type: 'text', text: 'armed' }, { type: 'text', text: 'fired' }, { type: 'text', text: 'after' }]);
  } finally { vi.useRealTimers(); }
});

it('bounds the number of pending guest timers', async () => {
  const output = await runCodeMode('for (let i = 0; i < 70; i++) setTimeout(() => text("late"), 1000); await new Promise(() => {});',
    [], async () => result('unused'), { ...limits, timers: 4, wallMs: 400 });
  expect(output.isError).toBe(true);
  expect(rendered(output)).toContain('CODE_MODE_TIMER_LIMIT');
});

it('shares one session store across cells of the same owner and isolates other owners', async () => {
  const owner: CodeModeOptions = { owner: 'core:store-a' };
  const gate = Promise.withResolvers<ToolResult>();
  const gateEntered = Promise.withResolvers<void>();
  const stored = Promise.withResolvers<void>();
  try {
    const waiting = runCodeMode('// @exec: {"yield_time_ms": 0}\nawait tools.gate({}); text(load("k"));',
      [{ name: 'gate', description: 'fixture gate' }], () => { gateEntered.resolve(); return gate.promise; }, limits, owner);
    await gateEntered.promise;
    const readerCell = cellIdOf(await waiting);
    // A second live cell of the same owner writes while the first is still blocked on its child.
    const writer = runCodeMode('// @exec: {"yield_time_ms": 0}\nstore("k", "first"); store("k", "second"); notify("written"); await new Promise(() => {});',
      [], async () => result('unused'), limits, { ...owner, onNotify: () => stored.resolve() });
    await stored.promise;
    gate.resolve(result('released'));
    expect((await waitCodeMode({ cell_id: readerCell, yield_time_ms: 1_000 }, owner)).content).toEqual([{ type: 'text', text: 'second' }]);
    expect((await waitCodeMode({ cell_id: cellIdOf(await writer), terminate: true }, owner)).isError).toBe(true);
    expect((await runCodeMode('text(load("k"))', [], async () => result('unused'), limits, owner)).content)
      .toEqual([{ type: 'text', text: 'second' }]);
    expect((await runCodeMode('text(load("k"))', [], async () => result('unused'), limits, { owner: 'core:store-b' })).content)
      .toEqual([{ type: 'text', text: 'undefined' }]);
  } finally {
    gate.resolve(result('released'));
    await shutdownCodeModeRuntime();
  }
});

it('refuses state helpers for an anonymous execution and never registers a cell for it', async () => {
  const stored = await runCodeMode('try { store("k", 1); } catch (error) { text(error.message); }', [], async () => result('unused'), limits);
  expect(stored.content).toEqual([{ type: 'text', text: 'A trusted session owner is required for this helper' }]);
  expect(stored.structuredContent).toBeUndefined();
  const yielded = await runCodeMode('// @exec: {"yield_time_ms": 0}\ntext("never");', [], async () => result('unused'), limits);
  expect(yielded.isError).toBe(true);
  expect(rendered(yielded)).toContain('CODE_MODE_OWNER_REQUIRED');
  const control = await runCodeMode('try { yield_control(); } catch (error) { text(error.message); }', [], async () => result('unused'), limits);
  expect(control.content).toEqual([{ type: 'text', text: 'A trusted session owner is required for this helper' }]);
});

it('delivers completed text, wait output, errors, and native media through the client-selected channel', async () => {
  const direct = await runCodeMode('text("completed text")', [], async () => result('unused'), limits);
  expect(direct.structuredContent ?? direct.content).toEqual([{ type: 'text', text: 'completed text' }]);

  const data = (await sharp({ create: { width: 2, height: 2, channels: 3, background: 'purple' } }).png().toBuffer()).toString('base64');
  const media = await runCodeMode(
    `image({type:"image",mimeType:"image/png",data:${JSON.stringify(data)}})`,
    [], async () => result('unused'), limits);
  expect(media.structuredContent ?? media.content).toEqual([{ type: 'image', mimeType: 'image/png', data }]);

  const gate = Promise.withResolvers<ToolResult>();
  const owner: CodeModeOptions = { owner: 'core:client-channel' };
  try {
    const first = await runCodeMode('text("before"); yield_control(); await tools.gate({}); text("after");',
      [{ name: 'gate', description: 'fixture gate' }], () => gate.promise, limits, owner);
    const cellId = cellIdOf(first);
    expect(first.structuredContent ?? first.content).toEqual(first.content);
    gate.resolve(result('released'));
    const completed = await waitCodeMode({ cell_id: cellId, yield_time_ms: 1_000 }, owner);
    expect(completed.structuredContent ?? completed.content).toEqual([{ type: 'text', text: 'after' }]);
    expect(completed.content).not.toEqual(expect.arrayContaining([expect.objectContaining({ text: expect.stringContaining(cellId) })]));

    const failureGate = Promise.withResolvers<ToolResult>();
    try {
      const emitted = await runCodeMode(
        `image({type:"image",mimeType:"image/png",data:${JSON.stringify(data)}}); yield_control(); await tools.gate({}); throw new Error("failure");`,
        [{ name: 'gate', description: 'fixture gate' }], () => failureGate.promise, limits, owner);
      const failedCellId = cellIdOf(emitted);
      expect(emitted.structuredContent ?? emitted.content).toEqual(emitted.content);
      expect(emitted.content).toContainEqual({ type: 'image', mimeType: 'image/png', data });
      failureGate.resolve(result('released'));
      const failure = await waitCodeMode({ cell_id: failedCellId, yield_time_ms: 1_000 }, owner);
      expect(failure.isError).toBe(true);
      expect(failure.structuredContent ?? failure.content).toEqual(failure.content);
      expect(rendered(failure)).toContain('CODE_MODE_SCRIPT_ERROR');
      expect(rendered(failure)).not.toContain(failedCellId);
    } finally {
      failureGate.resolve(result('released'));
    }
  } finally {
    gate.resolve(result('released'));
    await shutdownCodeModeRuntime();
  }
});

it('yields a resumable cell without pausing it and paginates each wait to new output only', async () => {
  const owner: CodeModeOptions = { owner: 'core:pagination' };
  const gate = Promise.withResolvers<ToolResult>();
  const gateEntered = Promise.withResolvers<void>();
  try {
    // yield_control() flushes output while the script keeps running; the child call below is admitted
    // only because the yield does not pause the interpreter.
    const run = runCodeMode('text("first"); yield_control(); await tools.gate({}); text("second");',
      [{ name: 'gate', description: 'fixture gate' }], () => { gateEntered.resolve(); return gate.promise; }, limits, owner);
    const first = await run;
    const cellId = cellIdOf(first);
    expect(first.isError).not.toBe(true);
    expect(first.content).toEqual([
      { type: 'text', text: 'first' },
      { type: 'text', text: expect.stringContaining('Script running with cell ID') }
    ]);
    await gateEntered.promise;
    // An immediate wait returns nothing new and leaves the cell resumable.
    const idle = await waitCodeMode({ cell_id: cellId, yield_time_ms: 0 }, owner);
    expect(idle.isError).not.toBe(true);
    expect(idle.content).toEqual([{ type: 'text', text: expect.stringContaining('Script running with cell ID') }]);
    gate.resolve(result('released'));
    const finished = await waitCodeMode({ cell_id: cellId, yield_time_ms: 1_000 }, owner);
    expect(finished.isError).not.toBe(true);
    expect(finished.structuredContent).toBeUndefined();
    expect(finished.content).toEqual([{ type: 'text', text: 'second' }]);
    // A completed cell is closed: the same id fails closed afterwards.
    expect(await waitCodeMode({ cell_id: cellId, yield_time_ms: 0 }, owner)).toMatchObject({ isError: true });
  } finally {
    gate.resolve(result('released'));
    await shutdownCodeModeRuntime();
  }
});

it('lets exactly one concurrent wait own a cell and terminates it on request', async () => {
  const owner: CodeModeOptions = { owner: 'core:wait-claim' };
  const held = Promise.withResolvers<ToolResult>();
  const entered = Promise.withResolvers<void>();
  try {
    const run = runCodeMode('await tools.hold({}); text("never");',
      [{ name: 'hold', description: 'fixture hold' }], () => { entered.resolve(); return held.promise; }, limits, owner);
    await entered.promise;
    const cellId = cellIdOf(await run);
    const [first, second] = await Promise.all([
      waitCodeMode({ cell_id: cellId, yield_time_ms: 0 }, owner),
      waitCodeMode({ cell_id: cellId, yield_time_ms: 0 }, owner)
    ]);
    const busy = [first, second].find(value => rendered(value).includes('CODE_MODE_CELL_BUSY'));
    expect(busy).toBeDefined();
    expect([first, second].filter(value => value.isError !== true)).toHaveLength(1);
    const terminated = await waitCodeMode({ cell_id: cellId, terminate: true }, owner);
    expect(terminated.isError).toBe(true);
    expect(rendered(terminated)).toContain('CODE_MODE_TERMINATED');
    expect(rendered(await waitCodeMode({ cell_id: cellId }, owner))).toContain('CODE_MODE_UNKNOWN_CELL');
  } finally {
    held.resolve(result('released'));
    await shutdownCodeModeRuntime();
  }
});

it('fails closed for unknown cells, foreign owners, and unproven callers', async () => {
  const owner: CodeModeOptions = { owner: 'core:owner-a' };
  const held = Promise.withResolvers<ToolResult>();
  try {
    const run = runCodeMode('await tools.hold({});', [{ name: 'hold', description: 'fixture' }], () => held.promise, limits, owner);
    const cellId = cellIdOf(await run);
    expect(rendered(await waitCodeMode({ cell_id: 'no-such-cell' }, owner))).toContain('CODE_MODE_UNKNOWN_CELL');
    expect(rendered(await waitCodeMode({ cell_id: cellId }, { owner: 'core:owner-b' }))).toContain('CODE_MODE_FORBIDDEN');
    expect(rendered(await waitCodeMode({ cell_id: cellId }, {}))).toContain('CODE_MODE_FORBIDDEN');
    expect(rendered(await waitCodeMode({ cell_id: cellId }, { owner: 'core:owner-b', canAccessOwner: () => { throw new Error('denied'); } })))
      .toContain('CODE_MODE_FORBIDDEN');
    const alias: CodeModeWaitOptions = { owner: 'request:abc', canAccessOwner: (stored, requested) => stored === 'core:owner-a' && requested === 'request:abc' };
    expect((await waitCodeMode({ cell_id: cellId, yield_time_ms: 0 }, alias)).isError).not.toBe(true);
    expect((await waitCodeMode({ cell_id: cellId, terminate: true }, owner)).isError).toBe(true);
  } finally {
    held.resolve(result('released'));
    await shutdownCodeModeRuntime();
  }
});

it('resolves a request alias to its canonical store owner at every access', async () => {
  const gate = Promise.withResolvers<ToolResult>();
  const entered = Promise.withResolvers<void>();
  const stored = Promise.withResolvers<void>();
  const canonical: CodeModeWaitOptions = { owner: 'session:canonical', resolveOwner: async owner => owner.startsWith('request:') ? 'session:canonical' : owner };
  try {
    // The reader holds a request alias that only canonicalizes to the session owner later.
    const reader = runCodeMode('// @exec: {"yield_time_ms": 0}\nawait tools.gate({}); text(load("shared"));',
      [{ name: 'gate', description: 'fixture' }], () => { entered.resolve(); return gate.promise; }, limits, canonical);
    await entered.promise;
    const writer = runCodeMode('// @exec: {"yield_time_ms": 0}\nstore("shared", "canonical-value"); notify("written"); await new Promise(() => {});',
      [], async () => result('unused'), limits, { ...canonical, onNotify: () => stored.resolve() });
    await stored.promise;
    gate.resolve(result('released'));
    const readerCell = cellIdOf(await reader);
    expect((await waitCodeMode({ cell_id: readerCell, yield_time_ms: 1_000 }, canonical)).content).toEqual([{ type: 'text', text: 'canonical-value' }]);
    expect((await waitCodeMode({ cell_id: cellIdOf(await writer), terminate: true }, canonical)).isError).toBe(true);
  } finally {
    gate.resolve(result('released'));
    await shutdownCodeModeRuntime();
  }
});

it('interrupts only cells whose proven source conversation matches', async () => {
  const conversationId = 'conversation-a';
  const held = Promise.withResolvers<ToolResult>();
  const otherHeld = Promise.withResolvers<ToolResult>();
  const owner: CodeModeOptions = { owner: 'core:interrupt' };
  try {
    const first = runCodeMode('await tools.hold({}); text("never");',
      [{ name: 'hold', description: 'fixture' }], () => held.promise, limits, { ...owner, conversationId: () => conversationId });
    const other = runCodeMode('await tools.hold({}); text("other survives");',
      [{ name: 'hold', description: 'fixture' }], () => otherHeld.promise, limits, { ...owner, conversationId: () => 'conversation-b' });
    const firstCell = cellIdOf(await first);
    const otherCell = cellIdOf(await other);
    interruptCodeModeConversation('conversation-c');
    expect((await waitCodeMode({ cell_id: firstCell, yield_time_ms: 0 }, owner)).isError).not.toBe(true);
    interruptCodeModeConversation(conversationId);
    const stopped = await waitCodeMode({ cell_id: firstCell, yield_time_ms: 0 }, owner);
    expect(stopped.isError).toBe(true);
    expect(rendered(stopped)).toContain('CODE_MODE_INTERRUPTED');
    otherHeld.resolve(result('released'));
    const survivor = await waitCodeMode({ cell_id: otherCell, yield_time_ms: 1_000 }, owner);
    expect(survivor.isError).not.toBe(true);
    expect(survivor.content).toEqual([{ type: 'text', text: 'other survives' }]);
  } finally {
    held.resolve(result('released'));
    otherHeld.resolve(result('released'));
    await shutdownCodeModeRuntime();
  }
});

it('consults a late source proof once for an unattributed cell and never retargets it', async () => {
  let proof: string | null = null;
  const held = Promise.withResolvers<ToolResult>();
  const owner: CodeModeOptions = { owner: 'core:late-proof' };
  try {
    // Created while the source proof is still unresolved: the interruption must consult it again.
    const unattributed = runCodeMode('// @exec: {"yield_time_ms": 0}\nawait tools.hold({});', [{ name: 'hold', description: 'fixture' }],
      () => held.promise, limits, { ...owner, conversationId: () => proof });
    const cellId = cellIdOf(await unattributed);
    proof = 'conversation-late';
    interruptCodeModeConversation('conversation-other');
    expect((await waitCodeMode({ cell_id: cellId, yield_time_ms: 0 }, owner)).isError).not.toBe(true);
    interruptCodeModeConversation('conversation-late');
    expect(rendered(await waitCodeMode({ cell_id: cellId, yield_time_ms: 0 }, owner))).toContain('CODE_MODE_INTERRUPTED');
    // A cell whose source was already resolved keeps it: a successor conversation cannot retarget it.
    const attributed = runCodeMode('// @exec: {"yield_time_ms": 0}\nawait tools.hold({});', [{ name: 'hold', description: 'fixture' }],
      () => held.promise, limits, { ...owner, conversationId: () => 'conversation-original' });
    const attributedId = cellIdOf(await attributed);
    interruptCodeModeConversation('conversation-successor');
    expect((await waitCodeMode({ cell_id: attributedId, yield_time_ms: 0 }, owner)).isError).not.toBe(true);
    interruptCodeModeConversation('conversation-original');
    expect(rendered(await waitCodeMode({ cell_id: attributedId, yield_time_ms: 0 }, owner))).toContain('CODE_MODE_INTERRUPTED');
    // A wait's own source proof is never adopted as the cell's source.
    let sourceProof: string | null = null;
    const waiter = runCodeMode('// @exec: {"yield_time_ms": 0}\nawait tools.hold({});', [{ name: 'hold', description: 'fixture' }],
      () => held.promise, limits, { ...owner, conversationId: () => sourceProof });
    const waiterId = cellIdOf(await waiter);
    const waiterOnly: CodeModeOptions = { ...owner, conversationId: () => 'conversation-waiter' };
    await waitCodeMode({ cell_id: waiterId, yield_time_ms: 0 }, waiterOnly);
    interruptCodeModeConversation('conversation-waiter');
    expect((await waitCodeMode({ cell_id: waiterId, yield_time_ms: 0 }, owner)).isError).not.toBe(true);
    sourceProof = 'conversation-original';
    interruptCodeModeConversation('conversation-original');
    expect(rendered(await waitCodeMode({ cell_id: waiterId, yield_time_ms: 0 }, owner))).toContain('CODE_MODE_INTERRUPTED');
  } finally {
    held.resolve(result('released'));
    await shutdownCodeModeRuntime();
  }
});

it('moves alias-written state onto the canonical owner and resolves collisions by latest write', async () => {
  // The alias stores while it cannot yet prove its session.
  expect((await runCodeMode('store("k", "alias-value");', [], async () => result('unused'), limits, { owner: 'request:r1' })).isError).not.toBe(true);
  // Later proof promotes the alias; the value it wrote before promotion is still readable.
  const promote = async (owner: string) => owner.startsWith('request:') ? 'session:s1' : owner;
  expect((await runCodeMode('text(load("k"))', [], async () => result('unused'), limits, { owner: 'request:r1', resolveOwner: promote })).content)
    .toEqual([{ type: 'text', text: 'alias-value' }]);
  // A canonical write after promotion wins, and a stale alias value cannot resurrect over it.
  await runCodeMode('store("k", "canonical-later");', [], async () => result('unused'), limits, { owner: 'session:s1' });
  expect((await runCodeMode('text(load("k"))', [], async () => result('unused'), limits, { owner: 'request:r1', resolveOwner: promote })).content)
    .toEqual([{ type: 'text', text: 'canonical-later' }]);
  // Two aliases colliding on one key: the later host write survives, whichever promotion runs first.
  await runCodeMode('store("race", "first");', [], async () => result('unused'), limits, { owner: 'request:r2' });
  await runCodeMode('store("race", "second");', [], async () => result('unused'), limits, { owner: 'request:r3' });
  await runCodeMode('text(load("race"))', [], async () => result('unused'), limits, { owner: 'request:r3', resolveOwner: promote });
  expect((await runCodeMode('text(load("race"))', [], async () => result('unused'), limits, { owner: 'request:r2', resolveOwner: promote })).content)
    .toEqual([{ type: 'text', text: 'second' }]);
  expect((await runCodeMode('text(load("race"))', [], async () => result('unused'), limits, { owner: 'session:s1' })).content)
    .toEqual([{ type: 'text', text: 'second' }]);
  await shutdownCodeModeRuntime();
});

it('finds state written under a request alias after the writing cell has finished', async () => {
  await shutdownCodeModeRuntime();
  // The writing cell is long gone by the time the join is proved, so only resolveOwner can find it.
  expect((await runCodeMode('store("k", "written-before-proof");', [], async () => result('unused'), limits, { owner: 'request:late' })).isError).not.toBe(true);
  const promote = async (owner: string) => owner === 'request:late' ? 'session:joined' : owner;
  expect((await runCodeMode('text(load("k"))', [], async () => result('unused'), limits, { owner: 'session:joined', resolveOwner: promote })).content)
    .toEqual([{ type: 'text', text: 'written-before-proof' }]);
  // The alias bucket is gone (adopted) and the value is still reachable from a fresh cell.
  expect((await runCodeMode('text(load("k"))', [], async () => result('unused'), limits, { owner: 'session:joined', resolveOwner: promote })).content)
    .toEqual([{ type: 'text', text: 'written-before-proof' }]);
  await shutdownCodeModeRuntime();
});

it('keeps alias state readable and lossless when the merge cannot fit the target quota', async () => {
  await shutdownCodeModeRuntime();
  const tight = { ...limits, storeBytes: 70_000 };
  const promote = async (owner: string) => owner === 'request:big' ? 'session:tight' : owner;
  // Two sizable keys under the alias, and a target value that leaves no room for both.
  await runCodeMode('store("a", "x".repeat(30000)); store("b", "y".repeat(30000));', [], async () => result('unused'), tight, { owner: 'request:big' });
  await runCodeMode('store("keep", "z".repeat(30000));', [], async () => result('unused'), tight, { owner: 'session:tight' });
  const refused = await runCodeMode('try { load("a"); } catch (error) { text(error.message); }',
    [], async () => result('unused'), tight, { owner: 'session:tight', resolveOwner: promote });
  expect(refused.content).toEqual([{ type: 'text', text: expect.stringContaining('STATE_LIMIT') }]);
  // Nothing was dropped from either bucket when the all-or-nothing merge was refused.
  const aliasStill = await runCodeMode('text([load("a") !== undefined, load("b") !== undefined]);',
    [], async () => result('unused'), tight, { owner: 'request:big' });
  expect(aliasStill.content).toEqual([{ type: 'text', text: '[true,true]' }]);
  expect((await runCodeMode('text(load("keep") !== undefined);', [], async () => result('unused'), tight, { owner: 'session:tight' })).content)
    .toEqual([{ type: 'text', text: 'true' }]);
  await shutdownCodeModeRuntime();
});

it('renames an alias bucket onto a new canonical owner even at the owner cap', async () => {
  await shutdownCodeModeRuntime();
  const capped = { ...limits, storeOwners: 1 };
  await runCodeMode('store("k", "alias-value");', [], async () => result('unused'), capped, { owner: 'request:cap' });
  const promote = async (owner: string) => owner === 'request:cap' ? 'session:cap' : owner;
  expect((await runCodeMode('text(load("k"))', [], async () => result('unused'), capped, { owner: 'session:cap', resolveOwner: promote })).content)
    .toEqual([{ type: 'text', text: 'alias-value' }]);
  expect((await runCodeMode('store("k2", 2); text(load("k2"));', [], async () => result('unused'), capped, { owner: 'session:cap', resolveOwner: promote })).content)
    .toEqual([{ type: 'text', text: '2' }]);
  await shutdownCodeModeRuntime();
});

it('merges a finished request cell onto its later-proved session, keeping unique keys and the newer collision', async () => {
  await shutdownCodeModeRuntime();
  // Unproved request stores a unique key and a collision value, then the cell finishes.
  expect((await runCodeMode('store("unique", "only-here"); store("shared", "older");', [], async () => result('unused'), limits, { owner: 'request:smoke' })).isError).not.toBe(true);
  // The session already holds a newer value for the colliding key.
  await runCodeMode('store("shared", "newer");', [], async () => result('unused'), limits, { owner: 'session:smoke' });
  // Only now is the request -> session join proved.
  const promote = async (owner: string) => owner === 'request:smoke' ? 'session:smoke' : owner;
  const joined = await runCodeMode('text([load("unique"), load("shared")]);', [], async () => result('unused'), limits, { owner: 'session:smoke', resolveOwner: promote });
  expect(joined.content).toEqual([{ type: 'text', text: '["only-here","newer"]' }]);
  // A fresh cell of the same session sees the merged state; an unrelated session sees nothing.
  expect((await runCodeMode('text([load("unique"), load("shared")]);', [], async () => result('unused'), limits, { owner: 'session:smoke', resolveOwner: promote })).content)
    .toEqual([{ type: 'text', text: '["only-here","newer"]' }]);
  expect((await runCodeMode('text([typeof load("unique"), typeof load("shared")]);', [], async () => result('unused'), limits, { owner: 'session:other', resolveOwner: promote })).content)
    .toEqual([{ type: 'text', text: '["undefined","undefined"]' }]);
  // A later write through the still-alias spelling lands on the session bucket, not a stale one.
  await runCodeMode('store("shared", "latest");', [], async () => result('unused'), limits, { owner: 'request:smoke', resolveOwner: promote });
  expect((await runCodeMode('text(load("shared"));', [], async () => result('unused'), limits, { owner: 'session:smoke', resolveOwner: promote })).content)
    .toEqual([{ type: 'text', text: 'latest' }]);
  await shutdownCodeModeRuntime();
});

it('does not spend an owner slot on reads, misses, or refused writes', async () => {
  await shutdownCodeModeRuntime();
  const limitsWithOneOwner = { ...limits, storeOwners: 1 };
  // A read from a distinct owner and a refused oversized write must both leave the slot free.
  expect((await runCodeMode('text(load("nope"))', [], async () => result('unused'), limitsWithOneOwner, { owner: 'core:reader' })).content)
    .toEqual([{ type: 'text', text: 'undefined' }]);
  const refused = await runCodeMode('store("big", "x".repeat(70000));', [], async () => result('unused'), limitsWithOneOwner, { owner: 'core:refused' });
  expect(rendered(refused)).toContain('CODE_MODE_SCRIPT_ERROR');
  expect((await runCodeMode('store("k", 1); text(load("k"));', [], async () => result('unused'), limitsWithOneOwner, { owner: 'core:writer' })).content)
    .toEqual([{ type: 'text', text: '1' }]);
  await shutdownCodeModeRuntime();
});

it('never lets a forged marker or an unrelated throw leak its message', async () => {
  const forged = await runCodeMode('throw Object.assign(new Error("FORGED_SECRET"), { __codeModeNested: true });', [], async () => result('unused'), limits);
  expect(forged.isError).toBe(true);
  expect(rendered(forged)).toContain('CODE_MODE_SCRIPT_ERROR');
  expect(rendered(forged)).not.toContain('FORGED_SECRET');
  const unrelated = await runCodeMode('const error = new Error("PRIVATE_THROW"); error.name = "TypeError"; throw error;', [], async () => result('unused'), limits);
  expect(rendered(unrelated)).not.toContain('PRIVATE_THROW');
});

it('treats clearTimeout of an unknown or absent handle as a no-op', async () => {
  const output = await runCodeMode('clearTimeout(undefined); clearTimeout(null); clearTimeout(12345); text("ok");', [], async () => result('unused'), limits);
  expect(output.isError).not.toBe(true);
  expect(output.content).toEqual([{ type: 'text', text: 'ok' }]);
});

it('refuses new work, state and output once the facade reports the source inactive', async () => {
  let active = true;
  const gate = Promise.withResolvers<ToolResult>();
  const entered = Promise.withResolvers<void>();
  const owner: CodeModeOptions = { owner: 'core:lifecycle', lifecycle: { isActive: async () => active } };
  try {
    const run = runCodeMode('await tools.gate({}); text("late");',
      [{ name: 'gate', description: 'fixture' }], () => { entered.resolve(); return gate.promise; }, limits, owner);
    await entered.promise;
    const cellId = cellIdOf(await run);
    active = false;
    gate.resolve(result('released'));
    const stopped = await waitCodeMode({ cell_id: cellId, yield_time_ms: 0 }, owner);
    expect(stopped.isError).toBe(true);
    expect(rendered(stopped)).toContain('CODE_MODE_OWNER_INACTIVE');
    // A fresh cell admitted while the source is inactive refuses the child call outright.
    const storeAttempt = runCodeMode('await tools.gate({}); store("k", 1);',
      [{ name: 'gate', description: 'fixture' }], () => gate.promise, limits, owner);
    expect(rendered(await storeAttempt)).toContain('CODE_MODE_OWNER_INACTIVE');
    active = true;
    expect((await runCodeMode('text("fresh")', [], async () => result('unused'), limits, owner)).content)
      .toEqual([{ type: 'text', text: 'fresh' }]);
  } finally {
    gate.resolve(result('released'));
    await shutdownCodeModeRuntime();
  }
});

it('keeps an anonymous execution under shutdown custody and terminates it', async () => {
  const held = Promise.withResolvers<ToolResult>();
  const entered = Promise.withResolvers<void>();
  const run = runCodeMode('await tools.hold({}); text("never");',
    [{ name: 'hold', description: 'fixture' }], () => { entered.resolve(); return held.promise; }, { ...limits, wallMs: 5_000 });
  await entered.promise;
  await shutdownCodeModeRuntime();
  const output = await run;
  expect(output.isError).toBe(true);
  expect(rendered(output)).toContain('CODE_MODE_RUNTIME_ERROR');
  held.resolve(result('released'));
});

it('parses only the documented exec pragma fields', () => {
  expect(parseCodeModeExecSource('text(1);')).toEqual({ code: 'text(1);' });
  expect(parseCodeModeExecSource('// @exec: {"yield_time_ms": 250, "max_output_tokens": 50}\ntext(1);'))
    .toEqual({ code: '// @exec: {"yield_time_ms": 250, "max_output_tokens": 50}\ntext(1);', yieldTimeMs: 250, maxOutputTokens: 50 });
  for (const source of ['// @exec:\ntext(1);', '// @exec: {"nope": 1}\ntext(1);', '// @exec: {oops}\ntext(1);', '// @exec: {"yield_time_ms": -1}\ntext(1);', '// @exec: {"yield_time_ms": 1}']) {
    expect(parseCodeModeExecSource(source)).toMatchObject({ error: expect.stringContaining('exec pragma') });
  }
  expect(parseCodeModeExecSource('   ')).toMatchObject({ error: expect.stringContaining('non-empty') });
});
