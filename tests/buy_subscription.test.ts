import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, rmSync } from 'node:fs'
import { createServer } from 'node:http'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { FileHelper } from '@start9labs/start-sdk'
import { testMetaLock, useTestMetaLock } from './metaLockSupport'
import {
  fetchOrderPaymentStatus,
  type OrderPaymentState,
} from '../startos/apiClient'
import {
  INVOICE_TTL_MS,
  MAX_PREVIOUS_PENDING_ORDERS,
  PendingPaymentConflictError,
  runPurchase,
  startPurchase,
  type PendingOrderRecord,
  type PurchaseOps,
} from '../startos/actions/buySubscription'
import {
  metaShape,
  pendingOrderShape,
} from '../startos/fileModels/tunnelsatsMeta'
import { generateWireguardKeypair } from '../startos/keygen'
import { payTaskReplayId } from '../startos/settlement'

const NOW = new Date('2026-10-01T12:00:00.000Z')
useTestMetaLock()
const inMs = (ms: number) => new Date(NOW.getTime() + ms).toISOString()

const HASH_1 = '1'.repeat(64)
const HASH_2 = '2'.repeat(64)
const INVOICE_1 =
  'lnbc250u1p0orderinvoice11111111111111111111111111111111111111111'
const INVOICE_2 =
  'lnbc500u1p0orderinvoice22222222222222222222222222222222222222222'

function makePendingOrder(
  overrides: Partial<PendingOrderRecord> = {},
): PendingOrderRecord {
  const kp = generateWireguardKeypair()
  return {
    paymentHash: HASH_1,
    orderId: 'ord-1',
    privateKey: kp.privateKey,
    publicKey: kp.publicKey,
    targetNode: 'lnd',
    serverId: 'eu-de',
    createdAt: inMs(-5 * 60_000),
    duration: 3,
    invoice: INVOICE_1,
    amountSats: 25_000,
    expiresAt: inMs(55 * 60_000),
    ...overrides,
  }
}

test('Buy Subscription action (keepPayable unset/false) refuses to replace a paid pendingOrder', async () => {
  const paidByMarker = makePendingOrder({ paymentReceivedFor: HASH_1 })
  const paidByError = makePendingOrder({
    paymentReceivedFor: undefined,
    lastError: 'The payment was received, but claiming the config timed out.',
  })

  for (const pending of [paidByMarker, paidByError]) {
    for (const keepPayable of [undefined, false]) {
      let createCalls = 0
      let recordCalls = 0
      const ops: PurchaseOps = {
        now: () => NOW,
        lockMeta: testMetaLock,
        readCurrent: async () => ({ pending }),
        generateKeypair: () => generateWireguardKeypair(),
        createOrder: async () => {
          createCalls += 1
          throw new Error('must not create order')
        },
        record: async () => {
          recordCalls += 1
        },
        raiseTask: async () => undefined,
      }

      // Refuses both when selection matches and when selection differs.
      for (const input of [
        {
          targetNode: 'lnd' as const,
          serverRegion: 'eu-de',
          duration: 3,
          keepPayable,
        },
        {
          targetNode: 'cln' as const,
          serverRegion: 'us-east',
          duration: 12,
          keepPayable,
        },
      ]) {
        await assert.rejects(
          runPurchase(input, ops),
          (err: unknown) =>
            err instanceof PendingPaymentConflictError &&
            /already been paid/.test(err.message),
        )
      }
      assert.equal(createCalls, 0)
      assert.equal(recordCalls, 0)
    }
  }
})

