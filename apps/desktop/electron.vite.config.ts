import { resolve } from 'node:path';
import tailwindcss from '@tailwindcss/vite';
import react from '@vitejs/plugin-react';
import { defineConfig } from 'electron-vite';

/**
 * Main + preload are bundled entirely (workspace packages ship TypeScript sources, so they
 * cannot be required at runtime); only ws' optional native accelerators stay external.
 */
const bundleEverything = {
  externalizeDeps: false,
  rollupOptions: { external: ['bufferutil', 'utf-8-validate'] },
};

export default defineConfig({
  main: { build: bundleEverything },
  preload: { build: bundleEverything },
  renderer: {
    resolve: {
      alias: { '@': resolve(import.meta.dirname, 'src/renderer/src') },
    },
    plugins: [react(), tailwindcss()],
  },
});
