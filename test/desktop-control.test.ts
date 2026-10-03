import { randomUUID } from 'node:crypto';
import net from 'node:net';
import * as identity from '../src/main/identity.js';
import type { DesktopWindowOptions } from '../src/main/desktop-window.js';
import type { IpcReply } from '../src/main/ipc.js';
import { afterEach, expect, it, vi } from 'vitest';
import { makeTempDir, removeTempDir } from './helpers.js';
import { openControlClient, readRuntimeDescriptor, startControlSocket } from '../src/main/work/control-socket.js';

const overflowPeers = new Set<net.Socket>();
afterEach(() => { for (const peer of overflowPeers) peer.destroy(); overflowPeers.clear(); });

it.runIf(process.platform !== 'win32')('flushes overflow refusals and closes the host even while refused peers keep their write side open', async () => {
  const dir = await makeTempDir('wgpt-control-overflow-');
  const host = await startControlSocket({ dataDir: dir, installationId: randomUUID(), dispatch: async () => 'alive' });
  const accepted = [];
  try {
    expect(host.clients()).toBe(0);
    const descriptor = await readRuntimeDescriptor(dir);
    if (!descriptor) throw new Error('Fixture host was not published');
    for (let index = 0; index < 16; index += 1) accepted.push(await openControlClient(descriptor));
    expect(host.clients()).toBe(16);
    for (let index = 0; index < 24; index += 1) {
      const ended = Promise.withResolvers<string>();
      const peer = net.connect({ path: host.socketPath, allowHalfOpen: true });
      overflowPeers.add(peer);
      let reply = '';
      peer.on('data', chunk => { reply += chunk.toString('utf8'); });
      peer.once('error', ended.reject);
      peer.once('end', () => ended.resolve(reply));
      expect(JSON.parse(await ended.promise)).toEqual({ error: { code: 'TOO_MANY_CLIENTS', message: 'too many control clients' } });
      expect(host.clients()).toBe(16);
    }
    expect(await accepted[0]!.call('work.list')).toBe('alive');
    await Promise.all(accepted.map(client => client.close()));
    await host.close();
    expect(host.clients()).toBe(0);
  } finally {
    for (const peer of overflowPeers) peer.destroy();
    await Promise.all(accepted.map(client => client.close()));
    await host.close();
    await removeTempDir(dir);
  }
}, 2_000);

