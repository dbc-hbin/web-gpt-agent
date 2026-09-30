/**
 * Who this application is, and which directory is *its* data directory.
 *
 * Two properties make this module worth existing rather than scattering the same
 * strings and `app.getPath` calls across the app:
 *
 * - **It never imports Electron.** The CLI runs under a plain Node runtime (or
 *   `ELECTRON_RUN_AS_NODE=1`) and must never initialize Electron, yet it has to
 *   agree with the host about the data directory and the installation identity.
 *   Everything here is `node:fs`/`node:os`/`node:path`, and the one function that
 *   touches Electron takes a structural parameter instead of the module.
 * - **The data directory is decided before anything can read it.** Electron
 *   derives `userData` from the application name, and every store this app owns
 *   (config, secrets, session history, durable state) is rooted there. Resolving
 *   it *after* the single-instance lock or after any store has captured a path
 *   would leave the two halves of a run pointing at different directories, so
 *   `resolveAndApplyUserData` is called first and the resolved directory is
 *   remembered here for callers that cannot ask Electron.
 *
 * This is a fork of Chat On Steroids with its own product identity, data
 * directory, browser profile, loopback port range and bridge identity. The
 * upstream project keeps its own; nothing here reads, writes or adopts it.
 */

import { randomUUID } from 'node:crypto';
import {
  chmodSync,
  existsSync,
  mkdirSync,
  readFileSync,
  renameSync,
  rmSync,
  statSync,
  writeFileSync
} from 'node:fs';
import os from 'node:os';
import path from 'node:path';

/** The user-visible product name. Native chrome, window title and tray read this. */
export const PRODUCT_NAME = 'Web GPT Agent';
/** The npm package name, and the directory name under the platform's app-data root. */
export const NPM_NAME = 'web-gpt-agent';
/** The macOS bundle identifier, and the Linux XDG application id. */
export const BUNDLE_ID = 'com.webgptagent.app';
/** The `.desktop` file basename Electron is told to use on Linux. */
export const LINUX_DESKTOP_NAME = `${BUNDLE_ID}.desktop`;
/**
 * The MCP server name reported in `initialize`. The internal surface id stays
 * `core`; this is only what the client sees.
 */
export const CORE_SERVER_NAME = 'web-gpt-agent-core';
/**
 * What the bridge stamps every response with, and what the companion extension
 * requires before it will talk to a port at all. Distinct from upstream's
 * `chat-on-steroids`, which is exactly the point: an upstream extension scanning
 * its own ports must never be mistaken for this app's companion.
 */
export const BRIDGE_APP_ID = 'web-gpt-agent';
/**
 * The fixed loopback range the companion extension scans.
 *
 * Deliberately different from upstream's 8765-8769 so a machine running both
 * applications cannot pair one product's extension with the other's host.
 */
export const BRIDGE_PORTS: readonly number[] = [8865, 8866, 8867, 8868, 8869];

/** The CLI flag that redirects every store away from the real installation. */
export const DATA_DIR_FLAG = '--data-dir';
/** The app-owned Chrome profile, relative to the data directory. */
export const BROWSER_PROFILE_DIRNAME = 'browser-profile';
/** The persistent random id that makes "our extension" a checkable fact. */
export const INSTALLATION_ID_FILE = 'installation-id';
/**
 * The seed a generated extension folder carries to name the installation it belongs to.
 *
 * Written by `extension-path.ts` into the per-data-directory copy of the companion, and
 * read by `extension/background.js` before it looks for a host. Both halves spell it here
 * and there because the extension is plain shipped JavaScript and cannot import this module.
 */
export const EXTENSION_HOST_SEED_FILE = 'host-identity.js';
/** The CLI/host rendezvous file the control socket owner publishes. */
export const RUNTIME_FILE = 'runtime.json';

/** Directories this app owns are private: only the user may list or enter them. */
const PRIVATE_DIR_MODE = 0o700;
/** Files holding credentials or identity are readable only by the user. */
const PRIVATE_FILE_MODE = 0o600;

function appDataRoot(env: NodeJS.ProcessEnv, platform: NodeJS.Platform): string {
  const home = env.HOME ?? env.USERPROFILE ?? os.homedir();
  if (platform === 'darwin') return path.posix.join(home, 'Library', 'Application Support');
  if (platform === 'win32') return env.APPDATA ?? path.win32.join(home, 'AppData', 'Roaming');
  return env.XDG_CONFIG_HOME ?? path.posix.join(home, '.config');
}

