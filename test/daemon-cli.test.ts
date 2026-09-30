/**
 * `wgpt daemon …` and the lifecycle module behind it.
 *
 * These cases defend one thing: a data directory has exactly one writer, and every command that
 * acts on it proves which instance it is acting on before it does anything.
 *
 * The daemon is faked *only* at the process boundary — a real Unix socket speaking the real
 * control protocol, and a real `runtime.json` written by the real publisher. Everything above
 * that boundary is the code under test: the real CLI parser, the real control client, the real
 * descriptor reader and the real lifecycle module.
 *
 * The negative cases are the point:
 *
 *   - `status` never reports a daemon from the descriptor alone, and never from a pid: a stale
 *     descriptor with a live-looking pid is "not running";
 *   - `start` is idempotent, and refuses outright when the desktop app owns the directory —
 *     without touching that app's descriptor or process;
 *   - `stop` refuses when the descriptor and the answering socket disagree about the instance,
 *     and it never signals a pid: an unrelated live process named by the descriptor survives;
 *   - a malformed command is exit 2, a missing daemon is exit 3, and a refusal is exit 4.
 */

import { spawn, spawnSync } from 'node:child_process';
import { promises as fs, writeFileSync } from 'node:fs';
import net from 'node:net';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { makeTempDir, removeTempDir } from './helpers.js';
import { run } from '../src/cli/index.js';
import { CAPABILITIES } from '../src/shared/types.js';
import {
  allocateControlEndpoint,
  readRuntimeDescriptor,
  removeStaleRuntimeDescriptor,
  runtimeFilePath
} from '../src/main/work/control-socket.js';
import {
  DAEMON_ERROR_CODES,
  claimDataDir,
  configureDaemon,
  daemonLaunchSpec,
  ownerForDataDir,
  requireDaemon,
  startDaemon,
  stopDaemon
} from '../src/daemon/lifecycle.js';

vi.mock('electron', () => ({
  safeStorage: {
    isAsyncEncryptionAvailable: async () => true,
    getSelectedStorageBackend: () => 'gnome_libsecret',
    encryptStringAsync: async (value: string) => Buffer.from(value, 'utf8'),
    decryptStringAsync: async (buffer: Buffer) => ({ result: buffer.toString('utf8'), shouldReEncrypt: false })
  },
  clipboard: { readText: () => '', writeText: () => undefined },
  shell: { openExternal: async () => undefined }
}));

/** Writes a descriptor file directly, so these cases do not depend on the schema's timing. */
async function writeDescriptorFile(dataDir: string, descriptor: Record<string, unknown>): Promise<void> {
  const file = runtimeFilePath(dataDir);
  await fs.writeFile(file, `${JSON.stringify(descriptor)}\n`, { mode: 0o600 });
  await fs.chmod(file, 0o600);
}

interface FakeDaemon {
  dataDir: string;
  instanceId: string;
  /** The exact descriptor document the fake daemon published. */
  descriptor: Record<string, unknown>;
  /** The MCP URLs the fake daemon answers with, so a caller need not re-derive them. */
  coreUrl: string;
  desktopUrl: string;
  pluginsUrl: string;
  /** Every control method the daemon actually received, in order. */
  methods: string[];
  /** Every `daemon.config` request the fake daemon received, in order. */
  configRequests: Array<Record<string, unknown>>;
  /** Every `daemon.secret` request the fake daemon received, in order. */
  secretRequests: Array<Record<string, unknown>>;
  /** Every hello frame the daemon accepted. */
  hellos: Array<{ installation_id: string; protocol_version: number; token?: string }>;
  /** Flips the instance id the daemon answers with, without touching the descriptor. */
  answerAs(instanceId: string): void;
  /** Runs after status is written, before the client can issue its mutation. */
  afterStatus(callback: () => void): void;
  /** Makes the daemon answer every call with a refusal, as a live host would. */
  refuse(code: string): void;
  /** Makes the daemon report an unavailable credential store with this reason. */
  storageUnavailable(detail: string): void;
  close(): Promise<void>;
}

const cleanups: Array<() => Promise<void>> = [];

afterEach(async () => {
  for (const cleanup of cleanups.splice(0)) await cleanup().catch(() => undefined);
});

function track(cleanup: () => Promise<void>): void {
  cleanups.push(cleanup);
}

async function makeDataDir(): Promise<string> {
  const dir = await makeTempDir('wgpt-daemon-');
  track(() => removeTempDir(dir));
  const dataDir = path.join(dir, 'data');
  await fs.mkdir(dataDir, { mode: 0o700 });
  return dataDir;
}

/**
 * A daemon control endpoint: a real private socket that speaks the real protocol.
 *
 * It enforces the same two things the real host does — the hello must carry the installation id
 * and protocol version, and it must carry the descriptor's control token when the descriptor has
 * one — so a client that forgot the token fails here rather than silently succeeding.
 */
