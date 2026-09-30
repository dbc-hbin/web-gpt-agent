import { randomUUID } from 'node:crypto';
import { z } from 'zod';
import { promises as fs } from 'node:fs';
import path from 'node:path';
import { beforeAll, afterAll, afterEach, expect, it, vi } from 'vitest';
import { defaultConfig, getConfig, initConfigPath, saveConfig } from '../src/main/config.js';
import { initDurableStore, flushDurable, resetDurableForTests } from '../src/main/durable.js';
import { initSessionStore, createSession, getSession, readSessionPlan, readEvents, readOverflowText, rebindSession, appendEvent, observeSessionModel, resetSessionStoreForTests } from '../src/main/session/store.js';
import { closeCorrelationStore, observeRequestCorrelation } from '../src/main/session/correlation.js';
import { flushRecorder, recordChatObservations } from '../src/main/session/recorder.js';
import { cancelInput, enqueueInput, listInputs, resetInputForTests } from '../src/main/session/input.js';
import { setChatBlocked, resetBlockedChatsForTests } from '../src/main/session/blocked-chats.js';
import { startMcpServer, type McpEndpoint } from '../src/main/mcp/server.js';
import { currentCall } from '../src/main/mcp/call-context.js';
import type { ToolContext } from '../src/main/mcp/kernel.js';
import * as workRuntime from '../src/main/work/runtime.js';
import * as searchPages from '../src/main/search-pages.js';
import { SearchEngineFailureError } from '../src/main/search.js';
import { eventTokens } from '../src/shared/session.js';
import * as backend from '../src/main/codex/read-backend.js';
import { unifiedExecManager } from '../src/main/codex/manager.js';
import { noteExecOwner, forgetExecOwner } from '../src/main/codex/ownership.js';
import type { ExecCommandToolOutput } from '../src/main/codex/unified-exec.js';
import { makeTempDir, removeTempDir } from './helpers.js';

let directory: string, endpoint: McpEndpoint, ctx: ToolContext;
async function rpc(method: string, params: object, requestId?: string, surface: 'core' | 'desktop' = 'core'): Promise<any> {
  const response = await fetch(endpoint.urls[surface], { method: 'POST', headers: {
    'content-type': 'application/json', accept: 'application/json, text/event-stream',
    ...(requestId ? { 'x-request-id': `${requestId}/attempt` } : {})
  }, body: JSON.stringify({ jsonrpc: '2.0', id: randomUUID(), method, params }) });
  const raw = await response.text();
  return JSON.parse(raw.startsWith('{') ? raw : [...raw.matchAll(/^data: (.+)$/gm)].at(-1)![1]!);
}
async function identity() {
  const conversationId = randomUUID(), requestId = `wfr_${randomUUID().replaceAll('-', '')}`;
  const session = await createSession({ conversationId, title: 'Code mode integration' });
  expect(observeRequestCorrelation({ requestId, conversationId, sessionId: session.id, messageId: randomUUID(), tool: 'exec', observedAt: Date.now() })).toBe('stored');
  return { conversationId, requestId, session };
}
const call = (requestId: string | undefined, code: string) => rpc('tools/call', { name: 'exec', arguments: { code } }, requestId);
const childResultSchema = z.looseObject({ content: z.array(z.looseObject({ type: z.string(), text: z.string().optional() })), isError: z.boolean().optional(), structuredContent: z.record(z.string(), z.unknown()).optional() });
/** A nested Core call returns the tool's native value; this projects it back to the envelope shape
 * the assertions below were written against, so the test reads what a caller of that tool observes. */
function asChildResult(value: unknown): z.infer<typeof childResultSchema> {
  if (value && typeof value === 'object' && !Array.isArray(value) && Array.isArray((value as { content?: unknown }).content)) {
    return childResultSchema.parse(value);
  }
  if (typeof value === 'string') return { content: [{ type: 'text', text: value }] };
  if (value === undefined || value === null || (typeof value === 'object' && !Array.isArray(value) && Object.keys(value).length === 0)) {
    return { content: [] };
  }
  return { content: [{ type: 'text', text: JSON.stringify(value) }], structuredContent: value as Record<string, unknown> };
}
async function invokeChild(requestId: string | undefined, name: string, args: unknown) {
  const outer = await call(requestId,
    `let r;try{r=await tools[${JSON.stringify(name)}](${JSON.stringify(args)});}` +
    'catch(e){r={__thrown:String((e&&e.message)||e)};}text(JSON.stringify(r));');
  if (outer.result.isError) return { ...outer, outer };
  const emitted = outer.result.content.find((part: { type: string; text?: string }) => part.type === 'text');
  const raw = JSON.parse(emitted.text);
  const result = raw && typeof raw === 'object' && typeof raw.__thrown === 'string'
    ? { content: [{ type: 'text', text: raw.__thrown }], isError: true }
    : asChildResult(raw);
  return { ...outer, result, outer };
}
const text = (response: any) => response.result.content.filter((item: any) => item.type === 'text').map((item: any) => item.text).join('\n');
const emittedText = (response: any): string => response.result.content.find((item: any) => item.type === 'text')?.text ?? '';

it.each(['current', 'superseded'] as const)('resolves late session_finish identity before enforcing its %s owner', async state => {
  const conversationId = randomUUID(), requestId = `wfr_${randomUUID().replaceAll('-', '')}`;
  const session = await createSession({ conversationId, title: 'Late finish identity' });
  await appendEvent(session.id, { kind: 'turn_start', source: 'extension', turnId: randomUUID(), time: Date.now() });
  const input = await enqueueInput({ id: randomUUID(), sessionId: session.id, text: 'CONTINUE_AFTER_FINISH', mode: 'auto', dueAt: 0, model: null, reasoningEffort: null });
  if (state === 'superseded') expect(await rebindSession(session.id, conversationId, randomUUID())).toBe(true);
  const proof = setTimeout(() => {
    observeRequestCorrelation({ requestId, conversationId, sessionId: session.id, messageId: randomUUID(), tool: 'session_finish', observedAt: Date.now() });
  }, 40);
  try {
    const finish = await rpc('tools/call', { name: 'session_finish', arguments: { summary: 'checkpoint complete' } }, requestId);
    if (state === 'current') {
      expect(finish.result.isError, text(finish)).not.toBe(true);
      expect(text(finish)).toContain('HELD:');
      expect(text(finish)).toContain('CONTINUE_AFTER_FINISH');
    } else {
      expect(finish.result.isError).toBe(true);
      expect(text(finish)).toMatch(/superseded/i);
      expect(text(finish)).not.toContain('CONTINUE_AFTER_FINISH');
      expect((await listInputs()).find(row => row.id === input.id)?.state).toBe('queued');
    }
  } finally {
    clearTimeout(proof);
    await cancelInput(input.id);
  }
});

