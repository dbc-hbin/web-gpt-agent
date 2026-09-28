import { createCipheriv, createDecipheriv, randomBytes } from 'node:crypto';

/**
 * The cipher a host without Electron uses for `secrets.bin`.
 *
 * A daemon runs on plain Node, where `safeStorage` does not exist. The honest answers were
 * "no credential store, refuse every write" (what shipped first) or "invent a plaintext file"
 * (never acceptable). This is the third: the operator supplies one 256-bit key from the
 * environment, and the same encrypted blob format is used — AES-256-GCM with a random nonce and
 * an authentication tag, so a modified file fails to decrypt rather than yielding garbage
 * credentials.
 *
 * Three properties matter and are deliberate:
 *
 *   - **The key never touches disk.** It is read from `WGPT_SECRET_KEY` at startup and lives only
 *     in this process. Nothing here writes a key file, and no fallback key is invented — without
 *     a usable key this returns null and every secret write is refused, exactly as before.
 *   - **The ciphertext is self-describing.** A four-byte version prefix precedes the nonce, so a
 *     blob written by this cipher is recognisably its own and a foreign file is refused by name
 *     instead of being guessed at.
 *   - **A changed key is a refusal, not a rotation.** The GCM tag is the whole authority: a file
 *     sealed under a different key does not authenticate, so the read fails and the file is left
 *     untouched. There is deliberately no reseal path and no recorded key fingerprint, because a
 *     fingerprint could never be reached — the tag fails first — and a `shouldReEncrypt` that can
 *     only ever be false is a claim about a rotation this host does not perform. An operator who
 *     replaces the key is choosing to make the stored credential unreachable, and the refusal says
 *     exactly that.
 */

/** Marks the blob as this cipher's, so a foreign file is rejected instead of guessed at. */
const BLOB_MAGIC = Buffer.from('WGK1', 'utf8');
/** AES-256-GCM: 12-byte nonce and 16-byte tag are the sizes this mode defines. */
const NONCE_BYTES = 12;
const TAG_BYTES = 16;
const KEY_BYTES = 32;

/** The environment variable that carries the key. Named here so every refusal can quote it. */
export const HEADLESS_KEY_ENV = 'WGPT_SECRET_KEY';

export const NO_HEADLESS_KEY_DETAIL =
  `No ${HEADLESS_KEY_ENV} is set, so this process cannot protect stored credentials. Set it to a ` +
  '32-byte key (base64 or 64 hex characters) to let this host keep secrets encrypted at rest.';

/** The shape `secrets.ts` needs, matching Electron's async safeStorage surface. */
export interface HeadlessCipher {
  isAvailable: () => Promise<boolean>;
  encrypt: (plaintext: string) => Promise<Buffer>;
  decrypt: (ciphertext: Buffer) => Promise<{ result: string; shouldReEncrypt: boolean }>;
}

export class HeadlessKeyError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'HeadlessKeyError';
  }
}

/**
 * Parses the key material.
 *
 * Both spellings are accepted because both are what an operator naturally produces: `openssl
 * rand -base64 32` and `openssl rand -hex 32`. Anything that is not exactly 32 bytes is refused
 * by name rather than padded or truncated — a short key silently stretched into 32 bytes would
 * look fine and protect nothing.
 */
export function parseHeadlessKey(raw: string | undefined | null): Buffer | null {
  const text = (raw ?? '').trim();
  if (text === '') return null;
  const hex = /^[0-9a-f]{64}$/i.test(text);
  const key = hex ? Buffer.from(text, 'hex') : Buffer.from(text, 'base64');
  if (key.length !== KEY_BYTES) {
    throw new HeadlessKeyError(
      `${HEADLESS_KEY_ENV} must decode to exactly ${KEY_BYTES} bytes; got ${key.length}. ` +
        'Generate one with `openssl rand -base64 32`.'
    );
  }
  return key;
}

/**
 * Builds the cipher for one key, or null when the environment carries no usable key.
 *
 * A malformed key throws rather than degrading to "no store": an operator who set the variable
 * meant to protect their credentials, and silently falling back to a refused-writes host would
 * look like the daemon ignoring them.
 */
export function createHeadlessCipher(rawKey: string | undefined | null = process.env[HEADLESS_KEY_ENV]): HeadlessCipher | null {
  const key = parseHeadlessKey(rawKey);
  if (!key) return null;

  return {
    isAvailable: async () => true,
    encrypt: async (plaintext: string) => {
      const nonce = randomBytes(NONCE_BYTES);
      const cipher = createCipheriv('aes-256-gcm', key, nonce);
      const sealed = Buffer.concat([cipher.update(plaintext, 'utf8'), cipher.final()]);
      return Buffer.concat([BLOB_MAGIC, nonce, cipher.getAuthTag(), sealed]);
    },
    decrypt: async (ciphertext: Buffer) => {
      const minimum = BLOB_MAGIC.length + NONCE_BYTES + TAG_BYTES;
      if (ciphertext.length < minimum || !ciphertext.subarray(0, BLOB_MAGIC.length).equals(BLOB_MAGIC)) {
        throw new HeadlessKeyError(
          'The stored credentials were not written by this host, so they cannot be read. ' +
            'Use the host that wrote them, or clear them and store the credential again.'
        );
      }
      const nonce = ciphertext.subarray(BLOB_MAGIC.length, BLOB_MAGIC.length + NONCE_BYTES);
      const tag = ciphertext.subarray(minimum - TAG_BYTES, minimum);
      const body = ciphertext.subarray(minimum);
      const decipher = createDecipheriv('aes-256-gcm', key, nonce);
      decipher.setAuthTag(tag);
      let result: string;
      try {
        result = Buffer.concat([decipher.update(body), decipher.final()]).toString('utf8');
      } catch {
        // The tag did not verify: a wrong key or a modified file. Both are refusals, and neither
        // may be reported as "no credentials" — that would invite overwriting the file.
        throw new HeadlessKeyError(
          'Stored credentials could not be decrypted: the file does not authenticate against the ' +
            `current ${HEADLESS_KEY_ENV}. The file was left untouched.`
        );
      }
      // Never a reseal request. This host has no second key provider to rotate *to*, and a file
      // written under another key cannot reach this line at all — it fails the tag check above.
      return { result, shouldReEncrypt: false };
    }
  };
}
