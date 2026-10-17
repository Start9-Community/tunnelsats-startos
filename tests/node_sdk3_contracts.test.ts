import test from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { ExtendedVersion, VersionRange } from '@start9labs/start-sdk'
import { clearnetVpn as lndClearnetVpn } from 'lnd-startos/startos/actions/clearnetVpn'
import { payInvoice as lndPayInvoice } from 'lnd-startos/startos/actions/payInvoice'
import { versionGraph as lndVersionGraph } from 'lnd-startos/startos/versions'
import { clearnetVpn as clnClearnetVpn } from 'cln-startos/startos/actions/clearnetVpn'
import { payInvoice as clnPayInvoice } from 'cln-startos/startos/actions/payInvoice'
import { versionGraph as clnVersionGraph } from 'cln-startos/startos/versions'
import { clearnetVpn as eclairClearnetVpn } from 'eclair-startos/startos/actions/clearnetVpn'
import { payInvoice as eclairPayInvoice } from 'eclair-startos/startos/actions/payInvoice'
import { versionGraph as eclairVersionGraph } from 'eclair-startos/startos/versions'
import { socksHostId, socksPort } from 'tor-startos/startos/utils'
import { versionGraph as torVersionGraph } from 'tor-startos/startos/versions'
import {
  getDependenciesForConfig,
  getTargetVpnConfig,
} from '../startos/dependencies'
import { resolvePayInvoice } from '../startos/actions/resolvePayInvoice'
import { TOR_SOCKS_HOST_ID, TOR_SOCKS_PORT } from '../startos/bridgeEnv'
import { buildOffTaskInput, buildOnTaskInput } from '../startos/vpnHandoff'

const REPO_ROOT = join(__dirname, '..')

const SAMPLE_WG_CONF = `[Interface]
PrivateKey = DUMMY_TEST_PRIVATE_KEY_FOR_TESTING_123456=
Address = 10.9.0.102/32
DNS = 8.8.8.8
# Valid Until: 2026-12-31T23:59:59Z
# VPNPort: 24556

[Peer]
PublicKey = DUMMY_TEST_PUBLIC_KEY_FOR_TESTING_123456=
PresharedKey = DUMMY_TEST_PSK_KEY_FOR_TESTING_1234567890=
Endpoint = de2.tunnelsats.com:51820
AllowedIPs = 0.0.0.0/0
PersistentKeepalive = 25
`

test('SDK 3 dependency contract: node packages and TunnelSats declare @start9labs/start-sdk >= 3.0.6 (< 4.0.0)', () => {
  const sdkRange = VersionRange.parse('>=3.0.6:0 <4.0.0:0')
  const packages = [
    join(REPO_ROOT, 'package.json'),
    join(REPO_ROOT, 'node_modules/lnd-startos/package.json'),
    join(REPO_ROOT, 'node_modules/cln-startos/package.json'),
    join(REPO_ROOT, 'node_modules/eclair-startos/package.json'),
    join(REPO_ROOT, 'node_modules/tor-startos/package.json'),
  ]

  for (const pkgPath of packages) {
    const pkg = JSON.parse(readFileSync(pkgPath, 'utf8')) as {
      name?: string
      dependencies?: Record<string, string>
    }
    const rawSdkVer = pkg.dependencies?.['@start9labs/start-sdk'] ?? ''
    const normalizedVer = rawSdkVer.replace(/^[~^]/, '')
    assert.ok(
      normalizedVer.length > 0 &&
        ExtendedVersion.parse(`${normalizedVer}:0`).satisfies(sdkRange),
      `${pkg.name ?? pkgPath} must depend on @start9labs/start-sdk >= 3.0.6 (< 4.0.0), got "${rawSdkVer}"`,
    )
  }
})

