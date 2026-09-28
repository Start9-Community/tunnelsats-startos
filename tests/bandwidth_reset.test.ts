import test from 'node:test'
import assert from 'node:assert/strict'
import { createServer, Server } from 'node:http'
import {
  ApiHttpError,
  fetchBandwidthResetStatus,
  requestBandwidthReset,
  type BandwidthResetOrder,
  type ResetState,
} from '../startos/apiClient'
import {
  ResetFailedError,
  resetAvailability,
  reusablePendingReset,
  runBandwidthReset,
  type PendingReset,
  type ResetOps,
} from '../startos/bandwidthReset'
import { NothingToResumeError, payTaskReplayId } from '../startos/settlement'

const HASH = 'b'.repeat(64)
const INVOICE =
  'lnbc12340n1pzry9x8pp5hwamhwamhwamhwamhwamhwamhwamhwamhwamhwamhwamhwamhwaspppppppppppppppppppppppppppppppppppppppppppppppppppppppppppppppppppppppppppppppppppppppppppppppppppppppqhevkmq'
const EXPIRES = '2026-10-01T10:00:00.000Z'

const GOOD = {
  invoice: INVOICE,
  paymentHash: HASH,
  resetId: 'reset-uuid-1',
  amountSats: 1234,
  amountUsd: '1.00',
  expiresAt: EXPIRES,
  currentUsagePercent: '75.3',
  resetsThisMonth: 1,
  maxResetsPerMonth: 2,
}

/** One scripted answer for the next bandwidth-reset request. */
let reply: { status: number; body: unknown } = { status: 200, body: GOOD }
let lastRequest: { method?: string; path: string; body: unknown } | null = null

function startMock(): Promise<{ server: Server; url: string }> {
  return new Promise((resolve) => {
    const server = createServer((req, res) => {
      let body = ''
      req.on('data', (c) => (body += c))
      req.on('end', () => {
        lastRequest = {
          method: req.method,
          path: new URL(req.url || '/', 'http://x').pathname,
          body: body ? JSON.parse(body) : null,
        }
        res.setHeader('Content-Type', 'application/json')
        res.writeHead(reply.status)
        res.end(JSON.stringify(reply.body))
      })
    })
    server.listen(0, '127.0.0.1', () => {
      const addr = server.address()
      const port = typeof addr === 'object' && addr ? addr.port : 0
      resolve({ server, url: `http://127.0.0.1:${port}` })
    })
  })
}

async function withMock<T>(fn: (url: string) => Promise<T>): Promise<T> {
  const { server, url } = await startMock()
  try {
    return await fn(url)
  } finally {
    server.close()
  }
}

const PARAMS = { wgPublicKey: 'pubkey=', serverId: 'eu-de' }

test('requestBandwidthReset posts the key and server and returns the validated order', async () => {
  reply = { status: 200, body: GOOD }
  const order = await withMock((url) => requestBandwidthReset(PARAMS, url))
  assert.deepEqual(lastRequest, {
    method: 'POST',
    path: '/api/public/v1/subscription/bandwidth-reset',
    body: PARAMS,
  })
  assert.deepEqual(order, {
    invoice: INVOICE,
    paymentHash: HASH,
    resetId: 'reset-uuid-1',
    amountSats: 1234,
    expiresAt: EXPIRES,
    currentUsagePercent: 75.3,
    resetsThisMonth: 1,
    maxResetsPerMonth: 2,
  })
})

test('requestBandwidthReset tolerates missing display-only fields', async () => {
  const { currentUsagePercent, resetsThisMonth, maxResetsPerMonth, ...rest } =
    GOOD
  void currentUsagePercent
  void resetsThisMonth
  void maxResetsPerMonth
  reply = { status: 200, body: rest }
  const order = await withMock((url) => requestBandwidthReset(PARAMS, url))
  assert.equal(order.currentUsagePercent, undefined)
  assert.equal(order.resetsThisMonth, undefined)
  assert.equal(order.maxResetsPerMonth, undefined)
})

