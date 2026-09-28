/**
 * Host-wide native-CUA ownership, snapshot provenance and the worker-identity seam.
 *
 * A Git worktree isolates a checkout; it does not isolate a desktop. Exactly one managed work
 * at a time may drive the native desktop through the cua-driver gateway, and the lease below is
 * what enforces that. It is deliberately *not* a lock on the driver itself: the user and any
 * other CUA client keep their own access. The app owns and stops only its embedded child.
 *
 * Two rules in this module exist because the driver's own contract depends on them:
 *
 *  - Snapshot provenance. The driver binds element tokens and screenshot pixels to one
 *    observation, and a new snapshot invalidates the previous ones. A work must therefore
 *    observe before it acts, and observe again after each action, before the next input. This
 *    module refuses a snapshot-bound action that cannot name the observation it came from
 *    instead of letting a stale token or frame be translated into a different state.
 *  - Transport generations. A reconnect mints new transport state, so every element token and
 *    screenshot frame from before it is unusable. Nothing is replayed across that boundary.
 *
 * Identity is not re-derived here. The runtime's own `assertManagedCaller` is the only authority
 * on which work, agent and generation a call belongs to; this module consumes its answer. The
 * resolver is injected rather than imported because the runtime already depends on this module
 * for the lease and the classifier, and a cycle between them would be worse than one seam.
 */

import type { ManagedWorkerIdentity } from './runtime.js';
import type { CallContext } from '../mcp/call-context.js';
import type { ToolResult } from '../mcp/kernel.js';
import { CUA_MUTATING_TOOLS, CUA_OBSERVATION_TOOLS, CUA_SNAPSHOT_BOUND_TOOLS } from '../cua/catalog.js';

export type { ManagedWorkerIdentity };

export type ManagedCallerResolver = (context: CallContext | null) => ManagedWorkerIdentity;

/**
 * Raised when no managed work can be proven for this call.
 *
 * Distinct from the runtime's own refusals on purpose: it means no managed work exists at all
 * (the ledger is not restored), which is not the same fact as "this caller is stale" and must
 * never be reported as GUI contention.
 */
export class ManagedCallerUnavailable extends Error {
  readonly code: string;
  constructor(code: string, message: string) {
    super(`${code}: ${message}`);
    this.name = 'ManagedCallerUnavailable';
    this.code = code;
  }
}

let resolveManagedCaller: ManagedCallerResolver | null = null;

/** Installed by the runtime with its own `assertManagedCaller`; cleared on shutdown. */
export function setManagedCallerResolver(resolver: ManagedCallerResolver | null): void {
  resolveManagedCaller = resolver;
}

/** The runtime's typed refusal for this call, or a refusal when no ledger is restored. */
export function managedCallerFor(context: CallContext | null): ManagedWorkerIdentity {
  if (!resolveManagedCaller)
    throw new ManagedCallerUnavailable(
      'WORK_SERVICE_UNAVAILABLE',
      'the host has not restored its durable work ledger, so native desktop control cannot be attributed to a work. No local tool ran.'
    );
  return resolveManagedCaller(context);
}

// ------------------------------------------------------------------------- GUI ownership

export class CuaBusyError extends Error {
  readonly code = 'CUA_BUSY';
  readonly holderWorkId: string;
  constructor(holderWorkId: string) {
    super(
      `CUA_BUSY: work ${holderWorkId} currently holds the native desktop lease. ` +
        'Coding-only work can continue; retry desktop work after that work pauses, finishes or is cancelled.'
    );
    this.name = 'CuaBusyError';
    this.holderWorkId = holderWorkId;
  }
}

interface LeaseState {
  workId: string;
  inFlight: number;
  releasing: boolean;
  drainers: Array<() => void>;
}

let current: LeaseState | null = null;
const releasedListeners = new Set<(workId: string) => void>();

/** For the scheduler: a work that was refused CUA_BUSY can retry once this fires. */
export function onGuiLeaseReleased(listener: (workId: string) => void): () => void {
  releasedListeners.add(listener);
  return () => releasedListeners.delete(listener);
}

export function guiLeaseHolder(): string | null {
  return current?.workId ?? null;
}

/**
 * Lazily takes the host-wide lease for one work.
 *
 * Held across observation → action → verification, and released only on pause, cancel,
 * completion or host shutdown. A worker page reload does not release it: the page is a view of
 * the work, not the work.
 */
export function acquireGuiLease(workId: string): void {
  if (current && current.workId !== workId) throw new CuaBusyError(current.workId);
  if (!current) current = { workId, inFlight: 0, releasing: false, drainers: [] };
}

