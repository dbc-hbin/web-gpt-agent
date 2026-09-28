/**
 * The app-owned control socket: one local transport for the same WorkService the GUI and
 * the MCP connector call.
 *
 * The CLI is the reason this exists. An agent (or a person at a shell) has to be able to
 * ask the host what work exists, start work, and follow events without becoming a second
 * authority: no separate queue, no direct SQLite handle, no Electron window. So the socket
 * carries *the WorkService's own request shapes* — `src/shared/work.ts` is parsed here, on
 * the host side, before any service method runs — and the CLI is a thin, dumb client that
 * cannot drift from what the GUI and mobile see.
 *
 * What the transport guarantees, and why each piece is here:
 *
 *   - A **Unix socket** on POSIX and a **named pipe** on Windows, never a TCP port, because a
 *     local transport is the whole access-control story. TCP on loopback would be reachable by
 *     every process of every user on the machine; a 0700 directory holding a 0600 socket is
 *     reachable only by the owner, and its randomly named path means a second installation
 *     cannot be talked to by accident. Windows has no filesystem entry to hang those
 *     permissions on — Node's IPC listener refuses an ordinary path outright, accepting only
 *     the `\\.\pipe\` namespace — so there the transport is a pipe whose *name* carries the
 *     randomness and whose access control is the creating token's default DACL. See
 *     `controlTransportKind` and `assertControlTransport`.
 *   - **`<userData>/runtime.json`, mode 0600**, is the only discovery mechanism: it names
 *     the socket, the owning pid and the installation id. The CLI validates the file's
 *     owner, mode and non-symlink-ness before it trusts a single byte of it, because a
 *     same-user attacker who can rewrite that file could otherwise redirect every command.
 *   - A **bounded newline-delimited JSON protocol**. One `hello` first, then request/reply
 *     pairs. Bounds are on *lines*, and a line that exceeds its bound is a disconnect
 *     rather than a truncated parse — a truncated JSON line is how a client and server end
 *     up disagreeing about what was said.
 *
 * Same-UID processes are trusted. This is not a security boundary against the user's own
 * programs, and nothing here pretends otherwise.
 */

import { randomBytes, timingSafeEqual } from 'node:crypto';
import { promises as fs, type Stats } from 'node:fs';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { z } from 'zod';
import {
  workControlSchema,
  workEventsRequestSchema,
  workInstructionSchema,
  workListSchema,
  workStartSchema,
  workStatusRequestSchema,
  type WorkService
} from '../../shared/work.js';
import { runtimeFilePath as identityRuntimeFilePath, writePrivateFile } from '../identity.js';
import {
  workConnectionTargetSchema,
  workReconnectRequestSchema,
  type WorkConnectionPort
} from '../../shared/work-connection.js';
import {
  daemonConfigRequestSchema,
  daemonSecretRequestSchema,
  type DaemonConfigReport,
  type DaemonConfigRequest,
  type DaemonSecretReport,
  type DaemonSecretRequest
} from '../../shared/daemon-config.js';
import { restrictControlPipeToOwner } from './windows-pipe-acl.js';

/** The wire version. A peer that does not speak this exact version is refused, not guessed at. */
export const CONTROL_PROTOCOL_VERSION = 1;

/** A request line: the largest single `{id,method,params}` a client may send. */
export const MAX_REQUEST_BYTES = 128 * 1024;
/** A reply line: the largest single `{id,result}` or `{id,error}` a host may send. */
export const MAX_REPLY_BYTES = 64 * 1024;
/** GUI payloads may include bounded attachment bytes; they are chunked, never widening work frames. */
const GUI_CHUNK_BYTES = 48 * 1024;
/** Conservative raw reply chunk size leaves room for base64 and every control envelope. */
const GUI_REPLY_CHUNK_BYTES = 32 * 1024;
// Up to twenty 12 MiB renderer attachments are valid; JSON/base64 expansion needs headroom.
const MAX_GUI_TRANSFER_BYTES = 384 * 1024 * 1024;
const MAX_GUI_TRANSFER_PARTS = Math.ceil(MAX_GUI_TRANSFER_BYTES / GUI_CHUNK_BYTES);
/**
 * `sun_path` is 104 bytes on macOS and 108 on Linux, both including the terminator, and a
 * longer path fails with ENAMETOOLONG from a place that gives no hint why. 100 leaves room
 * for the terminator on either platform.
 *
 * Windows has no such limit — a pipe name is a kernel object name, not a path — but the name
 * is still bounded, so a descriptor stays a descriptor and an absurd name is refused before a
 * pipe is created.
 */
export const MAX_SOCKET_PATH_BYTES = 100;
/**
 * The namespaces Node documents for a Windows IPC path: "The path must refer to an entry in
 * `\\?\pipe\` or `\\.\pipe\`". This module only ever *generates* the `\\.\pipe\` form, which
 * is the one that is valid on every supported Windows version, but a descriptor naming the
 * other form is still a pipe name and is not refused for spelling.
 */
const WINDOWS_PIPE_PREFIX = '\\\\.\\pipe\\';
const WINDOWS_PIPE_PREFIXES: readonly string[] = [WINDOWS_PIPE_PREFIX, '\\\\?\\pipe\\'];
/** Longest pipe name accepted on Windows, measured in UTF-16 code units because that is what
 * the kernel counts for an object name. 200 is far above any name this module generates and
 * far below any limit that would make `CreateNamedPipe` fail for length alone. */
export const MAX_PIPE_NAME_CHARS = 200;

/**
 * Which local transport a host or client uses, and therefore which validation applies.
 *
 * The two are not interchangeable and neither is a fallback for the other. A Unix socket
 * carries its permissions in the filesystem, so ownership and mode are checkable facts about
 * the endpoint itself. A Windows named pipe has no filesystem entry to stat: Node's IPC
 * implementation refuses an ordinary path outright — it requires `\\.\pipe\` or `\?\pipe\` —
 * and the pipe's access control is whatever descriptor it was created with. Verified in
 * libuv's `src/win/pipe.c`, `pipe_alloc_accept` calls `CreateNamedPipeW(..., NULL)`, so the
 * pipe inherits the creating token's default DACL: this user (plus SYSTEM and Administrators),
 * which is the same same-user boundary the POSIX socket's 0600 mode expresses, and not
 * something this module can tighten further. What it *can* verify is the property an attacker
 * would need to break: that the name really is a pipe name in the local namespace, rather than
 * an arbitrary string that would make Node listen somewhere else entirely.
 */
export type ControlTransportKind = 'unix' | 'pipe';

export function controlTransportKind(platform: NodeJS.Platform = process.platform): ControlTransportKind {
  return platform === 'win32' ? 'pipe' : 'unix';
}

/** A random pipe name in the local namespace, unique per host and per data directory. */
function randomPipeName(): string {
  return `${WINDOWS_PIPE_PREFIX}wgpt-${randomBytes(12).toString('hex')}`;
}

/** Why `target` is not a usable local pipe name, or null when it is. */
function pipeNameProblem(target: string): string | null {
  const prefix = WINDOWS_PIPE_PREFIXES.find((candidate) => target.startsWith(candidate));
  if (!prefix || target.length <= prefix.length) {
    return `the control pipe must be a local named pipe under ${WINDOWS_PIPE_PREFIX}, not ${JSON.stringify(target)}`;
  }
  if (target.length > MAX_PIPE_NAME_CHARS) {
    return `the control pipe name is longer than ${MAX_PIPE_NAME_CHARS} characters`;
  }
  return null;
}

/**
 * Why `target` is not a usable Unix socket path, or null when it is.
 *
 * The path has to be absolute, and for the same reason `--data-dir` does: a relative endpoint
 * is resolved against whatever directory the process happened to start in, so two processes
 * that agree on the string can still end up talking to two different sockets — or to none.
 * `path.posix` rather than the host's `path`, because this branch is the POSIX branch by
 * definition: a Windows pipe name must be refused here, not silently treated as a relative
 * path and `lstat`ed against the current directory.
 */
function unixSocketPathProblem(target: string): string | null {
  if (!path.posix.isAbsolute(target)) {
    return `the control socket must be an absolute filesystem path, not ${JSON.stringify(target)}`;
  }
  return null;
}

