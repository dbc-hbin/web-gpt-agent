import { afterEach, describe, expect, it } from 'vitest';
import { randomBytes } from 'node:crypto';
import { createHeadlessCipher, parseHeadlessKey, HeadlessKeyError, NO_HEADLESS_KEY_DETAIL } from '../src/daemon/headless-cipher.js';
import { getSecret, hasSecret, initSecretsPath, installSecretCipher, resetSecretsCacheForTests, secureStorageStatus, setSecret } from '../src/main/secrets.js';
import { makeTempDir, removeTempDir } from './helpers.js';
import { promises as fs } from 'node:fs';
import path from 'node:path';

/**
 * The cipher a host without Electron uses for `secrets.bin`.
 *
 * Three things are being defended, and each has an obvious cheaper version that is wrong:
 *
 *   - **A missing key refuses writes.** "No key" must never degrade into a plaintext store, so the
 *     store reports itself unavailable and a write fails by name.
 *   - **A wrong key does not silently produce garbage.** GCM's tag is the authority: a file sealed
 *     under another key is a refusal, not a set of credentials that happen to be unreadable.
 *   - **The value round-trips through the real store.** These are tested through `secrets.ts`
 *     rather than the cipher alone, because the contract that matters is the one the rest of the
 *     app uses — including the presence-only reporting a daemon relies on.
 */

const cleanups: Array<() => Promise<void>> = [];
afterEach(async () => {
  installSecretCipher(null);
  resetSecretsCacheForTests();
  for (const cleanup of cleanups.splice(0)) await cleanup().catch(() => undefined);
});

function key(): string {
  return randomBytes(32).toString('base64');
}

async function dataDir(): Promise<string> {
  const dir = await makeTempDir('wgpt-secret-');
  cleanups.push(() => removeTempDir(dir));
  return dir;
}

describe('headless key parsing', () => {
  it('accepts the two spellings an operator actually produces, and refuses anything else', () => {
    const raw = randomBytes(32);
    expect(parseHeadlessKey(raw.toString('base64'))?.equals(raw)).toBe(true);
    expect(parseHeadlessKey(raw.toString('hex'))?.equals(raw)).toBe(true);
    expect(parseHeadlessKey('')).toBeNull();
    expect(parseHeadlessKey(undefined)).toBeNull();
    // Not padded or stretched: a short key would look fine and protect nothing.
    expect(() => parseHeadlessKey(randomBytes(16).toString('base64'))).toThrow(HeadlessKeyError);
    expect(() => parseHeadlessKey('not a key')).toThrow(/exactly 32 bytes/);
  });
});

describe('headless cipher', () => {
  it('round-trips a value, and a changed key is a refusal rather than garbage', async () => {
    const cipher = createHeadlessCipher(key())!;
    const sealed = await cipher.encrypt('sk-a-real-looking-credential');
    // The plaintext is not in the file, and the blob is recognisably this cipher's.
    expect(sealed.toString('utf8')).not.toContain('sk-a-real-looking-credential');
    expect(sealed.subarray(0, 4).toString('utf8')).toBe('WGK1');
    const opened = await cipher.decrypt(sealed);
    expect(opened.result).toBe('sk-a-real-looking-credential');
    expect(opened.shouldReEncrypt).toBe(false);

    const other = createHeadlessCipher(key())!;
    await expect(other.decrypt(sealed)).rejects.toThrow(/could not be decrypted/);

    // A tampered body is caught by the tag, not returned as a mangled credential.
    const tampered = Buffer.from(sealed);
    tampered[tampered.length - 1] = tampered[tampered.length - 1]! ^ 0xff;
    await expect(cipher.decrypt(tampered)).rejects.toThrow(/could not be decrypted/);

    // A file written by some other tool is rejected by name instead of guessed at.
    await expect(cipher.decrypt(Buffer.from('v10' + 'x'.repeat(64)))).rejects.toThrow(/not written by this host/);
  });

  it('reports no reseal request, because a changed key is a refusal rather than a rotation', async () => {
    const material = key();
    const first = createHeadlessCipher(material)!;
    const sealed = await first.encrypt('{}');
    // The same key material in a rebuilt cipher still authenticates, and still asks for nothing:
    // there is no second provider to rotate to, so the flag is never set.
    const rebuilt = createHeadlessCipher(material)!;
    expect((await rebuilt.decrypt(sealed)).shouldReEncrypt).toBe(false);
    expect((await rebuilt.decrypt(sealed)).result).toBe('{}');
    // A different key cannot even authenticate the blob, so no rotation path is reachable from it:
    // that is the refusal tested above, not a silent reseal.
    const other = createHeadlessCipher(key())!;
    await expect(other.decrypt(sealed)).rejects.toThrow(/could not be decrypted/);
  });
});

