/**
 * The standalone daemon runtime, against its own real endpoint.
 *
 * This is the contract the whole feature rests on: a plain Node process that owns a data
 * directory, publishes an authenticated MCP endpoint, serves the coding tools over it, and gives
 * that directory back when it stops. Nothing here is mocked — the runtime starts the same
 * listener the desktop app starts, and the calls below are the same JSON-RPC ChatGPT sends.
 *
 * Two properties are asserted beyond "a tool answered":
 *
 *  - **The sandbox is the same one.** An approved root reads and patches; a path outside every
 *    root is refused by name. A daemon must not be a way around the app's own permission model.
 *  - **The Desktop surface is honestly empty.** Its capabilities are masked, so its tools are
 *    absent from discovery rather than present and failing — no browser is paired to this process
 *    and no native backend belongs to it.
 */

import { randomUUID } from 'node:crypto';
import { promises as fs } from 'node:fs';
import net from 'node:net';
import path from 'node:path';
import { afterEach, expect, it } from 'vitest';
import { defaultConfig } from '../src/main/config.js';
import { startDaemonRuntime, DAEMON_LOCK_FILE, type DaemonRuntimeHandle } from '../src/daemon/runtime.js';
import { acquireDataDirLock } from '../src/main/data-dir-lock.js';
import { makeTempDir, removeTempDir } from './helpers.js';

const cleanups: Array<() => Promise<void>> = [];
afterEach(async () => {
  for (const cleanup of cleanups.splice(0)) await cleanup().catch(() => undefined);
});

/** A data directory with one approved root and every coding permission granted. */
async function fixture(): Promise<{ dataDir: string; workspace: string; outside: string }> {
  const base = await makeTempDir('wgpt-daemon-');
  const dataDir = path.join(base, 'data');
  const workspace = path.join(base, 'workspace');
  const outside = path.join(base, 'outside');
  await fs.mkdir(workspace, { recursive: true });
  await fs.mkdir(outside, { recursive: true });
  await fs.writeFile(path.join(workspace, 'seed.txt'), 'seeded by the daemon fixture\n', 'utf8');
  await fs.writeFile(path.join(outside, 'secret.txt'), 'not for the model\n', 'utf8');
  await fs.mkdir(dataDir, { recursive: true });
  const config = defaultConfig();
  await fs.writeFile(
    path.join(dataDir, 'config.json'),
    JSON.stringify({
      ...config,
      // `fs.realpath` because the sandbox compares canonical paths, and macOS temp directories
      // are reached through a symlinked `/var` -> `/private/var`.
      roots: [{ name: 'workspace', path: await fs.realpath(workspace) }],
      capabilities: { ...config.capabilities, read: true, browse: true, search: true, metadata: true, create: true, edit: true, command: true },
      multiAgent: { ...config.multiAgent, enabled: false, allowUnattributedCalls: false }
    }),
    'utf8'
  );
  cleanups.push(() => removeTempDir(base));
  return { dataDir, workspace, outside };
}

/** One `exec` call over the daemon's own authenticated endpoint, returning the child's text. */
async function call(url: string, name: string, args: unknown): Promise<{ isError: boolean; text: string }> {
  const code = `const r = await tools[${JSON.stringify(name)}](${JSON.stringify(args)}); text(r);`;
  const response = await fetch(url, {
    method: 'POST',
    headers: { 'content-type': 'application/json', accept: 'application/json, text/event-stream' },
    body: JSON.stringify({ jsonrpc: '2.0', id: randomUUID(), method: 'tools/call', params: { name: 'exec', arguments: { code } } })
  });
  const raw = await response.text();
  const body = JSON.parse(raw.startsWith('{') ? raw : [...raw.matchAll(/^data: (.+)$/gm)].at(-1)![1]!) as {
    result?: { content?: Array<{ type: string; text?: string }>; isError?: boolean };
  };
  const outer = body.result;
  const outerText = (outer?.content ?? []).filter((part) => part.type === 'text').map((part) => part.text ?? '').join('\n');
  return { isError: outer?.isError === true, text: outerText };
}

async function start(dataDir: string): Promise<DaemonRuntimeHandle> {
  const handle = await startDaemonRuntime({ dataDir });
  cleanups.push(() => handle.stop());
  return handle;
}