it('delivers one recovered-identity notice on the real structured MCP wire after a refused plan update', async () => {
  const config = getConfig();
  await saveConfig({ ...config, multiAgent: { ...config.multiAgent, allowUnattributedCalls: false } });
  const requestId = `wfr_${randomUUID().replaceAll('-', '')}`;
  const rejected = await invokeChild(requestId, 'update_plan', { plan: [{ step: 'Verify recovery', status: 'in_progress' }] });
  expect(rejected.result.isError).toBe(true);
  expect(text(rejected)).toContain('CALLER_IDENTITY_REQUIRED');
  const conversationId = randomUUID();
  const session = await createSession({ conversationId, title: 'Identity recovery wire' });
  observeRequestCorrelation({ requestId, conversationId, sessionId: session.id, messageId: randomUUID(), tool: 'exec', observedAt: Date.now() });
  vi.spyOn(unifiedExecManager, 'execCommand').mockResolvedValue({ chunkId: 'fixture', wallTimeMs: 1,
    rawOutput: Buffer.from('command output'), truncationPolicy: { kind: 'tokens', tokens: 1000 },
    maxOutputTokens: undefined, processId: null, exitCode: 0, originalTokenCount: 2, outputOmittedBytes: null });
  const send = () => invokeChild(requestId, 'exec_command', { cmd: 'echo fixture', workdir: '/workspace' });
  const recovered = await send();
  expect(recovered.result.isError, text(recovered)).not.toBe(true);
  expect(recovered.result.structuredContent.output).toBe('command output');
  expect(recovered.result.structuredContent).not.toHaveProperty('supplemental_context');
  expect(text(recovered.outer).match(/--- Identity recovered ---/g)).toHaveLength(1);
  expect(text((await send()).outer)).not.toContain('Identity recovered');
  const recorded = (await readEvents(session.id)).filter(event => event.kind === 'tool_call' && event.call.tool === 'exec');
  expect(JSON.stringify(recorded)).toContain('Identity recovered');
});

it('delivers complete multibyte structured text beyond the former default preview over HTTP', async () => {
  const response = await call(undefined, 'text({payload:"한".repeat(30000)});');
  expect(response.result.isError, text(response)).not.toBe(true);
  expect(JSON.parse(emittedText(response))).toEqual({ payload: '한'.repeat(30_000) });
});

it('honors a requested structured-text preview beyond the former maximum over HTTP', async () => {
  const response = await call(undefined, '// @exec: {"max_output_tokens": 300000}\ntext({payload:"한".repeat(200000)});');
  expect(response.result.isError, text(response)).not.toBe(true);
  expect(JSON.parse(emittedText(response))).toEqual({ payload: '한'.repeat(200_000) });
});

it('delivers complete Core output beyond the old four MiB preview over HTTP without an opt-in', async () => {
  const response = await call(undefined, 'text({payload:"한".repeat(1500000)});');
  expect(response.result.isError, text(response)).not.toBe(true);
  expect(JSON.parse(emittedText(response))).toEqual({ payload: '한'.repeat(1_500_000) });
});

it('does not clip the default Core exec_read response either', async () => {
  const response = await rpc('tools/call', { name: 'exec_read', arguments: { code: 'text("界".repeat(400000));' } });
  expect(response.result.isError, text(response)).not.toBe(true);
  expect(emittedText(response)).toBe('界'.repeat(400_000));
});

it('delivers Core emissions totaling more than twelve MiB in one HTTP response', async () => {
  const who = await identity();
  const response = await call(who.requestId, 'text("a".repeat(7340032)); text("b".repeat(7340032));');
  expect(response.result.isError, text(response).slice(-500)).not.toBe(true);
  const parts = response.result.content.filter((part: { type: string }) => part.type === 'text');
  expect(parts.map((part: { text: string }) => [part.text.length, part.text[0], part.text.at(-1)]))
    .toEqual([[7_340_032, 'a', 'a'], [7_340_032, 'b', 'b']]);
});

it('delivers a single Core text emission larger than twelve MiB', async () => {
  const response = await call(undefined, 'text("z".repeat(13631488));');
  expect(response.result.isError, text(response).slice(-500)).not.toBe(true);
  expect(response.result.content[0].text.length).toBe(13_631_488);
  expect(response.result.content[0].text.at(-1)).toBe('z');
});

it('delivers a large Core result through wait after the earlier response releases its emissions', async () => {
  const who = await identity();
  const entered = Promise.withResolvers<void>();
  const release = Promise.withResolvers<void>();
  const original = backend.readTextFile;
  vi.spyOn(backend, 'readTextFile').mockImplementationOnce(async (...args) => {
    entered.resolve();
    await release.promise;
    return original(...args);
  });
  try {
    const started = await rpc('tools/call', { name: 'exec_read', arguments: {
      code: 'text("first"); yield_control(); await tools.read({paths:["/workspace/alpha.txt"]}); text("a".repeat(7340032)); text("b".repeat(7340032));'
    } }, who.requestId);
    const cell = text(started).match(/Script running with cell ID ([0-9a-f-]+)/)?.[1];
    expect(cell).toBeTruthy();
    expect(started.result.content[0]).toMatchObject({ type: 'text', text: 'first' });
    await entered.promise;
    release.resolve();
    const resumed = await rpc('tools/call', { name: 'wait', arguments: { cell_id: cell } }, who.requestId);
    expect(resumed.result.isError).not.toBe(true);
    expect(resumed.result.content.map((part: { text: string }) => [part.text.length, part.text[0]]))
      .toEqual([[7_340_032, 'a'], [7_340_032, 'b']]);
  } finally { release.resolve(); }
});