/**
 * The platform's own validation of a control endpoint, host or client side.
 *
 * POSIX: the socket must be an absolute path in a private 0700 directory, and the socket
 * itself a 0600 socket owned by this user, none of it a symlink. Windows: the endpoint must be
 * a pipe name in the local namespace, because that namespace is the only thing Node will
 * listen on and a name outside it would either fail at listen time or silently become some
 * other object.
 */
export async function assertControlTransport(
  target: string,
  platform: NodeJS.Platform = process.platform
): Promise<void> {
  if (controlTransportKind(platform) === 'pipe') {
    const problem = pipeNameProblem(target);
    if (problem) throw new ControlUnavailableError(problem);
    return;
  }
  const shape = unixSocketPathProblem(target);
  if (shape) throw new ControlUnavailableError(shape);
  await assertPrivateSocket(target);
}

/** Bounded concurrent clients: a stuck CLI must not be able to exhaust the host's fds. */
const MAX_CLIENTS = 16;
export const CONTROL_METHODS = [
  'host.status',
  'host.stop',
  'work.start',
  'work.list',
  'work.status',
  'work.instruct',
  'work.control',
  'work.events',
  // The two local connection verbs. Deliberately here and not in the MCP `work` action union:
  // bringing an existing chat back is something a person or a local script does, never a model.
  'work.connection',
  'work.reconnect',
  // The standalone daemon's own verbs. They are answered by the transport host rather than by
  // the WorkService, because what they report, what they configure and what they stop is the
  // *process*: a daemon's endpoint URLs, its own approved folders/permissions and its lifetime
  // are facts no work ledger knows. A desktop host has no daemon behind it and refuses all
  // three with HOST_UNAVAILABLE, which is the truth about it.
  'daemon.status',
  'daemon.config',
  'daemon.secret',
  'daemon.stop',
  // The desktop GUI's fixed IPC allowlist. The renderer never chooses a socket method;
  // it names one registered IPC channel inside this single authenticated envelope.
  'gui.invoke',
  'gui.subscribe',
  'gui.presence',
  'gui.stage',
  'gui.take'
] as const;
export type ControlMethod = (typeof CONTROL_METHODS)[number];

/** The model-facing surfaces a host publishes, one URL each. */
export const CONTROL_SURFACE_IDS = ['core', 'desktop', 'plugins'] as const;
export type ControlSurfaceId = (typeof CONTROL_SURFACE_IDS)[number];

/**
 * What a standalone daemon answers for `daemon.status`.
 *
 * Deliberately the *daemon's own* facts and nothing else: which instance is answering, which
 * process it is, which directory it owns, and the URLs a client should call. It makes no claim
 * about work, the browser or the provider, because none of those are things this socket can see.
 * `kind` is present so a client that receives this shape from a hand-rolled peer cannot mistake it
 * for the desktop host's `HostStatusReport`, which answers the same socket.
 */
export interface DaemonStatusReport {
  instance_id: string;
  pid: number;
  data_dir: string;
  version: string;
  started_at: string;
  /** The URL to hand a client: the Core surface, including its secret path. */
  endpoint: string;
  urls: Record<ControlSurfaceId, string>;
  kind: 'daemon';
  /**
   * Whether this daemon is publishing a transport, and what the transport itself reports.
   *
   * Part of the status rather than a separate verb because it is the same question a caller is
   * already asking: `endpoint` alone is a loopback URL and says nothing about whether a client
   * outside this machine can use it. `publicUrl` is the transport's own address when it has one,
   * and null when it does not — which is the honest answer for a daemon with no tunnel configured.
   *
   * What it describes is the *process*: whether one is running, what it last reported, and when it
   * last proved a round trip. It is deliberately not a claim about reachability from anywhere in
   * particular, which this host cannot observe.
   *
   * Optional when read: a peer built before this field existed answers without it, and "the
   * daemon did not say" must not be mistaken for "the daemon published a tunnel".
   */
  tunnel?: {
    state: 'off' | 'starting' | 'connected' | 'unavailable';
    detail: string;
    publicUrl: string | null;
    handshakeAt: number | null;
  };
  /**
   * Whether this daemon also serves the browser transport.
   *
   * A launch property, not a setting: it is decided when the process starts, and it is exactly
   * what a caller cannot infer from anything else here — an idempotent `start --browser` against a
   * daemon that was launched without it returns this daemon unchanged, and without this block that
   * answer would be indistinguishable from a browser-enabled one. `extensionDir` is the seeded
   * folder the user has to load in their browser, which is the whole next step once it is on.
   *
   * Optional for the same reason as `tunnel`: an older peer does not answer it.
   */
  browser?: { enabled: boolean; extensionDir: string | null };
}

/** What `daemon.stop` answers before the socket closes. */
export interface DaemonStopReceipt {
  stopping: true;
  instance_id: string;
}

/**
 * The daemon verbs, supplied only by a host that really is a daemon.
 *
 * Optional as a whole rather than three nullable callbacks: a host either has an instance to
 * report, configure and stop or it does not, and splitting that into independent seams is how
 * one of them would eventually be wired without the others.
 *
 * `config` is asynchronous on purpose. It mutates the same `config.json` the desktop UI writes
 * through, so the change has to travel through that store's own serialized transaction and be on
 * disk before the receipt is answered — a synchronous write here would be a second, unserialized
 * writer over shared settings.
 */
export interface DaemonControlPort {
  status(): DaemonStatusReport;
  /** Reads or changes this daemon's own approved folders, read-only mode and tool permissions. */
  config(request: DaemonConfigRequest): Promise<DaemonConfigReport>;
  /** Reports presence of, and stores or clears, the credentials this host may hold. */
  secret(request: DaemonSecretRequest): Promise<DaemonSecretReport>;
  /** Returns the receipt the caller is answered with; the stop itself follows the reply. */
  stop(): Promise<DaemonStopReceipt>;
}

/** Where a request is refused before the WorkService is ever reached. */
export type ControlErrorCode =
  | 'HELLO_REQUIRED'
  | 'PROTOCOL_MISMATCH'
  | 'INSTALLATION_MISMATCH'
  | 'TOKEN_MISMATCH'
  | 'UNKNOWN_METHOD'
  | 'INVALID_PARAMS'
  | 'REQUEST_TOO_LARGE'
  | 'REPLY_TOO_LARGE'
  | 'TOO_MANY_CLIENTS'
  | 'HOST_UNAVAILABLE'
  | 'INTERNAL';

export interface ControlError {
  code: ControlErrorCode | string;
  message: string;
}

/** Executes one already-authenticated control method. Supplied by the runtime host. */
export type ControlDispatch = (method: ControlMethod, params: unknown) => Promise<unknown>;

/**
 * The descriptor a host publishes at `<dataDir>/runtime.json`.
 *
 * The first four fields are the original desktop contract and stay exactly as they were: a
 * descriptor written by an older build still reads, and every existing client keeps working.
 *
 * The rest exist because a *daemon* publishes the same file into the same kind of directory, and
 * a reader has to be able to tell the two apart without guessing. Every added field is optional,
 * which is what makes the extension additive rather than a second format:
 *
 *  - `kind` is the discriminator. Absent means `desktop`, because that is what every descriptor
 *    written before this field existed belonged to — treating an unlabelled file as a daemon
 *    would make an installed app's directory look claimable by a daemon.
 *  - `instance_id` is the daemon's per-process identity. It is what lets `stop` prove that the
 *    socket it reached is the instance the file names rather than a successor that replaced it.
 *  - `control_token` is the daemon's control-socket secret. The desktop host has none: its
 *    endpoint is already a 0600 socket in a 0700 directory, and its clients are the same user's
 *    own commands. A daemon holds one because it can outlive the terminal that started it and be
 *    reached from a different one, so the handshake carries a value only its own descriptor names.
 *  - `data_dir`, `started_at`, `version` and `mcp` are what `status` reports, published next to
 *    the socket so a client can show them without a second protocol.
 */
