import test from 'node:test'
import assert from 'node:assert/strict'
import {
  getDependenciesForConfig,
  getSubscriptionExpiryTask,
  getConfirmedExpiry,
  getTargetVpnConfig,
  EXPIRY_TASK_KEY,
  RETIRED_TASK_KEYS,
  updateOwnTasks,
  UNKNOWN_KEY_TASK_KEY,
  isKeyUnknown,
  getUnknownKeyTask,
} from '../startos/dependencies'
import { clearnetVpnReplayId } from '../startos/vpnHandoff'
import { generateWireguardKeypair } from '../startos/keygen'

test('getDependenciesForConfig returns empty object when disabled or unconfigured', () => {
  assert.deepEqual(getDependenciesForConfig(null), {})
  assert.deepEqual(getDependenciesForConfig({ enabled: false }), {})
  assert.deepEqual(
    getDependenciesForConfig({ enabled: false, 'target-node': 'cln' }),
    {},
  )
  assert.deepEqual(
    getDependenciesForConfig({ enabled: false, 'target-node': 'lnd' }),
    {},
  )
})

test('getDependenciesForConfig returns LND dependency when enabled and target-node is lnd', () => {
  const res = getDependenciesForConfig({ enabled: true, 'target-node': 'lnd' })
  assert.deepEqual(res, {
    lnd: {
      kind: 'running',
      versionRange: '>=0.21.3-beta:7',
      healthChecks: ['lnd'],
    },
  })
})

test('getDependenciesForConfig returns c-lightning dependency when enabled and target-node is cln', () => {
  const res = getDependenciesForConfig({ enabled: true, 'target-node': 'cln' })
  assert.deepEqual(res, {
    'c-lightning': {
      kind: 'running',
      versionRange: '>=26.6.7:3',
      healthChecks: ['lightningd'],
    },
  })
})

test('getDependenciesForConfig keeps nodes with a pending off-task as exists dependencies', () => {
  // StartOS hides tasks on packages that are not current dependencies, so a
  // node that still owes us a confirmed "off" must stay declared.
  const res = getDependenciesForConfig(
    { enabled: true, 'target-node': 'cln' },
    ['lnd'],
  )
  assert.deepEqual(res, {
    'c-lightning': {
      kind: 'running',
      versionRange: '>=26.6.7:3',
      healthChecks: ['lightningd'],
    },
    lnd: { kind: 'exists', versionRange: '>=0.21.3-beta:7' },
  })

  const disabled = getDependenciesForConfig({ enabled: false }, ['eclair'])
  assert.deepEqual(disabled, {
    eclair: { kind: 'exists', versionRange: '>=0.14.3:2' },
  })
})

// ---------------------------------------------------------------------------
// Target selection for the clearnet-vpn handoff (ported from the retired
// gateway routing tests).
// ---------------------------------------------------------------------------

const TARGET_CONF = `[Interface]
PrivateKey = DUMMY_TEST_PRIVATE_KEY_FOR_TESTING_123456=
Address = 10.9.0.102/32
# VPNPort: 24556

[Peer]
PublicKey = DUMMY_TEST_PUBLIC_KEY_FOR_TESTING_123456=
Endpoint = ch1.tunnelsats.com:51820
`

test('getTargetVpnConfig returns null when disabled or unconfigured', () => {
  assert.equal(getTargetVpnConfig(null), null)
  assert.equal(getTargetVpnConfig(undefined), null)
  assert.equal(getTargetVpnConfig({ enabled: false }), null)
  assert.equal(
    getTargetVpnConfig({
      enabled: false,
      'target-node': 'lnd',
      'tunnelsats-conf': TARGET_CONF,
    }),
    null,
  )
  assert.equal(
    getTargetVpnConfig({ enabled: true, 'target-node': 'lnd' }),
    null,
  )
})

test('getTargetVpnConfig targets the selected node and clears every other node', () => {
  const cases = [
    { node: 'lnd', target: 'lnd', clear: ['c-lightning', 'eclair'] },
    { node: 'cln', target: 'c-lightning', clear: ['lnd', 'eclair'] },
    { node: 'eclair', target: 'eclair', clear: ['lnd', 'c-lightning'] },
  ] as const
  for (const { node, target, clear } of cases) {
    assert.deepEqual(
      getTargetVpnConfig({
        enabled: true,
        'target-node': node,
        'tunnelsats-conf': TARGET_CONF,
      }),
      {
        targetPackage: target,
        clearPackages: clear,
        announceEndpoint: 'ch1.tunnelsats.com:24556',
        wgConf: TARGET_CONF,
      },
    )
  }
})