it('records full explicitly emitted text without duplicating it onto an explicitly small MCP preview', async () => {
  const who = await identity();
  const tail = 'FULL_RECORDED_TAIL';
  const response = await call(who.requestId, `// @exec: {"max_output_tokens": 100000}\ntext("x".repeat(600000)+${JSON.stringify(tail)});`);
  expect(response.result.isError, text(response)).not.toBe(true);
  expect(text(response)).not.toContain(tail);

  const event = (await readEvents(who.session.id)).findLast(row => row.kind === 'tool_call' && row.call.tool === 'exec');
  if (!event || event.kind !== 'tool_call' || !event.call.result.assetId) throw new Error('missing exec overflow recording');
  expect(await readOverflowText(who.session.id, event.call.result.assetId)).toContain(tail);
});

it.each(['exec_command', 'write_stdin'] as const)('delivers terminal corrections through the actual %s structured wire without changing process output', async name => {
  const who = await identity();
  const processId = 739100;
  noteExecOwner(processId, who.session.id);
  const output: ExecCommandToolOutput = { chunkId: '623c3d', wallTimeMs: 30011.45, rawOutput: Buffer.from(''),
    truncationPolicy: { kind: 'tokens', tokens: 1000 }, maxOutputTokens: undefined, processId, exitCode: null,
    originalTokenCount: 0, outputOmittedBytes: null };
  const handler = name === 'exec_command' ? vi.spyOn(unifiedExecManager, 'execCommand') : vi.spyOn(unifiedExecManager, 'writeStdin');
  handler.mockResolvedValue(output);
  const args = name === 'exec_command' ? { cmd: 'echo fixture', workdir: '/workspace' } : { session_id: processId };
  const send = () => invokeChild(who.requestId, name, args);
  try {
    const plain = await send();
    expect(plain.result.isError).not.toBe(true);
    expect(plain.result.structuredContent).not.toHaveProperty('supplemental_context');
    const input = await enqueueInput({ id: randomUUID(), sessionId: who.session.id, text: 'ACK_G7391_CORRECTION', mode: 'auto', dueAt: 0, model: null, reasoningEffort: null });
    const response = await send();
    expect(response.result.isError).not.toBe(true);
    expect(response.result.structuredContent).toEqual(plain.result.structuredContent);
    expect(response.result.structuredContent.output).toBe('');
    expect(response.result.structuredContent.session_id).toBe(processId);
    expect(response.result.structuredContent).not.toHaveProperty('exit_code');
    expect(text(response.outer).match(/ACK_G7391_CORRECTION/g)).toHaveLength(1);
    expect((await listInputs()).find(row => row.id === input.id)?.state).toBe('tool');
    const receipt = await send();
    expect(receipt.result.structuredContent).toEqual(plain.result.structuredContent);
    expect(text(receipt.outer)).not.toContain('ACK_G7391_CORRECTION');
    expect((await listInputs()).find(row => row.id === input.id)?.state).toBe('sent');
    const invalid = await invokeChild(who.requestId, name, { ...args, unexpected: true });
    expect(invalid.result.isError).toBe(true);
    expect(invalid.result.structuredContent).toBeUndefined();
    expect(handler).toHaveBeenCalledTimes(3);
  } finally {
    await send(); // Settle any offered correction even when a regression assertion fails.
    for (const entry of await listInputs()) if (entry.sessionId === who.session.id) await cancelInput(entry.id);
    forgetExecOwner(processId);
  }
});

it('preserves a nonzero terminal exit and leaves nested correction delivery with the outer result', async () => {
  const who = await identity();
  vi.spyOn(unifiedExecManager, 'execCommand').mockResolvedValue({ chunkId: 'exit-seven', wallTimeMs: 2,
    rawOutput: Buffer.from('process failure'), truncationPolicy: { kind: 'tokens', tokens: 1000 },
    maxOutputTokens: undefined, processId: null, exitCode: 7, originalTokenCount: 2, outputOmittedBytes: null });
  await enqueueInput({ id: randomUUID(), sessionId: who.session.id, text: 'NONZERO_CORRECTION', mode: 'auto', dueAt: 0, model: null, reasoningEffort: null });
  const direct = await invokeChild(who.requestId, 'exec_command', { cmd: 'echo fixture', workdir: '/workspace' });
  expect(direct.result.structuredContent).toMatchObject({ exit_code: 7, output: 'process failure' });
  expect(text(direct.outer)).toContain('NONZERO_CORRECTION');
  expect(direct.result.structuredContent).not.toHaveProperty('session_id');
  await call(who.requestId, 'text("receipt")');
  await enqueueInput({ id: randomUUID(), sessionId: who.session.id, text: 'OUTER_ONLY_CORRECTION', mode: 'auto', dueAt: 0, model: null, reasoningEffort: null });
  const nested = await call(who.requestId, 'const child=await tools.exec_command({cmd:"echo fixture",workdir:"/workspace"});text(child);');
  const child = JSON.parse(nested.result.content[0].text);
  expect(child).toMatchObject({ exit_code: 7, output: 'process failure' });
  expect(child).not.toHaveProperty('supplemental_context');
  expect(text(nested).match(/OUTER_ONLY_CORRECTION/g)).toHaveLength(1);
  await call(who.requestId, 'text("receipt")');
});

it('projects corrections for other Core structured results without changing the empty worker family', async () => {
  const config = getConfig();
  await saveConfig({ ...config, multiAgent: { ...config.multiAgent, enabled: true } });
  const who = await identity();
  const status = () => rpc('tools/call', { name: 'agents', arguments: { action: 'status' } }, who.requestId);
  try {
    const before = await status();
    expect(before.result.isError).not.toBe(true);
    expect(before.result.structuredContent).toMatchObject({ action: 'status', run_id: null, self: null, agents: [] });
    await enqueueInput({ id: randomUUID(), sessionId: who.session.id, text: 'CORE_STATUS_CORRECTION', mode: 'auto', dueAt: 0, model: null, reasoningEffort: null });
    const delivered = await status();
    expect(delivered.result.structuredContent).toEqual({ ...before.result.structuredContent, supplemental_context: expect.stringContaining('CORE_STATUS_CORRECTION') });
    expect(text(delivered).match(/CORE_STATUS_CORRECTION/g)).toHaveLength(1);
    expect((await status()).result.structuredContent).toEqual(before.result.structuredContent);
  } finally {
    await status();
    await saveConfig(config);
  }
});

