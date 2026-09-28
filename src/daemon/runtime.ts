/**
 * The standalone MCP runtime: the same coding tools, served by a plain Node process.
 *
 * This is the one place a daemon is assembled, and everything it does is *reused* rather than
 * reimplemented — the same loopback MCP endpoint (`mcp/server.ts`, with its per-surface secret
 * paths, Host/Origin checks and bounded bodies), the same tool graph, the same durable work
 * ledger, the same admission gate and the same control socket. What is different is only what
 * there is no desktop app to provide:
 *
 *   - **No Electron.** Nothing in this module's graph imports it. The one module that used to
 *     (`secrets.ts`) now resolves its cipher structurally, so a host with no OS keychain says so
 *     instead of failing to load.
 *   - **No browser and no desktop.** The daemon masks the Desktop capabilities in the context it
 *     hands the endpoint, which is the app's own existing mechanism for "this host cannot do
 *     that": the browser and native-desktop tools are not registered at all, rather than
 *     registered and then failing. No companion extension is started, no helper is spawned, and
 *     no capability is advertised that this process cannot honour.
 *   - **No conversation to type into.** Managed work is admitted, durably recorded and
 *     controllable exactly as in the app, but the runtime installs no outbox delivery path: a
 *     daemon has no page to send a message to, and a fabricated `queued` would be a lie. A start
 *     whose first send is attempted reports that failure truthfully and blocks the work.
 *   - **One writer per data directory.** The desktop app is protected by Electron's single
 *     instance lock, which plain Node does not have, so the daemon claims its directory with an
 *     atomic exclusive lock before it opens the ledger.
 */

import { randomUUID } from 'node:crypto';
import path from 'node:path';

import { APP_VERSION } from '../main/version.js';
import { acquireDataDirLock, DATA_DIR_LOCK_FILE, DataDirLockError } from '../main/data-dir-lock.js';
import { ensurePrivateDir, getInstallationId, useDataDir } from '../main/identity.js';
import { effectiveCapabilities, getConfig, initConfigPath, loadConfig, updateConfig } from '../main/config.js';
import { RESERVED_ROOT_NAMES, uniqueRootName, validateNewRoot } from '../main/sandbox.js';
import { getSecret, initSecretsPath, installSecretCipher, secureStorageStatus, setSecret, type SecretKey } from '../main/secrets.js';
import { setupApiKeySlot } from '../shared/setup-profile.js';
import { flushDurable, initDurableStore } from '../main/durable.js';
import { initSkillsPath } from '../main/skills.js';
import { initLogFile, logInfo, logWarn } from '../main/logger.js';
import { flushSessions, initSessionStore } from '../main/session/store.js';
import { flushRecorder } from '../main/session/recorder.js';
import { pluginManager } from '../main/plugins/manager.js';
import { DESKTOP_CAPABILITIES, MAX_APPROVED_ROOTS, type Config } from '../shared/types.js';
import { WORK_ERROR_CODES } from '../shared/work.js';
import {
  DAEMON_SECRET_KEYS,
  type DaemonConfigReport,
  type DaemonConfigRequest,
  type DaemonSecretKey,
  type DaemonSecretReport,
  type DaemonSecretRequest
} from '../shared/daemon-config.js';
import { createHeadlessCipher, NO_HEADLESS_KEY_DETAIL } from './headless-cipher.js';
import { DaemonTunnel, type DaemonTunnelState } from './tunnel.js';
import { prepareDaemonBrowser, type DaemonBrowserAdapter } from './browser.js';
import { closeCorrelationStore, restoreRequestCorrelations } from '../main/session/correlation.js';

import { forgetExposedSurface, startMcpServer, type McpEndpoint } from '../main/mcp/server.js';
import { setManagedToolGate } from '../main/mcp/kernel.js';
import { shutdownCodeModeRuntime } from '../main/mcp/code-mode-runtime.js';
import { SURFACE_IDS, type SurfaceId } from '../main/mcp/surfaces.js';

