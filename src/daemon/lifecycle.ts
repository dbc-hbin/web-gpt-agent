/**
 * Who owns a data directory, and how a local command reaches — or deliberately refuses to
 * reach — the standalone daemon that owns it.
 *
 * This is the CLI's half of the daemon contract, and it is deliberately *only* that half: it
 * never starts a work ledger, never opens durable state and never runs a tool. Everything it
 * knows about the daemon comes from the two facts the daemon publishes for exactly this
 * purpose — the `runtime.json` descriptor in the data directory (0600, so only the owner of
 * the directory can read it) and the authenticated control socket that descriptor names.
 *
 * Three rules are load-bearing, and each one exists because the obvious cheaper version is
 * wrong:
 *
 *   1. **A descriptor is a claim, not a fact.** `status` never reports a daemon from the file
 *      alone, and never from a PID. It completes the hello handshake (installation id, protocol
 *      version, and the daemon's control token when the descriptor carries one) and asks the
 *      socket for `daemon.status`; only an answer from a live, authenticated peer counts. A
 *      crashed daemon leaves a perfectly plausible descriptor behind, and a PID can be reused.
 *   2. **A second `start` is idempotent, and a desktop app is not a daemon.** If a live daemon
 *      already answers for this data directory, `start` returns *that* daemon's own report
 *      rather than launching a second process. If instead the desktop app owns the directory,
 *      the command refuses outright: two writers over one SQLite ledger is the exact outcome
 *      this check exists to prevent, and the desktop app's own `runtime.json` must not be
 *      touched, replaced or signalled.
 *   3. **`stop` stops exactly one instance, and never a PID.** It requires the descriptor to be
 *      a daemon descriptor, requires the answering daemon's `instance_id` to equal the
 *      descriptor's, and then asks *that* instance to stop over its authenticated socket. No
 *      signal is ever sent to a process id read from a file.
 *
 * The same claim step runs in the daemon process itself (`entry.ts`) immediately before the
 * runtime is started, so a refusal is reported next to the resource it protects rather than only
 * in the client that asked for it. The *authority* for "one writer per data directory" is the
 * runtime's own atomic exclusive claim, taken before it opens the ledger: a descriptor only
 * exists once a control socket is listening, so two daemons launched in the same instant would
 * both pass every check made from the file alone. What this module provides is the clear refusal
 * and the idempotent `start` — never a second ownership protocol beside the runtime's.
 */

import { spawn } from 'node:child_process';
import { existsSync } from 'node:fs';
import path from 'node:path';
import {
  ControlRejectedError,
  ControlUnavailableError,
  openControlClient,
  readRuntimeDescriptor,
  removeStaleRuntimeDescriptor,
  type ControlClient,
  type ControlMethod,
  type HostStatusReport,
  type RuntimeDescriptor
} from '../main/work/control-socket.js';
import { WORK_ERROR_CODES } from '../shared/work.js';
import {
  daemonConfigReportSchema,
  daemonSecretReportSchema,
  type DaemonConfigReport,
  type DaemonConfigRequest,
  type DaemonSecretReport,
  type DaemonSecretRequest
} from '../shared/daemon-config.js';

/** The model-facing surfaces the daemon's MCP listener publishes, one URL each. */
export type DaemonSurfaceId = 'core' | 'desktop' | 'plugins';

/** What the daemon's own `daemon.status` answers. The daemon is the only source of it. */
export interface DaemonStatusReport {
  instance_id: string;
  pid: number;
  data_dir: string;
  version: string;
  started_at: string;
  /** The URL to hand a client: the Core surface, including its secret path. */
  endpoint: string;
  urls: Record<DaemonSurfaceId, string>;
  kind: 'daemon';
  /**
   * What this daemon's transport is doing: whether a process is running, what it last reported,
   * and when it last proved a round trip.
   *
   * Absent means the peer did not say, which is not the same as "off" — a daemon launched before
   * this field existed answers without it. It is not a claim about reachability from anywhere in
   * particular: this host can only report what its own transport observed.
   */
  tunnel?: {
    state: 'off' | 'starting' | 'connected' | 'unavailable';
    detail: string;
    publicUrl: string | null;
    handshakeAt: number | null;
  };
  /**
   * Whether this daemon serves the browser transport, and where its extension was seeded.
   *
   * Absent means the peer did not say, which is not the same as "off": a daemon launched before
   * this field existed answers without it.
   */
  browser?: { enabled: boolean; extensionDir: string | null };
}