it('serves read, exec_command, find and apply_patch over its own endpoint, and refuses outside roots', async () => {
  const { dataDir, workspace, outside } = await fixture();
  const daemon = await start(dataDir);

  // The URL is a real, authenticated MCP endpoint on loopback, exactly like the app's.
  expect(daemon.endpoint.startsWith('http://127.0.0.1:')).toBe(true);
  expect(daemon.urls.core).toBe(daemon.endpoint);
  expect(daemon.urls.core).not.toBe(daemon.urls.desktop);

  const read = await call(daemon.endpoint, 'read', { paths: ['/workspace/seed.txt'] });
  expect(read.isError, read.text).toBe(false);
  expect(read.text).toContain('seeded by the daemon fixture');

  const exec = await call(daemon.endpoint, 'exec_command', { cmd: 'printf daemon-exec-ok', workdir: '/workspace', yield_time_ms: 5_000 });
  expect(exec.isError, exec.text).toBe(false);
  expect(exec.text).toContain('daemon-exec-ok');

  const find = await call(daemon.endpoint, 'find', { query: 'seeded by the daemon fixture', mode: 'content', path: '/workspace' });
  expect(find.isError, find.text).toBe(false);
  expect(find.text).toContain('/workspace/seed.txt');

  const patch = await call(daemon.endpoint, 'apply_patch', ['*** Begin Patch', '*** Add File: /workspace/created.txt', '+created by the daemon', '*** End Patch'].join('\n'));
  expect(patch.isError, patch.text).toBe(false);
  expect(await fs.readFile(path.join(workspace, 'created.txt'), 'utf8')).toBe('created by the daemon\n');

  // The approved-root sandbox is the app's own, not a daemon-specific one.
  const escaped = await call(daemon.endpoint, 'read', { paths: [path.join(outside, 'secret.txt')] });
  expect(escaped.isError).toBe(true);
  expect(escaped.text).toContain('is not inside an approved folder');
  expect(escaped.text).not.toContain('not for the model');
});

it('advertises no Desktop tool, because this process has no browser or native backend', async () => {
  const { dataDir } = await fixture();
  const daemon = await start(dataDir);
  const response = await fetch(daemon.urls.desktop, {
    method: 'POST',
    headers: { 'content-type': 'application/json', accept: 'application/json, text/event-stream' },
    body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name: 'tools_search', arguments: {} } })
  });
  const raw = await response.text();
  const body = JSON.parse(raw.startsWith('{') ? raw : [...raw.matchAll(/^data: (.+)$/gm)].at(-1)![1]!) as {
    result?: { content?: Array<{ type: string; text?: string }> };
  };
  const text = (body.result?.content ?? []).map((part) => part.text ?? '').join('\n');
  expect(JSON.parse(text) as { tools: unknown[] }).toMatchObject({ tools: [], total: 0 });
});

it('answers daemon.status on its authenticated control socket and gives the directory back on stop', async () => {
  const { dataDir } = await fixture();
  const daemon = await start(dataDir);
  const descriptor = JSON.parse(await fs.readFile(path.join(dataDir, 'runtime.json'), 'utf8')) as Record<string, unknown>;
  expect(descriptor).toMatchObject({ kind: 'daemon', instance_id: daemon.instanceId, pid: process.pid });

  const socket = net.connect(daemon.control.socketPath);
  const lines: Array<Record<string, unknown>> = [];
  let buffer = '';
  socket.on('data', (chunk: Buffer) => {
    buffer += chunk.toString('utf8');
    for (let at = buffer.indexOf('\n'); at !== -1; at = buffer.indexOf('\n')) {
      lines.push(JSON.parse(buffer.slice(0, at)) as Record<string, unknown>);
      buffer = buffer.slice(at + 1);
    }
  });
  await new Promise<void>((resolve, reject) => {
    socket.once('connect', () => resolve());
    socket.once('error', reject);
  });
  const send = (value: unknown): void => void socket.write(`${JSON.stringify(value)}\n`);

  // The handshake carries the token from the descriptor: a wrong one is refused, the right one
  // is answered — which is what makes this socket reachable only through that 0600 file.
  send({ type: 'hello', installation_id: descriptor['installation_id'], protocol_version: 1, token: 'not-the-token' });
  while (lines.length < 1) await new Promise((resolve) => setTimeout(resolve, 10));
  expect(lines[0]).toMatchObject({ error: { code: 'TOKEN_MISMATCH' } });
  socket.destroy();

  const good = net.connect(daemon.control.socketPath);
  const goodLines: Array<Record<string, unknown>> = [];
  let goodBuffer = '';
  good.on('data', (chunk: Buffer) => {
    goodBuffer += chunk.toString('utf8');
    for (let at = goodBuffer.indexOf('\n'); at !== -1; at = goodBuffer.indexOf('\n')) {
      goodLines.push(JSON.parse(goodBuffer.slice(0, at)) as Record<string, unknown>);
      goodBuffer = goodBuffer.slice(at + 1);
    }
  });
  await new Promise<void>((resolve, reject) => {
    good.once('connect', () => resolve());
    good.once('error', reject);
  });
  good.write(`${JSON.stringify({ type: 'hello', installation_id: descriptor['installation_id'], protocol_version: 1, token: daemon.control.token })}\n`);
  while (goodLines.length < 1) await new Promise((resolve) => setTimeout(resolve, 10));
  good.write(`${JSON.stringify({ id: 1, method: 'daemon.status', params: {} })}\n`);
  while (goodLines.length < 2) await new Promise((resolve) => setTimeout(resolve, 10));
  expect(goodLines[1]!.result).toMatchObject({ instance_id: daemon.instanceId, data_dir: dataDir, endpoint: daemon.endpoint, kind: 'daemon' });
  good.destroy();

  await daemon.stop();
  // The directory is handed back: no descriptor advertising a dead endpoint, and no lock that
  // would make the next start look like a live owner.
  await expect(fs.access(path.join(dataDir, 'runtime.json'))).rejects.toThrow();
  await expect(fs.access(path.join(dataDir, DAEMON_LOCK_FILE))).rejects.toThrow();
  await expect(fetch(daemon.endpoint, { method: 'POST', body: '{}' })).rejects.toThrow();
});

