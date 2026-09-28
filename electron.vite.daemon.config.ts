import { defineConfig } from 'electron-vite';
import { resolve } from 'node:path';

/**
 * The standalone daemon bundle: one self-contained file at `out/daemon/index.js`.
 *
 * It is a separate pass for the same reason the CLI is — Rollup cannot emit an entry outside its
 * own `outDir`, and an entry sharing chunks with the main bundle would leave `out/daemon/index.js`
 * requiring `../chunks/…`, where nothing was written.
 *
 * Unlike the CLI, this bundle does **not** externalize its dependencies. That difference is the
 * whole point of the file:
 *
 *   - The CLI runs under `ELECTRON_RUN_AS_NODE`, so its `require('zod')` resolves through
 *     Electron's patched fs *inside* `app.asar`. That is why externalizing works there.
 *   - The daemon runs on **plain Node**, which cannot read inside an asar at all. Anything it
 *     `require`s from `node_modules` would therefore be missing on the machine that most needs it
 *     — the one with no desktop app installed. So every pure-JavaScript dependency is inlined
 *     here, and the result needs nothing but `node:*` builtins.
 *
 * Only two things stay external, and both are things a bundler *cannot* inline:
 *
 *   - `node:*` builtins, which plain Node provides.
 *   - Native addons (`node-pty`, `tree-sitter`, `tree-sitter-bash`, `sharp`, `@img/*`). These are
 *     platform binaries; `electron-builder.yml` unpacks the staged packages next to this bundle so
 *     plain Node resolves them, and the daemon reports a tool as unavailable rather than crashing
 *     if a build shipped without them.
 *
 * Two more packages are neither inlined nor listed here, because they are never *imported*: the
 * code-mode sandbox resolves `quickjs-emscripten-core` and `@jitl/quickjs-wasmfile-release-sync`
 * by name at run time (`createRequire(...).resolve` in code-mode-runtime.ts), so no bundler can
 * see them. They are real files in the package and `electron-builder.yml` unpacks them for the
 * same reason as the native addons — without them every `exec` call answers
 * `CODE_MODE_RUNTIME_ERROR` in a packaged daemon.
 *
 * Nothing in this graph may import `electron`: the daemon must serve the MCP coding tools with no
 * desktop runtime present, which is exactly what makes it a *standalone* daemon.
 */

/** Native/optional packages that cannot be inlined; shipped beside the bundle as real files. */
const NATIVE_MODULES = ['node-pty', 'tree-sitter', 'tree-sitter-bash', 'sharp', /^@img\//];

export default defineConfig({
  main: {
    build: {
      // `externalizeDeps: false` is what inlines the JavaScript dependencies (zod, the MCP SDK)
      // instead of leaving `require('zod')` in the output. electron-vite externalizes every
      // dependency by default — correct for the Electron main process and the CLI, both of which
      // resolve through Electron's patched fs inside `app.asar`, and wrong here: plain Node cannot
      // read an asar at all, so a `require('zod')` would be a missing module on exactly the machine
      // the daemon exists for. The native packages listed in `external` stay out of the bundle.
      externalizeDeps: false,
      outDir: resolve(__dirname, 'out', 'daemon'),
      rollupOptions: {
        input: resolve(__dirname, 'src/daemon/entry.ts'),
        // No `externalizeDepsPlugin()`: dependencies are inlined, not required at runtime.
        external: [/^node:/, ...NATIVE_MODULES, 'electron'],
        output: {
          entryFileNames: 'index.js',
          // A single file is what an `extraResources` copy needs to be useful outside the asar,
          // and it keeps the daemon's own worker/child scripts from becoming separate chunks that
          // plain Node would then have to find.
          inlineDynamicImports: true
        }
      }
    }
  }
});