/** Counts one in-flight desktop action so a release can wait for it to settle. */
export function holdGuiAction(workId: string): () => void {
  const state = current;
  if (!state || state.workId !== workId || state.releasing)
    throw state ? new CuaBusyError(state.workId) : new ManagedCallerUnavailable('WORK_NOT_RUNNING', 'no desktop lease is held.');
  state.inFlight++;
  let released = false;
  return () => {
    if (released) return;
    released = true;
    state.inFlight--;
    if (state.inFlight === 0) for (const done of state.drainers.splice(0)) done();
  };
}

/**
 * Releases after in-flight actions settle. Idempotent, and never frees another work's lease.
 *
 * New actions are refused from the moment release begins, but the lease is not handed to a
 * waiting work until the last in-flight call has actually returned — a half-delivered click
 * must not overlap the next work's first observation.
 */
export async function releaseGuiLease(workId: string): Promise<void> {
  const state = current;
  if (!state || state.workId !== workId || state.releasing) return;
  state.releasing = true;
  if (state.inFlight > 0) await new Promise<void>(resolve => state.drainers.push(resolve));
  if (current === state) current = null;
  dropProvenanceForWork(workId);
  for (const listener of releasedListeners) listener(workId);
}

// ------------------------------------------------------------------- snapshot provenance

export interface CuaObservation {
  installationId: string;
  /** Transport generation the observation was taken on. */
  generation: number;
  /** Driver snapshot id, when the observation produced one. */
  snapshotId: string | null;
  pid: number | null;
  windowId: number | null;
  desktop: boolean;
  at: number;
  /** Set once a mutating action consumed this observation. */
  consumed: boolean;
}

const observations = new Map<string, CuaObservation>();

const observationKey = (workId: string, installationId: string): string => `${workId}\u0000${installationId}`;

function numeric(value: unknown): number | null {
  return typeof value === 'number' && Number.isFinite(value) ? value : null;
}

function stringOrNull(value: unknown): string | null {
  return typeof value === 'string' && value.length > 0 ? value : null;
}

function structured(result: ToolResult): Record<string, unknown> | null {
  const value = result.structuredContent;
  return value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : null;
}

export function isCuaObservationTool(name: string): boolean {
  return CUA_OBSERVATION_TOOLS.includes(name);
}

export function isCuaSnapshotBoundTool(name: string): boolean {
  return CUA_SNAPSHOT_BOUND_TOOLS.includes(name);
}

export function isCuaMutatingTool(name: string): boolean {
  return CUA_MUTATING_TOOLS.includes(name);
}

/**
 * Records what an observation proved, so a later action can name it.
 *
 * The driver returns the snapshot id, pid and window id in the structured result; an
 * observation that carries no snapshot id (a text-only accessibility dump) is still recorded,
 * but it cannot authorize an element-token action — which is exactly the driver's own rule.
 */
export function noteCuaObservation(
  workId: string,
  installationId: string,
  generation: number,
  tool: string,
  result: ToolResult
): void {
  const data = structured(result);
  const desktop = tool === 'get_desktop_state' || (data !== null && 'display' in data && !('window_id' in data));
  observations.set(observationKey(workId, installationId), {
    installationId,
    generation,
    snapshotId: data ? stringOrNull(data.snapshot_id) : null,
    pid: data ? numeric(data.pid) : null,
    windowId: data ? numeric(data.window_id) : null,
    desktop,
    at: Date.now(),
    consumed: false
  });
}

/**
 * Records that a verification read the target back — without changing what the work can address.
 *
 * A verification confirms current state; it neither mints element targets nor invalidates the
 * ones the last snapshot produced. The driver replaces its element index map on a *snapshot*, so
 * a legitimate observe → act → verify → act sequence must keep working: overwriting the
 * observation here would refuse the second action's token for a reason the driver itself does not
 * have. An observation that was already consumed stays consumed, because those tokens were spent.
 */
export function noteCuaVerification(
  workId: string,
  installationId: string,
  generation: number,
  args: Record<string, unknown>
): void {
  const key = observationKey(workId, installationId);
  const existing = observations.get(key);
  if (!existing) {
    // No snapshot to preserve. A verification is not an observation, so this records the fact
    // without granting any element token authority it did not already have.
    observations.set(key, {
      installationId,
      generation,
      snapshotId: null,
      pid: numeric(args.pid),
      windowId: numeric(args.window_id),
      desktop: false,
      at: Date.now(),
      consumed: false
    });
    return;
  }
  existing.at = Date.now();
  existing.pid = numeric(args.pid) ?? existing.pid;
  existing.windowId = numeric(args.window_id) ?? existing.windowId;
}

