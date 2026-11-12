/**
 * Where a relative path points, and how scoped execution identity is resolved.
 *
 * Two things are defended here. A relative path is shorthand for a path *inside a folder the user
 * approved* — or inside a base the calling tool explicitly named — and never for a folder this
 * process remembered from an earlier conversation; that is what makes an ordinary read or command
 * independent of which chat happened to run something before it, and it is why the sandbox below
 * is the only thing deciding what may be reached.
 *
 * Code-mode stores and search cursors retain their request/session principals. Ordinary terminal
 * process IDs are shared across chats and do not use those principals for access.
 */

import { promises as fs } from 'node:fs';
import path from 'node:path';
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { emptyEvidence, runInCallContext, type CallContext } from '../src/main/mcp/call-context.js';
import { executionPrincipal } from '../src/main/codex/ownership.js';
import { observeRequestCorrelation, resetCorrelationRegistryForTests } from '../src/main/session/correlation.js';
import { resetRequestPlansForTests } from '../src/main/session/request-plans.js';
import { resolveCwd, resolveIn } from '../src/main/mcp/kernel.js';
import { SandboxError, resolvePath } from '../src/main/sandbox.js';
import { defaultConfig } from '../src/main/config.js';
import * as configModule from '../src/main/config.js';
import type { Root } from '../src/shared/types.js';
import { DIR_LINK, makeTempDir, removeTempDir, writeTree } from './helpers.js';

let base = '';
let approved = '';
let outside = '';
let roots: Root[] = [];

function asAgent(agent: string | null): CallContext {
  return {
    startedAt: Date.now(),
    transportKey: null,
    agent,
    caller: { transportKey: null, requestId: null, conversationId: agent ? `conv-${agent}` : null },
    outcome: null,
    evidence: emptyEvidence()
  } as CallContext;
}

const run = <T>(agent: string | null, fn: () => T): T => runInCallContext(asAgent(agent), fn);

beforeAll(async () => {
  base = await makeTempDir('wgpt-paths-');
  approved = path.join(base, 'approved');
  outside = path.join(base, 'outside');
  await writeTree(approved, {
    'project/.git/HEAD': 'ref: refs/heads/main\n',
    'project/package.json': '{"name":"project"}\n',
    'project/src/main/patch.ts': 'export const patch = 1;\n',
    'project/src/renderer/chat.ts': 'export const chat = 1;\n',
    'project/notes.txt': 'top level\n',
    'other/package.json': '{"name":"other"}\n',
    'other/src/index.ts': 'export const other = 1;\n',
    'loose/file.txt': 'no marker anywhere\n'
  });
  await writeTree(outside, { 'secret.txt': 'hunter2\n' });
  await fs.symlink(outside, path.join(approved, 'project', 'escape'), DIR_LINK).catch(() => undefined);
  roots = [{ name: 'workspace', path: approved }];
});

afterAll(async () => {
  await removeTempDir(base);
});

beforeEach(() => {
  resetCorrelationRegistryForTests();
  resetRequestPlansForTests();
});

describe('scoped code-mode and search identity', () => {
  it('upgrades a request principal to its proven session', () => {
    const temporary = executionPrincipal('wfr_exec_request', null, true);
    expect(temporary).toBe('request:wfr_exec_request');
    expect(observeRequestCorrelation({
      requestId: 'wfr_exec_request', conversationId: 'conv-request', sessionId: 'session-request',
      messageId: 'msg-request', tool: 'write_stdin', observedAt: Date.now()
    })).toBe('stored');
    expect(executionPrincipal('wfr_exec_request', null, true)).toBe('session-request');
  });
});

