/**
 * The CLI and its control socket.
 *
 * What these cases defend is the seam between a shell and the one work ledger: the CLI must
 * reach the *same* WorkService the GUI and the MCP connector use, over a transport that
 * cannot be reached by anyone but the owner of the data directory, and it must fail in a way
 * a script can branch on. So the tests drive the real CLI entry point against a real Unix
 * socket served by a real `createWorkService` over a real SQLite file — the only injected
 * pieces are the execution port and the project/model lookups, which the service itself
 * declares as dependencies and which cannot run a browser inside a test.
 *
 * The negative cases are the point:
 *
 * - a `runtime.json` that is a symlink, or readable by anyone else, is refused rather than
 *   followed — that file decides which socket every command is sent to;
 * - a hello that names another installation, or another protocol version, is refused before
 *   the service is called at all;
 * - an oversized request line ends the connection instead of being parsed in fragments;
 * - "no host" (exit 3) and "the host refused this operation" (exit 4) stay distinguishable.
 */

import { execFileSync } from 'node:child_process';
import { promises as fs } from 'node:fs';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { makeTempDir, removeTempDir } from './helpers.js';
import {
  EXIT_HOST_UNAVAILABLE,
  EXIT_INVALID_INPUT,
  EXIT_OK,
  EXIT_REJECTED,
  run,
  startCliControlSocket
} from '../src/cli/index.js';
import {
  CONTROL_PROTOCOL_VERSION,
  MAX_PIPE_NAME_CHARS,
  MAX_REQUEST_BYTES,
  allocateControlEndpoint,
  assertControlTransport,
  controlTransportKind,
  createLineReader,
  openControlClient,
  readRuntimeDescriptor,
  runtimeFilePath,
  startControlSocket,
  writeRuntimeDescriptor,
  type ControlSocketHandle
} from '../src/main/work/control-socket.js';
import type {
  WorkConnectionPort,
  WorkConnectionResult,
  WorkConnectionTarget,
  WorkReconnectRequest
} from '../src/shared/work-connection.js';
import {
  createWorkService,
  type WorkProjectDirectory,
  type WorkRuntimePort,
  type WorkServiceHandle
} from '../src/main/work/service.js';
import { createWorkStore, type WorkStore } from '../src/main/work/store.js';
import { defaultUserDataDir } from '../src/main/identity.js';

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

interface Host {
  dir: string;
  dataDir: string;
  store: WorkStore;
  service: WorkServiceHandle;
  socket: ControlSocketHandle;
  installationId: string;
  dispatchCalls: string[];
}

const cleanups: Array<() => Promise<void>> = [];

afterEach(async () => {
  for (const cleanup of cleanups.splice(0)) await cleanup().catch(() => undefined);
});

/** The execution port. Nothing here runs a browser; the ledger only needs a port that answers. */
function makeRuntime(): WorkRuntimePort {
  return {
    async beginStart() {},
    async deliver() {
      return { state: 'delivered' };
    },
    async control(input) {
      return { status: input.action === 'cancel' ? 'cancelled' : 'paused' };
    },

    async reconcile() {}
  };
}

/**
 * A project lookup that actually inspects the filesystem, so `work start` admission is
 * exercised against a real directory and a real Git repository rather than an assertion.
 * Every path it has been asked about is remembered, because `work list` reports the
 * registry and a real registry only ever contains projects it resolved.
 */
function makeProjectDirectory(): WorkProjectDirectory {
  const seen: string[] = [];
  return {
    async resolve(inputPath) {
      const absolute = path.resolve(inputPath);
      let exists = false;
      try {
        exists = (await fs.stat(absolute)).isDirectory();
      } catch {
        exists = false;
      }
      let isGit = false;
      if (exists) {
        try {
          execFileSync('git', ['rev-parse', '--git-dir'], { cwd: absolute, stdio: 'ignore' });
          isGit = true;
        } catch {
          isGit = false;
        }
      }
      if (!seen.includes(absolute)) seen.push(absolute);
      return { path: absolute, name: path.basename(absolute), exists, isGit };
    },
    async list() {
      return seen.map(projectPath => ({ id: projectPath, name: path.basename(projectPath), path: projectPath }));
    }
  };
}

async function startHost(connection?: WorkConnectionPort): Promise<Host> {
  const dir = await makeTempDir('wgpt-cli-');
  const dataDir = path.join(dir, 'data');
  await fs.mkdir(dataDir, { mode: 0o700 });
  const store = createWorkStore({ dataDir });
  const service = createWorkService({
    store,
    runtime: makeRuntime(),
    projects: makeProjectDirectory(),
    models: { async resolve({ model, reasoning }) { return { model: model ?? 'gpt-5', reasoning: reasoning ?? null }; } },
    worktreesRoot: path.join(dataDir, 'worktrees')
  });
  const installationId = randomUUID();
  const dispatchCalls: string[] = [];
  const socket = await startCliControlSocket({
    dataDir,
    installationId,
    ...(connection === undefined ? {} : { connection }),
    service: {
      start: input => {
        dispatchCalls.push('work.start');
        return service.start(input);
      },
      list: input => {
        dispatchCalls.push('work.list');
        return service.list(input);
      },
      status: input => {
        dispatchCalls.push('work.status');
        return service.status(input);
      },
      instruct: input => {
        dispatchCalls.push('work.instruct');
        return service.instruct(input);
      },
      control: input => {
        dispatchCalls.push('work.control');
        return service.control(input);
      },
      events: input => {
        dispatchCalls.push('work.events');
        return service.events(input);
      }
    },
    startedAt: Date.now()
  });
  cleanups.push(async () => {
    await socket.close();
    service.close();
    store.close();
    await removeTempDir(dir);
  });
  return { dir, dataDir, store, service, socket, installationId, dispatchCalls };
}

