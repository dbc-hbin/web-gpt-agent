import { defineConfig, externalizeDepsPlugin } from 'electron-vite';
import { resolve } from 'node:path';

/**
 * The `wgpt` CLI is built by its own electron-vite pass, into its own output directory.
 *
 * It shares the main process's CJS format, Node target and externalized dependencies, so a
 * second entry in the main build looks like the obvious way to produce it — and it does not
 * work. Rollup cannot emit an entry outside its own `outDir`, so that entry lands at
 * `out/main/cli/index.js`, and more importantly it is allowed to *share chunks* with the
 * main bundle. Moving just the entry to `out/cli/index.js` then leaves it requiring
 * `../chunks/…` — which resolves to `out/chunks/…`, where nothing was ever written.
 *
 * Its own pass writes exactly one self-contained file at `out/cli/index.js`, which is the
 * path the packaged `bin/wgpt` wrapper resolves inside app.asar and the path
 * electron-builder's `files: ['out/**']` carries into the package.
 *
 * The CLI's graph contains no Electron import: it is plain Node plus shared code, and it
 * must stay that way so it can run under `ELECTRON_RUN_AS_NODE=1` without initializing
 * Electron.
 */
export default defineConfig({
  main: {
    plugins: [externalizeDepsPlugin()],
    build: {
      outDir: resolve(__dirname, 'out', 'cli'),
      rollupOptions: {
        input: resolve(__dirname, 'src/cli/index.ts'),
        output: { entryFileNames: 'index.js' }
      }
    }
  }
});