beforeAll(async () => {
  directory = await makeTempDir('clf-code-mode-mcp-');
  initConfigPath(directory); initDurableStore(directory); initSessionStore(directory); resetInputForTests();
  const config = defaultConfig();
  await saveConfig({ ...config, multiAgent: { ...config.multiAgent, enabled: false }, ui: { ...config.ui, finishTool: true } });
  await fs.writeFile(path.join(directory, 'alpha.txt'), 'alpha PRIVATE_ALPHA');
  await fs.writeFile(path.join(directory, 'beta.txt'), 'beta PRIVATE_BETA');
  ctx = { roots: [{ name: 'workspace', path: directory }], caps: config.capabilities, readOnly: false, sessionTools: true, agentTools: true };
  endpoint = await startMcpServer(() => ctx);
});
afterEach(async () => {
  vi.restoreAllMocks(); ctx.caps = defaultConfig().capabilities; ctx.roots = [{ name: 'workspace', path: directory }]; resetBlockedChatsForTests();
  const config = getConfig();
  await saveConfig({ ...config, multiAgent: { ...config.multiAgent, allowUnattributedCalls: true } });
});
afterAll(async () => {
  await endpoint.stop(); await unifiedExecManager.terminateAllProcesses(); await flushRecorder(); await flushDurable(); resetInputForTests(); resetSessionStoreForTests(); resetDurableForTests(); closeCorrelationStore(); await removeTempDir(directory);
});

it.each([
  { wrapper: 'exec_read', args: { cursor: 'invalid-search-cursor' }, code: 'SEARCH_CURSOR_INVALID' },
  { wrapper: 'exec', args: { path: '/workspace/alpha.txt', query: '(', mode: 'content', regex: true }, code: null }
])('records invalid search input as rejected through $wrapper', async ({ wrapper, args, code }) => {
  const who = await identity();
  const response = await rpc('tools/call', { name: wrapper, arguments: {
    code: `try { text(await tools.find(${JSON.stringify(args)})); } catch (e) { text(e.message); }`
  } }, who.requestId);
  const calls = (await readEvents(who.session.id)).filter(event => event.kind === 'tool_call');
  const child = calls.find(event => event.call.tool === 'find');
  expect(child?.call.outcome).toBe('tool_rejected');
  expect(text(response)).toBe(child?.call.result.text);
  if (code) expect(text(response)).toContain(code);
  expect(text(response)).not.toContain('Filesystem error');
  expect(text(response)).not.toContain(directory);
  expect(calls.find(event => event.call.tool === wrapper)?.call.outcome).toBe('ok');
});

it.each([
  new SearchEngineFailureError('ripgrep search failed (exit 2)'),
  new searchPages.SearchPageError('SEARCH_CURSOR_CORRUPT', 'retained page contains invalid JSON')
])('retains internal search failures as internal errors: %s', async error => {
  const who = await identity();
  vi.spyOn(searchPages, 'ordinarySearch').mockRejectedValueOnce(error);
  const response = await invokeChild(who.requestId, 'find', { path: '/workspace/alpha.txt', query: 'alpha', mode: 'content' });
  expect(response.result.isError).toBe(true);
  const calls = (await readEvents(who.session.id)).filter(event => event.kind === 'tool_call');
  expect(calls.find(event => event.call.tool === 'find')?.call.outcome).toBe('tool_internal_error');
});

it('publishes restricted Core read with native output and no Desktop leakage', async () => {
  const core = (await rpc('tools/list', {})).result.tools;
  const read = core.find((tool: { name: string }) => tool.name === 'exec_read');
  expect(read?.annotations).toMatchObject({ readOnlyHint: true, destructiveHint: false, idempotentHint: false, openWorldHint: false });
  expect(read?.inputSchema).toEqual(core.find((tool: { name: string }) => tool.name === 'exec')?.inputSchema);
  expect((await rpc('tools/list', {}, undefined, 'desktop')).result.tools.map((tool: { name: string }) => tool.name)).not.toContain('exec_read');
  const result = await rpc('tools/call', { name: 'exec_read', arguments: { code: 'text(ALL_TOOLS.map(t=>t.name));text(await tools.read({paths:["/workspace/alpha.txt"]}));' } });
  expect(result.result.isError, text(result)).not.toBe(true);
  expect(text(result)).toContain('PRIVATE_ALPHA');
  const names = JSON.parse(result.result.content[0].text) as string[];
  expect(names).toEqual(expect.arrayContaining(['read', 'find', 'view_image', 'work_resume', 'mcp_tools']));
  for (const name of ['exec_command', 'apply_patch', 'mcp_call', 'write_stdin']) expect(names).not.toContain(name);
});

it('pages ordinary find through both code wrappers with native JSON and owner-safe cursors', async () => {
  ctx.caps = { ...ctx.caps, search: true };
  const source = path.join(directory, 'find-page-fixture.txt');
  await fs.writeFile(source, Array.from({ length: 70 }, (_, i) => `find-needle-${i + 1}`).join('\n') + '\n');
  const who = await identity();
  const nested = async (wrapper: 'exec' | 'exec_read', args: Record<string, unknown>, requestId = who.requestId) => {
    const response = await rpc('tools/call', { name: wrapper, arguments: {
      code: `try{text(JSON.stringify(await tools.find(${JSON.stringify(args)})))}catch(e){text(JSON.stringify({error:String(e.message)}))}`
    } }, requestId);
    expect(response.result.isError, JSON.stringify(response.result)).not.toBe(true);
    return JSON.parse(response.result.content.find((part: { type: string; text?: string }) => part.type === 'text').text);
  };
  try {
    const first = await nested('exec_read', { query: 'find-needle', mode: 'content', path: '/workspace/find-page-fixture.txt', max_results: 50 });
    expect(first).toMatchObject({ page: { returned: 50, total_hits: 70 }, truncated: 'page', content_file_limit: expect.any(Number) });
    expect(first.hits[0]).toMatchObject({ path: '/workspace/find-page-fixture.txt', line: 1 });
    expect(first.next_cursor).toEqual(expect.any(String));
    await fs.writeFile(source, 'source changed after search\n');
    const second = await nested('exec', { cursor: first.next_cursor, max_results: 50 });
    expect(second).toMatchObject({ page: { returned: 20, total_hits: 70 }, next_cursor: null });
    expect(second.hits[0]).toMatchObject({ line: 51, text: 'find-needle-51' });
    expect(second.hits.at(-1)).toMatchObject({ line: 70, text: 'find-needle-70' });
    const other = await identity();
    expect(await nested('exec_read', { cursor: first.next_cursor }, other.requestId)).toMatchObject({ error: expect.stringContaining('SEARCH_CURSOR_INVALID') });
    ctx.roots = [];
    const revoked = await nested('exec_read', { cursor: first.next_cursor });
    expect(JSON.stringify(revoked)).not.toContain('find-needle-51');
    ctx.roots = [{ name: 'workspace', path: directory }];
    await fs.writeFile(source, 'clip-needle ' + 'x'.repeat(2000) + '\n');
    const clipped = await nested('exec_read', { query: 'clip-needle', mode: 'content', path: '/workspace/find-page-fixture.txt' });
    expect(clipped.hits[0]).toMatchObject({ clipped: true, line_chars: expect.any(Number) });
    expect(clipped.hits[0].text.length).toBeLessThan(2000);
    await endpoint.stop();
    endpoint = await startMcpServer(() => ctx);
    expect(await nested('exec_read', { cursor: first.next_cursor })).toMatchObject({
      error: expect.stringContaining('SEARCH_CURSOR_INVALID')
    });
  } finally {
    ctx.roots = [{ name: 'workspace', path: directory }];
    await fs.rm(source, { force: true });
  }
});

