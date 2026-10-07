import test from 'node:test'
import assert from 'node:assert/strict'
import {
  parseNwcUri,
  calculateRecommendedBudget,
  estimateRenewalSatsForDuration,
  getRecommendedBudgetForSetting,
  resolveNwcDurationMonths,
} from '../startos/nwc'
import { buildMainBackups, NWC_BACKUP_EXCLUDES } from '../startos/backups'
import {
  getDependenciesForConfig,
  getSubscriptionExpiryTask,
  getNwcWalletTask,
  isNwcAutoRenewHealthy,
  noticeInputsFor,
  NWC_WALLET_TASK_KEY,
  EXPIRY_TASK_KEY,
  updateOwnTasks,
  raiseFallbackRenewalPayTask,
} from '../startos/dependencies'
import {
  planNotifications,
  createNoticeRunner,
  type NoticeState,
  type PlannedNotification,
} from '../startos/notifications'
import { runConnectWallet } from '../startos/actions/connectWallet'

const VALID_PUBKEY = 'a'.repeat(64)
const VALID_SECRET = 'b'.repeat(64)
const VALID_URI = `nostr+walletconnect://${VALID_PUBKEY}?relay=wss%3A%2F%2Frelay.getalby.com%2Fv1&secret=${VALID_SECRET}`

// Deterministic WireGuard config whose private key derives to a known public key:
// PrivKey = 32 zero bytes (AA...AA=) -> PubKey = 'L-V9o0fNYkMVKNqsX7spBzD_9oSvxM1C7ZCZX1jLO3Q=' (or let's use a 1-byte key from existing tests)
const TEST_WG_PRIV = 'YWFhYWFhYWFhYWFhYWFhYWFhYWFhYWFhYWFhYWFhYWE='
const TEST_WG_PUB = 'r6ad97ba2B8cc127R8E42b0239a07b2a9d22368d214='

// Let's compute the exact X25519 public key for TEST_WG_PRIV at runtime or read from noticeInputsFor:
const SAMPLE_WG_CONF = `[Interface]\nPrivateKey = ${TEST_WG_PRIV}\nAddress = 10.9.0.2/32\n`

test('parseNwcUri validates nostr+walletconnect:// URIs and detects .onion relays', () => {
  const parsed = parseNwcUri(VALID_URI)
  assert.equal(parsed.walletPubkey, VALID_PUBKEY)
  assert.equal(parsed.secret, VALID_SECRET)
  assert.equal(parsed.relayUrl, 'wss://relay.getalby.com/v1')
  assert.deepEqual(parsed.relays, ['wss://relay.getalby.com/v1'])
  assert.equal(parsed.relayHost, 'relay.getalby.com')
  assert.equal(parsed.isOnionRelay, false)

  // Allows ws:// for .onion hidden services and sets isOnionRelay = true
  const onionUri = `nostr+walletconnect://${VALID_PUBKEY}?relay=ws://albyhubxyz123456.onion:8080/v1&secret=${VALID_SECRET}`
  const parsedOnion = parseNwcUri(onionUri)
  assert.equal(parsedOnion.isOnionRelay, true)
  assert.equal(parsedOnion.relayHost, 'albyhubxyz123456.onion')
  assert.deepEqual(parsedOnion.relays, ['ws://albyhubxyz123456.onion:8080/v1'])

  // Rejects plaintext ws:// on clearnet relays
  assert.throws(
    () =>
      parseNwcUri(
        `nostr+walletconnect://${VALID_PUBKEY}?relay=ws://relay.getalby.com/v1&secret=${VALID_SECRET}`,
      ),
    /only permitted for \.onion/,
  )

  // Rejects invalid pubkey or secret without leaking the secret in the error message
  assert.throws(
    () =>
      parseNwcUri(
        `nostr+walletconnect://not-hex?relay=wss://relay.getalby.com&secret=${VALID_SECRET}`,
      ),
    (err: Error) => {
      assert.ok(!err.message.includes(VALID_SECRET))
      return /Invalid NWC wallet public key: expected a 64-character hex string/.test(
        err.message,
      )
    },
  )
  assert.throws(
    () =>
      parseNwcUri(
        `nostr+walletconnect://${VALID_PUBKEY}?relay=wss://relay.getalby.com&secret=short`,
      ),
    /Invalid NWC secret: expected a 64-character hexadecimal secret/,
  )
})