export const runtimeDescriptorSchema = z
  .object({
    socket_path: z.string().min(1).max(4096),
    pid: z.number().int().positive(),
    installation_id: z.string().min(1).max(200),
    protocol_version: z.number().int().positive(),
    kind: z.enum(['desktop', 'daemon']).optional(),
    instance_id: z.string().min(1).max(200).optional(),
    control_token: z.string().min(1).max(200).optional(),
    data_dir: z.string().min(1).max(4096).optional(),
    started_at: z.string().min(1).max(200).optional(),
    version: z.string().min(1).max(200).optional(),
    mcp: z.record(z.string().min(1).max(64), z.string().min(1).max(4096)).optional()
  })
  .strict();
export type RuntimeDescriptor = z.infer<typeof runtimeDescriptorSchema>;

/**
 * What `host.status` reports. The CLI prints this; nothing in it is a secret, and it is
 * deliberately the *factual* local state (is the socket up, which process owns it) rather
 * than a claim about the browser or the provider, which this socket cannot see.
 */
export interface HostStatusReport {
  pid: number;
  installation_id: string;
  protocol_version: number;
  data_dir: string;
  version: string;
  started_at: string;
}

export function runtimeFilePath(dataDir: string): string {
  return identityRuntimeFilePath(dataDir);
}

function currentUid(): number | null {
  return typeof process.getuid === 'function' ? process.getuid() : null;
}

export class ControlSocketError extends Error {
  constructor(
    message: string,
    readonly code: ControlErrorCode | string
  ) {
    super(message);
    this.name = 'ControlSocketError';
  }
}

/**
 * The host could not be reached at all: no descriptor, a dead socket, a failed handshake.
 *
 * The default code is `HOST_UNAVAILABLE` rather than a generic internal error because that
 * is what the caller has to act on: nothing about this condition is a bug in the command,
 * and a script branches on exactly this case (exit code 3, then try `host start`). Reporting
 * `INTERNAL` for a refused connection would send a reader hunting a defect that is not there.
 */
export class ControlUnavailableError extends ControlSocketError {
  constructor(message: string, code: ControlErrorCode | string = 'HOST_UNAVAILABLE') {
    super(message, code);
    this.name = 'ControlUnavailableError';
  }
}

/** The host answered and refused the operation. The WorkService's own code is preserved. */
export class ControlRejectedError extends ControlSocketError {
  constructor(message: string, code: string) {
    super(message, code);
    this.name = 'ControlRejectedError';
  }
}

// ---------------------------------------------------------------------------------------
// Filesystem validation
// ---------------------------------------------------------------------------------------

/**
 * The half of validation that is true on every platform: the entry exists, is not a symlink or
 * junction, and is the kind of thing the caller expects.
 *
 * `lstat` rather than `stat`: the point of the check is to refuse a *symlink* that points
 * somewhere else entirely, and following it first would defeat exactly that.
 */
async function assertPlainEntry(
  target: string,
  label: string,
  kind: 'file' | 'directory' | 'socket'
): Promise<Stats> {
  const info = await fs.lstat(target).catch((error: unknown) => {
    throw new ControlUnavailableError(`${label} is unreadable: ${errorText(error)}`);
  });
  if (info.isSymbolicLink()) throw new ControlUnavailableError(`${label} is a symlink; refusing to follow it`);
  const matches =
    kind === 'file' ? info.isFile() : kind === 'directory' ? info.isDirectory() : info.isSocket();
  if (!matches) throw new ControlUnavailableError(`${label} is not a ${kind}`);
  return info;
}

/**
 * The POSIX half: owned by this user, with no group/other bits at all.
 *
 * Group/other bits must be clear, not merely "not world-writable" — a group-readable socket
 * directory on a shared machine is a live control channel for anyone in that group.
 */
function assertPrivateOwner(info: Stats, label: string, expected: string): void {
  const uid = currentUid();
  if (uid !== null && info.uid !== uid) {
    throw new ControlUnavailableError(`${label} is owned by uid ${info.uid}, not ${uid}`);
  }
  if ((info.mode & 0o077) !== 0) {
    throw new ControlUnavailableError(`${label} is not private (mode ${modeText(info.mode)}); expected ${expected}`);
  }
}

/** A private directory must be owned by this user and closed to everyone else. */
async function assertPrivateDir(target: string, label: string): Promise<void> {
  assertPrivateOwner(await assertPlainEntry(target, label, 'directory'), label, '0700');
}

/**
 * A private file must be a regular file, owned by this user, at exactly mode 0600.
 *
 * The mode half is POSIX-only. Windows reports synthetic values there — mode `0o666` for every
 * regular file, uid/gid `0` — so a `mode & 0o077` test that is a real permission check on
 * POSIX would reject this app's own `runtime.json` and leave the CLI unable to find its host.
 * The structural half still runs everywhere, because a reparse point (symlink or junction) is
 * exactly how another process substitutes a different file, and there the descriptor's access
 * control comes from the data directory's inherited ACL rather than from bits Node exposes.
 */
async function assertPrivateFile(target: string, label: string, platform: NodeJS.Platform): Promise<void> {
  const info = await assertPlainEntry(target, label, 'file');
  if (platform === 'win32') return;
  assertPrivateOwner(info, label, '0600');
  if ((info.mode & 0o777) !== 0o600) {
    throw new ControlUnavailableError(`${label} has mode ${modeText(info.mode)}; expected 0600`);
  }
}

/** The socket itself must be a socket, owned by this user, mode 0600, and not a symlink. */
async function assertPrivateSocket(target: string): Promise<void> {
  await assertPrivateDir(path.dirname(target), 'the control socket directory');
  assertPrivateOwner(await assertPlainEntry(target, 'control socket', 'socket'), 'control socket', '0600');
}

function modeText(mode: number): string {
  return `0${(mode & 0o777).toString(8).padStart(3, '0')}`;
}

function errorText(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

// ---------------------------------------------------------------------------------------
// runtime.json
// ---------------------------------------------------------------------------------------

/**
 * Reads the descriptor a running host published, validating every property the CLI relies
 * on. A missing file is *not* an error here: it is the normal answer to "no host is
 * running", and the caller decides what that means.
 */
export async function readRuntimeDescriptor(
  dataDir: string,
  platform: NodeJS.Platform = process.platform
): Promise<RuntimeDescriptor | null> {
  const file = runtimeFilePath(dataDir);
  const info = await fs.lstat(file).catch(() => null);
  if (!info) return null;
  await assertPrivateFile(file, 'runtime.json', platform);
  const raw = await fs.readFile(file, 'utf8');
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    throw new ControlUnavailableError('runtime.json is not valid JSON');
  }
  const result = runtimeDescriptorSchema.safeParse(parsed);
  if (!result.success) throw new ControlUnavailableError('runtime.json does not describe a control socket');
  return result.data;
}

/**
 * Publishes the descriptor atomically at mode 0600.
 *
 * Written through the identity module's temp-then-rename helper, so a CLI that reads the
 * file during startup can only ever see the previous descriptor or the new one — never a
 * half-written line, which would look like a corrupt install rather than a race. It also
 * means the directory and file modes are decided in exactly one place.
 *
 * The file itself is always a real file in the data directory, on every platform — only the
 * *endpoint* differs. What protects it is the data directory: mode 0700 plus the file's own
 * 0600 on POSIX, and the directory's inherited ACL on Windows, where Node exposes no real mode
 * bits to set or check.
 */
export async function writeRuntimeDescriptor(dataDir: string, descriptor: RuntimeDescriptor): Promise<void> {
  const parsed = runtimeDescriptorSchema.parse(descriptor);
  writePrivateFile(identityRuntimeFilePath(dataDir), `${JSON.stringify(parsed)}\n`);
}

/**
 * Removes the descriptor, but only if it still describes `socketPath`.
 *
 * The guard matters on a clean shutdown that races a *new* host's startup: an unconditional
 * unlink would delete the live host's descriptor and make the socket undiscoverable.
 */
export async function removeRuntimeDescriptor(
  dataDir: string,
  socketPath: string,
  platform: NodeJS.Platform = process.platform
): Promise<void> {
  const file = runtimeFilePath(dataDir);
  const existing = await readRuntimeDescriptor(dataDir, platform).catch(() => null);
  if (!existing || existing.socket_path !== socketPath) return;
  await fs.rm(file, { force: true });
}

