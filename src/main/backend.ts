import { spawn } from 'node:child_process';
import { stopInputStartup } from './session/start-input.js';
import { browserExtensionRequired } from '../shared/types.js';
/**
 * Persistent Electron backend: the original desktop authority without a renderer process.
 */

import { randomUUID } from 'node:crypto';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { app, Notification, powerSaveBlocker } from 'electron';
import {
  PRODUCT_NAME,
  browserProfileDir,
  ensurePrivateDir,
  resolveAndApplyUserData
} from './identity.js';
import { acquireDataDirLock } from './data-dir-lock.js';
import { initPowerManagement } from './power.js';
import { getConfig, initConfigPath, loadConfig } from './config.js';
import { connect, refreshPluginPublication, shutdownConnection } from './connection.js';
import { onEmbeddedCuaChanged, startEmbeddedCua, stopEmbeddedCua } from './cua/runtime.js';
import { forgetExposedSurface } from './mcp/server.js';
import { invokeRegisteredIpc, registerIpc, type RemoteIpcPush } from './ipc.js';
import { restoreChatModels } from './chat-models.js';
import { flushLogBeforeExit, initLogFile, logError, logInfo, logWarn, snapshotLogOnCrash } from './logger.js';
import { unifiedExecManager } from './codex/manager.js';
import { initSecretsPath } from './secrets.js';
import { pluginManager } from './plugins/manager.js';
import { requestSessionFinishGoal, setFinishNotifier } from './session/finish.js';
import { chatUrl, setBrowserOpener, shutdownBridge, startBridge } from './bridge.js';
import { flushSessions, getSession, initSessionStore } from './session/store.js';
import { initSkillsPath } from './skills.js';
import { usageOverview } from './session/usage.js';
import {
  conversationPageObservedAt,
  flushRecorder,
  queueDeterministicAttributionRepair,
  setAgentBinder,
  setAgentConversationLookup
} from './session/recorder.js';
import {
  agentConversation,
  bindConversation,
  onRetiredWorkersPersist,
  onRetiredWorkersPersistNow,
  onSwarmPersist,
  onSwarmPersistNow,
  pauseSwarmForDisable,
  repairPrimeConversationAfterRecovery,
  reconcileAgentRequestOwners,
  restoreRetiredWorkers,
  restoreSwarm,
  snapshotRetiredWorkers,
  snapshotSwarm,
  type RetiredWorkersSnapshot,
  type SwarmSnapshot
} from './agents.js';
import { flushDurable, initDurableStore, readDurable, writeDurableNow, writeDurableSoon } from './durable.js';
import { closeCorrelationStore, restoreRequestCorrelations } from './session/correlation.js';
import { restoreBlockedChats } from './session/blocked-chats.js';
import {
  GOAL_OBJECTIVES_STATE,
  GOAL_REPLIES_STATE,
  GOAL_SWITCHES_STATE,
  restoreGoalObjectives,
  restoreGoalReplies,
  restoreGoalSwitches,
  type GoalObjectivesSnapshot,
  type GoalRepliesSnapshot,
  type GoalSwitchesSnapshot
} from './goal.js';
import {
  CONTINUATIONS_STATE,
  restoreContinuations,
  setContinuationRecoveryHooks,
  type ContinuationSnapshot
} from './session/continuation.js';
import { runShutdownSequence } from './shutdown.js';
import { shutdownCodeModeRuntime } from './mcp/code-mode-runtime.js';
import { openInPreferredBrowser } from './browser.js';
import { applyLoginStartup, createBackendActivationGate, ownsAppRuntime, registerNativeWindowActivation, shouldBeginAppBootstrap } from './window-lifecycle.js';
import {
  createWorktreeActivityProbe,
  drainWorkRuntime,
  initWorkRuntime,
  reconcileWorkRuntime,
  type WorkRuntimeHandle
} from './work/runtime.js';
import {
  drainWorkContinuity
} from './work/continuity.js';
import {
  cancelWorkInput,
  deliverWorkInput,
  readWorkInput,
  setWorkInputBindingQuery
} from './work/input-outbox.js';
import { createWorktreeManager } from './work/worktrees.js';
import { createWorkConnection } from './work/connection.js';
import { initWorkBrowserHost } from './work/browser-host.js';
import { createWorkStore, type WorkStore } from './work/store.js';
import { startCliControlSocket } from '../cli/index.js';
import { removeStaleRuntimeDescriptor, type ControlSocketHandle } from './work/control-socket.js';
import { getInstallationId } from './identity.js';