it('shares one atomic data-directory owner with the desktop backend role', async () => {
  const { dataDir } = await fixture();
  const releaseDesktop = await acquireDataDirLock(dataDir, { instanceId: randomUUID(), kind: 'desktop' });
  await expect(startDaemonRuntime({ dataDir })).rejects.toMatchObject({ code: 'DATA_DIR_CONFLICT' });
  await releaseDesktop();

  const daemon = await start(dataDir);
  expect(daemon.endpoint.startsWith('http://127.0.0.1:')).toBe(true);
});

it('excludes desktop and daemon claims in both directions and under a simultaneous start', async () => {
  const { dataDir } = await fixture();
  const releaseDaemon = await acquireDataDirLock(dataDir, { instanceId: randomUUID(), kind: 'daemon' });
  await expect(
    acquireDataDirLock(dataDir, { instanceId: randomUUID(), kind: 'desktop' })
  ).rejects.toMatchObject({ code: 'DATA_DIR_CONFLICT' });
  await releaseDaemon();

  const attempts = await Promise.allSettled([
    acquireDataDirLock(dataDir, { instanceId: randomUUID(), kind: 'desktop' }),
    acquireDataDirLock(dataDir, { instanceId: randomUUID(), kind: 'daemon' })
  ]);
  expect(attempts.filter(result => result.status === 'fulfilled')).toHaveLength(1);
  expect(attempts.filter(result => result.status === 'rejected')).toHaveLength(1);
  for (const result of attempts) {
    if (result.status === 'fulfilled') await result.value();
  }
});

it('refuses a second runtime over a directory another daemon owns', async () => {
  const { dataDir } = await fixture();
  await start(dataDir);
  // The descriptor is hidden, so this is the runtime's own lock answering and not the CLI's
  // pre-check: two writers over one SQLite ledger is the failure this prevents.
  await fs.rm(path.join(dataDir, 'runtime.json'), { force: true });
  await expect(startDaemonRuntime({ dataDir })).rejects.toMatchObject({ code: 'DATA_DIR_CONFLICT' });
});

it('serializes two contenders reclaiming the same stale owner', async () => {
  const { dataDir } = await fixture();
  await fs.writeFile(
    path.join(dataDir, DAEMON_LOCK_FILE),
    `${JSON.stringify({ pid: 2 ** 30, instance_id: randomUUID(), kind: 'daemon', started_at: new Date(0).toISOString() })}\n`,
    'utf8'
  );
  const attempts = await Promise.allSettled([
    acquireDataDirLock(dataDir, { instanceId: randomUUID(), kind: 'desktop' }),
    acquireDataDirLock(dataDir, { instanceId: randomUUID(), kind: 'daemon' })
  ]);
  expect(attempts.filter(result => result.status === 'fulfilled')).toHaveLength(1);
  expect(attempts.filter(result => result.status === 'rejected')).toHaveLength(1);
  for (const result of attempts) {
    if (result.status === 'fulfilled') await result.value();
  }
});