test('SDK 3 version range contract: QA baseline and start-sdk 3.0.6 node releases satisfy declared dependency ranges', () => {
  const lndDeps = getDependenciesForConfig({
    enabled: true,
    'target-node': 'lnd',
  })
  const clnDeps = getDependenciesForConfig({
    enabled: true,
    'target-node': 'cln',
  })
  const eclairDeps = getDependenciesForConfig({
    enabled: true,
    'target-node': 'eclair',
  })
  const torDeps = getDependenciesForConfig(
    { enabled: true, 'target-node': 'lnd' },
    [],
    { nwcConnected: true, nwcRouteViaTor: true },
  )

  assert.ok(lndDeps.lnd)
  assert.ok(clnDeps['c-lightning'])
  assert.ok(eclairDeps.eclair)
  assert.ok(torDeps.tor)

  const matrix: {
    packageId: string
    rangeStr: string
    installedCurrent: string
    versions: string[]
    rejected: string[]
  }[] = [
    {
      packageId: 'lnd',
      rangeStr: lndDeps.lnd.versionRange,
      installedCurrent: (lndVersionGraph as any).current.options.version,
      versions: [
        '0.21.3-beta:10',
        '0.21.4-beta:0',
        '0.21.4-beta:1',
        '0.21.4-beta:2',
        '0.21.4-beta:3',
      ],
      rejected: ['0.21.3-beta:9', '0.21.2-beta:5'],
    },
    {
      packageId: 'c-lightning',
      rangeStr: clnDeps['c-lightning'].versionRange,
      installedCurrent: (clnVersionGraph as any).current.options.version,
      versions: [
        '26.6.8:3',
        '26.6.8:7',
        '26.6.9:0',
        '26.6.9:1',
        '26.6.9:2',
        '26.6.9:3',
      ],
      rejected: ['26.6.8:2', '26.6.2:0'],
    },
    {
      packageId: 'eclair',
      rangeStr: eclairDeps.eclair.versionRange,
      installedCurrent: (eclairVersionGraph as any).current.options.version,
      versions: ['0.14.3:3', '0.14.3:4', '0.14.3:5'],
      rejected: ['0.14.3:2', '0.14.2:0'],
    },
    {
      packageId: 'tor',
      rangeStr: torDeps.tor.versionRange,
      installedCurrent: (torVersionGraph as any).current.options.version,
      versions: [
        '0.4.9.11:2',
        '0.4.9.12:5',
        '0.4.9.13:1',
        '0.4.9.14:0',
        '0.4.9.14:1',
      ],
      rejected: ['0.4.9.11:1'],
    },
  ]

  for (const {
    packageId,
    rangeStr,
    installedCurrent,
    versions,
    rejected,
  } of matrix) {
    const range = VersionRange.parse(rangeStr)
    for (const verStr of [...versions, installedCurrent]) {
      const parsedVer = ExtendedVersion.parse(verStr)
      assert.equal(
        range.satisfiedBy(parsedVer),
        true,
        `${packageId} version ${verStr} must satisfy range ${rangeStr}`,
      )
      assert.equal(
        parsedVer.satisfies(range),
        true,
        `${packageId} ExtendedVersion.satisfies(${rangeStr}) failed for ${verStr}`,
      )
    }
    for (const verStr of rejected) {
      const parsedVer = ExtendedVersion.parse(verStr)
      assert.equal(
        range.satisfiedBy(parsedVer),
        false,
        `${packageId} pre-baseline version ${verStr} must not satisfy range ${rangeStr}`,
      )
    }
  }
})