it('bounds real GUI sockets, admits concurrent reads and retires queued requests with their original renderer', async () => {
  const dir = await makeTempDir('wgpt-gui-admission-');
  const ready = Promise.withResolvers<void>();
  const handlers = new Map<string, (event: unknown, request: unknown) => Promise<IpcReply<unknown>>>();
  const appEvents = new Map<string, () => void>();
  let windowOptions: DesktopWindowOptions | undefined;
  const contents = { mainFrame: {} };
  const event = { sender: contents, senderFrame: contents.mainFrame };
  let entered = Promise.withResolvers<void>();
  let firstEntered = Promise.withResolvers<void>();
  let release = Promise.withResolvers<void>();
  const operations: Array<{ channel: string; payload: unknown; owner: string | null }> = [];
  let holding = true;
  let held = 0;
  const host = await startControlSocket({
    dataDir: dir, installationId: randomUUID(), authToken: randomUUID(),
    dispatch: async () => ({ pid: process.pid }),
    gui: {
      subscribe: () => () => undefined,
      invoke: async (channel, payload, owner) => {
        if (channel === 'tasks:plan') {
          operations.push({ channel, payload, owner });
          if (holding) {
            held++;
            if (held === 1) firstEntered.resolve();
            if (held === 8) entered.resolve();
            await release.promise;
          }
        }
        return { ok: true, data: payload };
      }
    }
  });
  vi.resetModules();
  vi.doMock('electron', () => ({
    app: { setPath: vi.fn(), requestSingleInstanceLock: () => true, quit: vi.fn(), whenReady: () => Promise.resolve(),
      on: (name: string, listener: () => void) => appEvents.set(name, listener) },
    dialog: { showErrorBox: vi.fn() },
    ipcMain: { handle: (name: string, handler: (event: unknown, request: unknown) => Promise<IpcReply<unknown>>) => handlers.set(name, handler) }
  }));
  vi.doMock('../src/main/identity.js', () => ({ ...identity, resolveDataDir: () => dir, ensurePrivateDir: vi.fn() }));
  vi.doMock('../src/main/desktop-window.js', () => ({ createDesktopWindow: (options: DesktopWindowOptions) => {
    windowOptions = options;
    return { getWindow: () => ({ isDestroyed: () => false, webContents: contents, isVisible: () => false }),
      update: vi.fn(), send: vi.fn(), dispose: vi.fn(), show: vi.fn(), bindLifecycle: () => ready.resolve() };
  } }));
  try {
    await import('../src/main/daemon-client.js');
    await ready.promise;
    if (!windowOptions) throw new Error('GUI did not start');
    const invoke = handlers.get('desktop:invoke');
    if (!invoke) throw new Error('GUI IPC did not register');
    windowOptions.rendererStarting?.();
    // View-owned IPC awaits the shared subscription lease before using an invocation slot.
    await expect(invoke(event, { channel: 'projectFiles:watch', payload: {} })).resolves.toEqual({ ok: true, data: {} });
    const requests = Array.from({ length: 80 }, (_, id) => invoke(event, { channel: 'tasks:plan', payload: { id } }));
    await entered.promise;
    expect(operations).toHaveLength(8);
    expect(host.clients()).toBeLessThanOrEqual(9);
    const descriptor = await readRuntimeDescriptor(dir);
    if (!descriptor) throw new Error('Fixture host was not published');
    const cli = await openControlClient(descriptor);
    expect(await cli.call('host.status')).toEqual({ pid: process.pid });
    await cli.close();
    // A native dialog must not serialize otherwise independent requests onto one socket.
    holding = false; release.resolve();
    const results = await Promise.all(requests);
    expect(results.filter(result => result.ok)).toHaveLength(72);
    expect(results.filter(result => !result.ok)).toHaveLength(8);
    expect(new Set(operations.map(operation => JSON.stringify(operation.payload)))).toEqual(new Set(Array.from({ length: 72 }, (_, id) => JSON.stringify({ id }))));
    for (let id = 0; id < 72; id += 1) expect(results[id]).toEqual({ ok: true, data: { id } });
    expect(new Set(operations.map(operation => operation.owner)).size).toBe(1);
    expect(operations[0]!.owner).not.toBeNull();
    holding = true; held = 0;
    entered = Promise.withResolvers<void>();
    firstEntered = Promise.withResolvers<void>();
    release = Promise.withResolvers<void>();
    const dialog = invoke(event, { channel: 'tasks:plan', payload: { id: 'dialog' } });
    await firstEntered.promise;
    await expect(invoke(event, { channel: 'sessions:controls', payload: { id: 'read' } })).resolves.toEqual({ ok: true, data: { id: 'read' } });
    const accepted = [dialog, ...Array.from({ length: 7 }, (_, id) => invoke(event, { channel: 'tasks:plan', payload: { id: `held-${id}` } }))];
    await entered.promise;
    const oldOwner = operations.at(-1)!.owner;
    const retired = [invoke(event, { channel: 'tasks:plan', payload: { id: 'retired' } }),
      invoke(event, { channel: 'projectFiles:watch', payload: { id: 'retired-watch' } })];
    windowOptions.rendererClosed?.();
    windowOptions.rendererStarting?.();
    for (const request of retired) await expect(request).resolves.toMatchObject({ ok: false, error: expect.stringContaining('closed or replaced') });
    release.resolve();
    for (const request of accepted) await expect(request).resolves.toMatchObject({ ok: true });
    expect(operations.slice(-8).every(operation => operation.owner === oldOwner)).toBe(true);
    expect(operations).toHaveLength(80);
  } finally {
    holding = false; release.resolve();
    appEvents.get('before-quit')?.();
    await host.close();
    vi.doUnmock('electron');
    vi.doUnmock('../src/main/identity.js');
    vi.doUnmock('../src/main/desktop-window.js');
    vi.resetModules();
    await removeTempDir(dir);
  }
});

it('waits for an accepted GUI operation beyond the CLI deadline without dispatching it again', async () => {
  const dir = await makeTempDir('wgpt-gui-deadline-');
  const entered = Promise.withResolvers<void>();
  const finish = Promise.withResolvers<void>();
  let mutations = 0;
  const host = await startControlSocket({
    dataDir: dir,
    installationId: randomUUID(),
    authToken: randomUUID(),
    dispatch: async () => { throw new Error('Unexpected non-GUI operation'); },
    gui: {
      invoke: async () => {
        entered.resolve();
        await finish.promise;
        mutations += 1;
        return { ok: true, data: 'accepted' };
      },
      subscribe: () => () => undefined
    }
  });
  const descriptor = await readRuntimeDescriptor(dir);
  if (!descriptor) throw new Error('Fixture host was not published');
  const client = await openControlClient(descriptor);
  try {
    vi.useFakeTimers();
    const result = client.call('gui.invoke', { channel: 'tasks:plan', json: '{}' });
    let settled = false;
    void result.then(() => { settled = true; }, () => { settled = true; });
    await entered.promise;
    await vi.advanceTimersByTimeAsync(30_001);
    expect(settled).toBe(false);
    finish.resolve();
    await expect(result).resolves.toEqual({ json: JSON.stringify({ ok: true, data: 'accepted' }) });
    expect(mutations).toBe(1);
  } finally {
    finish.resolve();
    vi.useRealTimers();
    await client.close();
    await host.close();
    await removeTempDir(dir);
  }
});