test('1.2x transparent budgeting helpers compute rounded per-renewal and annual budgets', () => {
  assert.equal(resolveNwcDurationMonths('match', 3), 3)
  assert.equal(resolveNwcDurationMonths('match', null), 1)
  assert.equal(resolveNwcDurationMonths('6m', 1), 6)

  // Default 1m baseline is 4,500 sats -> 1.2x = 5,400 sats
  const oneMonth = calculateRecommendedBudget(4500, 1)
  assert.equal(oneMonth.perRenewalSats, 5400)
  assert.equal(oneMonth.annualSats, 64800)
  assert.equal(oneMonth.multiplier, 1.2)

  // Scaling from a known 1m invoice (5,000 sats) to 3m (15,000 sats -> 1.2x = 18,000 sats)
  const scaled3m = estimateRenewalSatsForDuration(3, 5000, 1)
  assert.equal(scaled3m.estimatedSats, 15000)
  const rec3m = getRecommendedBudgetForSetting({
    autoRenewDuration: '3m',
    lastAmountSats: 5000,
    lastDuration: 1,
  })
  assert.equal(rec3m.durationMonths, 3)
  assert.equal(rec3m.perRenewalSats, 18000)
  assert.equal(rec3m.annualSats, 72000)
})

test('StartOS backup configuration excludes nwc-wallet.json', () => {
  assert.ok(NWC_BACKUP_EXCLUDES.includes('nwc-wallet.json'))
  const backupArtifact = buildMainBackups()
  assert.ok(backupArtifact)
})

test('runConnectWallet connects, enforces Tor for .onion relays, and disconnects cleanly under metaLock', async () => {
  let walletFile: any = null
  let metaFile: any = {
    lastDuration: 3,
    lastAmountSats: 12000,
    nwcAutoRenewState: {
      attempts: 2,
      fallbackTaskRaised: true,
      budgetWarning: true,
      restoreReconnectNeeded: true,
      lastPaidHash: 'c'.repeat(64),
      lastPaidAt: '2026-09-01T00:00:00.000Z',
    },
  }
  let lockCalls = 0

  const ops = {
    now: () => new Date('2026-09-28T12:00:00.000Z'),
    lockMeta: async <T>(fn: () => Promise<T>): Promise<T> => {
      lockCalls++
      return fn()
    },
    readMeta: async () => (metaFile ? structuredClone(metaFile) : null),
    writeWalletFile: async (data: any) => {
      walletFile = structuredClone(data)
    },
    removeWalletFile: async () => {
      walletFile = null
    },
    writeMeta: async (patch: any) => {
      metaFile = { ...metaFile, ...patch }
    },
  }

  const onionUri = `nostr+walletconnect://${VALID_PUBKEY}?relay=ws://myrelay.onion:8080&secret=${VALID_SECRET}`
  const connectRes = await runConnectWallet(
    {
      mode: 'connect',
      nwcUri: onionUri,
      autoRenewDuration: 'match',
      routeViaTor: false, // should be auto-enforced to true because of .onion
    },
    ops,
  )

  assert.equal(lockCalls, 1)
  assert.ok(walletFile)
  assert.equal(walletFile.relayHost, 'myrelay.onion')
  assert.equal(walletFile.routeViaTor, true)
  assert.equal(metaFile.nwcConnected, true)
  assert.equal(metaFile.nwcRelayHost, 'myrelay.onion')
  assert.equal(metaFile.nwcRouteViaTor, true)
  assert.equal(metaFile.nwcAutoRenewState, null)

  // Result never exposes the secret or full NWC URI
  const resultJson = JSON.stringify(connectRes)
  assert.ok(!resultJson.includes(VALID_SECRET))
  assert.ok(!resultJson.includes('nostr+walletconnect://'))

  // Disconnect clears walletFile and resets meta flags
  await runConnectWallet(
    {
      mode: 'disconnect',
      nwcUri: null,
      autoRenewDuration: 'match',
      routeViaTor: false,
    },
    ops,
  )
  assert.equal(walletFile, null)
  assert.equal(metaFile.nwcConnected, false)
  assert.equal(metaFile.nwcRelayHost, undefined)
  assert.equal(metaFile.nwcRouteViaTor, undefined)
  assert.equal(metaFile.nwcAutoRenewState, null)
})

