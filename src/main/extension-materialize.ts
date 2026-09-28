/**
 * Where the Chrome extension lives on this machine.
 *
 * Chrome loads an unpacked extension from a real folder, so the extension cannot live
 * inside the asar — it ships as an extraResource and is copied out verbatim by the
 * package. Both development and packaged builds materialize a copy in the app's
 * stable per-user data directory, seeded with the installation it must connect to.
 * That extra hop matters on Linux AppImage: `process.resourcesPath` lives in a temporary
 * mount which disappears when the app exits, while Chrome remembers the exact folder used
 * for Load unpacked. The per-user copy keeps that path stable on every desktop OS and is
 * refreshed from the package on every launch/update.
 */

import { createHash } from 'node:crypto';
import {
  cpSync,
  existsSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  renameSync,
  rmSync,
  statSync,
  writeFileSync
} from 'node:fs';
import path from 'node:path';
import { EXTENSION_HOST_SEED_FILE, getInstallationId } from './identity.js';

const MATERIALIZED_FINGERPRINT = '.web-gpt-agent-source';

function extensionFingerprint(root: string): string {
  const hash = createHash('sha256');
  const visit = (dir: string, relativeDir = ''): void => {
    const entries = readdirSync(dir, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name));
    for (const entry of entries) {
      const relative = relativeDir ? path.posix.join(relativeDir, entry.name) : entry.name;
      const absolute = path.join(dir, entry.name);
      if (entry.isDirectory()) {
        hash.update(`d\0${relative}\0`);
        visit(absolute, relative);
      } else if (entry.isFile()) {
        hash.update(`f\0${relative}\0`);
        hash.update(readFileSync(absolute));
        hash.update('\0');
      } else {
        // The shipped extension is plain files/directories. Refuse an unexpected special entry
        // instead of materializing host-dependent links/devices into Chrome's trusted folder.
        throw new Error(`Unsupported extension entry: ${relative}`);
      }
    }
  };
  visit(root);
  return hash.digest('hex');
}

function validExtension(dir: string): boolean {
  try {
    return statSync(path.join(dir, 'manifest.json')).isFile();
  } catch {
    return false;
  }
}

function materializedFingerprint(dir: string): string | null {
  try {
    return readFileSync(path.join(dir, MATERIALIZED_FINGERPRINT), 'utf8').trim() || null;
  } catch {
    return null;
  }
}

function recoverInterruptedMaterialization(stable: string, stage: string, backup: string): void {
  if (validExtension(stable)) return;

  // The backup is authoritative over staging: it was the previously published Chrome folder,
  // whereas `.new` may have been copied but not yet promoted when the process stopped.
  if (validExtension(backup)) {
    if (existsSync(stable)) rmSync(stable, { recursive: true, force: true });
    renameSync(backup, stable);
    rmSync(stage, { recursive: true, force: true });
    return;
  }

  // First-install crashes have no old copy to restore. A staged tree is recoverable only after
  // our fingerprint marker was written, which happens after the recursive copy and manifest
  // validation complete. A partial `.new` without that marker is never promoted.
  if (validExtension(stage) && materializedFingerprint(stage) !== null) {
    if (existsSync(stable)) rmSync(stable, { recursive: true, force: true });
    renameSync(stage, stable);
  }
}

/**
 * Refreshes the Chrome-visible copy transactionally while keeping its pathname stable.
 *
 * Copying package files directly into a folder Chrome already remembers makes an update
 * destructive before it is known-good: a stale destination shape, disk error, or interrupted
 * copy can leave a mixture of two extension versions. Stage the complete source beside the live
 * directory, then rename it into place. Directory rename is atomic on the same filesystem. The
 * backup makes the two-rename replacement recoverable, and a failed refresh keeps serving the
 * previous valid copy instead of disabling the extension-folder UI.
 */
export function materializeExtension(bundled: string, stable: string): string | null {
  const stage = `${stable}.new`;
  const backup = `${stable}.old`;
  mkdirSync(path.dirname(stable), { recursive: true });
  recoverInterruptedMaterialization(stable, stage, backup);

  // The package is the update source, not the only usable copy. If an installed resource is
  // damaged after a successful earlier materialization, keep exposing the last-known-good stable
  // folder so Chrome and Finder do not lose a working extension merely because refresh is broken.
  if (!validExtension(bundled)) return validExtension(stable) ? stable : null;
  const hostId = getInstallationId(path.dirname(stable));
  const fingerprint = `${extensionFingerprint(bundled)}:${hostId}`;
  if (validExtension(stable) && materializedFingerprint(stable) === fingerprint) return stable;
  rmSync(stage, { recursive: true, force: true });

  let oldMoved = false;
  try {
    cpSync(bundled, stage, { recursive: true, force: true });
    if (!validExtension(stage)) throw new Error('Staged extension is missing manifest.json');
    writeFileSync(path.join(stage, EXTENSION_HOST_SEED_FILE),
      `export const HOST_INSTALLATION_ID = ${JSON.stringify(hostId)};\n`, { encoding: 'utf8', mode: 0o600 });
    writeFileSync(path.join(stage, MATERIALIZED_FINGERPRINT), fingerprint, { encoding: 'utf8', mode: 0o600 });

    // Only now do we have both a complete replacement and whatever last-known-good published
    // copy survived recovery above. It is safe to retire a stale backup from an older transaction.
    rmSync(backup, { recursive: true, force: true });
    if (existsSync(stable)) {
      if (validExtension(stable)) {
        renameSync(stable, backup);
        oldMoved = true;
      } else {
        // Never preserve a known-corrupt directory as the rollback authority. This removal is
        // delayed until the new staged tree has been completely copied and fingerprinted.
        rmSync(stable, { recursive: true, force: true });
      }
    }
    try {
      renameSync(stage, stable);
    } catch (error) {
      if (oldMoved && !existsSync(stable) && existsSync(backup)) renameSync(backup, stable);
      throw error;
    }
    if (oldMoved) rmSync(backup, { recursive: true, force: true });
    return stable;
  } catch {
    // If rollback succeeded, the stale/partial stage is disposable. If no published copy exists,
    // preserve a completed stage or backup for the next startup's recovery instead of deleting
    // the only remaining recoverable material.
    if (validExtension(stable)) rmSync(stage, { recursive: true, force: true });
    // Promotion never mutates the old directory in place. If it is still valid, keeping it is a
    // strictly safer recovery than telling the user the extension disappeared during an update.
    return validExtension(stable) ? stable : null;
  }
}
