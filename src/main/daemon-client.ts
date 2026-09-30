import path from 'node:path';
import { existsSync } from 'node:fs';
import { cp, mkdtemp, rename, rm, writeFile } from 'node:fs/promises';
import { spawn, type StdioOptions } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { app, dialog, ipcMain } from 'electron';
import type { AppState } from '../shared/types.js';
import { createDesktopWindow, type DesktopWindowHandle } from './desktop-window.js';
import { UI_BASE_ZOOM } from './window-layout.js';
import { isBackgroundLaunch } from './window-lifecycle.js';
import { resolveDataDir, ensurePrivateDir } from './identity.js';
import {
  ControlUnavailableError,
  openControlClient,
  readRuntimeDescriptor,
  type ControlClient,
  type RuntimeDescriptor
} from './work/control-socket.js';
import type { IpcReply } from './ipc.js';
import type { DesktopDaemonApi, DesktopDaemonReply, DesktopDaemonStatus } from '../shared/desktop-daemon.js';

// The GUI has an isolated Chromium profile. The persistent Electron backend alone owns the
// data directory's config, secrets, sessions, bridge and work ledger.
const dataDir = resolveDataDir(process.argv);
const openSessionArgument = process.argv.find(argument => argument.startsWith('--open-session='));
let pendingSession = openSessionArgument?.slice('--open-session='.length) || null;
let foregroundRequested = !isBackgroundLaunch(process.argv) || pendingSession !== null;
const profile = path.join(dataDir, 'desktop-client');
ensurePrivateDir(profile);
app.setPath('userData', profile);
const hasSingleInstanceLock = app.requestSingleInstanceLock({ openSession: pendingSession });
if (!hasSingleInstanceLock) app.quit();

let desktopWindow: DesktopWindowHandle | null = null;
let subscription: ControlClient | null = null;
let closing = !hasSingleInstanceLock;
let rendererId: string | null = null;
let rendererLoaded = false;
let subscriptionAttempt: Promise<void> | null = null;
let subscriptionEpoch = 0;
let reconnectTimer: NodeJS.Timeout | undefined;
let connectionPaused = false;

function unavailable(error: unknown): IpcReply<never> {
  return { ok: false, error: error instanceof Error ? error.message : String(error) };
}

async function descriptor(): Promise<RuntimeDescriptor> {
  const value = await readRuntimeDescriptor(dataDir);
  if (!value || value.kind !== 'desktop') {
    throw new ControlUnavailableError(`Desktop backend unavailable for ${dataDir}. Start it, then try again.`);
  }
  return value;
}

async function connectedClient(): Promise<ControlClient> {
  return openControlClient(await descriptor());
}

async function hostStatus(): Promise<DesktopDaemonStatus> {
  let client: ControlClient | null = null;
  try {
    client = await connectedClient();
    const result = await client.call('host.status');
    let pid: number | null = null;
    if (typeof result === 'object' && result !== null && !Array.isArray(result) && 'pid' in result &&
        typeof result.pid === 'number' && Number.isInteger(result.pid) && result.pid > 0) {
      pid = result.pid;
    }
    return { running: pid !== null, connected: pid !== null && subscription?.descriptor.pid === pid, pid, dataDir };
  } catch {
    return { running: false, connected: false, pid: null, dataDir };
  } finally {
    await client?.close().catch(() => undefined);
  }
}

function hostLaunch(): { executable: string; args: string[]; env: NodeJS.ProcessEnv } {
  // Inside an AppImage, `process.execPath` lives in this process's temporary mount, which ends
  // when the GUI exits, and the AppImage launcher's sandbox decision (`--no-sandbox` where user
  // namespaces are unavailable) applied only to the process it started. Relaunching the
  // `.AppImage` itself gives the persistent backend its own mount and the same launcher decision.
  const appImage = app.isPackaged && process.platform === 'linux' ? process.env.APPIMAGE?.trim() : undefined;
  const executable = process.env.WGPT_APP_EXECUTABLE?.trim() || appImage || process.execPath;
  const root = process.env.WGPT_REPO_ROOT?.trim() || (app.isPackaged ? '' : path.resolve(__dirname, '../..'));
  const args = [...(root ? [root] : []), '--daemon-host', '--data-dir', dataDir];
  const env = { ...process.env };
  delete env.ELECTRON_RUN_AS_NODE;
  return { executable, args, env };
}

