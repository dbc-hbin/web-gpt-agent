import { defineConfig, externalizeDepsPlugin } from 'electron-vite';
import { resolve } from 'node:path';

export default defineConfig({
  main: {
    // Keep node_modules external so the MCP SDK ships as real files in the asar
    // rather than being inlined by the bundler.
    plugins: [externalizeDepsPlugin()],
    build: {
      rollupOptions: { input: { index: resolve(__dirname, 'src/main/index.ts'), 'daemon-client': resolve(__dirname, 'src/main/daemon-client.ts'), 'desktop-backend': resolve(__dirname, 'src/main/backend.ts') } }
    }
  },
  preload: {
    plugins: [externalizeDepsPlugin()],
    build: {
      rollupOptions: { input: resolve(__dirname, 'src/preload/index.ts') }
    }
  },
  renderer: {
    root: resolve(__dirname, 'src/renderer'),
    build: {
      rollupOptions: { input: { index: resolve(__dirname, 'src/renderer/index.html') } }
    }
  }
});