/** Durable state file holding the multi-agent run. Hashes only, never credentials. */
const SWARM_STATE = 'swarm';
const RETIRED_WORKERS_STATE = 'retired-workers';
/** This entry is launched only by the GUI wrapper with this explicit process role. */
const daemonHost = process.argv.includes('--daemon-host') || process.argv.includes('--background');
if (!daemonHost) {
  process.stderr.write(`${PRODUCT_NAME}: desktop backend requires --daemon-host\n`);
  app.exit(2);
}

let quitting = false;
let shutdownStarted = false;
let shutdownComplete = false;
let releaseDataDirLock: (() => Promise<void>) | null = null;
/** The durable work authority for this host process, or null before its startup seam runs. */
let workRuntime: WorkRuntimeHandle | null = null;
/** The ledger is opened once and shared by the runtime and the tree manager. */
let workStore: WorkStore | null = null;
/** The local control socket; closed as part of the work-drain phase. */
let control: ControlSocketHandle | null = null;
const closeControlSocket = async (): Promise<void> => {
  const socket = control;
  control = null;
  if (socket) await socket.close();
};
/** Closes the ledger last: the drain still reads it to fence and terminate owned work. */
const closeWorkStore = (): void => {
  const store = workStore;
  workStore = null;
  workRuntime = null;
  try { store?.close(); } catch { /* A closed handle is the state we wanted. */ }
};
const usageWarmup = new AbortController();
/** Authenticated GUI sockets currently subscribed to backend IPC events. */
const remoteIpcSubscribers = new Set<RemoteIpcPush>();
/** Presence reported by the authenticated GUI client; this backend never owns a BrowserWindow. */
let guiVisible = false;

/** Opens the isolated GUI client without ever re-entering the persistent host role. */
function openDesktopClient(sessionId?: string): void {
  const root = app.isPackaged ? null : process.env.WGPT_REPO_ROOT?.trim() || path.resolve(__dirname, '../..');
  const env = { ...process.env };
  delete env.ELECTRON_RUN_AS_NODE;
  const child = spawn(process.execPath, [
    ...(root ? [root] : []), '--data-dir', dataDir, ...(sessionId ? [`--open-session=${sessionId}`] : [])
  ], {
    detached: true,
    stdio: 'ignore',
    env
  });
  child.unref();
}

setFinishNotifier((title, body, sessionId, turnId) => {
  if (!Notification.isSupported()) return false;
  const write = (): void => {
    if (remoteIpcSubscribers.size > 0) {
      for (const subscriber of remoteIpcSubscribers) subscriber('session:write', [sessionId]);
    } else {
      openDesktopClient(sessionId);
    }
  };
  const notice = new Notification({ title, body, actions: [
    { type: 'button', text: 'Send Automatic Goal' }, { type: 'button', text: 'Write Directly' }
  ] });
  notice.on('click', write);
  notice.on('action', (details) => {
    if (details.actionIndex === 0) void requestSessionFinishGoal(sessionId, turnId).catch(error => logWarn(`Finish goal: ${error.message}`));
    else if (details.actionIndex === 1) write();
  });
  notice.show();
  return true;
});