async function startHost(): Promise<DesktopDaemonStatus> {
  const existing = await readRuntimeDescriptor(dataDir);
  if (existing?.kind === 'daemon' && processAlive(existing.pid)) {
    throw new Error('This data directory is owned by a standalone Node daemon. Stop that owner or use another data directory for the desktop backend.');
  }
  const before = await hostStatus();
  if (before.running) return before;
  const launch = hostLaunch();
  // CLF_DEBUG is the opt-in startup trace native package smokes read from the launched GUI.
  // The backend owns `app started`/`renderer state ready`, so share this process's output then.
  const stdio: StdioOptions = process.env.CLF_DEBUG === '1' ? ['ignore', 'inherit', 'inherit'] : 'ignore';
  const child = spawn(launch.executable, launch.args, { detached: true, stdio, env: launch.env });
  let launchError: Error | undefined;
  child.on('error', error => { launchError = error; });
  child.unref();
  const deadline = Date.now() + 15_000;
  while (Date.now() < deadline) {
    if (launchError) throw launchError;
    const current = await hostStatus();
    if (current.running) return current;
    await new Promise<void>(resolve => setTimeout(resolve, 100));
  }
  throw new Error('Desktop backend did not become ready within 15 seconds.');
}

async function clearSubscription(): Promise<void> {
  subscriptionEpoch += 1;
  subscriptionAttempt = null;
  clearTimeout(reconnectTimer);
  reconnectTimer = undefined;
  const client = subscription;
  subscription = null;
  await client?.close().catch(() => undefined);
}

function processAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === 'EPERM';
  }
}

async function stopHost(): Promise<DesktopDaemonStatus> {
  await clearSubscription();
  // Keep the exact endpoint proved for this stop. A replacement descriptor must not retarget it.
  const client = await connectedClient();
  const pid = client.descriptor.pid;
  try {
    await client.call('host.stop');
  } finally {
    await client.close().catch(() => undefined);
  }
  // The backend's bounded shutdown drains accepted work before releasing its singleton lock.
  const deadline = Date.now() + 120_000;
  while (Date.now() < deadline) {
    if (!processAlive(pid)) return hostStatus();
    await new Promise<void>(resolve => setTimeout(resolve, 100));
  }
  throw new Error('Desktop backend did not stop within 120 seconds.');
}

const desktopDaemon: DesktopDaemonApi = {
  status: async (): Promise<DesktopDaemonReply<DesktopDaemonStatus>> => {
    await ensureSubscription().catch(() => undefined);
    return { ok: true, data: await hostStatus() };
  },
  start: async (): Promise<DesktopDaemonReply<DesktopDaemonStatus>> => {
    try {
      await startHost();
      await ensureSubscription();
      const state = await invokeBackend('state:get', {});
      if (state.ok && typeof state.data === 'object' && state.data !== null && !Array.isArray(state.data)) {
        desktopWindow?.update(state.data as AppState);
        desktopWindow?.send('state:changed', [state.data]);
      }
      return { ok: true, data: await hostStatus() };
    } catch (error) {
      return unavailable(error);
    }
  },
  stop: async (): Promise<DesktopDaemonReply<DesktopDaemonStatus>> => {
    connectionPaused = true;
    try {
      return { ok: true, data: await stopHost() };
    } catch (error) {
      return unavailable(error);
    } finally {
      connectionPaused = false;
      scheduleReconnect();
    }
  }
};

function encodeGuiPayload(payload: unknown): string {
  return JSON.stringify(payload, (_key, value: unknown) => value instanceof Uint8Array
    ? { _wgpt_bytes: Buffer.from(value).toString('base64') }
    : value) ?? 'null';
}

