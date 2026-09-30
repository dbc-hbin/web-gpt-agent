/**
 * The worktree engine against real Git repositories.
 *
 * These are not fixture-shaped unit tests: every case below runs the real `git` binary against
 * a real temporary repository, because the properties being defended are exactly the ones a
 * mock cannot have — that the user's index and HEAD are untouched, that a snapshot of a dirty
 * working tree survives a worktree hop byte-for-byte, that a cherry-pick conflict is visible
 * and abortable, and that a crash between Git succeeding and the receipt being written is
 * recognized instead of applied twice.
 */

import { execFileSync } from 'node:child_process';
import { createHash, randomUUID } from 'node:crypto';
import { chmodSync, mkdirSync, promises as fs, symlinkSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';
import {
  WorktreeBusyError,
  WorktreeError,
  createWorktreeManager,
  type GitCommand,
  type GitRunner,
  type WorktreeActivityProbe,
  type WorktreeManager
} from '../src/main/work/worktrees.js';
import { createWorkStore, type WorkStore } from '../src/main/work/store.js';
import { createWorktreeActivityProbe } from '../src/main/work/runtime.js';
import { makeTempDir, removeTempDir } from './helpers.js';

const directories: string[] = [];
const stores: WorkStore[] = [];

afterAll(async () => {
  for (const store of stores) store.close();
  for (const directory of directories) await removeTempDir(directory);
});

// ---------------------------------------------------------------------------- git fixtures

function git(cwd: string, args: readonly string[]): string {
  return execFileSync('git', [...args], {
    cwd,
    encoding: 'utf8',
    // Several fixtures run Git commands that are *expected* to fail (an unborn HEAD, a
    // conflicting cherry-pick). Their diagnostics are asserted on, not printed.
    stdio: ['ignore', 'pipe', 'pipe'],
    env: {
      ...process.env,
      GIT_AUTHOR_NAME: 'Fixture',
      GIT_AUTHOR_EMAIL: 'fixture@example.test',
      GIT_COMMITTER_NAME: 'Fixture',
      GIT_COMMITTER_EMAIL: 'fixture@example.test',
      GIT_TERMINAL_PROMPT: '0'
    }
  });
}

/** Writes a fixture file, creating its parents. No shell is involved in any fixture. */
function write(root: string, relative: string, content: string): void {
  const target = path.join(root, relative);
  mkdirSync(path.dirname(target), { recursive: true });
  writeFileSync(target, content);
}

/** A real symlink, so the manifest and the captured tree must agree on mode `120000`. */
function symlink(root: string, target: string, link: string): void {
  symlinkSync(target, path.join(root, link));
}

async function repository(files: Record<string, string> = { 'f.txt': 'l1\nl2\nl3\n' }): Promise<string> {
  const root = await makeTempDir('wgpt-wt-');
  directories.push(root);
  git(root, ['init', '-q', '-b', 'main']);
  for (const [relative, content] of Object.entries(files)) write(root, relative, content);
  git(root, ['add', '-A']);
  git(root, ['commit', '-qm', 'base']);
  return root;
}

async function ledger(): Promise<{ store: WorkStore; dir: string }> {
  const dir = await makeTempDir('wgpt-wt-store-');
  directories.push(dir);
  const store = createWorkStore({ dataDir: dir });
  stores.push(store);
  return { store, dir };
}

/**
 * A work plus its prime and worker agent rows, which every assignment depends on.
 *
 * `projectPath` is the real fixture repository: the ledger records the canonical project per
 * work, and that is where a worker worktree derives its repository from.
 */
function seed(store: WorkStore, workerIds: readonly string[] = [], projectPath = '/tmp/fixture'): { workId: string; primeId: string } {
  return addWork(store, projectPath, workerIds);
}

/**
 * The successor of an existing work, linked through the ledger exactly as admission links it.
 *
 * The link is the ledger's fact, not the caller's: a continuation is only legitimate when both
 * rows name each other, which is what `captureSuccessorBaseline` reads.
 */
function continuation(store: WorkStore, predecessorWorkId: string, projectPath: string): { workId: string; primeId: string } {
  const next = addWork(store, projectPath);
  store.linkContinuation(predecessorWorkId, next.workId);
  return next;
}

/** A second work in the same ledger, which is what a continuation needs. */
function addWork(store: WorkStore, projectPath: string, workerIds: readonly string[] = []): { workId: string; primeId: string } {
  const workId = randomUUID();
  const primeId = randomUUID();
  const at = Date.now();
  store.insertWork({
    work_id: workId,
    title: 'Worktree fixture',
    goal: 'Exercise the worktree engine.',
    project_path: projectPath,
    project_name: null,
    base_commit: null,
    integration_branch: `wgpt/${workId}/main`,
    integration_worktree: null,
    status: 'running',
    desired_state: null,
    prime_agent_id: primeId,
    prime_session_id: null,
    model: null,
    reasoning: null,
    max_workers: 2,
    revision: 0,
    blocker: null,
    checkpoint: null,
    integration_intent: null,
    predecessor_work_id: null,
    successor_work_id: null,
    created_at: at,
    updated_at: at
  });
  const agent = (agentId: string, role: 'prime' | 'worker'): void =>
    store.insertAgent({
      agent_id: agentId,
      work_id: workId,
      parent_id: role === 'worker' ? primeId : null,
      role,
      label: role,
      state: 'active',
      session_id: null,
      conversation_id: null,
      generation: 0,
      worktree_path: null,
      branch: null,
      base_commit: null,
      model: null,
      reasoning: null,
      result_ref: null,
      checkpoint_ref: null,
      created_at: at,
      updated_at: at
    });
  agent(primeId, 'prime');
  for (const workerId of workerIds) agent(workerId, 'worker');
  return { workId, primeId };
}

function manager(
  store: WorkStore,
  userDataDir: string,
  options: {
    runGit?: GitRunner;
    activity?: WorktreeActivityProbe;
  } = {}
): WorktreeManager {
  return createWorktreeManager({
    userDataDir,
    worktreesRoot: path.join(userDataDir, 'worktrees'),
    store,
    sleep: async () => undefined,
    ...(options.runGit ? { runGit: options.runGit } : {}),
    ...(options.activity ? { activity: options.activity } : {})
  });
}

async function indexHash(root: string): Promise<string | null> {
  const indexPath = git(root, ['rev-parse', '--path-format=absolute', '--git-path', 'index']).trim();
  try {
    return createHash('sha256').update(await fs.readFile(indexPath)).digest('hex');
  } catch {
    return null;
  }
}

/** Everything about the source checkout a snapshot must leave exactly as it found it. */
async function sourceState(root: string): Promise<{ head: string; branch: string; index: string | null; refs: string; status: string }> {
  return {
    head: git(root, ['rev-parse', 'HEAD']).trim(),
    branch: git(root, ['symbolic-ref', '-q', 'HEAD']).trim(),
    index: await indexHash(root),
    // The app's own `wgpt/*` branches are the one thing it is allowed to add; every branch that
    // existed before must still point exactly where it did.
    refs: userRefs(root),
    status: git(root, ['status', '--porcelain', '-uall'])
  };
}

/**
 * Every branch the app did not create, with its exact object id.
 *
 * `wgpt/*` is the one namespace this app owns — its integration and worker branches — so the
 * source-checkout comparison excludes it and checks everything else to the byte.
 */
function userRefs(root: string): string {
  return git(root, ['for-each-ref', '--format=%(refname) %(objectname)', 'refs/heads'])
    .split('\n')
    .filter((line) => line !== '' && !line.startsWith('refs/heads/wgpt/'))
    .sort()
    .join('\n');
}

// ------------------------------------------------------------------------------- baselines

describe('baseline capture', () => {
  it('captures staged, unstaged, untracked, symlinks and modes without touching the source', async () => {
    const root = await repository({ 'f.txt': 'l1\nl2\nl3\n', 'exec.sh': '#!/bin/sh\n' });
    write(root, 'f.txt', 'l1\nSTAGED\nl3\n');
    git(root, ['add', 'f.txt']);
    write(root, 'f.txt', 'l1\nSTAGED-AND-DIRTY\nl3\n');
    write(root, 'untracked/nested.txt', 'untracked\n');
    symlink(root, 'f.txt', 'link.txt');
    chmodSync(path.join(root, 'exec.sh'), 0o755);
    // A nonignored untracked file that must NOT be dropped, and an ignored one that must not be copied.
    write(root, '.gitignore', 'ignored.txt\n');
    write(root, 'ignored.txt', 'ignored\n');

    const { store, dir } = await ledger();
    const { workId } = seed(store);
    const before = await sourceState(root);

    const baseline = await manager(store, dir).captureBaseline({ projectPath: root, workId });

    expect(baseline.unborn).toBe(false);
    expect(baseline.baselineCommit).toMatch(/^[0-9a-f]{40}$/);
    expect(baseline.headCommit).toBe(before.head);
    expect(baseline.headRef).toBe('refs/heads/main');
    expect(baseline.indexHash).toBe(before.index);

    // The captured tree carries the dirty state exactly, including the symlink and the mode.
    const entries = new Map(
      git(root, ['ls-tree', '-r', '-z', baseline.baselineCommit]).split('\0').filter(Boolean).map((record) => {
        const [meta = '', name = ''] = record.split('\t');
        const [mode = '', , hash = ''] = meta.split(' ');
        return [name, { mode, hash }] as const;
      })
    );
    expect(entries.get('f.txt')?.hash).toBe(git(root, ['hash-object', '--path=f.txt', '--', 'f.txt']).trim());
    expect(entries.get('untracked/nested.txt')?.mode).toBe('100644');
    expect(entries.get('link.txt')?.mode).toBe('120000');
    // A working-tree chmod is only a mode change where Git honours the executable bit. Git for
    // Windows initializes repositories with `core.fileMode=false`, and there the bit is not a fact
    // Git records, so the recorded `100644` is what a faithful capture must keep.
    const honorsFileMode = git(root, ['config', '--bool', 'core.fileMode']).trim() !== 'false';
    expect(entries.get('exec.sh')?.mode).toBe(honorsFileMode ? '100755' : '100644');
    expect(entries.has('ignored.txt')).toBe(false);
    // The manifest the caller sees agrees with the commit it produced.
    expect(baseline.manifest.find((entry) => entry.path === 'link.txt')?.hash).toBe(entries.get('link.txt')?.hash);

    // The source checkout is byte-for-byte what it was: HEAD, branch, index, working files.
    const after = await sourceState(root);
    expect(after.head).toBe(before.head);
    expect(after.branch).toBe(before.branch);
    expect(after.index).toBe(before.index);
    expect(after.status).toBe(before.status);
    expect(userRefs(root)).toBe(before.refs);
    // The only ref it adds is its own.
    expect(git(root, ['rev-parse', baseline.baseRef ?? '']).trim()).toBe(baseline.baselineCommit);
    expect(git(root, ['for-each-ref', '--format=%(refname)', 'refs/web-gpt-agent']).trim()).toBe(`refs/web-gpt-agent/${workId}/base`);
  });

  it('keeps a recorded executable mode when the repository ignores the filesystem bit', async () => {
    // `core.fileMode=false` is Git for Windows' default: the index, not `stat`, owns the mode.
    const root = await repository({ 'tool.sh': '#!/bin/sh\n', 'plain.txt': 'plain\n' });
    git(root, ['config', 'core.fileMode', 'false']);
    git(root, ['update-index', '--chmod=+x', 'tool.sh']);
    git(root, ['commit', '-qm', 'recorded executable']);
    // Neither the filesystem bit of a recorded script nor that of a new file is a mode change here.
    chmodSync(path.join(root, 'tool.sh'), 0o644);
    write(root, 'new.sh', '#!/bin/sh\n');
    chmodSync(path.join(root, 'new.sh'), 0o755);

    const { store, dir } = await ledger();
    const { workId } = seed(store);
    const baseline = await manager(store, dir).captureBaseline({ projectPath: root, workId });

    const modes = new Map(baseline.manifest.map((entry) => [entry.path, entry.mode]));
    expect(modes.get('tool.sh')).toBe('100755');
    expect(modes.get('plain.txt')).toBe('100644');
    expect(modes.get('new.sh')).toBe('100644');
    expect(git(root, ['ls-tree', baseline.baselineCommit, 'tool.sh']).split(' ')[0]).toBe('100755');
  });

  it('carries staged mode changes when the repository ignores the filesystem bit', async () => {
    const root = await repository({ 'up.sh': '#!/bin/sh\n', 'down.sh': '#!/bin/sh\n' });
    git(root, ['config', 'core.fileMode', 'false']);
    git(root, ['update-index', '--chmod=+x', 'down.sh']);
    git(root, ['commit', '-qm', 'down.sh executable']);
    // Staged only: the filesystem bit cannot express either change under core.fileMode=false.
    git(root, ['update-index', '--chmod=+x', 'up.sh']);
    git(root, ['update-index', '--chmod=-x', 'down.sh']);
    write(root, 'added.sh', '#!/bin/sh\n');
    git(root, ['add', 'added.sh']);
    git(root, ['update-index', '--chmod=+x', 'added.sh']);
    const indexBefore = git(root, ['ls-files', '--stage']);

    const { store, dir } = await ledger();
    const { workId } = seed(store);
    const baseline = await manager(store, dir).captureBaseline({ projectPath: root, workId });

    const recorded = (file: string) => git(root, ['ls-tree', baseline.baselineCommit, file]).split(' ')[0];
    expect(recorded('up.sh')).toBe('100755');
    expect(recorded('down.sh')).toBe('100644');
    expect(recorded('added.sh')).toBe('100755');
    expect(git(root, ['ls-files', '--stage'])).toBe(indexBefore);
  });

  it('captures an unborn repository from an empty tree and leaves HEAD unborn', async () => {
    const root = await makeTempDir('wgpt-wt-unborn-');
    directories.push(root);
    git(root, ['init', '-q', '-b', 'main']);
    write(root, 'first.txt', 'content\n');

    const { store, dir } = await ledger();
    const { workId } = seed(store);
    const baseline = await manager(store, dir).captureBaseline({ projectPath: root, workId });

    expect(baseline.unborn).toBe(true);
    expect(baseline.headCommit).toBeNull();
    expect(baseline.headRef).toBe('refs/heads/main');
    expect(baseline.manifest.map((entry) => entry.path)).toContain('first.txt');
    expect(git(root, ['ls-tree', '--name-only', baseline.baselineCommit]).trim()).toBe('first.txt');
    expect(() => git(root, ['rev-parse', '--verify', 'HEAD'])).toThrow();
    expect(git(root, ['status', '--porcelain'])).toContain('first.txt');
  });

  it('refuses a sparse checkout, an unmerged index and a dirty submodule with their paths', async () => {
    const sparse = await repository({ 'keep/kept.txt': 'a\n', 'other/dropped.txt': 'b\n' });
    git(sparse, ['sparse-checkout', 'set', 'keep']);
    const { store, dir } = await ledger();
    const { workId } = seed(store);
    await expect(manager(store, dir).captureBaseline({ projectPath: sparse, workId })).rejects.toMatchObject({
      code: 'PROJECT_SNAPSHOT_UNSUPPORTED'
    });

    const unmerged = await repository();
    git(unmerged, ['checkout', '-q', '-b', 'side']);
    write(unmerged, 'f.txt', 'l1\nSIDE\nl3\n');
    git(unmerged, ['commit', '-qam', 'side']);
    git(unmerged, ['checkout', '-q', 'main']);
    write(unmerged, 'f.txt', 'l1\nMAIN\nl3\n');
    git(unmerged, ['commit', '-qam', 'main']);
    try {
      git(unmerged, ['cherry-pick', 'side']);
    } catch {
      /* The conflict is the fixture. */
    }
    const unmergedError = await manager(store, dir).captureBaseline({ projectPath: unmerged, workId }).catch((error: unknown) => error);
    expect(unmergedError).toBeInstanceOf(WorktreeError);
    expect((unmergedError as WorktreeError).code).toBe('PROJECT_SNAPSHOT_UNSUPPORTED');
    expect((unmergedError as WorktreeError).paths).toContain('f.txt');

    const submodule = await repository({ 'root.txt': 'a\n' });
    const inner = await repository({ 'inner.txt': 'i\n' });
    git(submodule, ['-c', 'protocol.file.allow=always', 'submodule', 'add', '-q', inner, 'sub']);
    git(submodule, ['commit', '-qm', 'add submodule']);
    // A clean submodule is preserved as a gitlink and named, not copied or dropped.
    const clean = await manager(store, dir).captureBaseline({ projectPath: submodule, workId });
    expect(clean.submodules).toEqual(['sub']);
    expect(clean.manifest.find((entry) => entry.path === 'sub')?.mode).toBe('160000');
    expect(git(submodule, ['ls-tree', clean.baselineCommit, 'sub']).trim()).toBe(git(submodule, ['ls-tree', 'HEAD', 'sub']).trim());
    write(path.join(submodule, 'sub'), 'inner.txt', 'dirty\n');
    const submoduleError = await manager(store, dir).captureBaseline({ projectPath: submodule, workId }).catch((error: unknown) => error);
    expect((submoduleError as WorktreeError).code).toBe('PROJECT_SNAPSHOT_UNSUPPORTED');
    expect((submoduleError as WorktreeError).paths).toEqual(['sub']);
  });

  it('refuses to hand out a worktree whose submodules cannot be initialized', async () => {
    const root = await repository({ 'root.txt': 'a\n' });
    const inner = await repository({ 'inner.txt': 'i\n' });
    git(root, ['-c', 'protocol.file.allow=always', 'submodule', 'add', '-q', inner, 'sub']);
    git(root, ['commit', '-qm', 'add submodule']);

    const { store, dir } = await ledger();
    const { workId, primeId } = seed(store);
    const engine = manager(store, dir);
    const baseline = await engine.captureBaseline({ projectPath: root, workId });
    expect(baseline.submodules).toEqual(['sub']);

    // A worktree of this repository starts with the submodule uninitialized, and the fixture's
    // transport is the `file` protocol, which Git refuses for a host-owned background command.
    // The worktree must not be handed out as if it were complete.
    const error = await engine
      .ensureIntegrationWorktree({ workId, projectPath: root, baselineCommit: baseline.baselineCommit, agentId: primeId })
      .catch((thrown: unknown) => thrown);
    expect((error as WorktreeError).code).toBe('WORKTREE_FAILED');
    expect((error as WorktreeError).message).toContain('submodules');
    // Nothing was assigned, so no bootstrap can name a half-populated worktree.
    expect(store.getWorktreeAssignment(workId, primeId)).toBeNull();
    // A retry reuses the directory Git already registered and fails the same way, rather than
    // reporting success because a directory happens to exist.
    await expect(
      engine.ensureIntegrationWorktree({ workId, projectPath: root, baselineCommit: baseline.baselineCommit, agentId: primeId })
    ).rejects.toMatchObject({ code: 'WORKTREE_FAILED' });
    expect(store.getWorktreeAssignment(workId, primeId)).toBeNull();
  });

  it('refuses a non-Git folder with PROJECT_NOT_GIT', async () => {
    const plain = await makeTempDir('wgpt-wt-plain-');
    directories.push(plain);
    const { store, dir } = await ledger();
    await expect(manager(store, dir).captureBaseline({ projectPath: plain })).rejects.toMatchObject({ code: 'PROJECT_NOT_GIT' });
  });

  it('retries a transiently changing checkout and then blocks instead of mixing versions', async () => {
    const root = await repository();
    const { store, dir } = await ledger();
    const { workId } = seed(store);

    // A checkout that moves under the capture exactly once: the retry must succeed.
    let moves = 0;
    const once: GitRunner = async (command: GitCommand) => {
      const result = await realRunner(command);
      if (command.args.includes('write-tree') && moves === 0) {
        moves += 1;
        git(root, ['commit', '-q', '--allow-empty', '-m', 'moved once']);
      }
      return result;
    };
    const baseline = await manager(store, dir, { runGit: once }).captureBaseline({ projectPath: root, workId });
    expect(baseline.baselineCommit).toMatch(/^[0-9a-f]{40}$/);
    expect(moves).toBe(1);

    // A checkout that never settles: one attempt plus three retries, then a blocked work.
    let attempts = 0;
    const always: GitRunner = async (command: GitCommand) => {
      const result = await realRunner(command);
      if (command.args.includes('write-tree')) {
        attempts += 1;
        git(root, ['commit', '-q', '--allow-empty', '-m', `moved ${attempts}`]);
      }
      return result;
    };
    const error = await manager(store, dir, { runGit: always }).captureBaseline({ projectPath: root, workId }).catch((thrown: unknown) => thrown);
    expect((error as WorktreeError).code).toBe('PROJECT_CHANGED_DURING_SNAPSHOT');
    expect(attempts).toBe(4);
  });
});

/** The production runner, re-created here so a wrapper can delegate to it. */
const realRunner: GitRunner = (command) =>
  Promise.resolve().then(() => {
    try {
      const stdout = execFileSync('git', [...command.args], {
        cwd: command.cwd,
        encoding: 'utf8',
        env: { ...process.env, ...command.env },
        input: command.input ?? ''
      });
      return { code: 0, stdout, stderr: '' };
    } catch (error) {
      const failure = error as { status?: number; stdout?: string; stderr?: string };
      return { code: failure.status ?? 1, stdout: failure.stdout ?? '', stderr: failure.stderr ?? '' };
    }
  });

// ------------------------------------------------------------------- assignments and isolation

describe('worktrees and integration', () => {
  it('isolates two divergent workers and merges both results without touching the source', async () => {
    const root = await repository();
    const { store, dir } = await ledger();
    const workerA = randomUUID();
    const workerB = randomUUID();
    const { workId, primeId } = seed(store, [workerA, workerB], root);
    const engine = manager(store, dir);

    const baseline = await engine.captureBaseline({ projectPath: root, workId });
    const integration = await engine.ensureIntegrationWorktree({ workId, projectPath: root, baselineCommit: baseline.baselineCommit, agentId: primeId });
    expect(integration.branch).toBe(`wgpt/${workId}/main`);
    expect(integration.path).toBe(path.join(dir, 'worktrees', workId, 'main'));
    expect(integration.role).toBe('prime');
    // The assignment is durable before any bootstrap could be sent.
    expect(store.getWorktreeAssignment(workId, primeId)?.path).toBe(integration.path);

    const a = await engine.createWorkerWorktree({ workId, agentId: workerA, baseCommit: baseline.baselineCommit });
    const b = await engine.createWorkerWorktree({ workId, agentId: workerB, baseCommit: baseline.baselineCommit });
    expect(a.branch).toBe(`wgpt/${workId}/${workerA}`);
    expect(a.path).not.toBe(b.path);
    expect(store.getWorktreeAssignment(workId, workerA)?.branch).toBe(a.branch);

    const sourceBefore = await sourceState(root);

    write(a.path, 'from-a.txt', 'A\n');
    write(b.path, 'from-b.txt', 'B\n');
    const finishedA = await engine.finishWorker({ workId, agentId: workerA, message: 'worker A' });
    const finishedB = await engine.finishWorker({ workId, agentId: workerB, message: 'worker B' });
    expect(finishedA.noop).toBe(false);
    expect(finishedA.changedFiles.map((file) => file.path)).toEqual(['from-a.txt']);
    expect(finishedA.parentCommit).toBe(baseline.baselineCommit);

    const mergedA = await engine.integrate({ workId, workerId: workerA, workerCommit: finishedA.commit, operationId: randomUUID() });
    expect(mergedA.state).toBe('merged');
    expect(mergedA.resultPath).toBe(integration.path);
    const mergedB = await engine.integrate({ workId, workerId: workerB, workerCommit: finishedB.commit, operationId: randomUUID() });
    expect(mergedB.state).toBe('merged');

    const tree = git(integration.path, ['ls-tree', '-r', '--name-only', 'HEAD']).trim().split('\n');
    expect(tree).toContain('from-a.txt');
    expect(tree).toContain('from-b.txt');
    // The branch starts at the private baseline snapshot, then carries each worker's change.
    expect(git(integration.path, ['log', '--format=%s']).trim().split('\n')).toEqual([
      'worker B',
      'worker A',
      `web-gpt-agent baseline for work ${workId}`,
      'base'
    ]);
    expect(git(integration.path, ['rev-parse', 'HEAD~2']).trim()).toBe(baseline.baselineCommit);
    // Worker checkpoint commits are host-owned: the app commits on a conversation's behalf and
    // never signs as the user. The cherry-pick preserves that author rather than re-attributing.
    expect(git(integration.path, ['log', '-1', '--format=%an']).trim()).toBe('Web GPT Agent');
    expect(git(integration.path, ['log', '-1', '--format=%ae']).trim()).toBe('web-gpt-agent@localhost');

    // The user's original dirty checkout is untouched and still on its own branch.
    expect(await sourceState(root)).toEqual(sourceBefore);
    expect(git(root, ['worktree', 'list', '--porcelain']).includes('refs/heads/main')).toBe(true);
  });

  it('refuses to checkpoint a recorded path replaced by another repository', async () => {
    const root = await repository();
    const { store, dir } = await ledger();
    const { workId, primeId } = seed(store, [], root);
    const engine = manager(store, dir);
    const baseline = await engine.captureBaseline({ projectPath: root, workId });
    const integration = await engine.ensureIntegrationWorktree({
      workId,
      projectPath: root,
      baselineCommit: baseline.baselineCommit,
      agentId: primeId
    });

    await fs.rename(integration.path, `${integration.path}-original`);
    await fs.mkdir(integration.path, { recursive: true });
    git(integration.path, ['init', '-q', '-b', integration.branch]);
    write(integration.path, 'replacement.txt', 'must remain untracked\n');

    await expect(
      engine.checkpointIntegration({ workId, message: 'must not touch replacement' })
    ).rejects.toMatchObject({ code: 'WORKTREE_FAILED' });
    expect(git(integration.path, ['status', '--porcelain']).trim()).toBe('?? replacement.txt');
  });

  it('surfaces a same-line conflict, refuses a second integration, and aborts cleanly', async () => {
    const root = await repository();
    const { store, dir } = await ledger();
    const worker = randomUUID();
    const { workId, primeId } = seed(store, [worker], root);
    const engine = manager(store, dir);

    const baseline = await engine.captureBaseline({ projectPath: root, workId });
    const integration = await engine.ensureIntegrationWorktree({ workId, projectPath: root, baselineCommit: baseline.baselineCommit, agentId: primeId });
    const work = await engine.createWorkerWorktree({ workId, agentId: worker, baseCommit: baseline.baselineCommit });

    write(work.path, 'f.txt', 'l1\nWORKER\nl3\n');
    const finished = await engine.finishWorker({ workId, agentId: worker, message: 'worker line' });
    // The prime changes the same line in the integration worktree.
    write(integration.path, 'f.txt', 'l1\nPRIME\nl3\n');
    await engine.checkpointWorktree({ path: integration.path, message: 'prime line', baseCommit: baseline.baselineCommit });

    const conflicted = await engine.integrate({ workId, workerId: worker, workerCommit: finished.commit, operationId: randomUUID() });
    expect(conflicted.state).toBe('conflict');
    expect(conflicted.conflictFiles).toEqual(['f.txt']);
    // Never force-overwritten: the marker is on disk and both sides are still present.
    const onDisk = await fs.readFile(path.join(integration.path, 'f.txt'), 'utf8');
    expect(onDisk).toContain('<<<<<<<');
    expect(onDisk).toContain('WORKER');
    expect(onDisk).toContain('PRIME');
    expect(store.getIntegrationIntent(workId)?.status).toBe('conflict');
    // The intent is reconciled from Git, not re-picked.
    expect((await engine.reconcileIntegration({ workId }))?.state).toBe('conflict');

    // A second integration while one is unresolved is refused, not stacked.
    await expect(
      engine.integrate({ workId, workerId: worker, workerCommit: finished.commit, operationId: randomUUID() })
    ).rejects.toMatchObject({ code: 'INTEGRATION_UNKNOWN' });

    const aborted = await engine.abortIntegration({ workId });
    expect(aborted.state).toBe('aborted');
    expect(git(integration.path, ['status', '--porcelain'])).toBe('');
    // The abort restores the prime's committed line, and the file on disk is exactly Git's checkout
    // of it — including the host's line-ending conversion (`core.autocrlf=true` on Windows runners).
    expect(git(integration.path, ['show', 'HEAD:f.txt'])).toBe('l1\nPRIME\nl3\n');
    expect(await fs.readFile(path.join(integration.path, 'f.txt'), 'utf8')).toBe(git(integration.path, ['cat-file', '--filters', 'HEAD:f.txt']));
    expect(store.getIntegrationIntent(workId)?.status).toBe('aborted');
  });

  it('resumes a replacement conversation in the same worker worktree', async () => {
    const root = await repository();
    const { store, dir } = await ledger();
    const worker = randomUUID();
    const { workId, primeId } = seed(store, [worker], root);
    const engine = manager(store, dir);
    const baseline = await engine.captureBaseline({ projectPath: root, workId });
    await engine.ensureIntegrationWorktree({ workId, projectPath: root, baselineCommit: baseline.baselineCommit, agentId: primeId });

    const first = await engine.createWorkerWorktree({ workId, agentId: worker, baseCommit: baseline.baselineCommit });
    write(first.path, 'work-in-progress.txt', 'not committed yet\n');
    // The conversation is replaced: same agent id, same worktree, same branch, files intact.
    const second = await engine.createWorkerWorktree({ workId, agentId: worker, baseCommit: baseline.baselineCommit });
    expect(second.path).toBe(first.path);
    expect(second.branch).toBe(first.branch);
    expect(await fs.readFile(path.join(second.path, 'work-in-progress.txt'), 'utf8')).toBe('not committed yet\n');
    expect(second.createdAt).toBe(first.createdAt);
  });

  it('recognizes an integration that already reached Git before its receipt was written', async () => {
    const root = await repository();
    const { store, dir } = await ledger();
    const worker = randomUUID();
    const { workId, primeId } = seed(store, [worker], root);
    const engine = manager(store, dir);
    const baseline = await engine.captureBaseline({ projectPath: root, workId });
    const integration = await engine.ensureIntegrationWorktree({ workId, projectPath: root, baselineCommit: baseline.baselineCommit, agentId: primeId });
    const work = await engine.createWorkerWorktree({ workId, agentId: worker, baseCommit: baseline.baselineCommit });
    write(work.path, 'applied.txt', 'applied\n');
    const finished = await engine.finishWorker({ workId, agentId: worker, message: 'worker change' });

    const operationId = randomUUID();
    const mainBefore = git(integration.path, ['rev-parse', 'HEAD']).trim();
    // The crash window: Git succeeded, the receipt did not. Reproduce it exactly.
    git(integration.path, ['cherry-pick', '-x', finished.commit]);
    git(integration.path, ['commit', '--amend', '--no-edit', '--trailer', `WGPA-Integration: ${operationId}`]);
    const applied = git(integration.path, ['rev-parse', 'HEAD']).trim();
    store.setIntegrationIntent(workId, {
      workId,
      operationId,
      workerId: worker,
      workerCommit: finished.commit,
      mainBefore,
      status: 'running',
      conflictFiles: [],
      mainCommit: null,
      startedAt: Date.now(),
      updatedAt: Date.now()
    });

    const reconciled = await engine.reconcileIntegration({ workId });
    expect(reconciled?.state).toBe('merged');
    expect(reconciled?.mainCommit).toBe(applied);
    expect(git(integration.path, ['rev-parse', 'HEAD']).trim()).toBe(applied);
    expect(git(integration.path, ['log', '--format=%s']).trim().split('\n')).toEqual([
      'worker change',
      `web-gpt-agent baseline for work ${workId}`,
      'base'
    ]);

    // A retry of the same operation joins the result instead of applying it twice.
    const retried = await engine.integrate({ workId, workerId: worker, workerCommit: finished.commit, operationId });
    expect(retried.state).toBe('already-applied');
    expect(retried.mainCommit).toBe(applied);
    expect(git(integration.path, ['log', '--format=%s']).trim().split('\n')).toEqual([
      'worker change',
      `web-gpt-agent baseline for work ${workId}`,
      'base'
    ]);
  });

  it('recognizes an integration that reached Git before its trailer was written', async () => {
    const root = await repository();
    const { store, dir } = await ledger();
    const worker = randomUUID();
    const { workId, primeId } = seed(store, [worker], root);
    const engine = manager(store, dir);
    const baseline = await engine.captureBaseline({ projectPath: root, workId });
    const integration = await engine.ensureIntegrationWorktree({ workId, projectPath: root, baselineCommit: baseline.baselineCommit, agentId: primeId });
    const work = await engine.createWorkerWorktree({ workId, agentId: worker, baseCommit: baseline.baselineCommit });
    write(work.path, 'half-applied.txt', 'x\n');
    const finished = await engine.finishWorker({ workId, agentId: worker, message: 'worker change' });

    const operationId = randomUUID();
    const mainBefore = git(integration.path, ['rev-parse', 'HEAD']).trim();
    // The narrower crash window: `cherry-pick -x` committed, the trailer amend never ran.
    git(integration.path, ['cherry-pick', '-x', finished.commit]);
    const applied = git(integration.path, ['rev-parse', 'HEAD']).trim();
    expect(git(integration.path, ['log', '-1', '--format=%B'])).not.toContain('WGPA-Integration');
    store.setIntegrationIntent(workId, {
      workId,
      operationId,
      workerId: worker,
      workerCommit: finished.commit,
      mainBefore,
      status: 'running',
      conflictFiles: [],
      mainCommit: null,
      startedAt: Date.now(),
      updatedAt: Date.now()
    });

    const reconciled = await engine.reconcileIntegration({ workId });
    expect(reconciled?.state).toBe('merged');
    expect(reconciled?.mainCommit).toBe(applied);
    expect(store.getIntegrationIntent(workId)?.status).toBe('merged');

    const retried = await engine.integrate({ workId, workerId: worker, workerCommit: finished.commit, operationId });
    expect(retried.state).toBe('already-applied');
    expect(git(integration.path, ['log', '--format=%s']).trim().split('\n')).toEqual([
      'worker change',
      `web-gpt-agent baseline for work ${workId}`,
      'base'
    ]);
  });

  it('serializes integration and refuses while a mutating operation is live', async () => {
    const root = await repository();
    const { store, dir } = await ledger();
    const worker = randomUUID();
    const { workId, primeId } = seed(store, [worker], root);
    let busy = false;
    const engine = manager(store, dir, { activity: { isBusy: () => busy } });
    const baseline = await engine.captureBaseline({ projectPath: root, workId });
    const integration = await engine.ensureIntegrationWorktree({ workId, projectPath: root, baselineCommit: baseline.baselineCommit, agentId: primeId });
    const work = await engine.createWorkerWorktree({ workId, agentId: worker, baseCommit: baseline.baselineCommit });
    write(work.path, 'g.txt', 'g\n');
    const finished = await engine.finishWorker({ workId, agentId: worker, message: 'g' });

    busy = true;
    const busyError = await engine.integrate({ workId, workerId: worker, workerCommit: finished.commit, operationId: randomUUID() }).catch((error: unknown) => error);
    expect(busyError).toBeInstanceOf(WorktreeBusyError);
    expect((busyError as WorktreeBusyError).code).toBe('WORKTREE_BUSY');
    // Nothing was applied: the integration branch is still only the private baseline.
    expect(git(integration.path, ['rev-parse', 'HEAD']).trim()).toBe(baseline.baselineCommit);
    await expect(engine.assertQuiescent({ workId, worktreePath: integration.path })).rejects.toMatchObject({ code: 'WORKTREE_BUSY' });

    busy = false;
    await engine.assertQuiescent({ workId, worktreePath: integration.path });
    const merged = await engine.integrate({ workId, workerId: worker, workerCommit: finished.commit, operationId: randomUUID() });
    expect(merged.state).toBe('merged');

    // No activity probe at all means "never busy", so a test host still integrates.
    const unprobed = manager(store, dir);
    await expect(unprobed.assertQuiescent({ workId, worktreePath: integration.path })).resolves.toBeUndefined();
  });

  it('checkpoints only real changes and reports what a worker changed', async () => {
    const root = await repository();
    const { store, dir } = await ledger();
    const worker = randomUUID();
    const { workId, primeId } = seed(store, [worker], root);
    const engine = manager(store, dir);
    const baseline = await engine.captureBaseline({ projectPath: root, workId });
    await engine.ensureIntegrationWorktree({ workId, projectPath: root, baselineCommit: baseline.baselineCommit, agentId: primeId });
    const work = await engine.createWorkerWorktree({ workId, agentId: worker, baseCommit: baseline.baselineCommit });

    const unchanged = await engine.checkpointWorktree({ path: work.path, message: 'nothing yet' });
    expect(unchanged.noop).toBe(true);
    expect(unchanged.commit).toBe(baseline.baselineCommit);
    expect(unchanged.changedFiles).toEqual([]);

    write(work.path, 'f.txt', 'l1\nCHANGED\nl3\n');
    write(work.path, 'added.txt', 'added\n');
    const checkpoint = await engine.checkpointWorktree({ path: work.path, message: 'worker checkpoint' });
    expect(checkpoint.noop).toBe(false);
    expect(checkpoint.parentCommit).toBe(baseline.baselineCommit);
    expect(checkpoint.changedFiles).toEqual(
      expect.arrayContaining([{ path: 'f.txt', status: 'M' }, { path: 'added.txt', status: 'A' }])
    );
    // The worktree is left clean, so the next checkpoint cannot double-count the same change.
    expect(git(work.path, ['status', '--porcelain'])).toBe('');
    expect(await engine.changedFileSummary({ path: work.path, baseCommit: baseline.baselineCommit })).toEqual(
      expect.arrayContaining([{ path: 'f.txt', status: 'M' }, { path: 'added.txt', status: 'A' }])
    );
    // The source checkout still does not know any of this happened.
    expect(git(root, ['rev-parse', 'HEAD']).trim()).toBe(baseline.headCommit);
    expect(git(root, ['status', '--porcelain', '-uall'])).toBe('');
  });

  it('verifies recorded hashes so a crashed patch is not replayed blindly', async () => {
    const root = await repository();
    const { store, dir } = await ledger();
    const worker = randomUUID();
    const { workId, primeId } = seed(store, [worker], root);
    const engine = manager(store, dir);
    const baseline = await engine.captureBaseline({ projectPath: root, workId });
    await engine.ensureIntegrationWorktree({ workId, projectPath: root, baselineCommit: baseline.baselineCommit, agentId: primeId });
    const work = await engine.createWorkerWorktree({ workId, agentId: worker, baseCommit: baseline.baselineCommit });

    const before = git(work.path, ['hash-object', '--path=f.txt', '--', 'f.txt']).trim();
    const absent = await engine.verifyHashes({ path: work.path, expected: { 'f.txt': before, 'missing.txt': null } });
    expect(absent).toEqual([
      { path: 'f.txt', expected: before, actual: before, match: true },
      { path: 'missing.txt', expected: null, actual: null, match: true }
    ]);

    write(work.path, 'f.txt', 'l1\nWRITTEN\nl3\n');
    const after = git(work.path, ['hash-object', '--path=f.txt', '--', 'f.txt']).trim();
    expect(after).not.toBe(before);
    const mixed = await engine.verifyHashes({ path: work.path, expected: { 'f.txt': before, 'other.txt': null } });
    expect(mixed[0]).toEqual({ path: 'f.txt', expected: before, actual: after, match: false });
    expect(mixed[1]?.match).toBe(true);
  });

  it('creates a worker worktree from the ledger project without an integration worktree', async () => {
    const root = await repository();
    const { store, dir } = await ledger();
    const worker = randomUUID();
    const { workId } = seed(store, [worker], root);
    const engine = manager(store, dir);

    // The project comes from the work row, so a worker can be placed before the prime's own
    // worktree exists — which is what `stageSpawn` needs when a worker is spawned first.
    const assignment = await engine.createWorkerWorktree({ workId, agentId: worker, baseCommit: git(root, ['rev-parse', 'HEAD']).trim() });
    expect(assignment.path).toBe(path.join(dir, 'worktrees', workId, worker));
    expect(git(assignment.path, ['rev-parse', '--abbrev-ref', 'HEAD']).trim()).toBe(`wgpt/${workId}/${worker}`);
    expect(git(root, ['status', '--porcelain', '-uall'])).toBe('');
  });

  it('refuses integration under a live operation through the real production probe', async () => {
    const root = await repository();
    const { store, dir } = await ledger();
    const worker = randomUUID();
    const { workId, primeId } = seed(store, [worker], root);
    // EXACTLY the construction `src/main/index.ts` performs, including the real
    // `createWorktreeActivityProbe` from the runtime module — not a local stub. This is the
    // seam that decides whether `integrateWorkAgent` can run under a live command.
    const engine = createWorktreeManager({
      userDataDir: dir,
      worktreesRoot: path.join(dir, 'worktrees'),
      store,
      activity: createWorktreeActivityProbe(store)
    });
    const baseline = await engine.captureBaseline({ projectPath: root, workId });
    const integration = await engine.ensureIntegrationWorktree({ workId, projectPath: root, baselineCommit: baseline.baselineCommit, agentId: primeId });
    const work = await engine.createWorkerWorktree({ workId, agentId: worker, baseCommit: baseline.baselineCommit });
    write(work.path, 'live.txt', 'live\n');
    const finished = await engine.finishWorker({ workId, agentId: worker, message: 'live' });

    const at = Date.now();
    const live = randomUUID();
    store.insertOperation({
      operation_id: live,
      work_id: workId,
      agent_id: primeId,
      generation: 0,
      tool: 'exec_command',
      args_hash: 'a'.repeat(64),
      state: 'running',
      process_id: null,
      result_ref: null,
      result_json: null,
      session_id: null,
      expect_before: null,
      expect_after: null,
      retry_of: null,
      retry_operation_id: null,
      resolution: null,
      created_at: at,
      updated_at: at
    });

    // A live operation of this work refuses the integration, and nothing is applied.
    const refused = await engine.integrate({ workId, workerId: worker, workerCommit: finished.commit, operationId: randomUUID() }).catch((error: unknown) => error);
    expect(refused).toBeInstanceOf(WorktreeBusyError);
    expect((refused as WorktreeBusyError).code).toBe('WORKTREE_BUSY');
    expect(git(integration.path, ['rev-parse', 'HEAD']).trim()).toBe(baseline.baselineCommit);

    // The caller's own receipt is `running` for the whole call and must not be counted against
    // it, or no integration could ever start. Settle the unrelated row, then integrate under an
    // operation id that IS the live row: it proceeds, and the row is left untouched.
    store.updateOperation(live, { state: 'completed', updated_at: Date.now() });
    const self = randomUUID();
    store.insertOperation({
      operation_id: self,
      work_id: workId,
      agent_id: primeId,
      generation: 0,
      tool: 'agents',
      args_hash: 'b'.repeat(64),
      state: 'running',
      process_id: null,
      result_ref: null,
      result_json: null,
      session_id: null,
      expect_before: null,
      expect_after: null,
      retry_of: null,
      retry_operation_id: null,
      resolution: null,
      created_at: at,
      updated_at: at
    });
    const merged = await engine.integrate({ workId, workerId: worker, workerCommit: finished.commit, operationId: self });
    expect(merged.state).toBe('merged');
    expect(git(integration.path, ['ls-tree', '--name-only', '-r', 'HEAD']).trim().split('\n')).toContain('live.txt');
    // Excluded, not cleaned: the row is still open, which is what a real in-flight call looks like.
    expect(store.listOpenOperations(workId).map(row => row.operation_id)).toEqual([self]);

    // Once it settles, the worktree is quiescent again.
    store.updateOperation(self, { state: 'completed', updated_at: Date.now() });
    await engine.assertQuiescent({ workId, worktreePath: integration.path });
    expect(store.listOpenOperations(workId)).toEqual([]);
  });

  it('works without a ledger through its in-memory fallback', async () => {
    const root = await repository();
    const dir = await makeTempDir('wgpt-wt-mem-');
    directories.push(dir);
    const workId = randomUUID();
    const primeId = randomUUID();
    const engine = createWorktreeManager({ userDataDir: dir, worktreesRoot: path.join(dir, 'worktrees'), sleep: async () => undefined });

    // With no store the assignment cannot be persisted, so the caller supplies the ids and the
    // deterministic branch/path are the only contract. Integration still works end to end.
    const baseline = await engine.captureBaseline({ projectPath: root, workId });
    const integration = await engine.ensureIntegrationWorktree({ workId, projectPath: root, baselineCommit: baseline.baselineCommit, agentId: primeId });
    expect(integration.branch).toBe(`wgpt/${workId}/main`);
    write(integration.path, 'solo.txt', 'solo\n');
    const checkpoint = await engine.checkpointWorktree({ path: integration.path, message: 'solo' });
    expect(checkpoint.noop).toBe(false);
    expect(checkpoint.changedFiles).toEqual([{ path: 'solo.txt', status: 'A' }]);
    // With no ledger the assignment is still tracked for this process — the deterministic
    // branch/path are the contract — but it is not durable, so a restarted host starts empty.
    expect((await engine.getWorktreeAssignment({ workId, agentId: primeId }))?.branch).toBe(`wgpt/${workId}/main`);
    expect((await engine.listWorktreeAssignments({ workId })).map((row) => row.agentId)).toEqual([primeId]);
    const restarted = createWorktreeManager({ userDataDir: dir, worktreesRoot: path.join(dir, 'worktrees'), sleep: async () => undefined });
    expect(await restarted.getWorktreeAssignment({ workId, agentId: primeId })).toBeNull();
  });

  it('lists and reads back assignments after a restart, and rejects an unknown worker', async () => {
    const root = await repository();
    const { store, dir } = await ledger();
    const worker = randomUUID();
    const { workId, primeId } = seed(store, [worker], root);
    const engine = manager(store, dir);
    const baseline = await engine.captureBaseline({ projectPath: root, workId });
    await engine.ensureIntegrationWorktree({ workId, projectPath: root, baselineCommit: baseline.baselineCommit, agentId: primeId });
    await engine.createWorkerWorktree({ workId, agentId: worker, baseCommit: baseline.baselineCommit });

    // A fresh manager over the same ledger answers identically: nothing lives in memory.
    const restarted = manager(store, dir);
    expect((await restarted.getWorktreeAssignment({ workId, agentId: worker }))?.branch).toBe(`wgpt/${workId}/${worker}`);
    expect((await restarted.listWorktreeAssignments({ workId })).map((row) => row.agentId).sort()).toEqual([primeId, worker].sort());
    expect(await restarted.currentIntegrationCommit({ workId })).toBe(baseline.baselineCommit);
    expect(await restarted.getWorktreeAssignment({ workId, agentId: randomUUID() })).toBeNull();
    await expect(restarted.finishWorker({ workId, agentId: randomUUID(), message: 'nobody' })).rejects.toMatchObject({ code: 'WORKTREE_FAILED' });
  });

  it('reports an integration branch that moved without a recognizable receipt as unknown', async () => {
    const root = await repository();
    const { store, dir } = await ledger();
    const worker = randomUUID();
    const { workId, primeId } = seed(store, [worker], root);
    const engine = manager(store, dir);
    const baseline = await engine.captureBaseline({ projectPath: root, workId });
    const integration = await engine.ensureIntegrationWorktree({ workId, projectPath: root, baselineCommit: baseline.baselineCommit, agentId: primeId });

    const mainBefore = git(integration.path, ['rev-parse', 'HEAD']).trim();
    store.setIntegrationIntent(workId, {
      workId,
      operationId: randomUUID(),
      workerId: worker,
      workerCommit: mainBefore,
      mainBefore,
      status: 'running',
      conflictFiles: [],
      mainCommit: null,
      startedAt: Date.now(),
      updatedAt: Date.now()
    });
    // Something else committed on the integration branch: not ours to claim.
    write(integration.path, 'foreign.txt', 'x\n');
    git(integration.path, ['add', '-A']);
    git(integration.path, ['commit', '-qm', 'foreign']);
    const foreign = git(integration.path, ['rev-parse', 'HEAD']).trim();

    const reconciled = await engine.reconcileIntegration({ workId });
    expect(reconciled?.state).toBe('unknown');
    expect(store.getIntegrationIntent(workId)?.status).toBe('unknown');

    // The same operation is never applied again on top of an unexplained branch movement.
    const refused = await engine.integrate({
      workId,
      workerId: worker,
      workerCommit: mainBefore,
      operationId: store.getIntegrationIntent(workId)?.operationId ?? ''
    }).catch((error: unknown) => error);
    expect((refused as WorktreeError).code).toBe('INTEGRATION_UNKNOWN');
    // Nothing further was applied: the foreign commit is still the tip.
    expect(git(integration.path, ['rev-parse', 'HEAD']).trim()).toBe(foreign);

    // Aborting the recorded integration is the explicit way out, and it leaves the branch alone.
    const aborted = await engine.abortIntegration({ workId });
    expect(aborted.state).toBe('aborted');
    expect(store.getIntegrationIntent(workId)?.status).toBe('aborted');
    expect(git(integration.path, ['rev-parse', 'HEAD']).trim()).toBe(foreign);
  });

  it('retries an integration recorded unknown when Git shows no trace of it', async () => {
    const root = await repository();
    const { store, dir } = await ledger();
    const worker = randomUUID();
    const { workId, primeId } = seed(store, [worker], root);
    const engine = manager(store, dir);
    const baseline = await engine.captureBaseline({ projectPath: root, workId });
    const integration = await engine.ensureIntegrationWorktree({ workId, projectPath: root, baselineCommit: baseline.baselineCommit, agentId: primeId });
    const work = await engine.createWorkerWorktree({ workId, agentId: worker, baseCommit: baseline.baselineCommit });
    write(work.path, 'later.txt', 'later\n');
    const finished = await engine.finishWorker({ workId, agentId: worker, message: 'worker change' });

    const mainBefore = git(integration.path, ['rev-parse', 'HEAD']).trim();
    const operationId = randomUUID();
    // A refusal before Git ever ran: the intent says unknown, but nothing moved and no pick is
    // in progress, so retrying is safe rather than a duplicate application.
    store.setIntegrationIntent(workId, {
      workId,
      operationId,
      workerId: worker,
      workerCommit: finished.commit,
      mainBefore,
      status: 'unknown',
      conflictFiles: [],
      mainCommit: null,
      startedAt: Date.now(),
      updatedAt: Date.now()
    });
    expect(git(integration.path, ['rev-parse', 'HEAD']).trim()).toBe(mainBefore);

    const merged = await engine.integrate({ workId, workerId: worker, workerCommit: finished.commit, operationId });
    expect(merged.state).toBe('merged');
    expect(store.getIntegrationIntent(workId)?.status).toBe('merged');
    expect(git(integration.path, ['ls-tree', '--name-only', '-r', 'HEAD']).trim().split('\n')).toContain('later.txt');
  });
});

/**
 * A work with a real managed integration worktree, which is what a continuation inherits.
 *
 * The returned engine is the manager the caller keeps using: the worktree engine holds no
 * per-work state, so a later `captureSuccessorBaseline` on the same manager reads exactly what a
 * restarted host would.
 */
async function predecessorWork(
  store: WorkStore,
  dir: string,
  projectPath: string
): Promise<{ workId: string; primeId: string; integration: { path: string; branch: string }; baselineCommit: string }> {
  const { workId, primeId } = seed(store, [], projectPath);
  const engine = manager(store, dir);
  const baseline = await engine.captureBaseline({ projectPath, workId });
  const integration = await engine.ensureIntegrationWorktree({
    workId,
    projectPath,
    baselineCommit: baseline.baselineCommit,
    agentId: primeId
  });
  return { workId, primeId, integration, baselineCommit: baseline.baselineCommit };
}

describe('successor baselines', () => {
  it('inherits the committed and dirty result of a completed predecessor without touching it', async () => {
    const root = await repository({ 'f.txt': 'l1\nl2\nl3\n' });
    const { store, dir } = await ledger();
    const engine = manager(store, dir);
    const first = await predecessorWork(store, dir, root);

    // A finished change on the integration branch, plus work the prime never committed and an
    // untracked file it was still writing: all of it is the result a successor must continue.
    write(first.integration.path, 'done.txt', 'committed work\n');
    await engine.checkpointWorktree({ path: first.integration.path, message: 'prime finished the parser' });
    write(first.integration.path, 'f.txt', 'l1\nDIRTY FROM PREDECESSOR\nl3\n');
    write(first.integration.path, 'wip/notes.md', 'untracked draft\n');
    const sourceBefore = await sourceState(root);
    const predecessorHead = git(first.integration.path, ['rev-parse', 'HEAD']).trim();
    const predecessorStatus = git(first.integration.path, ['status', '--porcelain', '-uall']);
    const predecessorIndex = await indexHash(first.integration.path);

    // A predecessor that has not finished has no settled result to inherit.
    const second = continuation(store, first.workId, root);
    await expect(
      engine.captureSuccessorBaseline({ workId: second.workId, predecessorWorkId: first.workId, projectPath: root })
    ).rejects.toMatchObject({ code: 'WORKTREE_BUSY' });

    store.setWorkStatus(first.workId, 'completed', 'test');
    const baseline = await engine.captureSuccessorBaseline({
      workId: second.workId,
      predecessorWorkId: first.workId,
      projectPath: root
    });

    // The snapshot is the predecessor's result: its history underneath, its uncommitted content on
    // top, and a new commit of its own.
    expect(baseline.projectPath).toBe(root);
    expect(baseline.workId).toBe(second.workId);
    expect(baseline.predecessorWorkId).toBe(first.workId);
    expect(baseline.sourceWorktreePath).toBe(first.integration.path);
    expect(baseline.baselineCommit).not.toBe(predecessorHead);
    expect(git(root, ['rev-parse', `${baseline.baselineCommit}^`]).trim()).toBe(predecessorHead);
    const tree = git(root, ['ls-tree', '-r', '--name-only', baseline.baselineCommit]).trim().split('\n');
    expect(tree).toContain('done.txt');
    expect(tree).toContain('wip/notes.md');
    expect(git(root, ['show', `${baseline.baselineCommit}:f.txt`])).toBe('l1\nDIRTY FROM PREDECESSOR\nl3\n');
    expect(baseline.manifest.find((entry) => entry.path === 'f.txt')?.hash).toBe(
      git(first.integration.path, ['hash-object', '--path=f.txt', '--', 'f.txt']).trim()
    );
    // Its refs are its own, in the app's namespace only.
    expect(baseline.baseRef).toBe(`refs/web-gpt-agent/${second.workId}/base`);
    expect(git(root, ['rev-parse', baseline.baseRef ?? '']).trim()).toBe(baseline.baselineCommit);
    expect(git(root, ['rev-parse', `refs/web-gpt-agent/${second.workId}/from/${first.workId}`]).trim()).toBe(predecessorHead);

    // The predecessor is read, never rewritten: same commit, same branch, same dirty files, same
    // index. Its uncommitted work is still uncommitted.
    expect(git(first.integration.path, ['rev-parse', 'HEAD']).trim()).toBe(predecessorHead);
    expect(git(first.integration.path, ['symbolic-ref', '-q', 'HEAD']).trim()).toBe(`refs/heads/${first.integration.branch}`);
    expect(git(first.integration.path, ['status', '--porcelain', '-uall'])).toBe(predecessorStatus);
    expect(await indexHash(first.integration.path)).toBe(predecessorIndex);
    // And the user's original checkout still knows none of this happened.
    expect(await sourceState(root)).toEqual(sourceBefore);
  });

  it('starts the successor worktree at the prior result and never at the project checkout', async () => {
    const root = await repository({ 'f.txt': 'l1\nl2\nl3\n' });
    const { store, dir } = await ledger();
    const engine = manager(store, dir);
    const first = await predecessorWork(store, dir, root);
    write(first.integration.path, 'result.txt', 'the predecessor result\n');
    await engine.checkpointWorktree({ path: first.integration.path, message: 'prime result' });
    store.setWorkStatus(first.workId, 'completed', 'test');

    const second = continuation(store, first.workId, root);
    const baseline = await engine.captureSuccessorBaseline({
      workId: second.workId,
      predecessorWorkId: first.workId,
      projectPath: root
    });

    // The canonical checkout moves on after the result was recorded — an unrelated commit on the
    // user's own branch. It must not reach the successor.
    write(root, 'unrelated.txt', 'someone else changed main\n');
    git(root, ['add', '-A']);
    git(root, ['commit', '-qm', 'unrelated canonical change']);

    // The successor's start stage is retried (a restart, a replayed receipt) and answers with the
    // same baseline: the recorded result is a fact, not a fresh reading of a moving checkout.
    const retried = await engine.captureSuccessorBaseline({
      workId: second.workId,
      predecessorWorkId: first.workId,
      projectPath: root
    });
    expect(retried.baselineCommit).toBe(baseline.baselineCommit);
    expect(retried.predecessorWorkId).toBe(first.workId);

    const assignment = await engine.ensureIntegrationWorktree({
      workId: second.workId,
      projectPath: baseline.projectPath,
      baselineCommit: baseline.baselineCommit,
      agentId: second.primeId
    });
    const successorTree = git(assignment.path, ['ls-tree', '-r', '--name-only', 'HEAD']).trim().split('\n');
    expect(successorTree).toContain('result.txt');
    expect(successorTree).not.toContain('unrelated.txt');
    expect(git(assignment.path, ['rev-parse', 'HEAD']).trim()).toBe(baseline.baselineCommit);
    expect(git(assignment.path, ['rev-parse', 'HEAD^']).trim()).toBe(git(first.integration.path, ['rev-parse', 'HEAD']).trim());
    expect(assignment.branch).toBe(`wgpt/${second.workId}/main`);

    // A work whose baseline came from the project checkout is not silently re-pointed at a result.
    const plain = addWork(store, root);
    await engine.captureBaseline({ projectPath: root, workId: plain.workId });
    await expect(
      engine.captureSuccessorBaseline({ workId: plain.workId, predecessorWorkId: first.workId, projectPath: root })
    ).rejects.toMatchObject({ code: 'SUCCESSOR_SOURCE_MISMATCH' });
    expect(git(root, ['rev-parse', `refs/web-gpt-agent/${plain.workId}/base`]).trim()).not.toBe(baseline.baselineCommit);
  });

  it('refuses an unresolved integration and a live mutation on the predecessor', async () => {
    const root = await repository({ 'f.txt': 'l1\nl2\nl3\n' });
    const { store, dir } = await ledger();
    const engine = manager(store, dir);
    const first = await predecessorWork(store, dir, root);
    store.setWorkStatus(first.workId, 'completed', 'test');
    const second = continuation(store, first.workId, root);

    // A recorded integration that never settled means the predecessor's own result is half-applied.
    store.setIntegrationIntent(first.workId, {
      workId: first.workId,
      operationId: randomUUID(),
      workerId: randomUUID(),
      workerCommit: git(first.integration.path, ['rev-parse', 'HEAD']).trim(),
      mainBefore: git(first.integration.path, ['rev-parse', 'HEAD']).trim(),
      status: 'conflict',
      conflictFiles: ['f.txt'],
      mainCommit: null,
      startedAt: Date.now(),
      updatedAt: Date.now()
    });
    const conflicted = await engine
      .captureSuccessorBaseline({ workId: second.workId, predecessorWorkId: first.workId, projectPath: root })
      .catch((error: unknown) => error);
    expect((conflicted as WorktreeError).code).toBe('INTEGRATION_UNKNOWN');
    expect((conflicted as WorktreeError).paths).toEqual(['f.txt']);

    store.clearIntegrationIntent(first.workId);
    // A live operation in the predecessor's worktree is the same unsettled fact, one layer down.
    let busy = false;
    const probed = manager(store, dir, { activity: { isBusy: () => busy } });
    busy = true;
    await expect(
      probed.captureSuccessorBaseline({ workId: second.workId, predecessorWorkId: first.workId, projectPath: root })
    ).rejects.toMatchObject({ code: 'WORKTREE_BUSY' });
    busy = false;
    await expect(
      probed.captureSuccessorBaseline({ workId: second.workId, predecessorWorkId: first.workId, projectPath: root })
    ).resolves.toMatchObject({ predecessorWorkId: first.workId });

    // A predecessor that stopped without reaching its finish line has no result to continue from.
    const abandoned = await predecessorWork(store, dir, root);
    const third = continuation(store, abandoned.workId, root);
    store.setWorkStatus(abandoned.workId, 'cancelled', 'test');
    await expect(
      engine.captureSuccessorBaseline({ workId: third.workId, predecessorWorkId: abandoned.workId, projectPath: root })
    ).rejects.toMatchObject({ code: 'PREDECESSOR_NOT_COMPLETED' });
  });

  it('refuses a caller-supplied destination, a foreign project and an unmanaged worktree', async () => {
    const root = await repository({ 'f.txt': 'l1\nl2\nl3\n' });
    const other = await repository({ 'g.txt': 'other\n' });
    const { store, dir } = await ledger();
    const engine = manager(store, dir);
    const first = await predecessorWork(store, dir, root);
    store.setWorkStatus(first.workId, 'completed', 'test');
    const second = continuation(store, first.workId, root);

    // The destination is never the caller's to choose: the ledger's project is the only one.
    await expect(
      engine.captureSuccessorBaseline({ workId: second.workId, predecessorWorkId: first.workId, projectPath: other })
    ).rejects.toMatchObject({ code: 'PROJECT_MISMATCH' });
    // Neither is a predecessor from a different project.
    const foreign = await predecessorWork(store, dir, other);
    store.setWorkStatus(foreign.workId, 'completed', 'test');
    const crossing = continuation(store, foreign.workId, root);
    await expect(
      engine.captureSuccessorBaseline({ workId: crossing.workId, predecessorWorkId: foreign.workId, projectPath: root })
    ).rejects.toMatchObject({ code: 'PROJECT_MISMATCH' });
    // Nor is a predecessor the ledger never recorded for this work.
    await expect(
      engine.captureSuccessorBaseline({ workId: second.workId, predecessorWorkId: foreign.workId, projectPath: root })
    ).rejects.toMatchObject({ code: 'SUCCESSOR_SOURCE_MISMATCH' });
    // A work cannot continue itself.
    await expect(
      engine.captureSuccessorBaseline({ workId: first.workId, predecessorWorkId: first.workId, projectPath: root })
    ).rejects.toMatchObject({ code: 'WORKTREE_FAILED' });
    // Nothing was written for any of the refusals.
    expect(git(root, ['for-each-ref', '--format=%(refname)', `refs/web-gpt-agent/${second.workId}`]).trim()).toBe('');

    // A recorded assignment whose folder is outside this host's worktrees root is not read, even
    // when it is a symlink that resolves to the project checkout.
    const recorded = store.getWorktreeAssignment(first.workId, first.primeId)!;
    const escape = path.join(dir, 'worktrees', first.workId, 'escape');
    symlinkSync(root, escape);
    store.assignWorktree({ ...recorded, path: escape });
    await expect(
      engine.captureSuccessorBaseline({ workId: second.workId, predecessorWorkId: first.workId, projectPath: root })
    ).rejects.toMatchObject({ code: 'WORKTREE_FAILED' });

    // A recorded worktree Git no longer registers is refused rather than read from disk.
    store.assignWorktree({ ...recorded, path: path.join(dir, 'worktrees', first.workId, 'gone') });
    await expect(
      engine.captureSuccessorBaseline({ workId: second.workId, predecessorWorkId: first.workId, projectPath: root })
    ).rejects.toMatchObject({ code: 'WORKTREE_FAILED' });
    store.assignWorktree(recorded);

    // A predecessor that was never started in this host has no result at all.
    const unstarted = addWork(store, root);
    store.setWorkStatus(unstarted.workId, 'completed', 'test');
    const afterUnstarted = continuation(store, unstarted.workId, root);
    await expect(
      engine.captureSuccessorBaseline({ workId: afterUnstarted.workId, predecessorWorkId: unstarted.workId, projectPath: root })
    ).rejects.toMatchObject({ code: 'WORKTREE_FAILED' });

    // With no ledger the predecessor cannot be verified, so nothing is inherited.
    const memory = createWorktreeManager({ userDataDir: dir, worktreesRoot: path.join(dir, 'worktrees'), sleep: async () => undefined });
    await expect(
      memory.captureSuccessorBaseline({ workId: second.workId, predecessorWorkId: first.workId, projectPath: root })
    ).rejects.toMatchObject({ code: 'WORKTREE_FAILED' });
  });

  it('continues a project that is itself a linked worktree of another repository', async () => {
    // The project registry accepts a folder whose `.git` is a file — a linked worktree — so a
    // work may legitimately be admitted against one. Its root is not the parent of the shared
    // `.git` directory, which is exactly the assumption a "canonical project" shortcut gets wrong.
    const main = await repository({ 'f.txt': 'l1\nl2\nl3\n' });
    const linked = path.join(await makeTempDir('wgpt-wt-linked-'), 'feature');
    git(main, ['worktree', 'add', '-q', '-b', 'feature', linked]);
    // Git for Windows prints `C:/…`; the product resolves it (`path.resolve`) before comparing.
    expect(path.resolve(git(linked, ['rev-parse', '--show-toplevel']).trim())).toBe(linked);
    expect(git(linked, ['rev-parse', '--git-common-dir']).trim()).not.toBe(path.join(linked, '.git'));

    const { store, dir } = await ledger();
    const engine = manager(store, dir);
    const first = await predecessorWork(store, dir, linked);
    write(first.integration.path, 'result.txt', 'the result\n');
    await engine.checkpointWorktree({ path: first.integration.path, message: 'result' });
    store.setWorkStatus(first.workId, 'completed', 'test');

    const second = continuation(store, first.workId, linked);
    const baseline = await engine.captureSuccessorBaseline({
      workId: second.workId,
      predecessorWorkId: first.workId,
      projectPath: linked
    });
    expect(baseline.projectPath).toBe(linked);
    expect(git(linked, ['ls-tree', '-r', '--name-only', baseline.baselineCommit]).trim()).toContain('result.txt');
    // The worktree the successor lands in is created in the same checkout the ledger recorded.
    const assignment = await engine.ensureIntegrationWorktree({
      workId: second.workId,
      projectPath: baseline.projectPath,
      baselineCommit: baseline.baselineCommit,
      agentId: second.primeId
    });
    // Git for Windows prints the toplevel with forward slashes; the product resolves it natively.
    expect(path.resolve(git(assignment.path, ['rev-parse', '--show-toplevel']).trim())).toBe(path.resolve(assignment.path));
    expect(git(assignment.path, ['ls-tree', '-r', '--name-only', 'HEAD']).trim()).toContain('result.txt');
  });

  it('continues a work whose recorded project is a subfolder of the repository', async () => {
    // The project registry accepts any approved folder, including a package inside a repository.
    // Its recorded path is that subfolder, while the repository root is what Git reports.
    const root = await repository({ 'pkg/f.txt': 'l1\nl2\nl3\n', 'README.md': 'root\n' });
    const { store, dir } = await ledger();
    const engine = manager(store, dir);
    const projectPath = path.join(root, 'pkg');
    const first = await predecessorWork(store, dir, projectPath);
    write(first.integration.path, 'pkg/result.txt', 'result\n');
    await engine.checkpointWorktree({ path: first.integration.path, message: 'result' });
    store.setWorkStatus(first.workId, 'completed', 'test');

    const second = continuation(store, first.workId, projectPath);
    const baseline = await engine.captureSuccessorBaseline({
      workId: second.workId,
      predecessorWorkId: first.workId,
      projectPath
    });
    // The snapshot is still the predecessor's result; the repository root is where the successor
    // worktree is created, so the caller never has to know the difference.
    expect(baseline.projectPath).toBe(root);
    expect(git(root, ['ls-tree', '-r', '--name-only', baseline.baselineCommit]).trim()).toContain('pkg/result.txt');
    const assignment = await engine.ensureIntegrationWorktree({
      workId: second.workId,
      projectPath: baseline.projectPath,
      baselineCommit: baseline.baselineCommit,
      agentId: second.primeId
    });
    expect(git(assignment.path, ['ls-tree', '-r', '--name-only', 'HEAD']).trim()).toContain('pkg/result.txt');

    // The destination is still the ledger's to name: a request that spells the repository root
    // for a work recorded against the subfolder is a mismatch, not a convenient upgrade.
    const sibling = await predecessorWork(store, dir, projectPath);
    store.setWorkStatus(sibling.workId, 'completed', 'test');
    const other = continuation(store, sibling.workId, projectPath);
    await expect(
      engine.captureSuccessorBaseline({ workId: other.workId, predecessorWorkId: sibling.workId, projectPath: root })
    ).rejects.toMatchObject({ code: 'PROJECT_MISMATCH' });
  });

  it('reads back the same baseline after a restart, including when the ledger hides the link', async () => {
    const root = await repository({ 'f.txt': 'l1\nl2\nl3\n' });
    const { store, dir } = await ledger();
    const engine = manager(store, dir);
    const first = await predecessorWork(store, dir, root);
    write(first.integration.path, 'result.txt', 'first result\n');
    await engine.checkpointWorktree({ path: first.integration.path, message: 'first result' });
    store.setWorkStatus(first.workId, 'completed', 'test');
    const second = continuation(store, first.workId, root);
    const baseline = await engine.captureSuccessorBaseline({
      workId: second.workId,
      predecessorWorkId: first.workId,
      projectPath: root
    });

    // The predecessor keeps working after its result was recorded — a later commit on the same
    // integration branch. The successor's baseline is the recorded one, not the newer commit.
    write(first.integration.path, 'later.txt', 'after the result was recorded\n');
    await engine.checkpointWorktree({ path: first.integration.path, message: 'later work' });

    // A fresh manager over the same ledger answers identically: nothing lives in process memory.
    const restarted = manager(store, dir);
    const replayed = await restarted.captureSuccessorBaseline({
      workId: second.workId,
      predecessorWorkId: first.workId,
      projectPath: root
    });
    expect(replayed.baselineCommit).toBe(baseline.baselineCommit);
    expect(replayed.manifest).toEqual(baseline.manifest);
    expect(git(root, ['ls-tree', '-r', '--name-only', replayed.baselineCommit]).trim()).not.toContain('later.txt');

    // A host whose ledger predates the continuation link exposes no `predecessor_work_id`, so the
    // retained source ref is the only record of where the work started. It is enough: a request
    // naming a different predecessor is still refused, and the recorded baseline still stands.
    const linkedStore = store.getWork(first.workId);
    const hidden = createWorktreeManager({
      userDataDir: dir,
      worktreesRoot: path.join(dir, 'worktrees'),
      sleep: async () => undefined,
      store: {
        assignWorktree: record => store.assignWorktree(record),
        getWorktreeAssignment: (workId, agentId) => store.getWorktreeAssignment(workId, agentId),
        listWorktreeAssignments: workId => store.listWorktreeAssignments(workId),
        setIntegrationIntent: (workId, intent) => store.setIntegrationIntent(workId, intent),
        getIntegrationIntent: workId => store.getIntegrationIntent(workId),
        clearIntegrationIntent: workId => store.clearIntegrationIntent(workId),
        getWork: workId => {
          const row = store.getWork(workId);
          if (!row) return null;
          return { project_path: row.project_path, status: row.status, desired_state: row.desired_state };
        }
      }
    });
    expect(linkedStore).not.toBeNull();
    const alternative = await predecessorWork(store, dir, root);
    store.setWorkStatus(alternative.workId, 'completed', 'test');
    const third = continuation(store, alternative.workId, root);
    await expect(
      hidden.captureSuccessorBaseline({ workId: second.workId, predecessorWorkId: alternative.workId, projectPath: root })
    ).rejects.toMatchObject({ code: 'SUCCESSOR_SOURCE_MISMATCH' });
    const replayedAgain = await hidden.captureSuccessorBaseline({
      workId: second.workId,
      predecessorWorkId: first.workId,
      projectPath: root
    });
    expect(replayedAgain.baselineCommit).toBe(baseline.baselineCommit);

    // The predecessor is resumed after its result was recorded — the same work is running again.
    // The successor's start stage, replayed by a restart, still answers with the baseline it
    // recorded: that fact does not depend on what the predecessor is doing now.
    store.setWorkStatus(first.workId, 'running', 'test');
    const stillRecorded = await restarted.captureSuccessorBaseline({
      workId: second.workId,
      predecessorWorkId: first.workId,
      projectPath: root
    });
    expect(stillRecorded.baselineCommit).toBe(baseline.baselineCommit);
    expect(stillRecorded.manifest).toEqual(baseline.manifest);

    // A third work inherits from the same predecessor independently, and its own baseline is the
    // later state — each work keeps its own starting point.
    const independent = await restarted.captureSuccessorBaseline({
      workId: third.workId,
      predecessorWorkId: alternative.workId,
      projectPath: root
    });
    expect(independent.baselineCommit).not.toBe(baseline.baselineCommit);
    expect(git(root, ['rev-parse', `refs/web-gpt-agent/${third.workId}/base`]).trim()).toBe(independent.baselineCommit);
  });
});
