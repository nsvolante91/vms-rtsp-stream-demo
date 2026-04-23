/**
 * TLS Certificate Utilities for WebTransport
 *
 * Generates self-signed ECDSA P-256 certificates suitable for use with
 * WebTransport's serverCertificateHashes option. Chrome requires:
 * - ECDSA key (P-256 curve)
 * - Certificate validity ≤ 14 days
 * - basicConstraints CA:FALSE (must NOT be a CA certificate)
 * - SHA-256 fingerprint for pinning
 */

import { execSync } from 'child_process';
import { readFileSync, existsSync, mkdirSync } from 'fs';
import { createHash } from 'crypto';
import { join } from 'path';

/** Generated certificate material */
export interface CertMaterial {
  /** PEM-encoded certificate */
  cert: string;
  /** PEM-encoded private key */
  key: string;
  /** SHA-256 hash of the DER-encoded certificate (raw bytes) */
  hash: Uint8Array;
  /** SHA-256 hash as hex string */
  hashHex: string;
}

const CERT_DIR = join(process.cwd(), '.certs');

/**
 * Generate a self-signed ECDSA P-256 certificate for WebTransport.
 *
 * Uses OpenSSL to create a short-lived (13-day) certificate with
 * SAN entries for localhost, 127.0.0.1, and an optional additional host
 * (set via the HOST env var for remote access). The certificate is written
 * to disk in `.certs/` and regenerated on every startup.
 *
 * Chrome's WebTransport certificate hash pinning requires:
 * - Validity period ≤ 14 days (we use 13 for margin)
 * - basicConstraints CA:FALSE (NOT a CA cert)
 * - ECDSA with P-256 curve
 * - SAN must include the hostname used to connect (required even with hash pinning)
 *
 * @param extraHost - Additional hostname or IP to include in the SAN (e.g. a LAN IP for remote access)
 * @returns Certificate material including PEM cert, key, and SHA-256 hash
 */
export function generateCertificate(extraHost?: string): CertMaterial {
  if (!existsSync(CERT_DIR)) {
    mkdirSync(CERT_DIR, { recursive: true });
  }

  const certPath = join(CERT_DIR, 'cert.pem');
  const keyPath = join(CERT_DIR, 'key.pem');

  // Build the SAN list. Always include localhost and 127.0.0.1.
  // Append the extra host as DNS or IP depending on format.
  const sanEntries = ['DNS:localhost', 'IP:127.0.0.1'];
  if (extraHost && extraHost !== 'localhost' && extraHost !== '127.0.0.1') {
    const isIp = /^[\d.]+$/.test(extraHost) || extraHost.includes(':');
    sanEntries.push(isIp ? `IP:${extraHost}` : `DNS:${extraHost}`);
  }
  const san = sanEntries.join(',');

  // Generate ECDSA P-256 self-signed cert valid for 13 days
  // CRITICAL: basicConstraints=CA:FALSE is required for Chrome's WebTransport
  // certificate hash validation. OpenSSL's `req -x509` defaults to CA:TRUE
  // which Chrome rejects per the WebTransport spec.
  execSync(
    `openssl req -new -x509 -nodes ` +
      `-newkey ec -pkeyopt ec_paramgen_curve:prime256v1 ` +
      `-keyout "${keyPath}" -out "${certPath}" ` +
      `-days 13 -subj "/CN=localhost" ` +
      `-addext "subjectAltName=${san}" ` +
      `-addext "basicConstraints=critical,CA:FALSE"`,
    { stdio: 'pipe' }
  );

  const cert = readFileSync(certPath, 'utf-8');
  const key = readFileSync(keyPath, 'utf-8');

  // Compute SHA-256 hash of DER-encoded certificate
  const hash = computeCertHash(certPath);

  return {
    cert,
    key,
    hash,
    hashHex: Buffer.from(hash).toString('hex'),
  };
}

/**
 * Compute the SHA-256 fingerprint of a PEM certificate file.
 *
 * Converts PEM to DER and hashes the DER bytes, which is what
 * the browser's serverCertificateHashes option expects.
 *
 * @param certPath - Path to PEM certificate file
 * @returns SHA-256 hash as Uint8Array
 */
function computeCertHash(certPath: string): Uint8Array {
  const der = execSync(`openssl x509 -in "${certPath}" -outform DER`, {
    encoding: 'buffer',
  });

  const hash = createHash('sha256').update(der).digest();
  return new Uint8Array(hash);
}