function decodeGuiPayload(encoded: string): unknown {
  return JSON.parse(encoded, (_key, value: unknown) => {
    if (typeof value !== 'object' || value === null || Array.isArray(value) || !('_wgpt_bytes' in value) ||
        Object.keys(value).length !== 1 || typeof value._wgpt_bytes !== 'string') return value;
    return new Uint8Array(Buffer.from(value._wgpt_bytes, 'base64'));
  });
}

async function invokeBackend(channel: string, payload: unknown): Promise<IpcReply<unknown>> {
  let client: ControlClient | null = null;
  const owner = rendererId;
  const viewOwned = channel === 'workspaceTerminal:request' || channel === 'projectFiles:watch';
  let dispatched = false;
  try {
    if (viewOwned) await ensureSubscription();
    client = await connectedClient();
    if (viewOwned && (!owner || owner !== rendererId)) throw new Error('The owning desktop view was closed or replaced.');
    const encoded = encodeGuiPayload(payload);
    let result: unknown;
    if (Buffer.byteLength(encoded, 'utf8') <= 48 * 1024) {
      dispatched = true;
      result = await client.call('gui.invoke', { channel, json: encoded, rendererId: owner });
    } else {
      const transferId = randomUUID();
      const bytes = Buffer.from(encoded, 'utf8');
      const total = Math.ceil(bytes.length / (48 * 1024));
      for (let offset = 0, part = 0; offset < bytes.length; offset += 48 * 1024, part += 1) {
        await client.call('gui.stage', { id: transferId, part, total, data: bytes.subarray(offset, offset + 48 * 1024).toString('base64') });
      }
      dispatched = true;
      result = await client.call('gui.invoke', { channel, stage: transferId, rendererId: owner });
    }
    if (typeof result !== 'object' || result === null || Array.isArray(result)) throw new Error('Desktop backend returned an invalid IPC reply.');
    let decoded: unknown;
    if ('json' in result && typeof result.json === 'string') decoded = decodeGuiPayload(result.json);
    else if ('stage' in result && typeof result.stage === 'string' && 'total' in result && typeof result.total === 'number' && Number.isInteger(result.total) && result.total > 0) {
      const parts: Buffer[] = [];
      for (let part = 0; part < result.total; part += 1) {
        const item = await client.call('gui.take', { id: result.stage, part });
        if (typeof item !== 'object' || item === null || Array.isArray(item) || !('data' in item) || typeof item.data !== 'string') throw new Error('Desktop backend returned an invalid GUI transfer chunk.');
        parts.push(Buffer.from(item.data, 'base64'));
      }
      decoded = decodeGuiPayload(Buffer.concat(parts).toString('utf8'));
    } else throw new Error('Desktop backend returned an invalid GUI reply envelope.');
    if (typeof decoded !== 'object' || decoded === null || Array.isArray(decoded) || !('ok' in decoded) || typeof decoded.ok !== 'boolean') throw new Error('Desktop backend returned an invalid IPC reply.');
    return decoded as IpcReply<unknown>;
  } catch (error) {
    if (dispatched && error instanceof ControlUnavailableError) {
      return unavailable(new Error('Desktop connection lost after dispatch. The operation outcome is unconfirmed; check its existing result before retrying.'));
    }
    return unavailable(error);
  } finally {
    await client?.close().catch(() => undefined);
  }
}

function updatePresence(visible: boolean): void {
  const client = subscription;
  if (client) void client.call('gui.presence', { visible }).catch(() => undefined);
}

function scheduleReconnect(): void {
  if (closing || connectionPaused || reconnectTimer) return;
  reconnectTimer = setTimeout(() => {
    reconnectTimer = undefined;
    void ensureSubscription().catch(() => undefined);
  }, 1000);
  reconnectTimer.unref();
}