async function startFakeDaemon(options: { dataDir?: string; token?: string | null } = {}): Promise<FakeDaemon> {
  const dataDir = options.dataDir ?? (await makeDataDir());
  const instanceId = randomUUID();
  const installationId = randomUUID();
  const token = options.token === undefined ? randomUUID() : options.token;
  const socketPath = await allocateControlEndpoint();
  let answerInstance: string = instanceId;
  let refusal: string | null = null;
  let statusAnswered: (() => void) | null = null;
  const methods: string[] = [];
  const configRequests: Array<Record<string, unknown>> = [];
  const secretRequests: Array<Record<string, unknown>> = [];
  const hellos: FakeDaemon['hellos'] = [];
  const sockets = new Set<net.Socket>();

  const coreUrl = 'http://127.0.0.1:9/mcp/core/secret';
  const desktopUrl = 'http://127.0.0.1:9/mcp/desktop/secret';
  const pluginsUrl = 'http://127.0.0.1:9/mcp/plugins/secret';
  const startedAt = new Date(1_700_000_000_000).toISOString();
  /** The fake daemon's own settings state, so `daemon config` has something real to read back. */
  const configState: {
    roots: Array<{ name: string; path: string }>;
    readOnly: boolean;
    fileAccessMode: 'approved-roots' | 'all-files';
    capabilities: Record<string, boolean>;
    tunnelKind: 'openai' | 'cloudflared' | 'manual';
    tunnelId: string;
    hasApiKey: boolean;
  } = {
    roots: [],
    readOnly: false,
    fileAccessMode: 'approved-roots',
    // Complete rather than sparse: the report schema requires every capability key, because a
    // missing key would read as "off" to a caller that trusts the map.
    capabilities: Object.fromEntries(CAPABILITIES.map((capability) => [capability, false])),
    tunnelKind: 'manual',
    tunnelId: '',
    hasApiKey: false
  };
  /** The fake daemon's credential state: presence plus the storage verdict it reports. */
  const secretState = { present: false, storageAvailable: true, storageDetail: null as string | null };
  const status = (): Record<string, unknown> => ({
    instance_id: answerInstance,
    pid: 4242,
    data_dir: dataDir,
    version: '2.1.14',
    started_at: startedAt,
    endpoint: coreUrl,
    urls: { core: coreUrl, desktop: desktopUrl, plugins: pluginsUrl },
    kind: 'daemon'
  });

  const server = net.createServer((socket) => {
    sockets.add(socket);
    socket.on('error', () => socket.destroy());
    socket.on('close', () => sockets.delete(socket));
    let greeted = false;
    let buffered = '';
    const write = (value: unknown): void => {
      if (!socket.destroyed) socket.write(`${JSON.stringify(value)}\n`);
    };
    socket.on('data', (chunk) => {
      buffered += chunk.toString('utf8');
      for (;;) {
        const newline = buffered.indexOf('\n');
        if (newline === -1) return;
        const line = buffered.slice(0, newline);
        buffered = buffered.slice(newline + 1);
        const frame = JSON.parse(line) as Record<string, unknown>;
        if (!greeted) {
          hellos.push(frame as FakeDaemon['hellos'][number]);
          const wantsToken = token !== null;
          if (frame.installation_id !== installationId || frame.protocol_version !== 1) {
            write({ error: { code: 'INSTALLATION_MISMATCH', message: 'hello names a different installation' } });
            socket.end();
            return;
          }
          if (wantsToken && frame.token !== token) {
            write({ error: { code: 'HELLO_REQUIRED', message: 'hello did not carry the control token' } });
            socket.end();
            return;
          }
          greeted = true;
          write({ type: 'ready', protocol_version: 1 });
          continue;
        }
        const id = frame.id as number;
        const method = String(frame.method);
        methods.push(method);
        if (refusal) {
          write({ id, error: { code: refusal, message: 'refused by the fake daemon' } });
          continue;
        }
        if (method === 'daemon.status') {
          write({ id, result: status() });
          statusAnswered?.();
          continue;
        }
        if (method === 'daemon.config') {
          // A minimal but real projection of the verb: the request is recorded as received, and
          // the answer is built from an in-memory state so a caller can prove it read back what it
          // just changed. The production implementation is exercised against the real runtime in
          // `daemon-runtime.test.ts`.
          const params = (frame.params ?? {}) as Record<string, unknown>;
          configRequests.push(params);
          if (params['action'] === 'add-root') {
            configState.roots.push({ name: `root-${configState.roots.length + 1}`, path: String(params['path']) });
          } else if (params['action'] === 'remove-root') {
            configState.roots = configState.roots.filter((root) => root.name !== params['name']);
          } else if (params['action'] === 'file-access') {
            configState.fileAccessMode = params['mode'] as typeof configState.fileAccessMode;
          } else if (params['action'] === 'read-only') {
            configState.readOnly = params['enabled'] === true;
          } else if (params['action'] === 'capability') {
            configState.capabilities[String(params['name'])] = params['enabled'] === true;
          } else if (params['action'] === 'tunnel') {
            configState.tunnelKind = params['kind'] as typeof configState.tunnelKind;
            if (typeof params['tunnelId'] === 'string') configState.tunnelId = params['tunnelId'];
          }
          write({
            id,
            result: {
              roots: configState.roots.map((root) => ({ ...root })),
              readOnly: configState.readOnly,
              fileAccessMode: configState.fileAccessMode,
              capabilities: { ...configState.capabilities },
              effectiveCapabilities: { ...configState.capabilities },
              // The report schema requires the transport block, because a client that asked for
              // the configuration is exactly the caller deciding whether a tunnel can be used.
              tunnel: { kind: configState.tunnelKind, tunnelId: configState.tunnelId, hasApiKey: configState.hasApiKey }
            }
          });
          continue;
        }
        if (method === 'daemon.secret') {
          // Presence only, exactly like the real verb: the value is recorded nowhere and echoed
          // nowhere, so a test cannot accidentally depend on reading a credential back.
          const params = (frame.params ?? {}) as Record<string, unknown>;
          secretRequests.push(params);
          if (params['action'] === 'set') secretState.present = true;
          else if (params['action'] === 'clear') secretState.present = false;
          write({
            id,
            result: {
              keys: [{ key: 'openaiApiKey', present: secretState.present }],
              storage: { available: secretState.storageAvailable, detail: secretState.storageDetail }
            }
          });
          continue;
        }
        if (method === 'daemon.stop') {
          write({ id, result: { stopping: true, instance_id: answerInstance } });
          socket.end();
          // A stopped daemon stops answering: the listener goes with the instance, so a
          // following `status` cannot reach a socket that no longer has a daemon behind it.
          for (const peer of sockets) peer.destroy();
          sockets.clear();
          server.close();
          continue;
        }
        write({ id, error: { code: 'UNKNOWN_METHOD', message: `unknown method ${method}` } });
      }
    });
  });
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    server.listen(socketPath, resolve);
  });
  await fs.chmod(socketPath, 0o600);

  const descriptor: Record<string, unknown> = {
    socket_path: socketPath,
    pid: process.pid,
    installation_id: installationId,
    protocol_version: 1,
    kind: 'daemon',
    instance_id: instanceId,
    ...(token === null ? {} : { control_token: token }),
    data_dir: dataDir,
    started_at: startedAt,
    version: '2.1.14',
    mcp: { core: coreUrl, desktop: desktopUrl, plugins: pluginsUrl }
  };
  await writeDescriptorFile(dataDir, descriptor);

  const close = async (): Promise<void> => {
    for (const socket of sockets) socket.destroy();
    sockets.clear();
    await new Promise<void>((resolve) => server.close(() => resolve()));
    await fs.rm(socketPath, { force: true }).catch(() => undefined);
  };
  track(close);

  return {
    dataDir,
    instanceId,
    descriptor,
    coreUrl,
    desktopUrl,
    pluginsUrl,
    methods,
    configRequests,
    secretRequests,
    hellos,
    answerAs: (value: string) => {
      answerInstance = value;
    },
    afterStatus: (callback) => {
      statusAnswered = callback;
    },
    refuse: (code) => {
      refusal = code;
    },
    storageUnavailable: (detail) => {
      secretState.storageAvailable = false;
      secretState.storageDetail = detail;
    },
    close
  };
}