/**
 * Drops a descriptor whose owning process is gone. Reconciliation belongs to the host's
 * single-instance startup path; this is the primitive it uses.
 *
 * `process.kill(pid, 0)` is the probe: signal 0 performs the permission and existence
 * checks without delivering anything. Only ESRCH proves the pid is gone. EPERM proves a live
 * process exists but cannot be inspected, and every other error is likewise insufficient proof.
 */
export async function removeStaleRuntimeDescriptor(dataDir: string): Promise<boolean> {
  const existing = await readRuntimeDescriptor(dataDir).catch(() => null);
  if (!existing) return false;
  if (existing.pid === process.pid) return false;
  try {
    process.kill(existing.pid, 0);
    return false;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ESRCH') return false;
    await fs.rm(runtimeFilePath(dataDir), { force: true }).catch(() => undefined);
    return true;
  }
}

// ---------------------------------------------------------------------------------------
// Socket path selection
// ---------------------------------------------------------------------------------------

/**
 * The endpoint a host should listen on, chosen per platform.
 *
 * POSIX gets a private 0700 directory holding a randomly named socket, chosen so the whole
 * UTF-8 path stays under the platform's `sun_path` limit. `os.tmpdir()` on macOS is already a
 * per-user 0700 directory under `/var/folders`, so it is tried first; a short
 * `/tmp/wgpt-<uid>-<random>` directory is the fallback for the cases where it is long (or on
 * Linux, shared). Both are created fresh with 0700, and a fresh directory per host means a
 * crashed predecessor's socket file is never reused.
 *
 * Windows gets a named pipe, because that is the only thing `server.listen()` accepts there:
 * an ordinary temporary path is not IPC, and passing one is how the host fails to start at
 * all. Nothing is created on disk, so the randomness has to live in the name itself — hence
 * the 96 random bits — and the access control is the creating token's default DACL rather
 * than a directory mode.
 */
export async function allocateControlEndpoint(platform: NodeJS.Platform = process.platform): Promise<string> {
  if (controlTransportKind(platform) === 'pipe') return randomPipeName();

  const uid = currentUid() ?? 0;
  const bases = [os.tmpdir(), '/tmp'];
  const seen = new Set<string>();
  let last = '';
  for (const base of bases) {
    const directory = path.join(base, `wgpt-${uid}-${randomBytes(6).toString('hex')}`);
    if (seen.has(directory)) continue;
    seen.add(directory);
    const socket = path.join(directory, 's');
    last = socket;
    if (Buffer.byteLength(socket, 'utf8') >= MAX_SOCKET_PATH_BYTES) continue;
    await fs.mkdir(directory, { mode: 0o700, recursive: true });
    await fs.chmod(directory, 0o700);
    return socket;
  }
  throw new ControlSocketError(
    `no private temporary directory can hold a control socket under ${MAX_SOCKET_PATH_BYTES} bytes (tried ${last})`,
    'INTERNAL'
  );
}

/**
 * Removes the POSIX socket *file* and its private directory. A named pipe is a kernel object
 * with no filesystem entry: it disappears when the last handle closes, and `fs.rm` on a pipe
 * name would just fail. Returning early is what keeps a Windows close from reporting an error
 * for the transport's ordinary teardown.
 */
async function removeEndpointFile(endpoint: string, platform: NodeJS.Platform): Promise<void> {
  if (controlTransportKind(platform) === 'pipe') return;
  await fs.rm(endpoint, { force: true }).catch(() => undefined);
  await fs.rmdir(path.dirname(endpoint)).catch(() => undefined);
}

// ---------------------------------------------------------------------------------------
// Line framing
// ---------------------------------------------------------------------------------------

/**
 * Incremental newline-delimited JSON reader with a hard per-line bound.
 *
 * `onLine` returning false stops the connection. Exceeding the bound reports a code and
 * stops too: the remaining bytes of an oversized line are not JSON, so continuing would
 * mean parsing attacker-chosen fragments.
 */
export function createLineReader(options: {
  maxBytes: number;
  onLine: (line: string) => void | Promise<void>;
  onOverflow: () => void;
}): (chunk: Buffer) => void {
  let pending: Buffer<ArrayBufferLike> = Buffer.alloc(0);
  let stopped = false;
  return (chunk: Buffer) => {
    if (stopped) return;
    pending = pending.length === 0 ? chunk : Buffer.concat([pending, chunk]);
    for (;;) {
      const newline = pending.indexOf(0x0a);
      if (newline === -1) {
        if (pending.length > options.maxBytes) {
          stopped = true;
          options.onOverflow();
        }
        return;
      }
      const line = pending.subarray(0, newline).toString('utf8');
      pending = pending.subarray(newline + 1);
      if (Buffer.byteLength(line, 'utf8') > options.maxBytes) {
        stopped = true;
        options.onOverflow();
        return;
      }
      if (line.trim().length === 0) continue;
      options.onLine(line);
    }
  };
}

/**
 * The handshake, with the daemon's control token as an optional part of it.
 *
 * `token` is absent for every desktop host, and absent *by construction*: those hosts publish no
 * `control_token` in their descriptor, so a client has nothing to send and this field never
 * appears. When a descriptor does carry one, the hello must present exactly it — which is what
 * makes the daemon's socket reachable only through the file its owner already reads at 0600,
 * rather than by any process that guesses the randomly named endpoint.
 */
interface HelloMessage {
  type: 'hello';
  installation_id: string;
  protocol_version: number;
  token?: string;
}

function parseHello(value: unknown): HelloMessage | null {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return null;
  const record = value as Record<string, unknown>;
  if (record.type !== 'hello') return null;
  if (typeof record.installation_id !== 'string' || record.installation_id.length === 0) return null;
  if (typeof record.protocol_version !== 'number' || !Number.isInteger(record.protocol_version)) return null;
  const token = record.token;
  if (token !== undefined && (typeof token !== 'string' || token.length === 0)) return null;
  return {
    type: 'hello',
    installation_id: record.installation_id,
    protocol_version: record.protocol_version,
    ...(token === undefined ? {} : { token })
  };
}

/**
 * Constant-time comparison of two handshake secrets.
 *
 * Length is compared first and separately because `timingSafeEqual` throws on unequal buffers,
 * and a length check that short-circuits is itself the one difference in length that is already
 * observable from the frame.
 */
function completeGuiTransfer(parts: readonly string[]): boolean {
  for (let index = 0; index < parts.length; index += 1) if (typeof parts[index] !== 'string') return false;
  return true;
}

function encodeGuiPayload(value: unknown): string {
  return JSON.stringify(value, (_key, candidate: unknown) => candidate instanceof Uint8Array
    ? { _wgpt_bytes: Buffer.from(candidate).toString('base64') }
    : candidate);
}

function decodeGuiPayload(value: string): unknown {
  return JSON.parse(value, (_key, candidate: unknown) => {
    if (typeof candidate !== 'object' || candidate === null || Array.isArray(candidate) ||
        !('_wgpt_bytes' in candidate) || Object.keys(candidate).length !== 1 || typeof candidate._wgpt_bytes !== 'string') {
      return candidate;
    }
    return new Uint8Array(Buffer.from(candidate._wgpt_bytes, 'base64'));
  });
}

function sameToken(a: string, b: string): boolean {
  const left = Buffer.from(a, 'utf8');
  const right = Buffer.from(b, 'utf8');
  if (left.length !== right.length) return false;
  return timingSafeEqual(left, right);
}

function writeGuiEvent(socket: net.Socket, channel: string, args: unknown[]): void {
  const encoded = encodeGuiPayload({ channel, args });
  const bytes = Buffer.from(encoded, 'utf8');
  const inlineEvent = { type: 'gui.event', json: encoded };
  if (Buffer.byteLength(`${JSON.stringify(inlineEvent)}\n`, 'utf8') <= MAX_REPLY_BYTES) {
    writeLine(socket, inlineEvent);
    return;
  }
  const id = randomBytes(16).toString('hex');
  const total = Math.ceil(bytes.length / GUI_REPLY_CHUNK_BYTES);
  for (let offset = 0, part = 0; offset < bytes.length; offset += GUI_REPLY_CHUNK_BYTES, part += 1) {
    writeLine(socket, { type: 'gui.event.chunk', id, part, total, data: bytes.subarray(offset, offset + GUI_REPLY_CHUNK_BYTES).toString('base64') });
  }
}