test('SDK 3 clearnet-vpn handoff contract: lnd, c-lightning, and eclair validate on/off/IPv6 task payloads without restrictive regex patterns', async () => {
  const actions = [
    { targetNode: 'lnd' as const, packageId: 'lnd', action: lndClearnetVpn },
    {
      targetNode: 'cln' as const,
      packageId: 'c-lightning',
      action: clnClearnetVpn,
    },
    {
      targetNode: 'eclair' as const,
      packageId: 'eclair',
      action: eclairClearnetVpn,
    },
  ]

  for (const { targetNode, packageId, action } of actions) {
    assert.equal(
      action.id,
      'clearnet-vpn',
      `${packageId} clearnetVpn action id`,
    )

    const inputSpec = (action as any).inputSpec
    assert.ok(inputSpec, `${packageId} clearnetVpn must expose inputSpec`)

    const built = await inputSpec.build({
      effects: {} as never,
      prefill: null,
    })

    // Neither config nor announce may define restrictive regex patterns that
    // could reject valid WireGuard configs or host:port / [IPv6]:port strings
    // during SDK 3 server-side input validation.
    assert.deepEqual(
      built.spec.config.patterns,
      [],
      `${packageId} clearnet-vpn config must not define restrictive regex patterns`,
    )
    assert.deepEqual(
      built.spec.announce.patterns,
      [],
      `${packageId} clearnet-vpn announce must not define restrictive regex patterns`,
    )

    // Verify the "on" task input built from getTargetVpnConfig + buildOnTaskInput
    const vpn = getTargetVpnConfig({
      enabled: true,
      'target-node': targetNode,
      'tunnelsats-conf': SAMPLE_WG_CONF,
    })
    assert.ok(vpn)
    assert.equal(vpn.targetPackage, packageId)
    assert.equal(vpn.announceEndpoint, 'de2.tunnelsats.com:24556')

    const onTaskInput = buildOnTaskInput(vpn.wgConf, vpn.announceEndpoint)
    assert.deepEqual(onTaskInput.set, {
      config: SAMPLE_WG_CONF.trim(),
      announce: 'de2.tunnelsats.com:24556',
    })
    assert.deepEqual(
      built.validator.parse(onTaskInput.set),
      onTaskInput.set,
      `${packageId} validator must accept on-task set payload`,
    )
    for (const acceptEntry of onTaskInput.accept) {
      assert.deepEqual(
        built.validator.parse(acceptEntry),
        acceptEntry,
        `${packageId} validator must accept on-task accept entry`,
      )
      assert.deepEqual(
        inputSpec.partialValidator.parse(acceptEntry),
        acceptEntry,
        `${packageId} partialValidator must accept on-task accept entry`,
      )
    }

    // Verify the "off" task inputs ({ config: null, announce: null } and { config: null })
    const offTaskInput = buildOffTaskInput()
    assert.deepEqual(offTaskInput.set, { config: null, announce: null })
    assert.deepEqual(offTaskInput.accept, [{ config: null }])
    assert.deepEqual(
      built.validator.parse({ config: null, announce: null }),
      { config: null, announce: null },
      `${packageId} validator must accept off-task { config: null, announce: null }`,
    )
    assert.deepEqual(
      inputSpec.partialValidator.parse({ config: null }),
      { config: null },
      `${packageId} partialValidator must accept off-task partial { config: null }`,
    )

    // Verify an IPv6 announce endpoint is accepted by validator.parse
    const ipv6Payload = {
      config: SAMPLE_WG_CONF.trim(),
      announce: '[2a01:4f8:c012:1234::1]:24556',
    }
    assert.deepEqual(
      built.validator.parse(ipv6Payload),
      ipv6Payload,
      `${packageId} validator must accept IPv6 announce endpoint`,
    )
  }
})