/** What `daemon.stop` answers before the socket closes. */
export interface DaemonStopReceipt {
  stopping: true;
  instance_id: string;
}

/**
 * The codes this module reports. They are deliberately *not* added to the shared work error
 * union: none of them can come from the work ledger, and a caller switching on work codes must
 * not silently absorb a data-directory conflict as an ordinary work rejection.
 */
export const DAEMON_ERROR_CODES = {
  /** A live host already owns this data directory and is not a daemon. */
  dataDirConflict: 'DATA_DIR_CONFLICT',
  /** The descriptor and the answering daemon do not describe the same instance. */
  instanceMismatch: 'DAEMON_INSTANCE_MISMATCH',
  /** Nothing is listening for this data directory. */
  daemonUnavailable: WORK_ERROR_CODES.hostUnavailable
} as const;

/**
 * True when this descriptor was published by a daemon rather than by the desktop app.
 *
 * `kind` is the discriminator, and its *absence* means desktop: every descriptor written before
 * the field existed belonged to one. Treating an unlabelled file as a daemon would make an
 * installed app's own directory look claimable.
 */
function isDaemonDescriptor(descriptor: RuntimeDescriptor): boolean {
  return descriptor.kind === 'daemon';
}

/** How long `daemon start` waits for a daemon that actually answers. */
export const DAEMON_START_TIMEOUT_MS = 15_000;
/** How long `daemon stop` waits for the socket to stop answering. */
export const DAEMON_STOP_TIMEOUT_MS = 10_000;
/** One socket handshake or call. A hung peer must not hang a shell. */
export const DAEMON_PROBE_TIMEOUT_MS = 5_000;
const POLL_INTERVAL_MS = 150;

// ---------------------------------------------------------------------------------------
// Reading the directory's owner
// ---------------------------------------------------------------------------------------

/** The live owner of one data directory, as proved by its own authenticated answer. */
export type DataDirOwner =
  | { kind: 'daemon'; status: DaemonStatusReport; descriptor: RuntimeDescriptor }
  | { kind: 'desktop'; status: HostStatusReport; descriptor: RuntimeDescriptor };

async function readDescriptor(dataDir: string): Promise<RuntimeDescriptor | null> {
  return readRuntimeDescriptor(dataDir).catch((error: unknown) => {
    throw new ControlUnavailableError(error instanceof Error ? error.message : String(error));
  });
}

/**
 * The one call each kind of owner answers for "are you there".
 *
 * A daemon descriptor is proved with `daemon.status`, a desktop one with `host.status`. Asking
 * the wrong question would answer `HOST_UNAVAILABLE` for a *live* peer and make it look absent,
 * which is the failure mode that would let a daemon start on top of a running desktop app.
 */
async function callOwner(descriptor: RuntimeDescriptor, timeoutMs: number): Promise<unknown | null> {
  // A daemon is asked its own question; the desktop host is asked `host.status`. Asking the wrong
  // one would answer `HOST_UNAVAILABLE` for a *live* peer and make it look absent — which is how a
  // daemon would end up starting on top of a running desktop app.
  const method: ControlMethod = isDaemonDescriptor(descriptor) ? 'daemon.status' : 'host.status';
  let client: ControlClient | null = null;
  try {
    client = await openControlClient(descriptor, { timeoutMs });
    return await client.call(method, {});
  } catch {
    return null;
  } finally {
    await client?.close().catch(() => undefined);
  }
}

