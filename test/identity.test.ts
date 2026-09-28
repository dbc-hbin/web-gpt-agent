/**
 * The two properties that make `identity.ts` worth existing.
 *
 * Everything else in that module is a constant or a path join. These are the two that can
 * be silently wrong in a way nobody notices until data is in the wrong place: which
 * directory a run writes to, and how private it is. Both are asserted against the real
 * filesystem, because "mode 0700" is a fact about a directory, not about a string.
 */

import { promises as fs } from 'node:fs';
import path from 'node:path';
import { afterEach, expect, it } from 'vitest';
import {
  BUNDLE_ID,
  CORE_SERVER_NAME,
  NPM_NAME,
  PRODUCT_NAME,
  browserProfileDir,
  defaultUserDataDir,
  ensurePrivateDir,
  getInstallationId,
  readPrivateFile,
  resetIdentityForTests,
  resolveDataDir,
  writePrivateFile
} from '../src/main/identity.js';
import { makeTempDir, removeTempDir, IS_WINDOWS } from './helpers.js';

const temps: string[] = [];
async function temp(): Promise<string> {
  const dir = await makeTempDir('wgpt-identity-');
  temps.push(dir);
  return dir;
}
afterEach(async () => {
  resetIdentityForTests();
  await Promise.all(temps.splice(0).map((dir) => removeTempDir(dir)));
});

it('keeps the product identity this fork is packaged as', () => {
  expect(PRODUCT_NAME).toBe('Web GPT Agent');
  expect(NPM_NAME).toBe('web-gpt-agent');
  expect(BUNDLE_ID).toBe('com.webgptagent.app');
  expect(CORE_SERVER_NAME).toBe('web-gpt-agent-core');
});

it('defaults to this fork’s own data directory, never upstream’s', () => {
  const dir = defaultUserDataDir('darwin', { HOME: '/Users/example' });
  expect(dir).toBe('/Users/example/Library/Application Support/web-gpt-agent');
  expect(dir).not.toContain('chat-on-steroids');
  expect(browserProfileDir(dir)).toBe(path.join(dir, 'browser-profile'));
});

it('accepts an absolute --data-dir in any position and refuses a relative one', () => {
  const absolute = path.resolve('/tmp/wgpt-isolated');
  expect(resolveDataDir(['app', '--data-dir', absolute])).toBe(absolute);
  expect(resolveDataDir(['app', `--data-dir=${absolute}`, 'work', 'list'])).toBe(absolute);
  // A global flag documented as usable before or after the subcommand has to actually be
  // found in both places; the last occurrence wins, as with every other option parser.
  expect(resolveDataDir(['app', '--data-dir', '/tmp/first', 'work', 'list', '--data-dir', '/tmp/second']))
    .toBe(path.normalize('/tmp/second'));
  // A relative path would silently mean a different directory per working directory, which
  // is the one thing this flag exists to prevent.
  expect(() => resolveDataDir(['app', '--data-dir', 'relative/dir'])).toThrow(/absolute/i);
  expect(() => resolveDataDir(['app', '--data-dir'])).toThrow(/absolute/i);
});

it('creates private directories at 0700 and secret files at 0600', async () => {
  const root = await temp();
  const dir = path.join(root, 'nested', 'data');
  ensurePrivateDir(dir);
  const file = path.join(dir, 'installation-id');
  writePrivateFile(file, 'abc');
  expect(await readPrivateFile(file)).toBe('abc');
  if (IS_WINDOWS) return;
  expect((await fs.stat(dir)).mode & 0o777).toBe(0o700);
  expect((await fs.stat(file)).mode & 0o777).toBe(0o600);
  // An existing directory created by something else keeps its own permissions, so the
  // chmod is what makes the guarantee hold rather than the mkdir mode alone.
  await fs.chmod(dir, 0o755);
  ensurePrivateDir(dir);
  expect((await fs.stat(dir)).mode & 0o777).toBe(0o700);
});

it('creates the installation id once and then reuses it across processes', async () => {
  const dir = await temp();
  const first = getInstallationId(dir);
  expect(first).toMatch(/^[0-9a-f-]{36}$/);
  // Same process: cached. New process: read back from the 0600 file rather than regenerated,
  // because losing it would make this companion a stranger to its own host.
  expect(getInstallationId(dir)).toBe(first);
  resetIdentityForTests();
  expect(getInstallationId(dir)).toBe(first);
  const stored = await readPrivateFile(path.join(dir, 'installation-id'));
  expect(stored?.trim()).toBe(first);
});
