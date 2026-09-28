/**
 * Which work one call is about, and the one place that decides it.
 *
 * A managed call must name its target. Two ways are accepted, and nothing else is:
 *
 *  1. **Explicit coordinates.** A `work_id`, optionally with an `agent_id`, supplied by the
 *     caller. This is how a remote or headless caller — a phone chat, a scheduled run, a
 *     deliberate `work_checkpoint` after the page was closed — selects the work it is acting on.
 *     The ids are resolved against the durable ledger and the answer is either a live identity or
 *     a typed refusal; nothing is inferred from what happens to be running.
 *  2. **The proven conversation.** A call that belongs to a managed work's own agent conversation
 *     is resolved through that binding, exactly as before. This is the ordinary in-chat path.
 *
 * The conversation is therefore an *optional* way to name a target, never a requirement for one.
 * No proof of a canonical user question, no attached browser page and no session projection is
 * consulted here: an explicitly addressed work call is authority because it names the work and the
 * ledger admits it, not because some other component can place the caller. Which is also why this
 * module no longer holds anything: there is no deferred admission list, because a call is either
 * resolvable now or it is refused now.
 *
 * The ledger is a narrow structural port rather than an import, so this module can be reasoned
 * about — and tested — without a database, and so `work/runtime.ts` can depend on it without a
 * cycle.
 */

/** The live identity a resolved target yields. Owned here; the runtime re-exports it. */
export interface ManagedWorkerIdentity {
  workId: string;
  agentId: string;
  generation: number;
  role: 'prime' | 'worker';
  /** Stable local session for this agent, or null before the chat is bound. */
  sessionId: string | null;
  /** This agent's assigned private worktree, absolute. */
  worktreePath: string;
  /** The work's integration worktree and branch, for status and default search scope. */
  integrationPath: string;
  integrationBranch: string;
}

/**
 * The exact ledger rows this resolution reads.
 *
 * Deliberately four readers and no writes: naming a target is a question about the ledger, and a
 * question that could mutate would be a second authority beside the service.
 */
export interface WorkTargetStore {
  getWork(workId: string): {
    work_id: string;
    status: string;
    desired_state: string | null;
    prime_agent_id: string | null;
    integration_worktree: string | null;
    integration_branch: string | null;
  } | null;
  getAgent(agentId: string): WorkAgentTarget | null;
  getAgentByConversation(conversationId: string): WorkAgentTarget | null;
  getPrimeAgent(workId: string): WorkAgentTarget | null;
  getWorktreeAssignment(workId: string, agentId: string): { path: string } | null;
}

/** The agent projection resolution needs; the ledger owns the real row. */
export interface WorkAgentTarget {
  agent_id: string;
  work_id: string;
  role: 'prime' | 'worker';
  state: string;
  generation: number;
  session_id: string | null;
  worktree_path: string | null;
}

/** How a caller named the work it is acting on. */
export type WorkTarget =
  | { conversationId: string }
  | { workId: string; agentId?: string | null };

export type WorkTargetResolution =
  | { kind: 'resolved'; identity: ManagedWorkerIdentity }
  | { kind: 'refused'; code: string; message: string };

/** Refusal codes this module owns; every one is model-facing and actionable. */
export const WORK_TARGET_CODES = {
  /** The conversation is not a managed work's own agent conversation. */
  conversationUnbound: 'WORKER_CONNECTION_REQUIRED',
  /** The ledger has no such work, agent, or assignment. */
  stateUnavailable: 'STATE_UNAVAILABLE',
  /** The work or agent cannot mutate the worktree any more. */
  notRunning: 'WORK_NOT_RUNNING'
} as const;

/**
 * Resolves the work one call is about, or refuses by name.
 *
 * Both entry shapes end in the same state checks, because they answer the same question: a work
 * that is paused, cancelled, completed, blocked or desired-away, and an agent that has already
 * finished, is not a target for a mutation however it was named.
 */