/**
 * A daemon answer, or null when it is not one.
 *
 * Every field `stop` or `status` reports is checked here rather than asserted: the answer comes
 * from another process over a socket, and a peer that names no real instance — or an instance
 * whose pid is not a pid — must be treated as no daemon at all, not as a daemon whose identity
 * is unknown.
 */
function asDaemonStatus(value: unknown): DaemonStatusReport | null {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return null;
  const record = value as Record<string, unknown>;
  const instanceId = record.instance_id;
  const pid = record.pid;
  const dataDir = record.data_dir;
  const version = record.version;
  const startedAt = record.started_at;
  const endpoint = record.endpoint;
  if (typeof instanceId !== 'string' || instanceId.length === 0) return null;
  if (typeof pid !== 'number' || !Number.isInteger(pid) || pid <= 0) return null;
  if (typeof dataDir !== 'string' || dataDir.length === 0) return null;
  if (typeof version !== 'string' || version.length === 0) return null;
  if (typeof startedAt !== 'string' || startedAt.length === 0) return null;
  if (typeof endpoint !== 'string' || endpoint.length === 0) return null;
  const urls = record.urls;
  if (typeof urls !== 'object' || urls === null || Array.isArray(urls)) return null;
  const surfaces = urls as Record<string, unknown>;
  const core = surfaces.core;
  const desktop = surfaces.desktop;
  const plugins = surfaces.plugins;
  if (typeof core !== 'string' || typeof desktop !== 'string' || typeof plugins !== 'string') return null;
  // The tunnel block is optional because a peer built before it existed answers without one, and
  // an absent block must stay absent rather than being invented as `off`. When it *is* present it
  // is validated, so a malformed report cannot be shown as a healthy remote address.
  const rawTunnel = record.tunnel;
  let tunnel: DaemonStatusReport['tunnel'];
  if (rawTunnel !== undefined) {
    if (typeof rawTunnel !== 'object' || rawTunnel === null || Array.isArray(rawTunnel)) return null;
    const entry = rawTunnel as Record<string, unknown>;
    const state = entry.state;
    const detail = entry.detail;
    const publicUrl = entry.publicUrl;
    const handshakeAt = entry.handshakeAt;
    if (state !== 'off' && state !== 'starting' && state !== 'connected' && state !== 'unavailable') return null;
    if (typeof detail !== 'string') return null;
    if (publicUrl !== null && typeof publicUrl !== 'string') return null;
    if (handshakeAt !== null && (typeof handshakeAt !== 'number' || !Number.isFinite(handshakeAt))) return null;
    tunnel = { state, detail, publicUrl, handshakeAt };
  }
  // The browser block is optional for the same reason the tunnel one is: a peer built before it
  // existed answers without it, and an absent block must stay absent rather than being invented as
  // `enabled: false`. When it *is* present it is validated, so a malformed report cannot be shown
  // as a daemon that serves the browser transport.
  const rawBrowser = record.browser;
  let browser: DaemonStatusReport['browser'];
  if (rawBrowser !== undefined) {
    if (typeof rawBrowser !== 'object' || rawBrowser === null || Array.isArray(rawBrowser)) return null;
    const entry = rawBrowser as Record<string, unknown>;
    if (typeof entry.enabled !== 'boolean') return null;
    if (entry.extensionDir !== null && typeof entry.extensionDir !== 'string') return null;
    browser = { enabled: entry.enabled, extensionDir: entry.extensionDir };
  }
  return {
    instance_id: instanceId,
    pid,
    data_dir: dataDir,
    version,
    started_at: startedAt,
    endpoint,
    urls: { core, desktop, plugins },
    kind: 'daemon',
    ...(tunnel === undefined ? {} : { tunnel }),
    ...(browser === undefined ? {} : { browser })
  };
}

/**
 * A desktop-host answer, or null when it is not one.
 *
 * Checked for the same reason the daemon answer is: this comes from another process, and the one
 * field the conflict message quotes — `pid` — has to be a real pid before a refusal names it.
 */