// Identity and the data directory come first, before the single-instance lock and before any
// store has captured a path. Electron derives its default `userData` from the application
// name, so resolving one without the other is how a run ends up with two half-answers about
// where its own history lives. `--data-dir <absolute-path>` redirects all of it for an
// isolated run; a relative value is refused rather than silently resolved against whatever
// directory happened to launch the process.
let dataDir = '';
try {
  dataDir = resolveAndApplyUserData(app, process.argv);
} catch (error) {
  // A bad `--data-dir` is a caller error and the app cannot start without somewhere to keep
  // its state. Reporting it and exiting is the only honest outcome; a fallback directory
  // would run against the real installation while the caller believed otherwise.
  //
  // `quitting` is set first for the same reason the losing single-instance branch sets it:
  // `app.exit()` does not stop the rest of this module from executing, and the guards below
  // are what keep a doomed process out of the shared config and durable stores.
  process.stderr.write(`${PRODUCT_NAME}: ${error instanceof Error ? error.message : String(error)}\n`);
  quitting = true;
  app.exit(2);
}

// One instance only: two copies would fight over the tunnel, the control socket and the
// config file. Requested *after* the data directory is applied, so two installations pointed
// at different directories do not exclude each other.
const hasSingleInstanceLock = app.requestSingleInstanceLock();
if (!hasSingleInstanceLock) {
  // `app.quit()` does not make the rest of this module stop executing. Mark this process as a
  // terminal secondary instance immediately, so neither native activation nor the async bootstrap
  // below can touch shared config/durable state while the primary instance is still running.
  quitting = true;
  app.quit();
}

// A fresh app launch can be delivered to the resident host instead of starting a GUI. Do not
// mistake a second *host* launch (login/startHost) for an invitation to show a window. The gate
// retains a genuine early relaunch until the GUI control surface has finished bootstrapping.
const activation = createBackendActivationGate(() => openDesktopClient());
app.on('second-instance', (_event, argv) => {
  if (!hasSingleInstanceLock || quitting) return;
  activation.request(argv);
});