test('runPurchase checks fetchPaymentState before replacing an unpaid pendingOrder and refuses when paid or processing', async () => {
  const existing = makePendingOrder()
  const queriedHashes: string[] = []

  for (const liveState of ['paid', 'processing'] as OrderPaymentState[]) {
    let createCalls = 0
    let recordCalls = 0
    const ops: PurchaseOps = {
      now: () => NOW,
      lockMeta: testMetaLock,
      readCurrent: async () => ({ pending: existing }),
      fetchPaymentState: async (hash) => {
        queriedHashes.push(hash)
        return liveState
      },
      generateKeypair: () => generateWireguardKeypair(),
      createOrder: async () => {
        createCalls += 1
        throw new Error(
          'must not create order when live state is paid/processing',
        )
      },
      record: async () => {
        recordCalls += 1
      },
      raiseTask: async () => undefined,
    }

    await assert.rejects(
      runPurchase(
        { targetNode: 'cln', serverRegion: 'us-east', duration: 6 },
        ops,
      ),
      (err: unknown) =>
        err instanceof PendingPaymentConflictError &&
        /already been paid and is being provisioned/.test(err.message),
    )
    assert.equal(createCalls, 0)
    assert.equal(recordCalls, 0)
  }
  assert.deepEqual(queriedHashes, [HASH_1, HASH_1])

  // When fetchPaymentState reports 'unpaid' or 'unknown', replacement proceeds.
  for (const liveState of ['unpaid', 'unknown'] as OrderPaymentState[]) {
    let recorded: PendingOrderRecord | null = null
    const ops: PurchaseOps = {
      now: () => NOW,
      lockMeta: testMetaLock,
      readCurrent: async () => ({ pending: existing }),
      fetchPaymentState: async () => liveState,
      generateKeypair: () => generateWireguardKeypair(),
      createOrder: async () => ({
        invoice: INVOICE_2,
        paymentHash: HASH_2,
        amountSats: 50_000,
        orderId: 'ord-2',
      }),
      record: async (entry) => {
        recorded = entry
      },
      raiseTask: async () => undefined,
    }

    const res = await runPurchase(
      { targetNode: 'cln', serverRegion: 'us-east', duration: 6 },
      ops,
    )
    assert.equal(res.kind, 'created')
    assert.equal(recorded?.paymentHash, HASH_2)
  }
})

