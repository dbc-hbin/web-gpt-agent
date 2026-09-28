/**
 * One recovery owner per managed work/agent/generation.
 *
 * The upstream bridge already knows how to notice a silent ChatGPT tab and reload it, and the
 * continuation transaction already knows how to move a conversation to a fresh one. What did
 * not exist is a single authority that decides *which* of those facts about a managed agent's
 * turn mean "this generation is dead", how many times it may act, and what counts as forward
 * progress — and that survives a host restart.
 *
 * This module is that authority. It owns no browser, no timer and no database: it takes
 * observations, decides, and calls the injected actions. The bridge's own unmanaged
 * silence/goal path keeps running untouched for every other chat.
 *
 * The policy, in order:
 *
 * 1. An explicit current-turn `thinking_failed` or transport failure starts reconciliation
 *    once. Quoted or historical text is never a trigger; the caller only forwards an
 *    observation it proved belongs to the live turn.
 * 2. A living local command is checked first. A quiet browser with a running command is not
 *    a dead turn, and nothing is restarted or duplicated because the page is quiet.
 * 3. With no command and no progress, the model-aware silence window applies (normal/unknown
 *    120s, Pro 600s, Pro shortened to 300s after a confirmed thinking failure), then one
 *    reload. Observe 60s. Then one same-conversation continuation carrying the durable
 *    checkpoint. The prompt id is persisted before delivery.
 * 4. If that fails or stays silent for another window, transfer through the existing
 *    continuation transaction to a fresh conversation, handing over a host-generated
 *    checkpoint labelled as recorded facts when the source cannot write a summary.
 * 5. Three episodes without durable forward progress mark the work `blocked`
 *    (`RECOVERY_EXHAUSTED`). Only a new verified worktree tree hash, a newly completed
 *    successful operation with an unseen canonical hash, or an explicit new user instruction
 *    resets the count.
 */

/**
 * The durable recovery record. It lives here rather than in the shared interface schema
 * because it is internal persistence: `WorkStatus` carries a small projection of it, not the
 * record itself. Keeping the shape in the module that owns its state machine means the
 * ledger cannot drift from the policy that reads it.
 */
export type RecoveryPhase = 'idle' | 'observing' | 'reloading' | 'continuing' | 'transferring' | 'blocked';

export interface RecoveryRecord {
  work_id: string;
  agent_id: string;
  session_id: string;
  conversation_id: string;
  /** Monotonic per agent binding. A replacement conversation is a new generation. */
  generation: number;
  turn_id: string;
  phase: RecoveryPhase;
  /** Recovery episodes that produced no durable forward progress. */
  episodes: number;
  /** Attempts inside the current episode: reload, continuation, transfer. */
  attempts: number;
  thinking_failed: boolean;
  /** Positively identified Pro work earns the longer silence window. */
  pro: boolean;
  /** Absolute wall clock; survives restart so a deadline cannot be forgotten. */
  next_attempt_at: number;
  /** Persisted before a continuation is delivered, so a crash cannot duplicate the send. */
  prompt_id: string | null;
  /** Marker of the last durable progress; a repeat is not progress. */
  last_progress: string | null;
  observed_at: number;
  updated_at: number;
}

/** The projection every interface displays; never the internal record verbatim. */
export interface RecoveryEvent {
  work_id: string;
  agent_id: string;
  generation: number;
  phase: RecoveryPhase;
  episodes: number;
  attempts: number;
  next_attempt_at: number;
}

/** What a managed agent's conversation told us. Only proven current-turn facts arrive here. */
export interface RecoveryObservation {
  workId: string;
  agentId: string;
  sessionId: string;
  conversationId: string;
  turnId: string;
  generation: number;
  at: number;
}

export interface TurnFailureObservation extends RecoveryObservation {
  kind: 'thinking_failed' | 'transport_failure';
  detail?: string;
  /**
   * Provider-supplied retry time for an explicit rate-limit response, when one was read.
   * Absent means the fixed 60/120/300s backoff applies.
   */
  retryAfterMs?: number;
  /** A login/CAPTCHA/account wall, which is never retried and never bypassed. */
  authWall?: 'AUTH_REQUIRED' | 'PROVIDER_UNAVAILABLE';
}