it('continues an ordinary cursor after exact owner proof enables managed context', async () => {
  ctx.caps = { ...ctx.caps, search: true };
  const source = path.join(directory, 'find-late-owner.txt');
  await fs.writeFile(source, Array.from({ length: 55 }, (_, i) => `late-needle-${i + 1}`).join('\n') + '\n');
  const who = await identity();
  const find = async (requestId: string, args: Record<string, unknown>) => {
    const response = await rpc('tools/call', { name: 'exec_read', arguments: {
      code: `try{text(JSON.stringify(await tools.find(${JSON.stringify(args)})))}catch(e){text(JSON.stringify({error:String(e.message)}))}`
    } }, requestId);
    expect(response.result.isError, JSON.stringify(response.result)).not.toBe(true);
    return JSON.parse(emittedText(response));
  };
  try {
    const first = await find(who.requestId, { query: 'late-needle', mode: 'content', path: '/workspace/find-late-owner.txt', max_results: 50 });
    expect(first).toMatchObject({ page: { returned: 50, total_hits: 55 }, next_cursor: expect.any(String) });
    const managedReader = vi.fn(async () => null);
    const managedContext: workRuntime.ManagedSearchContext = {
      owner: { workId: randomUUID(), agentId: randomUUID(), sessionId: who.session.id },
      worktreePath: '/workspace',
      artifacts: { getArtifact: managedReader, recordArtifact: vi.fn(), listArtifacts: vi.fn() }
    };
    const context = vi.spyOn(workRuntime, 'getManagedSearchContext').mockReturnValue(managedContext);
    const next = await find(who.requestId, { cursor: first.next_cursor, max_results: 50 });
    expect(context).toHaveBeenCalled();
    expect(next).toMatchObject({ page: { returned: 5, total_hits: 55 }, next_cursor: null });
    expect(next.hits[0]).toMatchObject({ line: 51, text: 'late-needle-51' });
    expect(managedReader).not.toHaveBeenCalled();
    const foreign = await identity();
    expect(await find(foreign.requestId, { cursor: first.next_cursor })).toMatchObject({ error: expect.stringContaining('SEARCH_CURSOR_INVALID') });
    expect(managedReader).not.toHaveBeenCalled();
  } finally {
    await fs.rm(source, { force: true });
  }
});

it('rejects dynamic mutation before side effects while ordinary exec retains command access', async () => {
  const patch = '*** Begin Patch\n*** Add File: /workspace/read-boundary-patch.txt\n+must not exist\n*** End Patch';
  const attempts = [
    ['exec_command', { cmd: 'touch read-boundary.txt', workdir: '/workspace' }],
    ['apply_patch', patch]
  ];
  const code = 'for(const [name,args] of '+JSON.stringify(attempts)+' ){try{await tools[name](args);text("unexpected:"+name)}catch(e){text(name+":"+String(e.message))}}';
  const rejected = await rpc('tools/call', { name: 'exec_read', arguments: { code } });
  expect(text(rejected)).not.toContain('unexpected:');
  for (const [name] of attempts) expect(text(rejected)).toContain(name + ':not a function');
  for (const file of ['read-boundary.txt', 'read-boundary-patch.txt']) {
    await expect(fs.stat(path.join(directory, file))).rejects.toMatchObject({ code: 'ENOENT' });
  }
  vi.spyOn(unifiedExecManager, 'execCommand').mockResolvedValue({ chunkId: 'fixture', wallTimeMs: 1,
    rawOutput: Buffer.from('writable'), truncationPolicy: { kind: 'tokens', tokens: 1000 },
    maxOutputTokens: undefined, processId: null, exitCode: 0, originalTokenCount: 1, outputOmittedBytes: null });
  const writable = await invokeChild(undefined, 'exec_command', { cmd: 'echo writable', workdir: '/workspace' });
  expect(writable.result.structuredContent.output).toBe('writable');
});

