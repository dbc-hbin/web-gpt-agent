/**
 * `wgpt daemon …` — the command surface over the standalone daemon.
 *
 * This module owns *grammar and presentation*; `lifecycle.ts` owns the behaviour. The split is
 * deliberate, because the interesting questions here are all about what the command is allowed
 * to say:
 *
 *   - `serve` runs a daemon in the foreground of the terminal that asked for it, and exits with
 *     the daemon's own exit code. It refuses when one is already running rather than adopting a
 *     process it is not showing output for.
 *   - `start` launches a detached daemon and waits for it to answer, and is idempotent: an
 *     already-running daemon is returned as-is. It never falls back to the desktop app, and it
 *     refuses outright when the data directory belongs to the desktop app.
 *   - `status` reports the daemon's own answer, never the descriptor, never a pid.
 *   - `config` reads or changes that daemon's approved folders, read-only mode and tool
 *     permissions, through the daemon itself rather than by writing `config.json` behind its back.
 *   - `stop` stops the exact instance the descriptor names, over its authenticated socket.
 *
 * Nothing here prints a URL the daemon did not itself publish, nothing prints "stopped" for an
 * instance that did not answer a stop, and nothing prints a configuration report the daemon did
 * not itself return.
 */

import path from 'node:path';
import {
  DAEMON_PROBE_TIMEOUT_MS,
  configureDaemon,
  configureDaemonSecret,
  requireDaemon,
  serveDaemon,
  startDaemon,
  stopDaemon,
  type DaemonStatusReport,
  type DaemonStopReceipt
} from './lifecycle.js';
import { WORK_ERROR_CODES } from '../shared/work.js';
import { CAPABILITIES } from '../shared/types.js';
import {
  DAEMON_SECRET_KEYS,
  daemonConfigRequestSchema,
  daemonSecretRequestSchema,
  type DaemonConfigReport,
  type DaemonConfigRequest,
  type DaemonSecretReport,
  type DaemonSecretRequest
} from '../shared/daemon-config.js';

/** Where this command surface writes, supplied by the CLI so both share one output convention. */
export interface DaemonCliIo {
  json: boolean;
  /** One line of command output on stdout. */
  out(text: string): void;
  /** One diagnostic line on stderr. */
  diag(text: string): void;
}

/** A local input mistake in a `daemon` command. Mapped to exit 2 by the CLI's failure reporter. */
export class DaemonUsageError extends Error {
  readonly code = WORK_ERROR_CODES.invalidInput;
  constructor(message: string) {
    super(message);
    this.name = 'DaemonUsageError';
  }
}

/**
 * Runs one `daemon` command. `args` are the words after `daemon`; `dataDir` is the absolute
 * directory the CLI already resolved from `--data-dir`.
 *
 * Failures that are answers — nothing running, a data-directory conflict, a refused stop — are
 * thrown as `ControlUnavailableError`/`ControlRejectedError` and become the CLI's exit codes 3
 * and 4. Only a malformed command is `DaemonUsageError` (exit 2).
 */
export async function runDaemonCommand(
  args: readonly string[],
  dataDir: string,
  io: DaemonCliIo,
  env: NodeJS.ProcessEnv = process.env,
  flags: ReadonlyMap<string, string | true> = new Map()
): Promise<number> {
  const command = args[0];
  if (command === undefined) {
    throw new DaemonUsageError("daemon requires a command — 'serve', 'start', 'status', 'config', 'secret' or 'stop'");
  }
  const extra = args.slice(1);
  if (command !== 'config' && command !== 'secret' && extra.length > 0) {
    throw new DaemonUsageError(`daemon ${command} takes no positional arguments; got ${extra.join(' ')}`);
  }
  switch (command) {
    case 'serve':
      return serveDaemon(dataDir, { env, json: io.json, browser: browserFlag(flags) });
    case 'start': {
      const result = await startDaemon(dataDir, {
        env,
        note: (text) => io.diag(`wgpt: ${text}`),
        browser: browserFlag(flags)
      });
      if (!result.started) io.diag(`wgpt: daemon already running (pid ${result.status.pid}); reusing it`);
      emitStatus(io, result.status);
      return 0;
    }
    case 'status': {
      emitStatus(io, await requireDaemon(dataDir, DAEMON_PROBE_TIMEOUT_MS));
      return 0;
    }
    case 'config':
      return runDaemonConfig(extra, dataDir, io, flags);
    case 'secret':
      return runDaemonSecret(extra, dataDir, io);
    case 'stop': {
      const receipt: DaemonStopReceipt = await stopDaemon(dataDir, { timeoutMs: DAEMON_PROBE_TIMEOUT_MS });
      if (io.json) io.out(JSON.stringify(receipt));
      else io.out(`stopped instance_id ${receipt.instance_id}`);
      return 0;
    }
    default:
      throw new DaemonUsageError(
        `unknown daemon command: ${command} — expected 'serve', 'start', 'status', 'config', 'secret' or 'stop'`
      );
  }
}