function asHostStatus(value: unknown): HostStatusReport | null {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return null;
  const record = value as Record<string, unknown>;
  const pid = record.pid;
  const installationId = record.installation_id;
  if (typeof pid !== 'number' || !Number.isInteger(pid) || pid <= 0) return null;
  if (typeof installationId !== 'string' || installationId.length === 0) return null;
  return value as HostStatusReport;
}

/**
 * The live owner of `dataDir`, or null when nothing answers there.
 *
 * A missing descriptor is the normal "nothing is running" answer. A descriptor whose owner does
 * not answer is *also* null — the caller decides what to do about it, because "silent" means
 * "stale" for a start and "not running" for a status, and only the caller knows which question
 * was asked.
 */
export async function ownerForDataDir(
  dataDir: string,
  timeoutMs: number = DAEMON_PROBE_TIMEOUT_MS
): Promise<DataDirOwner | null> {
  const descriptor = await readDescriptor(dataDir);
  if (!descriptor) return null;
  const answer = await callOwner(descriptor, timeoutMs);
  if (answer === null) return null;
  if (isDaemonDescriptor(descriptor)) {
    const status = asDaemonStatus(answer);
    return status ? { kind: 'daemon', status, descriptor } : null;
  }
  const status = asHostStatus(answer);
  return status ? { kind: 'desktop', status, descriptor } : null;
}

/**
 * The live daemon for `dataDir`, or a truthful refusal.
 *
 * Both `status` and `stop` go through here so neither can drift into trusting the descriptor:
 * the descriptor and the answering daemon have to agree on `instance_id`, which is the only
 * proof that the socket reached is the instance the file names and not a successor that
 * replaced it while the command was starting.
 */
async function requireDaemonOwner(
  dataDir: string,
  timeoutMs: number = DAEMON_PROBE_TIMEOUT_MS
): Promise<{ status: DaemonStatusReport; descriptor: RuntimeDescriptor }> {
  const descriptor = await readDescriptor(dataDir);
  if (!descriptor) {
    throw new ControlUnavailableError(
      `no daemon is running for ${dataDir}; start it with 'wgpt daemon start --data-dir ${dataDir}'`,
      DAEMON_ERROR_CODES.daemonUnavailable
    );
  }
  if (!isDaemonDescriptor(descriptor)) {
    throw new ControlUnavailableError(
      `no daemon is running for ${dataDir}: the desktop app owns that data directory (pid ${descriptor.pid}). ` +
        'The daemon does not share a data directory with the desktop app.',
      DAEMON_ERROR_CODES.daemonUnavailable
    );
  }
  const answer = await callOwner(descriptor, timeoutMs);
  const status = answer === null ? null : asDaemonStatus(answer);
  if (!status) {
    throw new ControlUnavailableError(
      `no daemon answered for ${dataDir}: runtime.json names a control socket that is not accepting connections`,
      DAEMON_ERROR_CODES.daemonUnavailable
    );
  }
  if (descriptor.instance_id !== undefined && descriptor.instance_id !== status.instance_id) {
    throw new ControlRejectedError(
      `runtime.json names instance ${descriptor.instance_id} but the daemon answering on its socket is ` +
        `${status.instance_id}; refusing to act on an unverified instance`,
      DAEMON_ERROR_CODES.instanceMismatch
    );
  }
  return { status, descriptor };
}

export async function requireDaemon(
  dataDir: string,
  timeoutMs: number = DAEMON_PROBE_TIMEOUT_MS
): Promise<DaemonStatusReport> {
  return (await requireDaemonOwner(dataDir, timeoutMs)).status;
}

// ---------------------------------------------------------------------------------------
// Claiming a data directory
// ---------------------------------------------------------------------------------------

