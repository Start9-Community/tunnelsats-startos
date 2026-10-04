import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { FileHelper } from '@start9labs/start-sdk'
import { testMetaLock, useTestMetaLock } from './metaLockSupport'
import {
  PendingPaymentConflictError,
  reusablePendingRenewal,
  runRenewal,
  startRenewal,
  type PendingRenewalRecord,
  type RenewalOps,
} from '../startos/actions/renewSubscription'
import { metaShape, tunnelsatsMeta } from '../startos/fileModels/tunnelsatsMeta'
import { derivePublicKey, generateWireguardKeypair } from '../startos/keygen'

const NOW = new Date('2026-10-01T12:00:00.000Z')
useTestMetaLock()
const inMs = (ms: number) => new Date(NOW.getTime() + ms).toISOString()

const RENEW_HASH_1 = '3'.repeat(64)
const RENEW_HASH_2 = '4'.repeat(64)
const RENEW_INVOICE =
  'lnbc500u1p0renewinvoice000000000000000000000000000000000000000000'

test('creating a manual renewal does not change the last paid plan used by NWC Match Last Purchase', async () => {
  const kp = generateWireguardKeypair()
  const originalMerge = tunnelsatsMeta.merge
  let recorded: any
  tunnelsatsMeta.merge = (async (_effects: unknown, patch: unknown) => {
    recorded = patch
  }) as any
  try {
    await startRenewal(
      {} as never,
      { duration: 12 },
      {
        now: () => NOW,
        lockMeta: testMetaLock,
        readConfig: async () => ({
          enabled: true,
          'target-node': 'lnd',
          'tunnelsats-conf': `[Interface]\nPrivateKey = ${kp.privateKey}\n`,
        }),
        readServerMeta: async () => ({ serverDomain: 'eu-de' }),
        readCurrent: async () => null,
        requestRenewal: async () => ({
          paymentHash: RENEW_HASH_2,
          invoice: RENEW_INVOICE,
          renewalId: 'renewal-12',
          oldExpiry: inMs(5 * 24 * 60 * 60_000),
          newExpiry: inMs(370 * 24 * 60 * 60_000),
          amountSats: 45_000,
        }),
        raiseTask: async () => undefined,
      },
    )
    assert.equal(recorded.pendingRenewal.duration, 12)
    assert.equal(recorded.pendingRenewal.amountSats, 45_000)
    assert.ok(!Object.hasOwn(recorded, 'lastDuration'))
    assert.ok(!Object.hasOwn(recorded, 'lastAmountSats'))
  } finally {
    tunnelsatsMeta.merge = originalMerge
  }
})

test('runRenewal refuses to replace an unexpired pendingRenewal with nwcAttempted: true or nwcPayInFlightUntil in the future', async () => {
  const kp = generateWireguardKeypair()
  const pub = derivePublicKey(kp.privateKey)
  const conf = `[Interface]\nPrivateKey = ${kp.privateKey}\nAddress = 10.9.0.2/32\n# Server: de2.tunnelsats.com\n# Port Forwarding: 24556\n\n[Peer]\nPublicKey = ${kp.publicKey}\nEndpoint = de2.tunnelsats.com:51820\nAllowedIPs = 0.0.0.0/0\n`

  const basePending: PendingRenewalRecord = {
    paymentHash: RENEW_HASH_1,
    renewalId: 'ren-1',
    oldExpiry: '2026-10-15T00:00:00.000Z',
    newExpiry: '2026-11-15T00:00:00.000Z',
    createdAt: inMs(-5 * 60_000),
    duration: 1,
    invoice: RENEW_INVOICE,
    expiresAt: inMs(55 * 60_000),
    publicKey: pub,
    targetNode: 'lnd',
  }

  for (const pending of [
    { ...basePending, nwcAttempted: true },
    {
      ...basePending,
      expiresAt: inMs(-5 * 60_000),
      nwcPayInFlightUntil: inMs(60_000),
    },
  ]) {
    let requestCalls = 0
    const ops: RenewalOps = {
      now: () => NOW,
      lockMeta: testMetaLock,
      readConfig: async () => ({
        enabled: true,
        'target-node': 'lnd',
        'tunnelsats-conf': conf,
      }),
      readServerMeta: async () => ({
        publicKey: pub,
        serverDomain: 'de2.tunnelsats.com',
      }),
      readCurrent: async () => ({ pending }),
      requestRenewal: async () => {
        requestCalls += 1
        throw new Error(
          'must not request renewal while NWC payment is in flight',
        )
      },
      record: async () => undefined,
      raiseTask: async () => undefined,
    }

    assert.equal(
      reusablePendingRenewal(pending, pub, { duration: 1 }, 'lnd', NOW),
      null,
    )

    for (const input of [
      { duration: 1 },
      { duration: 6 },
      { duration: 1, keepPayable: true },
    ]) {
      await assert.rejects(
        runRenewal(input, ops),
        (err: unknown) =>
          err instanceof PendingPaymentConflictError &&
          /automatic NWC renewal payment is already in progress/.test(
            err.message,
          ),
      )
    }
    assert.equal(requestCalls, 0)
  }
})

