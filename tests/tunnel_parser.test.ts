import test from 'node:test'
import assert from 'node:assert/strict'
import {
  validateWireguardConfig,
  parseWireguardTunnelInfo,
} from '../startos/utils'

test('validateWireguardConfig accepts valid WireGuard configuration', () => {
  const conf = `[Interface]
PrivateKey = DUMMY_TEST_PRIVATE_KEY_FOR_TESTING_123456=
Address = 10.9.0.102/32
# VPNPort: 24556

[Peer]
PublicKey = DUMMY_TEST_PUBLIC_KEY_FOR_TESTING_123456=
Endpoint = ch1.tunnelsats.com:51820
AllowedIPs = 0.0.0.0/0
`
  const result = validateWireguardConfig(conf)
  assert.equal(result.valid, true)
  assert.equal(result.error, undefined)
})

test('validateWireguardConfig rejects missing PrivateKey', () => {
  const conf = `[Interface]
Address = 10.9.0.102/32
# VPNPort: 24556

[Peer]
PublicKey = DUMMY_TEST_PUBLIC_KEY_FOR_TESTING_123456=
Endpoint = ch1.tunnelsats.com:51820
`
  const result = validateWireguardConfig(conf)
  assert.equal(result.valid, false)
  assert.match(result.error || '', /PrivateKey/i)
})

test('validateWireguardConfig rejects missing Address', () => {
  const conf = `[Interface]
PrivateKey = DUMMY_TEST_PRIVATE_KEY_FOR_TESTING_123456=
# VPNPort: 24556

[Peer]
PublicKey = DUMMY_TEST_PUBLIC_KEY_FOR_TESTING_123456=
Endpoint = ch1.tunnelsats.com:51820
`
  const result = validateWireguardConfig(conf)
  assert.equal(result.valid, false)
  assert.match(result.error || '', /Address/i)
})

test('validateWireguardConfig rejects missing Endpoint', () => {
  const conf = `[Interface]
PrivateKey = DUMMY_TEST_PRIVATE_KEY_FOR_TESTING_123456=
Address = 10.9.0.102/32
# VPNPort: 24556

[Peer]
PublicKey = DUMMY_TEST_PUBLIC_KEY_FOR_TESTING_123456=
`
  const result = validateWireguardConfig(conf)
  assert.equal(result.valid, false)
  assert.match(result.error || '', /Endpoint/i)
})

test('validateWireguardConfig rejects missing port forwarding metadata', () => {
  const conf = `[Interface]
PrivateKey = DUMMY_TEST_PRIVATE_KEY_FOR_TESTING_123456=
Address = 10.9.0.102/32

[Peer]
PublicKey = DUMMY_TEST_PUBLIC_KEY_FOR_TESTING_123456=
Endpoint = ch1.tunnelsats.com:51820
`
  const result = validateWireguardConfig(conf)
  assert.equal(result.valid, false)
  assert.match(result.error || '', /port/i)
})

test('parseWireguardTunnelInfo extracts metadata accurately', () => {
  const conf = `[Interface]
# Server: ch1.tunnelsats.com
# Port Forwarding: 24556
PrivateKey = DUMMY_TEST_PRIVATE_KEY_FOR_TESTING_123456=
Address = 10.9.0.102/32

[Peer]
PublicKey = DUMMY_TEST_PUBLIC_KEY_FOR_TESTING_123456=
Endpoint = ch1.tunnelsats.com:51820
AllowedIPs = 0.0.0.0/0
`
  const info = parseWireguardTunnelInfo(conf)
  assert.equal(info.address, '10.9.0.102/32')
  assert.equal(info.endpoint, 'ch1.tunnelsats.com:51820')
  assert.equal(info.serverDomain, 'ch1.tunnelsats.com')
  assert.equal(info.vpnPort, 24556)
  assert.equal(info.publicKey, 'DUMMY_TEST_PUBLIC_KEY_FOR_TESTING_123456=')
})

test('parseWireguardTunnelInfo extracts bracketed and raw IPv6 serverDomain when server comment missing', () => {
  const confBracketed = `[Interface]
PrivateKey = DUMMY_TEST_PRIVATE_KEY_FOR_TESTING_123456=
Address = fd00::1/128
# VPNPort: 24556

[Peer]
PublicKey = DUMMY_TEST_PUBLIC_KEY_FOR_TESTING_123456=
Endpoint = [2001:db8::1]:51820
`
  const confRaw = `[Interface]
PrivateKey = DUMMY_TEST_PRIVATE_KEY_FOR_TESTING_123456=
Address = fd00::1/128
# VPNPort: 24556

[Peer]
PublicKey = DUMMY_TEST_PUBLIC_KEY_FOR_TESTING_123456=
Endpoint = 2001:db8::1:51820
`
  const infoBracketed = parseWireguardTunnelInfo(confBracketed)
  const infoRaw = parseWireguardTunnelInfo(confRaw)
  assert.equal(infoBracketed.serverDomain, '2001:db8::1')
  assert.equal(infoRaw.serverDomain, '2001:db8::1')
})
