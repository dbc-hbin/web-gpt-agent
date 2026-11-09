import { afterEach, expect, it, vi } from 'vitest';
import { UnifiedExecProcessManager, MAX_COMPLETED_EXEC_RESULTS, COMPLETED_EXEC_OUTPUT_BYTES,
  execCommandResponseText, execCommandStructuredOutput } from '../src/main/codex/unified-exec.js';
import { summarizeToolCall } from '../src/main/session/summarize.js';
import { emptyEvidence, noteExec, runInCallContext, type CallContext } from '../src/main/mcp/call-context.js';
import { nonZeroExitIsBenign } from '../src/main/exec-hints.js';
import { UNIFIED_EXEC_OUTPUT_MAX_BYTES } from '../src/main/codex/unified-exec-constants.js';

const managers: UnifiedExecProcessManager[] = [];
const policy = { kind: 'tokens' as const, tokens: 10_000 };
afterEach(async () => { vi.restoreAllMocks(); await Promise.all(managers.splice(0).map(m => m.terminateAllProcesses())); });
function manager() { const m = new UnifiedExecProcessManager(5000); managers.push(m); return m; }
function start(m: UnifiedExecProcessManager, code: string, yieldTimeMs = 10000) {
  const processId = m.allocateProcessId();
  return m.execCommand({ processId, command: [process.execPath, '-e', code], shellType: 'bash',
    hookCommand: 'completed-result fixture', cwd: process.cwd(), displayCwd: '.', env: process.env, tty: false,
    yieldTimeMs, maxOutputTokens: undefined, truncationPolicy: policy });
}
function poll(m: UnifiedExecProcessManager, processId: number, input = '') {
  return m.writeStdin({ processId, input, yieldTimeMs: 1000, maxOutputTokens: undefined, truncationPolicy: policy });
}

it('rereads an immediately completed command without executing it again or accepting input', async () => {
  const m = manager();
  const first = await start(m, "console.log('pid=' + process.pid); process.exitCode=7");
  expect(first.exitCode).toBe(7);
  const id = first.completedSessionId!;
  expect(execCommandStructuredOutput(first)).toMatchObject({ completed_session_id: id, exit_code: 7 });
  expect(execCommandStructuredOutput(first)).not.toHaveProperty('session_id');
  expect(execCommandResponseText(first)).toContain(`Completed session ID: ${id}`);
  const [a, b] = await Promise.all([poll(m, id), poll(m, id)]);
  expect(a.rawOutput.equals(first.rawOutput)).toBe(true);
  expect(b.rawOutput.equals(first.rawOutput)).toBe(true);
  expect(a).toMatchObject({ replayed: true, exitCode: 7, processId: null });
  expect(execCommandStructuredOutput(a)).toMatchObject({ output_replayed: true, exit_code: 7 });
  expect(execCommandStructuredOutput(a)).not.toHaveProperty('benign_exit');
  expect(m.backgroundState(new Set([id]))).toEqual({ running: [], exitedUnread: [] });
  await expect(poll(m, id, 'input')).rejects.toThrow('already completed');
  expect((await poll(m, id)).rawOutput.equals(first.rawOutput)).toBe(true);
});

it('rereads all retained output from one explicit poll, and nothing is pushed elsewhere', async () => {
  const m = manager();
  const first = await start(m, "console.log('early'); setTimeout(()=>console.log('late'), 700)", 250);
  const id = first.processId!;
  expect(id).not.toBeNull();
  // The first poll collects pending output; completed history remains available for rereading.
  expect(first.rawOutput.toString()).toBe('early\n');
  await expect.poll(() => m.exitedUnread(new Set([id])).length).toBe(1);
  // Automatic retirement frees the live slot; the poll consumes only the unread suffix.
  const polled = await poll(m, id);
  expect(polled.rawOutput.toString()).toBe('late\n');
  expect(m.backgroundState(new Set([id]))).toEqual({ running: [], exitedUnread: [] });
  // Once retired, the same poll replays the whole retained history.
  expect((await poll(m, id)).rawOutput.toString()).toBe('early\nlate\n');
});

it('preserves unread output omission metadata after automatic retirement', async () => {
  const m = manager();
  const started = await start(m,
    `setTimeout(()=>process.stdout.write('x'.repeat(${UNIFIED_EXEC_OUTPUT_MAX_BYTES * 2})), 700)`, 250);
  const id = started.processId;
  if (id === null) throw new Error('Expected the fixture to yield a running process');
  await started.completion;
  const result = await poll(m, id);
  expect(result.outputOmittedBytes).toBe(UNIFIED_EXEC_OUTPUT_MAX_BYTES);
});