describe('secret storage through the real store', () => {
  it('stores, reads and clears a credential, and never needs the OS keychain', async () => {
    const dir = await dataDir();
    initSecretsPath(dir);
    const material = key();
    installSecretCipher(createHeadlessCipher(material), null);

    expect(await secureStorageStatus()).toMatchObject({ available: true });
    await setSecret('openaiApiKey', '  sk-trimmed-value  ');
    expect(await getSecret('openaiApiKey')).toBe('sk-trimmed-value');
    expect(await hasSecret('openaiApiKey')).toBe(true);

    // The file on disk is ciphertext, not the credential.
    const raw = await fs.readFile(path.join(dir, 'secrets.bin'), 'utf8');
    expect(raw).not.toContain('sk-trimmed-value');
    expect(raw.startsWith('WGK1')).toBe(true);

    // A fresh process (cache dropped, same key from the environment) reads it back.
    resetSecretsCacheForTests();
    installSecretCipher(createHeadlessCipher(material), null);
    expect(await getSecret('openaiApiKey')).toBe('sk-trimmed-value');

    // Clearing removes it, and the removal is durable.
    await setSecret('openaiApiKey', '');
    resetSecretsCacheForTests();
    installSecretCipher(createHeadlessCipher(material), null);
    expect(await getSecret('openaiApiKey')).toBeNull();
  });

  it('refuses writes with an actionable reason when no key is supplied', async () => {
    const dir = await dataDir();
    initSecretsPath(dir);
    installSecretCipher(null, NO_HEADLESS_KEY_DETAIL);

    const status = await secureStorageStatus();
    expect(status.available).toBe(false);
    // The reason names the variable, because "no OS credential store" would be true and useless.
    expect(status.detail).toContain('WGPT_SECRET_KEY');
    await expect(setSecret('openaiApiKey', 'sk-x')).rejects.toThrow(/Secure OS credential storage is unavailable/);
    // A read degrades to "no credential" rather than throwing, so startup still works.
    expect(await getSecret('openaiApiKey')).toBeNull();
  });

  it('refuses to overwrite a store sealed under a key this host no longer has', async () => {
    const dir = await dataDir();
    initSecretsPath(dir);
    installSecretCipher(createHeadlessCipher(key()), null);
    await setSecret('openaiApiKey', 'sk-original');

    // The operator replaced WGPT_SECRET_KEY and restarted.
    resetSecretsCacheForTests();
    installSecretCipher(createHeadlessCipher(key()), null);
    // The read degrades rather than throwing, and a mutation must fail: composing from the empty
    // view would destroy a credential that is merely unreadable *here*.
    expect(await getSecret('openaiApiKey')).toBeNull();
    await expect(setSecret('openaiApiKey', 'sk-replacement')).rejects.toThrow(/credential storage is unavailable/);
    expect(await fs.readFile(path.join(dir, 'secrets.bin'), 'utf8')).toContain('WGK1');
    expect(await getSecret('openaiApiKey')).toBeNull();
  });
});
