/**
 * Isolated Git worktrees for managed work.
 *
 * Parallel editing needs more than "two chats, two folders": it needs a baseline that is
 * provably the state the user's checkout was in when the work was admitted, one private
 * branch per agent, and an integration step that is serialized and can be resumed after a
 * crash without ever applying the same change twice. None of that exists upstream, so this
 * module owns it.
 *
 * The rules it exists to keep:
 *
 * - **The user's checkout is never touched.** No stash, no reset, no clean, no checkout, no
 *   branch switch, no index write. The baseline is captured through an alternate temporary
 *   `GIT_INDEX_FILE`, so the source index, HEAD, working files and refs are byte-for-byte
 *   what they were before. The only refs this module creates are its own:
 *   `refs/web-gpt-agent/<work_id>/base` and, when a work continues a predecessor,
 *   `refs/web-gpt-agent/<work_id>/from/<predecessor_work_id>`.
 * - **A baseline is a consistent snapshot or it is nothing.** The captured tree is compared
 *   against an independently enumerated manifest of the working tree (paths, modes, blob
 *   hashes) and against the source HEAD/index hashes taken before and after. Anything that
 *   moved means the capture is discarded and retried; three failed retries block the work
 *   with `PROJECT_CHANGED_DURING_SNAPSHOT` rather than mixing two versions.
 * - **Snapshots that would lose data are refused, not guessed at.** A sparse checkout, an
 *   unmerged source index or a dirty submodule returns `PROJECT_SNAPSHOT_UNSUPPORTED` with
 *   the exact affected paths.
 * - **A successor continues from the prior *result*, not from the project's main.** Continuity
 *   replaces a conversation while the work keeps its result, so a new work can be seeded from its
 *   predecessor's managed integration worktree — committed and dirty content alike — through the
 *   same capture, with the predecessor only ever read. Where that snapshot comes from is decided
 *   from the ledger and from Git, never from the caller's path.
 * - **Integration is serialized and recoverable.** One intent row is written *before*
 *   `git cherry-pick` runs, so a crash between Git succeeding and the receipt being written
 *   is recognized from the recorded commit parent and trailer instead of being cherry-picked
 *   a second time. A conflict leaves an explicitly owned `conflicted` state that only the
 *   prime can resolve or abort; a second integrate in the same worktree is `WORKTREE_BUSY`.
 *
 * Every Git invocation is `spawn('git', argv)` with `shell: false` — no model-supplied or
 * path-supplied text ever reaches a shell parser. Hooks and signing are disabled per
 * invocation with `-c` overrides, so the host's own checkpoint commits cannot be shaped by a
 * repository's `core.hooksPath` or `commit.gpgsign`, and no repository config is modified.
 */

import { spawn } from 'node:child_process';
import { createHash, randomUUID } from 'node:crypto';
import type { Stats } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { logWarn } from '../logger.js';
import { rawPromises as fs } from '../rawfs.js';
import type { WorkAgentRole, WorkDesiredState, WorkState } from '../../shared/work.js';
import type { WorktreeAssignmentRecord, IntegrationIntentRecord } from './store.js';

// ---------------------------------------------------------------------------------- errors

export type WorktreeErrorCode =
  | 'PROJECT_NOT_GIT'
  | 'PROJECT_SNAPSHOT_UNSUPPORTED'
  | 'PROJECT_CHANGED_DURING_SNAPSHOT'
  /** The caller named a project that is not the one the ledger recorded for this work. */
  | 'PROJECT_MISMATCH'
  /** This work already has a baseline taken from a different predecessor. */
  | 'SUCCESSOR_SOURCE_MISMATCH'
  /** The predecessor has not finished, so it has no settled result to continue from. */
  | 'PREDECESSOR_NOT_COMPLETED'
  | 'WORKTREE_BUSY'
  | 'WORKTREE_FAILED'
  | 'INTEGRATION_UNKNOWN'
  | 'GIT_UNAVAILABLE';

/** A refused Git operation. `code` is the contract; `message` is already human-readable. */
export class WorktreeError extends Error {
  readonly code: WorktreeErrorCode;
  readonly detail: string | undefined;
  /** Exact affected paths, for the refusals that name them. */
  readonly paths: readonly string[];

  constructor(code: WorktreeErrorCode, message: string, options?: { detail?: string; paths?: readonly string[] }) {
    super(message);
    this.name = 'WorktreeError';
    this.code = code;
    this.detail = options?.detail;
    this.paths = options?.paths ?? [];
  }
}

/** A second mutation was asked for while one already owns this worktree. */
export class WorktreeBusyError extends WorktreeError {
  constructor(message: string, options?: { detail?: string; paths?: readonly string[] }) {
    super('WORKTREE_BUSY', message, options);
    this.name = 'WorktreeBusyError';
  }
}

// ----------------------------------------------------------------------------- git plumbing

export interface GitCommand {
  cwd: string;
  args: readonly string[];
  /** Extra environment for this invocation, merged over the host environment. */
  env?: Record<string, string>;
  /** Text written to stdin before it is closed. */
  input?: string;
  timeoutMs?: number;
}

export interface GitResult {
  code: number;
  stdout: string;
  stderr: string;
}

/**
 * Runs one Git command. Injectable so tests can drive the retry and recovery paths without
 * racing a real filesystem, and so a caller can substitute a different Git binary.
 */
export type GitRunner = (command: GitCommand) => Promise<GitResult>;

/** Host-owned commits are attributed to the app, never to the user's Git identity. */
const HOST_IDENTITY: Record<string, string> = {
  GIT_AUTHOR_NAME: 'Web GPT Agent',
  GIT_AUTHOR_EMAIL: 'web-gpt-agent@localhost',
  GIT_COMMITTER_NAME: 'Web GPT Agent',
  GIT_COMMITTER_EMAIL: 'web-gpt-agent@localhost'
};

/**
 * Environment for host-owned Git commands.
 *
 * `GIT_OPTIONAL_LOCKS=0` keeps read-only commands from refreshing or taking the index lock,
 * which is what makes "the source index is unchanged" true even for the probes.
 * `GIT_TERMINAL_PROMPT=0` turns a credential prompt into a failure instead of a hang.
 */
const HOST_GIT_ENV: Record<string, string> = {
  GIT_OPTIONAL_LOCKS: '0',
  GIT_TERMINAL_PROMPT: '0',
  GIT_PAGER: 'cat'
};

/**
 * Repository-config overrides applied to every host-owned command.
 *
 * `core.hooksPath=` points at no directory, so a repository's own hooks cannot run inside a
 * checkpoint or an integration, and `commit.gpgsign=false` keeps a signing prompt out of a
 * background commit. Both are per-invocation `-c` overrides: the repository's config file is
 * never written.
 */
const CONFIG_OVERRIDES: readonly string[] = ['-c', 'core.hooksPath=', '-c', 'commit.gpgsign=false', '-c', 'gc.auto=0'];

const DEFAULT_GIT_TIMEOUT_MS = 120_000;
const SUBMODULE_TIMEOUT_MS = 600_000;

/** The production runner: real `git`, array argv, `shell: false`, bounded by a timeout. */
export function createGitRunner(): GitRunner {
  return async (command) => {
    // `spawn` reports a missing working directory as `ENOENT`, which is indistinguishable from
    // a missing `git` binary. Reporting it the way git itself does keeps one failure vocabulary
    // and lets a caller treat a stale recorded path as a failed probe rather than a crash.
    try {
      await fs.stat(command.cwd);
    } catch {
      return { code: 128, stdout: '', stderr: `fatal: cannot change to '${command.cwd}': No such file or directory\n` };
    }
    return await new Promise<GitResult>((resolve, reject) => {
      const child = spawn('git', [...command.args], {
        cwd: command.cwd,
        shell: false,
        windowsHide: true,
        stdio: ['pipe', 'pipe', 'pipe'],
        env: { ...process.env, ...HOST_GIT_ENV, ...command.env }
      });
      const out: Buffer[] = [];
      const err: Buffer[] = [];
      let settled = false;
      const timeout = setTimeout(() => {
        if (settled) return;
        settled = true;
        child.kill('SIGKILL');
        reject(
          new WorktreeError('GIT_UNAVAILABLE', `GIT_UNAVAILABLE: git ${command.args[0] ?? ''} did not finish within ${command.timeoutMs ?? DEFAULT_GIT_TIMEOUT_MS}ms and was stopped.`)
        );
      }, command.timeoutMs ?? DEFAULT_GIT_TIMEOUT_MS);
      timeout.unref?.();

      const finish = (value: GitResult | Error): void => {
        if (settled) return;
        settled = true;
        clearTimeout(timeout);
        if (value instanceof Error) reject(value);
        else resolve(value);
      };

      child.stdout?.on('data', (chunk: Buffer) => out.push(Buffer.from(chunk)));
      child.stderr?.on('data', (chunk: Buffer) => err.push(Buffer.from(chunk)));
      child.on('error', (error: Error) =>
        finish(new WorktreeError('GIT_UNAVAILABLE', `GIT_UNAVAILABLE: git could not be started (${error.message}). Install Git and make sure it is on PATH.`))
      );
      child.on('close', (code: number | null) =>
        finish({
          code: code ?? -1,
          stdout: Buffer.concat(out).toString('utf8'),
          stderr: Buffer.concat(err).toString('utf8')
        })
      );
      child.stdin?.on('error', () => {
        /* A command that never reads stdin closes the pipe under us; the exit code decides. */
      });
      child.stdin?.end(command.input ?? '');
    });
  };
}

// ------------------------------------------------------------------------------ git helpers

/** Splits NUL-delimited output. Git's `-z` forms are the only ones that survive odd paths. */
function splitNul(text: string): string[] {
  if (text === '') return [];
  const parts = text.split('\0');
  if (parts[parts.length - 1] === '') parts.pop();
  return parts;
}

function lines(text: string): string[] {
  return text.split('\n').filter((line) => line !== '');
}

/** `XY path` records, with the rename form carrying the original path as the next record. */
function parsePorcelainZ(text: string): Array<{ status: string; path: string; from: string | null }> {
  const records = splitNul(text);
  const entries: Array<{ status: string; path: string; from: string | null }> = [];
  for (let index = 0; index < records.length; index += 1) {
    const record = records[index];
    if (record === undefined || record.length < 4) continue;
    const status = record.slice(0, 2);
    const target = record.slice(3);
    if (status.startsWith('R') || status.startsWith('C')) {
      const from = records[index + 1] ?? null;
      index += 1;
      entries.push({ status, path: target, from });
      continue;
    }
    entries.push({ status, path: target, from: null });
  }
  return entries;
}

/** `STATUS path` records, with rename/copy carrying the original path as the next record. */
function parseNameStatusZ(text: string): Array<{ status: string; path: string; from: string | null }> {
  const records = splitNul(text);
  const entries: Array<{ status: string; path: string; from: string | null }> = [];
  for (let index = 0; index < records.length; index += 1) {
    const status = records[index];
    if (status === undefined || status === '') continue;
    const first = records[index + 1];
    if (first === undefined) break;
    index += 1;
    if (status.startsWith('R') || status.startsWith('C')) {
      // `R100\0<original>\0<current>`: the second record is the original path.
      const current = records[index + 1];
      if (current === undefined) break;
      index += 1;
      entries.push({ status, path: current, from: first });
      continue;
    }
    entries.push({ status, path: first, from: null });
  }
  return entries;
}

/** `MODE SP TYPE SP OID TAB PATH` records from `ls-tree -r -z`. */
function parseTreeZ(text: string): Array<{ path: string; mode: string; hash: string }> {
  const entries: Array<{ path: string; mode: string; hash: string }> = [];
  for (const record of splitNul(text)) {
    const tab = record.indexOf('\t');
    if (tab < 0) continue;
    const meta = record.slice(0, tab).split(' ');
    const mode = meta[0];
    const hash = meta[2];
    const target = record.slice(tab + 1);
    if (mode === undefined || hash === undefined) continue;
    entries.push({ path: target, mode, hash });
  }
  return entries;
}

/** `MODE SP OID SP STAGE TAB PATH` records from `ls-files --stage -z`. */
function parseStageZ(text: string): Array<{ path: string; mode: string; hash: string; stage: string }> {
  const entries: Array<{ path: string; mode: string; hash: string; stage: string }> = [];
  for (const record of splitNul(text)) {
    const tab = record.indexOf('\t');
    if (tab < 0) continue;
    const meta = record.slice(0, tab).split(' ');
    const mode = meta[0];
    const hash = meta[1];
    const stage = meta[2];
    const target = record.slice(tab + 1);
    if (mode === undefined || hash === undefined || stage === undefined) continue;
    entries.push({ path: target, mode, hash, stage });
  }
  return entries;
}