// Each of these is kept on the device and handed to the Lightning node, or
// decides whether an invoice may be shown again: never trust them unchecked.
const MALFORMED: [string, Record<string, unknown>][] = [
  ['a non-BOLT11 invoice', { invoice: 'not-an-invoice' }],
  [
    'an invoice without a BOLT11 separator',
    { invoice: `lnbc${'q'.repeat(180)}` },
  ],
  [
    'an invoice with a bad Bech32 checksum',
    { invoice: `${INVOICE.slice(0, -1)}z` },
  ],
  ['an invoice with a newline', { invoice: `${INVOICE}\nx` }],
  ['a missing invoice', { invoice: undefined }],
  [
    'an invoice whose payment hash does not match paymentHash',
    { paymentHash: 'a'.repeat(64) },
  ],
  ['an invoice whose amount does not match amountSats', { amountSats: 9999 }],
  ['a short payment hash', { paymentHash: 'abc' }],
  ['a non-hex payment hash', { paymentHash: 'z'.repeat(64) }],
  ['an empty reset ID', { resetId: '' }],
  ['a numeric reset ID', { resetId: 7 }],
  ['a zero amount', { amountSats: 0 }],
  ['a fractional amount', { amountSats: 1.5 }],
  ['an amount as text', { amountSats: '1234' }],
  // Without its expiry the invoice cannot be safely shown again, and only a
  // backend that reports typed reset status returns it.
  ['a missing expiry', { expiresAt: undefined }],
  ['an unparseable expiry', { expiresAt: 'soon' }],
  ['an expiry without a time zone', { expiresAt: '2026-10-01T10:00:00' }],
]

for (const [name, patch] of MALFORMED) {
  test(`requestBandwidthReset rejects ${name}`, async () => {
    reply = { status: 200, body: { ...GOOD, ...patch } }
    await assert.rejects(
      withMock((url) => requestBandwidthReset(PARAMS, url)),
      /bandwidth reset/i,
    )
  })
}

for (const status of [400, 404, 429, 503]) {
  test(`requestBandwidthReset surfaces HTTP ${status} as ApiHttpError`, async () => {
    reply = {
      status,
      // The backend's errorResponse shape.
      body: { error: 'INVALID_INPUT', message: `backend says ${status}` },
    }
    await assert.rejects(
      withMock((url) => requestBandwidthReset(PARAMS, url)),
      (e: unknown) =>
        e instanceof ApiHttpError &&
        e.status === status &&
        e.apiMessage === `backend says ${status}` &&
        e.message.startsWith(`HTTP ${status} from `),
    )
  })
}

// --- fetchBandwidthResetStatus ---------------------------------------------

const TYPED = (status: string) => ({
  type: 'bandwidth_reset',
  paymentHash: HASH,
  status,
  message: 'x',
})

for (const status of ['unpaid', 'paid', 'failed', 'expired'] as const) {
  test(`fetchBandwidthResetStatus reads a typed '${status}'`, async () => {
    reply = { status: 200, body: TYPED(status) }
    const state = await withMock((url) => fetchBandwidthResetStatus(HASH, url))
    assert.equal(state, status)
    assert.deepEqual(lastRequest, {
      method: 'GET',
      path: `/api/public/v1/subscription/${HASH}`,
      body: null,
    })
  })
}

test('fetchBandwidthResetStatus reads 202 as processing', async () => {
  reply = { status: 202, body: TYPED('processing') }
  assert.equal(
    await withMock((url) => fetchBandwidthResetStatus(HASH, url)),
    'processing',
  )
})

test('fetchBandwidthResetStatus reads a typed 202 without status as processing', async () => {
  reply = {
    status: 202,
    body: { type: 'bandwidth_reset', paymentHash: HASH, message: 'wait' },
  }
  assert.equal(
    await withMock((url) => fetchBandwidthResetStatus(HASH, url)),
    'processing',
  )
})

test('fetchBandwidthResetStatus reads 404 as unknown', async () => {
  reply = { status: 404, body: { error: 'NOT_FOUND', message: 'nope' } }
  assert.equal(
    await withMock((url) => fetchBandwidthResetStatus(HASH, url)),
    'unknown',
  )
})

test('fetchBandwidthResetStatus fails closed on an untyped paid (order fallback)', async () => {
  reply = { status: 200, body: { paymentHash: HASH, status: 'paid' } }
  await assert.rejects(
    withMock((url) => fetchBandwidthResetStatus(HASH, url)),
    /does not confirm bandwidth resets/,
  )
})