import { createWorkStore } from '../main/work/store.js';
import { createWorktreeManager } from '../main/work/worktrees.js';
import {
  createWorktreeActivityProbe,
  drainWorkRuntime,
  initWorkRuntime,
  managedToolGate,
  reconcileWorkRuntime,
  setWorkPowerHolder,
  type WorkRuntimeHandle
} from '../main/work/runtime.js';
import { getWorkServiceOrNull } from '../main/work/service.js';
import {
  CONTROL_PROTOCOL_VERSION,
  createWorkControlDispatch,
  removeStaleRuntimeDescriptor,
  startControlSocket,
  type ControlSocketHandle,
  type DaemonStatusReport,
  type DaemonStopReceipt,
  type RuntimeDescriptor
} from '../main/work/control-socket.js';
import { unifiedExecManager } from '../main/codex/manager.js';

/** Compatibility export for callers that inspect the shared host ownership claim. */
export { DATA_DIR_LOCK_FILE as DAEMON_LOCK_FILE };

/** Raised when this process cannot own the data directory it was pointed at. */
export class DaemonRuntimeError extends Error {
  constructor(
    message: string,
    readonly code: string
  ) {
    super(message);
    this.name = 'DaemonRuntimeError';
  }
}

export interface DaemonRuntimeOptions {
  /** The directory this daemon owns alone. Absolute; a relative path is refused. */
  dataDir: string;
  /**
   * Whether this daemon also serves the browser bridge.
   *
   * Off by default, and deliberately so: a daemon is a *coding* host first, and everything the
   * browser path needs — the companion extension, a bridge listening on loopback, durable
   * conversation continuity — is extra surface that a host without a browser must not claim. When
   * it is on, the endpoint serves managed work exactly as before; what changes is that an
   * instruction may now be *delivered into a ChatGPT page* instead of failing as undeliverable.
   */
  browserDelivery?: boolean;
  /** Test seams. Production allocates a fresh private endpoint and mints its own token. */
  control?: { socketPath?: string; token?: string };
}

/**
 * What `startDaemonRuntime` hands back.
 *
 * `endpoint` and `urls` are the *real* MCP URLs, including each surface's secret path — the same
 * values the desktop app hands its tunnel. Nothing here is a placeholder: a caller that receives
 * this handle can make an authenticated MCP call against `endpoint` immediately.
 */
export interface DaemonRuntimeHandle {
  /** The URL to hand a client: the Core surface, including its secret path. */
  endpoint: string;
  urls: Record<SurfaceId, string>;
  dataDir: string;
  /** Stable per-process identity, published in the descriptor and answered by `daemon.status`. */
  instanceId: string;
  pid: number;
  /** The authenticated private control endpoint and the token its handshake must carry. */
  control: { socketPath: string; token: string };
  /** Idempotent. Drains owned work, stops children, withdraws the descriptor and releases the lock. */
  stop(): Promise<void>;
}

// ---------------------------------------------------------------------------------------
// The data directory lock
// ---------------------------------------------------------------------------------------



/**
 * Whether a pid exists at all.
 *
 * Signal 0 performs the permission and existence checks without delivering anything. `EPERM`
 * means the pid exists and belongs to somebody else, which is still "alive" — the process this
 * app would have to take over is not provably gone, and "not provably gone" is not permission.
 */




/**
 * Claims the data directory for this process, or refuses by name.
 *
 * `wx` is the whole mechanism: it is an atomic create-or-fail, so two daemons launched in the
 * same instant cannot both believe they own the directory. A lock left behind by a process that
 * is genuinely gone is reconciled with the same pid probe the rest of this codebase uses, and
 * exactly once — a second failure is a refusal rather than a loop, because a directory whose
 * lock cannot be taken is not one to keep retrying against.
 */


// ---------------------------------------------------------------------------------------
// The tool context
// ---------------------------------------------------------------------------------------