const GITLINK_MODE = '160000';
const SYMLINK_MODE = '120000';

/**
 * Git's own blob id for a byte string.
 *
 * Used for symlinks, whose content Git defines as the link text and whose id must therefore
 * be computed from the link rather than by reading the target — `git hash-object <link>`
 * follows the link and would report the target's blob, which is exactly the mistake this
 * avoids. The object format is the repository's (sha1 or sha256), never assumed.
 */
function gitBlobHash(content: string, format: 'sha1' | 'sha256'): string {
  const bytes = Buffer.from(content, 'utf8');
  const header = Buffer.from(`blob ${bytes.byteLength}\0`, 'utf8');
  return createHash(format).update(header).update(bytes).digest('hex');
}

/** Executable mode Git would record for a regular file with this permission mask. */
function fileMode(executable: boolean): string {
  return executable ? '100755' : '100644';
}

function compareEntries(a: readonly { path: string; mode: string; hash: string }[], b: readonly { path: string; mode: string; hash: string }[]): boolean {
  if (a.length !== b.length) return false;
  for (let index = 0; index < a.length; index += 1) {
    const left = a[index];
    const right = b[index];
    if (left === undefined || right === undefined) return false;
    if (left.path !== right.path || left.mode !== right.mode || left.hash !== right.hash) return false;
  }
  return true;
}

function byPath<T extends { path: string }>(entries: T[]): T[] {
  return [...entries].sort((left, right) => (left.path < right.path ? -1 : left.path > right.path ? 1 : 0));
}

// ------------------------------------------------------------------------------ public types

export interface BaselineManifestEntry {
  path: string;
  /** Git tree mode: `100644`, `100755`, `120000` for a symlink, `160000` for a submodule. */
  mode: string;
  /** Git blob hash. A symlink hashes its link text; a submodule hashes its recorded commit. */
  hash: string;
}

export interface Baseline {
  projectPath: string;
  workId: string | null;
  /** `refs/heads/...` at capture time, or null on a detached HEAD. */
  headRef: string | null;
  /** Null in an unborn repository. */
  headCommit: string | null;
  /**
   * The index file the snapshot was read from, or `''` when there is none to name.
   *
   * A captured baseline always names the checkout it read. A *retained* successor baseline
   * replayed after a restart names the predecessor worktree's index when that worktree is still
   * on disk, and is empty when it is not — the recorded commit is the fact, and naming a path for
   * a directory that no longer exists would be a lie.
   */
  indexPath: string;
  /**
   * SHA-256 of the source index file, or null when it does not exist.
   *
   * For a successor baseline this is the predecessor worktree's own index, which is read but
   * never inherited — the successor starts from `baselineCommit`, a clean checkout of a snapshot.
   */
  indexHash: string | null;
  manifest: BaselineManifestEntry[];
  /** The private baseline commit: HEAD plus every tracked change and nonignored untracked file. */
  baselineCommit: string;
  unborn: boolean;
  /** Submodule paths recorded in the baseline, in tree order. */
  submodules: string[];
  /** The retained private ref, when a work id was supplied. */
  baseRef: string | null;
  /**
   * The work this snapshot was taken from, when it was taken from a predecessor's result.
   *
   * Only {@link WorktreeManager.captureSuccessorBaseline} sets these two. They are what a caller
   * records or displays to say *which* result a successor inherited, and they are read back from
   * the durable ref namespace rather than from caller input.
   */
  predecessorWorkId?: string;
  sourceWorktreePath?: string;
}

export interface WorktreeAssignment {
  workId: string;
  agentId: string;
  role: WorkAgentRole;
  branch: string;
  path: string;
  baseCommit: string;
  createdAt: number;
}

export interface ChangedFile {
  path: string;
  /** Git's own status letters, e.g. `A`, `M`, `D`, `R100`. */
  status: string;
}

export interface WorktreeCheckpoint {
  path: string;
  branch: string;
  /** The new commit, or the current HEAD when nothing changed. */
  commit: string;
  treeHash: string;
  parentCommit: string | null;
  changedFiles: ChangedFile[];
  noop: boolean;
}

export type IntegrationState = 'merged' | 'already-applied' | 'conflict' | 'noop' | 'unknown' | 'aborted';

export interface IntegrationResult {
  state: IntegrationState;
  workId: string;
  workerId: string;
  operationId: string;
  mainBefore: string;
  workerCommit: string;
  mainCommit: string | null;
  conflictFiles: string[];
  /** The integration worktree — the deliverable's location, shown to every interface. */
  resultPath: string;
  integrationBranch: string;
  reason?: string;
}

/**
 * The durable subset this module needs from the work ledger.
 *
 * Declared with `void` results rather than the ledger's own row types, so the real `WorkStore`
 * satisfies it structurally without this module importing row shapes it never reads — and so
 * the in-memory fallback below has no fake rows to invent. Every method must be committed
 * before it resolves: the assignment is a pre-bootstrap barrier and the intent is a
 * pre-cherry-pick barrier.
 */
export interface WorktreeStorePort {
  assignWorktree(record: WorktreeAssignmentRecord): void;
  getWorktreeAssignment(workId: string, agentId: string): WorktreeAssignmentRecord | null;
  listWorktreeAssignments(workId: string): WorktreeAssignmentRecord[];
  setIntegrationIntent(workId: string, intent: IntegrationIntentRecord | null): void;
  getIntegrationIntent(workId: string): IntegrationIntentRecord | null;
  clearIntegrationIntent(workId: string): void;
  /**
   * Optional. The canonical project path recorded for a work, so a worker worktree can be
   * created before any other worktree directory exists. The real ledger's `getWork` satisfies
   * this shape, so production passes the `WorkStore` unchanged; when it is absent the project
   * is derived from an existing worktree's `--git-common-dir` instead.
   *
   * `status` and `desired_state` are read for the same reason: a successor may only be seeded
   * from a predecessor that has stopped working. Both are the ledger's own vocabulary and are
   * compared against the shared lifecycle constants, never against a locally invented set.
   *
   * `predecessor_work_id` is the ledger's own link between a work and the one it continues. A
   * store that does not expose it leaves it `undefined` and the request is checked against the
   * project instead; a ledger that answers `null` is saying the work has no predecessor at all.
   */
  getWork?(workId: string): {
    project_path?: string;
    status?: WorkState;
    desired_state?: WorkDesiredState | null;
    predecessor_work_id?: string | null;
  } | null;
}

/**
 * Reports whether a worktree still has a live mutating operation.
 *
 * `excludeOperationId` is the receipt of the call asking the question. It is a mutation receipt
 * like any other and is `running` by definition while its handler executes, so a probe that
 * counted it would refuse every integration. `integrate` passes its own id; a caller that
 * already knows the id may pass it through `assertQuiescent` as well.
 */
export interface WorktreeActivityProbeInput {
  workId: string;
  worktreePath: string;
  excludeOperationId?: string;
}

export interface WorktreeActivityProbe {
  isBusy(input: WorktreeActivityProbeInput): boolean;
}

export interface WorktreeManagerDeps {
  /** App data directory; managed worktrees live under `<userDataDir>/worktrees`. */
  userDataDir: string;
  /** Overrides the worktrees root. Must match the service's `worktreesRoot`. */
  worktreesRoot?: string;
  store?: WorktreeStorePort;
  activity?: WorktreeActivityProbe;
  runGit?: GitRunner;
  now?: () => number;
  sleep?: (ms: number) => Promise<void>;
}

export interface CaptureBaselineInput {
  projectPath: string;
  workId?: string;
}

/**
 * Seeds a successor work's baseline from its predecessor's result.
 *
 * `projectPath` is the original canonical project — the one the ledger recorded for the work —
 * and is only a cross-check: the snapshot is always taken from the predecessor's *managed
 * integration worktree*, which is resolved from the ledger's own assignment record. A caller
 * cannot point this at an arbitrary folder, and the predecessor cannot be mid-operation, holding
 * an unresolved integration, or already superseded.
 */
export interface CaptureSuccessorBaselineInput {
  workId: string;
  predecessorWorkId: string;
  projectPath: string;
}

export interface EnsureIntegrationInput {
  workId: string;
  projectPath: string;
  baselineCommit: string;
  /** The prime agent that owns the integration worktree. */
  agentId?: string;
}

export interface CreateWorkerInput {
  workId: string;
  agentId: string;
  baseCommit: string;
}

export interface CheckpointInput {
  path: string;
  message: string;
  baseCommit?: string;
}

export interface FinishWorkerInput {
  workId: string;
  agentId: string;
  message: string;
}

export interface IntegrateInput {
  workId: string;
  workerId: string;
  workerCommit: string;
  operationId: string;
  runId?: string;
}

export interface WorktreeManager {
  captureBaseline(input: CaptureBaselineInput): Promise<Baseline>;
  /**
   * The private baseline a successor starts from: its predecessor's managed integration worktree,
   * committed and dirty content alike, read without touching that worktree.
   */
  captureSuccessorBaseline(input: CaptureSuccessorBaselineInput): Promise<Baseline>;
  ensureIntegrationWorktree(input: EnsureIntegrationInput): Promise<WorktreeAssignment>;
  createWorkerWorktree(input: CreateWorkerInput): Promise<WorktreeAssignment>;
  getWorktreeAssignment(input: { workId: string; agentId: string }): Promise<WorktreeAssignment | null>;
  listWorktreeAssignments(input: { workId: string }): Promise<WorktreeAssignment[]>;
  currentIntegrationCommit(input: { workId: string }): Promise<string>;
  checkpointIntegration(input: { workId: string; message: string; baseCommit?: string }): Promise<WorktreeCheckpoint>;
  checkpointWorktree(input: CheckpointInput): Promise<WorktreeCheckpoint>;
  finishWorker(input: FinishWorkerInput): Promise<WorktreeCheckpoint>;
  integrate(input: IntegrateInput): Promise<IntegrationResult>;
  reconcileIntegration(input: { workId: string }): Promise<IntegrationResult | null>;
  abortIntegration(input: { workId: string }): Promise<IntegrationResult>;
  /** `excludeOperationId` names the caller's own live receipt so it is not counted as busy. */
  assertQuiescent(input: { workId: string; worktreePath: string; excludeOperationId?: string }): Promise<void>;
  changedFileSummary(input: { path: string; baseCommit: string }): Promise<ChangedFile[]>;
  verifyHashes(input: { path: string; expected: Record<string, string | null> }): Promise<Array<{ path: string; expected: string | null; actual: string | null; match: boolean }>>;
}

// --------------------------------------------------------------------------- store fallback

/**
 * An in-memory `WorktreeStorePort` for tests and for a host with no ledger.
 *
 * It is deliberately not a second persistence layer: nothing here survives the process. The
 * production host always passes the real ledger, which is what makes an assignment durable
 * before a bootstrap is sent.
 */
export function createMemoryWorktreeStore(): WorktreeStorePort {
  const assignments = new Map<string, WorktreeAssignmentRecord>();
  const intents = new Map<string, IntegrationIntentRecord>();
  const key = (workId: string, agentId: string): string => `${workId}\u0000${agentId}`;
  return {
    assignWorktree(record) {
      assignments.set(key(record.workId, record.agentId), { ...record });
    },
    getWorktreeAssignment(workId, agentId) {
      const found = assignments.get(key(workId, agentId));
      return found ? { ...found } : null;
    },
    listWorktreeAssignments(workId) {
      return [...assignments.values()].filter((row) => row.workId === workId).map((row) => ({ ...row }));
    },
    setIntegrationIntent(workId, intent) {
      if (intent) intents.set(workId, { ...intent });
      else intents.delete(workId);
    },
    getIntegrationIntent(workId) {
      const found = intents.get(workId);
      return found ? { ...found } : null;
    },
    clearIntegrationIntent(workId) {
      intents.delete(workId);
    }
  };
}

// ----------------------------------------------------------------------------- the manager

/** Three retries after the first attempt, then the work is blocked rather than mixed. */
const SNAPSHOT_RETRY_LIMIT = 3;
const SNAPSHOT_RETRY_DELAY_MS = 500;
const INTEGRATION_TRAILER = 'WGPA-Integration';