test('fetchBandwidthResetStatus rejects an unknown status', async () => {
  reply = { status: 200, body: TYPED('refunded') }
  await assert.rejects(
    withMock((url) => fetchBandwidthResetStatus(HASH, url)),
    /unknown bandwidth reset status/,
  )
})

test('fetchBandwidthResetStatus surfaces other HTTP errors', async () => {
  reply = { status: 503, body: { error: 'X', message: 'maintenance' } }
  await assert.rejects(
    withMock((url) => fetchBandwidthResetStatus(HASH, url)),
    (e: unknown) => e instanceof ApiHttpError && e.status === 503,
  )
})

// --- availability and reuse -------------------------------------------------

const KEY = 'key-A='
const NOW = new Date('2026-10-01T09:00:00.000Z')
const inMs = (ms: number) => new Date(NOW.getTime() + ms).toISOString()

const PENDING: PendingReset = {
  paymentHash: 'c'.repeat(64),
  invoice: 'lnbcpending0000000000',
  expiresAt: inMs(10 * 60_000),
  publicKey: KEY,
  targetNode: 'cln',
}

test('reusablePendingReset keeps a payable invoice for the same key', () => {
  assert.equal(reusablePendingReset(PENDING, KEY, NOW), PENDING)
})

test('reusablePendingReset keeps a payable invoice until its expiry instant', () => {
  const finalSecond = { ...PENDING, expiresAt: inMs(1_000) }
  assert.equal(reusablePendingReset(finalSecond, KEY, NOW), finalSecond)
})

const NOT_REUSABLE: [string, PendingReset | null | undefined][] = [
  ['nothing pending', null],
  ['another key', { ...PENDING, publicKey: 'key-B=' }],
  ['an invoice at its expiry instant', { ...PENDING, expiresAt: inMs(0) }],
  ['an expired invoice', { ...PENDING, expiresAt: inMs(-1) }],
  ['no expiry', { ...PENDING, expiresAt: undefined }],
  ['an unparseable expiry', { ...PENDING, expiresAt: 'soon' }],
]
for (const [name, pending] of NOT_REUSABLE) {
  test(`reusablePendingReset does not reuse ${name}`, () => {
    assert.equal(reusablePendingReset(pending, KEY, NOW), null)
  })
}

test('resetAvailability withholds the action without a configured key', () => {
  assert.deepEqual(resetAvailability(null), {
    available: false,
    reason: 'no-config',
  })
})

test('resetAvailability offers the action when a key is configured', () => {
  assert.deepEqual(resetAvailability(KEY), {
    available: true,
  })
})

// --- runBandwidthReset ------------------------------------------------------

const ORDER: BandwidthResetOrder = {
  invoice: INVOICE,
  paymentHash: HASH,
  resetId: 'reset-uuid-1',
  amountSats: 1234,
  expiresAt: inMs(30 * 60_000),
}

/** Fake StartOS/API state; the decision logic under test is the real one. */
function fakeOps(opts: {
  pending?: PendingReset | null
  status?: ResetState
  readError?: Error
}) {
  const calls: string[] = []
  const raised: object[] = []
  const recorded: object[] = []
  const state = {
    pending: opts.pending ?? null,
    payTasksToClear: [] as string[],
  }
  let requests = 0
  const ops: ResetOps = {
    now: () => NOW,
    targetNode: 'lnd',
    readCurrent: async () => {
      calls.push('read')
      if (opts.readError) throw opts.readError
      return { ...state }
    },
    fetchStatus: async (hash) => {
      calls.push(`status:${hash.slice(0, 4)}`)
      return opts.status ?? 'unpaid'
    },
    requestReset: async () => {
      calls.push('request')
      requests += 1
      // Let a concurrent run interleave here if the queue allowed it.
      await new Promise((r) => setTimeout(r, 5))
      return ORDER
    },
    record: async (order, patch) => {
      calls.push('record')
      recorded.push({ hash: order.paymentHash, ...patch })
      state.pending = {
        paymentHash: order.paymentHash,
        invoice: order.invoice,
        expiresAt: order.expiresAt,
        publicKey: KEY,
        targetNode: 'lnd',
      }
      if (patch.payTasksToClear) state.payTasksToClear = patch.payTasksToClear
    },
    raiseTask: async (task) => {
      calls.push('raise')
      raised.push(task)
    },
  }
  return { ops, calls, raised, recorded, requests: () => requests }
}