test('dependencies: Tor is declared when nwcConnected && nwcRouteViaTor, and 7d/3d manual renew task is suppressed while NWC is healthy', async () => {
  const depsWithTor = getDependenciesForConfig(
    { enabled: true, 'target-node': 'lnd' },
    [],
    { nwcConnected: true, nwcRouteViaTor: true },
  )
  assert.deepEqual(depsWithTor.tor, {
    kind: 'running',
    versionRange: '>=0.4.9.11:2',
    healthChecks: ['tor'],
  })

  const depsWithoutTor = getDependenciesForConfig(
    { enabled: true, 'target-node': 'lnd' },
    [],
    { nwcConnected: true, nwcRouteViaTor: false },
  )
  assert.equal(depsWithoutTor.tor, undefined)

  const cfg = { enabled: true, 'tunnelsats-conf': SAMPLE_WG_CONF }
  const derivedPubKey = noticeInputsFor(cfg, null)?.publicKey
  assert.ok(derivedPubKey)

  const now = new Date('2026-09-28T12:00:00.000Z')
  const inFiveDays = new Date(now.getTime() + 5 * 86400000).toISOString()
  const healthyMeta = {
    publicKey: derivedPubKey,
    expiresAt: inFiveDays,
    expirySource: 'api' as const,
    nwcConnected: true,
    nwcAutoRenewState: {
      budgetWarning: false,
      fallbackTaskRaised: false,
      restoreReconnectNeeded: false,
    },
  }
  assert.equal(isNwcAutoRenewHealthy(healthyMeta, true), true)
  // Suppressed at 5 days remaining because NWC auto-renew is healthy!
  assert.equal(
    getSubscriptionExpiryTask(cfg, healthyMeta, now, true).shouldCreateTask,
    false,
  )
  // Still raised if already expired!
  const expiredAt = new Date(now.getTime() - 3600000).toISOString()
  const lapsedMeta = { ...healthyMeta, expiresAt: expiredAt }
  const lapsedTask = getSubscriptionExpiryTask(cfg, lapsedMeta, now, true)
  assert.equal(lapsedTask.shouldCreateTask, true)
  assert.equal(lapsedTask.severity, 'important')

  // Post-restore missing wallet file raises Connect Wallet task
  const restoreTask = getNwcWalletTask(cfg, healthyMeta, false)
  assert.equal(restoreTask.shouldCreateTask, true)
  assert.equal(restoreTask.clearTaskKey, NWC_WALLET_TASK_KEY)
  assert.match(restoreTask.reason ?? '', /excluded from StartOS backups/)

  // Budget warning raises Connect Wallet task for current period
  const budgetMeta = {
    ...healthyMeta,
    nwcAutoRenewState: {
      periodExpiry: inFiveDays,
      budgetWarning: true,
      lastError: 'Budget below 5400 sats',
    },
  }
  const budgetTask = getNwcWalletTask(cfg, budgetMeta, true)
  assert.equal(budgetTask.shouldCreateTask, true)
  assert.equal(budgetTask.clearTaskKey, NWC_WALLET_TASK_KEY)
  assert.match(budgetTask.reason ?? '', /Budget below 5400 sats/)

  // Once a manual renewal advances expiresAt to a new period, stale period failure is ignored
  const nextPeriodExpiry = new Date(now.getTime() + 35 * 86400000).toISOString()
  const advancedMeta = {
    ...budgetMeta,
    expiresAt: nextPeriodExpiry,
  }
  assert.equal(isNwcAutoRenewHealthy(advancedMeta, true), true)
  assert.equal(
    getNwcWalletTask(cfg, advancedMeta, true).shouldCreateTask,
    false,
  )
  assert.equal(noticeInputsFor(cfg, advancedMeta, true)?.nwcFallback, undefined)

  // updateOwnTasks wires renewSubscription, unknownKey, and nwcWallet tasks
  const raisedNwcReasons: string[] = []
  const clearedKeys: string[] = []
  await updateOwnTasks(
    { shouldCreateTask: false, clearTaskKey: EXPIRY_TASK_KEY },
    {
      raiseExpiry: async () => {},
      raiseUnknownKey: async () => {},
      raiseNwcWallet: async (reason) => {
        raisedNwcReasons.push(reason)
      },
      clear: async (...keys) => {
        clearedKeys.push(...keys)
      },
    },
    { shouldCreateTask: false, clearTaskKey: 'unknown-subscription-key' },
    restoreTask,
  )
  assert.equal(raisedNwcReasons.length, 1)
  assert.ok(clearedKeys.includes(EXPIRY_TASK_KEY))
})

test('raiseFallbackRenewalPayTask raises Pay Invoice task once and clears raisePayTask flag', async () => {
  let clearedHash: string | null = null
  const raisedTasks: any[] = []
  const raised = await raiseFallbackRenewalPayTask({
    config: { 'target-node': 'lnd' },
    meta: {
      pendingRenewal: {
        paymentHash: 'd'.repeat(64),
        invoice: 'lnbc45u1pvalidinvoice',
        duration: 3,
        amountSats: 12500,
        createdAt: '2026-09-28T12:00:00.000Z',
        targetNode: 'lnd',
        paidViaNwc: true,
        raisePayTask: true,
      },
    },
    lockMeta: async (fn) => fn(),
    createTask: async (task) => {
      raisedTasks.push(task)
    },
    clearRaiseFlag: async (hash) => {
      clearedHash = hash
    },
  })
  assert.equal(raised, true)
  assert.equal(raisedTasks.length, 1)
  assert.equal(raisedTasks[0].packageId, 'lnd')
  assert.equal(raisedTasks[0].invoice, 'lnbc45u1pvalidinvoice')
  assert.equal(clearedHash, 'd'.repeat(64))
})

