/**
 * The exec output budget as it survives the real handler wiring, over `tools/call`.
 *
 * `exec-output-budget.test.ts` pins the formatter, but it builds its own `ExecCommandToolOutput`
 * and therefore chooses the policy itself. That cannot see which constant `tools-core` actually
 * hands the process manager.
 *
 * This goes through the server the connector really serves so handler wiring cannot silently drop
 * `max_output_tokens`: the default must retain a 200 KB result, while an explicit smaller budget
 * must produce an honestly marked bounded result.
 */

import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, expect, it } from 'vitest';
import { z } from 'zod';
import { defaultConfig, initConfigPath, saveConfig } from '../src/main/config.js';
import { flushDurable, initDurableStore, resetDurableForTests } from '../src/main/durable.js';
import { startMcpServer, type McpEndpoint } from '../src/main/mcp/server.js';
import { validateNewRoot } from '../src/main/sandbox.js';
import { flushRecorder, resetRecorderForTests } from '../src/main/session/recorder.js';
import { flushSessions, initSessionStore, resetSessionStoreForTests, unsetSessionRootForTests } from '../src/main/session/store.js';
import { removeTempDir } from './helpers.js';

/** Bytes the probe command writes to stdout. Comfortably past both budgets under test. */
const PROBE_BYTES = 200_000;

/**
 * Read a deterministic fixture from the approved workdir. This test is about retained output,
 * not shell formatting limits or setup-node discovery. macOS' shell printf rejects very large
 * field widths on some hosted images, while the same command succeeds under GNU/bash; letting
 * that platform detail decide whether the MCP call is an error defeats the purpose of the test.
 */
const PROBE_FILE = 'budget-output.txt';
const PROBE_CMD = process.platform === 'win32'
  ? `Get-Content -Raw -LiteralPath '${PROBE_FILE}'`
  : `cat '${PROBE_FILE}'`;

let dir = '';
let endpoint: McpEndpoint | null = null;

afterEach(async () => {
  if (endpoint) await endpoint.stop().catch(() => undefined);
  endpoint = null;
  // HTTP completion precedes asynchronous recorder publication. Join its writes
  // before forgetting their queues or deleting the directory they still own.
  await flushRecorder();
  await Promise.all([flushSessions(), flushDurable()]);
  resetRecorderForTests();
  resetSessionStoreForTests();
  unsetSessionRootForTests();
  resetDurableForTests();
  if (dir) await removeTempDir(dir);
  dir = '';
});

async function serve(): Promise<McpEndpoint> {
  // The real roots:add path persists validateNewRoot()'s canonical spelling. Hosted macOS
  // exposes temp paths through /var while realpath resolves them under /private/var, and some
  // Windows runners likewise expose temp directories through a redirected path. Injecting the
  // raw mkdtemp spelling here therefore creates a root production would never persist and makes
  // the sandbox correctly reject it as changed on disk before exec_command can test anything.
  dir = await validateNewRoot(await fs.mkdtemp(path.join(os.tmpdir(), 'clf-budget-')), []);
  await fs.writeFile(path.join(dir, PROBE_FILE), 'probe-head\n' + 'x'.repeat(PROBE_BYTES) + '\nprobe-tail', 'utf8');
  initConfigPath(dir);
  initSessionStore(dir);
  initDurableStore(dir);
  const cfg = defaultConfig();
  await saveConfig({ ...cfg, roots: [{ name: 'probe', path: dir }], readOnly: false });
  return startMcpServer(() => ({
    roots: [{ name: 'probe', path: dir }],
    caps: cfg.capabilities,
    readOnly: false,
    sessionTools: false,
    agentTools: false
  }));
}

/**
 * The server answers `tools/call` as a single Streamable HTTP SSE frame, so the JSON-RPC body
 * arrives in `data:` lines rather than as the whole response. Per the SSE spec several data lines
 * in one frame join with newlines.
 */
function sseJson(body: string): unknown {
  const data = body
    .split(/\r?\n/)
    .filter((line) => line.startsWith('data:'))
    .map((line) => line.slice('data:'.length).trimStart())
    .join('\n');
  return JSON.parse(data === '' ? body : data);
}

interface ExecSummary { head: string; tail: string; length: number; exitCode: number }

/** A bounded summary computed from the native terminal result inside code mode. */
async function execOutput(
  url: string,
  maxOutputTokens: number | undefined,
  viaWriteStdin = false
): Promise<ExecSummary> {
  const response = await fetch(url, {
    method: 'POST',
    headers: { 'content-type': 'application/json', accept: 'application/json, text/event-stream' },
    body: JSON.stringify({
      jsonrpc: '2.0',
      id: 1,
      method: 'tools/call',
      params: { name: 'exec', arguments: { code: viaWriteStdin
        ? `const first=await tools.exec_command(${JSON.stringify({cmd:PROBE_CMD,workdir:'/probe'})});const r=await tools.write_stdin({session_id:first.completed_session_id,max_output_tokens:${maxOutputTokens}});text({head:r.output.slice(0,1000),tail:r.output.slice(-1000).trimEnd(),length:r.output.length,exitCode:r.exit_code});`
        : `const r=await tools.exec_command(${JSON.stringify({cmd:PROBE_CMD,workdir:'/probe',...(maxOutputTokens === undefined ? {} : {max_output_tokens:maxOutputTokens})})});text({head:r.output.slice(0,1000),tail:r.output.slice(-1000).trimEnd(),length:r.output.length,exitCode:r.exit_code});` } }
    })
  });
  expect(response.status).toBe(200);
  const body = sseJson(await response.text()) as {
    result?: { content?: Array<{ type: string; text?: string }>; isError?: boolean };
  };
  const text = body.result?.content?.find((part) => part.type === 'text')?.text ?? '';
  expect(body.result?.isError ?? false, text).toBe(false);
  const summary = JSON.parse(text) as ExecSummary;
  expect(summary.exitCode).toBe(0);
  expect(summary.head).toContain('probe-head');
  expect(summary.tail).toContain('probe-tail');
  return summary;
}