test('getTargetVpnConfig defaults to LND when no target node is stored', () => {
  const vpn = getTargetVpnConfig({
    enabled: true,
    'tunnelsats-conf': TARGET_CONF,
  })
  assert.equal(vpn?.targetPackage, 'lnd')
})

// ---------------------------------------------------------------------------
// Expiry: only the API-confirmed expiry for the *current* key drives tasks.
// The `# Valid Until` comment is a hint and must never extend an expiry.
// ---------------------------------------------------------------------------

const NOW = new Date('2026-08-20T12:00:00Z')
const keys = generateWireguardKeypair()
const otherKeys = generateWireguardKeypair()

function confWith(comment: string | null, privateKey = keys.privateKey) {
  return [
    '[Interface]',
    `PrivateKey = ${privateKey}`,
    'Address = 10.9.0.1/32',
    ...(comment ? [`# Valid Until: ${comment}`] : []),
    '# VPNPort: 12345',
    '[Peer]',
    'PublicKey = bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb=',
    'Endpoint = de2.tunnelsats.com:51820',
    '',
  ].join('\n')
}

function confirmed(expiresAt: string, publicKey = keys.publicKey) {
  return {
    expiresAt,
    expirySource: 'api' as const,
    publicKey,
    syncSuccess: true,
  }
}

test('getSubscriptionExpiryTask returns no task when disabled or unconfigured', () => {
  const resNull = getSubscriptionExpiryTask(null)
  assert.equal(resNull.shouldCreateTask, false)
  assert.equal(resNull.clearTaskKey, 'tunnelsats:renew-subscription')

  const resDisabled = getSubscriptionExpiryTask(
    { enabled: false, 'tunnelsats-conf': confWith('2026-08-15T12:00:00Z') },
    confirmed('2026-08-15T12:00:00Z'),
    NOW,
  )
  assert.equal(resDisabled.shouldCreateTask, false)
})

test('getSubscriptionExpiryTask ignores the # Valid Until comment when nothing is confirmed', () => {
  const res = getSubscriptionExpiryTask(
    { enabled: true, 'tunnelsats-conf': confWith('2026-08-15T12:00:00Z') },
    null,
    NOW,
  )
  assert.equal(res.shouldCreateTask, false)
})

test('getSubscriptionExpiryTask returns no task when the confirmed expiry is > 7 days away', () => {
  const res = getSubscriptionExpiryTask(
    { enabled: true, 'tunnelsats-conf': confWith(null) },
    confirmed('2026-08-30T12:00:00Z'),
    NOW,
  )
  assert.equal(res.shouldCreateTask, false)
  assert.equal(res.clearTaskKey, 'tunnelsats:renew-subscription')
})

test('getSubscriptionExpiryTask raises an important Renew task at <= 7 days', () => {
  const res = getSubscriptionExpiryTask(
    { enabled: true, 'tunnelsats-conf': confWith(null) },
    confirmed('2026-08-26T12:00:00Z'),
    NOW,
  )
  assert.equal(res.shouldCreateTask, true)
  assert.equal(res.severity, 'important')
  assert.match(res.reason || '', /7 days/i)
  assert.match(res.reason || '', /Renew Subscription/)
})

// Expiry tasks are own tasks. StartOS stops the owning service while an own
// task is active *and critical*, which would halt the API sync that confirms a
// renewal and clears the task (deadlock), so every expiry task is important.
test('getSubscriptionExpiryTask raises an important Renew task at <= 3 days', () => {
  const res = getSubscriptionExpiryTask(
    { enabled: true, 'tunnelsats-conf': confWith(null) },
    confirmed('2026-08-22T12:00:00Z'),
    NOW,
  )
  assert.equal(res.shouldCreateTask, true)
  assert.equal(res.severity, 'important')
  assert.match(res.reason || '', /3 days/i)
  assert.match(res.reason || '', /Renew Subscription/)
})

test('getSubscriptionExpiryTask raises a lapse task that does not overclaim a kill switch', () => {
  const res = getSubscriptionExpiryTask(
    { enabled: true, 'tunnelsats-conf': confWith(null) },
    confirmed('2026-08-15T12:00:00Z'),
    NOW,
  )
  assert.equal(res.shouldCreateTask, true)
  assert.equal(res.severity, 'important')
  assert.match(res.reason || '', /expired/i)
  assert.match(res.reason || '', /disables your tunnel/i)
  // The kill switch belongs to the node package and is not guaranteed.
  assert.doesNotMatch(res.reason || '', /\bholds?\b|fail.closed|cannot leak/i)
  assert.match(res.reason || '', /Renew Subscription/)
})