test('notifications: emits nwc-renewed, nwc-fallback, and nwc-restore once per state transition', async () => {
  const now = new Date('2026-09-28T12:00:00.000Z')
  const expiry = new Date(now.getTime() + 30 * 86400000)

  // 1. NWC auto-renewal succeeded
  const renewedInput = {
    publicKey: 'wg-pub-1',
    expiry,
    keyUnknown: false,
    nwcRenewed: {
      paymentHash: 'e'.repeat(64),
      duration: 3,
      amountSats: 12500,
      newExpiry: expiry.toISOString(),
    },
  }
  const plan1 = planNotifications(renewedInput, null, now)
  assert.ok(plan1.steps.some((s) => s.notice.kind === 'nwc-renewed'))
  assert.equal(plan1.next.nwcRenewedHash, 'e'.repeat(64))

  // Second pass with next state does not re-emit nwc-renewed
  const plan2 = planNotifications(renewedInput, plan1.next, now)
  assert.ok(!plan2.steps.some((s) => s.notice.kind === 'nwc-renewed'))

  // 2. NWC fallback task raised
  const fallbackInput = {
    publicKey: 'wg-pub-1',
    expiry: new Date(now.getTime() + 4 * 86400000),
    keyUnknown: false,
    nwcFallback: {
      key: `${expiry.toISOString()}:QUOTA_EXCEEDED`,
      reason: 'Budget exceeded',
    },
  }
  const planFallback = planNotifications(fallbackInput, plan1.next, now)
  assert.ok(planFallback.steps.some((s) => s.notice.kind === 'nwc-fallback'))

  // 3. Post-restore missing wallet file via createNoticeRunner
  const postedKinds: string[] = []
  let savedState: NoticeState | null = null
  const runner = createNoticeRunner({
    readInputs: async () => ({
      publicKey: 'wg-pub-1',
      expiry,
      keyUnknown: false,
      nwcRestoreNeeded: true,
    }),
    readState: async () => savedState,
    writeState: async (s) => {
      savedState = s
    },
    notify: async (n) => {
      postedKinds.push(n.kind)
    },
    now: () => now,
  })
  const res = await runner()
  assert.equal(res.error, null)
  assert.ok(postedKinds.includes('nwc-restore'))
})

test('metaShape preserves all NWC auto-renewal fields written by bridge.py', async () => {
  const { metaShape } = await import('../startos/fileModels/tunnelsatsMeta')
  const raw = {
    publicKey: 'wg-pub-1',
    expiresAt: '2026-10-05T12:00:00Z',
    expirySource: 'api',
    lastDuration: 3,
    lastAmountSats: 12000,
    nwcConnected: true,
    nwcRelayHost: 'relay.getalby.com',
    nwcRouteViaTor: true,
    nwcAutoRenewDuration: '3m',
    nwcAutoRenewState: {
      periodExpiry: '2026-10-05T12:00:00Z',
      attempts: 1,
      lastAttemptAt: '2026-09-28T12:00:00Z',
      nextAttemptAt: '2026-09-28T13:00:00Z',
      lastError: null,
      lastErrorCode: null,
      fallbackTaskRaised: false,
      budgetWarning: false,
      restoreReconnectNeeded: false,
      lastPaidHash: 'a'.repeat(64),
      lastPaidAt: '2026-09-28T12:00:00Z',
      lastPaidDuration: 3,
      lastPaidAmountSats: 12000,
      lastPaidNewExpiry: '2027-01-05T12:00:00Z',
    },
    pendingRenewal: {
      paymentHash: 'b'.repeat(64),
      renewalId: 'ren-1',
      oldExpiry: '2026-10-05T12:00:00Z',
      newExpiry: '2027-01-05T12:00:00Z',
      createdAt: '2026-09-28T12:00:00Z',
      duration: 3,
      amountSats: 12000,
      paidViaNwc: true,
      raisePayTask: true,
    },
  }
  const parsed = metaShape.parse(raw)
  assert.equal(parsed.lastDuration, 3)
  assert.equal(parsed.lastAmountSats, 12000)
  assert.equal(parsed.nwcConnected, true)
  assert.equal(parsed.nwcRelayHost, 'relay.getalby.com')
  assert.equal(parsed.nwcRouteViaTor, true)
  assert.equal(parsed.nwcAutoRenewDuration, '3m')
  assert.equal(parsed.nwcAutoRenewState?.lastPaidDuration, 3)
  assert.equal(parsed.nwcAutoRenewState?.lastPaidAmountSats, 12000)
  assert.equal(parsed.pendingRenewal?.paidViaNwc, true)
  assert.equal(parsed.pendingRenewal?.raisePayTask, true)
})