it('retains read scope after another exec and honors live permission revocation', async () => {
  const who = await identity();
  const entered = Promise.withResolvers<void>();
  const release = Promise.withResolvers<void>();
  const original = backend.readTextFile;
  vi.spyOn(backend, 'readTextFile').mockImplementationOnce(async (...args) => {
    entered.resolve();
    await release.promise;
    return original(...args);
  });
  try {
    const started = await rpc('tools/call', { name: 'exec_read', arguments: { code: 'yield_control();await tools.read({paths:["/workspace/alpha.txt"]});try{await tools.exec_command({cmd:"touch read-boundary.txt",workdir:"/workspace"});text("unexpected")}catch(e){text(String(e.message))}' } }, who.requestId);
    const cell = text(started).match(/Script running with cell ID ([0-9a-f-]+)/)?.[1];
    expect(cell, text(started)).toBeTruthy();
    await entered.promise;
    expect((await call(who.requestId, 'text(ALL_TOOLS.some(t=>t.name==="exec_command"));')).result.isError).not.toBe(true);
    release.resolve();
    const resumed = await rpc('tools/call', { name: 'wait', arguments: { cell_id: cell } }, who.requestId);
    expect(text(resumed)).toContain('not a function');
    expect(text(resumed)).not.toContain('unexpected');
  } finally { release.resolve(); }
  await expect(fs.stat(path.join(directory, 'read-boundary.txt'))).rejects.toMatchObject({ code: 'ENOENT' });
  ctx.caps = { ...ctx.caps, read: false, browse: false, metadata: false };
  const denied = await rpc('tools/call', { name: 'exec_read', arguments: { code: 'try{text(await tools.read({paths:["/workspace/alpha.txt"]}))}catch(e){text(String(e.message))}' } }, who.requestId);
  expect(text(denied)).not.toContain('PRIVATE_ALPHA');
  expect(text(denied)).toMatch(/TOOL_DISABLED|UNKNOWN_TOOL/);
  ctx.caps = defaultConfig().capabilities;
  const resume = await rpc('tools/call', { name: 'exec_read', arguments: { code: 'text(await tools.work_resume({}))' } }, who.requestId);
  expect(resume.result.isError).toBe(true);
  expect(text(resume)).toContain('WORK_SERVICE_UNAVAILABLE');
});

it('retires session lookup while recording messages, tools and the exact caller plan', async () => {
  const who = await identity();
  const names = (await rpc('tools/list', {})).result.tools.map((tool: any) => tool.name);
  expect(names).not.toContain('session');
  expect(names).not.toContain('update_plan');
  const observed = await recordChatObservations(who.conversationId, [
    { kind: 'user_message', time: Date.now(), messageId: randomUUID(), text: 'LOCAL_REQUEST' },
    { kind: 'assistant_message', time: Date.now(), messageId: randomUUID(), text: 'LOCAL_ANSWER' }
  ]);
  expect(observed.sessionId).toBe(who.session.id);
  expect(text(await call(who.requestId, 'text(ALL_TOOLS.map(tool => tool.name));'))).not.toContain('"session"');
  const stale = await rpc('tools/call', { name: 'session', arguments: { action: 'search' } }, who.requestId);
  expect(Boolean(stale.error || stale.result?.isError)).toBe(true);
  const nested = await call(who.requestId, 'text(await tools.session({action:"search"}));');
  expect(nested.result.isError).toBe(true);
  expect(text(nested)).not.toContain('LOCAL_REQUEST');
  const read = await invokeChild(who.requestId, 'read', { paths: ['/workspace/alpha.txt'] });
  expect(read.result.isError, text(read)).not.toBe(true);
  const plan = [{ step: 'Keep recording', status: 'completed' }];
  const updated = await invokeChild(who.requestId, 'update_plan', { plan });
  expect(updated.result.isError, text(updated)).not.toBe(true);
  expect((await readSessionPlan(who.session.id))?.plan).toEqual(plan);
  await flushRecorder();
  const events = await readEvents(who.session.id);
  expect(events.filter(event => event.kind === 'user_message').map(event => event.message.text)).toContain('LOCAL_REQUEST');
  expect(events.filter(event => event.kind === 'assistant_message').map(event => event.message.text)).toContain('LOCAL_ANSWER');
  const reads = events.filter(event => event.kind === 'tool_call' && event.call.tool === 'read');
  expect(reads).toHaveLength(1);
  expect(JSON.stringify(reads)).toContain('PRIVATE_ALPHA');
});

it('initializes, discovers and executes the actual model-facing MCP contract with parallel filtering and separate recorded children', async () => {
  await rpc('initialize', { protocolVersion: '2025-03-26', capabilities: {}, clientInfo: { name: 'code-mode-contract-test', version: '1' } });
  const declarations = (await rpc('tools/list', {})).result.tools;
  const exec = declarations.find((tool: any) => tool.name === 'exec');
  expect(exec.inputSchema.required).toEqual(['code']);
  expect(exec.inputSchema.additionalProperties).toBe(false);
  expect(declarations.some((tool: { name: string }) => tool.name === 'read')).toBe(false);
  const discovery = await rpc('tools/call', { name: 'tools_search', arguments: { names: ['read'] } });
  expect(JSON.parse(text(discovery)).tools[0].inputSchema.required).toContain('paths');
  const who = await identity();
  const original = backend.readTextFile;
  const contexts: Array<ReturnType<typeof currentCall>> = [];
  let entered = 0, release!: () => void;
  const both = new Promise<void>(done => { release = done; });
  vi.spyOn(backend, 'readTextFile').mockImplementation(async (...args) => {
    contexts.push(currentCall());
    if (++entered === 2) release();
    await both;
    return original(...args);
  });
  const response = await call(who.requestId, 'const r = await Promise.all(["alpha","beta"].map(n => tools.read({paths:["/workspace/"+n+".txt"]}))); text(r.map(x=>({ok:typeof x === "string", found:x.includes("PRIVATE")})));');
  expect(response.result.isError).not.toBe(true);
  expect(JSON.parse(text(response))).toEqual([{ ok: true, found: true }, { ok: true, found: true }]);
  expect(JSON.stringify(response)).not.toContain('PRIVATE');
  expect(contexts).toHaveLength(2);
  expect(contexts[0]).not.toBe(contexts[1]);
  expect(contexts[0]!.evidence).not.toBe(contexts[1]!.evidence);
  for (const context of contexts) expect(context!.caller).toMatchObject({ requestId: who.requestId, conversationId: who.conversationId, sessionId: who.session.id });
  const events = (await readEvents(who.session.id)).filter(event => event.kind === 'tool_call');
  expect(events.map(event => event.call.tool).sort()).toEqual(['exec', 'read', 'read']);
  expect(new Set(events.map(event => event.call.callId)).size).toBe(3);
  const children = events.filter(event => event.call.tool === 'read');
  expect(children.every(event => event.call.nested === true)).toBe(true);
  expect(children.map(eventTokens)).toEqual([0, 0]);
  const outer = events.find(event => event.call.tool === 'exec')!;
  expect(outer.call.nested).toBeUndefined();
  expect(eventTokens(outer)).toBeGreaterThan(0);
  expect(await getSession(who.session.id)).toMatchObject({
    estimatedTokens: eventTokens(outer), contextTokens: eventTokens(outer), toolCalls: 3
  });
  expect(JSON.stringify(events.filter(event => event.call.tool === 'read'))).toContain('PRIVATE_ALPHA');
  expect(JSON.stringify(events.filter(event => event.call.tool === 'exec'))).not.toContain('PRIVATE_ALPHA');
});