/**
 * A desktop host for the same data directory: a real socket answering `host.status`, and a
 * descriptor with no daemon fields at all — exactly what the desktop app publishes today.
 */
async function startFakeDesktopHost(dataDir: string): Promise<{ close(): Promise<void> }> {
  const socketPath = await allocateControlEndpoint();
  const sockets = new Set<net.Socket>();
  const server = net.createServer((socket) => {
    sockets.add(socket);
    socket.on('error', () => socket.destroy());
    socket.on('close', () => sockets.delete(socket));
    let greeted = false;
    let buffered = '';
    socket.on('data', (chunk) => {
      buffered += chunk.toString('utf8');
      for (;;) {
        const newline = buffered.indexOf('\n');
        if (newline === -1) return;
        const frame = JSON.parse(buffered.slice(0, newline)) as Record<string, unknown>;
        buffered = buffered.slice(newline + 1);
        const write = (value: unknown): void => {
          if (!socket.destroyed) socket.write(`${JSON.stringify(value)}\n`);
        };
        if (!greeted) {
          greeted = true;
          write({ type: 'ready', protocol_version: 1 });
          continue;
        }
        write({
          id: frame.id as number,
          result: {
            pid: process.pid,
            installation_id: 'desktop-installation',
            protocol_version: 1,
            data_dir: dataDir,
            version: '2.1.14',
            started_at: new Date(1_700_000_000_000).toISOString()
          }
        });
      }
    });
  });
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    server.listen(socketPath, resolve);
  });
  await fs.chmod(socketPath, 0o600);
  await writeDescriptorFile(dataDir, {
    socket_path: socketPath,
    pid: process.pid,
    installation_id: 'desktop-installation',
    protocol_version: 1
  });
  const close = async (): Promise<void> => {
    for (const socket of sockets) socket.destroy();
    sockets.clear();
    await new Promise<void>((resolve) => server.close(() => resolve()));
    await fs.rm(socketPath, { force: true }).catch(() => undefined);
  };
  track(close);
  return { close };
}

/** Captures what the CLI wrote to stdout/stderr for one invocation. */
async function invoke(
  argv: string[],
  env: NodeJS.ProcessEnv = process.env
): Promise<{ code: number; out: string; err: string }> {
  let out = '';
  let err = '';
  const outWrite = process.stdout.write.bind(process.stdout);
  const errWrite = process.stderr.write.bind(process.stderr);
  const capture = (target: 'out' | 'err') => ((chunk: unknown): boolean => {
    if (target === 'out') out += String(chunk);
    else err += String(chunk);
    return true;
  }) as typeof process.stdout.write;
  process.stdout.write = capture('out');
  process.stderr.write = capture('err');
  try {
    const code = await run({ argv, env });
    return { code, out, err };
  } finally {
    process.stdout.write = outWrite;
    process.stderr.write = errWrite;
  }
}

function jsonLine(text: string): Record<string, unknown> {
  return JSON.parse(text.trim()) as Record<string, unknown>;
}

/**
 * A daemon entry that records the fact it was launched, and then does nothing.
 *
 * It exists so "did `start` spawn a process" is a filesystem fact rather than a guess: the file
 * is written by the child, so its absence after an idempotent start is proof nothing ran.
 */