function writeLine(socket: net.Socket, value: unknown): void {
  if (socket.destroyed) return;
  const line = `${JSON.stringify(value)}\n`;
  if (Buffer.byteLength(line, 'utf8') > MAX_REPLY_BYTES) {
    socket.end(`${JSON.stringify({ error: { code: 'REPLY_TOO_LARGE', message: 'reply exceeded the control protocol limit' } })}\n`);
    return;
  }
  socket.write(line);
}

// ---------------------------------------------------------------------------------------
// Host side
// ---------------------------------------------------------------------------------------

export interface ControlSocketHandle {
  /** The endpoint clients connect to: a Unix socket path, or a Windows named pipe name. */
  socketPath: string;
  /** Which transport `socketPath` is, so a caller never has to re-derive it. */
  transport: ControlTransportKind;
  runtimeFile: string;
  /** Live client count, for tests and diagnostics. */
  clients(): number;
  /** Stops accepting, drops clients, unlinks the socket and withdraws the descriptor. */
  close(): Promise<void>;
}

export interface GuiControlPort {
  /** Executes a fixed renderer IPC channel on the persistent desktop host. */
  invoke(channel: string, payload: unknown, rendererId: string | null): Promise<unknown>;
  /** Adds one GUI event consumer and returns its exact teardown. */
  subscribe(listener: (channel: string, args: unknown[]) => void, rendererId: string | null, connectionOrder: number): () => void;
  /** Updates presentation presence without granting any storage authority to the GUI. */
  presence?(visible: boolean, connectionOrder: number): void;
}

export interface StartControlSocketOptions {
  dataDir: string;
  installationId: string;
  dispatch: ControlDispatch;
  /** Desktop GUI RPC surface. Omitted for CLI-only/legacy hosts. */
  gui?: GuiControlPort;
  /** Private descriptor-backed credential for a GUI client. */
  authToken?: string;
  /** Test seam; production always allocates a fresh private endpoint. */
  socketPath?: string;
  /**
   * Test seam: which platform's transport and validation to use. `dataDir` stays a host
   * filesystem path either way — it is where the descriptor is published, not part of the
   * transport — so a POSIX host can exercise the Windows branch without a Windows filesystem.
   */
  platform?: NodeJS.Platform;
  /**
   * Test seam: how the Windows pipe is narrowed to this user before publication. Production
   * runs the app-owned PowerShell/C# program in `windows-pipe-acl.ts`.
   */
  restrictPipe?: (pipeName: string) => Promise<string>;
  pid?: number;
  /**
   * Present only for a standalone daemon. Installing it does two things that are deliberately one
   * decision rather than two: every connection must then present `token`, and the two `daemon.*`
   * methods become answerable. A desktop host installs neither and is unaffected.
   */
  daemon?: {
    token: string;
    port: DaemonControlPort;
    /** Published into `runtime.json` so a client can show them without a second protocol. */
    descriptor: Pick<RuntimeDescriptor, 'instance_id' | 'data_dir' | 'started_at' | 'version' | 'mcp'>;
  };
  /**
   * Runs after the reply to `daemon.stop` has been flushed. The socket deliberately does not tear
   * itself down here: the caller is owed an answer before its peer disappears, so the stop is
   * handed to the process that owns this socket and the transport closes on its own way out.
   */
  onStopRequested?: () => void;
  /** Runs after the reply to an explicit authenticated `host.stop` has flushed. */
  onHostStopRequested?: () => void;
}

/**
 * Starts the host's control socket and publishes it.
 *
 * Ordering is deliberate: the socket is listening *before* the descriptor is written, so a
 * CLI that sees `runtime.json` can always connect to it. The reverse order would advertise
 * a socket that does not exist yet, which reads as a crashed host.
 *
 * The transport is the platform's own. On Windows the endpoint is a named pipe and none of
 * the POSIX filesystem steps apply: there is no directory to create, no socket file to chmod
 * to 0600, and no file to unlink at close. Running the POSIX sequence there is what made this
 * a startup blocker rather than a missing feature — `server.listen()` rejects an ordinary
 * path before the window is ever created.
 */