void app.whenReady().then(async () => {
  // This guard is intentionally before even app.getPath/init* calls. A secondary instance, or a
  // primary that was told to quit before ready, must never touch the primary's shared userData.
  if (!shouldBeginAppBootstrap(hasSingleInstanceLock, quitting)) return;
  // The GUI client owns visible macOS application presence. Hiding this windowless host does
  // not disable its native dialogs, notifications, Keychain access, or desktop helper APIs.
  if (process.platform === 'darwin') app.dock?.hide();
  const userData = app.getPath('userData');
  // Read back rather than trusting the set: every store below is rooted here, and a silent
  // disagreement between the directory we resolved and the one Electron reports would be
  // discovered only as missing history.
  if (userData !== dataDir) logWarn(`userData is ${userData}, not the resolved ${dataDir}`);
  // Electron's single-instance lock excludes only another Electron host. The standalone daemon
  // uses the same stores without Electron, so both hosts must claim the shared directory before
  // either initializes logging, config, secrets, or the durable ledger.
  ensurePrivateDir(userData);
  try {
    releaseDataDirLock = await acquireDataDirLock(userData, { instanceId: randomUUID(), kind: 'desktop' });
  } catch (error) {
    process.stderr.write(`${PRODUCT_NAME}: ${error instanceof Error ? error.message : String(error)}\n`);
    quitting = true;
    app.exit(1);
    return;
  }
  initLogFile(path.join(userData, 'app.log'));
  process.on('uncaughtExceptionMonitor', (error, origin) => {
    snapshotLogOnCrash(`${origin}: ${error.stack ?? error.message}`);
  });
  // The app-owned Chrome profile is created here, once, at 0700 — before anything can launch
  // a browser into it and before Chrome could create it with whatever the umask allows. The
  // companion extension and the ChatGPT login both live in this directory, and no launch ever
  // points at the user's own profile.
  ensurePrivateDir(browserProfileDir(userData));
  // Suspension control: work that is "running" must not be idled out by the OS, and a Mac
  // that sleeps runs no commands. The blocker is reference-counted by the work runtime and
  // released when nothing is active; nothing here keeps the display awake.
  initPowerManagement(powerSaveBlocker, logWarn);
  initConfigPath(userData);
  initSecretsPath(userData);
  initSessionStore(userData);
  try { await initSkillsPath(userData); }
  catch (error) { logWarn(`Skills library unavailable: ${error instanceof Error ? error.message : String(error)}`); }
  initDurableStore(userData);
  await restoreChatModels();
  await loadConfig();
  await pluginManager.initialize(userData);
  onEmbeddedCuaChanged(() => {
    forgetExposedSurface();
    refreshPluginPublication('desktop');
  });
  // The backend is the Electron application authority; native CUA is its own bundled child.
  // Startup cannot hold the renderer or Core behind a native permission/driver failure.
  const cuaBinary = process.platform === 'win32' ? 'cua-driver.exe' : 'cua-driver';
  void startEmbeddedCua({
    binaryPath: app.isPackaged
      ? path.join(process.resourcesPath, 'desktop', cuaBinary)
      : path.resolve('resources', 'packaging', 'desktop', process.platform, process.arch, cuaBinary),
    sdkModule: app.isPackaged
      ? pathToFileURL(path.join(process.resourcesPath, 'app.asar.unpacked', 'node_modules',
        '@trycua', 'cua-driver', 'dist', 'embedded.js')).href
      : '@trycua/cua-driver/embedded'
  });
  try { applyLoginStartup(app, getConfig().ui.startAtLogin === true); }
  catch (error) { logWarn(`login startup: ${error instanceof Error ? error.message : String(error)}`); }
  const savedGoalObjectives = await readDurable<GoalObjectivesSnapshot>(GOAL_OBJECTIVES_STATE);
  restoreGoalObjectives(savedGoalObjectives);
  const savedGoalSwitches = await readDurable<GoalSwitchesSnapshot>(GOAL_SWITCHES_STATE);
  restoreGoalSwitches(savedGoalSwitches);
  const savedGoalReplies = await readDurable<GoalRepliesSnapshot>(GOAL_REPLIES_STATE);
  restoreGoalReplies(savedGoalReplies);
  // Request ownership must exist before either side of the bridge can race in. A request id
  // that was proved yesterday remains the same workflow today even if its ChatGPT tab closed.
  await restoreRequestCorrelations();
  // And the user's blocks, for the same reason: a chat blocked yesterday is still the rogue
  // turn today, and a block that loads after the first call is a tool the turn already got.
  await restoreBlockedChats();
  setAgentConversationLookup(agentConversation);
  // The prime's chat is the user's own, so no extension report can name it. It is bound
  // when the recorder manages to place the prime's first call. See recordToolCall.
  setAgentBinder(bindConversation);
  // Before anything can call an agent tool, and before a run is restored: the broker
  // decides whether a previous run has been abandoned partly from which ChatGPT tabs are
  // open, and without this it can only answer "I cannot see" — which it treats, on
  // purpose, as a reason to leave the existing run alone.
  // How a fresh chat opens when no browser can be asked to open it. The app asks the OS for
  // the ChatGPT URL, which launches the browser if it is closed and creates the tab if there
  // is none — the two cases the old "wait for a ChatGPT tab to poll us" delivery could never
  // handle. Wired before any restored command is delivered, so a resume queued yesterday opens
  // as soon as the bridge starts rather than waiting for the user to visit ChatGPT.
  //
  // It is deliberately not how a page-driven Compact & Resume opens chat B. The OS resolves a
  // URL to whichever browser instance last had focus, which is a different window — and can be
  // a browser without this extension in it — from the one holding chat A. That decision belongs
  // to the browser that owns the source chat; see bridge.ts::offerPlacement.
  setBrowserOpener(async (url) => {
    // Let the command owner report launch failure; another browser may belong to another account.
    await openInPreferredBrowser(url);
  });

  // Persistence is a process-lifetime dependency of the broker, not a feature-toggle
  // dependency. Multi-agent can be enabled from Settings without restarting the process;
  // keeping both sinks wired from startup guarantees the first spawn can cross its durable
  // acceptance barrier even when this launch began with multi-agent disabled.
  onSwarmPersist(() => writeDurableSoon(SWARM_STATE, snapshotSwarm()));
  onSwarmPersistNow((snapshot) => writeDurableNow(SWARM_STATE, snapshot));

  // A multi-agent run outlives this process. Restoring it before the bridge starts
  // means a worker that never joined gets its chat re-requested through the same queue
  // as a fresh one, rather than being stranded with a key nobody has.
  onRetiredWorkersPersist(() => writeDurableSoon(RETIRED_WORKERS_STATE, snapshotRetiredWorkers()));
  onRetiredWorkersPersistNow((snapshot) => writeDurableNow(RETIRED_WORKERS_STATE, snapshot));
  const retiredWorkers = await readDurable<RetiredWorkersSnapshot>(RETIRED_WORKERS_STATE);
  restoreRetiredWorkers(retiredWorkers);
  const savedSwarm = await readDurable<SwarmSnapshot>(SWARM_STATE);
  restoreSwarm(savedSwarm);
  if (!getConfig().multiAgent.enabled) {
    // A feature toggle is a pause, not Clear swarm. Canonicalize any active incarnation left by
    // a crash into stopped prime-owned history before the bridge exists, then make that safer
    // projection durable. Re-enabling later in this process or after another restart recovers the
    // same exact worker conversations without letting disabled workers consume execution slots.
    pauseSwarmForDisable('multi-agent mode is disabled');
    await writeDurableNow(SWARM_STATE, snapshotSwarm());
    }
  // Continuation recovery is after swarm restore because an interrupted durable rebind may
  // have to finish publishing the prime transfer that was frozen in that snapshot.
  setContinuationRecoveryHooks({
    repairPrimeTransfer: repairPrimeConversationAfterRecovery
  });
  const savedContinuations = await readDurable<ContinuationSnapshot>(CONTINUATIONS_STATE);
  await restoreContinuations(savedContinuations);
  await reconcileAgentRequestOwners();

  // --- work runtime init (owned by work-runtime-engine) -------------------------------
  // Durable state is restored and nothing has been admitted yet. The work authority, the MCP
  // admission gate and the broker hooks are all installed here, before `registerIpc`/
  // `startBridge`/`connect` can admit anything — and on a `--background` launch too, because
  // only window presentation differs for that flag, never storage restoration.
  removeStaleRuntimeDescriptor(userData);
  workStore = createWorkStore({ dataDir: userData });
  const worktrees = createWorktreeManager({
    userDataDir: userData,
    worktreesRoot: path.join(userData, 'worktrees'),
    store: workStore,
    // A worktree is busy while any of its work's operations is still prepared/running; without
    // this the integration quiescence check would always pass and integrate under a live command.
    activity: createWorktreeActivityProbe(workStore)
  });
  workRuntime = await initWorkRuntime({
    dataDir: userData,
    worktreesRoot: path.join(userData, 'worktrees'),
    worktrees,
    store: workStore,
    deliverOutbox: async input => {
      // One door into the outbox for every managed message, addressed by the persisted command id.
      // `dueAt` is the durable command's own creation instant, so a retry after a lost
      // acknowledgement reuses the same row and the same schedule instead of opening a second chat.
      return deliverWorkInput({
        id: input.id,
        sessionId: input.sessionId,
        text: input.text,
        model: input.model,
        reasoning: input.reasoning,
        dueAt: input.dueAt,
        kind: 'instruction',
        // The row records which work it answers to, so the outbox's final Send can refuse a work
        // the user has stopped or a chat that is no longer that work's prime.
        workId: input.workId
      });
    },
    // A stopped work still reconciles an input that was already authorized: the native receipt can
    // land after the stop, and this read is what lets the ledger record it instead of losing it.
    readOutbox: async id => readWorkInput(id),
    // A cancellation withdraws only what is provably unsent; anything the browser may already have
    // keeps its ambiguous receipt instead of being reported as cancelled.
    cancelOutbox: async id => cancelWorkInput(id)
  });
  await reconcileWorkRuntime();

  await initWorkBrowserHost(workStore, () => workRuntime?.service ?? null);
  // The local connection/reconnect backend. It reports what is true about a work's existing chat
  // and may open that exact chat in the app's own profile; it never creates or rebinds anything.
  // `chatUrl` is the host's single URL writer, and the page sighting comes from the authenticated
  // browser poll path, so a bridge heartbeat or an attributed MCP call can never be mistaken for
  // "the chat is open".
  const connection = createWorkConnection({
    store: () => workStore,
    pageObservedAt: conversationPageObservedAt,
    readSession: sessionId => getSession(sessionId).catch(() => null),
    open: async conversationId => {
      await openInPreferredBrowser(chatUrl(conversationId));
    }
  });
  // Install the full, fixed renderer allowlist before the descriptor is published. A GUI client
  // can only enter through this port after its descriptor-backed handshake; it never opens a
  // store or runs an Electron IPC handler locally.
  const guiLease = registerIpc(
    () => null,
    (channel, args) => {
      for (const subscriber of remoteIpcSubscribers) subscriber(channel, args);
    },
    () => guiVisible
  );
  const guiControlToken = randomUUID();
  let rendererOwner: { id: string; listener: RemoteIpcPush } | null = null;
  let latestGuiConnection = 0;
  const guiControl = {
    invoke: (channel: string, payload: unknown, rendererId: string | null) => {
      if ((channel === 'workspaceTerminal:request' || channel === 'projectFiles:watch') &&
          (!rendererId || rendererOwner?.id !== rendererId)) {
        return Promise.resolve({ ok: false, error: 'The owning desktop view was closed or replaced.' });
      }
      return invokeRegisteredIpc(channel, payload);
    },
    presence: (visible: boolean, connectionOrder: number): void => {
      if (connectionOrder === latestGuiConnection && remoteIpcSubscribers.size > 0) guiVisible = visible;
    },
    subscribe: (listener: RemoteIpcPush, rendererId: string | null, connectionOrder: number): (() => void) => {
      // An old connection finishing its handshake after a reload cannot replace the new view.
      if (connectionOrder < latestGuiConnection) throw new Error('The desktop connection was replaced.');
      latestGuiConnection = connectionOrder;
      remoteIpcSubscribers.add(listener);
      guiLease.disposeClient();
      rendererOwner = rendererId ? { id: rendererId, listener } : null;
      return () => {
        remoteIpcSubscribers.delete(listener);
        if (rendererOwner?.listener === listener) {
          rendererOwner = null;
          guiLease.disposeClient();
        }
        if (remoteIpcSubscribers.size === 0) {
          guiVisible = false;
        }
      };
    }
  };
  // The control endpoint is a secondary surface, and on Windows its access control is a
  // precondition rather than a detail: the pipe is published only after it has been narrowed
  // to this user and that narrowing verified. A host that cannot prove that does not publish,
  // and must still open — refusing to start would turn a missing CLI into a missing
  // application, which is the failure this endpoint was just fixed for.
  try {
    control = await startCliControlSocket({
      dataDir: userData,
      installationId: getInstallationId(),
      service: workRuntime.service,
      connection,
      gui: guiControl,
      authToken: guiControlToken,
      onHostStopRequested: () => app.quit()
    });
  } catch (error) {
    logWarn(`control socket unavailable: ${error instanceof Error ? error.message : String(error)}`);
  }
  // The backend has no Electron web contents. Renderer CSP, permissions, windows, menus and
  // tray belong exclusively to the separate desktop-client process.
  // macOS also emits `activate` while booting a background/host process. Installing the native
  // handler only now prevents that boot event from spawning a GUI, while subsequent Dock opens
  // reuse the same launch path as notification clicks.
  if (!quitting) {
    registerNativeWindowActivation(app, () => activation.request());
    activation.enable();
  }

  logInfo('app started');

  // Historical Unattributed repair may legitimately scan and rewrite a large legacy bucket.
  // It is maintenance, not a prerequisite for showing the app or accepting new exact-id
  // traffic, so never make startup/reload wait behind years of old session history.
  queueDeterministicAttributionRepair();

  // Recording, workers and direct browser tools share one extension transport.
  // ipc.ts uses the same eligibility rule when settings change.
  if (browserExtensionRequired(getConfig())) {
    void startBridge();
  }
  if (getConfig().ui.autoConnect) void connect();

  // Warm the existing derived cache once, after startup, without delaying the UI.
  // A visit to Usage joins this same calculation; unchanged recordings cost no reads.
  void usageOverview(usageWarmup.signal).catch((error: Error) => {
    if (!usageWarmup.signal.aborted) logWarn(`usage background refresh failed: ${error.message}`);
  });
}).catch(async (error: unknown) => {
  const message = error instanceof Error ? error.stack ?? error.message : String(error);
  process.stderr.write(`${PRODUCT_NAME}: backend startup failed: ${message}\n`);
  const release = releaseDataDirLock;
  releaseDataDirLock = null;
  await release?.().catch(() => undefined);
  quitting = true;
  app.exit(1);
});