async function makeMarkerEntry(dir: string): Promise<{ entry: string; marker: string }> {
  const marker = path.join(dir, 'launched.txt');
  const entry = path.join(dir, 'entry.js');
  await fs.writeFile(entry, `require('node:fs').writeFileSync(${JSON.stringify(marker)}, 'launched\\n');\n`, 'utf8');
  return { entry, marker };
}

async function exists(target: string): Promise<boolean> {
  return fs.access(target).then(
    () => true,
    () => false
  );
}

describe('wgpt daemon status', () => {
  it('reports the daemon that answers, and never the descriptor alone', async () => {
    const daemon = await startFakeDaemon();
    const result = await invoke(['daemon', 'status', '--data-dir', daemon.dataDir, '--json']);
    expect(result.code).toBe(0);
    const report = jsonLine(result.out);
    expect(report.instance_id).toBe(daemon.instanceId);
    expect(report.endpoint).toBe(daemon.coreUrl);
    expect(report.urls).toEqual({ core: daemon.coreUrl, desktop: daemon.desktopUrl, plugins: daemon.pluginsUrl });
    expect(report.kind).toBe('daemon');
    expect(daemon.methods).toEqual(['daemon.status']);
    // The token the descriptor carries is what the client authenticated with; without it the
    // fake daemon would have refused the hello and this would be exit 3.
    expect(daemon.hellos[0]?.token).toBe(daemon.descriptor.control_token);
  });

  it('is exit 3 when nothing is running, even with a live-looking pid in a stale descriptor', async () => {
    const dataDir = await makeDataDir();
    // A pid that certainly exists — this process — with a socket that does not. A command that
    // trusted the file would call this a running daemon.
    const socketPath = await allocateControlEndpoint();
    await fs.rm(socketPath, { force: true });
    await writeDescriptorFile(dataDir, {
      socket_path: socketPath,
      pid: process.pid,
      installation_id: randomUUID(),
      protocol_version: 1,
      kind: 'daemon',
      instance_id: randomUUID()
    });
    const result = await invoke(['daemon', 'status', '--data-dir', dataDir]);
    expect(result.code).toBe(3);
    expect(result.out).toBe('');
    expect(result.err).toMatch(/no daemon answered/);
  });

  it('is exit 3, not a desktop-host report, when the desktop app owns the directory', async () => {
    const dataDir = await makeDataDir();
    await startFakeDesktopHost(dataDir);
    const result = await invoke(['daemon', 'status', '--data-dir', dataDir]);
    expect(result.code).toBe(3);
    expect(result.err).toMatch(/desktop app owns that data directory/);
  });

  it('is exit 3 when a refusal comes back from the answering daemon', async () => {
    const daemon = await startFakeDaemon();
    daemon.refuse('HOST_UNAVAILABLE');
    const result = await invoke(['daemon', 'status', '--data-dir', daemon.dataDir]);
    expect(result.code).toBe(3);
  });
});

