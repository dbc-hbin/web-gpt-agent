import { expect, it, vi } from 'vitest';

const { invoke, expose, getPath } = vi.hoisted(() => ({
  invoke: vi.fn(async (_channel: string, request: any) => ({ ok: true, data: request.payload.files.map((_: unknown, index: number) => ({ id: String(index), name: 'staged', size: 0, mimeType: 'application/octet-stream' })) })),
  expose: vi.fn(), getPath: vi.fn((file: any) => file.path ?? '')
}));
vi.mock('electron', () => ({
  contextBridge: { exposeInMainWorld: expose },
  ipcRenderer: { invoke },
  webUtils: { getPathForFile: getPath }
}));

it('keeps disk paths batched while transporting pathless clipboard bytes one at a time', async () => {
  await import('../src/preload/index.js');
  const api = expose.mock.calls[0]![1];
  const bytes = new Uint8Array([1, 2, 3]);
  const arrayBuffer = vi.fn(async () => bytes.buffer);
  await api.dropFiles([{ name: 'clipboard.png', size: 3, arrayBuffer }, { name: 'disk.png', size: 3, path: '/disk.png' }]);
  expect(invoke).toHaveBeenNthCalledWith(1, 'desktop:invoke', { channel: 'sessions:dropFiles', payload: { files: ['/disk.png'] } });
  expect(invoke).toHaveBeenNthCalledWith(2, 'desktop:invoke', { channel: 'sessions:dropFiles', payload: { files: [{ name: 'clipboard.png', bytes }] } });
  expect(arrayBuffer).toHaveBeenCalledOnce();
  invoke.mockClear(); arrayBuffer.mockClear();
  expect(await api.dropFiles([{ name: 'huge.png', size: 12 * 1024 * 1024 + 1, arrayBuffer }])).toMatchObject({ ok: false });
  expect(await api.dropFiles(Array(21).fill({ name: 'clipboard.png', size: 3, arrayBuffer }))).toMatchObject({ ok: false });
  expect(arrayBuffer).not.toHaveBeenCalled();
  expect(invoke).not.toHaveBeenCalled();
});

it('rolls back disk attachments when a later pathless attachment is refused', async () => {
  vi.resetModules();
  await import('../src/preload/index.js');
  const api = expose.mock.calls[0]![1];
  invoke.mockClear();
  invoke.mockImplementation(async (_channel: string, request: any) => {
    if (request.channel === 'sessions:discardFiles') return { ok: true, data: true };
    if (request.payload.files[0]?.name === 'bad.txt') return { ok: false, error: 'rejected', data: [] };
    return { ok: true, data: request.payload.files.map((_: unknown, index: number) => ({ id: String(index), name: 'staged', size: 1, mimeType: 'text/plain' })) };
  });
  const result = await api.dropFiles([{ name: 'bad.txt', size: 1, arrayBuffer: vi.fn(async () => new Uint8Array([1]).buffer) }, { name: 'disk.txt', size: 1, path: '/disk.txt' }]);
  expect(result).toMatchObject({ ok: false, error: 'rejected' });
  expect(invoke).toHaveBeenLastCalledWith('desktop:invoke', { channel: 'sessions:discardFiles', payload: { ids: ['0'] } });
});
