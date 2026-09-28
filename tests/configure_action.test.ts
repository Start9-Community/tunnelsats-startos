import test from 'node:test'
import assert from 'node:assert/strict'
import { configure } from '../startos/actions/configure'
import { configJson } from '../startos/fileModels/config.json'
import { tunnelsatsConf } from '../startos/fileModels/tunnelsatsConf'
import { getTargetVpnConfig } from '../startos/dependencies'
import { buildOnTaskInput } from '../startos/vpnHandoff'
import defaultDict from '../startos/i18n/dictionaries/default'

const CLEAN_CONF = `[Interface]
PrivateKey = DUMMY_TEST_PRIVATE_KEY_FOR_TESTING_123456=
Address = 10.9.0.102/32
# VPNPort: 24556

[Peer]
PublicKey = DUMMY_TEST_PUBLIC_KEY_FOR_TESTING_123456=
Endpoint = ch1.tunnelsats.com:51820
`

// A config stored by an earlier version, which injected the classification
// markers of the retired StartOS gateway model.
const LEGACY_MARKED_CONF = `[Interface]
# StartTunnel
# inbound: yes
PrivateKey = DUMMY_TEST_PRIVATE_KEY_FOR_TESTING_123456=
Address = 10.9.0.102/32
# VPNPort: 24556

[Peer]
PublicKey = DUMMY_TEST_PUBLIC_KEY_FOR_TESTING_123456=
Endpoint = ch1.tunnelsats.com:51820
`

/**
 * Runs the production Configure handler with the file writes captured. With
 * enabled=false the handler removes tunnelsatsv3.conf with rm({force:true}),
 * a no-op outside StartOS where the volume path does not exist.
 */
async function runConfigure(conf: string, enabled = true, allowIpv6 = false) {
  const origMerge = configJson.merge
  const origWrite = tunnelsatsConf.write
  let merged: any = null
  let written: string | null = null
  configJson.merge = (async (_effects: unknown, data: unknown) => {
    merged = data
  }) as any
  tunnelsatsConf.write = (async (_effects: unknown, data: string) => {
    written = data
  }) as any
  try {
    const response = await (configure as any).runFn({
      effects: {},
      input: {
        enabled,
        'target-node': 'lnd',
        'tunnelsats-conf': conf,
        'allow-ipv6': allowIpv6,
      },
    })
    return { response, merged, written }
  } finally {
    configJson.merge = origMerge
    tunnelsatsConf.write = origWrite
  }
}

