/**
 * The daemon lifecycle against the *real* control socket.
 *
 * The fake daemon in `daemon-cli.test.ts` proves the CLI's own logic; this proves the two halves
 * meet: `startControlSocket` with a daemon port publishes a descriptor my module reads, the hello
 * carries the token it minted, and `daemon.status`/`daemon.stop` are answered by the real server.
 */
import { promises as fs } from 'node:fs';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { afterEach, expect, it } from 'vitest';
import { makeTempDir, removeTempDir } from './helpers.js';
import { startControlSocket, readRuntimeDescriptor } from '../src/main/work/control-socket.js';
import { requireDaemon, stopDaemon, ownerForDataDir } from '../src/daemon/lifecycle.js';

const cleanups: Array<() => Promise<void>> = [];
afterEach(async () => {
  for (const cleanup of cleanups.splice(0)) await cleanup().catch(() => undefined);
});

it('reads a daemon descriptor the real socket published and stops that instance', async () => {
  const dir = await makeTempDir('wgpt-real-');
  const dataDir = path.join(dir, 'data');
  await fs.mkdir(dataDir, { mode: 0o700 });
  const instanceId = randomUUID();
  let stopped: string | null = null;
  const holder: { socket: Awaited<ReturnType<typeof startControlSocket>> | null } = { socket: null };
  const socket = await startControlSocket({
    dataDir,
    installationId: randomUUID(),
    dispatch: async (method) => {
      throw new Error(`unexpected ${method}`);
    },
    daemon: {
      token: randomUUID(),
      descriptor: {
        instance_id: instanceId,
        data_dir: dataDir,
        started_at: new Date(0).toISOString(),
        version: '2.1.14',
        mcp: {
          core: 'http://127.0.0.1:1/mcp/core/x',
          desktop: 'http://127.0.0.1:1/mcp/desktop/x',
          plugins: 'http://127.0.0.1:1/mcp/plugins/x'
        }
      },
      port: {
      status: () => ({
        instance_id: instanceId,
        pid: process.pid,
        data_dir: dataDir,
        version: '2.1.14',
        started_at: new Date(0).toISOString(),
        endpoint: 'http://127.0.0.1:1/mcp/core/x',
        urls: {
          core: 'http://127.0.0.1:1/mcp/core/x',
          desktop: 'http://127.0.0.1:1/mcp/desktop/x',
          plugins: 'http://127.0.0.1:1/mcp/plugins/x'
        },
        kind: 'daemon'
      }),
      // This fixture proves the transport, not the configuration verbs; `daemon-runtime.test.ts`
      // exercises those against the real runtime. Reaching it here would be a test bug.
      config: async () => {
        throw new Error('unexpected daemon.config');
      },
      secret: async () => {
        throw new Error('unexpected daemon.secret');
      },
      stop: async () => {
        stopped = instanceId;
        return { stopping: true, instance_id: instanceId };
      }
      }
    },
    // The real stop path: the receipt is answered first, then the process owning the socket closes
    // it. `stopDaemon` waits that out, which is what makes the following `status` truthful.
    onStopRequested: () => {
      void holder.socket?.close();
    }
  });
  holder.socket = socket;
  cleanups.push(async () => {
    await socket.close();
    await removeTempDir(dir);
  });

  const descriptor = await readRuntimeDescriptor(dataDir);
  expect(descriptor).toMatchObject({ kind: 'daemon', instance_id: instanceId, control_token: expect.any(String) });

  const owner = await ownerForDataDir(dataDir);
  expect(owner).toMatchObject({ kind: 'daemon', status: { instance_id: instanceId } });
  expect((await requireDaemon(dataDir)).instance_id).toBe(instanceId);

  const receipt = await stopDaemon(dataDir, { timeoutMs: 3_000 });
  expect(receipt).toEqual({ stopping: true, instance_id: instanceId });
  expect(stopped).toBe(instanceId);
});