test('getSubscriptionExpiryTask never extends a confirmed lapse on the strength of a later comment', () => {
  const res = getSubscriptionExpiryTask(
    { enabled: true, 'tunnelsats-conf': confWith('2026-12-31T12:00:00Z') },
    confirmed('2026-08-15T12:00:00Z'),
    NOW,
  )
  assert.equal(res.shouldCreateTask, true)
  assert.match(res.reason || '', /expired/i)
})

test('getSubscriptionExpiryTask uses the confirmed expiry even when the comment is earlier', () => {
  const res = getSubscriptionExpiryTask(
    { enabled: true, 'tunnelsats-conf': confWith('2026-08-15T12:00:00Z') },
    confirmed('2026-09-30T12:00:00Z'),
    NOW,
  )
  assert.equal(res.shouldCreateTask, false)
})

test("getSubscriptionExpiryTask does not apply another key's confirmed expiry", () => {
  // A newly imported config has a different key; the old key's expiry is
  // meaningless for it until the API has answered for the new key.
  const res = getSubscriptionExpiryTask(
    {
      enabled: true,
      'tunnelsats-conf': confWith(null, otherKeys.privateKey),
    },
    confirmed('2026-08-15T12:00:00Z'),
    NOW,
  )
  assert.equal(res.shouldCreateTask, false)
})

test('getConfirmedExpiry rejects unconfirmed, legacy, malformed and foreign-key metadata', () => {
  const conf = confWith(null)
  assert.equal(getConfirmedExpiry(conf, null), null)
  // Legacy meta written before provenance was tracked (possibly comment-seeded).
  assert.equal(
    getConfirmedExpiry(conf, {
      expiresAt: '2026-09-30T12:00:00Z',
      syncSuccess: true,
    }),
    null,
  )
  assert.equal(getConfirmedExpiry(conf, { ...confirmed('not-a-date') }), null)
  assert.equal(
    getConfirmedExpiry(
      conf,
      confirmed('2026-09-30T12:00:00Z', otherKeys.publicKey),
    ),
    null,
  )
  assert.equal(
    getConfirmedExpiry(
      '[Interface]\nPrivateKey = garbage\n',
      confirmed('2026-09-30T12:00:00Z'),
    ),
    null,
  )
  assert.equal(
    getConfirmedExpiry(conf, confirmed('2026-09-30T12:00:00Z'))?.toISOString(),
    '2026-09-30T12:00:00.000Z',
  )
})

test('every task key raised by released versions is retired, and no live key is', () => {
  // v0.4.0_5 raised these; StartOS never reaps a replay key that is no longer
  // written, so an upgraded box would keep offering obsolete routing changes.
  for (const released of [
    'tunnelsats:configure',
    'tunnelsats:import-subscription',
    'lnd:custom-external-host-config',
    'c-lightning:config',
  ]) {
    assert.ok(RETIRED_TASK_KEYS.includes(released), released)
  }
  for (const live of [
    EXPIRY_TASK_KEY,
    UNKNOWN_KEY_TASK_KEY,
    clearnetVpnReplayId('lnd'),
    clearnetVpnReplayId('c-lightning'),
    clearnetVpnReplayId('eclair'),
    'lnd:pay-invoice',
    'c-lightning:pay-invoice',
    'eclair:pay-invoice',
  ]) {
    assert.ok(!RETIRED_TASK_KEYS.includes(live), live)
  }
})

test('updateOwnTasks never throws and still clears retired tasks when the expiry task fails', async () => {
  const calls: string[] = []
  const failures = await updateOwnTasks(
    {
      shouldCreateTask: true,
      severity: 'important',
      reason: 'renew',
      clearTaskKey: EXPIRY_TASK_KEY,
    },
    {
      raiseExpiry: async () => {
        calls.push('raise')
        throw new Error('boom')
      },
      raiseUnknownKey: async () => {
        throw new Error('must not raise')
      },
      clear: async (...keys) => {
        calls.push(`clear:${keys.join(',')}`)
      },
    },
  )
  assert.deepEqual(calls, [
    'raise',
    `clear:${UNKNOWN_KEY_TASK_KEY}`,
    `clear:${RETIRED_TASK_KEYS.join(',')}`,
  ])
  assert.deepEqual(failures, [{ op: 'expiry', error: 'boom' }])

  const cleared: string[] = []
  const none = await updateOwnTasks(
    { shouldCreateTask: false, clearTaskKey: EXPIRY_TASK_KEY },
    {
      raiseExpiry: async () => {
        throw new Error('must not raise')
      },
      raiseUnknownKey: async () => {
        throw new Error('must not raise')
      },
      clear: async (...keys) => {
        cleared.push(keys.join(','))
        if (keys.includes(RETIRED_TASK_KEYS[0])) throw new Error('down')
      },
    },
  )
  assert.deepEqual(cleared, [
    EXPIRY_TASK_KEY,
    UNKNOWN_KEY_TASK_KEY,
    RETIRED_TASK_KEYS.join(','),
  ])
  assert.deepEqual(none, [{ op: 'retired', error: 'down' }])
})

