import test from 'node:test'
import assert from 'node:assert/strict'
import { exportConfig } from '../startos/actions/exportConfig'
import { tunnelsatsConf } from '../startos/fileModels/tunnelsatsConf'
import { configJson } from '../startos/fileModels/config.json'
import { tunnelsatsMeta } from '../startos/fileModels/tunnelsatsMeta'

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
async function exportStored(
  stored: string,
  recovered?: Record<string, string>,
) {
  const origTunnelsatsConfRead = tunnelsatsConf.read
  const origMetaRead = tunnelsatsMeta.read
  const origConfigRead = configJson.read
  tunnelsatsMeta.read = () => ({ once: async () => recovered }) as any
  configJson.read = () => ({ once: async () => null }) as any
  tunnelsatsConf.read = () =>
    ({
      once: async () => stored,
      const: async () => stored,
    }) as any
  try {
    return await (exportConfig as any).run({ effects: {} })
  } finally {
    tunnelsatsConf.read = origTunnelsatsConfRead
    tunnelsatsMeta.read = origMetaRead
    configJson.read = origConfigRead
  }
}

test('exportConfig returns recovered paid configurations, including without an active config', async () => {
  const hash = 'a'.repeat(64)
  const recovered = '[Interface]\nPrivateKey = recovered-secret\n'
  for (const active of ['', '[Interface]\nPrivateKey = active-secret\n']) {
    const response = await exportStored(active, { [hash]: recovered })
    assert.equal(response.result.type, 'group')
    const values = response.result.value
    assert.equal(values.length, active ? 2 : 1)
    assert.equal(values.at(-1).value, recovered)
    assert.equal(values.at(-1).name, 'Recovered Order ' + hash)
    assert.equal(values.at(-1).filename, 'tunnelsatsv3-aaaaaaaa.conf')
    for (const value of values) {
      assert.equal(value.type, 'multiline')
      assert.equal(value.masked, true)
      assert.equal(value.copyable, true)
    }
    if (active) assert.equal(values[0].filename, 'tunnelsatsv3.conf')
  }
})

test('exportConfig lists an activated recovered order once, as the active configuration', async () => {
  const active = '[Interface]\nPrivateKey = active-secret\n# VPNPort: 24556\n'
  // The same key as recorded at recovery, before a port marker rewrite.
  const activated = '[Interface]\nPrivateKey = active-secret\n'
  const single = await exportStored(active, { ['a'.repeat(64)]: activated })
  assert.equal(single.title, 'Active WireGuard Configuration')
  assert.equal(single.result.type, 'multiline')
  assert.equal(single.result.value, active)

  const other = '[Interface]\nPrivateKey = other-secret\n'
  const group = await exportStored(active, {
    ['a'.repeat(64)]: activated,
    ['b'.repeat(64)]: other,
  })
  assert.equal(group.result.type, 'group')
  assert.deepEqual(
    group.result.value.map((v: { name: string }) => v.name),
    ['Active WireGuard Configuration', 'Recovered Order ' + 'b'.repeat(64)],
  )
})

test('exportConfig returns the stored configuration as-is, masked, copyable and downloadable', async () => {
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
  assert.equal(response.result.type, 'multiline')
  assert.equal(response.result.value, sampleConf)
  assert.doesNotMatch(response.result.value, /# StartTunnel/i)
  assert.doesNotMatch(response.result.value, /# inbound: yes/i)
  assert.equal(response.result.copyable, true)
  assert.equal(response.result.masked, true)
  assert.equal(response.result.filename, 'tunnelsatsv3.conf')
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