function ensureSubscription(): Promise<void> {
  if (subscription || closing || connectionPaused) return Promise.resolve();
  if (subscriptionAttempt) return subscriptionAttempt;
  const epoch = subscriptionEpoch;
  const owner = rendererId;
  const attempt = (async () => {
    const client = await connectedClient();
    let closed = false;
    client.onClose(() => {
      closed = true;
      if (subscription !== client) return;
      subscription = null;
      scheduleReconnect();
    });
    client.onGuiEvent((channel, args) => {
      if (epoch !== subscriptionEpoch || closing) return;
      if (channel === 'session:write' && typeof args[0] === 'string') {
        pendingSession = args[0];
        desktopWindow?.show();
        if (rendererLoaded) {
          desktopWindow?.send(channel, [pendingSession]);
          pendingSession = null;
        }
        return;
      }
      if (channel === 'state:changed' && args.length === 1) {
        const state = args[0];
        if (typeof state === 'object' && state !== null && !Array.isArray(state)) desktopWindow?.update(state as AppState);
      }
      desktopWindow?.send(channel, args);
    });
    try {
      if (epoch !== subscriptionEpoch || closing || connectionPaused) return;
      await client.call('gui.subscribe', { rendererId: owner });
      if (closed || epoch !== subscriptionEpoch || closing || connectionPaused) return;
      subscription = client;
      clearTimeout(reconnectTimer);
      reconnectTimer = undefined;
      updatePresence(desktopWindow?.getWindow()?.isVisible() === true);
      // Rehydrate projections missed while disconnected; never replay a user operation.
      for (const [channel, event] of [['state:get', 'state:changed'], ['plugins:snapshot', 'plugins:changed'], ['swarm:get', 'swarm:changed']] as const) {
        const reply = await invokeBackend(channel, {});
        if (subscription !== client || epoch !== subscriptionEpoch) return;
        if (reply.ok) {
          if (channel === 'state:get') desktopWindow?.update(reply.data as AppState);
          desktopWindow?.send(event, [reply.data]);
        }
      }
      desktopWindow?.send('session:changed', []);
    } finally {
      if (subscription !== client) await client.close().catch(() => undefined);
    }
  })();
  subscriptionAttempt = attempt;
  void attempt.finally(() => {
    if (subscriptionAttempt !== attempt) return;
    subscriptionAttempt = null;
    if (!subscription) scheduleReconnect();
  }).catch(() => undefined);
  return attempt;
}

/** Copy only browser UI preferences once, after a persistent backend owns the legacy directory. */
async function migrateLegacyUiProfile(): Promise<void> {
  const source = path.join(dataDir, 'Local Storage');
  const destination = path.join(profile, 'Local Storage');
  const markerName = '.wgpt-legacy-import-complete';
  if (!existsSync(source) || existsSync(path.join(destination, markerName)) ||
      existsSync(path.join(profile, '.legacy-ui-profile-migrated'))) return;
  if (existsSync(destination)) {
    throw new Error('An existing desktop UI profile conflicts with the pending legacy import. Both profiles have been preserved; no migration was marked complete.');
  }
  // Only localStorage contains app UI preferences/drafts. Chromium Local State can contain
  // encryption material and remains with the legacy backend that owns safeStorage.
  const stage = await mkdtemp(path.join(profile, '.legacy-ui-import-'));
  try {
    const stagedStorage = path.join(stage, 'Local Storage');
    await cp(source, stagedStorage, { recursive: true, errorOnExist: true, force: false });
    await writeFile(path.join(stagedStorage, markerName), 'migrated\n', { mode: 0o600 });
    // The completion proof and complete database become visible in the same rename.
    await rename(stagedStorage, destination);
  } finally {
    await rm(stage, { recursive: true, force: true });
  }
}