it('does not reclaim an ownership claim whose process cannot be proved gone', async () => {
  const { dataDir } = await fixture();
  const lock = path.join(dataDir, DAEMON_LOCK_FILE);
  await fs.writeFile(lock, '', 'utf8');

  await expect(startDaemonRuntime({ dataDir })).rejects.toMatchObject({ code: 'DATA_DIR_CONFLICT' });
  expect(await fs.readFile(lock, 'utf8')).toBe('');
});

it('reclaims a directory whose owning daemon is genuinely gone', async () => {
  const { dataDir } = await fixture();
  await fs.writeFile(
    path.join(dataDir, DAEMON_LOCK_FILE),
    `${JSON.stringify({ pid: 2 ** 30, instance_id: randomUUID(), started_at: new Date(0).toISOString() })}\n`,
    'utf8'
  );
  const daemon = await start(dataDir);
  expect(daemon.endpoint.startsWith('http://127.0.0.1:')).toBe(true);
});

/** One authenticated `daemon.config` call over the real control socket. */
async function configure(
  dataDir: string,
  daemon: DaemonRuntimeHandle,
  params: Record<string, unknown>
): Promise<Record<string, unknown>> {
  return controlCall(dataDir, daemon, 'daemon.config', params);
}

/** One authenticated call over the real control socket, returning its result. */
async function controlCall(
  dataDir: string,
  daemon: DaemonRuntimeHandle,
  method: string,
  params: Record<string, unknown>
): Promise<Record<string, unknown>> {
  const descriptor = JSON.parse(await fs.readFile(path.join(dataDir, 'runtime.json'), 'utf8')) as Record<string, unknown>;
  const socket = net.connect(daemon.control.socketPath);
  const lines: Array<Record<string, unknown>> = [];
  let buffer = '';
  socket.on('data', (chunk: Buffer) => {
    buffer += chunk.toString('utf8');
    for (let at = buffer.indexOf('\n'); at !== -1; at = buffer.indexOf('\n')) {
      lines.push(JSON.parse(buffer.slice(0, at)) as Record<string, unknown>);
      buffer = buffer.slice(at + 1);
    }
  });
  await new Promise<void>((resolve, reject) => {
    socket.once('connect', () => resolve());
    socket.once('error', reject);
  });
  socket.write(
    `${JSON.stringify({ type: 'hello', installation_id: descriptor['installation_id'], protocol_version: 1, token: daemon.control.token })}\n`
  );
  while (lines.length < 1) await new Promise((resolve) => setTimeout(resolve, 10));
  socket.write(`${JSON.stringify({ id: 1, method, params })}\n`);
  while (lines.length < 2) await new Promise((resolve) => setTimeout(resolve, 10));
  socket.destroy();
  const answer = lines[1]!;
  if (answer['error']) throw new Error(JSON.stringify(answer['error']));
  return answer['result'] as Record<string, unknown>;
}