describe('wgpt daemon start', () => {
  it('adopts the running daemon instead of launching a second one', async () => {
    const daemon = await startFakeDaemon();
    const { entry, marker } = await makeMarkerEntry(daemon.dataDir);
    const result = await invoke(['daemon', 'start', '--data-dir', daemon.dataDir, '--json'], {
      ...process.env,
      WGPT_DAEMON_ENTRY: entry
    });
    expect(result.code).toBe(0);
    expect(jsonLine(result.out).instance_id).toBe(daemon.instanceId);
    expect(result.err).toMatch(/already running/);
    expect(await exists(marker)).toBe(false);
    // The descriptor the running daemon published is untouched by the second start.
    expect(await readRuntimeDescriptor(daemon.dataDir)).toMatchObject({ instance_id: daemon.instanceId });
  });

  it('launches the daemon entry when nothing is running, and reports a truthful timeout', async () => {
    const dataDir = await makeDataDir();
    const { entry, marker } = await makeMarkerEntry(dataDir);
    // The entry is a marker writer, so no daemon ever answers: this proves the launch happened
    // and that the wait ends as a truthful timeout rather than as an invented success. The wait
    // is shortened here because the real budget is the daemon's own startup time, not a fact
    // under test.
    await expect(
      startDaemon(dataDir, {
        env: { ...process.env, WGPT_DAEMON_ENTRY: entry, WGPT_NODE_EXECUTABLE: process.execPath },
        timeoutMs: 1_000
      })
    ).rejects.toThrow(/did not answer/);
    for (let attempt = 0; attempt < 100 && !(await exists(marker)); attempt += 1) {
      await new Promise((resolve) => setTimeout(resolve, 20));
    }
    expect(await exists(marker)).toBe(true);
  });

  it('refuses when the desktop app owns the data directory, without touching its descriptor', async () => {
    const dataDir = await makeDataDir();
    await startFakeDesktopHost(dataDir);
    const before = await fs.readFile(runtimeFilePath(dataDir), 'utf8');
    const { entry, marker } = await makeMarkerEntry(dataDir);
    const result = await invoke(['daemon', 'start', '--data-dir', dataDir], {
      ...process.env,
      WGPT_DAEMON_ENTRY: entry
    });
    expect(result.code).toBe(4);
    expect(result.err).toMatch(/desktop app owns/);
    expect(await exists(marker)).toBe(false);
    expect(await fs.readFile(runtimeFilePath(dataDir), 'utf8')).toBe(before);
  });

  it('keeps a descriptor when the owner probe is permission denied', async () => {
    const dataDir = await makeDataDir();
    const socketPath = await allocateControlEndpoint();
    const before = {
      socket_path: socketPath,
      pid: 424242,
      installation_id: randomUUID(),
      protocol_version: 1,
      kind: 'daemon',
      instance_id: randomUUID()
    };
    await writeDescriptorFile(dataDir, before);
    const probe = vi.spyOn(process, 'kill').mockImplementation(() => {
      throw Object.assign(new Error('permission denied'), { code: 'EPERM' });
    });
    try {
      await expect(removeStaleRuntimeDescriptor(dataDir)).resolves.toBe(false);
      await expect(readRuntimeDescriptor(dataDir)).resolves.toMatchObject(before);
    } finally {
      probe.mockRestore();
    }
  });

  it('clears a stale descriptor whose owner is gone and launches', async () => {
    const dataDir = await makeDataDir();
    const { entry, marker } = await makeMarkerEntry(dataDir);
    const socketPath = await allocateControlEndpoint();
    await fs.rm(socketPath, { force: true });
    // A pid nothing owns: `removeStaleRuntimeDescriptor` probes it and removes the file.
    const deadPid = 0x7ffffff;
    await writeDescriptorFile(dataDir, {
      socket_path: socketPath,
      pid: deadPid,
      installation_id: randomUUID(),
      protocol_version: 1,
      kind: 'daemon',
      instance_id: randomUUID()
    });
    await expect(
      startDaemon(dataDir, {
        env: { ...process.env, WGPT_DAEMON_ENTRY: entry, WGPT_NODE_EXECUTABLE: process.execPath },
        timeoutMs: 1_000
      })
    ).rejects.toThrow(/did not answer/);
    for (let attempt = 0; attempt < 100 && !(await exists(marker)); attempt += 1) {
      await new Promise((resolve) => setTimeout(resolve, 20));
    }
    expect(await exists(marker)).toBe(true);
    // The stale descriptor was reconciled rather than left behind for the next command to trip on.
    expect(await fs.access(runtimeFilePath(dataDir)).then(() => true, () => false)).toBe(false);
  });

  it('refuses to launch on an Electron binary instead of falling back to one', async () => {
    const dataDir = await makeDataDir();
    const { entry } = await makeMarkerEntry(dataDir);
    expect(() =>
      daemonLaunchSpec(
        { ...process.env, WGPT_DAEMON_ENTRY: entry, WGPT_NODE_EXECUTABLE: '' },
        '/opt/app/out/cli/index.js',
        '/opt/app/Electron.app/Contents/MacOS/Electron'
      )
    ).toThrow(/plain Node/);
  });

  // A POSIX app stand-in: records that it ran, then acts as the Node host the launcher expects.
  async function makeAppFixture(file: string, marker: string): Promise<void> {
    await fs.mkdir(path.dirname(file), { recursive: true });
    await fs.writeFile(file, `#!/bin/sh\nprintf ran > ${JSON.stringify(marker)}\nexec ${JSON.stringify(process.execPath)} "$@"\n`, { mode: 0o755 });
  }

  it.runIf(process.platform !== 'win32')('runs an explicit development host override exactly as given', async () => {
    const dir = await makeTempDir('wgpt-launcher-override-');
    track(() => removeTempDir(dir));
    const bin = path.join(dir, 'path bin');
    const name = 'wgpt-fixture-app';
    const marker = path.join(dir, 'path-app-ran');
    await makeAppFixture(path.join(bin, name), marker);
    // Stands in for `host start`: spawns whatever host executable the launcher published.
    const entry = path.join(dir, 'cli.mjs');
    await fs.writeFile(entry, [
      "import { spawnSync } from 'node:child_process';",
      "const host = spawnSync(process.env.WGPT_APP_EXECUTABLE, ['-e', ''], { encoding: 'utf8' });",
      "process.stdout.write(JSON.stringify({ status: host.status, error: host.error?.code ?? null }));"
    ].join('\n'));
    const launcher = path.resolve('bin/wgpt.mjs');
    const env = { ...process.env, WGPT_CLI_ENTRY: entry, PATH: bin + path.delimiter + (process.env.PATH || '') };

    const byName = spawnSync(process.execPath, [launcher, 'host', 'start'], { env: { ...env, WGPT_APP_EXECUTABLE: name }, encoding: 'utf8' });
    expect(JSON.parse(byName.stdout)).toEqual({ status: 0, error: null });
    expect(await exists(marker)).toBe(true);

    // The repo's Electron is available, but a broken explicit path must fail rather than run it.
    const missing = path.join(dir, 'missing-app');
    const invalid = spawnSync(process.execPath, [launcher, 'host', 'start'], { env: { ...env, WGPT_APP_EXECUTABLE: missing }, encoding: 'utf8' });
    expect(JSON.parse(invalid.stdout)).toEqual({ status: null, error: 'ENOENT' });
  });

  it.runIf(process.platform !== 'win32')('runs the packaged app binary, or an explicit override exactly as given', async () => {
    const dir = await makeTempDir('wgpt-packaged-launcher-');
    track(() => removeTempDir(dir));
    const appRoot = process.platform === 'darwin' ? path.join(dir, 'Web GPT Agent.app', 'Contents') : dir;
    const resources = path.join(appRoot, process.platform === 'darwin' ? 'Resources' : 'resources');
    await fs.mkdir(path.join(resources, 'bin'), { recursive: true });
    await fs.writeFile(path.join(resources, 'app.asar'), 'fixture');
    const launcher = path.join(resources, 'bin', 'wgpt.mjs');
    await fs.copyFile(path.resolve('bin/wgpt.mjs'), launcher);
    const bundledRan = path.join(dir, 'bundled-ran');
    await makeAppFixture(path.join(appRoot, process.platform === 'darwin' ? 'MacOS/Web GPT Agent' : 'web-gpt-agent'), bundledRan);
    const bin = path.join(dir, 'path bin');
    const name = 'wgpt-fixture-app';
    const pathRan = path.join(dir, 'path-app-ran');
    await makeAppFixture(path.join(bin, name), pathRan);
    const entryRan = path.join(dir, 'entry-ran');
    const entry = path.join(dir, 'cli.mjs');
    await fs.writeFile(entry, `import { writeFileSync } from 'node:fs'; writeFileSync(${JSON.stringify(entryRan)}, 'ran'); process.exit(4);`);
    const env = { ...process.env, WGPT_CLI_ENTRY: entry, PATH: bin + path.delimiter + (process.env.PATH || '') };
    // Unset: the bundled binary runs the entry.
    const automatic = spawnSync(process.execPath, [launcher, 'host', 'status'], {
      env: { ...env, WGPT_APP_EXECUTABLE: '' }, encoding: 'utf8'
    });
    expect(automatic.status).toBe(4);
    expect([await exists(bundledRan), await exists(pathRan), await exists(entryRan)]).toEqual([true, false, true]);

    // A bare name resolves on PATH and replaces the bundled binary.
    await Promise.all([bundledRan, pathRan, entryRan].map((file) => fs.rm(file, { force: true })));
    const explicit = spawnSync(process.execPath, [launcher, 'host', 'status'], {
      env: { ...env, WGPT_APP_EXECUTABLE: name }, encoding: 'utf8'
    });
    expect(explicit.status).toBe(4);
    expect([await exists(bundledRan), await exists(pathRan), await exists(entryRan)]).toEqual([false, true, true]);

    // An unusable explicit path fails; the bundled binary is not substituted and the entry never runs.
    await Promise.all([bundledRan, pathRan, entryRan].map((file) => fs.rm(file, { force: true })));
    const invalid = spawnSync(process.execPath, [launcher, 'host', 'status'], {
      env: { ...env, WGPT_APP_EXECUTABLE: path.join(dir, 'missing-app') }, encoding: 'utf8'
    });
    expect(invalid.status).toBe(2);
    expect(invalid.stderr).toContain('ENOENT');
    expect([await exists(bundledRan), await exists(pathRan), await exists(entryRan)]).toEqual([false, false, false]);
  });

  it('refuses when there is no daemon entry to launch', async () => {
    expect(() => daemonLaunchSpec({ ...process.env, WGPT_DAEMON_ENTRY: '' }, '/opt/app/main/index.js')).toThrow(
      /cannot locate the daemon entry/
    );
  });
});