function registerProxyIpc(): void {
  const allowed = (event: Electron.IpcMainInvokeEvent): boolean => {
    const target = desktopWindow?.getWindow();
    return !!target && !target.isDestroyed() && event.sender === target.webContents && event.senderFrame === target.webContents.mainFrame;
  };
  ipcMain.handle('desktopDaemon:status', event => allowed(event) ? desktopDaemon.status() : unavailable(new Error('Window unavailable.')));
  ipcMain.handle('desktopDaemon:start', event => allowed(event) ? desktopDaemon.start() : unavailable(new Error('Window unavailable.')));
  ipcMain.handle('desktopDaemon:stop', event => allowed(event) ? desktopDaemon.stop() : unavailable(new Error('Window unavailable.')));
  ipcMain.handle('desktop:invoke', (event, request: unknown) => {
    if (!allowed(event)) return unavailable(new Error('Window unavailable.'));
    if (typeof request !== 'object' || request === null || Array.isArray(request)) return unavailable(new Error('Invalid desktop IPC request.'));
    const record = request as Record<string, unknown>;
    if (typeof record.channel !== 'string' || record.channel.length === 0 || record.channel.length > 128) {
      return unavailable(new Error('Invalid desktop IPC channel.'));
    }
    if (record.channel === 'window:getZoom') return { ok: true as const, data: event.sender.getZoomFactor() / UI_BASE_ZOOM };
    if (record.channel === 'window:zoom') {
      const payload = record.payload;
      if (typeof payload !== 'object' || payload === null || Array.isArray(payload) || !('factor' in payload) || typeof payload.factor !== 'number' || payload.factor < 0.75 || payload.factor > 1.5) {
        return unavailable(new Error('Invalid zoom factor.'));
      }
      event.sender.setZoomFactor(payload.factor * UI_BASE_ZOOM);
      return { ok: true as const, data: payload.factor };
    }
    return invokeBackend(record.channel, record.payload);
  });
}

void app.whenReady().then(async () => {
  if (closing) return;
  registerProxyIpc();
  let initialState: AppState | null = null;
  try {
    await startHost();
    const initial = await invokeBackend('state:get', {});
    if (!initial.ok) throw new Error(initial.error);
    initialState = initial.data as AppState;
    await migrateLegacyUiProfile();
  } catch (error) {
    // Never create a replacement Chromium database before a pending import can complete.
    if (existsSync(path.join(dataDir, 'Local Storage')) &&
        !existsSync(path.join(profile, 'Local Storage', '.wgpt-legacy-import-complete')) &&
        !existsSync(path.join(profile, '.legacy-ui-profile-migrated'))) {
      dialog.showErrorBox('Desktop startup failed', error instanceof Error ? error.message : String(error));
      app.quit();
      return;
    }
    // The lifecycle pane remains usable: it can start a backend that was unavailable at launch.
  }
  desktopWindow = createDesktopWindow({
    initialState,
    preloadPath: path.join(__dirname, '../preload/index.js'),
    rendererPath: path.join(__dirname, '../renderer/index.html'),
    ...(process.env.ELECTRON_RENDERER_URL ? { rendererUrl: process.env.ELECTRON_RENDERER_URL } : {}),
    invoke: (channel) => invokeBackend(channel, {}),
    quitGui: () => app.quit(),
    onVisibilityChange: updatePresence,
    rendererStarting: () => {
      rendererId = randomUUID();
      rendererLoaded = false;
      void clearSubscription().then(() => ensureSubscription()).catch(() => undefined);
    },
    rendererClosed: () => {
      rendererId = null;
      rendererLoaded = false;
      void clearSubscription().then(() => ensureSubscription()).catch(() => undefined);
    },
    rendererReady: () => {
      rendererLoaded = true;
      if (pendingSession) {
        desktopWindow?.send('session:write', [pendingSession]);
        pendingSession = null;
      }
    }
  });
  await ensureSubscription().catch(() => undefined);
  desktopWindow.bindLifecycle();
  if (foregroundRequested) desktopWindow.show();
});

app.on('second-instance', (_event, _argv, _directory, data: unknown) => {
  foregroundRequested = true;
  // Chromium may reorder bare switch values in argv. Electron preserves this structured
  // request from the secondary process, so a native switch can never become a session id.
  if (typeof data === 'object' && data !== null && 'openSession' in data &&
      typeof data.openSession === 'string' && data.openSession.length > 0 && data.openSession.length <= 200) {
    pendingSession = data.openSession;
  }
  desktopWindow?.show();
  if (rendererLoaded && pendingSession) {
    desktopWindow?.send('session:write', [pendingSession]);
    pendingSession = null;
  }
});

app.on('before-quit', () => {
  closing = true;
  clearTimeout(reconnectTimer);
  desktopWindow?.dispose();
  desktopWindow = null;
  const client = subscription;
  subscription = null;
  void client?.close();
});