export interface SilenceObservation extends RecoveryObservation {
  kind: 'silence';
  /** Positively identified Pro work earns the longer window. */
  pro: boolean;
}

export interface ProgressObservation extends RecoveryObservation {
  kind: 'progress';
  /**
   * The durable marker of what actually advanced. Two observations with the same marker are
   * not progress: a reworded checkpoint, a repeated successful search or a page heartbeat
   * must not reset the episode count.
   */
  marker: ProgressMarker;
}

export type ProgressMarker =
  | { kind: 'operation'; inputHash: string; resultHash: string }
  | { kind: 'tree'; treeHash: string }
  | { kind: 'instruction'; textHash: string };

/** The durable facts a continuation or transfer needs to describe the real state. */
export interface RecoveryCheckpoint {
  summary: string;
  remaining: string[];
  verification: Array<{ operation_id: string; outcome: 'passed' | 'failed' }>;
  revision: number;
  /** Recorded facts for a source that cannot write its own summary. */
  hostGenerated: boolean;
}

/** Reads the factual state the owner is allowed to trust. */
export interface RecoveryPort {
  load(agentId: string, generation: number): RecoveryRecord | null;
  save(record: RecoveryRecord): void;
  /** Every record, so startup can re-arm deadlines that outlived the process. */
  list(): RecoveryRecord[];
  /** Live local commands owned by this agent/generation. */
  hasActiveCommands(observation: RecoveryObservation): boolean;
  /** Last durable progress marker for this agent/generation, if any. */
  lastProgress(observation: RecoveryObservation): ProgressMarker | null;
  /** Latest durable checkpoint for the work, or null when none was ever recorded. */
  readCheckpoint(workId: string): RecoveryCheckpoint | null;
  /** Monotonic generation fence; the old generation may never mutate again. */
  fenceGeneration(input: { workId: string; agentId: string; generation: number }): void;
  /** Records the fact for every interface; `blocked` is never success. */
  markBlocked(input: { workId: string; reason: 'RECOVERY_EXHAUSTED' | 'AUTH_REQUIRED' | 'PROVIDER_UNAVAILABLE'; detail: string }): void;
  /** Bumps the agent's generation and returns the new one. */
  advanceGeneration(input: { workId: string; agentId: string }): number;
  appendEvent(workId: string, kind: string, payload: unknown): number;
}

/** Everything the owner can do to a conversation. Implemented by the runtime. */
export interface RecoveryActions {
  /** The bridge's existing one-shot reload for this exact conversation. */
  reload(input: { sessionId: string; conversationId: string; workId: string; agentId: string; generation: number; reason: string }): Promise<boolean>;
  /**
   * One same-conversation continuation. `promptId` is persisted before this is called, so a
   * crash between the two leaves a retryable record rather than a duplicated send.
   */
  continueConversation(input: {
    sessionId: string;
    conversationId: string;
    promptId: string;
    text: string;
    workId: string;
    agentId: string;
    generation: number;
  }): Promise<boolean>;
  /**
   * Moves the agent to a fresh conversation through the existing continuation transaction,
   * with a host-generated checkpoint when the source cannot summarize itself.
   */
  transfer(input: {
    workId: string;
    agentId: string;
    generation: number;
    sessionId: string;
    conversationId: string;
    checkpoint: RecoveryCheckpoint;
  }): Promise<boolean>;
  /** Starts the observation clock for a new generation after a successful transfer. */
  onGenerationAdvanced(input: { workId: string; agentId: string; generation: number }): void;
}

export interface RecoveryOwnerDeps {
  port: RecoveryPort;
  actions: RecoveryActions;
  now?: () => number;
  /** Injectable delay so tests drive deadlines without real time. */
  schedule?: (delayMs: number, run: () => void) => () => void;
}

/** Upstream's model-aware windows, kept identical to bridge.ts::silenceWindowMs. */
export const SILENCE_NORMAL_MS = 120_000;
export const SILENCE_PRO_MS = 600_000;
export const SILENCE_PRO_AFTER_FAILURE_MS = 300_000;
/** The observation window after a reload, before a continuation is attempted. */
export const POST_RELOAD_OBSERVE_MS = 60_000;
/** Fixed backoff for rate-limited or failed attempts when the provider names no time. */
export const RETRY_BACKOFF_MS = [60_000, 120_000, 300_000] as const;
/** Episodes without durable forward progress before the work is blocked. */
export const MAX_EPISODES = 3;