/**
 * Whether `dataDir` is free for a daemon, or the live daemon already running there.
 *
 * Returns the existing daemon's report when one is running — that is what makes `start`
 * idempotent — and throws `DATA_DIR_CONFLICT` when the directory is owned by something else.
 *
 * This is the *friendly* pre-check, not the authority: the runtime takes its own atomic
 * exclusive claim on the data directory before it opens the ledger, so two daemons launched in
 * the same instant are still resolved to one writer even though neither can see the other
 * through `runtime.json` yet. What this check buys is a clear refusal instead of a crash, and an
 * idempotent `start` when a daemon is already up.
 *
 * A descriptor whose owner is gone is reconciled rather than refused, but only through
 * `removeStaleRuntimeDescriptor`, which probes the pid and removes the file only when that
 * process is genuinely absent. A pid that is still alive but silent is *not* stale: it is a
 * host that has not answered yet, or a process that reused the id, and neither is permission to
 * take over its durable state.
 */
export async function claimDataDir(dataDir: string): Promise<DaemonStatusReport | null> {
  const owner = await ownerForDataDir(dataDir);
  if (owner?.kind === 'daemon') return owner.status;
  if (owner?.kind === 'desktop') {
    throw new ControlRejectedError(
      `the desktop app owns ${dataDir} (pid ${owner.status.pid}); a daemon must not write the same ledger. ` +
        'Stop the desktop app, or give the daemon its own --data-dir.',
      DAEMON_ERROR_CODES.dataDirConflict
    );
  }
  const descriptor = await readDescriptor(dataDir);
  if (!descriptor) return null;
  const removed = await removeStaleRuntimeDescriptor(dataDir);
  if (!removed) {
    throw new ControlRejectedError(
      `pid ${descriptor.pid} still owns ${dataDir} but its control socket did not answer; refusing to start a ` +
        'second writer over the same durable state.',
      DAEMON_ERROR_CODES.dataDirConflict
    );
  }
  return null;
}

// ---------------------------------------------------------------------------------------
// Launching the daemon process
// ---------------------------------------------------------------------------------------

export interface DaemonLaunchSpec {
  /** The plain Node executable the daemon runs on. Never an Electron binary. */
  executable: string;
  /** The built daemon entry: `<out>/daemon/index.js`. */
  entry: string;
}

/** True when `execPath` is an Electron binary rather than Node. */
function isElectronExecutable(env: NodeJS.ProcessEnv, execPath: string): boolean {
  if (env.ELECTRON_RUN_AS_NODE) return true;
  const base = path.basename(execPath).toLowerCase();
  return base === 'electron' || base === 'electron.exe';
}

/**
 * The daemon entry, derived from the running CLI bundle's own location.
 *
 * `out/cli/index.js` and `out/daemon/index.js` are siblings in the repository, so in a source
 * checkout the daemon is always exactly where the CLI was built next to. The path is required to
 * exist: inside a packaged app the same arithmetic resolves to a path *within* `app.asar`, which
 * plain Node cannot read, so a packaged copy has to be told where its extracted daemon lives
 * instead of being handed a path that would fail on the first `require`.
 */
function daemonEntryFrom(argv1: string | undefined): string | null {
  if (!argv1) return null;
  const normalized = argv1.split('\\').join('/');
  if (!normalized.endsWith('/cli/index.js')) return null;
  const candidate = path.join(path.dirname(argv1), '..', 'daemon', 'index.js');
  return existsSync(candidate) ? candidate : null;
}

/**
 * What to run for a daemon, or a truthful refusal.
 *
 * The daemon is plain Node, always: it owns an MCP endpoint, a work ledger and a control socket
 * with no window, no menu and no browser, and it must keep doing that on a machine where the
 * desktop app was never installed. So an Electron binary is never used as a fallback runtime —
 * a packaged `bin/wgpt` that is itself running on one resolves a real `node` from PATH and
 * passes it in `WGPT_NODE_EXECUTABLE`. When no Node exists, the command says so instead of
 * quietly starting an app process that cannot serve the request.
 */
