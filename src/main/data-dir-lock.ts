import { promises as fs } from 'node:fs';
import path from 'node:path';

/** The exclusive owner claim shared by every process that can open one data directory. */
export const DATA_DIR_LOCK_FILE = 'daemon.lock';
const DATA_DIR_RECLAIM_FILE = `${DATA_DIR_LOCK_FILE}.reclaim`;

interface DataDirLockRecord {
  pid: number;
  instance_id: string;
  kind: 'daemon' | 'desktop';
  started_at: string;
}

export class DataDirLockError extends Error {
  readonly code = 'DATA_DIR_CONFLICT';

  constructor(message: string) {
    super(message);
    this.name = 'DataDirLockError';
  }
}

function pidGone(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return false;
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === 'ESRCH';
  }
}

/**
 * Atomically claims a data directory before its config, credentials, or stores are opened.
 * The returned release removes only this exact instance's claim.
 */
export async function acquireDataDirLock(
  dataDir: string,
  owner: { instanceId: string; kind: DataDirLockRecord['kind'] }
): Promise<() => Promise<void>> {
  const file = path.join(dataDir, DATA_DIR_LOCK_FILE);
  const reclaimFile = path.join(dataDir, DATA_DIR_RECLAIM_FILE);
  const record: DataDirLockRecord = {
    pid: process.pid,
    instance_id: owner.instanceId,
    kind: owner.kind,
    started_at: new Date().toISOString()
  };

  const createClaim = async (): Promise<() => Promise<void>> => {
    const handle = await fs.open(file, 'wx', 0o600);
    try {
      await handle.writeFile(`${JSON.stringify(record)}\n`, 'utf8');
      await handle.close();
    } catch (error) {
      await handle.close().catch(() => undefined);
      await fs.rm(file, { force: true }).catch(() => undefined);
      throw error;
    }
    return async () => {
      const current = await fs.readFile(file, 'utf8').catch(() => null);
      if (current === null) return;
      try {
        const parsed = JSON.parse(current) as Partial<DataDirLockRecord>;
        if (parsed.instance_id !== owner.instanceId) return;
      } catch {
        // Never remove a claim whose identity cannot be proved.
        return;
      }
      await fs.rm(file, { force: true }).catch(() => undefined);
    };
  };

  try {
    return await createClaim();
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'EEXIST') {
      throw new DataDirLockError(`the data-directory lock ${file} could not be created: ${(error as Error).message}`);
    }
  }

  // Only one process may inspect and replace a stale claim. The recovery guard is deliberately
  // fail-closed when abandoned by a crash: automatically reclaiming the guard would recreate the
  // same race one level higher.
  let reclaimHandle: Awaited<ReturnType<typeof fs.open>>;
  try {
    reclaimHandle = await fs.open(reclaimFile, 'wx', 0o600);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'EEXIST') {
      throw new DataDirLockError(
        `data directory ${dataDir} has an ownership recovery in progress or an abandoned recovery guard. ` +
          'Wait for the other starter, or remove the guard only after verifying that no host is running.'
      );
    }
    throw new DataDirLockError(`the ownership recovery guard ${reclaimFile} could not be created: ${(error as Error).message}`);
  }

  try {
    const existing = await fs.readFile(file, 'utf8').catch(() => null);
    let held: Partial<DataDirLockRecord> = {};
    try {
      held = existing ? (JSON.parse(existing) as Partial<DataDirLockRecord>) : {};
    } catch {
      held = {};
    }
    const ownerPid = held.pid;
    if (typeof ownerPid !== 'number' || !Number.isSafeInteger(ownerPid) || ownerPid <= 0) {
      throw new DataDirLockError(
        `data directory ${dataDir} has an ownership claim whose process cannot be proved gone. ` +
          'Remove it only after verifying that no desktop or daemon host is running.'
      );
    }
    if (!pidGone(ownerPid)) {
      throw new DataDirLockError(
        `data directory ${dataDir} is already owned by a running or uninspectable ${held.kind ?? 'host'} ` +
          `(pid ${ownerPid}, instance ${String(held.instance_id ?? 'unknown')}). Stop that owner or use another --data-dir.`
      );
    }

    await fs.rm(file);
    try {
      return await createClaim();
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'EEXIST') {
        throw new DataDirLockError(`data directory ${dataDir} was claimed by another host during stale-owner recovery.`);
      }
      throw new DataDirLockError(`the data-directory lock ${file} could not be created: ${(error as Error).message}`);
    }
  } finally {
    await reclaimHandle.close().catch(() => undefined);
    await fs.rm(reclaimFile, { force: true }).catch(() => undefined);
  }
}
