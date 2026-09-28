import { app } from 'electron';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { restartEmbeddedCua } from './cua/runtime.js';

let pending: Promise<void> | null = null;

/** Only explicit renderer requests may prompt or replace the native runtime. */
export function refreshDesktopAccess(options: { request?: boolean } = {}): Promise<void> {
  if (process.platform !== 'darwin') return Promise.reject(new Error('Desktop permission requests are only available on macOS.'));
  if (pending) return Promise.reject(new Error('A Desktop permission check is already running.'));
  const operation = (async () => {
    await app.whenReady();
    if (options.request) {
      // Like runtime startup, this ESM-only entry must load from the physical unpacked
      // package: its FFI resolves the dylib relative to the module URL, not Electron's fs.
      const sdkModule = app.isPackaged
        ? pathToFileURL(path.join(process.resourcesPath, 'app.asar.unpacked', 'node_modules',
          '@trycua', 'cua-driver', 'dist', 'electron.js')).href
        : '@trycua/cua-driver/electron';
      const { requestMacOSPermissions } = await import(sdkModule);
      requestMacOSPermissions();
    }
    await restartEmbeddedCua();
  })();
  pending = operation;
  void operation.finally(() => { if (pending === operation) pending = null; }).catch(() => undefined);
  return operation;
}
