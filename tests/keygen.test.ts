import test from 'node:test'
import assert from 'node:assert/strict'
import {
  generateWireguardKeypair,
  derivePublicKey,
  validateWireguardKey,
} from '../startos/keygen'

test('generateWireguardKeypair generates valid Curve25519 Base64 WireGuard keys', () => {
  const pair = generateWireguardKeypair()

  assert.ok(pair.privateKey)
  assert.ok(pair.publicKey)
  assert.equal(pair.privateKey.length, 44)
  assert.equal(pair.publicKey.length, 44)
  assert.ok(pair.privateKey.endsWith('='))
  assert.ok(pair.publicKey.endsWith('='))

  assert.equal(validateWireguardKey(pair.privateKey), true)
  assert.equal(validateWireguardKey(pair.publicKey), true)
})

test('derivePublicKey successfully derives matching public key from generated private key', () => {
  const pair = generateWireguardKeypair()
  const derivedPub = derivePublicKey(pair.privateKey)

  assert.equal(derivedPub, pair.publicKey)
})

test('derivePublicKey produces canonical Curve25519 public key matching reference test vector', () => {
  // Test vector:
  // Priv hex: 77076d0a7318a57d3c16c17251b26645df4c2f87ebc0992ab177fba51db92c2a
  // Pub hex:  8520f0098930a754748b7ddcb43ef75a0dbf3a0d26381af4eba4a98eaa9b4e6a
  const privB64 = Buffer.from(
    '77076d0a7318a57d3c16c17251b26645df4c2f87ebc0992ab177fba51db92c2a',
    'hex',
  ).toString('base64')
  const expectedPubB64 = Buffer.from(
    '8520f0098930a754748b7ddcb43ef75a0dbf3a0d26381af4eba4a98eaa9b4e6a',
    'hex',
  ).toString('base64')

  const derived = derivePublicKey(privB64)
  assert.equal(derived, expectedPubB64)
})

test('validateWireguardKey accurately discriminates valid and invalid key strings', () => {
  assert.equal(validateWireguardKey(null), false)
  assert.equal(validateWireguardKey(undefined), false)
  assert.equal(validateWireguardKey(''), false)
  assert.equal(validateWireguardKey('shortKey=='), false)
  assert.equal(
    validateWireguardKey('invalid_characters_in_key_not_base64_12345678='),
    false,
  )
  // 44 chars but decodes to wrong length
  assert.equal(
    validateWireguardKey('AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA'),
    false,
  )

  // 32-byte valid base64 key
  const validKey = Buffer.alloc(32, 7).toString('base64')
  assert.equal(validateWireguardKey(validKey), true)
})

test('derivePublicKey throws descriptive error on invalid private key input', () => {
  assert.throws(
    () => derivePublicKey('invalid-key'),
    /Invalid WireGuard private key format/,
  )
})

test('multiple invocations of generateWireguardKeypair produce distinct, unique keypairs', () => {
  const pair1 = generateWireguardKeypair()
  const pair2 = generateWireguardKeypair()

  assert.notEqual(pair1.privateKey, pair2.privateKey)
  assert.notEqual(pair1.publicKey, pair2.publicKey)
})