it('never pushes completed terminal output onto unrelated results, however they are filtered', async () => {
  const who = await identity();
  await fs.writeFile(path.join(directory, 'auto-result.cjs'), 'setTimeout(()=>{console.log("OUTER_AUTO_RESULT");process.exitCode=7},1000);');
  const command = process.platform === 'win32' ? 'node auto-result.cjs; exit $LASTEXITCODE' : 'node auto-result.cjs';
  const started = await call(who.requestId, `text(await tools.exec_command({cmd:${JSON.stringify(command)},workdir:"/workspace",yield_time_ms:25}));`);
  const id = Number(text(started).match(/"session_id":(\d+)/)?.[1]);
  expect(Number.isInteger(id), text(started)).toBe(true);
  await vi.waitFor(() => expect(unifiedExecManager.exitedUnread(new Set([id]))).toHaveLength(1), { timeout: 5_000 });
  const full = await call(who.requestId, 'text("x".repeat(39_900));');
  expect(Buffer.byteLength(text(full)), text(full).slice(0, 400)).toBe(39_900);
  expect(text(full)).not.toContain('OUTER_AUTO_RESULT');
  // Two unrelated reads in the same request get their own answers and nothing else — no retained
  // terminal text, no reminders, and the unread row is still waiting to be polled.
  const response = await call(who.requestId, 'await Promise.all([tools.read({paths:["/workspace/alpha.txt"]}),tools.read({paths:["/workspace/beta.txt"]})]); text("filtered children");');
  expect(text(response)).toContain('filtered children');
  expect(text(response)).not.toContain('OUTER_AUTO_RESULT');
  expect(text(response)).not.toContain('Background session');
  expect(text(response)).not.toContain('PRIVATE_ALPHA');
  expect(unifiedExecManager.exitedUnread(new Set([id]))).toHaveLength(1);
  // The exact poll is the lookup path, and it is what retires the row.
  const polled = await invokeChild(who.requestId, 'write_stdin', { session_id: id, chars: '' });
  expect(polled.result.isError, text(polled.outer)).not.toBe(true);
  expect(text(polled.outer)).toContain('OUTER_AUTO_RESULT');
  expect(unifiedExecManager.exitedUnread(new Set([id]))).toEqual([]);
});

it('rejects missing proof, foreign tools, invalid child arguments and nested lifecycle calls', async () => {
  const config = getConfig();
  await saveConfig({ ...config, multiAgent: { ...config.multiAgent, allowUnattributedCalls: false } });
  // Code mode itself needs no proven caller; the plan below still does, because a plan belongs to
  // one chat. A headerless call therefore runs JavaScript and is refused only by that child.
  expect(text(await call(undefined, 'text("SHOULD_NOT_RUN")'))).toContain('SHOULD_NOT_RUN');
  const who = await identity();
  expect(text(await call(who.requestId, 'text(typeof tools.exec)'))).toBe('undefined');
  expect(text(await call(who.requestId, 'text(await tools.read({paths:1}))'))).toContain('INVALID_ARGUMENTS');
  expect((await call(who.requestId, 'text(await tools.session_finish({summary:"done"}))')).result.isError).toBe(true);
  expect((await call(who.requestId, 'text(await tools.agents({action:"finish",summary:"done"}))')).result.isError).toBe(true);
});

it('allows unattributed file edits through code mode while preserving permissions and chat-owned operations', async () => {
  const patch = '*** Begin Patch\n*** Add File: /workspace/unattributed.txt\n+created anonymously\n*** End Patch';
  const response = await call(undefined, `text(await tools.apply_patch(${JSON.stringify(patch)}));`);
  expect(response.result.isError, text(response)).not.toBe(true);
  // A successful Core patch resolves to `{}`, the pinned upstream code-mode conversion.
  expect(emittedText(response)).toBe('{}');
  expect(await fs.readFile(path.join(directory, 'unattributed.txt'), 'utf8')).toBe('created anonymously\n');
  const read = await call(`wfr_${randomUUID().replaceAll('-', '')}`, 'text(await tools.read({paths:["/workspace/unattributed.txt"]}));');
  expect(text(read)).toContain('created anonymously');
  const edit = '*** Begin Patch\n*** Update File: /workspace/unattributed.txt\n@@\n-created anonymously\n+edited anonymously\n*** End Patch';
  const edited = await call(undefined, `text(await tools.apply_patch(${JSON.stringify(edit)}));`);
  expect(edited.result.isError, text(edited)).not.toBe(true);
  expect(emittedText(edited)).toBe('{}');
  expect(await fs.readFile(path.join(directory, 'unattributed.txt'), 'utf8')).toBe('edited anonymously\n');
  ctx.caps = { ...ctx.caps, edit: false };
  const deniedPatch = edit.replace('-created anonymously', '-edited anonymously').replace('+edited anonymously', '+must not change');
  const denied = await call(undefined, `text(await tools.apply_patch(${JSON.stringify(deniedPatch)}));`);
  // A refused Core patch throws, so the script ends with the tool's own refusal text.
  expect(denied.result.isError).toBe(true);
  expect(text(denied)).toContain('Edit files is disabled');
  expect(await fs.readFile(path.join(directory, 'unattributed.txt'), 'utf8')).toBe('edited anonymously\n');
  const planRequest = `wfr_${randomUUID().replaceAll('-', '')}`;
  const plan = await call(planRequest, 'text(await tools.update_plan({plan:[{step:"Anonymous plan",status:"in_progress"}]}));');
  expect(plan.result.isError, text(plan)).not.toBe(true);
  expect(text(plan)).toContain('will attach when its chat identity arrives');
  const planConversation = randomUUID();
  const planSession = await createSession({ conversationId: planConversation, title: 'Request plan owner' });
  expect(observeRequestCorrelation({ requestId: planRequest, conversationId: planConversation, sessionId: planSession.id,
    messageId: randomUUID(), tool: 'update_plan', observedAt: Date.now() })).toBe('stored');
  await vi.waitFor(async () => expect((await readSessionPlan(planSession.id))?.plan)
    .toEqual([{ step: 'Anonymous plan', status: 'in_progress' }]), { timeout: 2_000 });
  const finish = await rpc('tools/call', { name: 'session_finish', arguments: { summary: 'done' } });
  expect(finish.result.isError).toBe(true);
  expect(text(finish)).toContain('Exact session identity');
  const config = getConfig();
  try {
    await saveConfig({ ...config, multiAgent: { ...config.multiAgent, enabled: true } });
    const spawn = await rpc('tools/call', { name: 'agents', arguments: { action: 'spawn', workers: [{ task: 'Must never start' }] } });
    expect(spawn.result.isError).toBe(true);
    expect(text(spawn)).toContain('UNIDENTIFIED_CALLER');
  } finally {
    await saveConfig(config);
  }
});