test('Configure stores a pasted config without gateway markers', async () => {
  const { response, merged, written } = await runConfigure(CLEAN_CONF)
  assert.equal(merged['tunnelsats-conf'], CLEAN_CONF)
  assert.equal(written, CLEAN_CONF)
  assert.equal(response.result.value, CLEAN_CONF)
  for (const stored of [merged['tunnelsats-conf'], written]) {
    assert.doesNotMatch(stored, /# StartTunnel/i)
    assert.doesNotMatch(stored, /# inbound: yes/i)
  }
})

test('Configure passes an already-marked stored config through byte-identical', async () => {
  // Stripping the markers would change the string the node task accepts
  // and re-raise the clearnet-vpn task on every upgraded box.
  const { merged, written } = await runConfigure(LEGACY_MARKED_CONF)
  assert.equal(merged['tunnelsats-conf'], LEGACY_MARKED_CONF)
  assert.equal(written, LEGACY_MARKED_CONF)
})

test('the node task accepts an already-marked stored config byte-identical', () => {
  const vpn = getTargetVpnConfig({
    enabled: true,
    'target-node': 'lnd',
    'tunnelsats-conf': LEGACY_MARKED_CONF,
  })
  assert.ok(vpn)
  assert.equal(vpn.wgConf, LEGACY_MARKED_CONF)
  const input = buildOnTaskInput(vpn.wgConf, vpn.announceEndpoint!)
  assert.deepEqual(input.accept, [
    { config: LEGACY_MARKED_CONF, announce: 'ch1.tunnelsats.com:24556' },
  ])
})

// ---------------------------------------------------------------------------
// Configure speaks the node-owned clearnet-vpn model, not the retired
// StartOS gateway model.
// ---------------------------------------------------------------------------

const RETIRED_GATEWAY_GUIDANCE =
  /System → Gateways|Outbound Gateway|Peer interface|external host/i

test('Configure metadata describes enable/disable, node choice and config replacement', () => {
  const metadata = (configure as any).metadataFn
  assert.equal(configure.id, 'configure')
  assert.equal(
    metadata.description,
    'Enable/disable TunnelSats, pick the target node, and replace the WireGuard configuration',
  )
  assert.doesNotMatch(metadata.description, RETIRED_GATEWAY_GUIDANCE)
})

test('Configure success explains the clearnet-vpn task flow, like Import', async () => {
  const { response } = await runConfigure(CLEAN_CONF)
  assert.equal(
    response.message,
    'WireGuard configuration saved. Your Lightning node will ask you to activate the VPN tunnel. If TunnelSats routed a different node before, that node first asks you to turn its tunnel off.',
  )
  assert.doesNotMatch(response.message, RETIRED_GATEWAY_GUIDANCE)
})

test('Configure with TunnelSats switched off says the node will be asked to turn its tunnel off', async () => {
  const { response, merged, written } = await runConfigure(CLEAN_CONF, false)
  assert.equal(merged.enabled, false)
  assert.equal(merged['tunnelsats-conf'], CLEAN_CONF)
  assert.equal(written, null)
  assert.equal(
    response.message,
    'TunnelSats is switched off and your WireGuard configuration is kept. If a Lightning node used the tunnel, it will ask you to turn it off.',
  )
  assert.doesNotMatch(response.message, RETIRED_GATEWAY_GUIDANCE)
})

test('no user-facing string still carries retired gateway guidance', () => {
  for (const key of Object.keys(defaultDict)) {
    assert.doesNotMatch(key, RETIRED_GATEWAY_GUIDANCE, key)
  }
})

// ---------------------------------------------------------------------------
// An enabled config must be announceable, as in Import Subscription: the
// handoff raises no activation task without an announce endpoint, so the
// success message would promise a prompt that never appears.
// ---------------------------------------------------------------------------

const IPV6_CONF = `[Interface]
PrivateKey = DUMMY_TEST_PRIVATE_KEY_FOR_TESTING_123456=
Address = 10.9.0.102/32
# VPNPort: 24556

[Peer]
PublicKey = DUMMY_TEST_PUBLIC_KEY_FOR_TESTING_123456=
Endpoint = [2001:db8::1]:51820
`

const NOT_ANNOUNCEABLE =
  'This configuration has no endpoint that can be announced to the Lightning Network (an IPv6 endpoint needs Allow IPv6 Endpoint).'

test('Configure rejects enabling an IPv6-only endpoint without IPv6 coexistence, like Import', async () => {
  const origMerge = configJson.merge
  const origWrite = tunnelsatsConf.write
  let touched = false
  configJson.merge = (async () => {
    touched = true
  }) as any
  tunnelsatsConf.write = (async () => {
    touched = true
  }) as any
  try {
    await assert.rejects(
      (configure as any).runFn({
        effects: {},
        input: {
          enabled: true,
          'target-node': 'lnd',
          'tunnelsats-conf': IPV6_CONF,
          'allow-ipv6': false,
        },
      }),
      { message: NOT_ANNOUNCEABLE },
    )
  } finally {
    configJson.merge = origMerge
    tunnelsatsConf.write = origWrite
  }
  assert.equal(touched, false, 'nothing may be stored for a rejected config')
})

test('Configure enables an IPv6 endpoint when IPv6 coexistence is allowed', async () => {
  const { response, merged, written } = await runConfigure(
    IPV6_CONF,
    true,
    true,
  )
  assert.equal(merged.enabled, true)
  assert.equal(written, IPV6_CONF)
  assert.match(response.message, /ask you to activate the VPN tunnel/)
  assert.ok(
    getTargetVpnConfig({
      enabled: true,
      'target-node': 'lnd',
      'tunnelsats-conf': IPV6_CONF,
      'allow-ipv6': true,
    })?.announceEndpoint,
  )
})

test('Configure keeps an IPv6-only config while TunnelSats is switched off', async () => {
  // Switched off promises no activation, so the config is simply kept.
  const { merged, written } = await runConfigure(IPV6_CONF, false)
  assert.equal(merged.enabled, false)
  assert.equal(merged['tunnelsats-conf'], IPV6_CONF)
  assert.equal(written, null)
})
