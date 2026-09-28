import { randomUUID } from 'node:crypto';
import { expect, it, vi } from 'vitest';
import { makeTempDir, removeTempDir } from './helpers.js';
import { openControlClient, readRuntimeDescriptor, startControlSocket } from '../src/main/work/control-socket.js';

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