export function resolveWorkTarget(store: WorkTargetStore, target: WorkTarget): WorkTargetResolution {
  const agent = 'conversationId' in target
    ? conversationAgent(store, target.conversationId)
    : agentOf(store, target);
  if (agent.kind === 'refused') return agent;
  const work = store.getWork(agent.value.work_id);
  if (!work) {
    return refused(
      WORK_TARGET_CODES.stateUnavailable,
      `the durable ledger has no work row for agent ${agent.value.agent_id}. No local tool ran.`
    );
  }
  const live = agent.value;
  if (live.state === 'finished' || live.state === 'failed') {
    return refused(
      WORK_TARGET_CODES.notRunning,
      `this agent is ${live.state}; it cannot mutate the worktree any more. No local tool ran.`
    );
  }
  if (work.status === 'paused' || work.status === 'cancelled' || work.desired_state !== null) {
    return refused(
      WORK_TARGET_CODES.notRunning,
      `this work is ${work.desired_state ?? work.status}. No local tool ran; wait for it to resume or ask the user to resume it.`
    );
  }
  if (work.status === 'completed' || work.status === 'blocked') {
    return refused(
      WORK_TARGET_CODES.notRunning,
      `this work is ${work.status}. No local tool ran; resolve the blocker or start a new work.`
    );
  }
  const assignment = store.getWorktreeAssignment(work.work_id, live.agent_id);
  const worktreePath = live.worktree_path ?? assignment?.path ?? work.integration_worktree;
  if (!worktreePath) {
    return refused(
      WORK_TARGET_CODES.stateUnavailable,
      `no worktree is assigned to agent ${live.agent_id}. No local tool ran.`
    );
  }
  return {
    kind: 'resolved',
    identity: {
      workId: work.work_id,
      agentId: live.agent_id,
      generation: live.generation,
      role: live.role,
      sessionId: live.session_id,
      worktreePath,
      integrationPath: work.integration_worktree ?? worktreePath,
      integrationBranch: work.integration_branch ?? `wgpt/${work.work_id}/main`
    }
  };
}

/**
 * The agent one proven conversation belongs to, or the ordinary refusal.
 *
 * This is the in-chat path, and its refusal is deliberately the same one it has always been: a
 * conversation that is not a managed work's own agent conversation is not a target, and it is told
 * to use the direct work tool rather than being given somebody else's identity.
 */
function conversationAgent(
  store: WorkTargetStore,
  conversationId: string
): { kind: 'resolved'; value: WorkAgentTarget } | { kind: 'refused'; code: string; message: string } {
  const agent = store.getAgentByConversation(conversationId);
  if (!agent) {
    return refused(
      WORK_TARGET_CODES.conversationUnbound,
      'this conversation does not belong to a managed work. Use the direct work tool with action="start" or "list". No local tool ran.'
    );
  }
  return { kind: 'resolved', value: agent };
}

/**
 * The agent one explicit `work_id` (with optional `agent_id`) names.
 *
 * An explicit agent is checked against the work it was given: resolving an agent id globally would
 * let a call name one work and act on another, which is exactly the inference this module exists to
 * prevent. A work named without an agent resolves to its prime — the one agent that is always
 * supposed to exist for a live work.
 */
function agentOf(
  store: WorkTargetStore,
  target: { workId: string; agentId?: string | null }
): { kind: 'resolved'; value: WorkAgentTarget } | { kind: 'refused'; code: string; message: string } {
  const work = store.getWork(target.workId);
  if (!work) {
    return refused(WORK_TARGET_CODES.stateUnavailable, `no work with id ${target.workId} exists in the durable ledger. No local tool ran.`);
  }
  if (target.agentId) {
    const agent = store.getAgent(target.agentId);
    if (!agent || agent.work_id !== work.work_id) {
      return refused(
        WORK_TARGET_CODES.stateUnavailable,
        `agent ${target.agentId} is not an agent of work ${work.work_id}. No local tool ran.`
      );
    }
    return { kind: 'resolved', value: agent };
  }
  const prime = store.getPrimeAgent(work.work_id);
  if (!prime) {
    return refused(WORK_TARGET_CODES.stateUnavailable, `work ${work.work_id} has no prime agent in the durable ledger. No local tool ran.`);
  }
  return { kind: 'resolved', value: prime };
}

function refused(code: string, message: string): { kind: 'refused'; code: string; message: string } {
  return { kind: 'refused', code, message };
}

/**
 * The explicit target one raw invocation carries, or null when it names none.
 *
 * Read from the *raw* arguments, before schema parsing, because the admission gate runs ahead of
 * every handler: the ids are exactly the fields the caller wrote, and a malformed or absent one
 * simply means "no explicit target" — the conversation path then decides, and the handler's own
 * schema is what refuses anything that does not parse.
 */
export function explicitWorkTarget(args: unknown): { workId: string; agentId: string | null } | null {
  if (!args || typeof args !== 'object') return null;
  const record = args as Record<string, unknown>;
  const workId = typeof record['work_id'] === 'string' && record['work_id'].length > 0 ? record['work_id'] : null;
  if (!workId) return null;
  const agentId = typeof record['agent_id'] === 'string' && record['agent_id'].length > 0 ? record['agent_id'] : null;
  return { workId, agentId };
}
