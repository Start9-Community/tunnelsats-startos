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
import { metaShape } from '../startos/fileModels/tunnelsatsMeta'
import { resolvePayInvoice } from '../startos/actions/resolvePayInvoice'

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
      versionRange: '>=0.21.3-beta:10',
      healthChecks: ['lnd'],
    },
  })
})

test('getDependenciesForConfig returns c-lightning dependency when enabled and target-node is cln', () => {
  const res = getDependenciesForConfig({ enabled: true, 'target-node': 'cln' })
  assert.deepEqual(res, {
    'c-lightning': {
      kind: 'running',
      versionRange: '>=26.6.8:3',
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
      versionRange: '>=26.6.8:3',
      healthChecks: ['lightningd'],
    },
    lnd: { kind: 'exists', versionRange: '>=0.21.3-beta:10' },
  })

  const disabled = getDependenciesForConfig({ enabled: false }, ['eclair'])
  assert.deepEqual(disabled, {
    eclair: { kind: 'exists', versionRange: '>=0.14.3:3' },
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

// ---------------------------------------------------------------------------
// Pay Invoice tasks: StartOS 0.4.0.2 shows a task TunnelSats raised on
// another package only while that package is a current dependency of
// TunnelSats, so the node that holds a TunnelSats Pay Invoice task is
// declared while the payment is pending. The metadata is parsed with the
// real file model, as setDependencies reads it.
// ---------------------------------------------------------------------------

const LND_RUNNING = {
  kind: 'running',
  versionRange: '>=0.21.3-beta:10',
  healthChecks: ['lnd'],
}
const LND_EXISTS = { kind: 'exists', versionRange: '>=0.21.3-beta:10' }
const CLN_RUNNING = {
  kind: 'running',
  versionRange: '>=26.6.8:3',
  healthChecks: ['lightningd'],
}
const CLN_EXISTS = { kind: 'exists', versionRange: '>=26.6.8:3' }
const ECLAIR_EXISTS = { kind: 'exists', versionRange: '>=0.14.3:3' }
const TOR_RUNNING = {
  kind: 'running',
  versionRange: '>=0.4.9.11:2',
  healthChecks: ['tor'],
}

function pendingOrderFor(targetNode: 'lnd' | 'cln' | 'eclair') {
  return {
    paymentHash: '1'.repeat(64),
    orderId: 'ord-1',
    privateKey: keys.privateKey,
    publicKey: keys.publicKey,
    targetNode,
    serverId: 'eu-de',
    createdAt: '2026-10-07T18:00:00.000Z',
    duration: 1,
    invoice: 'lnbc36u1p0firstpurchase',
    amountSats: 3606,
    expiresAt: '2026-10-07T19:00:00.000Z',
  }
}

function pendingRenewalFor(targetNode?: 'lnd' | 'cln' | 'eclair') {
  return {
    paymentHash: '2'.repeat(64),
    renewalId: 'ren-1',
    oldExpiry: '2026-10-10T00:00:00.000Z',
    newExpiry: '2026-11-10T00:00:00.000Z',
    createdAt: '2026-10-07T18:00:00.000Z',
    duration: 1,
    invoice: 'lnbc36u1p0renewal',
    amountSats: 3606,
    expiresAt: '2026-10-07T19:00:00.000Z',
    publicKey: keys.publicKey,
    ...(targetNode ? { targetNode } : {}),
  }
}

function pendingResetFor(targetNode: 'lnd' | 'cln' | 'eclair') {
  return {
    paymentHash: '3'.repeat(64),
    resetId: 'rst-1',
    invoice: 'lnbc10u1p0reset',
    expiresAt: '2026-10-07T19:00:00.000Z',
    createdAt: '2026-10-07T18:00:00.000Z',
    publicKey: keys.publicKey,
    serverId: 'eu-de',
    targetNode,
    amountSats: 1000,
  }
}

test('a first purchase on a fresh install declares the paying node, so its Pay Invoice task shows', () => {
  // No config.json yet and no node owes an off-task: without payTaskNodes
  // nothing would be declared, and StartOS would hide the task Buy raised.
  const meta = metaShape.parse({ pendingOrder: pendingOrderFor('lnd') })
  assert.deepEqual(getDependenciesForConfig(null, [], meta), {
    lnd: LND_EXISTS,
  })
})

test('a renewal raised on the previous node keeps that node declared after a target switch', () => {
  // Renewed on LND, then Configure switched the target to Core Lightning and
  // LND confirmed its off-task: the renewal's Pay Invoice task stays on LND.
  const meta = metaShape.parse({ pendingRenewal: pendingRenewalFor('lnd') })
  assert.deepEqual(
    getDependenciesForConfig({ enabled: true, 'target-node': 'cln' }, [], meta),
    { 'c-lightning': CLN_RUNNING, lnd: LND_EXISTS },
  )
})

test('a renewal without a recorded node is declared on the configured target, then LND', () => {
  // Older renewals did not record their node. Their task was raised on the
  // configured target, which raiseFallbackRenewalPayTask assumes as well.
  const meta = metaShape.parse({ pendingRenewal: pendingRenewalFor() })
  assert.deepEqual(
    getDependenciesForConfig(
      { enabled: false, 'target-node': 'eclair' },
      [],
      meta,
    ),
    { eclair: ECLAIR_EXISTS },
  )
  assert.deepEqual(getDependenciesForConfig(null, [], meta), {
    lnd: LND_EXISTS,
  })
})

test('an NWC renewal declares its node only once NWC falls back to the Pay Invoice task', () => {
  // bridge.py records an NWC renewal with raisePayTask false and raises no
  // task while NWC pays it. On fallback it sets the flag to true; the task is
  // raised and the flag removed, so true and absent both mean a task exists.
  // The renewal was created on LND before the target switched to CLN.
  const config = { enabled: true, 'target-node': 'cln' } as const
  const nwcRenewal = (raisePayTask?: boolean) =>
    metaShape.parse({
      pendingRenewal: {
        ...pendingRenewalFor('lnd'),
        paidViaNwc: false,
        nwcAttempted: false,
        ...(raisePayTask === undefined ? {} : { raisePayTask }),
      },
    })
  assert.deepEqual(getDependenciesForConfig(config, [], nwcRenewal(false)), {
    'c-lightning': CLN_RUNNING,
  })
  assert.deepEqual(getDependenciesForConfig(config, [], nwcRenewal(true)), {
    'c-lightning': CLN_RUNNING,
    lnd: LND_EXISTS,
  })
  assert.deepEqual(getDependenciesForConfig(config, [], nwcRenewal()), {
    'c-lightning': CLN_RUNNING,
    lnd: LND_EXISTS,
  })
})

test('a pending bandwidth reset declares the node its Pay Invoice task is on', () => {
  // Reset Bandwidth raised the task on Eclair, then the target switched to
  // Core Lightning.
  const meta = metaShape.parse({ pendingReset: pendingResetFor('eclair') })
  assert.deepEqual(
    getDependenciesForConfig({ enabled: true, 'target-node': 'cln' }, [], meta),
    { 'c-lightning': CLN_RUNNING, eclair: ECLAIR_EXISTS },
  )
})

test('a pending renewal on the enabled target keeps it a running dependency, declared once', () => {
  const meta = metaShape.parse({ pendingRenewal: pendingRenewalFor('lnd') })
  assert.deepEqual(
    getDependenciesForConfig({ enabled: true, 'target-node': 'lnd' }, [], meta),
    { lnd: LND_RUNNING },
  )
})

test('an order paid from a node other than the target declares the paying node too', () => {
  // TunnelSats routes LND; Buy Subscription was run for Core Lightning.
  const meta = metaShape.parse({ pendingOrder: pendingOrderFor('cln') })
  assert.deepEqual(
    getDependenciesForConfig({ enabled: true, 'target-node': 'lnd' }, [], meta),
    { lnd: LND_RUNNING, 'c-lightning': CLN_EXISTS },
  )
})

test('pending payment nodes stay declared when absent or uninstalled', () => {
  const meta = metaShape.parse({
    pendingOrder: pendingOrderFor('eclair'),
    pendingRenewal: pendingRenewalFor('cln'),
    pendingReset: pendingResetFor('lnd'),
  })
  assert.deepEqual(getDependenciesForConfig(null, [], meta), {
    eclair: ECLAIR_EXISTS,
    'c-lightning': CLN_EXISTS,
    lnd: LND_EXISTS,
  })
  assert.deepEqual(
    getDependenciesForConfig({ enabled: true, 'target-node': 'lnd' }, [], meta),
    { lnd: LND_RUNNING, eclair: ECLAIR_EXISTS, 'c-lightning': CLN_EXISTS },
  )
})

test('the declaration drops once the pending entry is cleared', () => {
  const pending = metaShape.parse({
    pendingOrder: pendingOrderFor('lnd'),
    pendingRenewal: pendingRenewalFor('cln'),
    pendingReset: pendingResetFor('eclair'),
  })
  assert.deepEqual(getDependenciesForConfig(null, [], pending), {
    lnd: LND_EXISTS,
    'c-lightning': CLN_EXISTS,
    eclair: ECLAIR_EXISTS,
  })
  // bridge.py removes an entry once its payment settles or its invoice is
  // given up, and queues the task's clear in the same write.
  const cleared = metaShape.parse({
    payTasksToClear: [
      `tunnelsats-order:lnd:${'1'.repeat(16)}`,
      `tunnelsats-renewal:cln:${'2'.repeat(16)}`,
      `tunnelsats-reset:eclair:${'3'.repeat(16)}`,
    ],
  })
  assert.deepEqual(getDependenciesForConfig(null, [], cleared), {})
  const nulled = metaShape.parse({
    pendingOrder: null,
    pendingRenewal: null,
    pendingReset: null,
  })
  assert.deepEqual(getDependenciesForConfig(null, [], nulled), {})
})

test('replaced orders are not declared: their tasks were queued for clearing when they were replaced', () => {
  // recordThenRaise moves a replaced order to previousPendingOrders in the
  // same write that queues its task in payTasksToClear, so no task of a
  // replaced order is left to show.
  const meta = metaShape.parse({
    previousPendingOrders: [pendingOrderFor('eclair')],
    payTasksToClear: [`tunnelsats-order:eclair:${'1'.repeat(16)}`],
  })
  assert.deepEqual(getDependenciesForConfig(null, [], meta), {})
})

test('pay-task nodes leave the pending-off nodes and Tor as they were', () => {
  const config = { enabled: true, 'target-node': 'cln' } as const
  const tor = metaShape.parse({ nwcConnected: true, nwcRouteViaTor: true })
  // Without a pending payment the result is what 1.0.0 declared.
  assert.deepEqual(getDependenciesForConfig(config, ['lnd'], tor), {
    'c-lightning': CLN_RUNNING,
    lnd: LND_EXISTS,
    tor: TOR_RUNNING,
  })
  // A payment pending on Eclair adds Eclair and nothing else.
  const withOrder = metaShape.parse({
    nwcConnected: true,
    nwcRouteViaTor: true,
    pendingOrder: pendingOrderFor('eclair'),
  })
  assert.deepEqual(getDependenciesForConfig(config, ['lnd'], withOrder), {
    'c-lightning': CLN_RUNNING,
    lnd: LND_EXISTS,
    eclair: ECLAIR_EXISTS,
    tor: TOR_RUNNING,
  })
  // A payment pending on a node that owes an off-task keeps one entry.
  const onOffNode = metaShape.parse({
    pendingRenewal: pendingRenewalFor('lnd'),
  })
  assert.deepEqual(getDependenciesForConfig(config, ['lnd'], onOffNode), {
    'c-lightning': CLN_RUNNING,
    lnd: LND_EXISTS,
  })
})

test('the declared package is the one the Pay Invoice task is raised on', () => {
  for (const node of ['lnd', 'cln', 'eclair'] as const) {
    const meta = metaShape.parse({ pendingOrder: pendingOrderFor(node) })
    assert.deepEqual(Object.keys(getDependenciesForConfig(null, [], meta)), [
      resolvePayInvoice(node).packageId,
    ])
  }
})

test('pending-off nodes stay declared when absent or uninstalled until handoff clears them', () => {
  const config = { enabled: false } as const
  assert.deepEqual(
    getDependenciesForConfig(config, ['lnd', 'c-lightning', 'eclair']),
    { lnd: LND_EXISTS, 'c-lightning': CLN_EXISTS, eclair: ECLAIR_EXISTS },
  )
  assert.deepEqual(getDependenciesForConfig(config, []), {})
})