describe('wgpt daemon stop', () => {
  it('stops the exact instance, and no pid is ever signalled', async () => {
    const daemon = await startFakeDaemon();
    // An unrelated live process. The descriptor's own pid is this test process, so a stop that
    // signalled the file's pid would kill the test runner itself — this is the same guarantee
    // stated positively: the daemon stops over its socket, and an unrelated process lives on.
    const bystander = spawn(process.execPath, ['-e', 'setTimeout(() => {}, 60_000)'], { stdio: 'ignore' });
    track(async () => {
      bystander.kill('SIGKILL');
    });
    const result = await invoke(['daemon', 'stop', '--data-dir', daemon.dataDir, '--json']);
    expect(result.code).toBe(0);
    expect(jsonLine(result.out)).toEqual({ stopping: true, instance_id: daemon.instanceId });
    expect(daemon.methods).toEqual(['daemon.status', 'daemon.stop']);
    expect(bystander.exitCode).toBeNull();
    expect(bystander.signalCode).toBeNull();
    // The daemon closed its socket; a following status is truthfully "not running".
    const after = await invoke(['daemon', 'status', '--data-dir', daemon.dataDir]);
    expect(after.code).toBe(3);
  });

  it('refuses when the descriptor and the answering daemon disagree about the instance', async () => {
    const daemon = await startFakeDaemon();
    daemon.answerAs(randomUUID());
    const result = await invoke(['daemon', 'stop', '--data-dir', daemon.dataDir]);
    expect(result.code).toBe(4);
    expect(result.err).toMatch(/refusing to act on an unverified instance/);
    // Nothing was stopped: the stop verb was never even sent.
    expect(daemon.methods).toEqual(['daemon.status']);
  });

  it('is exit 3 when no daemon is running, and never touches the desktop app', async () => {
    const dataDir = await makeDataDir();
    const desktop = await startFakeDesktopHost(dataDir);
    const before = await fs.readFile(runtimeFilePath(dataDir), 'utf8');
    const result = await invoke(['daemon', 'stop', '--data-dir', dataDir]);
    expect(result.code).toBe(3);
    expect(result.err).toMatch(/desktop app owns that data directory/);
    expect(await fs.readFile(runtimeFilePath(dataDir), 'utf8')).toBe(before);
    await desktop.close();
  });
});