/**
 * `wgpt daemon secret …` — the credentials this daemon may hold.
 *
 * The value is accepted as an argument rather than read from a prompt so the command stays usable
 * from a script, and it is never echoed back: every form prints presence only. `set` therefore
 * takes the key's value on the command line, which is visible in the caller's own shell history —
 * documented rather than papered over, because the alternative (a hidden prompt) cannot be driven
 * by the same scripts this command exists for.
 */
async function runDaemonSecret(args: readonly string[], dataDir: string, io: DaemonCliIo): Promise<number> {
  const action = args[0] ?? 'status';
  const rest = args.slice(1);
  const request = ((): DaemonSecretRequest => {
    if (action === 'status') {
      if (rest.length > 0) throw new DaemonUsageError('daemon secret takes no arguments for a status');
      return { action: 'status' };
    }
    if (action === 'set' || action === 'clear') {
      const key = rest[0];
      if (key === undefined) throw new DaemonUsageError(`daemon secret ${action} requires a key name`);
      if (!(DAEMON_SECRET_KEYS as readonly string[]).includes(key)) {
        throw new DaemonUsageError(`unknown secret ${key} — expected one of ${DAEMON_SECRET_KEYS.join(', ')}`);
      }
      const value = rest[1];
      if (action === 'set') {
        if (value === undefined) throw new DaemonUsageError('daemon secret set requires a value');
        if (rest.length > 2) throw new DaemonUsageError('daemon secret set takes a key and one value');
        return { action: 'set', key: key as (typeof DAEMON_SECRET_KEYS)[number], value };
      }
      if (rest.length > 1) throw new DaemonUsageError(`daemon secret clear takes one key name; got ${rest.join(' ')}`);
      return { action: 'clear', key: key as (typeof DAEMON_SECRET_KEYS)[number] };
    }
    throw new DaemonUsageError(`unknown daemon secret command: ${action} — expected 'status', 'set' or 'clear'`);
  })();

  const parsed = daemonSecretRequestSchema.safeParse(request);
  if (!parsed.success) {
    const issue = parsed.error.issues[0];
    throw new DaemonUsageError(issue ? `${issue.path.join('.') || 'input'}: ${issue.message}` : 'invalid secret request');
  }
  emitSecret(io, await configureDaemonSecret(dataDir, parsed.data, { probeTimeoutMs: DAEMON_PROBE_TIMEOUT_MS }));
  return 0;
}

/**
 * `wgpt daemon config …` — the daemon's approved folders, read-only mode and tool permissions.
 *
 * A closed grammar rather than a settings key/value channel: the words below are the whole
 * surface a socket can change, so a caller cannot rewrite tunnel credentials, appearance or
 * continuation prompts through it. Every form is answered by the running daemon (see
 * `configureDaemon`), which is what keeps one writer over `config.json`.
 */