export async function startControlSocket(options: StartControlSocketOptions): Promise<ControlSocketHandle> {
  const dataDir = options.dataDir;
  if (!path.isAbsolute(dataDir)) {
    throw new ControlSocketError('control socket requires an absolute data directory', 'INTERNAL');
  }
  const platform = options.platform ?? process.platform;
  const transport = controlTransportKind(platform);
  await fs.mkdir(dataDir, { recursive: true, mode: 0o700 });
  const socketPath = options.socketPath ?? (await allocateControlEndpoint(platform));
  // The endpoint's *shape* is checked before anything listens on it. The endpoint does not
  // exist yet, so this cannot be the client's full check — but a relative POSIX path or a
  // non-pipe Windows string must never reach `listen()`, where the failure is a stray socket
  // file in the current directory or a listener that cannot start at all.
  const endpointProblem =
    transport === 'pipe' ? pipeNameProblem(socketPath) : unixSocketPathProblem(socketPath);
  if (endpointProblem) throw new ControlSocketError(endpointProblem, 'INTERNAL');
  const pid = options.pid ?? process.pid;
  const sockets = new Set<net.Socket>();
  let connectionOrder = 0;
  /**
   * Whether the endpoint's access control is in force. False only while a Windows pipe is
   * still carrying the default descriptor; see the connection handler below.
   */
  let restricted = transport === 'unix';

  const server = net.createServer((socket) => {
    const order = ++connectionOrder;
    /**
     * Until the Windows pipe has been narrowed to this user, no connection is read at all.
     *
     * The default descriptor a Windows named pipe starts with grants read access to Everyone
     * and the anonymous account (see `windows-pipe-acl.ts`), so anything that can reach the
     * name could otherwise begin a `hello` — or simply sit there — during the moment between
     * `listen()` and the ACL taking effect. Those connections are tracked and destroyed once
     * the descriptor is verified, and never reach the protocol. On POSIX this flag is true
     * from the start: the socket's own 0600 mode is already in force when it starts listening.
     */
    if (!restricted) {
      // Bounded even here: an unauthenticated peer must not be able to grow the host's fd
      // use without limit during the moment before the ACL is in force.
      if (sockets.size >= MAX_CLIENTS) {
        socket.destroy();
        return;
      }
      sockets.add(socket);
      socket.on('error', () => socket.destroy());
      socket.on('close', () => sockets.delete(socket));
      return;
    }
    if (sockets.size >= MAX_CLIENTS) {
      writeLine(socket, { error: { code: 'TOO_MANY_CLIENTS', message: 'too many control clients' } });
      socket.end();
      return;
    }
    sockets.add(socket);
    socket.setNoDelay(true);

    let greeted = false;
    let guiUnsubscribe: (() => void) | null = null;
    const inboundGuiTransfers = new Map<string, string[]>();
    const outboundGuiTransfers = new Map<string, string[]>();
    /**
     * Requests are handled one at a time, in arrival order. Two lines can arrive in a single
     * TCP read, and dispatching them concurrently would let a later `work.status` answer
     * before the `work.start` it was asked about — legal for a client keyed by id, but a
     * confusing thing to debug. A chain makes the wire order the execution order.
     */
    let chain: Promise<void> = Promise.resolve();
    const read = createLineReader({
      maxBytes: MAX_REQUEST_BYTES,
      onOverflow: () => {
        writeLine(socket, { error: { code: 'REQUEST_TOO_LARGE', message: 'request line exceeded the control protocol limit' } });
        socket.end();
      },
      onLine: (line) => {
        chain = chain.then(() => handleLine(line)).catch(() => undefined);
      }
    });

    const handleLine = async (line: string): Promise<void> => {
      let parsed: unknown;
      try {
        parsed = JSON.parse(line);
      } catch {
        writeLine(socket, { error: { code: 'INVALID_PARAMS', message: 'request line is not valid JSON' } });
        return;
      }
      if (!greeted) {
        const hello = parseHello(parsed);
        if (!hello) {
          writeLine(socket, { error: { code: 'HELLO_REQUIRED', message: 'the first message must be a hello' } });
          socket.end();
          return;
        }
        if (hello.protocol_version !== CONTROL_PROTOCOL_VERSION) {
          writeLine(socket, {
            error: {
              code: 'PROTOCOL_MISMATCH',
              message: `control protocol ${hello.protocol_version} is not ${CONTROL_PROTOCOL_VERSION}`
            }
          });
          socket.end();
          return;
        }
        if (hello.installation_id !== options.installationId) {
          writeLine(socket, { error: { code: 'INSTALLATION_MISMATCH', message: 'hello names a different installation' } });
          socket.end();
          return;
        }
        // A host with no daemon port accepts a hello with no token, exactly as before. One with a
        // daemon port accepts *only* the token it minted, and refuses a missing one identically to
        // a wrong one: telling a caller which half it got wrong is free information for the wrong
        // caller and no help to the right one, which already holds the descriptor.
        const expected = options.daemon?.token ?? options.authToken;
        if (expected !== undefined && (hello.token === undefined || !sameToken(hello.token, expected))) {
          writeLine(socket, { error: { code: 'TOKEN_MISMATCH', message: 'hello did not present this host’s control token' } });
          socket.end();
          return;
        }
        greeted = true;
        writeLine(socket, { type: 'ready', protocol_version: CONTROL_PROTOCOL_VERSION });
        return;
      }

      const request = parsed as { id?: unknown; method?: unknown; params?: unknown };
      const id = typeof request?.id === 'string' || typeof request?.id === 'number' ? request.id : null;
      if (id === null) {
        writeLine(socket, { error: { code: 'INVALID_PARAMS', message: 'request must carry a string or number id' } });
        return;
      }
      const method = request.method;
      if (typeof method !== 'string' || !(CONTROL_METHODS as readonly string[]).includes(method)) {
        writeLine(socket, { id, error: { code: 'UNKNOWN_METHOD', message: `unknown control method: ${String(method)}` } });
        return;
      }
      if (method === 'host.stop') {
        if (!options.onHostStopRequested) {
          writeLine(socket, { id, error: { code: 'HOST_UNAVAILABLE', message: 'this host cannot be stopped through the control socket.' } });
          return;
        }
        writeLine(socket, { id, result: { stopping: true } });
        let requested = false;
        const requestStop = (): void => {
          if (requested) return;
          requested = true;
          options.onHostStopRequested?.();
        };
        socket.once('drain', requestStop);
        setTimeout(requestStop, 0).unref?.();
        return;
      }
      // The daemon's own verbs are answered by the transport host, before the WorkService is
      // consulted at all: a host with no daemon behind it refuses them truthfully rather than
      // forwarding a verb it cannot mean. `stop` is answered *and then* handed on, so the caller
      // always receives its receipt from a peer that was still listening.
      if (method === 'daemon.status' || method === 'daemon.config' || method === 'daemon.secret' || method === 'daemon.stop') {
        const port = options.daemon?.port;
        if (!port) {
          writeLine(socket, {
            id,
            error: {
              code: 'HOST_UNAVAILABLE',
              message: 'this host is not a standalone daemon, so it has no daemon status, configuration, credentials or lifetime to report.'
            }
          });
          return;
        }
        try {
          if (method === 'daemon.status') {
            writeLine(socket, { id, result: port.status() });
            return;
          }
          if (method === 'daemon.config') {
            // Parsed here rather than inside the port so a malformed request is refused as
            // INVALID_PARAMS before it can reach the settings store, exactly like every other
            // control method.
            writeLine(socket, { id, result: await port.config(daemonConfigRequestSchema.parse(request.params ?? {})) });
            return;
          }
          if (method === 'daemon.secret') {
            writeLine(socket, { id, result: await port.secret(daemonSecretRequestSchema.parse(request.params ?? {})) });
            return;
          }
          const receipt = await port.stop();
          writeLine(socket, { id, result: receipt });
          // Only once the answer is out of this process: a caller that asked a daemon to stop is
          // owed the receipt before the socket it is reading from goes away.
          socket.once('drain', () => options.onStopRequested?.());
          setTimeout(() => options.onStopRequested?.(), 0).unref?.();
        } catch (error) {
          writeLine(socket, { id, error: describeDispatchFailure(error) });
        }
        return;
      }
      if (method === 'gui.invoke' || method === 'gui.subscribe' || method === 'gui.presence' || method === 'gui.stage' || method === 'gui.take') {
        const port = options.gui;
        if (!port) {
          writeLine(socket, { id, error: { code: 'HOST_UNAVAILABLE', message: 'this host does not expose the desktop GUI RPC surface.' } });
          return;
        }
        try {
          if (method === 'gui.subscribe') {
            const params = request.params;
            const rendererId = typeof params === 'object' && params !== null && 'rendererId' in params
              && typeof params.rendererId === 'string' && params.rendererId.length <= 128 ? params.rendererId : null;
            guiUnsubscribe?.();
            guiUnsubscribe = port.subscribe((channel, args) => writeGuiEvent(socket, channel, args), rendererId, order);
            writeLine(socket, { id, result: true });
            return;
          }
          if (method === 'gui.presence') {
            const params = request.params;
            if (typeof params !== 'object' || params === null || Array.isArray(params) || !('visible' in params) || typeof params.visible !== 'boolean') {
              throw new ControlRejectedError('GUI presence must name visibility', 'INVALID_PARAMS');
            }
            port.presence?.(params.visible, order);
            writeLine(socket, { id, result: true });
            return;
          }
          const params = request.params;
          if (typeof params !== 'object' || params === null || Array.isArray(params)) throw new ControlRejectedError('GUI request must be an object', 'INVALID_PARAMS');
          const entry = params as Record<string, unknown>;
          if (method === 'gui.stage') {
            if (typeof entry.id !== 'string' || typeof entry.part !== 'number' || typeof entry.total !== 'number' || typeof entry.data !== 'string' ||
                !Number.isInteger(entry.part) || !Number.isInteger(entry.total) || entry.total < 1 || entry.total > MAX_GUI_TRANSFER_PARTS ||
                entry.part < 0 || entry.part >= entry.total || Buffer.byteLength(entry.data, 'utf8') > MAX_REQUEST_BYTES - 1024) {
              throw new ControlRejectedError('Invalid GUI transfer chunk', 'INVALID_PARAMS');
            }
            const parts = inboundGuiTransfers.get(entry.id) ?? Array<string>(entry.total);
            if (parts.length !== entry.total) throw new ControlRejectedError('GUI transfer id was reused with a different size', 'INVALID_PARAMS');
            parts[entry.part] = entry.data;
            inboundGuiTransfers.set(entry.id, parts);
            writeLine(socket, { id, result: { complete: completeGuiTransfer(parts) } });
            return;
          }
          if (method === 'gui.take') {
            if (typeof entry.id !== 'string' || typeof entry.part !== 'number' || !Number.isInteger(entry.part)) throw new ControlRejectedError('Invalid GUI transfer read', 'INVALID_PARAMS');
            const parts = outboundGuiTransfers.get(entry.id);
            if (!parts || entry.part < 0 || entry.part >= parts.length) throw new ControlRejectedError('GUI transfer is unavailable', 'INVALID_PARAMS');
            const data = parts[entry.part]!;
            if (entry.part + 1 === parts.length) outboundGuiTransfers.delete(entry.id);
            writeLine(socket, { id, result: { data } });
            return;
          }
          if (typeof entry.channel !== 'string' || entry.channel.length < 1 || entry.channel.length > 128) {
            throw new ControlRejectedError('GUI request must name one registered channel', 'INVALID_PARAMS');
          }
          let encoded: string;
          if (typeof entry.json === 'string') encoded = entry.json;
          else if (typeof entry.stage === 'string') {
            const parts = inboundGuiTransfers.get(entry.stage);
            if (!parts || !completeGuiTransfer(parts)) throw new ControlRejectedError('GUI transfer is incomplete', 'INVALID_PARAMS');
            inboundGuiTransfers.delete(entry.stage);
            encoded = Buffer.concat(parts.map(part => Buffer.from(part, 'base64'))).toString('utf8');
          } else throw new ControlRejectedError('GUI request must include an encoded payload', 'INVALID_PARAMS');
          if (Buffer.byteLength(encoded, 'utf8') > MAX_GUI_TRANSFER_BYTES) throw new ControlRejectedError('GUI payload exceeds its 384 MiB limit', 'INVALID_PARAMS');
          const rendererId = typeof entry.rendererId === 'string' && entry.rendererId.length <= 128 ? entry.rendererId : null;
          const reply = encodeGuiPayload(await port.invoke(entry.channel, decodeGuiPayload(encoded), rendererId));
          const inlineReply = { id, result: { json: reply } };
          if (Buffer.byteLength(`${JSON.stringify(inlineReply)}\n`, 'utf8') <= MAX_REPLY_BYTES) {
            writeLine(socket, inlineReply);
            return;
          }
          if (Buffer.byteLength(reply, 'utf8') > MAX_GUI_TRANSFER_BYTES) throw new ControlRejectedError('GUI reply exceeds its 384 MiB limit', 'INTERNAL');
          const transferId = randomBytes(16).toString('hex');
          const parts: string[] = [];
          const bytes = Buffer.from(reply, 'utf8');
          for (let offset = 0; offset < bytes.length; offset += GUI_REPLY_CHUNK_BYTES) {
            parts.push(bytes.subarray(offset, offset + GUI_REPLY_CHUNK_BYTES).toString('base64'));
          }
          outboundGuiTransfers.set(transferId, parts);
          writeLine(socket, { id, result: { stage: transferId, total: parts.length } });
        } catch (error) {
          writeLine(socket, { id, error: describeDispatchFailure(error) });
        }
        return;
      }
      try {
        const result = await options.dispatch(method as ControlMethod, request.params ?? {});
        writeLine(socket, { id, result });
      } catch (error) {
        writeLine(socket, { id, error: describeDispatchFailure(error) });
      }
    };

    socket.on('data', read);
    socket.on('error', () => socket.destroy());
    socket.on('close', () => {
      guiUnsubscribe?.();
      guiUnsubscribe = null;
      sockets.delete(socket);
    });
  });

  await new Promise<void>((resolve, reject) => {
    const onError = (error: Error): void => {
      server.off('listening', onListening);
      reject(new ControlSocketError(`control socket could not listen: ${error.message}`, 'INTERNAL'));
    };
    const onListening = (): void => {
      server.off('error', onError);
      resolve();
    };
    server.once('error', onError);
    server.once('listening', onListening);
    server.listen(socketPath);
  });
  // A Unix socket's mode is a real access control, so it is set explicitly rather than left to
  // the umask. A Windows named pipe has no mode to set: Node creates it with the default
  // descriptor, which grants Everyone and the anonymous account read access, so it has to be
  // narrowed explicitly — and proven narrowed — before anything is told where it is.
  if (transport === 'unix') {
    await fs.chmod(socketPath, 0o600).catch(() => undefined);
  } else {
    try {
      await (options.restrictPipe ?? restrictControlPipeToOwner)(socketPath);
    } catch (error) {
      // Fail closed. A pipe that cannot be shown to be private is closed rather than
      // published: an endpoint whose access control is unproven is worse than no endpoint,
      // because `runtime.json` would advertise it to every local process. Sockets go first:
      // `server.close()` does not call back until every live connection has ended, so a peer
      // that connected during the window would otherwise hold the failure path open.
      for (const socket of sockets) socket.destroy();
      sockets.clear();
      await new Promise<void>((resolve) => server.close(() => resolve())).catch(() => undefined);
      throw error instanceof ControlSocketError
        ? error
        : new ControlSocketError(
            `the control pipe could not be restricted to this user: ${errorText(error)}`,
            'INTERNAL'
          );
    }
    // Anything that connected while the default descriptor was still in force never reached
    // the protocol and is dropped now that the pipe is this user's alone. The socket the ACL
    // script itself opened is one of these.
    for (const socket of sockets) socket.destroy();
    sockets.clear();
    restricted = true;
  }

  const descriptor: RuntimeDescriptor = {
    socket_path: socketPath,
    pid,
    installation_id: options.installationId,
    protocol_version: CONTROL_PROTOCOL_VERSION,
    // A daemon's descriptor is the same file with its own facts added: which kind of host wrote
    // it, which instance is answering, and the token its handshake expects. The token is only
    // ever in this 0600 file inside a 0700 directory, which is the whole of its confidentiality.
    ...(options.daemon
      ? {
          kind: 'daemon' as const,
          control_token: options.daemon.token,
          ...options.daemon.descriptor
        }
      : options.authToken ? { kind: 'desktop' as const, control_token: options.authToken } : {})
  };
  await writeRuntimeDescriptor(dataDir, descriptor);

  let closed = false;
  return {
    socketPath,
    transport,
    runtimeFile: runtimeFilePath(dataDir),
    clients: () => sockets.size,
    close: async () => {
      if (closed) return;
      closed = true;
      for (const socket of sockets) socket.destroy();
      sockets.clear();
      await new Promise<void>((resolve) => server.close(() => resolve()));
      await removeRuntimeDescriptor(dataDir, socketPath, platform);
      await removeEndpointFile(socketPath, platform);
    }
  };
}

