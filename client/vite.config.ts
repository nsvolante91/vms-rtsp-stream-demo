import { defineConfig } from 'vite';
import { readFileSync } from 'fs';
import { resolve } from 'path';

export default defineConfig({
  root: '.',
  server: {
    port: 5173,
    host: '0.0.0.0',
    https: {
      cert: readFileSync(resolve(__dirname, '..', 'KP7DWX6RDC.local.pem')),
      key: readFileSync(resolve(__dirname, '..', 'KP7DWX6RDC.local-key.pem')),
    },
    headers: {
      'Cross-Origin-Opener-Policy': 'same-origin',
      'Cross-Origin-Embedder-Policy': 'require-corp',
    },
  },
  build: {
    target: 'esnext',
    outDir: 'dist',
  },
});
