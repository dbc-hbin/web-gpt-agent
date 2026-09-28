/**
 * Coding from a conversation this app cannot place at all.
 *
 * The scenario is the one the connector has to survive: no durable session, no request-id header,
 * no browser page and no work binding — the companion bridge is deliberately closed, and there is
 * no conversation metadata to project. Every one of those facts used to make the coding tools
 * refuse with `WORKER_CONNECTION_REQUIRED`. They must not: a read, a command and a patch run
 * under the caller's existing permissions and the approved-root sandbox, and a path outside those
 * roots is still refused.
 *
 * Nothing here is mocked except the browser, which is simply absent — there is no page to fake.
 */

import { randomUUID } from 'node:crypto';
import { promises as fs } from 'node:fs';
import path from 'node:path';
import { afterAll, beforeAll, expect, it } from 'vitest';
import { defaultConfig, initConfigPath, saveConfig } from '../src/main/config.js';
import { flushDurable, initDurableStore, resetDurableForTests } from '../src/main/durable.js';
import { initSessionStore, resetSessionStoreForTests } from '../src/main/session/store.js';
import { flushRecorder } from '../src/main/session/recorder.js';
import { resetCorrelationRegistryForTests } from '../src/main/session/correlation.js';
import { startMcpServer, type McpEndpoint } from '../src/main/mcp/server.js';
import type { ToolContext } from '../src/main/mcp/kernel.js';
import { makeTempDir, removeTempDir } from './helpers.js';

let base: string, approved: string, outside: string, endpoint: McpEndpoint, ctx: ToolContext;

beforeAll(async () => {
  base = await makeTempDir('wgpt-session-independent-');
  approved = path.join(base, 'workspace');
  outside = path.join(base, 'private');
  await fs.mkdir(approved, { recursive: true });
  await fs.mkdir(outside, { recursive: true });
  await fs.writeFile(path.join(approved, 'seed.txt'), 'seeded\n', 'utf8');
  await fs.writeFile(path.join(outside, 'secret.txt'), 'hunter2\n', 'utf8');
  initConfigPath(base);
  initDurableStore(base);
  initSessionStore(base);
  const config = defaultConfig();
  // The strictest setting: the legacy "allow unattributed calls" opt-in is OFF, so nothing here
  // depends on it. Independence from conversation metadata is the contract, not a relaxation.
  await saveConfig({ ...config, multiAgent: { ...config.multiAgent, enabled: false, allowUnattributedCalls: false } });
  ctx = {
    roots: [{ name: 'workspace', path: approved }],
    caps: { ...config.capabilities, read: true, browse: true, create: true, edit: true, command: true },
    readOnly: false,
    sessionTools: false,
    agentTools: false
  };
  endpoint = await startMcpServer(() => ctx);
});

afterAll(async () => {
  await endpoint.stop();
  await flushRecorder();
  await flushDurable();
  resetSessionStoreForTests();
  resetDurableForTests();
  await removeTempDir(base);
});

type Reply = { text: string; isError: boolean; child: Record<string, unknown> | null };

/**
 * One `exec` call with no request-id header, no session and no correlation evidence of any kind,
 * whose nested child is the tool under test. Core publishes code mode, so this is how a real
 * client reaches `read`/`exec_command`/`apply_patch`.
 */
async function call(name: string, args: unknown): Promise<Reply> {
  const code = `const r = await tools[${JSON.stringify(name)}](${JSON.stringify(args)}); text(r);`;
  const response = await fetch(endpoint.urls.core, {
    method: 'POST',
    headers: { 'content-type': 'application/json', accept: 'application/json, text/event-stream' },
    body: JSON.stringify({ jsonrpc: '2.0', id: randomUUID(), method: 'tools/call', params: { name: 'exec', arguments: { code } } })
  });
  const raw = await response.text();
  const body = JSON.parse(raw.startsWith('{') ? raw : [...raw.matchAll(/^data: (.+)$/gm)].at(-1)![1]!);
  const outer = body.result as { content: Array<{ type: string; text?: string }>; isError?: boolean };
  const outerText = outer.content.filter((part) => part.type === 'text').map((part) => part.text ?? '').join('\n');
  const emitted = outer.content.find((part) => part.type === 'text' && (part.text ?? '').startsWith('{'));
  const child = emitted ? JSON.parse(emitted.text!) as Record<string, unknown> : null;
  return {
    text: outerText,
    isError: outer.isError === true,
    child
  };
}

it('reads a file from an unplaceable caller', async () => {
  resetCorrelationRegistryForTests();
  const reply = await call('read', { paths: ['/workspace/seed.txt'] });
  expect(reply.isError, reply.text).toBe(false);
  expect(reply.text).toContain('seeded');
  // No identity prose on the response: attribution is a recorder fact, not an answer.
  expect(reply.text).not.toContain('Identity notice');
  expect(reply.text).not.toContain('WORKER_CONNECTION_REQUIRED');
});

it('runs a real command in an explicit workdir from that same caller', async () => {
  resetCorrelationRegistryForTests();
  const command = process.platform === 'win32' ? 'echo ran-from-shell' : 'printf ran-from-shell';
  const reply = await call('exec_command', { cmd: command, workdir: '/workspace', yield_time_ms: 5_000 });
  expect(reply.isError, reply.text).toBe(false);
  expect(reply.child?.output).toContain('ran-from-shell');
  expect(reply.text).not.toContain('WORKER_CONNECTION_REQUIRED');
});

it('applies a real patch, then shows the file on disk', async () => {
  resetCorrelationRegistryForTests();
  const patch = ['*** Begin Patch', '*** Add File: /workspace/created.txt', '+created by an unplaceable caller', '*** End Patch'].join('\n');
  const reply = await call('apply_patch', patch);
  expect(reply.isError, reply.text).toBe(false);
  expect(await fs.readFile(path.join(approved, 'created.txt'), 'utf8')).toBe('created by an unplaceable caller\n');
});

it('still refuses a path outside every approved folder', async () => {
  resetCorrelationRegistryForTests();
  const reply = await call('read', { paths: [path.join(outside, 'secret.txt')] });
  expect(reply.isError).toBe(true);
  expect(reply.text).not.toContain('hunter2');
  expect(reply.text).toContain('Approved roots');
  const patched = await call('apply_patch', ['*** Begin Patch', '*** Add File: /workspace/../private/planted.txt', '+x', '*** End Patch'].join('\n'));
  expect(patched.isError).toBe(true);
  await expect(fs.stat(path.join(outside, 'planted.txt'))).rejects.toMatchObject({ code: 'ENOENT' });
});