test('startRenewal clears nwcAttempted and nwcPayInFlightUntil when replacing an expired pendingRenewal', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'renew-nwc-clear-'))
  try {
    const kp = generateWireguardKeypair()
    const pub = derivePublicKey(kp.privateKey)
    const conf = `[Interface]\nPrivateKey = ${kp.privateKey}\nAddress = 10.9.0.2/32\n# Server: de2.tunnelsats.com\n# Port Forwarding: 24556\n\n[Peer]\nPublicKey = ${kp.publicKey}\nEndpoint = de2.tunnelsats.com:51820\nAllowedIPs = 0.0.0.0/0\n`
    const metaFile = FileHelper.json(join(dir, 'meta.json'), metaShape)

    await metaFile.write({} as never, {
      pendingRenewal: {
        paymentHash: RENEW_HASH_1,
        renewalId: 'ren-expired',
        oldExpiry: '2026-10-15T00:00:00.000Z',
        newExpiry: '2026-11-15T00:00:00.000Z',
        createdAt: inMs(-120 * 60_000),
        expiresAt: inMs(-60 * 60_000),
        duration: 1,
        invoice: RENEW_INVOICE,
        publicKey: pub,
        targetNode: 'lnd',
        nwcAttempted: true,
        nwcPayInFlightUntil: inMs(-30 * 60_000),
        raisePayTask: true,
      },
    })

    const res = await startRenewal(
      {} as never,
      { duration: 3 },
      {
        now: () => NOW,
        lockMeta: testMetaLock,
        readConfig: async () => ({
          enabled: true,
          'target-node': 'lnd',
          'tunnelsats-conf': conf,
        }),
        readServerMeta: async () => ({
          publicKey: pub,
          serverDomain: 'de2.tunnelsats.com',
        }),
        readCurrent: async () => {
          const cur = await metaFile.read().once()
          return (
            cur && {
              pending: cur.pendingRenewal,
              payTasksToClear: cur.payTasksToClear,
            }
          )
        },
        requestRenewal: async () => ({
          invoice: RENEW_INVOICE,
          paymentHash: RENEW_HASH_2,
          oldExpiry: '2026-10-15T00:00:00.000Z',
          newExpiry: '2027-01-15T00:00:00.000Z',
          renewalId: 'ren-new',
        }),
        record: (entry, patch) =>
          metaFile.merge({} as never, {
            pendingRenewal: {
              ...entry,
              paymentReceivedFor: undefined,
              lastError: undefined,
              nextAttemptAt: undefined,
              paidViaNwc: undefined,
              nwcAttempted: undefined,
              nwcPayInFlightUntil: undefined,
              raisePayTask: undefined,
            },
            ...patch,
          }),
        raiseTask: async () => undefined,
      },
    )

    assert.equal(res.kind, 'created')
    const saved = await metaFile.read().once()
    assert.equal(saved?.pendingRenewal?.paymentHash, RENEW_HASH_2)
    assert.equal(saved?.pendingRenewal?.nwcAttempted, undefined)
    assert.equal(saved?.pendingRenewal?.nwcPayInFlightUntil, undefined)
    assert.equal(saved?.pendingRenewal?.paidViaNwc, undefined)
    assert.equal(saved?.pendingRenewal?.raisePayTask, undefined)
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('runRenewal: allows replacing an unexpired renewal once NWC fell back to manual payment (raisePayTask: true)', async () => {
  const kp = generateWireguardKeypair()
  const pub = derivePublicKey(kp.privateKey)
  const conf = `[Interface]\nPrivateKey = ${kp.privateKey}\nAddress = 10.9.0.2/32\n# Server: de2.tunnelsats.com\n# Port Forwarding: 24556\n\n[Peer]\nPublicKey = ${kp.publicKey}\nEndpoint = de2.tunnelsats.com:51820\nAllowedIPs = 0.0.0.0/0\n`
  let recorded: PendingRenewalRecord | null = null
  const res = await runRenewal(
    { duration: 3 },
    {
      now: () => NOW,
      lockMeta: testMetaLock,
      readConfig: async () => ({
        enabled: true,
        'target-node': 'lnd',
        'tunnelsats-conf': conf,
      }),
      readServerMeta: async () => ({
        publicKey: pub,
        serverDomain: 'de2.tunnelsats.com',
      }),
      readCurrent: async () => ({
        pending: {
          paymentHash: RENEW_HASH_1,
          renewalId: 'ren-fallback',
          oldExpiry: '2026-10-15T00:00:00.000Z',
          newExpiry: '2026-11-15T00:00:00.000Z',
          createdAt: inMs(-5 * 60_000),
          expiresAt: inMs(55 * 60_000),
          duration: 1,
          invoice: RENEW_INVOICE,
          publicKey: pub,
          targetNode: 'lnd',
          nwcAttempted: true,
          raisePayTask: true,
        },
      }),
      requestRenewal: async () => ({
        invoice: RENEW_INVOICE,
        paymentHash: RENEW_HASH_2,
        oldExpiry: '2026-10-15T00:00:00.000Z',
        newExpiry: '2027-01-15T00:00:00.000Z',
        renewalId: 'ren-new',
      }),
      record: async (entry) => {
        recorded = entry
      },
      raiseTask: async () => undefined,
    },
  )
  assert.equal(res.kind, 'created')
  assert.equal(recorded?.paymentHash, RENEW_HASH_2)
})