// ---------------------------------------------------------------------------
// Unknown key (G6): bridge.py records `keyUnknown` for the key the API has no
// subscription for; only that key's verdict raises the Import/Buy task.
// ---------------------------------------------------------------------------

function unknownFor(publicKey = keys.publicKey) {
  return { publicKey, keyUnknown: true, syncSuccess: false }
}

test('isKeyUnknown only trusts a verdict recorded for the configured key', () => {
  const conf = confWith(null)
  assert.equal(isKeyUnknown(conf, unknownFor()), true)
  assert.equal(isKeyUnknown(conf, unknownFor(otherKeys.publicKey)), false)
  assert.equal(isKeyUnknown(conf, { publicKey: keys.publicKey }), false)
  assert.equal(isKeyUnknown(conf, { keyUnknown: true }), false)
  assert.equal(isKeyUnknown('[Interface]\n', unknownFor()), false)
  assert.equal(isKeyUnknown(conf, null), false)
})

test('getUnknownKeyTask raises an important Import task naming Buy as the alternative', () => {
  const task = getUnknownKeyTask(
    { enabled: true, 'tunnelsats-conf': confWith(null) },
    unknownFor(),
  )
  assert.equal(task.shouldCreateTask, true)
  assert.equal(task.clearTaskKey, UNKNOWN_KEY_TASK_KEY)
  assert.match(task.reason || '', /no subscription/i)
  assert.match(task.reason || '', /Import/)
  assert.match(task.reason || '', /Buy Subscription/)
})

test('getUnknownKeyTask stays clear when disabled, unconfigured, known or for another key', () => {
  const conf = confWith(null)
  for (const [config, meta] of [
    [{ enabled: false, 'tunnelsats-conf': conf }, unknownFor()],
    [{ enabled: true }, unknownFor()],
    [
      { enabled: true, 'tunnelsats-conf': conf },
      confirmed('2099-01-01T00:00:00Z'),
    ],
    [
      { enabled: true, 'tunnelsats-conf': conf },
      unknownFor(otherKeys.publicKey),
    ],
    [{ enabled: true, 'tunnelsats-conf': conf }, null],
  ] as const) {
    const task = getUnknownKeyTask(config, meta)
    assert.equal(task.shouldCreateTask, false)
    assert.equal(task.clearTaskKey, UNKNOWN_KEY_TASK_KEY)
  }
})

test('the unknown-key task has its own replay key, not the retired Import default', () => {
  // createOwnTask would default to `tunnelsats:import-subscription`, which is
  // retired and cleared on every run.
  assert.notEqual(UNKNOWN_KEY_TASK_KEY, 'tunnelsats:import-subscription')
  assert.ok(!RETIRED_TASK_KEYS.includes(UNKNOWN_KEY_TASK_KEY))
})

test('updateOwnTasks raises the unknown-key task and isolates its failure', async () => {
  const raised: string[] = []
  const cleared: string[] = []
  const failures = await updateOwnTasks(
    { shouldCreateTask: false, clearTaskKey: EXPIRY_TASK_KEY },
    {
      raiseExpiry: async () => {
        throw new Error('must not raise')
      },
      raiseUnknownKey: async (reason) => {
        raised.push(reason)
        throw new Error('down')
      },
      clear: async (...k) => {
        cleared.push(k.join(','))
      },
    },
    {
      shouldCreateTask: true,
      reason: 'import',
      clearTaskKey: UNKNOWN_KEY_TASK_KEY,
    },
  )
  assert.deepEqual(raised, ['import'])
  // The retired keys are still cleared after the failure.
  assert.deepEqual(cleared, [EXPIRY_TASK_KEY, RETIRED_TASK_KEYS.join(',')])
  assert.deepEqual(failures, [{ op: 'unknown-key', error: 'down' }])
})