describe('wgpt daemon config', () => {
  it('reads the daemon’s own settings rather than the file', async () => {
    const daemon = await startFakeDaemon();
    const result = await invoke(['daemon', 'config', '--data-dir', daemon.dataDir, '--json']);
    expect(result.code).toBe(0);
    expect(jsonLine(result.out)).toMatchObject({ roots: [], readOnly: false });
    // The verb reached the daemon rather than the file: nothing here writes config.json directly.
    // `daemon.status` proves the instance first, exactly as `stop` does.
    expect(daemon.methods).toEqual(['daemon.status', 'daemon.config']);
    expect(daemon.configRequests).toEqual([{ action: 'get' }]);
  });

  it('keeps a mutation on the exact daemon proved before runtime.json changes', async () => {
    const first = await startFakeDaemon();
    const successor = await startFakeDaemon({ dataDir: first.dataDir });
    await writeDescriptorFile(first.dataDir, first.descriptor);
    first.afterStatus(() => {
      writeFileSync(runtimeFilePath(first.dataDir), `${JSON.stringify(successor.descriptor)}\n`, { mode: 0o600 });
    });

    await expect(configureDaemon(first.dataDir, { action: 'get' })).resolves.toMatchObject({ roots: [] });
    expect(first.methods).toEqual(['daemon.status', 'daemon.config']);
    expect(successor.methods).toEqual([]);
  });

  it('sends each change to the daemon and prints the state it answered with', async () => {
    const daemon = await startFakeDaemon();
    const workspace = path.join(daemon.dataDir, 'workspace');
    await fs.mkdir(workspace, { recursive: true });

    const added = await invoke([
      'daemon', 'config', 'add-root', workspace, '--name', 'project', '--data-dir', daemon.dataDir, '--json'
    ]);
    expect(added.code).toBe(0);
    expect(jsonLine(added.out)).toMatchObject({ roots: [{ name: 'root-1', path: workspace }] });
    // Only the change is sent; the daemon is proved with `daemon.status` first, exactly as stop is.
    expect(daemon.methods).toEqual(['daemon.status', 'daemon.config']);
    expect(daemon.configRequests).toEqual([{ action: 'add-root', path: workspace, name: 'project' }]);

    const access = await invoke(['daemon', 'config', 'file-access', 'all-files', '--data-dir', daemon.dataDir, '--json']);
    expect(access.code).toBe(0);
    expect(jsonLine(access.out)).toMatchObject({ fileAccessMode: 'all-files' });
    expect(daemon.configRequests.at(-1)).toEqual({ action: 'file-access', mode: 'all-files' });

    const readOnly = await invoke(['daemon', 'config', 'read-only', 'on', '--data-dir', daemon.dataDir, '--json']);
    expect(readOnly.code).toBe(0);
    expect(jsonLine(readOnly.out)).toMatchObject({ readOnly: true });

    const capability = await invoke(['daemon', 'config', 'capability', 'command', 'off', '--data-dir', daemon.dataDir, '--json']);
    expect(capability.code).toBe(0);
    expect(jsonLine(capability.out).capabilities).toMatchObject({ command: false });

    const removed = await invoke(['daemon', 'config', 'remove-root', 'root-1', '--data-dir', daemon.dataDir, '--json']);
    expect(removed.code).toBe(0);
    expect(jsonLine(removed.out)).toMatchObject({ roots: [] });
  });

  it('rejects a malformed config command locally, without contacting the daemon', async () => {
    const daemon = await startFakeDaemon();
    const unknown = await invoke(['daemon', 'config', 'set-everything', '--data-dir', daemon.dataDir]);
    expect(unknown.code).toBe(2);
    expect(unknown.err).toMatch(/unknown daemon config command: set-everything/);

    const missingPath = await invoke(['daemon', 'config', 'add-root', '--data-dir', daemon.dataDir]);
    expect(missingPath.code).toBe(2);
    expect(missingPath.err).toMatch(/requires an absolute <path>/);

    // A permission name the app does not have is a local mistake, not a remote refusal.
    const badCapability = await invoke(['daemon', 'config', 'capability', 'sudo', 'on', '--data-dir', daemon.dataDir]);
    expect(badCapability.code).toBe(2);
    expect(badCapability.err).toMatch(/unknown permission sudo/);

    const badAccess = await invoke(['daemon', 'config', 'file-access', 'everything', '--data-dir', daemon.dataDir]);
    expect(badAccess.code).toBe(2);
    expect(badAccess.err).toMatch(/approved-roots.*all-files/);

    const noWord = await invoke(['daemon', 'config', 'read-only', '--data-dir', daemon.dataDir]);
    expect(noWord.code).toBe(2);
    expect(noWord.err).toMatch(/requires 'on' or 'off'/);

    const badName = await invoke([
      'daemon', 'config', 'add-root', daemon.dataDir, '--name', 'Not A Slug', '--data-dir', daemon.dataDir
    ]);
    expect(badName.code).toBe(2);

    // A bad local request must never have reached the daemon.
    expect(daemon.methods).toEqual([]);
  });

  it('refuses to configure a directory the desktop app owns, and never touches its descriptor', async () => {
    const dataDir = await makeDataDir();
    const desktop = await startFakeDesktopHost(dataDir);
    const before = await fs.readFile(runtimeFilePath(dataDir), 'utf8');
    const result = await invoke(['daemon', 'config', '--data-dir', dataDir]);
    expect(result.code).toBe(3);
    expect(result.err).toMatch(/desktop app owns that data directory/);
    expect(await fs.readFile(runtimeFilePath(dataDir), 'utf8')).toBe(before);
    await desktop.close();
  });

  it('refuses arguments after reconnect, which takes none', async () => {
    const daemon = await startFakeDaemon();
    const extra = await invoke(['daemon', 'config', 'reconnect', 'now', '--data-dir', daemon.dataDir]);
    expect(extra.code).toBe(2);
    expect(extra.err).toMatch(/reconnect takes no arguments/);
    expect(daemon.methods).toEqual([]);
  });
});