export function createWorktreeManager(deps: WorktreeManagerDeps): WorktreeManager {
  const runGit = deps.runGit ?? createGitRunner();
  const now = deps.now ?? (() => Date.now());
  const sleep = deps.sleep ?? ((ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms)));
  const store = deps.store ?? createMemoryWorktreeStore();
  const worktreesRoot = deps.worktreesRoot ?? path.join(deps.userDataDir, 'worktrees');
  /** One in-flight integration per work. A second caller is refused, never queued. */
  const integrationLocks = new Set<string>();
  /** Canonical project roots observed while admitting work; durable ledgers remain authoritative. */
  const projectRoots = new Map<string, string>();

  function fail(code: WorktreeErrorCode, message: string, options?: { detail?: string; paths?: readonly string[] }): never {
    throw new WorktreeError(code, message, options);
  }

  /** Runs Git and returns the result; the caller decides what a non-zero code means. */
  async function git(cwd: string, args: readonly string[], options?: { env?: Record<string, string>; input?: string; timeoutMs?: number }): Promise<GitResult> {
    return runGit({ cwd, args: [...CONFIG_OVERRIDES, ...args], ...options });
  }

  /** Runs Git and refuses on a non-zero exit, with the exact command in the detail. */
  async function gitOk(cwd: string, args: readonly string[], options?: { env?: Record<string, string>; input?: string; timeoutMs?: number }): Promise<GitResult> {
    const result = await git(cwd, args, options);
    if (result.code !== 0) {
      fail('WORKTREE_FAILED', `WORKTREE_FAILED: git ${args.join(' ')} failed (exit ${result.code}).`, {
        detail: result.stderr.trim() || result.stdout.trim() || 'git produced no diagnostic'
      });
    }
    return result;
  }

  async function exists(target: string): Promise<boolean> {
    try {
      await fs.lstat(target);
      return true;
    } catch {
      return false;
    }
  }

  async function readIndexHash(indexPath: string): Promise<string | null> {
    try {
      const bytes = await fs.readFile(indexPath);
      return createHash('sha256').update(bytes).digest('hex');
    } catch {
      return null;
    }
  }

  async function objectFormat(cwd: string): Promise<'sha1' | 'sha256'> {
    const result = await git(cwd, ['rev-parse', '--show-object-format']);
    return result.stdout.trim() === 'sha256' ? 'sha256' : 'sha1';
  }

  async function symbolicHead(cwd: string): Promise<string | null> {
    const result = await git(cwd, ['symbolic-ref', '-q', 'HEAD']);
    return result.code === 0 ? result.stdout.trim() || null : null;
  }

  async function headCommit(cwd: string): Promise<string | null> {
    const result = await git(cwd, ['rev-parse', '--verify', '--quiet', 'HEAD']);
    return result.code === 0 ? result.stdout.trim() || null : null;
  }

  /**
   * The sorted manifest of the working tree: every tracked and nonignored untracked path with
   * the mode and blob hash Git would record for it.
   *
   * Built from the filesystem rather than from a capture, so comparing it against a captured
   * tree is a real check that `add -A` saw the whole working state instead of a tautology.
   */
  async function enumerateManifest(cwd: string, format: 'sha1' | 'sha256'): Promise<BaselineManifestEntry[]> {
    const listed = await gitOk(cwd, ['ls-files', '-z', '--cached', '--others', '--exclude-standard']);
    // An untracked embedded Git repository is reported as `dir/` while its tree entry is
    // `dir`; normalizing here is what lets the manifest and the captured tree be compared.
    const paths = splitNul(listed.stdout).map((entry) => (entry.endsWith('/') ? entry.slice(0, -1) : entry)).filter((entry) => entry !== '');
    // With `core.fileMode=false` (the Windows default) Git ignores the filesystem's executable bit:
    // a regular file keeps the mode its index entry already has, and a new one is `100644`. The
    // capture's index is seeded from HEAD, so HEAD's recorded mode is exactly what `add -A` keeps —
    // a tracked `100755` script stays executable. Reading the bit from `stat` here instead made
    // every such project look like it changed during the snapshot.
    const honorsFileMode = (await git(cwd, ['config', '--bool', 'core.fileMode'])).stdout.trim() !== 'false';
    const recordedExecutable = new Set<string>();
    if (!honorsFileMode && (await headCommit(cwd)) !== null) {
      for (const entry of parseTreeZ((await gitOk(cwd, ['ls-tree', '-r', '-z', 'HEAD'])).stdout)) {
        if (entry.mode === fileMode(true)) recordedExecutable.add(entry.path);
      }
    }
    const staged = parseStageZ((await gitOk(cwd, ['ls-files', '--stage', '-z'])).stdout);
    const gitlinks = new Map<string, string>();
    for (const entry of staged) {
      if (entry.mode === GITLINK_MODE) gitlinks.set(entry.path, entry.hash);
    }

    const entries: BaselineManifestEntry[] = [];
    const batchable: string[] = [];
    for (const relative of paths) {
      const absolute = path.join(cwd, relative);
      let stat: Stats;
      try {
        stat = await fs.lstat(absolute);
      } catch {
        // Deleted in the working tree: `add -A` records the deletion, so there is no entry.
        continue;
      }
      if (stat.isSymbolicLink()) {
        const link = await fs.readlink(absolute);
        entries.push({ path: relative, mode: SYMLINK_MODE, hash: gitBlobHash(link, format) });
        continue;
      }
      if (stat.isDirectory()) {
        // A recorded submodule, or an untracked embedded repository Git would record as a gitlink.
        const recorded = gitlinks.get(relative);
        const inner = await headCommit(absolute);
        const hash = recorded ?? inner;
        if (hash !== null) entries.push({ path: relative, mode: GITLINK_MODE, hash });
        continue;
      }
      const executable = honorsFileMode ? (stat.mode & 0o111) !== 0 : recordedExecutable.has(relative);
      entries.push({ path: relative, mode: fileMode(executable), hash: '' });
      batchable.push(relative);
    }

    // One invocation hashes every regular file with the repository's own clean filters applied
    // (`.gitattributes`, `core.autocrlf`), which is the only way the manifest and the captured
    // tree can agree on a CRLF or `-text` file. Paths a line-based pipe cannot carry are
    // hashed one at a time instead.
    //
    // A file that vanishes mid-capture makes the batch fail; that is not an error here, it is
    // exactly the instability the caller's retry loop exists for, so the missing hash simply
    // leaves the manifest unequal to the captured tree.
    const piped = batchable.filter((relative) => !relative.includes('\n') && !relative.includes('\r'));
    const perFile = batchable.filter((relative) => relative.includes('\n') || relative.includes('\r'));
    const hashes = new Map<string, string>();
    if (piped.length > 0) {
      const hashed = await git(cwd, ['hash-object', '--stdin-paths'], { input: `${piped.join('\n')}\n` });
      if (hashed.code === 0) {
        const values = lines(hashed.stdout);
        for (let index = 0; index < piped.length; index += 1) {
          const relative = piped[index];
          const value = values[index];
          if (relative !== undefined && value !== undefined) hashes.set(relative, value.trim());
        }
      }
    }
    for (const relative of perFile) {
      const hashed = await git(cwd, ['hash-object', `--path=${relative}`, '--', relative]);
      if (hashed.code === 0) hashes.set(relative, hashed.stdout.trim());
    }

    return byPath(entries.map((entry) => (entry.hash === '' ? { ...entry, hash: hashes.get(entry.path) ?? '' } : entry)));
  }

  /** The same manifest shape, read from a tree object instead of the filesystem. */
  async function treeManifest(cwd: string, tree: string): Promise<BaselineManifestEntry[]> {
    return byPath(parseTreeZ((await gitOk(cwd, ['ls-tree', '-r', '-z', tree])).stdout));
  }

  /**
   * Refuses the source shapes whose snapshot would silently lose data.
   *
   * Each refusal names what is wrong and where, because "unsupported" without the paths is
   * not actionable.
   */
  async function assertSnapshotSupported(cwd: string): Promise<void> {
    const sparse = await git(cwd, ['config', '--get', 'core.sparseCheckout']);
    if (sparse.stdout.trim() === 'true') {
      const listed = await git(cwd, ['sparse-checkout', 'list']);
      fail(
        'PROJECT_SNAPSHOT_UNSUPPORTED',
        'PROJECT_SNAPSHOT_UNSUPPORTED: this checkout is sparse, so a private snapshot would silently omit files. ' +
          'Disable sparse checkout for this project, or start the work in a full checkout.',
        { paths: lines(listed.stdout) }
      );
    }

    const unmerged = await git(cwd, ['ls-files', '-u', '-z']);
    const unmergedPaths = [...new Set(parseStageZ(unmerged.stdout).map((entry) => entry.path))];
    if (unmergedPaths.length > 0) {
      fail(
        'PROJECT_SNAPSHOT_UNSUPPORTED',
        'PROJECT_SNAPSHOT_UNSUPPORTED: the source index has unresolved conflicts, so there is no single working version to snapshot. ' +
          'Resolve or abort the merge/rebase in the original checkout first.',
        { paths: unmergedPaths }
      );
    }

    const staged = parseStageZ((await gitOk(cwd, ['ls-files', '--stage', '-z'])).stdout);
    const gitlinks = new Set(staged.filter((entry) => entry.mode === GITLINK_MODE).map((entry) => entry.path));
    if (gitlinks.size === 0) return;
    const status = await git(cwd, ['status', '--porcelain', '-z', '--ignore-submodules=none', '--untracked-files=no']);
    const dirty = parsePorcelainZ(status.stdout)
      .filter((entry) => entry.status !== '??' && gitlinks.has(entry.path))
      .map((entry) => entry.path);
    if (dirty.length > 0) {
      fail(
        'PROJECT_SNAPSHOT_UNSUPPORTED',
        'PROJECT_SNAPSHOT_UNSUPPORTED: these submodules have uncommitted changes, which cannot be carried into an isolated worktree. ' +
          'Commit or discard them in the submodule first.',
        { paths: [...new Set(dirty)] }
      );
    }
  }

  /** Runs `read-tree`/`add -A`/`write-tree`/`commit-tree` through an alternate index file. */
  async function captureTree(cwd: string, options: { unborn: boolean; message: string; parent: string | null }): Promise<{ tree: string; commit: string }> {
    const indexPath = path.join(tmpdir(), `wgpt-idx-${randomUUID()}`);
    const env = { GIT_INDEX_FILE: indexPath };
    try {
      await gitOk(cwd, options.unborn ? ['read-tree', '--empty'] : ['read-tree', 'HEAD'], { env });
      await gitOk(cwd, ['add', '-A'], { env });
      const tree = (await gitOk(cwd, ['write-tree'], { env })).stdout.trim();
      const args = options.parent === null ? ['commit-tree', tree, '-m', options.message] : ['commit-tree', tree, '-p', options.parent, '-m', options.message];
      const commit = (await gitOk(cwd, args, { env: { ...env, ...HOST_IDENTITY } })).stdout.trim();
      return { tree, commit };
    } finally {
      await fs.rm(indexPath, { force: true }).catch(() => undefined);
    }
  }

  /**
   * A consistent private baseline of the project's current state.
   *
   * The user's index, HEAD, working files and branches are not touched: the capture goes
   * through an alternate index file and the result is only ever written to this module's own
   * ref namespace.
   */
  async function captureBaseline(input: CaptureBaselineInput): Promise<Baseline> {
    const projectPath = path.resolve(input.projectPath);
    const workId = input.workId ?? null;

    const inside = await git(projectPath, ['rev-parse', '--is-inside-work-tree']);
    if (inside.code !== 0 || inside.stdout.trim() !== 'true') {
      fail(
        'PROJECT_NOT_GIT',
        'PROJECT_NOT_GIT: isolated parallel editing needs a Git project. This folder is not a Git work tree, and the app will not initialize one for you.'
      );
    }
    const top = (await gitOk(projectPath, ['rev-parse', '--show-toplevel'])).stdout.trim();
    if (top === '') fail('PROJECT_NOT_GIT', 'PROJECT_NOT_GIT: Git did not report a working tree for this folder.');
    const root = path.resolve(top);
    const indexPath = (await gitOk(root, ['rev-parse', '--path-format=absolute', '--git-path', 'index'])).stdout.trim();
    const format = await objectFormat(root);
    const unborn = (await headCommit(root)) === null;

    let lastReason = 'the working tree kept changing while it was being read';
    for (let attempt = 0; attempt <= SNAPSHOT_RETRY_LIMIT; attempt += 1) {
      await assertSnapshotSupported(root);
      const headBefore = await headCommit(root);
      const refBefore = await symbolicHead(root);
      const indexBefore = await readIndexHash(indexPath);
      const manifestBefore = await enumerateManifest(root, format);
      const captured = await captureTree(root, {
        unborn: headBefore === null,
        parent: headBefore,
        message: workId === null ? 'web-gpt-agent baseline' : `web-gpt-agent baseline for work ${workId}`
      });
      const headAfter = await headCommit(root);
      const refAfter = await symbolicHead(root);
      const indexAfter = await readIndexHash(indexPath);
      const capturedEntries = await treeManifest(root, captured.tree);
      const manifestAfter = await enumerateManifest(root, format);

      if (headBefore === headAfter && refBefore === refAfter && indexBefore === indexAfter) {
        if (compareEntries(manifestBefore, capturedEntries) && compareEntries(manifestAfter, capturedEntries)) {
          const submodules = capturedEntries.filter((entry) => entry.mode === GITLINK_MODE).map((entry) => entry.path);
          let baseRef: string | null = null;
          if (workId !== null) {
            baseRef = `refs/web-gpt-agent/${workId}/base`;
            await gitOk(root, ['update-ref', baseRef, captured.commit], { env: HOST_IDENTITY });
          }
          return {
            projectPath: root,
            workId,
            headRef: refBefore,
            headCommit: headBefore,
            indexPath,
            indexHash: indexBefore,
            manifest: manifestBefore,
            baselineCommit: captured.commit,
            unborn,
            submodules,
            baseRef
          };
        }
        lastReason =
          'the captured tree did not match the working tree, which means a file changed while it was being read';
      } else {
        lastReason = 'HEAD, the current branch or the index changed while the snapshot was being taken';
      }

      if (attempt < SNAPSHOT_RETRY_LIMIT) {
        logWarn(`Baseline snapshot for ${root} was unstable (${lastReason}); retrying (${attempt + 1}/${SNAPSHOT_RETRY_LIMIT}).`);
        await sleep(SNAPSHOT_RETRY_DELAY_MS);
      }
    }

    fail(
      'PROJECT_CHANGED_DURING_SNAPSHOT',
      'PROJECT_CHANGED_DURING_SNAPSHOT: the project kept changing while a private snapshot was being taken, so no baseline was recorded. ' +
        'Stop other tools writing to this checkout and start the work again.',
      { detail: lastReason }
    );
  }

  // ------------------------------------------------------------------ successor baselines

  /**
   * The lifecycle states in which a predecessor is still the live owner of its work.
   *
   * These are the shared contract's own words — the same set the runtime holds its power
   * assertion for — so a state cannot enter this set by accident, and "still writing" is decided
   * by the ledger's vocabulary rather than by a locally invented list.
   */
  const LIVE_WORK_STATES: ReadonlySet<WorkState> = new Set<WorkState>(['queued', 'starting', 'running', 'recovering']);

  /**
   * `refs/web-gpt-agent/<work_id>/from/<predecessor_work_id>`: one per seeded baseline.
   *
   * Its *name* is the durable record of which predecessor a work starts from, and its value is
   * the predecessor integration commit the snapshot was taken on top of. The name is what makes
   * a retry idempotent: the predecessor's own branch is free to advance afterwards — that is
   * ordinary later work — and a second call still recognizes its own source instead of
   * re-snapshotting a predecessor that has moved on.
   */
  function sourceRefOf(workId: string, predecessorWorkId: string): string {
    return `refs/web-gpt-agent/${workId}/from/${predecessorWorkId}`;
  }

  /** `refs/web-gpt-agent/<work_id>/from/`, the namespace only this module writes. */
  function sourceRefPrefixOf(workId: string): string {
    return `refs/web-gpt-agent/${workId}/from/`;
  }

  function samePath(left: string, right: string): boolean {
    return path.relative(left, right) === '';
  }

  function isInsideRoot(parent: string, child: string): boolean {
    const relative = path.relative(parent, child);
    return relative !== '' && !relative.startsWith('..') && !path.isAbsolute(relative);
  }

  async function realpathOrResolve(target: string): Promise<string> {
    return (await fs.realpath(target).catch(() => null)) ?? path.resolve(target);
  }

  /** One revision's exact object id — a ref name, a `<commit>^` — or null when it resolves to nothing. */
  async function revTarget(cwd: string, revision: string): Promise<string | null> {
    const result = await git(cwd, ['rev-parse', '--verify', '--quiet', revision]);
    return result.code === 0 ? result.stdout.trim() || null : null;
  }

  /** Every predecessor this module already recorded as a work's source, oldest name first. */
  async function sourceWorkIdsFor(cwd: string, workId: string): Promise<string[]> {
    const prefix = sourceRefPrefixOf(workId);
    const listed = await git(cwd, ['for-each-ref', '--format=%(refname)', prefix]);
    if (listed.code !== 0) return [];
    return listed.stdout
      .split('\n')
      .filter((line) => line.startsWith(prefix))
      .map((line) => line.slice(prefix.length))
      .filter((name) => name !== '');
  }

  /**
   * The root Git reports for a folder, or null when the folder is not in a work tree.
   *
   * `--show-toplevel` is what identifies the *project* the ledger recorded: for a linked worktree
   * it answers with that worktree, which is the checkout the user actually added, and for a
   * repository created with `--separate-git-dir` it still answers correctly. The common directory
   * is a different question — it identifies the repository — and is asked separately below.
   */
  async function worktreeRoot(folder: string): Promise<string | null> {
    const inside = await git(folder, ['rev-parse', '--is-inside-work-tree']);
    if (inside.code !== 0 || inside.stdout.trim() !== 'true') return null;
    const top = await git(folder, ['rev-parse', '--show-toplevel']);
    if (top.code !== 0 || top.stdout.trim() === '') return null;
    return await realpathOrResolve(top.stdout.trim());
  }

  /**
   * The repository a work tree belongs to, as Git reports it.
   *
   * Every worktree of a repository — including the managed integration worktrees — shares one
   * common directory, so comparing these is what proves two folders are the same project without
   * assuming the project root is the parent of `.git`.
   */
  async function commonDirOf(folder: string): Promise<string | null> {
    const common = await git(folder, ['rev-parse', '--path-format=absolute', '--git-common-dir']);
    if (common.code !== 0 || common.stdout.trim() === '') return null;
    return await realpathOrResolve(path.resolve(common.stdout.trim()));
  }

  /**
   * The worktree Git has registered at this exact directory, with symlinks resolved.
   *
   * Both spellings are canonicalized before they are compared: a worktrees root that is itself
   * reached through a symlink would otherwise make a registered worktree look foreign, and the
   * answer to "is this directory a worktree of this repository" must not depend on how the host
   * happens to spell its own data directory.
   */
  async function registeredWorktree(cwd: string, realPath: string): Promise<{ path: string; branch: string | null } | null> {
    for (const entry of await worktreeList(cwd)) {
      if (samePath(await realpathOrResolve(entry.path), realPath)) return entry;
    }
    return null;
  }

  /** The read-only facts a managed integration worktree has to prove before it is trusted. */
  interface ManagedIntegration {
    path: string;
    branch: string;
    head: string;
    commonDir: string;
    /** The worktree's own index file, so the capture can report what it read and did not touch. */
    indexPath: string;
    format: 'sha1' | 'sha256';
  }

  /**
   * Resolves a work's managed integration worktree and proves it is really one.
   *
   * The directory never comes from the caller. It comes from the ledger's own prime assignment
   * row and is then checked against four independent facts: the directory is inside this host's
   * worktrees root after symlinks are resolved, Git registers that exact directory as a worktree
   * of the repository, that worktree is on the branch the row recorded, and it has a commit. A
   * snapshot taken from the wrong directory is indistinguishable from a correct one once it is a
   * commit, so every one of these is a refusal rather than a fallback.
   */
  async function verifiedAssignment(
    cwd: string,
    recorded: WorktreeAssignmentRecord,
    label: string
  ): Promise<ManagedIntegration> {
    const root = await realpathOrResolve(worktreesRoot);
    const realPath = await fs.realpath(recorded.path).catch(() => null);
    if (realPath === null || !isInsideRoot(root, realPath)) {
      fail('WORKTREE_FAILED', `WORKTREE_FAILED: the recorded worktree for ${label} is not inside this host's managed worktrees folder.`, {
        detail: `recorded ${recorded.path}`
      });
    }
    const registered = await registeredWorktree(cwd, realPath);
    if (!registered) {
      fail('WORKTREE_FAILED', `WORKTREE_FAILED: ${realPath} is not registered as a worktree of this repository, so ${label} was not mutated.`, {
        detail: 'Run `git worktree repair` in the project, or start a new work.'
      });
    }
    if (registered.branch !== `refs/heads/${recorded.branch}`) {
      fail('WORKTREE_FAILED', `WORKTREE_FAILED: the worktree for ${label} is on ${registered.branch ?? 'a detached HEAD'} rather than its recorded branch ${recorded.branch}, so it was not mutated.`);
    }
    const head = await headCommit(realPath);
    if (head === null) fail('WORKTREE_FAILED', `WORKTREE_FAILED: the worktree for ${label} has no commit.`);
    const common = await commonDirOf(realPath);
    const expectedCommon = await commonDirOf(cwd);
    if (common === null || expectedCommon === null || !samePath(common, expectedCommon)) {
      fail('WORKTREE_FAILED', `WORKTREE_FAILED: the recorded worktree for ${label} no longer belongs to its recorded project, so it was not mutated.`);
    }
    return {
      path: realPath,
      branch: recorded.branch,
      head,
      commonDir: common,
      indexPath: (await gitOk(realPath, ['rev-parse', '--path-format=absolute', '--git-path', 'index'])).stdout.trim(),
      format: await objectFormat(realPath)
    };
  }

  async function managedIntegration(cwd: string, workId: string, label: string): Promise<ManagedIntegration> {
    const recorded = store.listWorktreeAssignments(workId).find((row) => row.role === 'prime');
    if (!recorded) {
      fail('WORKTREE_FAILED', `WORKTREE_FAILED: ${label} has no recorded integration worktree, so it has no result to inherit.`, {
        detail: 'The predecessor must have been started in this host before a successor can continue it.'
      });
    }
    return verifiedAssignment(cwd, recorded, label);
  }

  interface VerifiedProject {
    projectPath: string;
    commonDir: string;
    predecessorStatus: WorkState | undefined;
    predecessorDesiredState: WorkDesiredState | null;
  }

  /**
   * Cross-checks the caller's project against the ledger before anything is read.
   *
   * The ledger is the authority on which project a work belongs to; `projectPath` is only a
   * cross-check, so a caller cannot aim a successor at a folder of its choosing. Both works must
   * be recorded against the same canonical project, and the predecessor's `project_path` must be
   * the same repository — a predecessor from a different project is a mismatch, not a hint.
   */
  async function verifiedProject(input: CaptureSuccessorBaselineInput): Promise<VerifiedProject> {
    const successor = store.getWork?.(input.workId);
    const predecessor = store.getWork?.(input.predecessorWorkId);
    if (successor === undefined || predecessor === undefined) {
      fail('WORKTREE_FAILED', 'WORKTREE_FAILED: this host has no work ledger, so a predecessor\'s recorded result cannot be verified and nothing was inherited.', {
        detail: 'Continue work only in a host that owns the ledger.'
      });
    }
    if (!successor) fail('WORKTREE_FAILED', `WORKTREE_FAILED: no work ${input.workId} exists in the ledger.`);
    if (!predecessor) fail('WORKTREE_FAILED', `WORKTREE_FAILED: no work ${input.predecessorWorkId} exists in the ledger, so it has no result to inherit.`);
    // The ledger owns the lineage. A caller cannot decide that some *other* work is this one's
    // predecessor, and a work the ledger records as having no predecessor cannot be given one:
    // that is exactly the "follow the latest work" guess this must never make.
    const linked = successor.predecessor_work_id;
    if (linked !== undefined && linked !== input.predecessorWorkId) {
      fail(
        'SUCCESSOR_SOURCE_MISMATCH',
        linked === null
          ? `SUCCESSOR_SOURCE_MISMATCH: work ${input.workId} is not recorded as continuing any work, so work ${input.predecessorWorkId}'s result was not adopted as its start.`
          : `SUCCESSOR_SOURCE_MISMATCH: work ${input.workId} continues work ${linked} rather than work ${input.predecessorWorkId}, so its start was not replaced.`,
        { detail: 'The predecessor is the ledger\'s fact, never the request\'s.' }
      );
    }
    const ledgerProject = successor.project_path;
    if (!ledgerProject) {
      fail('PROJECT_MISMATCH', `PROJECT_MISMATCH: work ${input.workId} has no recorded project, so the folder it is being continued from cannot be verified.`);
    }

    const requested = await realpathOrResolve(path.resolve(input.projectPath));
    const recorded = await realpathOrResolve(ledgerProject);
    if (!samePath(requested, recorded)) {
      fail('PROJECT_MISMATCH', `PROJECT_MISMATCH: work ${input.workId} belongs to ${ledgerProject}, so its result cannot be inherited from ${input.projectPath}.`, {
        detail: 'The project is read from the ledger, never from the request.'
      });
    }
    const predecessorProjectPath = predecessor.project_path;
    if (!predecessorProjectPath) {
      fail('PROJECT_MISMATCH', `PROJECT_MISMATCH: work ${input.predecessorWorkId} has no recorded project, so it cannot be shown to be this work's result.`);
    }
    const predecessorProject = await realpathOrResolve(predecessorProjectPath);
    if (!samePath(predecessorProject, recorded)) {
      fail('PROJECT_MISMATCH', `PROJECT_MISMATCH: work ${input.predecessorWorkId} belongs to ${predecessorProjectPath} rather than ${ledgerProject}, so it is not the result being continued.`);
    }

    // The recorded project must be inside a Git work tree. It does not have to *be* the work
    // tree's root: the registry accepts a subfolder of a repository, and it accepts a linked
    // worktree, whose `.git` is a file rather than a directory. What identifies the project is
    // the root Git reports, which is what the successor's worktree is created from.
    const root = await worktreeRoot(recorded);
    if (root === null || !(samePath(root, recorded) || isInsideRoot(root, recorded))) {
      fail('PROJECT_MISMATCH', `PROJECT_MISMATCH: ${ledgerProject} is not inside a Git work tree, so the project being continued cannot be verified.`, {
        detail: `git reported ${root ?? 'no working tree'}`
      });
    }
    const common = await commonDirOf(recorded);
    if (common === null) fail('PROJECT_MISMATCH', `PROJECT_MISMATCH: Git did not report a repository for ${recorded}.`);
    return {
      projectPath: root,
      commonDir: common,
      predecessorStatus: predecessor.status,
      predecessorDesiredState: predecessor.desired_state ?? null
    };
  }

  /**
   * The private baseline a successor starts from: its predecessor's result.
   *
   * The predecessor's managed integration worktree — its committed history *and* its dirty
   * tracked and untracked files — is snapshotted through the same machinery the project baseline
   * uses, with the predecessor's HEAD as the parent so the successor's branch carries the prior
   * work in its history. The predecessor is only ever read: no reset, checkout, amend, index
   * write or ref of its own is touched, and its working files are left byte-for-byte as they
   * were, uncommitted content included.
   *
   * A predecessor that is still working, holding a live mutation, or carrying an unresolved
   * integration has no settled result to inherit and is refused rather than snapshotted
   * half-applied. A successor whose baseline already exists keeps it: the retained commit is
   * returned instead of re-reading a predecessor that may have changed since, and a request
   * naming a different predecessor is refused rather than silently re-pointing the work.
   *
   * The source is decided by the ledger and by Git, never by the caller: `projectPath` is a
   * cross-check, and the directory read is the predecessor's registered prime assignment, proven
   * to be inside this host's worktrees root and to belong to the same canonical repository.
   */
  async function captureSuccessorBaseline(input: CaptureSuccessorBaselineInput): Promise<Baseline> {
    const { workId, predecessorWorkId } = input;
    if (workId === predecessorWorkId) {
      fail('WORKTREE_FAILED', `WORKTREE_FAILED: work ${workId} cannot be continued from itself.`);
    }

    const project = await verifiedProject(input);
    const recorded = store.listWorktreeAssignments(predecessorWorkId).find((row) => row.role === 'prime');
    const baseRef = `refs/web-gpt-agent/${workId}/base`;
    const sourceRef = sourceRefOf(workId, predecessorWorkId);
    const retained = await revTarget(project.projectPath, baseRef);
    if (retained !== null) {
      // The baseline is already a fixed fact, so it is answered before the predecessor's current
      // worktree and activity are examined: a restarted host replaying this start stage must get
      // the same answer even if the predecessor has since been resumed, moved or repaired.
      //
      // The retained *source* ref — not the commit it names — is what identifies where this work
      // starts from. The predecessor's HEAD is allowed to move on after the snapshot (that is
      // ordinary later work), so comparing commits here would refuse a legitimate retry.
      const sourceCommit = await revTarget(project.projectPath, sourceRef);
      if (sourceCommit === null) {
        // This work already starts from somewhere else — the project checkout, or another
        // predecessor. Re-pointing it would replace the result its agents are working from.
        const sources = await sourceWorkIdsFor(project.projectPath, workId);
        const from = sources.length > 0 ? `work ${sources.join(', ')}` : 'the project checkout';
        fail(
          'SUCCESSOR_SOURCE_MISMATCH',
          `SUCCESSOR_SOURCE_MISMATCH: work ${workId} already starts from ${from}, so its baseline was not replaced with work ${predecessorWorkId}'s result.`,
          { detail: 'Start a new work to continue from a different result.' }
        );
      }
      // The snapshot is built on top of exactly the commit the source ref records. If that no
      // longer holds, something else rewrote this work's baseline — the project checkout, say —
      // and handing it back as the predecessor's result would be a lie.
      const parent = await revTarget(project.projectPath, `${retained}^`);
      if (parent !== sourceCommit) {
        fail(
          'SUCCESSOR_SOURCE_MISMATCH',
          `SUCCESSOR_SOURCE_MISMATCH: the recorded baseline of work ${workId} is no longer built on work ${predecessorWorkId}'s result, so it was not reused.`,
          { detail: 'Start a new work to continue from that result.' }
        );
      }
      // The predecessor's worktree may have been removed or moved on since; when it is still
      // there, its real path and index file are reported. When it is not, nothing is invented.
      const sourceWorktree = recorded && (await exists(recorded.path)) ? await realpathOrResolve(recorded.path) : '';
      return await retainedBaseline({
        projectPath: project.projectPath,
        workId,
        predecessorWorkId,
        indexPath:
          sourceWorktree === ''
            ? ''
            : (await gitOk(sourceWorktree, ['rev-parse', '--path-format=absolute', '--git-path', 'index'])).stdout.trim(),
        sourcePath: sourceWorktree,
        branch: recorded?.branch ?? '',
        commit: retained,
        sourceCommit
      });
    }

    const predecessor = await managedIntegration(project.projectPath, predecessorWorkId, `work ${predecessorWorkId}`);
    if (!samePath(predecessor.commonDir, project.commonDir)) {
      fail(
        'PROJECT_MISMATCH',
        `PROJECT_MISMATCH: the integration worktree of work ${predecessorWorkId} belongs to ${predecessor.commonDir} rather than this project's ${project.commonDir}, so it is not this work's result.`
      );
    }

    // A predecessor still owning its work has not stopped writing: its result is whatever the
    // last writer left behind, which is not a state a successor may be handed as its start.
    const status = project.predecessorStatus;
    if (status === undefined) {
      fail('WORKTREE_FAILED', `WORKTREE_FAILED: the lifecycle state of work ${predecessorWorkId} could not be read, so it cannot be shown to have finished and nothing was inherited.`);
    }
    if (LIVE_WORK_STATES.has(status)) {
      throw new WorktreeBusyError(
        `WORKTREE_BUSY: work ${predecessorWorkId} is still ${status}, so its result is not settled and no successor baseline was taken. ` +
          'Wait for it to stop, then continue the work again.'
      );
    }
    // A committed pause/cancel that has not drained is the same fact: the stop was asked for but
    // the work has not finished stopping.
    if (project.predecessorDesiredState !== null && status !== 'paused' && status !== 'cancelled') {
      throw new WorktreeBusyError(
        `WORKTREE_BUSY: work ${predecessorWorkId} has a committed ${project.predecessorDesiredState} that has not drained, so its result is not settled and no successor baseline was taken. ` +
          'Wait for it to stop, then continue the work again.'
      );
    }
    // Only a completed work has a result to continue from. A paused, blocked or cancelled work
    // stopped without reaching its finish line, and a successor seeded from it would present
    // unfinished work as the state the new conversation starts from.
    if (status !== 'completed') {
      fail(
        'PREDECESSOR_NOT_COMPLETED',
        `PREDECESSOR_NOT_COMPLETED: work ${predecessorWorkId} is ${status}, not completed, so it has no finished result to continue from.`,
        { detail: 'Finish that work — or start a new one — instead of continuing it.' }
      );
    }
    // The same fact one layer down: a live mutation or process is still writing to the worktree.
    if (deps.activity?.isBusy({ workId: predecessorWorkId, worktreePath: predecessor.path })) {
      throw new WorktreeBusyError(
        `WORKTREE_BUSY: work ${predecessorWorkId} still has a live mutation or process in ${predecessor.path}, so its result is not settled and no successor baseline was taken. ` +
          'Wait for it to settle, then continue the work again.'
      );
    }
    // An integration that has not settled means the predecessor's own result is half-applied.
    const intent = store.getIntegrationIntent(predecessorWorkId);
    if (intent && intent.status !== 'merged' && intent.status !== 'aborted') {
      fail(
        'INTEGRATION_UNKNOWN',
        `INTEGRATION_UNKNOWN: work ${predecessorWorkId} has an unresolved integration (${intent.status}), so its result is not settled and no successor baseline was taken.`,
        { paths: intent.conflictFiles, detail: 'Resolve or abort that integration, then continue the work.' }
      );
    }
    // A cherry-pick Git is holding without a recorded intent is the same unsettled fact.
    if (await cherryPickInProgress(predecessor.path)) {
      fail(
        'INTEGRATION_UNKNOWN',
        `INTEGRATION_UNKNOWN: the integration worktree of work ${predecessorWorkId} is in the middle of a cherry-pick, so its result is not settled and no successor baseline was taken.`,
        { detail: 'Settle that cherry-pick, then continue the work.' }
      );
    }

    let lastReason = 'the predecessor worktree kept changing while it was being read';
    for (let attempt = 0; attempt <= SNAPSHOT_RETRY_LIMIT; attempt += 1) {
      await assertSnapshotSupported(predecessor.path);
      const headBefore = await headCommit(predecessor.path);
      const refBefore = await symbolicHead(predecessor.path);
      const indexBefore = await readIndexHash(predecessor.indexPath);
      const manifestBefore = await enumerateManifest(predecessor.path, predecessor.format);
      const captured = await captureTree(predecessor.path, {
        unborn: false,
        parent: headBefore,
        message: `web-gpt-agent successor baseline for work ${workId} from work ${predecessorWorkId}`
      });
      const headAfter = await headCommit(predecessor.path);
      const refAfter = await symbolicHead(predecessor.path);
      const indexAfter = await readIndexHash(predecessor.indexPath);
      const capturedEntries = await treeManifest(predecessor.path, captured.tree);
      const manifestAfter = await enumerateManifest(predecessor.path, predecessor.format);

      if (headBefore !== predecessor.head || refBefore !== `refs/heads/${predecessor.branch}`) {
        // The worktree moved on between being validated and being read. Its *current* content is
        // not the settled result this call was asked to inherit, so nothing is captured from it.
        lastReason = 'the predecessor worktree is no longer on the commit and branch that were validated';
      } else if (headBefore === headAfter && refBefore === refAfter && indexBefore === indexAfter) {
        if (compareEntries(manifestBefore, capturedEntries) && compareEntries(manifestAfter, capturedEntries)) {
          // Both refs are published in one ref transaction, so a crash cannot leave a retained
          // baseline whose source is unrecorded, and a racing second call cannot win one of them.
          const published = await git(project.projectPath, ['update-ref', '--stdin'], {
            env: HOST_IDENTITY,
            input: `start\ncreate ${baseRef} ${captured.commit}\ncreate ${sourceRef} ${predecessor.head}\nprepare\ncommit\n`
          });
          if (published.code !== 0) {
            // Another call for the same work published first. Its baseline is the one that counts
            // when it came from this same predecessor; a different source means this work is
            // already seeded elsewhere and must not be re-pointed.
            const winner = await revTarget(project.projectPath, baseRef);
            const winnerSource = await revTarget(project.projectPath, sourceRef);
            if (winner !== null && winnerSource !== null) {
              return await retainedBaseline({
                projectPath: project.projectPath,
                workId,
                predecessorWorkId,
                indexPath: predecessor.indexPath,
                sourcePath: predecessor.path,
                branch: predecessor.branch,
                commit: winner,
                sourceCommit: winnerSource
              });
            }
            if (winner !== null) {
              fail(
                'SUCCESSOR_SOURCE_MISMATCH',
                `SUCCESSOR_SOURCE_MISMATCH: work ${workId} was seeded from a different source while this request was running, so it was not re-pointed at work ${predecessorWorkId}'s result.`,
                { detail: 'Start a new work to continue from a different result.' }
              );
            }
            fail('WORKTREE_FAILED', `WORKTREE_FAILED: the successor baseline for work ${workId} could not be published (exit ${published.code}).`, {
              detail: published.stderr.trim() || published.stdout.trim() || 'git update-ref produced no diagnostic'
            });
          }
          return {
            projectPath: project.projectPath,
            workId,
            headRef: refBefore,
            headCommit: headBefore,
            indexPath: predecessor.indexPath,
            indexHash: indexBefore,
            manifest: manifestBefore,
            baselineCommit: captured.commit,
            // A successor always continues from a commit; there is no unborn predecessor.
            unborn: false,
            submodules: capturedEntries.filter((entry) => entry.mode === GITLINK_MODE).map((entry) => entry.path),
            baseRef,
            predecessorWorkId,
            sourceWorktreePath: predecessor.path
          };
        }
        lastReason = 'the captured tree did not match the predecessor worktree, which means a file changed while it was being read';
      } else {
        lastReason = 'the predecessor worktree moved to another commit, branch or index while it was being read';
      }

      if (attempt < SNAPSHOT_RETRY_LIMIT) {
        logWarn(`Successor baseline for work ${workId} was unstable (${lastReason}); retrying (${attempt + 1}/${SNAPSHOT_RETRY_LIMIT}).`);
        await sleep(SNAPSHOT_RETRY_DELAY_MS);
      }
    }

    fail(
      'PROJECT_CHANGED_DURING_SNAPSHOT',
      `PROJECT_CHANGED_DURING_SNAPSHOT: work ${predecessorWorkId}'s result kept changing while it was being read, so no successor baseline was recorded. ` +
        'Let the work settle, then continue it again.',
      { detail: lastReason }
    );
  }

  /**
   * The baseline this work already has, read back from the retained commit.
   *
   * A successor's start stage is retried across a restart, and re-reading the predecessor would
   * answer with whatever the predecessor looks like *now* — a different result than the one the
   * work's agents are already working from. The retained commit is the same fact for every later
   * attempt, so it is re-read rather than re-derived.
   *
   * Nothing here needs the predecessor's worktree to still exist, be registered or be on its
   * original branch: the snapshot, the source commit it was built on and the branch it came from
   * are all recorded in the refs and in the commit itself.
   */
  async function retainedBaseline(input: {
    projectPath: string;
    workId: string;
    predecessorWorkId: string;
    /** The predecessor worktree's index file, or `''` when that worktree is gone. */
    indexPath: string;
    sourcePath: string;
    branch: string;
    commit: string;
    sourceCommit: string;
  }): Promise<Baseline> {
    const { projectPath, workId, predecessorWorkId, indexPath, sourcePath, branch, commit, sourceCommit } = input;
    const tree = (await gitOk(projectPath, ['rev-parse', `${commit}^{tree}`])).stdout.trim();
    const entries = await treeManifest(projectPath, tree);
    return {
      projectPath,
      workId,
      headRef: branch === '' ? null : `refs/heads/${branch}`,
      headCommit: sourceCommit,
      indexPath,
      indexHash: indexPath === '' ? null : await readIndexHash(indexPath),
      manifest: entries,
      baselineCommit: commit,
      unborn: false,
      submodules: entries.filter((entry) => entry.mode === GITLINK_MODE).map((entry) => entry.path),
      baseRef: `refs/web-gpt-agent/${workId}/base`,
      predecessorWorkId,
      sourceWorktreePath: sourcePath
    };
  }

  // ------------------------------------------------------------------- worktree assignment

  function integrationBranchOf(workId: string): string {
    return `wgpt/${workId}/main`;
  }

  function workerBranchOf(workId: string, agentId: string): string {
    return `wgpt/${workId}/${agentId}`;
  }

  function integrationPathOf(workId: string): string {
    return path.join(worktreesRoot, workId, 'main');
  }

  function workerPathOf(workId: string, agentId: string): string {
    return path.join(worktreesRoot, workId, agentId);
  }

  /** Where this repository keeps its worktrees, as Git itself reports it. */
  async function worktreeList(cwd: string): Promise<Array<{ path: string; branch: string | null }>> {
    const result = await git(cwd, ['worktree', 'list', '--porcelain']);
    if (result.code !== 0) return [];
    const entries: Array<{ path: string; branch: string | null }> = [];
    let current: { path: string; branch: string | null } | null = null;
    for (const line of result.stdout.split('\n')) {
      if (line.startsWith('worktree ')) {
        if (current) entries.push(current);
        current = { path: path.resolve(line.slice('worktree '.length).trim()), branch: null };
        continue;
      }
      if (current && line.startsWith('branch ')) current.branch = line.slice('branch '.length).trim();
    }
    if (current) entries.push(current);
    return entries;
  }

  async function persistAssignment(assignment: WorktreeAssignment): Promise<WorktreeAssignment> {
    try {
      store.assignWorktree({ ...assignment });
    } catch (error) {
      // The ledger requires the agent row to exist first. Say so instead of half-creating a
      // worktree whose assignment no restart can find.
      fail('WORKTREE_FAILED', `WORKTREE_FAILED: the worktree assignment for agent ${assignment.agentId} could not be persisted, so no worktree was created.`, {
        detail: error instanceof Error ? error.message : String(error)
      });
    }
    // The durable row is the answer, not the object this call built: a caller that keeps the
    // returned record must see exactly what a restarted host would read back.
    return store.getWorktreeAssignment(assignment.workId, assignment.agentId) ?? assignment;
  }

  /**
   * Creates (or reuses) one private worktree on its own branch.
   *
   * Idempotent by design: a resumed or replaced conversation re-asks for the same agent id and
   * must land in the same worktree with the same branch and the same commits. An existing
   * worktree is returned untouched, never re-created or reset.
   */
  async function ensureWorktree(input: {
    workId: string;
    agentId: string;
    role: WorkAgentRole;
    branch: string;
    target: string;
    baseCommit: string;
    cwd: string;
    existing: WorktreeAssignment | null;
  }): Promise<WorktreeAssignment> {
    const { workId, agentId, role, branch, target, cwd } = input;
    if (input.existing && (input.existing.path !== target || input.existing.branch !== branch)) {
      // The ledger is authoritative about where this agent works. A different request would
      // silently relocate an agent mid-task, so it is refused rather than reinterpreted.
      return input.existing;
    }

    const listed = await worktreeList(cwd);
    const registered = listed.find((entry) => entry.path === path.resolve(target));
    const directoryExists = await exists(target);
    if (registered && registered.branch === `refs/heads/${branch}` && directoryExists) {
      // A retry after a failed submodule initialization lands here: the worktree exists but its
      // content may still be incomplete, so the same check runs before it is handed out again.
      await initializeSubmodules(target);
      return persistAssignment({
        workId,
        agentId,
        role,
        branch,
        path: target,
        baseCommit: input.existing?.baseCommit || input.baseCommit,
        createdAt: input.existing?.createdAt ?? now()
      });
    }

    await fs.mkdir(path.dirname(target), { recursive: true, mode: 0o700 });
    if (directoryExists && !registered) {
      // A leftover directory Git does not know about: `worktree add` would refuse it, and
      // deleting it could destroy someone's files.
      fail('WORKTREE_FAILED', `WORKTREE_FAILED: ${target} already exists but is not a worktree of this project, so it was left alone.`, {
        detail: 'Move or remove that folder and start the work again.'
      });
    }

    const add = await git(cwd, ['worktree', 'add', '-b', branch, target, input.baseCommit], { env: HOST_IDENTITY });
    if (add.code !== 0) {
      // The branch may already exist from a previous attempt while the worktree record is gone.
      const reuse = await git(cwd, ['worktree', 'add', '--force', target, branch], { env: HOST_IDENTITY });
      if (reuse.code !== 0) {
        fail('WORKTREE_FAILED', `WORKTREE_FAILED: git could not create the worktree at ${target} on ${branch} (exit ${add.code}).`, {
          detail: add.stderr.trim() || reuse.stderr.trim() || 'git produced no diagnostic'
        });
      }
    }

    await initializeSubmodules(target);
    return persistAssignment({ workId, agentId, role, branch, path: target, baseCommit: input.baseCommit, createdAt: input.existing?.createdAt ?? now() });
  }

  /**
   * Initializes the submodules a worktree needs, and only when it needs them.
   *
   * A repository whose submodules are already populated is left alone — this must not reach
   * the network for no reason. An uninitialized one is a hard failure: the worktree would be
   * missing tracked content, and pretending otherwise is how an agent edits the wrong tree.
   */
  async function initializeSubmodules(target: string): Promise<void> {
    const staged = parseStageZ((await gitOk(target, ['ls-files', '--stage', '-z'])).stdout);
    if (!staged.some((entry) => entry.mode === GITLINK_MODE)) return;
    const status = await git(target, ['submodule', 'status', '--recursive']);
    if (status.code !== 0) return;
    const uninitialized = status.stdout.split('\n').filter((line) => line.startsWith('-')).length;
    if (uninitialized === 0) return;
    const update = await git(target, ['submodule', 'update', '--init', '--recursive'], { timeoutMs: SUBMODULE_TIMEOUT_MS });
    if (update.code !== 0) {
      fail('WORKTREE_FAILED', 'WORKTREE_FAILED: this project uses submodules and they could not be initialized in the new worktree.', {
        detail: update.stderr.trim() || 'git submodule update --init --recursive failed'
      });
    }
  }

  async function ensureIntegrationWorktree(input: EnsureIntegrationInput): Promise<WorktreeAssignment> {
    projectRoots.set(input.workId, path.resolve(input.projectPath));
    const branch = integrationBranchOf(input.workId);
    const target = integrationPathOf(input.workId);
    const recorded = store.listWorktreeAssignments(input.workId).find((row) => row.role === 'prime');
    const agentId = input.agentId ?? recorded?.agentId;
    if (agentId === undefined) {
      fail('WORKTREE_FAILED', `WORKTREE_FAILED: work ${input.workId} has no prime agent, so it has no integration worktree.`, {
        detail: 'Admit the work through the work service so the prime row exists first.'
      });
    }
    return ensureWorktree({
      workId: input.workId,
      agentId,
      role: 'prime',
      branch,
      target,
      baseCommit: input.baselineCommit,
      cwd: path.resolve(input.projectPath),
      existing: store.getWorktreeAssignment(input.workId, agentId)
    });
  }

  async function createWorkerWorktree(input: CreateWorkerInput): Promise<WorktreeAssignment> {
    const recorded = store.getWorktreeAssignment(input.workId, input.agentId);
    const existing = recorded ?? null;
    const projectPath = await projectPathForWork(input.workId, existing);
    projectRoots.set(input.workId, projectPath);
    return ensureWorktree({
      workId: input.workId,
      agentId: input.agentId,
      role: 'worker',
      branch: workerBranchOf(input.workId, input.agentId),
      target: workerPathOf(input.workId, input.agentId),
      baseCommit: input.baseCommit,
      cwd: projectPath,
      existing
    });
  }

  /**
   * The repository a work belongs to.
   *
   * The ledger stores the project path per work, so a resumed worker lands in the same
   * repository without the caller having to re-supply it. When the ledger does not expose it,
   * a recorded assignment's own worktree answers the question through `--git-common-dir`.
   */
  async function projectPathForWork(workId: string, existing: WorktreeAssignment | null): Promise<string> {
    const recorded = store.getWork?.(workId)?.project_path;
    if (recorded) {
      const inside = await git(recorded, ['rev-parse', '--is-inside-work-tree']);
      if (inside.code === 0 && inside.stdout.trim() === 'true') {
        const top = (await gitOk(recorded, ['rev-parse', '--show-toplevel'])).stdout.trim();
        if (top !== '') return path.resolve(top);
      }
    }
    for (const row of [existing, ...store.listWorktreeAssignments(workId)]) {
      if (!row) continue;
      const common = await git(row.path, ['rev-parse', '--path-format=absolute', '--git-common-dir']);
      if (common.code === 0 && common.stdout.trim() !== '' && path.basename(path.resolve(common.stdout.trim())) === '.git') {
        return path.dirname(path.resolve(common.stdout.trim()));
      }
    }
    fail('WORKTREE_FAILED', `WORKTREE_FAILED: work ${workId} has no recorded project or worktree to derive one from.`, {
      detail: 'Create the integration worktree first, then the worker worktrees.'
    });
  }

  async function getWorktreeAssignment(input: { workId: string; agentId: string }): Promise<WorktreeAssignment | null> {
    return store.getWorktreeAssignment(input.workId, input.agentId) ?? null;
  }

  async function listWorktreeAssignments(input: { workId: string }): Promise<WorktreeAssignment[]> {
    return store.listWorktreeAssignments(input.workId);
  }

  async function canonicalProjectPath(workId: string): Promise<string> {
    const projectPath = store.getWork?.(workId)?.project_path ?? projectRoots.get(workId);
    if (!projectPath) {
      fail('WORKTREE_FAILED', `WORKTREE_FAILED: work ${workId} has no authoritative project path, so its recorded worktree cannot be trusted.`);
    }
    const top = await git(projectPath, ['rev-parse', '--show-toplevel']);
    if (top.code !== 0 || top.stdout.trim() === '') {
      fail('WORKTREE_FAILED', `WORKTREE_FAILED: work ${workId}'s recorded project is no longer a Git worktree.`);
    }
    return path.resolve(top.stdout.trim());
  }

  async function verifiedIntegrationLocation(workId: string): Promise<ManagedIntegration> {
    const recorded = store.listWorktreeAssignments(workId).find((row) => row.role === 'prime');
    if (!recorded) fail('WORKTREE_FAILED', `WORKTREE_FAILED: work ${workId} has no recorded integration worktree.`);
    return verifiedAssignment(await canonicalProjectPath(workId), recorded, `work ${workId}'s integration`);
  }

  async function currentIntegrationCommit(input: { workId: string }): Promise<string> {
    return (await verifiedIntegrationLocation(input.workId)).head;
  }

  /** The integration worktree and branch for a work, from the ledger when it is known. */
  function integrationLocation(workId: string): { path: string; branch: string } {
    const recorded = store.listWorktreeAssignments(workId).find((row) => row.role === 'prime');
    return {
      path: recorded?.path ?? integrationPathOf(workId),
      branch: recorded?.branch ?? integrationBranchOf(workId)
    };
  }

  // ------------------------------------------------------------------------ checkpointing

  /**
   * Commits everything in a worktree onto its own branch and reports what changed.
   *
   * The commit is built through an alternate index and published with `update-ref HEAD`, which
   * moves the branch this worktree has checked out without a checkout, a stash or a reset.
   * Nothing is pushed, merged or pruned here.
   */
  async function checkpointIntegration(input: { workId: string; message: string; baseCommit?: string }): Promise<WorktreeCheckpoint> {
    const target = await verifiedIntegrationLocation(input.workId);
    return checkpointWorktree({ path: target.path, message: input.message, baseCommit: input.baseCommit });
  }

  async function checkpointWorktree(input: CheckpointInput): Promise<WorktreeCheckpoint> {
    const cwd = path.resolve(input.path);
    const unmerged = parseStageZ((await git(cwd, ['ls-files', '-u', '-z'])).stdout);
    if (unmerged.length > 0) {
      fail('WORKTREE_FAILED', `WORKTREE_FAILED: ${cwd} has unresolved conflicts, so it cannot be checkpointed.`, {
        paths: [...new Set(unmerged.map((entry) => entry.path))]
      });
    }
    // A cherry-pick Git is still holding — including an "empty" one waiting for a decision —
    // means the recorded integration has not been settled. Committing here would record that
    // half-state as a deliberate checkpoint, so the caller reconciles or aborts first.
    if (await cherryPickInProgress(cwd)) {
      fail('INTEGRATION_UNKNOWN', `INTEGRATION_UNKNOWN: ${cwd} is in the middle of a cherry-pick, so it cannot be checkpointed.`, {
        detail: 'Settle the recorded integration (reconcile or abort) before checkpointing this worktree.'
      });
    }
    const branch = (await git(cwd, ['rev-parse', '--abbrev-ref', 'HEAD'])).stdout.trim();
    const parent = await headCommit(cwd);
    if (parent === null) {
      fail('WORKTREE_FAILED', `WORKTREE_FAILED: ${cwd} has no commit to checkpoint onto.`, {
        detail: 'A managed worktree is always created from a commit; an empty one means it was replaced.'
      });
    }
    const captured = await captureTree(cwd, { unborn: false, message: input.message, parent });
    const parentTree = (await gitOk(cwd, ['rev-parse', `${parent}^{tree}`])).stdout.trim();
    if (captured.tree === parentTree) {
      return { path: cwd, branch, commit: parent, treeHash: captured.tree, parentCommit: parent, changedFiles: [], noop: true };
    }
    await gitOk(cwd, ['update-ref', 'HEAD', captured.commit], { env: HOST_IDENTITY });
    // The worktree's own index is ours to keep coherent: without this it would still describe
    // the pre-commit state and every later diff would double-count the same change.
    await gitOk(cwd, ['read-tree', 'HEAD']);
    const base = input.baseCommit ?? parent;
    const changedFiles = parseNameStatusZ((await gitOk(cwd, ['diff', '--name-status', '-z', base, captured.commit])).stdout).map((entry) => ({
      path: entry.path,
      status: entry.status
    }));
    return { path: cwd, branch, commit: captured.commit, treeHash: captured.tree, parentCommit: parent, changedFiles, noop: false };
  }

  async function finishWorker(input: FinishWorkerInput): Promise<WorktreeCheckpoint> {
    const assignment = store.getWorktreeAssignment(input.workId, input.agentId);
    if (!assignment) {
      fail('WORKTREE_FAILED', `WORKTREE_FAILED: agent ${input.agentId} has no worktree assignment in work ${input.workId}, so there is nothing to checkpoint.`);
    }
    // Resolve the ledger-owned path again immediately before staging. The directory can be
    // replaced after assignment; branch and common-repository identity must still match.
    const target = await verifiedAssignment(
      await canonicalProjectPath(input.workId),
      assignment,
      `agent ${input.agentId} in work ${input.workId}`
    );
    // No quiescence gate here on purpose: the caller rejects `finish` while that agent has a
    // live mutating operation, and it is the only side that knows which operation belongs to
    // which agent. A second, work-wide gate in this module would refuse one worker's finish
    // because a *different* worker in the same work is busy.
    return checkpointWorktree({ path: target.path, message: input.message, baseCommit: assignment.baseCommit });
  }

  // -------------------------------------------------------------------------- integration

  async function assertQuiescent(input: { workId: string; worktreePath: string; excludeOperationId?: string }): Promise<void> {
    if (!deps.activity) return;
    if (deps.activity.isBusy({ workId: input.workId, worktreePath: input.worktreePath, ...(input.excludeOperationId === undefined ? {} : { excludeOperationId: input.excludeOperationId }) })) {
      throw new WorktreeBusyError(
        `WORKTREE_BUSY: work ${input.workId} still has a live mutation or process in ${input.worktreePath}, so the integration was not started. ` +
          'Wait for it to settle, then integrate again.'
      );
    }
  }

  function buildResult(input: {
    state: IntegrationState;
    workId: string;
    workerId: string;
    operationId: string;
    mainBefore: string;
    workerCommit: string;
    mainCommit: string | null;
    conflictFiles: string[];
    reason?: string;
  }): IntegrationResult {
    const location = integrationLocation(input.workId);
    return {
      state: input.state,
      workId: input.workId,
      workerId: input.workerId,
      operationId: input.operationId,
      mainBefore: input.mainBefore,
      workerCommit: input.workerCommit,
      mainCommit: input.mainCommit,
      conflictFiles: input.conflictFiles,
      resultPath: location.path,
      integrationBranch: location.branch,
      ...(input.reason === undefined ? {} : { reason: input.reason })
    };
  }

  async function unmergedPaths(cwd: string): Promise<string[]> {
    return [...new Set(splitNul((await git(cwd, ['diff', '--name-only', '--diff-filter=U', '-z'])).stdout))];
  }

  async function cherryPickInProgress(cwd: string): Promise<boolean> {
    const head = await git(cwd, ['rev-parse', '--verify', '--quiet', 'CHERRY_PICK_HEAD']);
    return head.code === 0;
  }

  /**
   * The commit an integration produced, recognized without replaying it.
   *
   * A crash between Git succeeding and the intent being updated leaves an intent that still
   * says `running`. Two windows have to be recognized, because Git commits before the trailer
   * is amended on:
   *
   * - `cherry-pick -x` succeeded but `commit --amend --trailer` did not: the commit records
   *   `(cherry picked from commit <worker_commit>)` in its body.
   * - Both succeeded: the commit carries the `WGPA-Integration: <operation_id>` trailer.
   *
   * Either way the commit's parent is the recorded `mainBefore`, which is what makes this a
   * statement about *this* integration rather than about some later commit.
   */
  async function recognizeIntegrationCommit(cwd: string, intent: IntegrationIntentRecord): Promise<string | null> {
    const head = await headCommit(cwd);
    if (head === null) return null;
    const parent = (await git(cwd, ['rev-parse', '--verify', '--quiet', `${head}^`])).stdout.trim();
    if (parent !== intent.mainBefore) return null;
    const message = (await git(cwd, ['log', '-1', '--format=%B', head])).stdout;
    if (message.includes(`${INTEGRATION_TRAILER}: ${intent.operationId}`)) return head;
    return message.includes(`cherry picked from commit ${intent.workerCommit}`) ? head : null;
  }

  /**
   * Settles a recorded integration against what Git actually holds.
   *
   * Returns null when no intent was ever recorded, so a caller can tell "nothing to reconcile"
   * from "reconciled into a state".
   */
  async function reconcileIntegration(input: { workId: string }): Promise<IntegrationResult | null> {
    const intent = store.getIntegrationIntent(input.workId);
    if (!intent) return null;
    const location = await verifiedIntegrationLocation(input.workId);
    const cwd = location.path;
    const base = {
      workId: intent.workId,
      workerId: intent.workerId,
      operationId: intent.operationId,
      mainBefore: intent.mainBefore,
      workerCommit: intent.workerCommit
    };

    const recognized = await recognizeIntegrationCommit(cwd, intent);
    if (recognized !== null) {
      if (intent.status !== 'merged' || intent.mainCommit !== recognized) {
        store.setIntegrationIntent(input.workId, { ...intent, status: 'merged', mainCommit: recognized, conflictFiles: [], updatedAt: now() });
      }
      return buildResult({ ...base, state: 'merged', mainCommit: recognized, conflictFiles: [] });
    }

    if (intent.status === 'conflict') {
      const conflicts = await unmergedPaths(cwd);
      if (conflicts.length > 0) return buildResult({ ...base, state: 'conflict', mainCommit: null, conflictFiles: conflicts });
      return buildResult({ ...base, state: 'unknown', mainCommit: null, conflictFiles: [], reason: 'the recorded conflict is no longer present in the worktree' });
    }

    if (intent.status === 'aborted') {
      return buildResult({ ...base, state: 'aborted', mainCommit: null, conflictFiles: [] });
    }

    if (intent.status === 'running') {
      if (await cherryPickInProgress(cwd)) {
        const conflicts = await unmergedPaths(cwd);
        if (conflicts.length > 0) {
          store.setIntegrationIntent(input.workId, { ...intent, status: 'conflict', conflictFiles: conflicts, updatedAt: now() });
          return buildResult({ ...base, state: 'conflict', mainCommit: null, conflictFiles: conflicts });
        }
        return buildResult({ ...base, state: 'unknown', mainCommit: null, conflictFiles: [], reason: 'a cherry-pick is in progress but its state is not one this work started' });
      }
      const head = await headCommit(cwd);
      if (head === intent.mainBefore) {
        // Git never moved: the pick did not take effect, so the intent can be retried safely.
        return buildResult({ ...base, state: 'noop', mainCommit: null, conflictFiles: [], reason: 'the recorded integration never changed the branch' });
      }
      store.setIntegrationIntent(input.workId, { ...intent, status: 'unknown', conflictFiles: [], updatedAt: now() });
      return buildResult({
        ...base,
        state: 'unknown',
        mainCommit: head,
        conflictFiles: [],
        reason: 'the integration branch moved without a recognizable integration commit'
      });
    }

    return buildResult({ ...base, state: 'unknown', mainCommit: intent.mainCommit, conflictFiles: intent.conflictFiles, reason: `the recorded integration is ${intent.status}` });
  }

  async function integrate(input: IntegrateInput): Promise<IntegrationResult> {
    if (integrationLocks.has(input.workId)) {
      throw new WorktreeBusyError(
        `WORKTREE_BUSY: an integration for work ${input.workId} is already running. Only one integration per work is allowed at a time; wait for it to finish.`
      );
    }
    integrationLocks.add(input.workId);
    try {
      const location = await verifiedIntegrationLocation(input.workId);
      const cwd = location.path;
      if (!(await exists(cwd))) {
        fail('WORKTREE_FAILED', `WORKTREE_FAILED: the integration worktree for work ${input.workId} does not exist at ${cwd}.`, {
          detail: 'Create it before integrating a worker.'
        });
      }
      // The integrate receipt itself is `running` while this handler runs, so it is named as
      // the exclusion rather than relied on from a mutable module-level slot.
      await assertQuiescent({ workId: input.workId, worktreePath: cwd, excludeOperationId: input.operationId });

      // Anything already in flight is settled first. Stacking a second cherry-pick on an
      // unresolved one is how a worktree ends up in a state no receipt describes.
      const pending = store.getIntegrationIntent(input.workId);
      if (pending && pending.status === 'running') {
        const settled = await reconcileIntegration({ workId: input.workId });
        if (settled && settled.state !== 'noop') {
          if (settled.operationId === input.operationId && settled.state === 'merged') return settled;
          fail(
            'INTEGRATION_UNKNOWN',
            `INTEGRATION_UNKNOWN: work ${input.workId} has an unresolved integration (${settled.state}) that must be reconciled before another one starts.`,
            { detail: settled.reason ?? 'Resolve or abort the recorded integration first.' }
          );
        }
      }
      if (pending && pending.status === 'unknown' && pending.operationId === input.operationId) {
        // A recorded `unknown` only blocks a retry when there is evidence the pick may have
        // applied: the branch moved past the recorded point, or Git still holds a pick. When
        // neither is true — a refusal before Git ran, for instance — retrying is safe and
        // refusing here would strand the work behind an abort it does not need.
        const head = await headCommit(cwd);
        const moved = head !== null && head !== pending.mainBefore;
        if (moved || (await cherryPickInProgress(cwd))) {
          fail(
            'INTEGRATION_UNKNOWN',
            `INTEGRATION_UNKNOWN: operation ${input.operationId} left work ${input.workId} in an unresolved state and will not be applied again.`,
            { detail: 'Inspect the integration worktree, then abort the recorded integration or integrate the worker under a new operation id.' }
          );
        }
      }
      if (await cherryPickInProgress(cwd)) {
        const conflicts = await unmergedPaths(cwd);
        fail(
          'INTEGRATION_UNKNOWN',
          `INTEGRATION_UNKNOWN: the integration worktree for work ${input.workId} is in the middle of a cherry-pick this app did not record. Nothing was applied.`,
          { paths: conflicts }
        );
      }

      const mainBefore = await headCommit(cwd);
      if (mainBefore === null) fail('WORKTREE_FAILED', `WORKTREE_FAILED: the integration worktree for work ${input.workId} has no commit.`);

      const ancestor = await git(cwd, ['merge-base', '--is-ancestor', input.workerCommit, 'HEAD']);
      if (ancestor.code === 0) {
        return buildResult({
          state: 'already-applied',
          workId: input.workId,
          workerId: input.workerId,
          operationId: input.operationId,
          mainBefore,
          workerCommit: input.workerCommit,
          mainCommit: mainBefore,
          conflictFiles: [],
          reason: 'the worker commit is already in the integration branch'
        });
      }
      const cherry = await git(cwd, ['cherry', 'HEAD', input.workerCommit]);
      if (cherry.code === 0 && cherry.stdout.split('\n').some((line) => line.startsWith('- ') && line.includes(input.workerCommit))) {
        return buildResult({
          state: 'already-applied',
          workId: input.workId,
          workerId: input.workerId,
          operationId: input.operationId,
          mainBefore,
          workerCommit: input.workerCommit,
          mainCommit: mainBefore,
          conflictFiles: [],
          reason: 'this change is already present in the integration branch'
        });
      }

      const startedAt = now();
      const intent: IntegrationIntentRecord = {
        workId: input.workId,
        operationId: input.operationId,
        workerId: input.workerId,
        workerCommit: input.workerCommit,
        mainBefore,
        status: 'running',
        conflictFiles: [],
        mainCommit: null,
        ...(input.runId === undefined ? {} : { runId: input.runId }),
        startedAt,
        updatedAt: startedAt
      };
      // The intent is durable before Git is asked to do anything: a crash after this point is
      // reconciled from the commit, and a crash before it leaves no trace to confuse.
      store.setIntegrationIntent(input.workId, intent);

      const pick = await git(cwd, ['cherry-pick', '-x', input.workerCommit], { env: HOST_IDENTITY });
      if (pick.code === 0) {
        // The change is in. The trailer is a recovery aid, not the record of truth, so a failed
        // amend must not be reported as an unknown outcome: the commit is already recognizable
        // by its `cherry picked from` line and its recorded parent.
        const amended = await git(cwd, ['commit', '--amend', '--no-edit', '--trailer', `${INTEGRATION_TRAILER}: ${input.operationId}`], { env: HOST_IDENTITY });
        const mainCommit = await headCommit(cwd);
        if (mainCommit === null) {
          fail('INTEGRATION_UNKNOWN', `INTEGRATION_UNKNOWN: the change applied to ${cwd} but the integration branch has no commit to record.`, {
            detail: 'git reported success yet HEAD is unreadable'
          });
        }
        store.setIntegrationIntent(input.workId, { ...intent, status: 'merged', mainCommit, updatedAt: now() });
        return buildResult({
          state: 'merged',
          workId: input.workId,
          workerId: input.workerId,
          operationId: input.operationId,
          mainBefore,
          workerCommit: input.workerCommit,
          mainCommit,
          conflictFiles: [],
          ...(amended.code === 0
            ? {}
            : { reason: `the change applied, but its recovery trailer could not be written (exit ${amended.code}); it is still recognized by its recorded parent` })
        });
      }

      const conflicts = await unmergedPaths(cwd);
      if (conflicts.length > 0) {
        store.setIntegrationIntent(input.workId, { ...intent, status: 'conflict', conflictFiles: conflicts, updatedAt: now() });
        return buildResult({
          state: 'conflict',
          workId: input.workId,
          workerId: input.workerId,
          operationId: input.operationId,
          mainBefore,
          workerCommit: input.workerCommit,
          mainCommit: null,
          conflictFiles: conflicts,
          reason: 'the worker change conflicts with the integration branch; resolve it in the integration worktree'
        });
      }

      // No unmerged paths and a non-zero exit has two very different meanings, and only
      // `CHERRY_PICK_HEAD` tells them apart: an empty pick Git is holding for a decision, or a
      // pick Git refused outright (a dirty integration worktree, most often). Reporting the
      // second as a successful no-op would claim an integration that never happened.
      if (!(await cherryPickInProgress(cwd))) {
        fail('WORKTREE_FAILED', `WORKTREE_FAILED: git cherry-pick refused to apply ${input.workerCommit} in ${cwd} (exit ${pick.code}).`, {
          detail: pick.stderr.trim() || pick.stdout.trim() || 'git produced no diagnostic'
        });
      }
      await git(cwd, ['cherry-pick', '--skip']);
      store.setIntegrationIntent(input.workId, { ...intent, status: 'merged', mainCommit: mainBefore, conflictFiles: [], updatedAt: now() });
      return buildResult({
        state: 'noop',
        workId: input.workId,
        workerId: input.workerId,
        operationId: input.operationId,
        mainBefore,
        workerCommit: input.workerCommit,
        mainCommit: mainBefore,
        conflictFiles: [],
        reason: 'the worker change produced no difference against the integration branch'
      });
    } finally {
      integrationLocks.delete(input.workId);
    }
  }

  async function abortIntegration(input: { workId: string }): Promise<IntegrationResult> {
    if (integrationLocks.has(input.workId)) {
      throw new WorktreeBusyError(`WORKTREE_BUSY: an integration for work ${input.workId} is running; it must finish before it can be aborted.`);
    }
    integrationLocks.add(input.workId);
    try {
      const location = await verifiedIntegrationLocation(input.workId);
      const intent = store.getIntegrationIntent(input.workId);
      const inProgress = await cherryPickInProgress(location.path);
      if (inProgress) {
        const aborted = await git(location.path, ['cherry-pick', '--abort']);
        if (aborted.code !== 0) {
          fail('WORKTREE_FAILED', `WORKTREE_FAILED: the cherry-pick in ${location.path} could not be aborted (exit ${aborted.code}).`, {
            detail: aborted.stderr.trim() || 'git cherry-pick --abort failed'
          });
        }
      }
      const mainCommit = await headCommit(location.path);
      const base = {
        workId: input.workId,
        workerId: intent?.workerId ?? '',
        operationId: intent?.operationId ?? '',
        mainBefore: intent?.mainBefore ?? mainCommit ?? '',
        workerCommit: intent?.workerCommit ?? '',
        mainCommit,
        conflictFiles: []
      };
      if (intent) store.setIntegrationIntent(input.workId, { ...intent, status: 'aborted', conflictFiles: [], mainCommit, updatedAt: now() });
      return buildResult({
        state: 'aborted',
        ...base,
        ...(inProgress ? {} : { reason: 'no cherry-pick was in progress; the recorded integration was marked aborted' })
      });
    } finally {
      integrationLocks.delete(input.workId);
    }
  }

  // ------------------------------------------------------------------- hashes and summaries

  async function changedFileSummary(input: { path: string; baseCommit: string }): Promise<ChangedFile[]> {
    const cwd = path.resolve(input.path);
    const head = await headCommit(cwd);
    if (head === null) fail('WORKTREE_FAILED', `WORKTREE_FAILED: ${cwd} has no commit to summarize.`);
    return parseNameStatusZ((await gitOk(cwd, ['diff', '--name-status', '-z', input.baseCommit, head])).stdout).map((entry) => ({
      path: entry.path,
      status: entry.status
    }));
  }

  /**
   * Compares recorded blob hashes against the worktree's current files.
   *
   * This is what patch recovery uses: a patch records the hash of every path before and after
   * it ran, and after a host restart those hashes — not a guess — decide whether the write
   * happened. Symlinks hash their link text, exactly as the baseline manifest does.
   */
  async function verifyHashes(input: { path: string; expected: Record<string, string | null> }): Promise<Array<{ path: string; expected: string | null; actual: string | null; match: boolean }>> {
    const cwd = path.resolve(input.path);
    const format = await objectFormat(cwd);
    const results: Array<{ path: string; expected: string | null; actual: string | null; match: boolean }> = [];
    for (const [relative, expected] of Object.entries(input.expected)) {
      const absolute = path.join(cwd, relative);
      let actual: string | null = null;
      try {
        const stat = await fs.lstat(absolute);
        if (stat.isSymbolicLink()) actual = gitBlobHash(await fs.readlink(absolute), format);
        else if (stat.isFile()) {
          const hashed = await git(cwd, ['hash-object', `--path=${relative}`, '--', relative]);
          actual = hashed.code === 0 ? hashed.stdout.trim() : null;
        }
      } catch {
        actual = null;
      }
      results.push({ path: relative, expected, actual, match: actual === expected });
    }
    return results;
  }

  return {
    captureBaseline,
    captureSuccessorBaseline,
    ensureIntegrationWorktree,
    createWorkerWorktree,
    getWorktreeAssignment,
    listWorktreeAssignments,
    currentIntegrationCommit,
    checkpointIntegration,
    checkpointWorktree,
    finishWorker,
    integrate,
    reconcileIntegration,
    abortIntegration,
    assertQuiescent,
    changedFileSummary,
    verifyHashes
  };
}
