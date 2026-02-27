/**
 * RTSP Auth Proxy
 *
 * A minimal TCP proxy that sits between FFmpeg and an RTSP camera to work
 * around an FFmpeg 8.x bug where SHA-256 Digest authentication fails with
 * certain camera implementations. The proxy strips SHA-256 WWW-Authenticate
 * headers from 401 responses, forcing FFmpeg to fall back to MD5 Digest auth
 * which works correctly.
 *
 * Usage: call `createRtspAuthProxy(targetHost, targetPort)` to get a local
 * proxy URL that FFmpeg can connect to without encountering the SHA-256 bug.
 */

import * as net from 'net';

/** Active proxy instance with cleanup capability */
export interface RtspAuthProxy {
  /** Local port the proxy is listening on */
  port: number;
  /** Rewrite an RTSP URL to go through this proxy */
  rewriteUrl(originalUrl: string): string;
  /** Shut down the proxy server */
  close(): void;
}

/**
 * Create a local TCP proxy that intercepts RTSP 401 responses and removes
 * SHA-256 Digest WWW-Authenticate headers, leaving only MD5.
 *
 * The proxy transparently relays all other RTSP/RTP data without modification.
 *
 * @param targetHost - The RTSP camera host
 * @param targetPort - The RTSP camera port
 * @returns Promise resolving to the proxy instance once it's listening
 */
export function createRtspAuthProxy(
  targetHost: string,
  targetPort: number
): Promise<RtspAuthProxy> {
  return new Promise((resolve, reject) => {
    const server = net.createServer((clientSocket) => {
      const cameraSocket = net.createConnection(
        { host: targetHost, port: targetPort },
        () => {
          // Client -> Camera: forward all data unmodified
          clientSocket.on('data', (data) => {
            if (!cameraSocket.destroyed) {
              cameraSocket.write(data);
            }
          });
        }
      );

      // Camera -> Client: filter SHA-256 WWW-Authenticate lines from 401 responses
      let responseBuffer = Buffer.alloc(0);
      let inRtspResponse = false;

      cameraSocket.on('data', (data) => {
        if (clientSocket.destroyed) return;

        // Check if this looks like an RTSP text response (starts with "RTSP/")
        // vs binary interleaved RTP data (starts with '$')
        const combined = Buffer.concat([responseBuffer, data]);

        // If we're receiving interleaved RTP data (binary), pass through directly
        if (combined.length > 0 && combined[0] === 0x24) {
          // '$' = interleaved RTP/RTCP — pass through immediately
          responseBuffer = Buffer.alloc(0);
          clientSocket.write(combined);
          return;
        }

        const text = combined.toString('utf-8');

        // Check if we have a complete RTSP response (ends with \r\n\r\n for headers)
        // For 401 responses, there's typically no body, so headers end at \r\n\r\n
        if (text.startsWith('RTSP/')) {
          inRtspResponse = true;
        }

        if (inRtspResponse && text.includes('\r\n\r\n')) {
          // We have complete headers — check if this is a 401 that needs patching
          const headerEnd = text.indexOf('\r\n\r\n');
          const headers = text.substring(0, headerEnd);
          const rest = combined.subarray(Buffer.byteLength(headers + '\r\n\r\n'));

          if (headers.includes('401')) {
            // Remove SHA-256 Digest lines, keep MD5
            const filteredLines = headers
              .split('\r\n')
              .filter(
                (line) =>
                  !(
                    line.includes('WWW-Authenticate') &&
                    line.includes('algorithm="SHA-256"')
                  )
              );
            const patched = filteredLines.join('\r\n') + '\r\n\r\n';
            clientSocket.write(patched);
            if (rest.length > 0) {
              clientSocket.write(rest);
            }
          } else {
            // Non-401 response — pass through the complete buffer
            clientSocket.write(combined);
          }

          responseBuffer = Buffer.alloc(0);
          inRtspResponse = false;
        } else if (inRtspResponse) {
          // Incomplete RTSP response — buffer more data
          responseBuffer = combined;
        } else {
          // Not an RTSP response header — pass through (e.g. SDP body, RTP data)
          responseBuffer = Buffer.alloc(0);
          clientSocket.write(combined);
        }
      });

      // Error and close handling
      clientSocket.on('error', () => {
        if (!cameraSocket.destroyed) cameraSocket.destroy();
      });
      clientSocket.on('close', () => {
        if (!cameraSocket.destroyed) cameraSocket.destroy();
      });
      cameraSocket.on('error', () => {
        if (!clientSocket.destroyed) clientSocket.destroy();
      });
      cameraSocket.on('close', () => {
        if (!clientSocket.destroyed) clientSocket.destroy();
      });
    });

    server.on('error', reject);

    // Listen on a random available port on localhost
    server.listen(0, '127.0.0.1', () => {
      const addr = server.address();
      if (!addr || typeof addr === 'string') {
        server.close();
        reject(new Error('Failed to get proxy address'));
        return;
      }

      const port = addr.port;
      console.log(
        `[RTSP Proxy] Listening on 127.0.0.1:${port} → ${targetHost}:${targetPort} (stripping SHA-256 Digest auth)`
      );

      resolve({
        port,
        rewriteUrl(originalUrl: string): string {
          // Replace the original host:port with the proxy's localhost:port
          // Keep credentials so FFmpeg can use them for Digest auth with the proxy
          try {
            const match = originalUrl.match(
              /^(rtsp:\/\/)([^@]*@)?([^:/]+)(?::(\d+))?(\/.*)?$/
            );
            if (!match) return originalUrl;

            const [, scheme, credentials, , , path] = match;
            const creds = credentials ?? '';
            return `${scheme}${creds}127.0.0.1:${port}${path ?? '/'}`;
          } catch {
            return originalUrl;
          }
        },
        close(): void {
          server.close();
        },
      });
    });
  });
}

/**
 * Parse host and port from an RTSP URL.
 *
 * @param rtspUrl - RTSP URL to parse
 * @returns Object with host, port, and full URL with credentials stripped
 */
export function parseRtspUrl(rtspUrl: string): {
  host: string;
  port: number;
  credentials: string | null;
  path: string;
} {
  const match = rtspUrl.match(
    /^rtsp:\/\/(?:([^@]*)@)?([^:/]+)(?::(\d+))?(\/.*)?$/
  );
  if (!match) {
    throw new Error(`Invalid RTSP URL: ${rtspUrl}`);
  }

  return {
    credentials: match[1] ?? null,
    host: match[2],
    port: match[3] ? parseInt(match[3], 10) : 554,
    path: match[4] ?? '/',
  };
}