it('keeps multi-chunk GUI replies framed when retrieval request ids grow', async () => {
  const dir = await makeTempDir('wgpt-gui-reply-chunks-');
  const text = '한글🙂\\"'.repeat(20_000);
  const bytes = Uint8Array.from({ length: 100_000 }, (_value, index) => index % 251);
  const host = await startControlSocket({
    dataDir: dir,
    installationId: randomUUID(),
    authToken: randomUUID(),
    dispatch: async () => { throw new Error('Unexpected non-GUI operation'); },
    gui: {
      invoke: async () => ({ text, bytes }),
      subscribe: () => () => undefined
    }
  });
  const descriptor = await readRuntimeDescriptor(dir);
  if (!descriptor) throw new Error('Fixture host was not published');
  const client = await openControlClient(descriptor);
  try {
    for (let request = 0; request < 7; request += 1) await client.call('gui.subscribe');
    const result = await client.call('gui.invoke', { channel: 'sessions:outbox', json: '{}' });
    expect(result).toMatchObject({ stage: expect.any(String), total: expect.any(Number) });
    const transfer = result as { stage: string; total: number };
    expect(transfer.total).toBeGreaterThan(2);
    const parts: string[] = [];
    for (let part = 0; part < transfer.total; part += 1) {
      const chunk = await client.call('gui.take', { id: transfer.stage, part }) as { data: string };
      parts.push(chunk.data);
    }
    const decoded = JSON.parse(Buffer.concat(parts.map(part => Buffer.from(part, 'base64'))).toString('utf8')) as {
      text: string;
      bytes: { _wgpt_bytes: string };
    };
    expect(decoded.text).toBe(text);
    expect(Buffer.from(decoded.bytes._wgpt_bytes, 'base64')).toEqual(Buffer.from(bytes));
  } finally {
    await client.close();
    await host.close();
    await removeTempDir(dir);
  }
});

it('stages an escaped GUI reply whose encoded payload fits but serialized envelope does not', async () => {
  const dir = await makeTempDir('wgpt-gui-reply-escaping-');
  const escaped = '\\"'.repeat(12_000);
  const host = await startControlSocket({
    dataDir: dir,
    installationId: randomUUID(),
    authToken: randomUUID(),
    dispatch: async () => { throw new Error('Unexpected non-GUI operation'); },
    gui: {
      invoke: async () => escaped,
      subscribe: () => () => undefined
    }
  });
  const descriptor = await readRuntimeDescriptor(dir);
  if (!descriptor) throw new Error('Fixture host was not published');
  const client = await openControlClient(descriptor);
  try {
    const result = await client.call('gui.invoke', { channel: 'sessions:outbox', json: '{}' });
    expect(result).toMatchObject({ stage: expect.any(String), total: expect.any(Number) });
    const transfer = result as { stage: string; total: number };
    const parts: string[] = [];
    for (let part = 0; part < transfer.total; part += 1) {
      const chunk = await client.call('gui.take', { id: transfer.stage, part }) as { data: string };
      parts.push(chunk.data);
    }
    expect(JSON.parse(Buffer.concat(parts.map(part => Buffer.from(part, 'base64'))).toString('utf8'))).toBe(escaped);
  } finally {
    await client.close();
    await host.close();
    await removeTempDir(dir);
  }
});

it('delivers an escaped GUI event whose complete inline envelope exceeds the reply limit', async () => {
  const dir = await makeTempDir('wgpt-gui-event-escaping-');
  const subscribed = Promise.withResolvers<(channel: string, args: unknown[]) => void>();
  const host = await startControlSocket({
    dataDir: dir,
    installationId: randomUUID(),
    authToken: randomUUID(),
    dispatch: async () => { throw new Error('Unexpected non-GUI operation'); },
    gui: {
      invoke: async () => null,
      subscribe: listener => {
        subscribed.resolve(listener);
        return () => undefined;
      }
    }
  });
  const descriptor = await readRuntimeDescriptor(dir);
  if (!descriptor) throw new Error('Fixture host was not published');
  const client = await openControlClient(descriptor);
  const received = Promise.withResolvers<{ channel: string; args: unknown[] }>();
  const closed = Promise.withResolvers<never>();
  const removeEventListener = client.onGuiEvent((channel, args) => received.resolve({ channel, args }));
  const removeCloseListener = client.onClose(() => closed.reject(new Error('Control socket closed before the GUI event arrived')));
  try {
    await client.call('gui.subscribe');
    const payload = '"'.repeat(16_368);
    const publish = await subscribed.promise;
    publish('x', [payload]);
    await expect(Promise.race([received.promise, closed.promise])).resolves.toEqual({ channel: 'x', args: [payload] });
  } finally {
    removeEventListener();
    removeCloseListener();
    await client.close();
    await host.close();
    await removeTempDir(dir);
  }
});
