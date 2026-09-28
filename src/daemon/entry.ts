/**
 * The daemon process itself: a plain Node program that serves the MCP tools with no desktop app
 * anywhere in the picture.
 *
 * This file is the *only* place the standalone runtime is entered, and it is deliberately tiny.
 * Everything expensive — the MCP listener, the work ledger, the control socket — belongs to
 * `runtime.ts`, and everything a *command* needs to know about a running daemon belongs to
 * `lifecycle.ts`. What is left here is the process contract:
 *
 *   1. **Plain Node.** The daemon never loads Electron. It runs on the interpreter `bin/wgpt`
 *      resolved for it (`WGPT_NODE_EXECUTABLE`), which is what makes "coding tools work on a
 *      machine with no desktop app installed" true rather than aspirational.
 *   2. **One writer per data directory.** The directory is claimed before the runtime starts, so
 *      a second daemon — or a daemon pointed at a running desktop app's directory — is refused
 *      next to the state it would have corrupted, not merely by the client that asked.
 *   3. **It publishes, then waits.** Readiness is the runtime's own endpoint URLs, printed once
 *      on stdout, which is what a foreground `wgpt daemon serve` is watching for. Shutdown is
 *      SIGINT/SIGTERM (or `daemon.stop` over the control socket, which the runtime owns).
 *
 * The process stays alive because the runtime's listener is holding the event loop open; nothing
 * here spins, polls or keeps a timer of its own.
 */

import { resolveDataDir, useDataDir } from '../main/identity.js';
import { ControlSocketError } from '../main/work/control-socket.js';
import { WORK_ERROR_CODES } from '../shared/work.js';
import { DAEMON_ERROR_CODES, claimDataDir } from './lifecycle.js';
import { DaemonRuntimeError, startDaemonRuntime } from './runtime.js';

/** A refusal that is the *answer* to the command, not a crash: reported and exited, never thrown. */
class DaemonStartupError extends Error {
  constructor(
    message: string,
    readonly code: string
  ) {
    super(message);
    this.name = 'DaemonStartupError';
  }
}

/** The absolute data directory the daemon was told to own. There is no default: it is required. */
function dataDirArgument(argv: readonly string[]): string {
  if (!argv.some((token) => token === '--data-dir' || token.startsWith('--data-dir='))) {
    throw new DaemonStartupError('--data-dir <absolute-path> is required', 'INVALID_INPUT');
  }
  try {
    // The same resolver the CLI and the desktop app use, so all three can never disagree about
    // what "the data directory" means. A relative value is refused there rather than resolved
    // against the working directory, which for a detached process is not even the same place.
    return resolveDataDir(argv);
  } catch (error) {
    throw new DaemonStartupError(error instanceof Error ? error.message : String(error), 'INVALID_INPUT');
  }
}

async function main(): Promise<void> {
  const argv = process.argv.slice(2);
  const json = argv.includes('--json');
  // The optional browser transport is a launch argument, not a stored setting: it decides whether
  // this process materialises the companion extension and opens a bridge, which a later settings
  // change could not undo. Only the exact word is accepted, so a typo is a refusal rather than a
  // silently coding-only daemon.
  const browser = argv.includes('--browser');
  const dataDir = useDataDir(dataDirArgument(argv));
  // Claiming here rather than only in the command that spawned us is what closes the race: a
  // daemon started by hand, by a script, or by an older `wgpt` still refuses to open a second
  // writer over a data directory that is already owned.
  const existing = await claimDataDir(dataDir);
  if (existing) {
    throw new DaemonStartupError(
      `a daemon is already running for ${dataDir} (pid ${existing.pid}, instance ${existing.instance_id})`,
      DAEMON_ERROR_CODES.dataDirConflict
    );
  }
  // The check above is the friendly one: it can only see a daemon that has already published its
  // descriptor. The atomic guarantee is the runtime's own exclusive claim on the data directory,
  // taken before it opens the ledger — which is what resolves two daemons launched in the same
  // instant, where neither can see the other through `runtime.json` yet.
  const runtime = await startDaemonRuntime({ dataDir, browserDelivery: browser });
  const ready = {
    daemon: 'ready',
    pid: runtime.pid,
    instance_id: runtime.instanceId,
    data_dir: runtime.dataDir,
    endpoint: runtime.endpoint,
    urls: runtime.urls
  };
  process.stdout.write(
    json ? `${JSON.stringify(ready)}\n` : `daemon ready pid=${runtime.pid} endpoint=${runtime.endpoint}\n`
  );

  let stopping: Promise<void> | null = null;
  const shutdown = (): void => {
    const pending =
      stopping ??
      runtime.stop().catch((error: unknown) => {
        process.stderr.write(`wgpt daemon: stop failed: ${error instanceof Error ? error.message : String(error)}\n`);
      });
    stopping = pending;
    void pending.then(() => process.exit(0));
  };
  process.on('SIGINT', shutdown);
  process.on('SIGTERM', shutdown);
}

void main().catch((error: unknown) => {
  // Three classes of failure, reported so a script can branch on them: a malformed command, a
  // refusal that is an *answer*, and a genuine crash. The first two are exit 2/4 like every other
  // refusal in this CLI; only the last is 1.
  //
  // The runtime's own refusal matters here specifically: it takes the *atomic* claim on the data
  // directory, so it is the one that catches a second daemon the descriptor-based pre-check could
  // not see (a competitor that has not published its socket yet). Reporting that as a crash would
  // make the one case the lock exists for indistinguishable from a defect.
  const code =
    error instanceof DaemonStartupError || error instanceof DaemonRuntimeError
      ? error.code
      : error instanceof ControlSocketError
        ? error.code
        : 'INTERNAL_ERROR';
  const message = error instanceof Error ? error.message : String(error);
  process.stderr.write(`wgpt daemon: ${code}: ${message}\n`);
  if (code === WORK_ERROR_CODES.invalidInput) process.exitCode = 2;
  else if (error instanceof DaemonStartupError || error instanceof DaemonRuntimeError || error instanceof ControlSocketError) {
    process.exitCode = 4;
  } else process.exitCode = 1;
});