describe('wgpt daemon secret', () => {
  it('reports presence only, and never echoes the value back', async () => {
    const daemon = await startFakeDaemon();
    const before = await invoke(['daemon', 'secret', 'status', '--data-dir', daemon.dataDir, '--json']);
    expect(before.code).toBe(0);
    expect(jsonLine(before.out)).toMatchObject({ keys: [{ key: 'openaiApiKey', present: false }] });

    const secret = 'sk-do-not-echo-me';
    const stored = await invoke(['daemon', 'secret', 'set', 'openaiApiKey', secret, '--data-dir', daemon.dataDir, '--json']);
    expect(stored.code).toBe(0);
    expect(jsonLine(stored.out)).toMatchObject({ keys: [{ key: 'openaiApiKey', present: true }] });
    // The whole point: the report says the credential exists and never repeats it.
    expect(stored.out).not.toContain(secret);
    expect(daemon.secretRequests).toEqual([
      { action: 'status' },
      { action: 'set', key: 'openaiApiKey', value: secret }
    ]);

    const cleared = await invoke(['daemon', 'secret', 'clear', 'openaiApiKey', '--data-dir', daemon.dataDir, '--json']);
    expect(cleared.code).toBe(0);
    expect(jsonLine(cleared.out)).toMatchObject({ keys: [{ key: 'openaiApiKey', present: false }] });
  });

  it('shows an unavailable credential store, and refuses an unknown key locally', async () => {
    const daemon = await startFakeDaemon();
    daemon.storageUnavailable('No WGPT_SECRET_KEY is set');
    const status = await invoke(['daemon', 'secret', 'status', '--data-dir', daemon.dataDir, '--json']);
    expect(status.code).toBe(0);
    expect(jsonLine(status.out)).toMatchObject({
      storage: { available: false, detail: 'No WGPT_SECRET_KEY is set' }
    });

    const unknown = await invoke(['daemon', 'secret', 'set', 'bridgeToken', 'x', '--data-dir', daemon.dataDir]);
    expect(unknown.code).toBe(2);
    expect(unknown.err).toMatch(/unknown secret bridgeToken/);
    // A local mistake never reaches the daemon: the only request it ever saw was the status read.
    expect(daemon.secretRequests).toEqual([{ action: 'status' }]);
  });
});

describe('wgpt daemon command grammar', () => {
  it('rejects a missing, unknown or malformed daemon command', async () => {
    const dataDir = await makeDataDir();
    const missing = await invoke(['daemon', '--data-dir', dataDir]);
    expect(missing.code).toBe(2);
    expect(missing.err).toMatch(/requires a command/);

    const unknown = await invoke(['daemon', 'restart', '--data-dir', dataDir]);
    expect(unknown.code).toBe(2);
    expect(unknown.err).toMatch(/unknown daemon command: restart/);

    const positional = await invoke(['daemon', 'status', 'extra', '--data-dir', dataDir]);
    expect(positional.code).toBe(2);
    expect(positional.err).toMatch(/takes no positional arguments/);

    const flagless = await invoke(['daemon', 'status']);
    expect(flagless.code).toBe(2);
    expect(flagless.err).toMatch(/--data-dir <absolute-path> is required/);

    const relative = await invoke(['daemon', 'status', '--data-dir', 'relative/path']);
    expect(relative.code).toBe(2);
  });

  it('keeps the work and host commands intact alongside it', async () => {
    const help = await invoke(['--help']);
    expect(help.code).toBe(0);
    expect(help.out).toMatch(/wgpt daemon serve\|start\|status\|stop/);
    expect(help.out).toMatch(/wgpt work list/);
    expect(help.out).toMatch(/wgpt host status/);
  });
});

describe('daemon lifecycle module', () => {
  it('claims an unowned directory and reports no owner', async () => {
    const dataDir = await makeDataDir();
    expect(await ownerForDataDir(dataDir)).toBeNull();
    expect(await claimDataDir(dataDir)).toBeNull();
  });

  it('reports the running daemon from the claim, so start never launches a second one', async () => {
    const daemon = await startFakeDaemon();
    await expect(claimDataDir(daemon.dataDir)).resolves.toMatchObject({ instance_id: daemon.instanceId });
  });

  it('requires an instance id, and refuses a daemon answer without one', async () => {
    const daemon = await startFakeDaemon();
    daemon.answerAs('');
    await expect(requireDaemon(daemon.dataDir)).rejects.toMatchObject({
      code: DAEMON_ERROR_CODES.daemonUnavailable
    });
  });

  it('reports a data-directory conflict for a directory the desktop app owns', async () => {
    const dataDir = await makeDataDir();
    await startFakeDesktopHost(dataDir);
    await expect(claimDataDir(dataDir)).rejects.toMatchObject({ code: DAEMON_ERROR_CODES.dataDirConflict });
    await expect(stopDaemon(dataDir)).rejects.toMatchObject({ code: DAEMON_ERROR_CODES.daemonUnavailable });
  });
});