it('configures its own approved folders and permissions, and the live endpoint honours them', async () => {
  const { dataDir, outside } = await fixture();
  // A second folder the daemon has never been told about: reading it is refused until it is
  // approved through the socket.
  const added = path.join(path.dirname(dataDir), 'added');
  await fs.mkdir(added, { recursive: true });
  await fs.writeFile(path.join(added, 'added.txt'), 'added through the daemon\n', 'utf8');
  const real = await fs.realpath(added);

  const daemon = await start(dataDir);
  const denied = await call(daemon.endpoint, 'read', { paths: [path.join(real, 'added.txt')] });
  expect(denied.isError).toBe(true);
  expect(denied.text).toContain('is not inside an approved folder');

  const afterAdd = await configure(dataDir, daemon, { action: 'add-root', path: added, name: 'added' });
  expect(afterAdd).toMatchObject({ roots: expect.arrayContaining([{ name: 'added', path: real }]) });

  // The endpoint reads its context per request, so the folder is usable immediately — no restart.
  const allowed = await call(daemon.endpoint, 'read', { paths: ['/added/added.txt'] });
  expect(allowed.isError, allowed.text).toBe(false);
  expect(allowed.text).toContain('added through the daemon');

  // An overlapping folder is refused by the same rule the desktop picker applies.
  await expect(configure(dataDir, daemon, { action: 'add-root', path: path.join(real, 'nested') })).rejects.toThrow();
  // A relative path is refused rather than resolved against the daemon's cwd.
  await expect(configure(dataDir, daemon, { action: 'add-root', path: 'relative/folder' })).rejects.toThrow();

  // Read-only is applied to the live capability set, so a write tool is refused from now on.
  const readOnly = await configure(dataDir, daemon, { action: 'read-only', enabled: true });
  expect(readOnly['readOnly']).toBe(true);
  const refusedWrite = await call(daemon.endpoint, 'apply_patch', ['*** Begin Patch', '*** Add File: /added/blocked.txt', '+should not exist', '*** End Patch'].join('\n'));
  expect(refusedWrite.isError).toBe(true);
  await expect(fs.access(path.join(real, 'blocked.txt'))).rejects.toThrow();

  // Turning one permission off is a stored setting, and the Desktop group stays masked because
  // this host genuinely cannot serve it.
  const capability = await configure(dataDir, daemon, { action: 'capability', name: 'command', enabled: false });
  expect(capability).toMatchObject({
    capabilities: { command: false },
    effectiveCapabilities: { command: false, screen: false, control: false }
  });

  // Removing the folder withdraws access again.
  const afterRemove = await configure(dataDir, daemon, { action: 'remove-root', name: 'added' });
  expect(afterRemove['roots']).toEqual([{ name: 'workspace', path: expect.any(String) }]);
  const deniedAgain = await call(daemon.endpoint, 'read', { paths: ['/added/added.txt'] });
  expect(deniedAgain.isError).toBe(true);

  // `outside` was never approved and still is not: the verbs do not widen the sandbox.
  expect(afterRemove['roots']).not.toEqual(expect.arrayContaining([{ name: expect.any(String), path: outside }]));

  await daemon.stop();

  // The change is durable, not just in-memory: a restart reads the same stored configuration.
  const restarted = await start(dataDir);
  const persisted = await configure(dataDir, restarted, { action: 'get' });
  expect(persisted).toMatchObject({ readOnly: true, capabilities: { command: false } });
  expect(persisted['roots']).toEqual([{ name: 'workspace', path: expect.any(String) }]);
  const allFiles = await configure(dataDir, restarted, { action: 'file-access', mode: 'all-files' });
  expect(allFiles).toMatchObject({ fileAccessMode: 'all-files' });
  expect(JSON.parse(await fs.readFile(path.join(dataDir, 'config.json'), 'utf8'))).toMatchObject({ fileAccessMode: 'all-files' });
});

it('reports its tunnel state, and stores a credential only when the host can protect one', async () => {
  const { dataDir } = await fixture();
  const daemon = await start(dataDir);

  // No key in this process's environment: the store reports itself unavailable and names the
  // variable, and a write is refused rather than silently dropped.
  const status = await controlCall(dataDir, daemon, 'daemon.secret', { action: 'status' });
  expect(status['keys']).toEqual([{ key: 'openaiApiKey', present: false }]);
  expect(status['storage']).toMatchObject({ available: false });
  expect(String((status['storage'] as { detail: string }).detail)).toContain('WGPT_SECRET_KEY');
  await expect(controlCall(dataDir, daemon, 'daemon.secret', { action: 'set', key: 'openaiApiKey', value: 'sk-x' }))
    .rejects.toThrow(/credential storage is unavailable/);

  // A configured tunnel with no credential is reported as unavailable *with the reason*, rather
  // than as a tunnel that is merely quiet.
  const configured = await configure(dataDir, daemon, {
    action: 'tunnel',
    kind: 'openai',
    tunnelId: `tunnel_${'a'.repeat(32)}`
  });
  expect(configured['tunnel']).toMatchObject({ kind: 'openai', hasApiKey: false });
  const report = await controlCall(dataDir, daemon, 'daemon.status', {});
  expect(report['tunnel']).toMatchObject({ state: 'unavailable' });
  expect(String((report['tunnel'] as { detail: string }).detail)).toContain('daemon secret set openaiApiKey');

  // Selecting a transport the daemon cannot serve is still a stored, readable choice; and manual
  // is a real state rather than an error.
  const manual = await configure(dataDir, daemon, { action: 'tunnel', kind: 'manual' });
  expect(manual['tunnel']).toMatchObject({ kind: 'manual' });
  const off = await controlCall(dataDir, daemon, 'daemon.status', {});
  expect(off['tunnel']).toMatchObject({ state: 'off', publicUrl: null });
});