app.on('before-quit', () => {
  if (!ownsAppRuntime(hasSingleInstanceLock)) return;
  quitting = true;
  activation.disable();
  usageWarmup.abort();
});

app.on('will-quit', (event) => {
  // A secondary instance called app.quit() only to get out of the primary's way. It must be
  // allowed to exit normally: preventing that quit and flushing/stopping the primary's shared
  // stores from a process that never initialized or owns them is both a hang and data race.
  if (!ownsAppRuntime(hasSingleInstanceLock)) return;
  if (shutdownComplete) return;
  event.preventDefault();
  if (shutdownStarted) return;
  shutdownStarted = true;
  stopInputStartup();

  void runShutdownSequence(
    [
      // Phase 1: stop both listeners from admitting work and let accepted requests drain.
      // The budget has to clear the drains it contains, or it would silently defeat them:
      // the bridge force-closes wedged localhost sockets at 15s and the MCP endpoint forces
      // its own drain at 30s. This is the outer bound on both, not a competing one.
      { name: 'admission/drain', budgetMs: 40_000, run: () => [shutdownConnection(), shutdownBridge()] },
      // --- work drain (owned by work-runtime-engine) ------------------------------------
      // Work drain belongs HERE: after admissions are fenced and before any owned child
      // process is cleaned up, so pause/cancel can still terminate the process groups it
      // owns and nothing may start new work while it settles.
      //
      // Continuity stops FIRST: it is the only component that could still hand a message to the
      // outbox after the endpoint closed, and stopping it here is what guarantees no controller
      // instruction or report is admitted during teardown.
      {
        name: 'work drain',
        budgetMs: 30_000,
        run: () => {
          setWorkInputBindingQuery(null);
          return [drainWorkContinuity(), drainWorkRuntime(), closeControlSocket()];
        }
      },
      // Phase 2: only after request handlers are done may their owned child processes go.
      {
        name: 'process cleanup',
        budgetMs: 15_000,
        run: () => [unifiedExecManager.terminateAllProcesses(), stopEmbeddedCua(), pluginManager.close(), shutdownCodeModeRuntime()]
      },
      // The ledger is the last thing to close: every phase above may still read it.
      { name: 'work ledger', budgetMs: 5_000, run: () => [Promise.resolve(closeWorkStore())] },
      // Phase 3: recorder work can enqueue both session projections and named durable state.
      { name: 'recorder flush', budgetMs: 10_000, run: () => [flushRecorder()] },
      // These are independent writers. One rejection must never skip the other flush.
      { name: 'durable flush', budgetMs: 10_000, run: () => [flushSessions(), flushDurable().then(closeCorrelationStore)] }
    ],
    {
      info: logInfo,
      warn: logWarn,
      error: logError,
      // Not `app.quit()`. See the note on ShutdownHooks.exit: a quit raised from the
      // continuation that ends this sequence is dropped by Electron, and the app is left
      // running with nothing to click and the single-instance lock still held.
      exit: () => {
        // The sequence has just logged its completion; a phase inside it would flush too early.
        void (async () => {
          await flushLogBeforeExit().catch(() => undefined);
          const release = releaseDataDirLock;
          releaseDataDirLock = null;
          await release?.().catch(() => undefined);
          shutdownComplete = true;
          app.exit(0);
        })();
      }
    }
  );
});