test('startPurchase / runPurchase retains unexpired replaced pendingOrder in previousPendingOrders, deduplicates, caps at 5, and prunes expired entries', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'buy-prev-orders-'))
  try {
    const metaFile = FileHelper.json(join(dir, 'meta.json'), metaShape)
    const expiredPrev = makePendingOrder({
      paymentHash: 'e'.repeat(64),
      orderId: 'ord-expired',
      createdAt: inMs(-120 * 60_000),
      expiresAt: inMs(-60 * 60_000),
    })
    const activeOrder1 = makePendingOrder({
      paymentHash: HASH_1,
      orderId: 'ord-1',
      expiresAt: inMs(45 * 60_000),
    })

    await metaFile.write({} as never, {
      pendingOrder: activeOrder1,
      previousPendingOrders: [expiredPrev],
    })

    const kp2 = generateWireguardKeypair()
    const res = await startPurchase(
      {} as never,
      { targetNode: 'cln', serverRegion: 'us-east', duration: 6 },
      {
        now: () => NOW,
        lockMeta: testMetaLock,
        readCurrent: async () => {
          const cur = await metaFile.read().once()
          return (
            cur && {
              pending: cur.pendingOrder,
              previousPendingOrders: cur.previousPendingOrders,
              payTasksToClear: cur.payTasksToClear,
            }
          )
        },
        fetchPaymentState: async () => 'unpaid',
        generateKeypair: () => kp2,
        createOrder: async () => ({
          invoice: INVOICE_2,
          paymentHash: HASH_2,
          amountSats: 50_000,
          orderId: 'ord-2',
        }),
        record: (entry, patch) =>
          metaFile.merge({} as never, {
            pendingOrder: {
              ...entry,
              paymentReceivedFor: undefined,
              lastError: undefined,
              nextAttemptAt: undefined,
            },
            ...patch,
          }),
        raiseTask: async () => undefined,
      },
    )

    assert.equal(res.kind, 'created')
    const saved = await metaFile.read().once()
    assert.equal(saved?.pendingOrder?.paymentHash, HASH_2)
    assert.equal(saved?.pendingOrder?.privateKey, kp2.privateKey)
    assert.equal(saved?.previousPendingOrders?.length, 1)
    assert.equal(saved?.previousPendingOrders?.[0]?.paymentHash, HASH_1)
    assert.equal(
      saved?.previousPendingOrders?.[0]?.privateKey,
      activeOrder1.privateKey,
    )
    assert.deepEqual(saved?.payTasksToClear, [
      payTaskReplayId('order', 'lnd', HASH_1),
    ])

    // Replace 5 more times so 6 total unexpired orders have been replaced:
    // only the 5 most recent are kept, and pendingOrderShape validates each.
    for (let i = 3; i <= 7; i++) {
      const kp = generateWireguardKeypair()
      const nextHash = String(i).repeat(64)
      await startPurchase(
        {} as never,
        {
          targetNode: 'lnd',
          serverRegion: `eu-${i}`,
          duration: 1,
        },
        {
          now: () => NOW,
          lockMeta: testMetaLock,
          readCurrent: async () => {
            const cur = await metaFile.read().once()
            return (
              cur && {
                pending: cur.pendingOrder,
                previousPendingOrders: cur.previousPendingOrders,
                payTasksToClear: cur.payTasksToClear,
              }
            )
          },
          fetchPaymentState: async () => 'unpaid',
          generateKeypair: () => kp,
          createOrder: async () => ({
            invoice: INVOICE_1,
            paymentHash: nextHash,
            amountSats: 10_000,
            orderId: `ord-${i}`,
          }),
          record: (entry, patch) =>
            metaFile.merge({} as never, {
              pendingOrder: {
                ...entry,
                paymentReceivedFor: undefined,
                lastError: undefined,
                nextAttemptAt: undefined,
              },
              ...patch,
            }),
          raiseTask: async () => undefined,
        },
      )
    }

    const capped = await metaFile.read().once()
    assert.equal(
      capped?.previousPendingOrders?.length,
      MAX_PREVIOUS_PENDING_ORDERS,
    )
    assert.deepEqual(
      capped?.previousPendingOrders?.map((o) => o.paymentHash),
      [HASH_2, '3'.repeat(64), '4'.repeat(64), '5'.repeat(64), '6'.repeat(64)],
    )
    for (const item of capped?.previousPendingOrders ?? []) {
      assert.ok(pendingOrderShape.parse(item).privateKey)
    }
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('fetchOrderPaymentStatus maps 200 paid/unpaid/pending, 202 processing, and 404 unknown', async () => {
  const server = createServer((req, res) => {
    const hash = (req.url ?? '').split('/').pop() ?? ''
    res.setHeader('Content-Type', 'application/json')
    if (hash === 'paid') {
      res.writeHead(200)
      res.end(JSON.stringify({ status: 'paid' }))
    } else if (hash === 'processing-202') {
      res.writeHead(202)
      res.end(JSON.stringify({ status: 'unpaid' }))
    } else if (hash === 'processing-200') {
      res.writeHead(200)
      res.end(JSON.stringify({ status: 'processing' }))
    } else if (hash === 'unpaid') {
      res.writeHead(200)
      res.end(JSON.stringify({ status: 'unpaid' }))
    } else if (hash === 'pending') {
      res.writeHead(200)
      res.end(JSON.stringify({ status: 'pending' }))
    } else if (hash === 'mystery') {
      res.writeHead(200)
      res.end(JSON.stringify({ status: 'weird_state' }))
    } else {
      res.writeHead(404)
      res.end(JSON.stringify({ error: 'NOT_FOUND' }))
    }
  })

  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
  const port = (server.address() as { port: number }).port
  const baseUrl = `http://127.0.0.1:${port}`
  try {
    assert.equal(await fetchOrderPaymentStatus('paid', baseUrl), 'paid')
    assert.equal(
      await fetchOrderPaymentStatus('processing-202', baseUrl),
      'processing',
    )
    assert.equal(
      await fetchOrderPaymentStatus('processing-200', baseUrl),
      'processing',
    )
    assert.equal(await fetchOrderPaymentStatus('unpaid', baseUrl), 'unpaid')
    assert.equal(await fetchOrderPaymentStatus('pending', baseUrl), 'unpaid')
    assert.equal(await fetchOrderPaymentStatus('missing', baseUrl), 'unknown')
    await assert.rejects(
      fetchOrderPaymentStatus('mystery', baseUrl),
      /unknown payment status/,
    )
  } finally {
    server.close()
  }
})
