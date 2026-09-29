import {
  generateKeyPairSync,
  createPrivateKey,
  createPublicKey,
} from 'node:crypto'

export interface WireguardKeypair {
  privateKey: string
  publicKey: string
}

// Prefix for X25519 PKCS8 DER format (16 bytes)
const PKCS8_X25519_PREFIX = Buffer.from(
  '302e020100300506032b656e04220420',
  'hex',
)

/**
 * Validates whether a given string is a valid WireGuard key (Curve25519 32-byte Base64 string).
 */
export function validateWireguardKey(
  keyBase64: string | null | undefined,
): boolean {
  if (!keyBase64 || typeof keyBase64 !== 'string') return false
  const trimmed = keyBase64.trim()
  // Standard WireGuard key: 44 chars base64, 32 bytes raw, terminates in '='
  if (!/^[A-Za-z0-9+/]{43}=$/.test(trimmed)) return false
  const buf = Buffer.from(trimmed, 'base64')
  return buf.length === 32
}

/**
 * Generates an in-process Curve25519 WireGuard keypair.
 * Returns both private and public keys as standard 44-character Base64 WireGuard strings.
 */
export function generateWireguardKeypair(): WireguardKeypair {
  const { privateKey, publicKey } = generateKeyPairSync('x25519')
  const rawPriv = privateKey
    .export({ type: 'pkcs8', format: 'der' })
    .subarray(-32)
  const rawPub = publicKey.export({ type: 'spki', format: 'der' }).subarray(-32)

  return {
    privateKey: rawPriv.toString('base64'),
    publicKey: rawPub.toString('base64'),
  }
}

/**
 * Derives a WireGuard Curve25519 public key from a given private key.
 */
export function derivePublicKey(privateKeyBase64: string): string {
  if (!validateWireguardKey(privateKeyBase64)) {
    throw new Error('Invalid WireGuard private key format')
  }

  const rawPriv = Buffer.from(privateKeyBase64.trim(), 'base64')
  const fullPkcs8 = Buffer.concat([PKCS8_X25519_PREFIX, rawPriv])
  const importedKey = createPrivateKey({
    key: fullPkcs8,
    format: 'der',
    type: 'pkcs8',
  })
  const derivedPub = createPublicKey(importedKey)
    .export({ type: 'spki', format: 'der' })
    .subarray(-32)

  return derivedPub.toString('base64')
}