/**
 * The capabilities this host can actually honour.
 *
 * Everything the user has granted, minus the Desktop group — and that subtraction is the honest
 * answer rather than a policy choice. Those capabilities gate tools that drive a companion
 * browser tab or the native desktop, and a daemon has neither: no extension is paired to it and
 * no helper belongs to it. Masking them here is the app's own existing mechanism, so the tools
 * are simply not registered, `tools_search` does not list them, and no refusal has to explain a
 * capability the connector never had.
 *
 * Read-only mode is applied by `effectiveCapabilities` exactly as in the app, so a daemon pointed
 * at a read-only configuration starts with every write tool absent.
 */
function daemonCapabilities() {
  const caps = effectiveCapabilities(getConfig());
  for (const capability of DESKTOP_CAPABILITIES) caps[capability] = false;
  return caps;
}

/** A refusal this daemon's configuration verbs report with a machine-readable code. */
class DaemonConfigError extends Error {
  constructor(
    message: string,
    readonly code: string
  ) {
    super(message);
    this.name = 'DaemonConfigError';
  }
}

/**
 * The daemon's own approved folders, read-only mode, tool permissions and tunnel selection.
 *
 * This exists because a daemon owns a data directory but has no window, and those things were
 * otherwise only editable through the desktop UI. It is deliberately a closed set of verbs rather
 * than a generic settings writer: appearance, continuation prompts and another connector's
 * identity stay out of reach of a socket, and the tunnel *credential* travels on the separate
 * `daemon.secret` verb so it is never echoed back in a settings report.
 *
 * Three rules are load-bearing:
 *
 *   1. **It goes through `updateConfig`.** That is the same serialized read-modify-write the UI
 *      uses, so a concurrent desktop edit (or the work runtime approving its managed worktree
 *      root) cannot be clobbered by a stale full-config snapshot, and the receipt is answered
 *      only after the file has been replaced.
 *   2. **A folder is validated exactly as the picker validates it.** `validateNewRoot`
 *      canonicalizes, refuses network/root paths and refuses a folder that overlaps an existing
 *      root, so the CLI cannot approve something the desktop would have refused.
 *   3. **A transport change is reconciled, not assumed.** Selecting a tunnel id is only a stored
 *      intent; whether a tunnel is actually running is decided by `DaemonTunnel`, which reads the
 *      credential and the endpoint for itself.
 */
