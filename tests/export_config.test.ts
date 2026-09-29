import test from 'node:test'
import assert from 'node:assert/strict'
import { exportConfig } from '../startos/actions/exportConfig'
import { tunnelsatsConf } from '../startos/fileModels/tunnelsatsConf'
import { configJson } from '../startos/fileModels/config.json'

test('exportConfig action is registered with correct metadata', () => {
  assert.equal(exportConfig.id, 'export-config')
  const metadata = (exportConfig as any).metadataFn
  assert.equal(metadata.name, 'Export WireGuard Configuration')
  assert.equal(metadata.allowedStatuses, 'any')
  assert.equal(metadata.visibility, 'enabled')
})

test('exportConfig returns No Configuration Found when no config is present', async () => {
  // Mock file model read methods to return null
  const origTunnelsatsConfRead = tunnelsatsConf.read
  const origConfigJsonRead = configJson.read

  tunnelsatsConf.read = () =>
    ({
      once: async () => null,
      const: async () => null,
    }) as any

  configJson.read = () =>
    ({
      once: async () => null,
      const: async () => null,
    }) as any

  try {
    const response = await (exportConfig as any).run({ effects: {} })
    assert.equal(response.version, '1')
    assert.equal(response.title, 'No Configuration Found')
    assert.equal(response.result, null)
    assert.match(response.message, /No active WireGuard configuration found/)
  } finally {
    tunnelsatsConf.read = origTunnelsatsConfRead
    configJson.read = origConfigJsonRead
  }
})

/** Runs the production export with tunnelsatsv3.conf reading `stored`. */
async function exportStored(stored: string) {
  const origTunnelsatsConfRead = tunnelsatsConf.read
  tunnelsatsConf.read = () =>
    ({
      once: async () => stored,
      const: async () => stored,
    }) as any
  try {
    return await (exportConfig as any).run({ effects: {} })
  } finally {
    tunnelsatsConf.read = origTunnelsatsConfRead
  }
}

test('exportConfig returns the stored configuration as-is, masked and copyable', async () => {
  const sampleConf = `[Interface]
PrivateKey = DUMMY_TEST_KEY_FOR_TESTING_1234567890123456=
Address = 10.9.0.102/32
# VPNPort: 24556

[Peer]
PublicKey = DUMMY_SERVER_KEY_FOR_TESTING_123456789012345=
Endpoint = de2.tunnelsats.com:51820
`
  const response = await exportStored(sampleConf)
  assert.equal(response.version, '1')
  assert.equal(response.title, 'Active WireGuard Configuration')
  assert.ok(response.result)
  assert.equal(response.result.type, 'single')
  assert.equal(response.result.value, sampleConf)
  assert.doesNotMatch(response.result.value, /# StartTunnel/i)
  assert.doesNotMatch(response.result.value, /# inbound: yes/i)
  assert.equal(response.result.copyable, true)
  assert.equal(response.result.masked, true)
  assert.equal(response.result.qr, false)
})

test('exportConfig passes a config stored with legacy gateway markers through byte-identical', async () => {
  const legacyConf = `[Interface]
# StartTunnel
# inbound: yes
PrivateKey = DUMMY_TEST_KEY_FOR_TESTING_1234567890123456=
Address = 10.9.0.102/32
# VPNPort: 24556

[Peer]
PublicKey = DUMMY_SERVER_KEY_FOR_TESTING_123456789012345=
Endpoint = de2.tunnelsats.com:51820
`
  const response = await exportStored(legacyConf)
  assert.equal(response.result.value, legacyConf)
})