it('retains partial-batch diagnostics in native code-mode output', async () => {
  endpoint = await serve();
  const cmds = process.platform === 'win32'
    ? ['Write-Output batch-success', 'Write-Output batch-failure; cmd /c exit 7']
    : ['printf batch-success', "printf batch-failure; sh -c 'exit 7'"];
  const response = await fetch(endpoint.url, {
    method: 'POST',
    headers: { 'content-type': 'application/json', accept: 'application/json, text/event-stream' },
    body: JSON.stringify({
      jsonrpc: '2.0', id: 1, method: 'tools/call',
      params: { name: 'exec', arguments: { code:
        `const r=await tools.exec_command(${JSON.stringify({cmds,workdir:'/probe',login:false})});text(r);`
      } }
    })
  });
  expect(response.status).toBe(200);
  const result = z.object({ result: z.object({
    content: z.array(z.object({ type: z.string(), text: z.string().optional() })),
    isError: z.boolean().optional()
  }) }).parse(sseJson(await response.text())).result;
  const text = result.content.find(part => part.type === 'text')?.text ?? '';
  expect(result.isError, text).not.toBe(true);
  const native = z.object({ exit_code: z.number(), output: z.string() }).catchall(z.unknown()).parse(JSON.parse(text));
  expect(native.exit_code).toBe(7);
  expect(native).not.toHaveProperty('content');
  expect(native.output).toContain('batch-success');
  expect(native.output).toContain('batch-failure');
  expect(native.output).toContain('Batch: command 2 exited 7; the other command exited 0.');
  expect(native.output.match(/Note: Batch:/g)).toHaveLength(1);
  expect(native.output.match(/batch-success/g)).toHaveLength(1);
}, 30_000);

it('honours the default and an explicit smaller terminal output budget through MCP', async () => {
  endpoint = await serve();

  const omitted = await execOutput(endpoint.url, undefined);
  const requested = await execOutput(endpoint.url, 1_024);
  const reread = await execOutput(endpoint.url, 1_024, true);

  expect(omitted.length).toBeGreaterThan(PROBE_BYTES);
  for (const bounded of [requested, reread]) {
    expect(bounded.length).toBeLessThan(10_000);
    expect(bounded.head).toContain('Warning: truncated output');
  }
}, 30_000);

it('honours larger and smaller budgets for intercepted patch results without losing file receipts', async () => {
  endpoint = await serve();
  const names = Array.from({ length: 4000 }, (_, index) => `${String(index).padStart(4, '0')}-${'p'.repeat(72)}.txt`);

  const outputs: string[] = [];
  for (const maxOutputTokens of [100_000, 1024]) {
    const response = await fetch(endpoint.url, {
      method: 'POST',
      headers: { 'content-type': 'application/json', accept: 'application/json, text/event-stream' },
      body: JSON.stringify({
        jsonrpc: '2.0', id: 1, method: 'tools/call',
        params: { name: 'exec', arguments: { code:
          `const patch='*** Begin Patch\\n'+Array.from({length:4000},(_,i)=>'*** Add File: files/'+String(i).padStart(4,'0')+'-'+ 'p'.repeat(72)+'.txt\\n+x\\n').join('')+'*** End Patch';text(await tools.exec_command({cmd:"apply_patch <<'PATCH'\\n"+patch+"\\nPATCH",workdir:'/probe',login:false,max_output_tokens:${maxOutputTokens}}));`
        } }
      })
    });
    expect(response.status).toBe(200);
    const result = z.object({ result: z.object({
      content: z.array(z.object({ type: z.string(), text: z.string().optional() })),
      isError: z.boolean().optional()
    }) }).parse(sseJson(await response.text())).result;
    expect(result.isError, JSON.stringify(result.content)).not.toBe(true);
    const text = result.content.find(part => part.type === 'text')?.text ?? '';
    outputs.push(z.object({ output: z.string() }).parse(JSON.parse(text)).output);
  }
  const [full, bounded] = outputs;
  expect(full).toContain(names.map(name => `A files/${name}\n`).join(''));
  expect(Buffer.byteLength(full!)).toBeLessThan(400_000);
  expect(Buffer.byteLength(bounded!)).toBeLessThan(5000);
  expect(bounded).toContain(names[0]);
  expect(bounded).toContain(names.at(-1));
  expect(bounded).not.toContain(names[2000]);
  expect(await fs.readFile(path.join(dir, 'files', names[2000]!), 'utf8')).toBe('x\n');
}, 30_000);