async function runDaemonConfig(
  args: readonly string[],
  dataDir: string,
  io: DaemonCliIo,
  flags: ReadonlyMap<string, string | true>
): Promise<number> {
  const action = args[0] ?? 'get';
  const rest = args.slice(1);
  const request = ((): DaemonConfigRequest => {
    if (action === 'get') {
      if (rest.length > 0) throw new DaemonUsageError('daemon config takes no arguments for a read');
      return { action: 'get' };
    }
    if (action === 'add-root') {
      const folder = rest[0];
      if (folder === undefined) throw new DaemonUsageError('daemon config add-root requires an absolute <path>');
      if (rest.length > 1) throw new DaemonUsageError(`daemon config add-root takes one path; got ${rest.join(' ')}`);
      // A relative path is a local mistake, and the daemon would refuse it anyway: catching it
      // here keeps "malformed command" at exit 2 instead of spending a round trip to learn it.
      if (!path.isAbsolute(folder)) throw new DaemonUsageError(`daemon config add-root needs an absolute path; got ${folder}`);
      const name = flags.get('name');
      if (name === true) throw new DaemonUsageError('--name requires a value');
      return name === undefined ? { action: 'add-root', path: folder } : { action: 'add-root', path: folder, name };
    }
    if (action === 'remove-root') {
      const name = rest[0];
      if (name === undefined) throw new DaemonUsageError('daemon config remove-root requires a <name>');
      if (rest.length > 1) throw new DaemonUsageError(`daemon config remove-root takes one name; got ${rest.join(' ')}`);
      return { action: 'remove-root', name };
    }
    if (action === 'file-access') {
      const mode = rest[0];
      if (rest.length !== 1 || (mode !== 'approved-roots' && mode !== 'all-files')) {
        throw new DaemonUsageError("daemon config file-access expects 'approved-roots' or 'all-files'; all-files gives model-facing file tools access anywhere your account can access. Commands already run with your user privileges.");
      }
      return { action: 'file-access', mode };
    }
    if (action === 'read-only') {
      return { action: 'read-only', enabled: onOff(rest, 'read-only') };
    }
    if (action === 'capability') {
      const name = rest[0];
      if (name === undefined) throw new DaemonUsageError(`daemon config capability requires a permission name`);
      if (!(CAPABILITIES as readonly string[]).includes(name)) {
        throw new DaemonUsageError(
          `unknown permission ${name} — expected one of ${CAPABILITIES.join(', ')}`
        );
      }
      return {
        action: 'capability',
        name: name as (typeof CAPABILITIES)[number],
        enabled: onOff(rest.slice(1), `capability ${name}`)
      };
    }
    if (action === 'tunnel') {
      const kind = rest[0];
      if (kind === undefined) throw new DaemonUsageError("daemon config tunnel requires 'openai', 'cloudflared' or 'manual'");
      if (kind !== 'openai' && kind !== 'cloudflared' && kind !== 'manual') {
        throw new DaemonUsageError(`daemon config tunnel expects 'openai', 'cloudflared' or 'manual'; got ${kind}`);
      }
      const rest2 = rest.slice(1);
      if (rest2.length > 1) throw new DaemonUsageError(`daemon config tunnel takes at most one tunnel id; got ${rest2.join(' ')}`);
      const id = rest2[0];
      if (id !== undefined && kind === 'manual') {
        throw new DaemonUsageError('a manual transport has no tunnel id to set; use `daemon config tunnel manual`');
      }
      return id === undefined ? { action: 'tunnel', kind } : { action: 'tunnel', kind, tunnelId: id };
    }
    if (action === 'reconnect') {
      if (rest.length > 0) throw new DaemonUsageError('daemon config reconnect takes no arguments');
      return { action: 'reconnect' };
    }
    throw new DaemonUsageError(
      `unknown daemon config command: ${action} — expected 'get', 'add-root', 'remove-root', 'file-access', 'read-only', 'capability', 'tunnel' or 'reconnect'`
    );
  })();

  // Parsed with the same schema the socket parses, so a bad name or a relative path is a local
  // usage error here rather than a round trip that comes back as a remote refusal.
  const parsed = daemonConfigRequestSchema.safeParse(request);
  if (!parsed.success) {
    const issue = parsed.error.issues[0];
    throw new DaemonUsageError(issue ? `${issue.path.join('.') || 'input'}: ${issue.message}` : 'invalid configuration request');
  }
  emitConfig(io, await configureDaemon(dataDir, parsed.data, { probeTimeoutMs: DAEMON_PROBE_TIMEOUT_MS }));
  return 0;
}

/** Reads an explicit `on`/`off` word. Silence is never a change to a permission. */
function onOff(rest: readonly string[], label: string): boolean {
  const word = rest[0];
  if (word === undefined) throw new DaemonUsageError(`daemon config ${label} requires 'on' or 'off'`);
  if (rest.length > 1) throw new DaemonUsageError(`daemon config ${label} takes one word; got ${rest.join(' ')}`);
  if (word === 'on') return true;
  if (word === 'off') return false;
  throw new DaemonUsageError(`daemon config ${label} expects 'on' or 'off'; got ${word}`);
}