test('runBandwidthReset requests, records, then raises a new reset', async () => {
  const f = fakeOps({})
  const result = await runBandwidthReset(KEY, f.ops)
  assert.deepEqual(result, { kind: 'requested', order: ORDER })
  assert.deepEqual(f.calls, ['read', 'request', 'read', 'record', 'raise'])
  assert.deepEqual(f.recorded, [{ hash: HASH }])
  assert.deepEqual(f.raised, [
    { invoice: INVOICE, paymentHash: HASH, targetNode: 'lnd' },
  ])
})

test('runBandwidthReset shows an unpaid pending invoice again instead of requesting', async () => {
  const f = fakeOps({ pending: PENDING, status: 'unpaid' })
  const result = await runBandwidthReset(KEY, f.ops)
  assert.deepEqual(result, { kind: 'reused', pending: PENDING })
  assert.equal(f.requests(), 0)
  // Same invoice, hash and node: the task keeps its replay ID.
  assert.deepEqual(f.raised, [
    {
      invoice: PENDING.invoice,
      paymentHash: PENDING.paymentHash,
      targetNode: 'cln',
    },
  ])
})

test('runBandwidthReset reuses an unpaid invoice in its final minute before expiry', async () => {
  const finalMinute = { ...PENDING, expiresAt: inMs(30_000) }
  const f = fakeOps({ pending: finalMinute, status: 'unpaid' })
  const result = await runBandwidthReset(KEY, f.ops)
  assert.deepEqual(result, { kind: 'reused', pending: finalMinute })
  assert.equal(f.requests(), 0)
})

test('runBandwidthReset reuseOnly returns the recorded invoice or paid state but never requests', async () => {
  const reuse = fakeOps({ pending: PENDING, status: 'unpaid' })
  assert.deepEqual(
    await runBandwidthReset(KEY, reuse.ops, { reuseOnly: true }),
    { kind: 'reused', pending: PENDING },
  )
  const paid = fakeOps({ pending: PENDING, status: 'paid' })
  assert.equal(
    (await runBandwidthReset(KEY, paid.ops, { reuseOnly: true })).kind,
    'already-paid',
  )
  for (const f of [
    fakeOps({}),
    fakeOps({ pending: PENDING, status: 'expired' }),
  ]) {
    await assert.rejects(
      runBandwidthReset(KEY, f.ops, { reuseOnly: true }),
      NothingToResumeError,
    )
    assert.equal(f.requests(), 0)
    assert.equal(f.raised.length, 0)
  }
})

for (const status of ['processing', 'paid'] as const) {
  test(`runBandwidthReset neither requests nor raises when the pending reset is ${status}`, async () => {
    const f = fakeOps({ pending: PENDING, status })
    const result = await runBandwidthReset(KEY, f.ops)
    assert.deepEqual(result, {
      kind: 'already-paid',
      paymentHash: PENDING.paymentHash,
    })
    assert.equal(f.requests(), 0)
    assert.deepEqual(f.raised, [])
  })
}

for (const status of ['processing', 'paid'] as const) {
  test(`runBandwidthReset keeps a pending reset that is ${status} even after expiresAt`, async () => {
    const f = fakeOps({
      pending: { ...PENDING, expiresAt: inMs(-1) },
      status,
    })
    const result = await runBandwidthReset(KEY, f.ops)
    assert.deepEqual(result, {
      kind: 'already-paid',
      paymentHash: PENDING.paymentHash,
    })
    assert.equal(f.requests(), 0)
    assert.deepEqual(f.raised, [])
  })
}

test('runBandwidthReset reports a failed reset instead of buying another', async () => {
  const f = fakeOps({ pending: PENDING, status: 'failed' })
  await assert.rejects(
    runBandwidthReset(KEY, f.ops),
    (e: unknown) =>
      e instanceof ResetFailedError && e.message.includes(PENDING.paymentHash),
  )
  assert.equal(f.requests(), 0)
})

