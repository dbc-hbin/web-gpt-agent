/**
 * Keeps this host from being suspended while it is doing something that must not be
 * interrupted.
 *
 * A Mac that is asleep runs no terminal commands, answers no MCP calls and recovers no
 * worker, so work that is "running" in this app's ledger would be quietly frozen until
 * somebody opened the lid. `powerSaveBlocker` with `prevent-app-suspension` is the one
 * supported way to say that, and it is deliberately the *narrow* one: it stops the system
 * from idling the app out, and it does not keep the display awake, does not stop the user
 * from closing the lid, and cannot prevent a shutdown. Nothing here claims otherwise.
 *
 * The blocker is reference-counted rather than toggled, because the reasons to hold it
 * arrive independently — a work becoming `running`, a second work recovering, a command
 * still draining after a pause — and any of them clearing must not release the hold that
 * the others still need. It is released only when the last holder lets go.
 *
 * The Electron dependency is injected rather than imported so the counting rule — the part
 * that can actually be wrong — is testable without booting Electron.
 */

export interface PowerSaveBlockerTarget {
  start(type: 'prevent-app-suspension'): number;
  stop(id: number): void;
  isStarted(id: number): boolean;
}

/** A no-op target for tests and for a host that has no power management available. */
export const NULL_POWER_TARGET: PowerSaveBlockerTarget = {
  start: () => 0,
  stop: () => undefined,
  isStarted: () => false
};

let target: PowerSaveBlockerTarget = NULL_POWER_TARGET;
/** Distinct holders, so releasing one does not release another's claim. */
const holders = new Set<string>();
/** The single live blocker id, or null when nothing is held. */
let blockerId: number | null = null;
let logWarn: (message: string) => void = () => undefined;

/**
 * Installs the real Electron `powerSaveBlocker` and the log sink.
 *
 * Called once from the main process during startup, before any work can be admitted. Until
 * then every call is a no-op, which is what makes the module safe to import from anywhere.
 */
export function initPowerManagement(
  next: PowerSaveBlockerTarget,
  warn: (message: string) => void = () => undefined
): void {
  target = next;
  logWarn = warn;
}

/**
 * Adds or removes one named holder and reconciles the OS blocker with the result.
 *
 * Idempotent per holder: acquiring twice is one hold, and releasing a holder that was never
 * acquired is nothing. That matters because these calls come from state transitions that can
 * legitimately repeat — a status push, a second reconciliation after a restart.
 */
export function setPowerHolder(name: string, held: boolean): void {
  if (held) holders.add(name);
  else holders.delete(name);
  reconcile();
}

function reconcile(): void {
  const wanted = holders.size > 0;
  if (wanted && blockerId === null) {
    try {
      blockerId = target.start('prevent-app-suspension');
    } catch (error) {
      // A host that refuses the blocker is still a working host. Recording the intent and
      // moving on is better than failing the work that asked for it.
      logWarn(`could not hold a power-save blocker: ${error instanceof Error ? error.message : String(error)}`);
      blockerId = null;
    }
    return;
  }
  if (!wanted && blockerId !== null) {
    try {
      target.stop(blockerId);
    } catch (error) {
      logWarn(`could not release the power-save blocker: ${error instanceof Error ? error.message : String(error)}`);
    }
    blockerId = null;
  }
}

/** True while at least one holder is keeping this host awake. */
export function powerHeld(): boolean {
  return holders.size > 0;
}

/** The holders currently keeping the host awake, for diagnostics. */
export function powerHolders(): string[] {
  return [...holders];
}

/** Test seam: drop every holder and the installed target. */
export function resetPowerForTests(): void {
  holders.clear();
  blockerId = null;
  target = NULL_POWER_TARGET;
  logWarn = () => undefined;
}