function targetOf(args: Record<string, unknown>): { pid: number | null; windowId: number | null; desktop: boolean; snapshotId: string | null; tokenSnapshot: string | null } {
  const target = args.target;
  const nested = target && typeof target === 'object' && !Array.isArray(target) ? target as Record<string, unknown> : null;
  const desktop = args.scope === 'desktop' || nested?.kind === 'desktop';
  const token = stringOrNull(args.element_token);
  return {
    pid: numeric(args.pid) ?? (nested ? numeric(nested.pid) : null),
    windowId: numeric(args.window_id) ?? (nested ? numeric(nested.window_id) : null),
    desktop,
    snapshotId: stringOrNull(args.snapshot_id),
    // Element tokens are snapshot-scoped: `s0000002a:14` addresses one snapshot's element map.
    tokenSnapshot: token ? token.split(':', 1)[0] ?? null : null
  };
}

const snapshotRequired =
  'CUA_SNAPSHOT_REQUIRED: this action addresses a specific observation, and this work has not taken a fresh one. ' +
  'Call get_window_state (or get_desktop_state for screen-absolute work) first, then address the element token, ' +
  'snapshot id or pixel from that same result. No action was dispatched.';

const snapshotStale =
  'CUA_SNAPSHOT_STALE: the observation this work was addressing is no longer current — either an action already ' +
  'consumed it or the driver transport reconnected and its tokens are unusable. Take a fresh observation and ' +
  'address that one. No action was dispatched, and nothing was retried.';

/**
 * Returns a refusal message when a snapshot-bound action cannot name a current observation.
 *
 * Never translates a target between states: an element token from a superseded snapshot, a
 * pixel frame from a different window, or any target after a reconnect is refused rather than
 * resolved against the newest state.
 */
export function assertCuaSnapshot(
  workId: string,
  installationId: string,
  generation: number,
  args: Record<string, unknown>
): string | null {
  const observation = observations.get(observationKey(workId, installationId));
  if (!observation) return snapshotRequired;
  if (observation.generation !== generation || observation.consumed) return snapshotStale;
  const target = targetOf(args);
  if (target.desktop !== observation.desktop)
    return observation.desktop
      ? 'CUA_SNAPSHOT_MISMATCH: the last observation was of the whole desktop, but this action names a window. Take a window observation for the window you intend to drive. No action was dispatched.'
      : 'CUA_SNAPSHOT_MISMATCH: the last observation was of one window, but this action targets the whole desktop. Take a desktop observation first. No action was dispatched.';
  if (target.snapshotId && observation.snapshotId && target.snapshotId !== observation.snapshotId) return snapshotStale;
  if (target.tokenSnapshot && target.tokenSnapshot !== observation.snapshotId)
    return 'CUA_SNAPSHOT_MISMATCH: this element token belongs to a different snapshot than the one this work observed. Take a fresh observation and use its token. No action was dispatched.';
  if (target.pid !== null && observation.pid !== null && target.pid !== observation.pid)
    return 'CUA_SNAPSHOT_MISMATCH: this action names a different process than the observed one. Observe that window, then act. No action was dispatched.';
  if (target.windowId !== null && observation.windowId !== null && target.windowId !== observation.windowId)
    return 'CUA_SNAPSHOT_MISMATCH: this action names a different window than the observed one. Observe that window, then act. No action was dispatched.';
  return null;
}

/** A mutating action consumes the observation, so the next input needs a fresh one. */
export function consumeCuaObservation(workId: string, installationId: string): void {
  const observation = observations.get(observationKey(workId, installationId));
  if (observation) observation.consumed = true;
}

/** Drops provenance taken on a superseded transport generation. */
export function noteCuaTransportGeneration(installationId: string, generation: number): void {
  for (const [key, observation] of observations)
    if (observation.installationId === installationId && observation.generation !== generation) observations.delete(key);
}

export function dropProvenanceForWork(workId: string): void {
  const prefix = `${workId}\u0000`;
  for (const key of [...observations.keys()]) if (key.startsWith(prefix)) observations.delete(key);
}

/** Test seam: clears lease and provenance state without touching the driver. */
export function resetCuaStateForTests(): void {
  current = null;
  observations.clear();
  releasedListeners.clear();
  resolveManagedCaller = null;
}