function silenceWindowMs(pro: boolean, thinkingFailed: boolean): number {
  if (!pro) return SILENCE_NORMAL_MS;
  return thinkingFailed ? SILENCE_PRO_AFTER_FAILURE_MS : SILENCE_PRO_MS;
}

/** One live decision: what the owner wants done now. */
export type RecoveryDecision =
  | { kind: 'none' }
  | { kind: 'wait'; until: number }
  | { kind: 'reload' }
  | { kind: 'continue'; promptId: string; text: string }
  | { kind: 'transfer' }
  | { kind: 'blocked'; reason: 'RECOVERY_EXHAUSTED' | 'AUTH_REQUIRED' | 'PROVIDER_UNAVAILABLE'; detail: string };

function freshRecord(observation: RecoveryObservation, now: number): RecoveryRecord {
  return {
    work_id: observation.workId,
    agent_id: observation.agentId,
    session_id: observation.sessionId,
    conversation_id: observation.conversationId,
    generation: observation.generation,
    turn_id: observation.turnId,
    phase: 'idle',
    episodes: 0,
    attempts: 0,
    thinking_failed: false,
    pro: false,
    next_attempt_at: now,
    prompt_id: null,
    last_progress: null,
    observed_at: now,
    updated_at: now
  };
}

/**
 * A compact, deterministic description of the durable state for a continuation prompt.
 * It describes recorded facts and never invents a model answer.
 */
/**
 * What the host knows about an interrupted turn, as facts rather than instructions.
 *
 * The model already knows the task and that its last turn was cut off — that is the visible
 * conversation. What it cannot see is the durable state the app recorded, so that is all this
 * carries: the recorded summary, what is outstanding, and which checks were recorded. No warnings,
 * no procedures and no tool recipes; the values are labeled so they are read as the app's facts.
 */
export function continuationText(checkpoint: RecoveryCheckpoint): string {
  const lines = ['Recorded state from the app:'];
  if (checkpoint.summary.trim()) lines.push(`- Summary: ${checkpoint.summary.trim()}`);
  if (checkpoint.remaining.length) lines.push(`- Outstanding: ${checkpoint.remaining.join('; ')}`);
  if (checkpoint.verification.length) {
    lines.push(`- Checks: ${checkpoint.verification.map((item) => `${item.operation_id}=${item.outcome}`).join(', ')}`);
  }
  return lines.join('\n');
}

export interface RecoveryOwner {
  /** Forwards a proven current-turn failure. Returns the decision taken. */
  noteTurnFailure(observation: TurnFailureObservation): RecoveryDecision;
  /** Forwards proven silence for the live turn. */
  noteSilence(observation: SilenceObservation): RecoveryDecision;
  /** Forwards a durable progress marker; may reset the episode count. */
  noteProgress(observation: ProgressObservation): void;
  /** An explicit new user instruction resets the episode count for this work. */
  noteUserInstruction(input: { workId: string; agentId: string; generation: number; textHash: string }): void;
  /** Re-arms deadlines that outlived the process. */
  reconcileOnStartup(): RecoveryDecision[];
  /** Whether this generation is still allowed to mutate. */
  isCurrent(agentId: string, generation: number): boolean;
  /** Test/observability: the persisted record for one generation. */
  record(agentId: string, generation: number): RecoveryRecord | null;
  /** All records, newest update last. */
  records(): RecoveryRecord[];
}

