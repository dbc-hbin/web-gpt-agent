import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { existsSync } from 'node:fs';
import { browserProfileDir, ensurePrivateDir } from '../main/identity.js';
import { materializeExtension } from '../main/extension-materialize.js';
import { openInPreferredBrowser } from '../main/browser.js';
import { chatUrl, setBrowserOpener, startBridge, stopBridge } from '../main/bridge.js';
import { restoreChatModels } from '../main/chat-models.js';
import { readDurable, writeDurableNow, writeDurableSoon } from '../main/durable.js';
import { restoreBlockedChats } from '../main/session/blocked-chats.js';
import { setAgentBinder, setAgentConversationLookup, conversationPageObservedAt } from '../main/session/recorder.js';
import { getSession } from '../main/session/store.js';
import { setInputStartupHost, stopInputStartup } from '../main/session/start-input.js';
import { agentConversation, bindConversation, onSwarmPersist, onSwarmPersistNow,
  onRetiredWorkersPersist, onRetiredWorkersPersistNow, restoreSwarm, restoreRetiredWorkers,
  snapshotSwarm, snapshotRetiredWorkers, reconcileAgentRequestOwners,
  repairPrimeConversationAfterRecovery, type SwarmSnapshot, type RetiredWorkersSnapshot } from '../main/agents.js';
import { CONTINUATIONS_STATE, restoreContinuations, setContinuationRecoveryHooks,
  type ContinuationSnapshot } from '../main/session/continuation.js';
import { GOAL_OBJECTIVES_STATE, GOAL_SWITCHES_STATE, GOAL_REPLIES_STATE,
  restoreGoalObjectives, restoreGoalSwitches, restoreGoalReplies,
  type GoalObjectivesSnapshot, type GoalSwitchesSnapshot, type GoalRepliesSnapshot } from '../main/goal.js';
import { deliverWorkInput, readWorkInput, cancelWorkInput, setWorkInputBindingQuery, setWorkInputInstructionQuery } from '../main/work/input-outbox.js';
import { initWorkBrowserHost } from '../main/work/browser-host.js';
import { drainWorkContinuity } from '../main/work/continuity.js';
import { createWorkConnection } from '../main/work/connection.js';
import type { WorkConnectionPort } from '../shared/work-connection.js';
import type { WorkRuntimeDeps, WorkRuntimeHandle } from '../main/work/runtime.js';
import type { WorkStore } from '../main/work/store.js';

export interface DaemonBrowserAdapter {
  extensionDir: string;
  delivery: Required<Pick<WorkRuntimeDeps, 'deliverOutbox' | 'readOutbox' | 'cancelOutbox'>>;
  connection: WorkConnectionPort | null;
  attach(store: WorkStore, runtime: WorkRuntimeHandle): Promise<void>;
  start(): Promise<void>;
  stop(): Promise<void>;
}

/** Optional browser transport; coding tools keep running independently of browser availability. */
export async function prepareDaemonBrowser(dataDir: string): Promise<DaemonBrowserAdapter> {
  ensurePrivateDir(browserProfileDir());
  const candidates = [
    path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../extension'),
    path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../../extension'),
    path.join(process.cwd(), 'extension'),
    ...(process.resourcesPath ? [path.join(process.resourcesPath, 'extension')] : [])
  ];
  const bundled = candidates.find(dir => existsSync(path.join(dir, 'manifest.json'))) ?? candidates[0]!;
  const extensionDir = materializeExtension(bundled, path.join(dataDir, 'extension'));
  if (!extensionDir) throw new Error('Browser delivery needs the companion extension next to the daemon distribution.');
  await restoreChatModels();
  await restoreBlockedChats();
  restoreGoalObjectives(await readDurable<GoalObjectivesSnapshot>(GOAL_OBJECTIVES_STATE));
  restoreGoalSwitches(await readDurable<GoalSwitchesSnapshot>(GOAL_SWITCHES_STATE));
  restoreGoalReplies(await readDurable<GoalRepliesSnapshot>(GOAL_REPLIES_STATE));
  setAgentConversationLookup(agentConversation);
  setAgentBinder(bindConversation);
  setBrowserOpener(async url => { await openInPreferredBrowser(url); });
  onSwarmPersist(() => writeDurableSoon('swarm', snapshotSwarm()));
  onSwarmPersistNow(snapshot => writeDurableNow('swarm', snapshot));
  onRetiredWorkersPersist(() => writeDurableSoon('retired-workers', snapshotRetiredWorkers()));
  onRetiredWorkersPersistNow(snapshot => writeDurableNow('retired-workers', snapshot));
  restoreRetiredWorkers(await readDurable<RetiredWorkersSnapshot>('retired-workers'));
  restoreSwarm(await readDurable<SwarmSnapshot>('swarm'));
  setContinuationRecoveryHooks({ repairPrimeTransfer: repairPrimeConversationAfterRecovery });
  await restoreContinuations(await readDurable<ContinuationSnapshot>(CONTINUATIONS_STATE));
  await reconcileAgentRequestOwners();
  let stopped = false;
  const start = async (): Promise<void> => {
    if (stopped) throw new Error('Browser delivery is stopped');
    if (!await startBridge()) throw new Error('The browser bridge could not start');
  };
  setInputStartupHost(async signal => {
    signal?.throwIfAborted();
    await start();
    signal?.throwIfAborted();
  });
  const adapter: DaemonBrowserAdapter = {
    extensionDir,
    delivery: {
      deliverOutbox: input => deliverWorkInput({ ...input, kind: 'instruction' }),
      readOutbox: readWorkInput,
      cancelOutbox: cancelWorkInput
    },
    connection: null,
    async attach(store, runtime) {
      await initWorkBrowserHost(store, () => runtime.service);
      adapter.connection = createWorkConnection({
        store: () => store,
        pageObservedAt: conversationPageObservedAt,
        readSession: id => getSession(id).catch(() => null),
        open: async id => { await openInPreferredBrowser(chatUrl(id)); }
      });
    },
    start,
    async stop() {
      stopped = true;
      stopInputStartup();
      await drainWorkContinuity();
      await stopBridge();
      setWorkInputBindingQuery(null);
      setWorkInputInstructionQuery(null);
      setInputStartupHost(null);
      stopInputStartup();
      setBrowserOpener(null);
    }
  };
  return adapter;
}
