import path from 'node:path';
import { existsSync } from 'node:fs';
import { app } from 'electron';
import { materializeExtension } from './extension-materialize.js';

/** The installation-seeded folder Chrome can load in development or a packaged app. */
export function extensionDir(): string | null {
  const candidates = app.isPackaged ? [path.join(process.resourcesPath, 'extension')] : [
    path.join(app.getAppPath(), 'extension'),
    path.join(process.cwd(), 'extension'),
    path.join(process.resourcesPath, 'extension')
  ];
  const bundled = candidates.find(dir => existsSync(path.join(dir, 'manifest.json'))) ?? candidates[0]!;
  const stable = path.join(app.getPath('userData'), 'extension');
  try {
    return materializeExtension(bundled, stable);
  } catch {
    return existsSync(path.join(stable, 'manifest.json')) ? stable : null;
  }
}