function createDaemonConfigPort(deps: {
  tunnelState: () => DaemonTunnelState;
  applyTunnel: () => Promise<void>;
  reconnectTunnel: () => Promise<void>;
}): (request: DaemonConfigRequest) => Promise<DaemonConfigReport> {
  const report = (): DaemonConfigReport => {
    const config = getConfig();
    return {
      roots: config.roots.map((root) => ({ name: root.name, path: root.path })),
      readOnly: config.readOnly,
      fileAccessMode: config.fileAccessMode,
      capabilities: { ...config.capabilities },
      // Reported separately, and masked here, so a client is never shown `screen`/`control` as
      // usable on a host that has no browser or native backend to serve them.
      effectiveCapabilities: daemonCapabilities(),
      tunnel: {
        kind: config.tunnel.kind,
        tunnelId: config.tunnel.tunnelId,
        hasApiKey: deps.tunnelState().hasApiKey
      }
    };
  };

  const commit = async (update: (config: Config) => Config | Promise<Config>): Promise<void> => {
    const before = getConfig();
    const next = await updateConfig(update);
    // The same invalidation the desktop performs: an explicit permission change has to replace
    // discovery's monotonic snapshot, or a tool the user just disabled stays published until the
    // process restarts.
    if (JSON.stringify(effectiveCapabilities(before)) !== JSON.stringify(effectiveCapabilities(next))) {
      forgetExposedSurface();
    }
    // A transport change is applied after the write, so a tunnel is never started from a
    // configuration that failed to persist. `applyTunnel` is idempotent, so this is also correct
    // for the changes that cannot affect the transport at all.
    if (JSON.stringify(transportOf(before)) !== JSON.stringify(transportOf(next))) await deps.applyTunnel();
  };

  return async (request: DaemonConfigRequest): Promise<DaemonConfigReport> => {
    if (request.action === 'get') return report();

    if (request.action === 'add-root') {
      if (getConfig().roots.length >= MAX_APPROVED_ROOTS) {
        throw new DaemonConfigError(
          `this daemon already has ${MAX_APPROVED_ROOTS} approved folders, which is the maximum. Remove one first.`,
          WORK_ERROR_CODES.invalidInput
        );
      }
      let approved = '';
      // Canonicalising and the overlap check both happen *inside* the transaction, against the
      // roots that are actually committed at that moment. Validating against a snapshot read before
      // the write would be a race with the same one-writer rule this port exists to honour: a
      // concurrent approval — the desktop UI's, or the work runtime approving a managed worktree
      // root — could add a folder between the check and the write, and the overlapping root would
      // then be persisted without ever having been compared against its neighbour.
      await commit(async (config) => {
        const real = await validateNewRoot(request.path, config.roots).catch((error: unknown) => {
          throw new DaemonConfigError(error instanceof Error ? error.message : String(error), WORK_ERROR_CODES.invalidInput);
        });
        const existing = config.roots.find((root) => root.path === real);
        if (existing) {
          throw new DaemonConfigError(
            `${real} is already approved as /${existing.name}.`,
            WORK_ERROR_CODES.invalidInput
          );
        }
        const name = request.name ?? uniqueRootName(real, config.roots);
        if (RESERVED_ROOT_NAMES.has(name)) {
          throw new DaemonConfigError(`/${name} is reserved by this app and cannot be used as a folder name.`, WORK_ERROR_CODES.invalidInput);
        }
        if (config.roots.some((root) => root.name === name)) {
          throw new DaemonConfigError(`/${name} is already used by another approved folder.`, WORK_ERROR_CODES.invalidInput);
        }
        approved = name;
        return { ...config, roots: [...config.roots, { name, path: real }] };
      });
      logInfo(`daemon approved folder /${approved}`);
      return report();
    }

    if (request.action === 'remove-root') {
      const name = request.name;
      await commit((config) => {
        if (!config.roots.some((root) => root.name === name)) {
          throw new DaemonConfigError(`/${name} is not an approved folder.`, WORK_ERROR_CODES.invalidInput);
        }
        return { ...config, roots: config.roots.filter((root) => root.name !== name) };
      });
      logInfo(`daemon removed folder /${name}`);
      return report();
    }

    if (request.action === 'file-access') {
      await commit((config) => ({ ...config, fileAccessMode: request.mode }));
      return report();
    }

    if (request.action === 'read-only') {
      await commit((config) => ({ ...config, readOnly: request.enabled }));
      return report();
    }

    if (request.action === 'tunnel') {
      await commit((config) => ({
        ...config,
        tunnel: {
          ...config.tunnel,
          kind: request.kind,
          ...(request.tunnelId === undefined ? {} : { tunnelId: request.tunnelId })
        }
      }));
      return report();
    }

    if (request.action === 'reconnect') {
      // No settings write: this is the recovery verb, and forcing the transport to be rebuilt is
      // the whole of it. The report that comes back carries the state it landed in.
      await deps.reconnectTunnel();
      return report();
    }

    await commit((config) => ({
      ...config,
      capabilities: { ...config.capabilities, [request.name]: request.enabled }
    }));
    return report();
  };
}

/** The part of the configuration that decides whether — and where — a tunnel runs. */
function transportOf(config: Config): { kind: string; tunnelId: string } {
  return { kind: config.tunnel.kind, tunnelId: config.tunnel.tunnelId };
}