it('rechecks live permissions and approved roots between awaited children', async () => {
  const original = backend.readTextFile;
  for (const revoke of [() => { ctx.caps = { ...ctx.caps, read: false }; }, () => { ctx.roots = []; }]) {
    const who = await identity();
    ctx.caps = defaultConfig().capabilities; ctx.roots = [{ name: 'workspace', path: directory }];
    vi.spyOn(backend, 'readTextFile').mockImplementationOnce(async (...args) => { const result = await original(...args); revoke(); return result; });
    const response = await call(who.requestId, 'await tools.read({paths:["/workspace/alpha.txt"]}); text(await tools.read({paths:["/workspace/beta.txt"]}));');
    expect(text(response)).not.toContain('PRIVATE_BETA');
    vi.restoreAllMocks();
  }
});

it('rechecks a block or superseded chat before the next nested action', async () => {
  const original = backend.readTextFile;
  for (const superseded of [false, true]) {
    const who = await identity();
    vi.spyOn(backend, 'readTextFile').mockImplementationOnce(async (...args) => {
      const result = await original(...args);
      if (superseded) expect(await rebindSession(who.session.id, who.conversationId, randomUUID())).toBe(true);
      else setChatBlocked(who.conversationId, true);
      return result;
    });
    const response = await call(who.requestId, 'await tools.read({paths:["/workspace/alpha.txt"]}); text(await tools.read({paths:["/workspace/beta.txt"]}));');
    // The cell itself is stopped at the liveness gate before the next child is admitted, so the
    // second read never runs and the outer result carries the interruption, not the child's refusal.
    expect(response.result.isError).toBe(true);
    expect(text(response)).toMatch(/CODE_MODE_(INTERRUPTED|OWNER_INACTIVE)/);
    expect(text(response)).not.toContain('PRIVATE_BETA');
    vi.restoreAllMocks(); resetBlockedChatsForTests();
  }
});

it('keeps simultaneous chats separate and delivers queued input once outside script filtering', async () => {
  const a = await identity(), b = await identity();
  await observeSessionModel(a.session.id, a.conversationId, 'gpt-6-astra', Date.now());
  await appendEvent(a.session.id, { kind: 'turn_start', source: 'extension', turnId: randomUUID(), time: Date.now() });
  const input = await enqueueInput({ id: randomUUID(), sessionId: a.session.id, text: 'PRIVATE_USER_INSTRUCTION', mode: 'auto', dueAt: 0, model: null, reasoningEffort: null });
  const original = backend.readTextFile;
  const observed: string[] = [];
  vi.spyOn(backend, 'readTextFile').mockImplementation(async (...args) => {
    observed.push(currentCall()!.caller.sessionId!);
    return original(...args);
  });
  // Each script keeps its own two children, and the queued instruction is delivered to the outer
  // result only: it never becomes part of a nested child's own value.
  const script = 'const r=[await tools.read({paths:["/workspace/alpha.txt"]}),await tools.read({paths:["/workspace/beta.txt"]})];text(JSON.stringify(r));text("filtered");';
  const [ra, rb] = await Promise.all([a, b].map(who => call(who.requestId, script)));
  expect(observed.filter(id => id === a.session.id)).toHaveLength(2);
  expect(observed.filter(id => id === b.session.id)).toHaveLength(2);
  expect(emittedText(ra)).not.toContain('PRIVATE_USER_INSTRUCTION');
  expect(emittedText(rb)).not.toContain('PRIVATE_USER_INSTRUCTION');
  expect(text(ra).match(/PRIVATE_USER_INSTRUCTION/g)).toHaveLength(1);
  expect(text(rb)).not.toContain('PRIVATE_USER_INSTRUCTION');
  expect((await listInputs()).find(row => row.id === input.id)?.state).toBe('tool');
  vi.restoreAllMocks();
  const receipt = await call(a.requestId, 'text("received")');
  expect(text(receipt)).not.toContain('PRIVATE_USER_INSTRUCTION');
  expect((await listInputs()).find(row => row.id === input.id)?.state).toBe('sent');
});

it('uses existing process custody for nested exec and write_stdin across a conversation rebind', async () => {
  const a = await identity(), stranger = await identity();
  await fs.writeFile(path.join(directory, 'owned.cjs'), 'process.stdin.once("data",()=>{console.log("OWNED_RESULT");process.exit(0)});');
  const started = await call(a.requestId, 'text(await tools.exec_command({cmd:"node owned.cjs",workdir:"/workspace",tty:true,yield_time_ms:25}));');
  const processId = Number(text(started).match(/"session_id":(\d+)/)?.[1]);
  expect(Number.isInteger(processId), text(started)).toBe(true);
  const denied = await call(stranger.requestId, `text(await tools.write_stdin({session_id:${processId},chars:"stolen\\r",yield_time_ms:50}));`);
  expect(text(denied)).toContain('EXEC_SESSION_OWNER_MISMATCH');
  const replacement = randomUUID(), requestId = `wfr_${randomUUID().replaceAll('-', '')}`;
  expect(await rebindSession(a.session.id, a.conversationId, replacement)).toBe(true);
  observeRequestCorrelation({ requestId, conversationId: replacement, sessionId: a.session.id, messageId: randomUUID(), tool: 'exec', observedAt: Date.now() });
  const continued = await call(requestId, `text(await tools.write_stdin({session_id:${processId},chars:"owner\\r",yield_time_ms:1000}));`);
  expect(text(continued)).toContain('OWNED_RESULT');
});