/**
 * The host's reply for a failed dispatch.
 *
 * A WorkService failure is a *rejection* with its own machine-readable code — the CLI must
 * be able to tell `REQUEST_ID_CONFLICT` from a bug — while anything else is reported as an
 * internal error with its message, because swallowing it would leave the caller with a
 * silent no-op.
 */
export function describeDispatchFailure(error: unknown): ControlError {
  const code = (error as { code?: unknown } | null)?.code;
  const message = errorText(error);
  if (typeof code === 'string' && code.length > 0) return { code, message };
  return { code: 'INTERNAL', message };
}

export interface WorkControlDispatchOptions {
  service: WorkService;
  /** Local facts for `host.status`. Never fetched from the service. */
  hostStatus: () => HostStatusReport;
  /**
   * The local connection/reconnect backend.
   *
   * Optional so a host that has not built one still answers the socket: a call to a verb with
   * no backend is refused as `HOST_UNAVAILABLE`, which is the truth, rather than reported as a
   * connection that does not exist.
   */
  connection?: WorkConnectionPort;
}

/**
 * Adapts the one WorkService to the control protocol.
 *
 * This is the *only* place the socket touches the service, and it parses with the shared
 * schemas before every call — so a CLI bug, a stale CLI build, or a hand-written JSON line
 * is rejected as `INVALID_INPUT` before a single durable write. The CLI therefore cannot
 * reach the ledger through a looser door than the MCP tools or the GUI do.
 */
export function createWorkControlDispatch(options: WorkControlDispatchOptions): ControlDispatch {
  const { service } = options;
  return async (method, params) => {
    switch (method) {
      case 'host.status':
        return options.hostStatus();
      case 'work.start':
        return service.start(workStartSchema.parse(params));
      case 'work.list':
        return service.list(workListSchema.parse(params));
      case 'work.status':
        return service.status(workStatusRequestSchema.parse(params));
      case 'work.instruct':
        return service.instruct(workInstructionSchema.parse(params));
      case 'work.control':
        return service.control(workControlSchema.parse(params));
      case 'work.events':
        return service.events(workEventsRequestSchema.parse(params));
      case 'work.connection':
        return connectionPort(options).connection(workConnectionTargetSchema.parse(params));
      case 'work.reconnect':
        return connectionPort(options).reconnect(workReconnectRequestSchema.parse(params));
    }
  };
}

/**
 * The connection backend, or a truthful refusal.
 *
 * A host that never built one has no page evidence to read and no opener to use, so answering
 * `HOST_UNAVAILABLE` is the only honest reply — inventing a `closed` result would tell a caller
 * its chat is gone when nothing ever looked.
 */
function connectionPort(options: WorkControlDispatchOptions): WorkConnectionPort {
  if (options.connection) return options.connection;
  throw new ControlUnavailableError(
    'HOST_UNAVAILABLE: this host has no local connection backend, so it cannot report or open a work conversation.'
  );
}

// ---------------------------------------------------------------------------------------
// Client side
// ---------------------------------------------------------------------------------------

export interface ControlClient {
  descriptor: RuntimeDescriptor;
  call(method: ControlMethod, params?: unknown): Promise<unknown>;
  /** Receives GUI host pushes after `gui.subscribe` succeeds. */
  onGuiEvent(listener: (channel: string, args: unknown[]) => void): () => void;
  /** Observes one terminal transport close. */
  onClose(listener: () => void): () => void;
  close(): Promise<void>;
}