/**
 * One log line per *change* of transport state.
 *
 * A daemon's tunnel is supervised by the transport itself, which re-reports the same healthy state
 * on every poll; logging each report would bury the one transition that matters — connected,
 * refused, or gone — under a line every fifteen seconds.
 */
let lastLoggedTunnelState: DaemonTunnelState['state'] | null = null;
function logTunnelState(state: DaemonTunnelState): void {
  if (state.state === lastLoggedTunnelState) return;
  lastLoggedTunnelState = state.state;
  const detail = state.detail ? `: ${state.detail}` : '';
  if (state.state === 'unavailable') logWarn(`daemon tunnel ${state.state}${detail}`);
  else logInfo(`daemon tunnel ${state.state}${detail}`);
}

/**
 * The credentials a daemon may hold, and whether this host can protect them at all.
 *
 * Presence is all that is ever reported. A credential readable back over the control socket would
 * leak through any process that can read the descriptor, and the caller that set it already knows
 * its value. The storage block is what tells an operator the difference between "no key stored"
 * and "this host cannot store one", which are the same symptom and different problems.
 *
 * A write reconciles the transport afterwards: a key stored while no tunnel was running is exactly
 * the case where the daemon should now start one, and a cleared key is the case where it should
 * stop claiming to publish.
 */
async function daemonSecretPort(
  request: DaemonSecretRequest,
  deps: { applyTunnel: () => Promise<void> }
): Promise<DaemonSecretReport> {
  // The verb's key name is stable (`openaiApiKey`), but the *slot* it names is the one the
  // configured tunnel actually reads: an active setup profile keeps its credential under
  // `setup:<id>`, and writing the default slot instead would report a key as stored while the
  // transport went on saying it had none.
  const slot = (key: DaemonSecretKey): SecretKey => (key === 'openaiApiKey' ? setupApiKeySlot(getConfig().tunnel.profileId) : key);
  if (request.action !== 'status') {
    // `setSecret` refuses by name when this host has no cipher, so a caller is never told a
    // credential was stored when it was not.
    await setSecret(slot(request.key), request.action === 'clear' ? '' : request.value);
    await deps.applyTunnel();
  }
  const storage = await secureStorageStatus();
  const keys = await Promise.all(
    DAEMON_SECRET_KEYS.map(async (key) => ({ key, present: (await getSecret(slot(key))) !== null }))
  );
  return { keys, storage: { available: storage.available, detail: storage.detail } };
}

/**
 * The live context the endpoint reads on every request.
 *
 * Rebuilt per request so a permission or root change is honoured on the next call without
 * restarting the daemon, and so the work service is read *live*: a daemon whose ledger is still
 * being restored answers `WORK_SERVICE_UNAVAILABLE` through the service's own refusal instead of
 * serving a stale null.
 */
function daemonToolContext() {
  const config = getConfig();
  return {
    roots: config.roots,
    caps: daemonCapabilities(),
    readOnly: config.readOnly,
    privacyScreenshots: false,
    workService: getWorkServiceOrNull() ?? undefined
  };
}

// ---------------------------------------------------------------------------------------
// Startup and shutdown
// ---------------------------------------------------------------------------------------

/**
 * Starts the standalone runtime.
 *
 * Order is the contract, and every step before the endpoint listens exists so that nothing can
 * be admitted into a host that is not ready for it:
 *
 *   1. the directory is claimed, before any store opens a file in it;
 *   2. every store is rooted at that directory and the saved configuration is loaded, because
 *      permissions and approved roots are read from it rather than defaulted;
 *   3. the durable work runtime is created and reconciled, which is what installs the admission
 *      gate — before the endpoint can receive a single call;
 *   4. only then does the MCP endpoint listen and the control socket publish.
 */