export function createRecoveryOwner(deps: RecoveryOwnerDeps): RecoveryOwner {
  const { port, actions } = deps;
  const now = deps.now ?? (() => Date.now());
  const schedule = deps.schedule ?? ((delayMs, run) => {
    const timer = setTimeout(run, delayMs);
    timer.unref?.();
    return () => clearTimeout(timer);
  });
  /** One pending scheduled tick per agent, so a burst of observations cannot stack timers. */
  const pending = new Map<string, () => void>();
  /** Highest generation ever seen per agent; the fence reads this without a DB round trip. */
  const currentGeneration = new Map<string, number>();

  function key(agentId: string, generation: number): string {
    return `${agentId}:${generation}`;
  }

  function load(observation: RecoveryObservation): RecoveryRecord {
    const existing = port.load(observation.agentId, observation.generation);
    const at = observation.at || now();
    const record = existing ?? freshRecord(observation, at);
    // A conversation replacement keeps the agent and worktree but is a new binding.
    record.session_id = observation.sessionId;
    record.conversation_id = observation.conversationId;
    record.turn_id = observation.turnId;
    record.updated_at = at;
    currentGeneration.set(observation.agentId, Math.max(currentGeneration.get(observation.agentId) ?? 0, observation.generation));
    return record;
  }

  function persist(record: RecoveryRecord): void {
    record.updated_at = now();
    port.save(record);
    port.appendEvent(record.work_id, 'recovery', {
      agent_id: record.agent_id,
      generation: record.generation,
      phase: record.phase,
      episodes: record.episodes,
      attempts: record.attempts,
      next_attempt_at: record.next_attempt_at
    });
  }

  function arm(record: RecoveryRecord, run: (record: RecoveryRecord) => void): void {
    const id = key(record.agent_id, record.generation);
    pending.get(id)?.();
    pending.set(id, schedule(Math.max(0, record.next_attempt_at - now()), () => {
      pending.delete(id);
      const current = port.load(record.agent_id, record.generation);
      if (!current || current.phase === 'blocked' || current.phase === 'idle') return;
      run(current);
    }));
  }

  /** Whether this exact generation is still the agent's newest binding. */
  function isGenerationCurrent(agentId: string, generation: number): boolean {
    const highest = currentGeneration.get(agentId);
    if (highest !== undefined) return highest === generation;
    return true;
  }

  function progressMarkerKey(marker: ProgressMarker): string {
    if (marker.kind === 'operation') return `op:${marker.inputHash}:${marker.resultHash}`;
    if (marker.kind === 'tree') return `tree:${marker.treeHash}`;
    return `instr:${marker.textHash}`;
  }

  function block(record: RecoveryRecord, reason: 'RECOVERY_EXHAUSTED' | 'AUTH_REQUIRED' | 'PROVIDER_UNAVAILABLE', detail: string): RecoveryDecision {
    record.phase = 'blocked';
    persist(record);
    port.markBlocked({ workId: record.work_id, reason, detail });
    return { kind: 'blocked', reason, detail };
  }

  function waitUntil(record: RecoveryRecord, deadline: number): RecoveryDecision {
    // `observing` (never `idle`) is what keeps the armed timer meaningful: the timer's own
    // guard skips a record that has no episode in flight.
    record.phase = 'observing';
    record.next_attempt_at = deadline;
    persist(record);
    arm(record, row => void act(row, 'deadline'));
    return { kind: 'wait', until: deadline };
  }

  /**
   * The policy, in order.
   *
   * `trigger` is what caused this evaluation:
   * - `failure`: an explicit current-turn thinking failure or transport failure.
   * - `silence`: a proven silence observation for the live turn.
   * - `deadline`: the timer armed by the previous decision elapsed.
   *
   * One episode is reload → observe 60s → one same-conversation continuation → observe one
   * model-aware window → transfer. A transfer that produces no durable progress counts as an
   * episode; three of those block the work.
   */
  function act(record: RecoveryRecord, trigger: 'failure' | 'silence' | 'deadline'): RecoveryDecision {
    // A superseded generation never acts again: its replacement owns recovery now. This is the
    // same fence the mutation gate applies, kept here so a late browser observation cannot
    // reload or continue a conversation that has already been replaced.
    if (!isGenerationCurrent(record.agent_id, record.generation)) {
      record.phase = 'idle';
      persist(record);
      return { kind: 'none' };
    }
    const observation: RecoveryObservation = {
      workId: record.work_id,
      agentId: record.agent_id,
      sessionId: record.session_id,
      conversationId: record.conversation_id,
      turnId: record.turn_id,
      generation: record.generation,
      at: now()
    };
    // Step 2: a living command is never evidence of a dead turn, whatever the page shows.
    if (port.hasActiveCommands(observation)) {
      record.phase = 'observing';
      return waitUntil(record, now() + SILENCE_NORMAL_MS);
    }
    const window = silenceWindowMs(record.pro, record.thinking_failed);
    // A silence observation must age before it may act. An explicit failure and an elapsed
    // deadline have already earned their moment.
    if (trigger === 'silence') {
      if (record.attempts > 0) return waitUntil(record, record.next_attempt_at);
      const deadline = record.observed_at + window;
      if (now() < deadline) return waitUntil(record, deadline);
    }
    // Stage 0: one reload per episode.
    if (record.attempts === 0) {
      if (record.episodes >= MAX_EPISODES) {
        return block(record, 'RECOVERY_EXHAUSTED',
          `${MAX_EPISODES} recovery episodes produced no durable progress. Last recorded progress: ${record.last_progress ?? 'none'}.`);
      }
      record.attempts = 1;
      record.phase = 'reloading';
      record.next_attempt_at = now() + POST_RELOAD_OBSERVE_MS;
      persist(record);
      void actions.reload({
        sessionId: record.session_id,
        conversationId: record.conversation_id,
        workId: record.work_id,
        agentId: record.agent_id,
        generation: record.generation,
        reason: trigger === 'failure' ? 'thinking_failed' : 'silence'
      }).then(ok => {
        if (ok) return;
        // The reload could not be handed to the browser. Do not spend the observation window on
        // an action that never happened; retry at the silence window instead.
        const current = port.load(record.agent_id, record.generation);
        if (current && current.phase === 'reloading') {
          current.phase = 'observing';
          persist(current);
          arm(current, row => void act(row, 'deadline'));
        }
      }).catch(() => undefined);
      arm(record, row => void act(row, 'deadline'));
      return { kind: 'reload' };
    }
    // Stage 1: the observation window elapsed without progress — one continuation, same chat.
    if (record.attempts === 1) {
      const checkpoint = port.readCheckpoint(record.work_id);
      const promptId = `${record.work_id}:${record.agent_id}:${record.generation}:continue`;
      const text = continuationText(checkpoint ?? {
        summary: 'No durable checkpoint was recorded for this work.',
        remaining: [],
        verification: [],
        revision: 0,
        hostGenerated: true
      });
      // Persist the prompt id before delivery so a crash cannot duplicate the send.
      record.prompt_id = promptId;
      record.attempts = 2;
      record.phase = 'continuing';
      record.next_attempt_at = now() + window;
      persist(record);
      void actions.continueConversation({
        sessionId: record.session_id,
        conversationId: record.conversation_id,
        promptId,
        text,
        workId: record.work_id,
        agentId: record.agent_id,
        generation: record.generation
      }).catch(() => undefined);
      arm(record, row => void act(row, 'deadline'));
      return { kind: 'continue', promptId, text };
    }
    // Stage 2: the continuation also produced nothing — transfer to a fresh conversation
    // through the existing one-claimant continuation transaction.
    const checkpoint = port.readCheckpoint(record.work_id);
    record.phase = 'transferring';
    persist(record);
    void actions.transfer({
      workId: record.work_id,
      agentId: record.agent_id,
      generation: record.generation,
      sessionId: record.session_id,
      conversationId: record.conversation_id,
      checkpoint: checkpoint ?? {
        summary: 'The previous conversation produced no final answer and left no checkpoint.',
        remaining: [],
        verification: [],
        revision: 0,
        hostGenerated: true
      }
    }).then(ok => {
      if (!ok) return;
      // Fence the old generation before the new one is allowed to mutate anything.
      port.fenceGeneration({ workId: record.work_id, agentId: record.agent_id, generation: record.generation });
      const next = port.advanceGeneration({ workId: record.work_id, agentId: record.agent_id });
      currentGeneration.set(record.agent_id, next);
      const fresh = freshRecord({
        workId: record.work_id,
        agentId: record.agent_id,
        sessionId: record.session_id,
        conversationId: record.conversation_id,
        turnId: record.turn_id,
        generation: next,
        at: now()
      }, now());
      // A transfer is not forward progress: the episode count carries over, and the new
      // generation starts a fresh cycle.
      fresh.episodes = record.episodes + 1;
      fresh.attempts = 0;
      fresh.thinking_failed = record.thinking_failed;
      fresh.pro = record.pro;
      fresh.last_progress = record.last_progress;
      fresh.phase = 'observing';
      fresh.next_attempt_at = now() + silenceWindowMs(record.pro, record.thinking_failed);
      port.save(fresh);
      actions.onGenerationAdvanced({ workId: record.work_id, agentId: record.agent_id, generation: next });
      arm(fresh, row => void act(row, 'deadline'));
    }).catch(() => undefined);
    return { kind: 'transfer' };
  }

  function observeProgress(observation: ProgressObservation): boolean {
    // The marker is durable from the first observation, so a later repeat of the same marker
    // is recognisable as a repeat rather than being mistaken for new progress.
    const record = load(observation);
    const marker = progressMarkerKey(observation.marker);
    // Only a marker never seen before is progress. A reworded checkpoint, a repeated search or
    // a heartbeat reuses its marker and must not reset the episode count.
    if (record.last_progress === marker) return false;
    record.last_progress = marker;
    record.episodes = 0;
    record.attempts = 0;
    record.thinking_failed = false;
    record.phase = 'idle';
    record.next_attempt_at = observation.at || now();
    persist(record);
    pending.get(key(observation.agentId, observation.generation))?.();
    pending.delete(key(observation.agentId, observation.generation));
    return true;
  }

  return {
    noteTurnFailure(observation) {
      const record = load(observation);
      if (record.phase === 'blocked') {
        return { kind: 'blocked', reason: 'RECOVERY_EXHAUSTED', detail: 'recovery is already exhausted for this generation' };
      }
      if (observation.authWall) {
        return block(record, observation.authWall,
          observation.detail ?? 'ChatGPT requires attention in the browser before work can continue.');
      }
      record.thinking_failed = observation.kind === 'thinking_failed';
      record.observed_at = observation.at || now();
      // An explicit current-turn failure earns its reconciliation immediately. A transport
      // failure honors the provider's retry time when it gave one, otherwise the fixed backoff.
      if (observation.kind === 'transport_failure') {
        const backoff = observation.retryAfterMs ?? RETRY_BACKOFF_MS[Math.min(record.attempts, RETRY_BACKOFF_MS.length - 1)]!;
        record.next_attempt_at = (observation.at || now()) + backoff;
        persist(record);
        return { kind: 'wait', until: record.next_attempt_at };
      }
      persist(record);
      return act(record, 'failure');
    },

    noteSilence(observation) {
      const record = load(observation);
      if (record.phase === 'blocked') {
        return { kind: 'blocked', reason: 'RECOVERY_EXHAUSTED', detail: 'recovery is already exhausted for this generation' };
      }
      record.pro = observation.pro;
      record.observed_at = observation.at || now();
      persist(record);
      return act(record, 'silence');
    },

    noteProgress(observation) {
      observeProgress(observation);
    },

    noteUserInstruction(input) {
      const record = port.load(input.agentId, input.generation);
      if (!record) return;
      const marker = progressMarkerKey({ kind: 'instruction', textHash: input.textHash });
      if (record.last_progress === marker) return;
      record.last_progress = marker;
      record.episodes = 0;
      record.attempts = 0;
      record.thinking_failed = false;
      record.phase = 'idle';
      record.next_attempt_at = now();
      persist(record);
      pending.get(key(input.agentId, input.generation))?.();
      pending.delete(key(input.agentId, input.generation));
    },

    reconcileOnStartup() {
      const decisions: RecoveryDecision[] = [];
      for (const record of port.list()) {
        if (record.phase === 'blocked') continue;
        currentGeneration.set(record.agent_id, Math.max(currentGeneration.get(record.agent_id) ?? 0, record.generation));
        // Re-arm from the persisted deadline: one that elapsed while the host was down fires
        // immediately, and one that has not fires when it is due. Either way it fires once.
        arm(record, (row) => void act(row, 'deadline'));
        decisions.push({ kind: 'wait', until: record.next_attempt_at });
      }
      return decisions;
    },

    isCurrent(agentId, generation) {
      const highest = currentGeneration.get(agentId);
      if (highest !== undefined) return highest === generation;
      const stored = port.list().filter((row) => row.agent_id === agentId);
      if (!stored.length) return true;
      const max = Math.max(...stored.map((row) => row.generation));
      currentGeneration.set(agentId, max);
      return max === generation;
    },

    record(agentId, generation) {
      return port.load(agentId, generation);
    },

    records() {
      return port.list();
    }
  };
}