/**
 * Whether `--browser` asked for the optional browser transport.
 *
 * A flag on `start`/`serve` rather than a stored setting, because it is a property of *this
 * launch*: it decides whether the daemon materialises the companion extension and opens a bridge
 * at all, which is not something a later `config` call could change in a process that already
 * decided. `--browser=false` is accepted so a script can spell the default explicitly.
 */
function browserFlag(flags: ReadonlyMap<string, string | true>): boolean {
  const value = flags.get('browser');
  if (value === undefined) return false;
  if (value === true) return true;
  if (value === 'true' || value === '1') return true;
  if (value === 'false' || value === '0') return false;
  throw new DaemonUsageError(`--browser expects true or false; got ${value}`);
}

function emitConfig(io: DaemonCliIo, report: DaemonConfigReport): void {
  if (io.json) {
    io.out(JSON.stringify(report));
    return;
  }
  if (report.roots.length === 0) io.out('no approved folders');
  for (const root of report.roots) io.out(`root        /${root.name}  ${root.path}`);
  io.out(`file-access ${report.fileAccessMode}`);
  io.out(`read-only   ${report.readOnly ? 'on' : 'off'}`);
  // The tunnel is shown before the permissions because it decides whether a client can reach this
  // daemon at all; the permissions only decide what it may do once it does.
  io.out(`tunnel      ${report.tunnel.kind}${report.tunnel.tunnelId ? `  ${report.tunnel.tunnelId}` : ''}`);
  if (report.tunnel.kind === 'openai' && report.tunnel.tunnelId !== '' && !report.tunnel.hasApiKey) {
    io.out('            no tunnel API key is stored; set one with `wgpt daemon secret set openaiApiKey`');
  }
  for (const capability of CAPABILITIES) {
    const effective = report.effectiveCapabilities[capability];
    const requested = report.capabilities[capability];
    // The two are shown together because they differ exactly where a daemon is honest about
    // itself: a granted Desktop permission is not effective on a host with no browser.
    io.out(
      `permission  ${capability.padEnd(15)} ${requested ? 'on' : 'off'}` +
        (requested === effective ? '' : '  (not effective on this host)')
    );
  }
}

function emitSecret(io: DaemonCliIo, report: DaemonSecretReport): void {
  if (io.json) {
    io.out(JSON.stringify(report));
    return;
  }
  // Never the value: a credential that can be read back over the control socket leaks through
  // anything able to read the descriptor, and the caller that set it already knows it.
  for (const entry of report.keys) io.out(`${entry.key.padEnd(20)} ${entry.present ? 'stored' : 'not stored'}`);
  if (!report.storage.available) io.out(`storage              unavailable: ${report.storage.detail ?? 'no detail'}`);
}

function emitStatus(io: DaemonCliIo, status: DaemonStatusReport): void {
  if (io.json) {
    io.out(JSON.stringify(status));
    return;
  }
  for (const text of formatStatus(status)) io.out(text);
}

function formatStatus(status: DaemonStatusReport): string[] {
  const lines = [
    `instance_id  ${status.instance_id}`,
    `pid          ${status.pid}`,
    `kind         ${status.kind}`,
    `data_dir     ${status.data_dir}`,
    `version      ${status.version}`,
    `started_at   ${status.started_at}`,
    `endpoint     ${status.endpoint}`,
    `desktop      ${status.urls.desktop}`,
    `plugins      ${status.urls.plugins}`
  ];
  // A remote client's first question is whether the loopback endpoint above is reachable from
  // anywhere but this machine, so the tunnel's own answer belongs in the same report rather than a
  // second command. Absent means the peer did not say, which is not the same as "off".
  if (status.tunnel) {
    lines.push(`tunnel       ${status.tunnel.state}`);
    if (status.tunnel.publicUrl) lines.push(`public_url   ${status.tunnel.publicUrl}`);
    if (status.tunnel.detail) lines.push(`tunnel_note  ${status.tunnel.detail}`);
  }
  // The browser transport is a launch property, so the report has to say which daemon this is
  // rather than let a caller assume `--browser` was honoured: `start --browser` against a daemon
  // launched without it returns that daemon unchanged.
  if (status.browser) {
    lines.push(`browser      ${status.browser.enabled ? 'on' : 'off'}`);
    if (status.browser.enabled && status.browser.extensionDir) {
      lines.push(`extension    ${status.browser.extensionDir}`);
    }
    if (!status.browser.enabled) {
      lines.push('browser_note restart the daemon with `--browser` to serve the companion extension');
    }
  }
  return lines;
}