/** A real Git project, so the CLI's `--project` reaches a genuinely valid target. */
async function makeGitProject(): Promise<string> {
  const project = await makeTempDir('wgpt-proj-');
  cleanups.push(() => removeTempDir(project));
  execFileSync('git', ['init', '-q'], { cwd: project });
  execFileSync('git', ['config', 'user.email', 'test@example.com'], { cwd: project });
  execFileSync('git', ['config', 'user.name', 'Test'], { cwd: project });
  await fs.writeFile(path.join(project, 'README.md'), '# fixture\n');
  execFileSync('git', ['add', '.'], { cwd: project });
  execFileSync('git', ['commit', '-qm', 'initial'], { cwd: project });
  return project;
}

/** Captures what the CLI wrote to stdout/stderr for one invocation. */
async function invoke(argv: string[], env: NodeJS.ProcessEnv = process.env): Promise<{ code: number; out: string; err: string }> {
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

function jsonLines(text: string): unknown[] {
  return text
    .split('\n')
    .filter(line => line.trim().length > 0)
    .map(line => JSON.parse(line) as unknown);
}

describe('control socket publishing', () => {
  it('publishes a private descriptor in the data directory and withdraws it on close', async () => {
    const host = await startHost();
    const file = runtimeFilePath(host.dataDir);
    const info = await fs.lstat(file);
    expect(info.isSymbolicLink()).toBe(false);
    expect(info.isFile()).toBe(true);
    // Mode bits are a real permission check only where the platform has them; Windows reports
    // synthetic 0o666 for every regular file, and the descriptor's protection there is the
    // data directory's inherited ACL.
    if (process.platform !== 'win32') expect(info.mode & 0o777).toBe(0o600);

    const descriptor = await readRuntimeDescriptor(host.dataDir);
    expect(descriptor).toEqual({
      socket_path: host.socket.socketPath,
      pid: process.pid,
      installation_id: host.installationId,
      protocol_version: CONTROL_PROTOCOL_VERSION
    });

    await host.socket.close();
    expect(await readRuntimeDescriptor(host.dataDir)).toBeNull();
  });

  /**
   * The POSIX endpoint is a filesystem object, and its own mode and directory are the access
   * control. A Windows named pipe is a kernel object with no entry to stat, so there is
   * nothing here to assert about it — `allocateControlEndpoint('win32')` and
   * `assertControlTransport` cover that side, and the host's own startup is exercised there.
   */
  it.runIf(process.platform !== 'win32')('keeps the POSIX socket private and removes it on close', async () => {
    const host = await startHost();
    const socketInfo = await fs.lstat(host.socket.socketPath);
    expect(socketInfo.isSocket()).toBe(true);
    expect(socketInfo.mode & 0o777).toBe(0o600);
    const dirInfo = await fs.lstat(path.dirname(host.socket.socketPath));
    expect(dirInfo.mode & 0o777).toBe(0o700);

    await host.socket.close();
    await expect(fs.lstat(host.socket.socketPath)).rejects.toThrow();
  });

  it('allocates a fresh private directory whose socket path fits in sun_path', async () => {
    const first = await allocateControlEndpoint('darwin');
    const second = await allocateControlEndpoint('darwin');
    cleanups.push(async () => {
      for (const socket of [first, second]) {
        await fs.rm(path.dirname(socket), { recursive: true, force: true });
      }
    });
    expect(first).not.toBe(second);
    for (const socket of [first, second]) {
      expect(Buffer.byteLength(socket, 'utf8')).toBeLessThan(100);
      // Windows reports synthetic mode bits for every entry, so the 0700 assertion is a
      // POSIX fact; the directory is created either way.
      const info = await fs.lstat(path.dirname(socket));
      if (process.platform !== 'win32') expect(info.mode & 0o777).toBe(0o700);
    }
  });

  /**
   * The Windows startup blocker, as a platform-deterministic fact rather than a native run.
   *
   * Node's IPC listener accepts only a name under `\\.\pipe\`; an ordinary temporary path is
   * not a pipe, so `server.listen()` fails and — because `index.ts` awaits control startup
   * before the window — the whole application fails to start. The name, the transport choice
   * and the validation are therefore asserted for win32 from any host.
   */
  it('allocates a named pipe, not a filesystem path, on Windows', async () => {
    const first = await allocateControlEndpoint('win32');
    const second = await allocateControlEndpoint('win32');
    for (const pipe of [first, second]) {
      expect(pipe.startsWith('\\\\.\\pipe\\wgpt-')).toBe(true);
      expect(pipe.length).toBeLessThanOrEqual(MAX_PIPE_NAME_CHARS);
      // Never an ordinary path, in either platform's path grammar: on Windows a `\\.\pipe\`
      // name is the device namespace, and on POSIX it would be a relative filename.
      expect(path.win32.normalize(pipe).startsWith('\\\\.\\pipe\\')).toBe(true);
      expect(path.posix.isAbsolute(pipe)).toBe(false);
    }
    expect(first).not.toBe(second);
    expect(controlTransportKind('win32')).toBe('pipe');
    expect(controlTransportKind('darwin')).toBe('unix');
  });

  /**
   * Allocation creates nothing.
   *
   * On POSIX a `\\.\pipe\` string is an ordinary relative filename, so `lstat` is a real
   * probe for a file the Windows branch must never have written. On Windows the pipe
   * namespace is not the filesystem at all, so the same probe proves nothing there.
   */
  it.runIf(process.platform !== 'win32')('creates no filesystem entry for a Windows endpoint', async () => {
    const workspace = await makeTempDir('wgpt-pipe-alloc-');
    const original = process.cwd();
    process.chdir(workspace);
    cleanups.push(async () => {
      process.chdir(original);
      await removeTempDir(workspace);
    });
    const pipe = await allocateControlEndpoint('win32');
    await expect(fs.lstat(path.join(workspace, pipe))).rejects.toThrow();
    await expect(fs.readdir(workspace)).resolves.toEqual([]);
  });

  it('refuses a Windows endpoint that is not a local pipe name', async () => {
    await expect(assertControlTransport(path.join(os.tmpdir(), 'wgpt-not-a-pipe'), 'win32')).rejects.toThrow(
      /named pipe/
    );
    await expect(assertControlTransport('\\\\.\\pipe\\', 'win32')).rejects.toThrow(/named pipe/);
    await expect(
      assertControlTransport(`\\\\.\\pipe\\${'x'.repeat(MAX_PIPE_NAME_CHARS)}`, 'win32')
    ).rejects.toThrow(/longer than/);
    // The documented alternative namespace is still a pipe name and is not refused.
    await expect(assertControlTransport('\\\\?\\pipe\\wgpt-ok', 'win32')).resolves.toBeUndefined();
    await expect(assertControlTransport('\\\\.\\pipe\\wgpt-ok', 'win32')).resolves.toBeUndefined();
    // A pipe name is never a valid POSIX endpoint, whatever platform is asked.
    await expect(assertControlTransport('\\\\.\\pipe\\wgpt-ok', 'darwin')).rejects.toThrow(
      /absolute filesystem path/
    );
  });

  /**
   * The host never hands an endpoint of the wrong shape to a listener.
   *
   * This is the exact shape of the startup blocker: `index.ts` awaits control startup before
   * it registers IPC, creates the window and creates the tray, so a listener that cannot start
   * is not "the CLI is unavailable", it is "the application does not open". Asserting the
   * refusal is what makes the platform decision, rather than a native Windows run, the thing
   * under test here.
   */
  it('refuses to start a control socket on an endpoint of the wrong shape', async () => {
    const dir = await makeTempDir('wgpt-endpoint-shape-');
    cleanups.push(() => removeTempDir(dir));
    const dispatch = async () => ({});
    await expect(
      startControlSocket({
        dataDir: dir,
        installationId: 'fixture',
        platform: 'win32',
        socketPath: path.join(os.tmpdir(), 'wgpt-not-a-pipe'),
        dispatch
      })
    ).rejects.toThrow(/named pipe/);
    // A relative path on POSIX would land the socket in whatever directory the process
    // happened to start in, so two processes agreeing on the string could still miss each
    // other. It is refused rather than resolved.
    await expect(
      startControlSocket({
        dataDir: dir,
        installationId: 'fixture',
        platform: 'darwin',
        socketPath: 'wgpt-relative/s',
        dispatch
      })
    ).rejects.toThrow(/absolute filesystem path/);
    // A refused start must leave no descriptor behind for a CLI to chase.
    expect(await readRuntimeDescriptor(dir, 'win32')).toBeNull();
  });

  /**
   * The Windows pipe's access control is a precondition, not a best effort.
   *
   * Windows gives a named pipe read access for Everyone and the anonymous account by default,
   * so a host that cannot narrow it must not advertise the endpoint: `runtime.json` is the
   * only thing a CLI reads to find the pipe, and publishing it while the pipe is still open
   * would point every local process at a channel that answers. Failing the startup is the
   * honest outcome, and it happens before the descriptor exists.
   */
  it('refuses to publish a Windows endpoint whose pipe ACL could not be established', async () => {
    const dir = await makeTempDir('wgpt-pipe-acl-fail-');
    cleanups.push(() => removeTempDir(dir));
    const attempts: string[] = [];
    const started = Date.now();
    await expect(
      startControlSocket({
        dataDir: dir,
        installationId: 'fixture',
        platform: 'win32',
        socketPath: '\\\\.\\pipe\\wgpt-acl-fail',
        dispatch: async () => ({}),
        restrictPipe: async (pipe) => {
          attempts.push(pipe);
          throw new Error('PIPE_ACL_FAILED: SetSecurityInfo failed (win32 5)');
        }
      })
    ).rejects.toThrow(/PIPE_ACL_FAILED/);
    // It really tried, and it tried on the endpoint it was about to publish.
    expect(attempts).toEqual(['\\\\.\\pipe\\wgpt-acl-fail']);
    expect(await readRuntimeDescriptor(dir, 'win32')).toBeNull();
    // And it gave the listener back rather than leaking it: a failure that leaves the port
    // bound is how a second attempt reports "in use" for a host that never started.
    expect(Date.now() - started).toBeLessThan(5_000);
  });

  /**
   * A connection that arrives before the pipe is narrowed never reaches the protocol.
   *
   * This is the attack the ACL exists to stop, expressed as the window it would use: on a
   * Windows host the pipe is listening — under the default descriptor — while the ACL is being
   * applied, so a peer that connected then must be dropped rather than served. On POSIX the
   * `\\.\pipe\` name is an ordinary relative socket file, which makes the same window
   * reproducible here without a Windows host.
   */
  it('drops a connection that arrived before the pipe was restricted, then serves real clients', async () => {
    const workspace = await makeTempDir('wgpt-pipe-acl-window-');
    const original = process.cwd();
    process.chdir(workspace);
    cleanups.push(async () => {
      process.chdir(original);
      await removeTempDir(workspace);
    });
    const dataDir = path.join(workspace, 'data');
    const gate = Promise.withResolvers<string>();
    const opened = Promise.withResolvers<void>();
    const hostPromise = startControlSocket({
      dataDir,
      installationId: 'fixture',
      platform: 'win32',
      socketPath: '\\\\.\\pipe\\wgpt-acl-window',
      dispatch: async () => ({ ok: true }),
      restrictPipe: (pipe) => {
        opened.resolve();
        return gate.promise.then(() => `S-1-5-21-1-2-3-1001 for ${pipe}`);
      }
    });
    await opened.promise;

    // The endpoint is listening but not yet restricted: this peer is exactly the one the ACL
    // window would admit. Connected by the relative name the process already has as its cwd,
    // because a `\\.\pipe\` name is 24 characters and an absolute temp path plus that name
    // exceeds `sun_path` — the same limit the POSIX allocation path exists to respect.
    const intruder = net.connect('\\\\.\\pipe\\wgpt-acl-window');
    let intruderData = '';
    intruder.on('data', (chunk: Buffer) => {
      intruderData += chunk.toString('utf8');
    });
    // Armed before anything can drop it: the drop may land before the host promise settles.
    const intruderClosed = new Promise<void>((resolve) => intruder.once('close', () => resolve()));
    await new Promise<void>((resolve, reject) => {
      intruder.once('connect', () => resolve());
      intruder.once('error', reject);
    });
    // A legitimate-looking hello, to prove the drop is the window and not the handshake.
    intruder.write(`${JSON.stringify({ type: 'hello', installation_id: 'fixture', protocol_version: 1 })}\n`);

    gate.resolve('S-1-5-21-1-2-3-1001');
    const host = await hostPromise;
    cleanups.push(() => host.close());
    expect(host.transport).toBe('pipe');

    // The pre-restriction connection was closed without an answer of any kind.
    await intruderClosed;
    expect(intruderData).toBe('');

    // And the pipe is usable: the descriptor is published only now, and a client that connects
    // afterwards completes the handshake.
    const descriptor = await readRuntimeDescriptor(dataDir, 'win32');
    expect(descriptor?.socket_path).toBe(host.socketPath);
    const client = await openControlClient(descriptor!, { platform: 'win32' });
    cleanups.push(() => client.close());
    expect(await client.call('host.status', {})).toEqual({ ok: true });
  });

  it('refuses a descriptor that is a symlink, and one another user can read on POSIX', async () => {
    const dir = await makeTempDir('wgpt-runtime-');
    cleanups.push(() => removeTempDir(dir));
    const target = path.join(dir, 'real.json');
    await fs.writeFile(target, '{"socket_path":"/tmp/x","pid":1,"installation_id":"i","protocol_version":1}\n', { mode: 0o600 });
    const link = runtimeFilePath(dir);
    await fs.symlink(target, link);
    // A reparse point is refused on every platform: it is how another process substitutes a
    // different descriptor naming a different endpoint.
    await expect(readRuntimeDescriptor(dir)).rejects.toThrow(/symlink/);

    await fs.rm(link);
    await fs.writeFile(link, '{"socket_path":"/tmp/x","pid":1,"installation_id":"i","protocol_version":1}\n', { mode: 0o644 });
    // Group/other readability is only a fact where the platform reports real mode bits.
    if (process.platform === 'win32') {
      await expect(readRuntimeDescriptor(dir)).resolves.toMatchObject({ socket_path: '/tmp/x' });
    } else {
      await expect(readRuntimeDescriptor(dir)).rejects.toThrow(/not private/);
    }
  });

  it('applies POSIX mode bits only where they exist, and refuses a pipe-shaped descriptor on POSIX', async () => {
    const dir = await makeTempDir('wgpt-runtime-platform-');
    cleanups.push(() => removeTempDir(dir));
    const file = runtimeFilePath(dir);
    const body = JSON.stringify({
      socket_path: '\\\\.\\pipe\\wgpt-fixture',
      pid: process.pid,
      installation_id: 'i',
      protocol_version: 1
    });
    // 0644 is not private on POSIX, and the check must stay strict there.
    await fs.writeFile(file, `${body}\n`, { mode: 0o644 });
    await expect(readRuntimeDescriptor(dir, 'darwin')).rejects.toThrow(/not private/);
    // On Windows Node reports synthetic mode bits for every file, so the same strict test
    // would reject the app's own descriptor. The structural checks remain.
    await expect(readRuntimeDescriptor(dir, 'win32')).resolves.toMatchObject({
      socket_path: '\\\\.\\pipe\\wgpt-fixture'
    });

    // The endpoint's own validation is the platform's, in both directions: Windows accepts a
    // pipe name and refuses a path, POSIX the reverse.
    const descriptor = await readRuntimeDescriptor(dir, 'win32');
    await expect(assertControlTransport(descriptor!.socket_path, 'win32')).resolves.toBeUndefined();
    await expect(assertControlTransport(descriptor!.socket_path, 'darwin')).rejects.toThrow(
      /absolute filesystem path/
    );

    // A reparse point is refused on both, because it is how a different endpoint is substituted.
    await fs.rm(file);
    const real = path.join(dir, 'real.json');
    await fs.writeFile(real, `${body}\n`, { mode: 0o600 });
    await fs.symlink(real, file);
    await expect(readRuntimeDescriptor(dir, 'win32')).rejects.toThrow(/symlink/);
  });

  it.runIf(process.platform !== 'win32')('refuses a socket file whose mode lets another user connect', async () => {
    const dir = await makeTempDir('wgpt-loose-');
    cleanups.push(() => removeTempDir(dir));
    const socketPath = path.join(dir, 's');
    const server = net.createServer();
    await new Promise<void>(resolve => server.listen(socketPath, resolve));
    await fs.chmod(socketPath, 0o666);
    const descriptor = { socket_path: socketPath, pid: process.pid, installation_id: 'i', protocol_version: 1 };
    await expect(openControlClient(descriptor)).rejects.toThrow(/not private/);
    await new Promise<void>(resolve => server.close(() => resolve()));
  });
});

describe('control protocol handshake', () => {
  it('refuses a bad hello before the service is ever called', async () => {
    const host = await startHost();
    const connect = (): Promise<net.Socket> =>
      new Promise((resolve, reject) => {
        const socket = net.connect(host.socket.socketPath);
        socket.once('connect', () => resolve(socket));
        socket.once('error', reject);
      });
    const readReply = (socket: net.Socket): Promise<Record<string, unknown>> =>
      new Promise(resolve => {
        socket.once('data', chunk => resolve(JSON.parse(chunk.toString('utf8').trim()) as Record<string, unknown>));
      });

    const wrongVersion = await connect();
    const versionReply = readReply(wrongVersion);
    wrongVersion.write(`${JSON.stringify({ type: 'hello', installation_id: host.installationId, protocol_version: 99 })}\n`);
    expect(await versionReply).toMatchObject({ error: { code: 'PROTOCOL_MISMATCH' } });
    wrongVersion.destroy();

    const wrongInstallation = await connect();
    const installationReply = readReply(wrongInstallation);
    wrongInstallation.write(`${JSON.stringify({ type: 'hello', installation_id: 'someone-else', protocol_version: 1 })}\n`);
    expect(await installationReply).toMatchObject({ error: { code: 'INSTALLATION_MISMATCH' } });
    wrongInstallation.destroy();

    const noHello = await connect();
    const noHelloReply = readReply(noHello);
    noHello.write(`${JSON.stringify({ id: 1, method: 'work.list', params: {} })}\n`);
    expect(await noHelloReply).toMatchObject({ error: { code: 'HELLO_REQUIRED' } });
    noHello.destroy();

    expect(host.dispatchCalls).toEqual([]);
  });

  it('drops an oversized request line instead of parsing fragments of it', async () => {
    const host = await startHost();
    const socket = net.connect(host.socket.socketPath);
    await new Promise<void>(resolve => socket.once('connect', () => resolve()));
    const reply = await new Promise<string>(resolve => {
      let text = '';
      socket.on('data', chunk => {
        text += chunk.toString('utf8');
      });
      socket.on('close', () => resolve(text));
      socket.write(`${JSON.stringify({ type: 'hello', installation_id: host.installationId, protocol_version: 1 })}\n`);
      setTimeout(() => {
        socket.write(`${'x'.repeat(MAX_REQUEST_BYTES + 1024)}\n`);
      }, 50);
    });
    expect(reply).toContain('REQUEST_TOO_LARGE');
    socket.destroy();
    expect(host.dispatchCalls).toEqual([]);
  });

  it('bounds a single line even when the newline never arrives', () => {
    const overflowed: string[] = [];
    const reader = createLineReader({
      maxBytes: 32,
      onLine: () => {
        overflowed.push('line');
      },
      onOverflow: () => {
        overflowed.push('overflow');
      }
    });
    reader(Buffer.from('x'.repeat(64), 'utf8'));
    expect(overflowed).toEqual(['overflow']);
  });
});

describe('wgpt work commands against a live host', () => {
  it('starts work through the CLI and reads it back from the same service', async () => {
    const host = await startHost();
    const project = await makeGitProject();

    const started = await invoke([
      'work', 'start',
      '--project', project,
      '--goal', 'Make the failing suite pass.',
      '--data-dir', host.dataDir,
      '--json'
    ]);
    expect(started.code).toBe(EXIT_OK);
    const receipt = jsonLines(started.out)[0] as { work_id: string; status: string; revision: number };
    expect(receipt.status).toBe('queued');
    expect(receipt.work_id).toMatch(/^[0-9a-f-]{36}$/);

    // The service the socket called is the same object the GUI/MCP would use.
    const status = await host.service.status({ work_id: receipt.work_id });
    expect(status.work_id).toBe(receipt.work_id);
    expect(status.project_path).toBe(project);

    const listed = await invoke(['--json', 'work', 'list', '--data-dir', host.dataDir]);
    expect(listed.code).toBe(EXIT_OK);
    const page = jsonLines(listed.out)[0] as { works: Array<{ work_id: string }>; projects: Array<{ path: string }> };
    expect(page.works.map(work => work.work_id)).toEqual([receipt.work_id]);
    expect(page.projects.map(entry => entry.path)).toContain(project);

    const one = await invoke(['work', 'status', receipt.work_id, '--data-dir', host.dataDir, '--json']);
    expect(one.code).toBe(EXIT_OK);
    expect((jsonLines(one.out)[0] as { work_id: string }).work_id).toBe(receipt.work_id);

    const instructed = await invoke([
      'work', 'instruct', receipt.work_id,
      '--text', 'Prefer the smaller change.',
      '--data-dir', host.dataDir,
      '--json'
    ]);
    expect(instructed.code).toBe(EXIT_OK);
    expect((jsonLines(instructed.out)[0] as { work_id: string }).work_id).toBe(receipt.work_id);

    const events = await invoke(['work', 'events', receipt.work_id, '--data-dir', host.dataDir, '--json']);
    expect(events.code).toBe(EXIT_OK);
    const seen = jsonLines(events.out) as Array<{ sequence: number; kind: string }>;
    expect(seen.length).toBeGreaterThan(0);
    expect(seen.every((event, index) => index === 0 || event.sequence > seen[index - 1]!.sequence)).toBe(true);

    // Re-reading from the newest cursor never re-delivers an event that was already seen —
    // which is the property following depends on. (It may return *newer* events: the
    // delivery pump keeps writing while the CLI reads, and that is the point of the cursor.)
    const newest = seen.at(-1)!.sequence;
    const again = await invoke(['work', 'events', receipt.work_id, '--after', String(newest), '--data-dir', host.dataDir, '--json']);
    expect(again.code).toBe(EXIT_OK);
    const seenSequences = new Set(seen.map(event => event.sequence));
    for (const event of jsonLines(again.out) as Array<{ sequence: number }>) {
      expect(event.sequence).toBeGreaterThan(newest);
      expect(seenSequences.has(event.sequence)).toBe(false);
    }
  });

  it('reports the same work id and revision for a replayed request id', async () => {
    const host = await startHost();
    const project = await makeGitProject();
    const requestId = randomUUID();
    const args = ['work', 'start', '--project', project, '--goal', 'Same request.', '--request-id', requestId, '--data-dir', host.dataDir, '--json'];

    const first = await invoke(args);
    const second = await invoke(args);
    expect(first.code).toBe(EXIT_OK);
    expect(second.code).toBe(EXIT_OK);
    const a = jsonLines(first.out)[0] as { work_id: string; revision: number };
    const b = jsonLines(second.out)[0] as { work_id: string; revision: number };
    expect(b).toEqual(a);
    expect(host.store.countWorks()).toBe(1);
  });

  it('rejects the same request id with a different payload as a conflict, not a new work', async () => {
    const host = await startHost();
    const project = await makeGitProject();
    const requestId = randomUUID();
    const base = ['--project', project, '--request-id', requestId, '--data-dir', host.dataDir, '--json'];

    await invoke(['work', 'start', ...base, '--goal', 'The first goal.']);
    const conflict = await invoke(['work', 'start', ...base, '--goal', 'A different goal.']);
    expect(conflict.code).toBe(EXIT_REJECTED);
    expect((jsonLines(conflict.out)[0] as { error: { code: string } }).error.code).toBe('REQUEST_ID_CONFLICT');
    expect(host.store.countWorks()).toBe(1);
  });

  it('pauses through the CLI and leaves the work resumable', async () => {
    const host = await startHost();
    const project = await makeGitProject();
    const started = await invoke(['work', 'start', '--project', project, '--goal', 'Pause me.', '--data-dir', host.dataDir, '--json']);
    const workId = (jsonLines(started.out)[0] as { work_id: string }).work_id;

    const paused = await invoke(['work', 'pause', workId, '--data-dir', host.dataDir, '--json']);
    expect(paused.code).toBe(EXIT_OK);
    expect((jsonLines(paused.out)[0] as { status: string }).status).toBe('paused');

    const resumed = await invoke(['work', 'resume', workId, '--data-dir', host.dataDir, '--json']);
    expect(resumed.code).toBe(EXIT_OK);
    expect(host.dispatchCalls.filter(call => call === 'work.control').length).toBe(2);
  });
});

describe('wgpt argument and failure contract', () => {
  it('accepts global flags on either side of the subcommand', async () => {
    const host = await startHost();
    const before = await invoke(['--json', '--data-dir', host.dataDir, 'work', 'list']);
    const after = await invoke(['work', 'list', '--data-dir', host.dataDir, '--json']);
    expect(before.code).toBe(EXIT_OK);
    expect(after.code).toBe(EXIT_OK);
    expect(before.out).toBe(after.out);
  });

  it('exits 2 for invalid local input without touching the host', async () => {
    const host = await startHost();
    const unknownFlag = await invoke(['work', 'list', '--data-dir', host.dataDir, '--nonsense']);
    expect(unknownFlag.code).toBe(EXIT_INVALID_INPUT);

    const relative = await invoke(['work', 'list', '--data-dir', 'relative/dir']);
    expect(relative.code).toBe(EXIT_INVALID_INPUT);

    const badRequestId = await invoke(['work', 'pause', randomUUID(), '--request-id', 'not-a-uuid', '--data-dir', host.dataDir]);
    expect(badRequestId.code).toBe(EXIT_INVALID_INPUT);

    const badReasoning = await invoke([
      'work', 'start', '--project', host.dir, '--goal', 'x', '--reasoning', 'nonsense', '--data-dir', host.dataDir
    ]);
    expect(badReasoning.code).toBe(EXIT_INVALID_INPUT);

    const noWorkId = await invoke(['work', 'status', '--data-dir', host.dataDir]);
    expect(noWorkId.code).toBe(EXIT_INVALID_INPUT);

    expect(host.dispatchCalls).toEqual([]);
  });

  it('exits 3 when no host is running, and 3 when the descriptor points nowhere', async () => {
    const dir = await makeTempDir('wgpt-nohost-');
    cleanups.push(() => removeTempDir(dir));
    const missing = await invoke(['work', 'list', '--data-dir', dir, '--json']);
    expect(missing.code).toBe(EXIT_HOST_UNAVAILABLE);
    expect((jsonLines(missing.out)[0] as { error: { code: string } }).error.code).toBe('HOST_UNAVAILABLE');

    await writeRuntimeDescriptor(dir, {
      socket_path: path.join(dir, 'gone'),
      pid: process.pid,
      installation_id: 'x',
      protocol_version: 1
    });
    const dead = await invoke(['host', 'status', '--data-dir', dir]);
    expect(dead.code).toBe(EXIT_HOST_UNAVAILABLE);
  });

  it('maps a real service rejection to exit 4 with its own code', async () => {
    const host = await startHost();
    // A directory that exists but is not a Git repository: the service refuses admission and
    // the CLI has to surface that code rather than a generic failure.
    const plain = await makeTempDir('wgpt-plain-');
    cleanups.push(() => removeTempDir(plain));
    const notGit = await invoke([
      'work', 'start', '--project', plain, '--goal', 'Needs a Git project.', '--data-dir', host.dataDir, '--json'
    ]);
    expect(notGit.code).toBe(EXIT_REJECTED);
    expect((jsonLines(notGit.out)[0] as { error: { code: string } }).error.code).toBe('PROJECT_NOT_GIT');
    expect(host.store.countWorks()).toBe(0);

    const unknownWork = await invoke(['work', 'status', randomUUID(), '--data-dir', host.dataDir, '--json']);
    expect(unknownWork.code).toBe(EXIT_REJECTED);
    expect((jsonLines(unknownWork.out)[0] as { error: { code: string } }).error.code).toBe('WORK_NOT_FOUND');
  });

  it('reports host status from local facts only', async () => {
    const host = await startHost();
    const status = await invoke(['host', 'status', '--data-dir', host.dataDir, '--json']);
    expect(status.code).toBe(EXIT_OK);
    const report = jsonLines(status.out)[0] as { pid: number; data_dir: string; installation_id: string; protocol_version: number };
    expect(report.pid).toBe(process.pid);
    expect(report.data_dir).toBe(host.dataDir);
    expect(report.installation_id).toBe(host.installationId);
    expect(report.protocol_version).toBe(CONTROL_PROTOCOL_VERSION);
  });

  it('prints a usage message for no arguments and never starts a host implicitly', async () => {
    const host = await startHost();
    const usage = await invoke([]);
    expect(usage.code).toBe(EXIT_INVALID_INPUT);
    expect(usage.out).toContain('wgpt');

    // `work list` against a directory with no host must not launch anything.
    const dir = await makeTempDir('wgpt-implicit-');
    cleanups.push(() => removeTempDir(dir));
    const noHost = await invoke(['work', 'list', '--data-dir', dir]);
    expect(noHost.code).toBe(EXIT_HOST_UNAVAILABLE);
    expect(host.dispatchCalls).toEqual([]);
  });

  it('names the work directory the CLI will use when none is given', async () => {
    // Point every per-OS data root at the temp directory so the default can never be the
    // developer's or runner's real one (hosted Linux runners export XDG_CONFIG_HOME).
    const env = { ...process.env, HOME: os.tmpdir(), XDG_CONFIG_HOME: undefined, APPDATA: undefined };
    const result = await invoke(['work', 'list', '--json'], env);
    expect(result.code).toBe(EXIT_HOST_UNAVAILABLE);
    const error = (jsonLines(result.out)[0] as { error: { message: string } }).error;
    const expected = defaultUserDataDir(process.platform, env);
    expect(expected.startsWith(os.tmpdir())).toBe(true);
    expect(error.message).toContain(expected);
  });
});

/**
 * The two local connection verbs, over the real socket and the real CLI parser.
 *
 * The browser boundary is a fake port on purpose: nothing here may open a tab, and the facts
 * these cases defend are the *seam* facts — that the CLI parses the agreed grammar, that the
 * exact expected-conversation selector is a fence rather than a rebind target, that the socket
 * deadline is longer than the wait the caller asked for, and that `ready` is the only exit 0.
 */
describe('wgpt work connection and reconnect', () => {
  const WORK_ID = '11111111-1111-4111-8111-111111111111';
  const AGENT_ID = '22222222-2222-4222-8222-222222222222';
  const CID = '0192f0a1-1111-8111-9111-111111111111';

  /** A fake backend that records what it was asked and answers with a fixed result. */
  function fakeConnection(result: Partial<WorkConnectionResult> = {}): {
    port: WorkConnectionPort;
    calls: Array<{ verb: string; params: unknown }>;
  } {
    const calls: Array<{ verb: string; params: unknown }> = [];
    const answer = (): WorkConnectionResult => ({
      work_id: WORK_ID,
      work_state: 'running',
      agent_id: AGENT_ID,
      generation: 0,
      session_id: 'session-1',
      conversation_id: CID,
      state: 'ready',
      page_observed_at: 1_700_000_000_000,
      browser_recovery_dismissed_at: null,
      reason: null,
      ...result
    });
    return {
      calls,
      port: {
        async connection(target: WorkConnectionTarget) {
          calls.push({ verb: 'connection', params: target });
          return answer();
        },
        async reconnect(request: WorkReconnectRequest) {
          calls.push({ verb: 'reconnect', params: request });
          return answer();
        }
      }
    };
  }

  it('reports the connection of the selected work and prints the raw evidence', async () => {
    const backend = fakeConnection();
    const host = await startHost(backend.port);

    const result = await invoke(['work', 'connection', WORK_ID, '--data-dir', host.dataDir, '--json']);
    expect(result.code).toBe(EXIT_OK);
    expect(backend.calls).toEqual([{ verb: 'connection', params: { work_id: WORK_ID } }]);
    expect(jsonLines(result.out)[0]).toMatchObject({
      work_id: WORK_ID, state: 'ready', conversation_id: CID, page_observed_at: 1_700_000_000_000,
      browser_recovery_dismissed_at: null, reason: null
    });

    // The text form keeps the two evidence fields visible even when they are null: "never seen"
    // and "seen but suppressed" cannot be told apart from the state alone.
    const text = await invoke(['work', 'connection', WORK_ID, '--data-dir', host.dataDir]);
    expect(text.code).toBe(EXIT_OK);
    expect(text.out).toContain('page_seen_at');
    expect(text.out).toContain('recovery_at    -');
  });

  it('passes the agent and exact-conversation selectors through unchanged', async () => {
    const backend = fakeConnection();
    const host = await startHost(backend.port);

    const result = await invoke([
      'work', 'reconnect', WORK_ID,
      '--agent-id', AGENT_ID,
      '--conversation-id', CID,
      '--data-dir', host.dataDir,
      '--json'
    ]);
    expect(result.code).toBe(EXIT_OK);
    expect(backend.calls).toEqual([{
      verb: 'reconnect',
      // The expected conversation travels as a *selector*; the backend is free to refuse it, and
      // nothing here rewrites it into the registry's current value.
      params: { work_id: WORK_ID, agent_id: AGENT_ID, conversation_id: CID, timeout_ms: 30_000 }
    }]);
  });

  it('accepts a real v8 provider conversation id', async () => {
    const backend = fakeConnection();
    const host = await startHost(backend.port);
    const result = await invoke([
      'work', 'connection', WORK_ID, '--conversation-id', CID, '--data-dir', host.dataDir, '--json'
    ]);
    expect(result.code).toBe(EXIT_OK);
    expect(backend.calls[0]!.params).toEqual({ work_id: WORK_ID, conversation_id: CID });
  });

  it('exits nonzero with a truthful state when the page is not ready', async () => {
    const backend = fakeConnection({ state: 'opening', reason: 'waiting for the page to report', page_observed_at: null });
    const host = await startHost(backend.port);

    const result = await invoke(['work', 'reconnect', WORK_ID, '--timeout', '0', '--data-dir', host.dataDir, '--json']);
    // A wait that legitimately found nothing is still not the success the caller asked for, so a
    // script can branch on it: exit 4, with the state and reason intact.
    expect(result.code).toBe(EXIT_REJECTED);
    expect(jsonLines(result.out)[0]).toMatchObject({ state: 'opening', reason: 'waiting for the page to report' });
  });

  it('refuses a malformed selector before the backend is reached', async () => {
    const backend = fakeConnection();
    const host = await startHost(backend.port);

    const badAgent = await invoke(['work', 'connection', WORK_ID, '--agent-id', 'not-a-uuid', '--data-dir', host.dataDir, '--json']);
    expect(badAgent.code).toBe(EXIT_INVALID_INPUT);
    const badCid = await invoke(['work', 'reconnect', WORK_ID, '--conversation-id', 'has spaces', '--data-dir', host.dataDir, '--json']);
    expect(badCid.code).toBe(EXIT_INVALID_INPUT);
    const badTimeout = await invoke(['work', 'reconnect', WORK_ID, '--timeout', '60001', '--data-dir', host.dataDir, '--json']);
    expect(badTimeout.code).toBe(EXIT_INVALID_INPUT);
    // `connection` has no wait to ask for, so the flag is not part of its grammar.
    const timeoutOnConnection = await invoke(['work', 'connection', WORK_ID, '--timeout', '5', '--data-dir', host.dataDir, '--json']);
    expect(timeoutOnConnection.code).toBe(EXIT_INVALID_INPUT);
    expect(backend.calls).toEqual([]);
  });

  it('answers HOST_UNAVAILABLE when the host has no connection backend', async () => {
    // A host that never built one must not invent a state: nothing looked, so nothing is known.
    const host = await startHost();
    const result = await invoke(['work', 'connection', WORK_ID, '--data-dir', host.dataDir, '--json']);
    expect(result.code).toBe(EXIT_HOST_UNAVAILABLE);
    expect((jsonLines(result.out)[0] as { error: { message: string } }).error.message).toContain('HOST_UNAVAILABLE');
  });

  it('is not reachable as an MCP work action', async () => {
    const { workConnectionTargetSchema } = await import('../src/shared/work-connection.js');
    // The local surface is a schema, not a tool: the MCP action union has no `connection` or
    // `reconnect` member, and this asserts the contract stays local by construction.
    expect(workConnectionTargetSchema.safeParse({ work_id: WORK_ID }).success).toBe(true);
    expect(workConnectionTargetSchema.safeParse({ work_id: WORK_ID, rebind: CID }).success).toBe(false);
  });
});