/**
 * Where this application keeps everything when no `--data-dir` is given.
 *
 * Spelled out rather than left to Electron's `userData` default, because the
 * default follows `app.getName()` and would therefore move if the product name
 * ever changed again — silently orphaning every existing installation's history.
 */
export function defaultUserDataDir(
  platform: NodeJS.Platform = process.platform,
  env: NodeJS.ProcessEnv = process.env
): string {
  // Joined in the grammar of the platform asked about, not this host's: a darwin path resolved on
  // a Windows host must not come back with backslashes.
  return (platform === 'win32' ? path.win32 : path.posix).join(appDataRoot(env, platform), NPM_NAME);
}

/**
 * The default data directory of this host, resolved once at module load.
 *
 * Exported as a value as well as the `defaultUserDataDir()` function because the
 * CLI needs one string and has no business re-deriving it; the function stays
 * for the tests and for callers modelling another platform.
 */
export const DEFAULT_USER_DATA_DIR = defaultUserDataDir();

/** The installation id, read once per process from disk. */
let installationId: string | null = null;
/** The data directory in force for this process, once something has resolved it. */
let activeDir: string | null = null;

/** The data directory in force, or the default when nothing has resolved one yet. */
export function activeDataDir(): string {
  return activeDir ?? defaultUserDataDir();
}

/**
 * Reads `--data-dir` from anywhere in an argument vector.
 *
 * Both `--data-dir <path>` and `--data-dir=<path>` are accepted, in any
 * position, because the CLI documents the flag as a global that may appear
 * before or after the subcommand. The last occurrence wins, matching every other
 * command-line parser's treatment of a repeated option.
 *
 * A relative value is refused rather than resolved against the working
 * directory: the whole purpose of the flag is a data directory that is the same
 * place no matter who launched the process from where, and a relative path
 * silently is not.
 */
export function resolveDataDir(
  argv: readonly string[],
  env: NodeJS.ProcessEnv = process.env,
  platform: NodeJS.Platform = process.platform
): string {
  let wanted: string | null = null;
  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index]!;
    if (argument === DATA_DIR_FLAG) {
      const value = argv[index + 1];
      if (value === undefined) throw new Error(`${DATA_DIR_FLAG} needs an absolute directory path`);
      wanted = value;
      index += 1;
      continue;
    }
    if (argument.startsWith(`${DATA_DIR_FLAG}=`)) wanted = argument.slice(DATA_DIR_FLAG.length + 1);
  }
  if (wanted === null) return defaultUserDataDir(platform, env);
  if (!wanted) throw new Error(`${DATA_DIR_FLAG} needs an absolute directory path`);
  if (!path.isAbsolute(wanted)) {
    throw new Error(`${DATA_DIR_FLAG} must be an absolute path; got ${JSON.stringify(wanted)}`);
  }
  return path.normalize(wanted);
}

/**
 * Creates a directory this app owns, at mode 0700, and makes an existing one private.
 *
 * The chmod is not redundant with the `mode` passed to `mkdir`: that argument is
 * masked by the process umask and is ignored entirely for a directory that
 * already exists, so a directory created by an earlier build (or by hand) would
 * otherwise keep whatever permissions it had.
 */
export function ensurePrivateDir(dir: string): string {
  mkdirSync(dir, { recursive: true, mode: PRIVATE_DIR_MODE });
  try {
    chmodSync(dir, PRIVATE_DIR_MODE);
  } catch {
    // A directory we cannot chmod is still usable; refusing to start would be worse.
  }
  return dir;
}

/** Creates the parent of `file` at 0700 and returns it. */
export function ensurePrivateDirFor(file: string): string {
  return ensurePrivateDir(path.dirname(file));
}

/**
 * Writes a small secret file atomically at mode 0600.
 *
 * Temp-then-rename so a crash mid-write leaves the previous contents intact
 * rather than a truncated file that parses as something else. The temp file is
 * created inside the same directory, which is already 0700, so the bytes are
 * never briefly world-readable.
 */
export function writePrivateFile(file: string, contents: string | Buffer): void {
  ensurePrivateDirFor(file);
  const temp = `${file}.${process.pid}.${randomUUID()}.tmp`;
  writeFileSync(temp, contents, { mode: PRIVATE_FILE_MODE });
  try {
    chmodSync(temp, PRIVATE_FILE_MODE);
  } catch {
    // Same reasoning as ensurePrivateDir: mode 0600 was already requested above.
  }
  try {
    renameSync(temp, file);
  } catch (error) {
    rmSync(temp, { force: true });
    throw error;
  }
  try {
    chmodSync(file, PRIVATE_FILE_MODE);
  } catch {
    // Best effort; the create mode above already applied on a fresh file.
  }
}

