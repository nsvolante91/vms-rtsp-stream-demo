import { defineConfig } from 'vite';
import { readFileSync, existsSync } from 'fs';
import { resolve } from 'path';

const BRIDGE_PORT = process.env.BRIDGE_PORT ?? '9000';

/**
 * Vite's `server.host` option controls which network interfaces it binds to.
 * Setting it to '0.0.0.0' makes Vite reachable from any interface (LAN, VPN, etc.).
 * This is equivalent to `vite --host` on the CLI.
 */
const VITE_HOST = process.env.HOST ?? '0.0.0.0';

/**
 * Load TLS certificate from the bridge server's .certs/ directory.
 * The bridge server generates these on startup; start it before `npm run dev`.
 */
function loadTlsOptions(): { cert: Buffer; key: Buffer } | undefined {
  const certPath = resolve(__dirname, '..', '.certs', 'cert.pem');
  const keyPath = resolve(__dirname, '..', '.certs', 'key.pem');

  if (!existsSync(certPath) || !existsSync(keyPath)) {
    console.warn(
      '[Vite] TLS certs not found at .certs/. Start the bridge server first to generate them.\n' +
      '       Falling back to HTTP.'
    );
    return undefined;
  }

  return {
    cert: readFileSync(certPath),
    key: readFileSync(keyPath),
  };
}

const tlsOptions = loadTlsOptions();

export default defineConfig({
  root: '.',
  server: {
    port: 5173,
    host: VITE_HOST,
    https: tlsOptions,
    headers: {
      'Cross-Origin-Opener-Policy': 'same-origin',
      'Cross-Origin-Embedder-Policy': 'require-corp',
    },
    proxy: {
      // REST API: proxy /api/* → http://bridge:9000/* (strips /api prefix).
      // This lets the browser page (HTTPS) fetch from the bridge server (HTTP)
      // without mixed-content errors or self-signed certificate trust issues.
      // Works for both local and remote access.
      '/api': {
        target: `http://127.0.0.1:${BRIDGE_PORT}`,
        changeOrigin: false,
        rewrite: (path) => path.replace(/^\/api/, ''),
      },
    },
  },
  build: {
    target: 'esnext',
    outDir: 'dist',
  },
});