it('bounds completed output and expires old read and unread results without blocking launches', async () => {
  const m = manager();
  const released = vi.fn(); m.setProcessReleaseListener(released);
  const first = await start(m, `process.stdout.write('a'.repeat(${COMPLETED_EXEC_OUTPUT_BYTES * 2})+'TAIL')`);
  const id = first.completedSessionId!;
  const output = (await poll(m, id)).rawOutput.toString();
  expect(Buffer.byteLength(output)).toBeLessThan(COMPLETED_EXEC_OUTPUT_BYTES + 200);
  expect(output).toContain('omitted'); expect(output.endsWith('TAIL')).toBe(true);
  const unread = await start(m, "setTimeout(()=>console.log('unread-result'), 700)", 250);
  const unreadId = unread.processId;
  expect(unreadId).not.toBeNull();
  if (unreadId === null) throw new Error('Expected the fixture to yield a running process');
  await unread.completion;
  // Fill the cache exactly; neither read nor unread results may expire early.
  for (let i = 0; i < MAX_COMPLETED_EXEC_RESULTS - 2; i++) await start(m, '');
  expect(released).not.toHaveBeenCalled();
  expect((await poll(m, id)).rawOutput.toString()).toBe(output);
  expect(m.exitedUnread(new Set([unreadId]))).toEqual([{ processId: unreadId, exitCode: 0 }]);
  // Only results beyond the bound evict the two oldest entries.
  await start(m, '');
  await start(m, '');
  expect(released).toHaveBeenCalledWith(id);
  expect(released).toHaveBeenCalledWith(unreadId);
  await expect(poll(m, id)).rejects.toThrow('Unknown process id');
  await expect(poll(m, unreadId)).rejects.toThrow('Unknown process id');
  expect(m.backgroundState(new Set([unreadId]))).toEqual({ running: [], exitedUnread: [] });
}, 120000);

it('keeps benign exit classification, batch labels and numeric wait ids consistent', () => {
  const context: CallContext = { startedAt: 0, transportKey: null, agent: null, outcome: null,
    caller: { requestId: null, transportKey: null, conversationId: null }, evidence: emptyEvidence() };
  const command = "C:/tools/rg.exe needle file.txt | Select-Object -First 40";
  const benign = nonZeroExitIsBenign(command, 4294967295, 'needle\n');
  expect(benign).toBe(true);
  runInCallContext(context, () => noteExec({ exitCode: 4294967295, benignExit: benign, running: false }));
  const summary = summarizeToolCall({ tool: 'exec_command', args: { cmds: ['git diff', command] },
    evidence: context.evidence, outcome: context.outcome ?? 'ok', durationMs: 10 });
  expect(summary.tone).toBe('good'); expect(summary.title).toContain('2 commands: git diff');
  expect(summary.title).not.toContain('a command');
  for (const exitCode of [1, 2]) {
    const wait = summarizeToolCall({ tool: 'write_stdin', args: { session_id: 1234 },
      evidence: { ...emptyEvidence(), exitCode }, outcome: 'process_exit_nonzero', durationMs: 1 });
    expect(wait).toMatchObject({ title: 'Waited on session 1234', tone: 'bad', metric: `✕ exit ${exitCode}` });
  }
});

it('carries the same proven classification through asynchronous completion and rereads', async () => {
  const m = manager(), id = m.allocateProcessId();
  const first = await m.execCommand({ processId: id,
    command: [process.execPath, '-e', "setTimeout(()=>{ console.log('needle'); process.exitCode=1; },700)"],
    shellType: 'bash', hookCommand: 'reporting fixture', cwd: process.cwd(), displayCwd: '.', env: process.env,
    tty: false, yieldTimeMs: 250, maxOutputTokens: undefined, truncationPolicy: policy,
    classifyExit: (exit, output) => nonZeroExitIsBenign('C:/tools/rg.exe needle file | Select-Object -First 1', exit, output) });
  expect(first.processId).toBe(id);
  await expect(first.completion).resolves.toMatchObject({ exitCode: 1, benignExit: true });
  await expect(poll(m, id)).resolves.toMatchObject({ exitCode: 1, benignExit: true });
  const reread = await poll(m, id);
  expect(reread).toMatchObject({ exitCode: 1, benignExit: true, replayed: true });
  expect(execCommandStructuredOutput(reread)).toMatchObject({ exit_code: 1, benign_exit: true, output_replayed: true });
  const random = vi.spyOn(Math, 'random').mockReturnValueOnce((id - 1000) / 99000).mockReturnValueOnce(.99999);
  const next = m.allocateProcessId();
  expect(next).not.toBe(id);
  random.mockRestore();
  await m.terminateAllProcesses();
  await expect(poll(m, id)).rejects.toThrow('Unknown process id');
});