export async function startDaemonRuntime(options: DaemonRuntimeOptions): Promise<DaemonRuntimeHandle> {
  const dataDir = options.dataDir;
  if (!path.isAbsolute(dataDir)) {
    throw new DaemonRuntimeError(
      `the daemon requires an absolute data directory; got ${JSON.stringify(dataDir)}`,
      'INVALID_INPUT'
    );
  }
  ensurePrivateDir(dataDir);
  const instanceId = randomUUID();
  // Built before the directory is claimed so a malformed key is a plain startup refusal, with no
  // lock to release and no half-started daemon behind it. A malformed key throws by design: an
  // operator who set the variable meant to protect their credentials, and quietly running without
  // it would look like the daemon ignoring them.
  const headlessCipher = createHeadlessCipher();
  let releaseLock: () => Promise<void>;
  try {
    releaseLock = await acquireDataDirLock(dataDir, { instanceId, kind: 'daemon' });
  } catch (error) {
    if (error instanceof DataDirLockError) throw new DaemonRuntimeError(error.message, error.code);
    throw error;
  }

  const startedAt = new Date().toISOString();
  // Minted once, before anything can publish it: the descriptor, the handshake and the handle all
  // have to name the same value, and three separate `randomUUID()` calls would be three tokens.
  const controlToken = options.control?.token ?? randomUUID();
  let endpoint: McpEndpoint | null = null;
  let control: ControlSocketHandle | null = null;
  let browser: DaemonBrowserAdapter | null = null;
  let tunnel: DaemonTunnel | null = null;
  let workRuntime: WorkRuntimeHandle | null = null;
  let stopping: Promise<void> | null = null;

  try {
    // The identity module has to know the directory before anything asks it for the installation
    // id, or the id would be created in the real installation's directory instead of this one.
    useDataDir(dataDir);
    initLogFile(path.join(dataDir, 'app.log'));
    initConfigPath(dataDir);
    initSecretsPath(dataDir);
    // Before any secret is read: this host has no OS keychain, so it either protects `secrets.bin`
    // with the key its operator supplied or refuses every write by name. There is no third option
    // and no plaintext fallback.
    installSecretCipher(headlessCipher, headlessCipher ? null : NO_HEADLESS_KEY_DETAIL);
    initSessionStore(dataDir);
    initDurableStore(dataDir);
    try {
      await initSkillsPath(dataDir);
    } catch (error) {
      logWarn(`Skills library unavailable: ${error instanceof Error ? error.message : String(error)}`);
    }
    await loadConfig();
    // External MCP servers are the user's own, and the manager is Electron-free: only its default
    // "open this authorization URL" callback reaches for a browser, and nothing calls it here.
    await pluginManager.initialize(dataDir);
    // Restore exact owners before work or browser reconciliation can consume them.
    await restoreRequestCorrelations();

    // A descriptor left by a daemon that is genuinely gone is cleared here as well as by the CLI,
    // so a directory recovered by hand is usable without first running a command against it.
    await removeStaleRuntimeDescriptor(dataDir).catch(() => false);

    const workStore = createWorkStore({ dataDir });
    const worktreesRoot = path.join(dataDir, 'worktrees');
    const worktrees = createWorktreeManager({
      userDataDir: dataDir,
      worktreesRoot,
      store: workStore,
      activity: createWorktreeActivityProbe(workStore)
    });
    // The optional browser transport is prepared *before* the runtime is created, because the
    // runtime takes the delivery callbacks as construction inputs: a work started through this
    // daemon has to know from its first admission whether an instruction can be delivered at all.
    // Preparing is not starting — nothing is listening yet — so a failure here is still a plain
    // startup refusal with the lock released.
    if (options.browserDelivery === true) browser = await prepareDaemonBrowser(dataDir);
    // No delivery path unless the browser transport supplied one: a coding-only daemon has no page
    // to send into, and the runtime reports that as a failed send rather than a queued one that
    // nothing would ever dispatch.
    workRuntime = await initWorkRuntime({
      dataDir,
      worktreesRoot,
      worktrees,
      store: workStore,
      ...(browser ? browser.delivery : {})
    });
    await reconcileWorkRuntime();
    // Installed before the listener exists, exactly as in the app: a call that names a work is
    // admitted against the durable ledger from the first request, and a call that names none runs
    // as ordinary coding under its own permissions and the approved-root sandbox.
    setManagedToolGate(managedToolGate);

    endpoint = await startMcpServer(daemonToolContext);

    // The bridge is started only once the endpoint is listening: the extension's paired page and
    // the MCP surface are two halves of the same transport, and a bridge that is up while the
    // endpoint is not would accept instructions nothing could serve.
    if (browser) {
      await browser.attach(workStore, workRuntime);
      await browser.start();
    }

    // The transport is reconciled, not commanded: a daemon with a configured tunnel and a stored
    // credential publishes one, and any other combination reports honestly why it does not.
    tunnel = new DaemonTunnel((state) => logTunnelState(state));
    tunnel.setLocalUrl(endpoint.url);
    // Deliberately not awaited: the endpoint and the control socket below are what make this
    // daemon usable, and a tunnel can take a minute to reach the provider. The reconciliation is
    // still owned — `stop()` retires an in-flight child — and its state is reported as it lands.
    void tunnel.apply();
    const port = {
      status: (): DaemonStatusReport => ({
        instance_id: instanceId,
        pid: process.pid,
        data_dir: dataDir,
        version: APP_VERSION,
        started_at: startedAt,
        endpoint: endpoint!.url,
        urls: { ...endpoint!.urls },
        kind: 'daemon' as const,
        tunnel: tunnel!.report(),
        // A launch property, and the one thing a caller cannot infer from the rest of this report:
        // an idempotent `start --browser` against a coding-only daemon returns that daemon, and
        // without this it would look like the flag had been honoured.
        browser: { enabled: browser !== null, extensionDir: browser?.extensionDir ?? null }
      }),
      // The daemon's own folder/permission verbs. They run against the same config store the
      // desktop UI writes, so the daemon has no second settings authority of its own.
      config: createDaemonConfigPort({
        tunnelState: () => tunnel!.report(),
        applyTunnel: () => tunnel!.apply(),
        reconnectTunnel: () => tunnel!.reconnect()
      }),
      secret: (request: DaemonSecretRequest) => daemonSecretPort(request, { applyTunnel: () => tunnel!.apply() }),
      stop: async (): Promise<DaemonStopReceipt> => {
        // The stop is started, not awaited: the caller is owed its receipt first, and the socket
        // hands this back to the process after that reply has been written.
        //
        // A stop asked for over the control socket is a request to end *this process*, which is
        // the whole meaning of `wgpt daemon stop`; `handle.stop()` called by an in-process owner
        // is not, and returns after draining so a test or an embedding host keeps its own process.
        void stop().then(() => process.exit(0));
        return { stopping: true, instance_id: instanceId };
      }
    };

    const descriptor: Pick<RuntimeDescriptor, 'instance_id' | 'data_dir' | 'started_at' | 'version' | 'mcp'> = {
      instance_id: instanceId,
      data_dir: dataDir,
      started_at: startedAt,
      version: APP_VERSION,
      mcp: { ...endpoint.urls }
    };

    control = await startControlSocket({
      dataDir,
      installationId: getInstallationId(dataDir),
      ...(options.control?.socketPath === undefined ? {} : { socketPath: options.control.socketPath }),
      daemon: { token: controlToken, port, descriptor },
      onStopRequested: () => void stop(),
      dispatch: createWorkControlDispatch({
        service: getWorkServiceOrNull()!,
        // The browser transport's own connection backend, when this daemon serves one: the socket
        // answers `work.connection`/`work.reconnect` from the same page evidence the bridge uses,
        // instead of refusing a verb this host actually supports.
        ...(browser?.connection ? { connection: browser.connection } : {}),
        // Without it, a daemon cannot report or open a chat, and the socket says
        // `HOST_UNAVAILABLE` rather than inventing a `closed` result nothing looked at.
        hostStatus: () => ({
          pid: process.pid,
          installation_id: getInstallationId(dataDir),
          protocol_version: CONTROL_PROTOCOL_VERSION,
          data_dir: dataDir,
          version: APP_VERSION,
          started_at: startedAt
        })
      })
    });

    const stop = async (): Promise<void> => {
      if (stopping) return stopping;
      stopping = (async () => {
        logInfo(`daemon ${instanceId} stopping`);
        // The endpoint first, and the tunnel not yet: the endpoint is what *drains*, and a client
        // that is mid-call over the tunnel has to be able to finish. Retiring the tunnel here would
        // cut exactly those accepted calls off and turn a clean shutdown into a dead connection.
        await endpoint?.stop({ forceAfterMs: 5_000 }).catch((error: unknown) => {
          logWarn(`daemon endpoint stop failed: ${error instanceof Error ? error.message : String(error)}`);
        });
        await shutdownCodeModeRuntime();
        // Then the transport, with the endpoint it pointed at already drained: from here on nothing
        // new can be admitted, and the tunnel can stop being reachable.
        await tunnel?.stop().catch((error: unknown) => {
          logWarn(`daemon tunnel stop failed: ${error instanceof Error ? error.message : String(error)}`);
        });
        setManagedToolGate(null);
        // The browser transport stops before the work runtime drains: it is what *delivers* an
        // instruction, and a bridge that outlived the drain would keep accepting messages for a
        // ledger that is already closing.
        await browser?.stop().catch((error: unknown) => {
          logWarn(`daemon browser stop failed: ${error instanceof Error ? error.message : String(error)}`);
        });
        await drainWorkRuntime().catch((error: unknown) => {
          logWarn(`daemon work drain failed: ${error instanceof Error ? error.message : String(error)}`);
        });
        setWorkPowerHolder('daemon', false);
        // Everything this process spawned: the exec manager owns the terminal sessions, and the
        // plugin manager owns the external MCP servers it started.
        await unifiedExecManager.terminateAllProcesses().catch(() => undefined);
        await pluginManager.close().catch(() => undefined);
        await control?.close().catch((error: unknown) => {
          logWarn(`daemon control socket close failed: ${error instanceof Error ? error.message : String(error)}`);
        });
        await flushRecorder().catch(() => undefined);
        await flushSessions().catch(() => undefined);
        await flushDurable().catch(() => undefined);
        // After the durable flush and after nothing else can observe a correlation: every
        // observation committed its own transaction, so the handle is released once admission and
        // recording have drained.
        closeCorrelationStore();
        workStore.close();
        await releaseLock().catch(() => undefined);
      })();
      return stopping;
    };

    const handle: DaemonRuntimeHandle = {
      endpoint: endpoint.url,
      urls: { ...endpoint.urls },
      dataDir,
      instanceId,
      pid: process.pid,
      control: { socketPath: control.socketPath, token: controlToken },
      stop
    };
    logInfo(`daemon runtime ready: endpoint=${endpoint.url} control=${control.socketPath}`);
    return handle;
  } catch (error) {
    // A half-started daemon releases what it took, and the child processes it started are part of
    // that: a tunnel or a bridge that was already up when a later step failed is stopped here, or
    // a startup refusal would leave a published endpoint behind pointing at a dead process. The
    // lock especially: a refusal that left it behind would make the next attempt look like a live
    // owner.
    await endpoint?.stop({ forceAfterMs: 1_000 }).catch(() => undefined);
    await shutdownCodeModeRuntime();
    await tunnel?.stop().catch(() => undefined);
    await browser?.stop().catch(() => undefined);
    await control?.close().catch(() => undefined);
    await pluginManager.close().catch(() => undefined);
    setManagedToolGate(null);
    await releaseLock().catch(() => undefined);
    throw error;
  }
}

export { SURFACE_IDS };