export function daemonLaunchSpec(
  env: NodeJS.ProcessEnv = process.env,
  argv1: string | undefined = process.argv[1],
  execPath: string = process.execPath
): DaemonLaunchSpec {
  const configured = env.WGPT_DAEMON_ENTRY?.trim();
  const entry = configured || daemonEntryFrom(argv1);
  if (!entry) {
    throw new ControlUnavailableError(
      'cannot locate the daemon entry: run wgpt through bin/wgpt after `npm run build:node`, or set ' +
        'WGPT_DAEMON_ENTRY to the built daemon bundle',
      DAEMON_ERROR_CODES.daemonUnavailable
    );
  }
  if (configured && !existsSync(entry)) {
    throw new ControlUnavailableError(
      `WGPT_DAEMON_ENTRY names ${entry}, which does not exist`,
      DAEMON_ERROR_CODES.daemonUnavailable
    );
  }
  const node = env.WGPT_NODE_EXECUTABLE?.trim();
  if (node) return { executable: node, entry };
  if (isElectronExecutable(env, execPath)) {
    throw new ControlUnavailableError(
      'the daemon runs on plain Node, and this process is an Electron binary; set WGPT_NODE_EXECUTABLE to a ' +
        'node executable (bin/wgpt sets it when node is on PATH)',
      DAEMON_ERROR_CODES.daemonUnavailable
    );
  }
  return { executable: execPath, entry };
}