for (const status of ['processing', 'paid'] as const) {
  test(`runBandwidthReset keeps a ${status} reset for a previous key until settlement finishes`, async () => {
    const f = fakeOps({
      pending: { ...PENDING, publicKey: 'key-B=' },
      status,
    })
    const result = await runBandwidthReset(KEY, f.ops)
    assert.deepEqual(result, {
      kind: 'already-paid',
      paymentHash: PENDING.paymentHash,
    })
    assert.equal(f.requests(), 0)
    assert.deepEqual(f.raised, [])
  })
}

test('runBandwidthReset reports a failed reset for a previous key instead of overwriting it', async () => {
  const f = fakeOps({
    pending: { ...PENDING, publicKey: 'key-B=' },
    status: 'failed',
  })
  await assert.rejects(
    runBandwidthReset(KEY, f.ops),
    (e: unknown) =>
      e instanceof ResetFailedError && e.message.includes(PENDING.paymentHash),
  )
  assert.equal(f.requests(), 0)
})

test('runBandwidthReset keeps an unexpired unpaid reset for a previous key until it settles or expires', async () => {
  const f = fakeOps({
    pending: { ...PENDING, publicKey: 'key-B=' },
    status: 'unpaid',
  })
  await assert.rejects(
    runBandwidthReset(KEY, f.ops),
    /previous subscription is still pending/,
  )
  assert.equal(f.requests(), 0)
  assert.deepEqual(f.recorded, [])
})

test('runBandwidthReset replaces an expired unpaid reset for a previous key and clears its task', async () => {
  const f = fakeOps({
    pending: { ...PENDING, publicKey: 'key-B=', expiresAt: inMs(-1) },
    status: 'unpaid',
  })
  const result = await runBandwidthReset(KEY, f.ops)
  assert.equal(result.kind, 'requested')
  assert.deepEqual(f.recorded, [
    {
      hash: HASH,
      payTasksToClear: [payTaskReplayId('reset', 'cln', PENDING.paymentHash)],
    },
  ])
})

test('runBandwidthReset replaces a pending reset the API reports expired', async () => {
  const f = fakeOps({ pending: PENDING, status: 'expired' })
  const result = await runBandwidthReset(KEY, f.ops)
  assert.equal(result.kind, 'requested')
  // The replaced invoice's pay task is queued for clearing in the same write.
  assert.deepEqual(f.recorded, [
    {
      hash: HASH,
      payTasksToClear: [payTaskReplayId('reset', 'cln', PENDING.paymentHash)],
    },
  ])
})

test('runBandwidthReset fails closed when the API returns 404 (unknown) for an unexpired invoice', async () => {
  const f = fakeOps({ pending: PENDING, status: 'unknown' })
  await assert.rejects(
    runBandwidthReset(KEY, f.ops),
    /no record of this bandwidth reset/,
  )
  assert.equal(f.requests(), 0)
  assert.deepEqual(f.recorded, [])
})

for (const status of ['unpaid', 'unknown'] as const) {
  test(`runBandwidthReset replaces an expired pending invoice when the API reports ${status}`, async () => {
    const f = fakeOps({
      pending: { ...PENDING, expiresAt: inMs(-1) },
      status,
    })
    const result = await runBandwidthReset(KEY, f.ops)
    assert.equal(result.kind, 'requested')
    assert.ok(f.calls.includes(`status:${PENDING.paymentHash.slice(0, 4)}`))
    assert.equal(f.requests(), 1)
    assert.deepEqual(f.recorded, [
      {
        hash: HASH,
        payTasksToClear: [payTaskReplayId('reset', 'cln', PENDING.paymentHash)],
      },
    ])
  })
}

test('runBandwidthReset fails closed when the pending state cannot be read', async () => {
  const f = fakeOps({ readError: new Error('EIO') })
  await assert.rejects(runBandwidthReset(KEY, f.ops), /EIO/)
  assert.equal(f.requests(), 0)
  assert.deepEqual(f.raised, [])
})

test('runBandwidthReset serializes runs: two at once request one reset', async () => {
  const f = fakeOps({ status: 'unpaid' })
  const [a, b] = await Promise.all([
    runBandwidthReset(KEY, f.ops),
    runBandwidthReset(KEY, f.ops),
  ])
  assert.equal(f.requests(), 1)
  assert.equal(a.kind, 'requested')
  assert.equal(b.kind, 'reused')
})
