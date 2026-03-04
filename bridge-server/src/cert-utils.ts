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
 * SAN entries for localhost and 127.0.0.1. The certificate is written
 * to disk in `.certs/` and regenerated on every startup.
 *
 * Chrome's WebTransport certificate hash pinning requires:
 * - Validity period ≤ 14 days (we use 13 for margin)
 * - basicConstraints CA:FALSE (NOT a CA cert)
 * - ECDSA with P-256 curve
 *
 * @returns Certificate material including PEM cert, key, and SHA-256 hash
 */
export function generateCertificate(): CertMaterial {
  if (!existsSync(CERT_DIR)) {
    mkdirSync(CERT_DIR, { recursive: true });
  }

  const certPath = join(CERT_DIR, 'cert.pem');
  const keyPath = join(CERT_DIR, 'key.pem');

  // Generate ECDSA P-256 self-signed cert valid for 13 days
  // CRITICAL: basicConstraints=CA:FALSE is required for Chrome's WebTransport
  // certificate hash validation. OpenSSL's `req -x509` defaults to CA:TRUE
  // which Chrome rejects per the WebTransport spec.
  execSync(
    `openssl req -new -x509 -nodes ` +
      `-newkey ec -pkeyopt ec_paramgen_curve:prime256v1 ` +
      `-keyout "${keyPath}" -out "${certPath}" ` +
      `-days 13 -subj "/CN=localhost" ` +
      `-addext "subjectAltName=DNS:localhost,IP:127.0.0.1" ` +
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