/** Reads a private file, or null when it does not exist. */
export function readPrivateFile(file: string): string | null {
  try {
    return readFileSync(file, 'utf8');
  } catch {
    return null;
  }
}

/** True when `file` exists and is an ordinary file. */
export function isRegularFile(file: string): boolean {
  try {
    return statSync(file).isFile();
  } catch {
    return false;
  }
}

/** The path of the persistent installation id inside `dir`. */
export function installationIdPath(dir: string = activeDataDir()): string {
  return path.join(dir, INSTALLATION_ID_FILE);
}

/**
 * The persistent random id of *this installation*.
 *
 * Created on first use and then never changed: it is what turns "the extension
 * reached a port in the right range" into "the extension reached *this* app",
 * so it has to outlive restarts, profile changes and updates. Losing it is
 * equivalent to a fresh installation, which is why it lives in a 0600 file
 * rather than being derived from anything that can change.
 *
 * **It is only ever written into a directory this process has explicitly
 * resolved.** A process that never called `resolveAndApplyUserData`/`useDataDir`
 * — a test harness, a bridge started in isolation — gets a per-process id
 * instead of a file. Without that rule, merely reading the id would create the
 * real installation's data directory in a process that was never told to use
 * it, which is both a surprise for the user and the exact class of bug that
 * lets an isolated run quietly touch the live installation.
 */
export function getInstallationId(dir?: string): string {
  if (installationId !== null) return installationId;
  if (dir === undefined && activeDir === null) {
    // No directory was resolved, so there is nowhere this id may legitimately
    // live. A process-scoped value still makes /hello and /pair agree.
    installationId = randomUUID();
    return installationId;
  }
  const file = installationIdPath(dir ?? activeDataDir());
  const stored = readPrivateFile(file)?.trim();
  if (stored && /^[0-9a-f-]{36}$/i.test(stored)) {
    installationId = stored.toLowerCase();
    return installationId;
  }
  const created = randomUUID();
  writePrivateFile(file, created);
  installationId = created;
  return created;
}

/** The app-owned Chrome profile, where the companion extension and login live. */
export function browserProfileDir(dir: string = activeDataDir()): string {
  return path.join(dir, BROWSER_PROFILE_DIRNAME);
}

/** The rendezvous file the CLI reads to find the host's control socket. */
export function runtimeFilePath(dir: string = activeDataDir()): string {
  return path.join(dir, RUNTIME_FILE);
}

/** The subset of Electron's `app` this module needs, taken structurally. */
export interface AppIdentityTarget {
  setName(name: string): void;
  setPath(name: 'userData', path: string): void;
  setDesktopName?(name: string): void;
}

/**
 * Applies the product identity and points Electron's `userData` at our directory.
 *
 * Order matters and is enforced by the call sites: this runs before
 * `requestSingleInstanceLock()` and before any store is initialized. Electron
 * derives the default `userData` from the application name, so the name is set
 * first and the path is then set explicitly — an installation whose history
 * lives under one directory must not have that directory recomputed from a
 * product name that a later release rewords.
 */
export function resolveAndApplyUserData(
  app: AppIdentityTarget,
  argv: readonly string[],
  platform: NodeJS.Platform = process.platform,
  env: NodeJS.ProcessEnv = process.env
): string {
  app.setName(PRODUCT_NAME);
  if (platform === 'linux') {
    try {
      app.setDesktopName?.(LINUX_DESKTOP_NAME);
    } catch {
      // Older Electron builds do not expose this; the desktop entry still works.
    }
  }
  const dir = resolveDataDir(argv, env, platform);
  ensurePrivateDir(dir);
  activeDir = dir;
  app.setPath('userData', dir);
  return dir;
}

/**
 * Records the data directory for callers that resolve it themselves.
 *
 * Used by the CLI, which never touches Electron but still has to read the same
 * installation id and the same runtime file as the host it is talking to.
 */
export function useDataDir(dir: string): string {
  activeDir = dir;
  return dir;
}

/** Test seam: forget the cached installation id and the resolved directory. */
export function resetIdentityForTests(): void {
  installationId = null;
  activeDir = null;
}

/** True when `dir` exists and is a directory. */
export function directoryExists(dir: string): boolean {
  try {
    return statSync(dir).isDirectory();
  } catch {
    return false;
  }
}

/** True when `file` exists at all. */
export function pathExists(candidate: string): boolean {
  return existsSync(candidate);
}