describe('a relative path starts at an approved folder, not at a remembered one', () => {
  it('resolves against the first approved task root', async () => {
    const resolved = await resolveIn(roots, 'project/notes.txt');
    expect(resolved.virtual).toBe('/workspace/project/notes.txt');
    expect(resolved.real).toBe(path.join(approved, 'project', 'notes.txt'));
  });

  it('gives the same answer to two different callers', async () => {
    // Nothing about the caller is consulted. That is the whole point: a fresh chat, a phone, a
    // headless run and a worker all read the same file for the same argument.
    const one = await run('worker-1', () => resolveIn(roots, 'project/notes.txt'));
    const two = await run('worker-2', () => resolveIn(roots, 'project/notes.txt'));
    const anonymous = await run(null, () => resolveIn(roots, 'project/notes.txt'));
    expect(two.virtual).toBe(one.virtual);
    expect(anonymous.virtual).toBe(one.virtual);
  });

  it('honours an explicit base the calling tool named', async () => {
    const resolved = await resolveIn(roots, 'src/index.ts', { base: '/workspace/other' });
    expect(resolved.virtual).toBe('/workspace/other/src/index.ts');
  });

  it('still needs an approved root to resolve anything', async () => {
    await expect(resolveIn([], 'notes.txt')).rejects.toThrow(SandboxError);
    await expect(resolveCwd({ roots: [], caps: defaultConfig().capabilities, readOnly: false }, undefined))
      .rejects.toThrow(/No folder is approved/);
  });

  it('uses native cwd and relative home when all-files is explicitly enabled without roots', async () => {
    const config = { ...defaultConfig(), fileAccessMode: 'all-files' as const };
    const live = vi.spyOn(configModule, 'getConfig').mockReturnValue(config);
    try {
      const cwd = await resolveCwd({ roots: [], caps: config.capabilities, readOnly: false }, outside);
      expect(cwd.real).toBe(outside);
      expect((await resolveIn([], 'secret.txt', { base: cwd.virtual })).real).toBe(path.join(outside, 'secret.txt'));
      expect((await resolveCwd({ roots: [], caps: config.capabilities, readOnly: false }, undefined)).defaulted).toBe(true);
      live.mockReturnValue({ ...config, fileAccessMode: 'approved-roots' });
      await expect(resolveCwd({ roots: [], caps: config.capabilities, readOnly: false }, outside))
        .rejects.toThrow(SandboxError);
    } finally { live.mockRestore(); }
  });

  it('defaults a command with no workdir to the first approved root', async () => {
    const dir = await resolveCwd({ roots, caps: defaultConfig().capabilities, readOnly: false }, undefined);
    expect(dir.virtual).toBe('/workspace');
    expect(dir.defaulted).toBe(true);
    expect((await resolveCwd({ roots, caps: defaultConfig().capabilities, readOnly: false }, '/workspace/other')).virtual)
      .toBe('/workspace/other');
  });
});

describe('the sandbox is still the boundary', () => {
  it('refuses shorthand that climbs out of the root', async () => {
    // The point of prefixing before validation rather than joining and normalising: the `..` is
    // still there when checkSegment sees it. `posix.normalize` would have turned this into a
    // clean-looking path with nothing left to refuse.
    await expect(run('worker-1', () => resolveIn(roots, '../other/src/index.ts'))).rejects.toThrow(SandboxError);
    await expect(run('worker-1', () => resolveIn(roots, '../../outside/secret.txt'))).rejects.toThrow(SandboxError);
    await expect(run('worker-1', () => resolveIn(roots, '..\\..\\outside\\secret.txt'))).rejects.toThrow(SandboxError);
  });

  it('refuses shorthand that climbs out of an explicit base', async () => {
    await expect(resolveIn(roots, '../../outside/secret.txt', { base: '/workspace/project' })).rejects.toThrow(SandboxError);
  });

  it('refuses a symlink out of the root', async () => {
    await expect(run('worker-1', () => resolveIn(roots, 'project/escape/secret.txt'))).rejects.toThrow(SandboxError);
  });

  it('refuses a native path outside every approved root', async () => {
    await expect(run('worker-1', () => resolveIn(roots, path.join(outside, 'secret.txt')))).rejects.toThrow(SandboxError);
  });

  it('leaves absolute virtual paths meaning exactly what they always meant', async () => {
    const resolved = await resolveIn(roots, '/workspace/other/src/index.ts');
    expect(resolved.virtual).toBe('/workspace/other/src/index.ts');
    // And the same path resolves identically outside any call context at all, which is what makes
    // every existing caller and every stored path still correct.
    const direct = await resolvePath(roots, '/workspace/other/src/index.ts');
    expect(direct.virtual).toBe(resolved.virtual);
    expect(direct.real).toBe(resolved.real);
  });

  it('refuses an absolute path that traverses, instead of normalising it away', async () => {
    await expect(run('worker-1', () => resolveIn(roots, '/workspace/project/../../outside/secret.txt'))).rejects.toThrow(
      SandboxError
    );
  });
});