/** The child's environment: the daemon is not a script runner, so that marker is dropped. */
function daemonEnv(env: NodeJS.ProcessEnv): NodeJS.ProcessEnv {
  const child = { ...env };
  delete child.ELECTRON_RUN_AS_NODE;
  return child;
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

export interface StartDaemonResult {
  status: DaemonStatusReport;
  /** False when an already-running daemon was adopted instead of a new one launched. */
  started: boolean;
}

export interface DaemonCommandOptions {
  env?: NodeJS.ProcessEnv;
  /** One socket handshake or call. */
  probeTimeoutMs?: number;
  /** How long `start` waits for a daemon that answers, or `stop` for one that goes away. */
  timeoutMs?: number;
  /** Diagnostics sink for the launch line; the CLI passes its stderr writer. */
  note?: (text: string) => void;
  /** Passed to a foreground daemon, which then prints one JSON readiness line instead of text. */
  json?: boolean;
  /**
   * Whether the daemon being launched should also serve the browser bridge.
   *
   * A launch argument rather than a stored setting: the daemon decides at startup whether it
   * materialises the companion extension and opens a bridge, so this has to reach the child
   * process as an argument. It is forwarded verbatim, and the child refuses a malformed value the
   * same way every other argument is refused.
   */
  browser?: boolean;
}

/**
 * Starts a detached daemon for `dataDir` and waits until it answers.
 *
 * Detached and unreferenced, so the daemon outlives the shell that asked for it — that is the
 * whole difference between `daemon start` and `daemon serve`. Nothing here writes a pid file:
 * the daemon publishes its own descriptor, and `status`/`stop` reach it through that and its
 * authenticated socket.
 */
export async function startDaemon(
  dataDir: string,
  options: DaemonCommandOptions = {}
): Promise<StartDaemonResult> {
  const existing = await claimDataDir(dataDir);
  if (existing) return { status: existing, started: false };
  const env = options.env ?? process.env;
  const spec = daemonLaunchSpec(env);
  options.note?.(`starting daemon ${spec.executable} ${spec.entry}`);
  const child = spawn(spec.executable, [spec.entry, '--data-dir', dataDir, ...(options.browser ? ['--browser'] : [])], {
    env: daemonEnv(env),
    detached: true,
    stdio: 'ignore'
  });
  // The launch error is reported by the wait below ("did not answer"), which is the fact the
  // caller acts on; this handler only keeps an ENOENT from becoming an unhandled event.
  child.on('error', () => undefined);
  child.unref();
  const budget = options.timeoutMs ?? DAEMON_START_TIMEOUT_MS;
  const deadline = Date.now() + budget;
  for (;;) {
    const owner = await ownerForDataDir(dataDir);
    if (owner?.kind === 'daemon') return { status: owner.status, started: true };
    // A desktop host appearing while this command waits is a refusal, not a timeout: the
    // directory changed hands, and the daemon being waited for must not open the same ledger
    // beside it.
    if (owner?.kind === 'desktop') {
      throw new ControlRejectedError(
        `the desktop app took ${dataDir} while the daemon was starting; refusing to run two writers over it`,
        DAEMON_ERROR_CODES.dataDirConflict
      );
    }
    if (Date.now() >= deadline) {
      throw new ControlUnavailableError(
        `the daemon did not answer on its control socket within ${budget}ms`,
        DAEMON_ERROR_CODES.daemonUnavailable
      );
    }
    await sleep(POLL_INTERVAL_MS);
  }
}

/**
 * Runs a daemon in the foreground, as this process's child.
 *
 * The daemon itself is a separate process even here: the CLI bundle must stay free of the
 * runtime graph so that `wgpt work …` and `wgpt daemon status` keep working under a plain Node
 * with no Electron anywhere, and the daemon must not be able to take the CLI down with it.
 * Signals are forwarded, so Ctrl-C in the terminal stops the daemon it is showing.
 */
export async function serveDaemon(dataDir: string, options: DaemonCommandOptions = {}): Promise<number> {
  const existing = await claimDataDir(dataDir);
  if (existing) {
    throw new ControlRejectedError(
      `a daemon is already running for ${dataDir} (pid ${existing.pid}, instance ${existing.instance_id})`,
      DAEMON_ERROR_CODES.dataDirConflict
    );
  }
  const env = options.env ?? process.env;
  const spec = daemonLaunchSpec(env);
  const child = spawn(
    spec.executable,
    [spec.entry, '--data-dir', dataDir, ...(options.json ? ['--json'] : []), ...(options.browser ? ['--browser'] : [])],
    { env: daemonEnv(env), stdio: 'inherit' }
  );
  const forward = (signal: NodeJS.Signals): void => {
    child.kill(signal);
  };
  process.on('SIGINT', forward);
  process.on('SIGTERM', forward);
  try {
    return await new Promise<number>((resolve, reject) => {
      child.once('error', (error) => reject(new ControlUnavailableError(`daemon launch failed: ${error.message}`)));
      child.once('exit', (code, signal) => resolve(code ?? (signal ? 1 : 0)));
    });
  } finally {
    process.off('SIGINT', forward);
    process.off('SIGTERM', forward);
  }
}

// ---------------------------------------------------------------------------------------
// Stopping
// ---------------------------------------------------------------------------------------

/**
 * Stops the exact daemon this data directory's descriptor names.
 *
 * The identity check is what makes this safe to run twice and safe to run against a directory
 * somebody else is using: the instance that stops is the one the descriptor and the answering
 * socket agree on, it stops itself over its own authenticated socket, and no process id is ever
 * signalled. Afterwards the socket is waited out, so a following `status` cannot observe a
 * daemon that is already gone.
 */
export async function stopDaemon(
  dataDir: string,
  options: DaemonCommandOptions = {}
): Promise<DaemonStopReceipt> {
  const { status, descriptor } = await requireDaemonOwner(dataDir, options.probeTimeoutMs ?? DAEMON_PROBE_TIMEOUT_MS);
  const receipt = await callDaemonStop(descriptor, status, options.probeTimeoutMs ?? DAEMON_PROBE_TIMEOUT_MS);
  const deadline = Date.now() + (options.timeoutMs ?? DAEMON_STOP_TIMEOUT_MS);
  for (;;) {
    const owner = await ownerForDataDir(dataDir);
    if (!owner) break;
    if (Date.now() >= deadline) {
      throw new ControlUnavailableError(
        `daemon ${status.instance_id} accepted the stop but is still answering after ` +
          `${options.timeoutMs ?? DAEMON_STOP_TIMEOUT_MS}ms`,
        DAEMON_ERROR_CODES.daemonUnavailable
      );
    }
    await sleep(POLL_INTERVAL_MS);
  }
  // The daemon withdraws its own descriptor on the way out. This is the fallback for a daemon
  // that died before it could: it removes the file only when the recorded pid is gone, so a
  // successor's descriptor is never deleted.
  await removeStaleRuntimeDescriptor(dataDir).catch(() => false);
  return receipt;
}

/**
 * Reads or changes the running daemon's own configuration.
 *
 * Deliberately routed through the daemon rather than written here: the live host owns that
 * `config.json`, and it applies the change through the same serialized transaction the desktop UI
 * uses, then answers only once the file has been replaced. A CLI that opened the file directly
 * would be a second writer over shared settings — and would silently lose a concurrent desktop
 * edit it never saw.
 */
export async function configureDaemon(
  dataDir: string,
  request: DaemonConfigRequest,
  options: DaemonCommandOptions = {}
): Promise<DaemonConfigReport> {
  // Proved first, exactly like `stop`: the change is applied to the instance the descriptor names
  // and the socket actually answers for.
  const { status, descriptor } = await requireDaemonOwner(dataDir, options.probeTimeoutMs ?? DAEMON_PROBE_TIMEOUT_MS);
  const client = await openControlClient(descriptor, { timeoutMs: options.probeTimeoutMs ?? DAEMON_PROBE_TIMEOUT_MS });
  try {
    const answer = await client.call('daemon.config', request);
    // Validated rather than cast: this came from another process over a socket, and a peer that
    // answers an unusable shape must be reported as such instead of being printed as settings.
    const parsed = daemonConfigReportSchema.safeParse(answer);
    if (!parsed.success) {
      throw new ControlRejectedError(
        `the daemon at ${dataDir} (instance ${status.instance_id}) answered an unusable configuration report`,
        DAEMON_ERROR_CODES.instanceMismatch
      );
    }
    return parsed.data;
  } finally {
    await client.close().catch(() => undefined);
  }
}

/**
 * Reads, stores or clears one of the credentials this daemon may hold.
 *
 * Same rule as `configureDaemon`: the *running* daemon performs the write, so a credential cannot
 * be stored behind the owner's back and the transport is reconciled with the value the daemon
 * itself committed. Only presence comes back.
 */
export async function configureDaemonSecret(
  dataDir: string,
  request: DaemonSecretRequest,
  options: DaemonCommandOptions = {}
): Promise<DaemonSecretReport> {
  const { status, descriptor } = await requireDaemonOwner(dataDir, options.probeTimeoutMs ?? DAEMON_PROBE_TIMEOUT_MS);
  const client = await openControlClient(descriptor, { timeoutMs: options.probeTimeoutMs ?? DAEMON_PROBE_TIMEOUT_MS });
  try {
    const answer = await client.call('daemon.secret', request);
    const parsed = daemonSecretReportSchema.safeParse(answer);
    if (!parsed.success) {
      throw new ControlRejectedError(
        `the daemon at ${dataDir} (instance ${status.instance_id}) answered an unusable credential report`,
        DAEMON_ERROR_CODES.instanceMismatch
      );
    }
    return parsed.data;
  } finally {
    await client.close().catch(() => undefined);
  }
}

async function callDaemonStop(
  descriptor: RuntimeDescriptor,
  status: DaemonStatusReport,
  timeoutMs: number
): Promise<DaemonStopReceipt> {
  const client = await openControlClient(descriptor, { timeoutMs });
  try {
    const answer = await client.call('daemon.stop', {});
    const record = (answer ?? {}) as Record<string, unknown>;
    if (record.instance_id !== status.instance_id) {
      throw new ControlRejectedError(
        `the daemon answered a stop for instance ${String(record.instance_id)}, not ${status.instance_id}`,
        DAEMON_ERROR_CODES.instanceMismatch
      );
    }
    return { stopping: true, instance_id: status.instance_id };
  } finally {
    await client.close().catch(() => undefined);
  }
}