test('SDK 3 node vpn.ts dataplane contract: parseWireguardConfig, isHostPort, renderWgQuick (B1-B3), and vpnDownScript (B8)', async () => {
  const { assembleWireguardConfig } = await import('../startos/apiClient')
  const { generateWireguardKeypair } = await import('../startos/keygen')
  const lndVpn = await import('lnd-startos/startos/vpn')
  const clnVpn = await import('cln-startos/startos/vpn')
  const eclairVpn = await import('eclair-startos/startos/vpn')

  const clientKeys = generateWireguardKeypair()
  const serverKeys = generateWireguardKeypair()
  const psk = generateWireguardKeypair().privateKey
  const claimedConf = assembleWireguardConfig(
    {
      server: {
        endpoint: 'de2.tunnelsats.com:51820',
        publicKey: serverKeys.publicKey,
        allowedIPs: '0.0.0.0/0',
      },
      peer: {
        address: '10.9.0.102/32',
        presharedKey: psk,
      },
      subscriptionEnd: '2026-12-31T23:59:59Z',
      vpnPort: 24556,
    },
    clientKeys.privateKey,
  )

  const vpnModules = [
    { packageId: 'lnd', mod: lndVpn },
    { packageId: 'c-lightning', mod: clnVpn },
    { packageId: 'eclair', mod: eclairVpn },
  ] as const

  for (const { packageId, mod } of vpnModules) {
    assert.equal(mod.vpnIface, 'wg0')
    assert.equal(mod.vpnTable, 51820)

    const parsed = mod.parseWireguardConfig(claimedConf.trim())
    assert.ok(
      !('error' in parsed),
      `${packageId} parseWireguardConfig must accept assembleWireguardConfig output`,
    )
    assert.equal(parsed.config.privateKey, clientKeys.privateKey)
    assert.equal(parsed.config.publicKey, serverKeys.publicKey)
    assert.equal(parsed.config.presharedKey, psk)
    assert.equal(parsed.config.endpoint, 'de2.tunnelsats.com:51820')
    assert.equal(parsed.config.allowedIps, '0.0.0.0/0')

    assert.equal(mod.isHostPort('de2.tunnelsats.com:24556'), true)
    assert.equal(mod.isHostPort('[2a01:4f8:c012:1234::1]:24556'), true)
    assert.equal(mod.isHostPort('de2.tunnelsats.com'), false)
    assert.equal(mod.isHostPort('de2.tunnelsats.com:70000'), false)

    const wgQuick =
      packageId === 'eclair'
        ? eclairVpn.renderWgQuick(parsed.config, 24556)
        : (mod.renderWgQuick as (c: typeof parsed.config) => string)(
            parsed.config,
          )
    assert.match(wgQuick, /^Table = off$/m)
    assert.match(wgQuick, /PostUp = wg set %i fwmark 51820/)
    assert.match(wgQuick, /PostUp = ip -4 route add default dev %i table 51820/)
    assert.match(
      wgQuick,
      /PostUp = ip -4 route add blackhole default metric 4294967295 table 51820/,
    )
    assert.match(
      wgQuick,
      /PostUp = ip -6 route add blackhole default metric 4294967295 table 51820/,
    )
    assert.match(
      wgQuick,
      /PostUp = ip -4 rule add not fwmark 51820 table 51820/,
    )
    assert.match(
      wgQuick,
      /PostUp = ip -4 rule add table main suppress_prefixlength 0/,
    )
    if (packageId === 'eclair') {
      assert.match(
        wgQuick,
        /iptables -t nat -A PREROUTING -i %i -p tcp --dport 9735 -j REDIRECT --to-ports 24556/,
      )
    }

    assert.match(mod.vpnDownScript, /ip link del wg0/)
    assert.match(mod.vpnDownScript, /ip \$fam route flush table 51820/)
    assert.match(mod.vpnDownScript, /ip \$fam rule del table 51820/)
    assert.match(
      mod.vpnDownScript,
      /ip \$fam rule del table main suppress_prefixlength 0/,
    )
  }
})

test('SDK 3 pay-invoice settlement contract: resolvePayInvoice actions accept TunnelSats task payload', async () => {
  const expectedActions = {
    lnd: { packageId: 'lnd', action: lndPayInvoice },
    cln: { packageId: 'c-lightning', action: clnPayInvoice },
    eclair: { packageId: 'eclair', action: eclairPayInvoice },
  } as const

  // Exact payload raised by buySubscription, renewSubscription, resetBandwidth,
  // and NWC fallback renewal tasks.
  const taskPayload = {
    invoice: 'lnbc45u1p0testinvoice',
    amount: { selection: 'invoice' as const, value: {} },
    'max-fee-percent': 1,
    confirmed: false,
  }

  for (const node of ['lnd', 'cln', 'eclair'] as const) {
    const { packageId, payInvoiceAction } = resolvePayInvoice(node)
    assert.equal(packageId, expectedActions[node].packageId)
    assert.equal(payInvoiceAction, expectedActions[node].action)
    assert.equal(payInvoiceAction.id, 'pay-invoice')

    // When prefill is null (task creation / unprefilled spec build), inputSpec
    // resolves without invoking node container or RPC decode helpers.
    const specFn = (payInvoiceAction as any).inputSpec
    assert.equal(typeof specFn, 'function')
    const inputSpec = await specFn({
      effects: {} as never,
      prefill: null,
      caller: null,
    })
    const built = await inputSpec.build({
      effects: {} as never,
      prefill: null,
    })

    assert.deepEqual(
      built.validator.parse(taskPayload),
      taskPayload,
      `${packageId} pay-invoice validator must accept TunnelSats settlement task payload`,
    )
    assert.deepEqual(
      inputSpec.partialValidator.parse(taskPayload),
      taskPayload,
      `${packageId} pay-invoice partialValidator must accept TunnelSats settlement task payload`,
    )
  }
})

test('SDK 3 Tor SOCKS5 contract: TOR_SOCKS_HOST_ID and TOR_SOCKS_PORT match tor-startos', () => {
  assert.equal(TOR_SOCKS_HOST_ID, 'socks')
  assert.equal(TOR_SOCKS_PORT, 9050)
  assert.equal(TOR_SOCKS_HOST_ID, socksHostId)
  assert.equal(TOR_SOCKS_PORT, socksPort)
})