export interface OpenControlClientOptions {
  /** Per-call deadline. A hung host must not hang a shell. */
  timeoutMs?: number;
  /** Test seam: which platform's transport and validation to use. */
  platform?: NodeJS.Platform;
}

const DEFAULT_CALL_TIMEOUT_MS = 30_000;

/**
 * Connects, performs the hello handshake, and returns a request/reply client.
 *
 * Every failure before the handshake completes is `ControlUnavailableError`: from the
 * caller's point of view "no host", "dead host" and "a host that will not talk to this CLI"
 * are one condition — nothing can be done over this socket — and they must not be confused
 * with a host that answered and *refused an operation*.
 *
 * The endpoint is validated with the platform's own rules before a byte is sent, so a
 * descriptor pointing at a world-writable socket (POSIX) or at something that is not a local
 * pipe name (Windows) is refused rather than trusted.
 */
export async function openControlClient(
  descriptor: RuntimeDescriptor,
  options: OpenControlClientOptions = {}
): Promise<ControlClient> {
  const platform = options.platform ?? process.platform;
  await assertControlTransport(descriptor.socket_path, platform);
  const timeoutMs = options.timeoutMs ?? DEFAULT_CALL_TIMEOUT_MS;

  const socket = await new Promise<net.Socket>((resolve, reject) => {
    const candidate = net.connect(descriptor.socket_path);
    const onError = (error: Error): void => {
      candidate.off('connect', onConnect);
      candidate.destroy();
      reject(new ControlUnavailableError(`control socket is not accepting connections: ${error.message}`));
    };
    const onConnect = (): void => {
      candidate.off('error', onError);
      resolve(candidate);
    };
    candidate.once('error', onError);
    candidate.once('connect', onConnect);
  });
  socket.setNoDelay(true);

  const pending = new Map<number, { resolve: (value: unknown) => void; reject: (error: Error) => void; timer: NodeJS.Timeout | undefined }>();
  const guiListeners = new Set<(channel: string, args: unknown[]) => void>();
  const closeListeners = new Set<() => void>();
  const guiEventTransfers = new Map<string, string[]>();
  let nextId = 1;
  let failure: Error | null = null;
  /** Resolved by the host's `ready` frame; rejected by any connection failure. */
  const handshake = Promise.withResolvers<void>();

  /**
   * Every terminal connection problem lands here once. `handshake` and all in-flight calls
   * are rejected from the same place so a client can never be left waiting on a socket that
   * is already gone.
   */
  const failAll = (error: Error): void => {
    if (failure) return;
    failure = error;
    handshake.reject(error);
    for (const entry of pending.values()) {
      clearTimeout(entry.timer);
      entry.reject(error);
    }
    pending.clear();
    for (const listener of closeListeners) listener();
    closeListeners.clear();
  };

  const read = createLineReader({
    maxBytes: MAX_REPLY_BYTES,
    onOverflow: () => {
      failAll(new ControlUnavailableError('control reply exceeded the protocol limit', 'REPLY_TOO_LARGE'));
      socket.destroy();
    },
    onLine: (line) => {
      let parsed: unknown;
      try {
        parsed = JSON.parse(line);
      } catch {
        failAll(new ControlUnavailableError('control reply is not valid JSON'));
        socket.destroy();
        return;
      }
      const record = parsed as { id?: unknown; result?: unknown; error?: unknown; type?: unknown };
      if (record.type === 'ready') {
        handshake.resolve();
        return;
      }
      if (record.type === 'gui.event') {
        const event = parsed as Record<string, unknown>;
        if (typeof event.json === 'string') {
          const value = decodeGuiPayload(event.json);
          if (typeof value === 'object' && value !== null && !Array.isArray(value) && 'channel' in value && 'args' in value &&
              typeof value.channel === 'string' && Array.isArray(value.args)) {
            for (const listener of guiListeners) listener(value.channel, value.args);
          }
        }
        return;
      }
      if (record.type === 'gui.event.chunk') {
        const event = parsed as Record<string, unknown>;
        if (typeof event.id === 'string' && typeof event.part === 'number' && typeof event.total === 'number' && typeof event.data === 'string' &&
            Number.isInteger(event.part) && Number.isInteger(event.total) && event.total > 0 && event.part >= 0 && event.part < event.total) {
          const parts = guiEventTransfers.get(event.id) ?? Array<string>(event.total);
          if (parts.length === event.total) {
            parts[event.part] = event.data;
            guiEventTransfers.set(event.id, parts);
            if (completeGuiTransfer(parts)) {
              guiEventTransfers.delete(event.id);
              const value = decodeGuiPayload(Buffer.concat(parts.map(part => Buffer.from(part, 'base64'))).toString('utf8'));
              if (typeof value === 'object' && value !== null && !Array.isArray(value) && 'channel' in value && 'args' in value &&
                  typeof value.channel === 'string' && Array.isArray(value.args)) {
                for (const listener of guiListeners) listener(value.channel, value.args);
              }
            }
          }
        }
        return;
      }
      const detail = (record.error ?? null) as { code?: unknown; message?: unknown } | null;
      const errorCode = typeof detail?.code === 'string' ? detail.code : 'INTERNAL';
      const errorMessage = typeof detail?.message === 'string' ? detail.message : 'control request failed';
      // A frame with no id is the host refusing the connection itself (bad hello, protocol
      // mismatch, oversized line). That ends the client, not one call.
      if (record.error && (record.id === undefined || record.id === null)) {
        failAll(new ControlUnavailableError(errorMessage, errorCode));
        socket.destroy();
        return;
      }
      if (typeof record.id !== 'number') return;
      const entry = pending.get(record.id);
      if (!entry) return;
      pending.delete(record.id);
      clearTimeout(entry.timer);
      if (record.error) {
        entry.reject(new ControlRejectedError(errorMessage, errorCode));
        return;
      }
      entry.resolve(record.result);
    }
  });

  socket.on('data', read);
  socket.on('error', (error) => failAll(new ControlUnavailableError(`control connection failed: ${error.message}`)));
  socket.on('close', () => failAll(new ControlUnavailableError('control connection closed')));

  const writeJson = (value: unknown): void => {
    if (socket.destroyed) throw new ControlUnavailableError('control connection is closed');
    socket.write(`${JSON.stringify(value)}\n`);
  };

  const handshakeTimer = setTimeout(() => {
    failAll(new ControlUnavailableError('control handshake timed out'));
    socket.destroy();
  }, timeoutMs);
  try {
    writeJson({
      type: 'hello',
      installation_id: descriptor.installation_id,
      protocol_version: CONTROL_PROTOCOL_VERSION,
      // Read from the descriptor rather than passed in as an option. The token is a property of
      // *which host this is*, not of the call being made: a client that had to remember it would
      // be a client that could forget it, and the descriptor it just read is the one place the
      // value is published.
      ...(descriptor.control_token === undefined ? {} : { token: descriptor.control_token })
    });
    await handshake.promise;
  } finally {
    clearTimeout(handshakeTimer);
  }

  return {
    descriptor,
    call: (method, params = {}) =>
      new Promise<unknown>((resolve, reject) => {
        if (failure) {
          reject(failure);
          return;
        }
        const id = nextId++;
        // GUI handlers own their operation deadline (and native dialogs are human-paced).
        // A transport timeout cannot cancel an accepted mutation or make replay safe.
        const timer = method === 'gui.invoke' ? undefined : setTimeout(() => {
          pending.delete(id);
          reject(new ControlUnavailableError(`control request timed out after ${timeoutMs}ms`));
        }, timeoutMs);
        pending.set(id, { resolve, reject, timer });
        try {
          writeJson({ id, method, params });
        } catch (error) {
          clearTimeout(timer);
          pending.delete(id);
          reject(error instanceof Error ? error : new ControlUnavailableError(String(error)));
        }
      }),
    onGuiEvent: (listener) => {
      guiListeners.add(listener);
      return () => guiListeners.delete(listener);
    },
    onClose: (listener) => {
      closeListeners.add(listener);
      return () => closeListeners.delete(listener);
    },
    close: async () => {
      guiListeners.clear();
      socket.end();
      socket.destroy();
    }
  };
}
