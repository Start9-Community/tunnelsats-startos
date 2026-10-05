import test from 'node:test'
import assert from 'node:assert/strict'
import { testMetaLock } from './metaLockSupport'
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { FileHelper } from '@start9labs/start-sdk'
import { metaShape } from '../startos/fileModels/tunnelsatsMeta'
import {
  PendingPaymentConflictError,
  payTaskReplayId,
  recordPaymentThenRaiseTask,
  recordThenRaise,
  replacedOrderPatch,
  replacedPayTaskPatch,
  replacedPayTaskId,
  runSettlementTick,
  type ExecResult,
  type SettlementOps,
} from '../startos/settlement'

const ok = (value: unknown): ExecResult => ({
  exitCode: 0,
  stdout: JSON.stringify(value),
  stderr: '',
})

const outcome = (
  result: string,
  message = `${result} message`,
  kind = 'order',
) => ({ kind, result, message, paymentHash: 'a'.repeat(64) })

/** Records every call so tests assert on what the tick really did. */
function fakeOps(
  settle: ExecResult | (() => Promise<ExecResult>),
  opts: {
    ack?: ExecResult
    failClear?: string[]
  } = {},
) {
  const calls = { cleared: [] as string[], acked: [] as string[][] }
  const ops: SettlementOps = {
    settle: typeof settle === 'function' ? settle : async () => settle,
    ack: async (ids) => {
      calls.acked.push(ids)
      return opts.ack ?? ok({ acknowledged: ids })
    },
    clearTask: async (id) => {
      if (opts.failClear?.includes(id)) throw new Error(`no ${id}`)
      calls.cleared.push(id)
    },
  }
  return { ops, calls }
}

const H1 = 'a'.repeat(64)
const H2 = 'b'.repeat(64)

test('payTaskReplayId matches the per-payment IDs bridge.py queues for clearing', () => {
  assert.equal(
    payTaskReplayId('order', 'lnd', H1),
    `tunnelsats-order:lnd:${H1.slice(0, 16)}`,
  )
  assert.equal(
    payTaskReplayId('renewal', 'cln', H2),
    `tunnelsats-renewal:cln:${H2.slice(0, 16)}`,
  )
  assert.notEqual(
    payTaskReplayId('order', 'eclair', H1),
    payTaskReplayId('order', 'eclair', H2),
  )
})

test('replacedPayTaskId names the task of a pending entry a new payment replaces', () => {
  assert.equal(
    replacedPayTaskId('order', { paymentHash: H1, targetNode: 'eclair' }, H2),
    payTaskReplayId('order', 'eclair', H1),
  )
  // Nothing replaced: no entry, the same payment, or no known node.
  assert.equal(replacedPayTaskId('order', null, H2), null)
  assert.equal(replacedPayTaskId('order', undefined, H2), null)
  assert.equal(
    replacedPayTaskId('renewal', { paymentHash: H2, targetNode: 'lnd' }, H2),
    null,
  )
  assert.equal(replacedPayTaskId('renewal', { paymentHash: H1 }, H2), null)
})

test('nothing pending is idle and touches no task', async () => {
  const { ops, calls } = fakeOps(
    ok({ outcomes: [], clearPayTasks: [], busy: false }),
  )
  assert.deepEqual(await runSettlementTick(ops), { state: 'idle' })
  assert.deepEqual(calls, { cleared: [], acked: [] })
})

test('a concurrent tick reports busy', async () => {
  const { ops } = fakeOps(ok({ outcomes: [], clearPayTasks: [], busy: true }))
  assert.deepEqual(await runSettlementTick(ops), { state: 'busy' })
})

test('a waiting payment reports its message', async () => {
  const { ops } = fakeOps(
    ok({
      outcomes: [outcome('waiting', 'Waiting for the invoice to be paid.')],
      clearPayTasks: [],
      busy: false,
    }),
  )
  assert.deepEqual(await runSettlementTick(ops), {
    state: 'waiting',
    message: 'Waiting for the invoice to be paid.',
  })
})

test('a settled payment clears its pay task, then acknowledges it', async () => {
  const { ops, calls } = fakeOps(
    ok({
      outcomes: [outcome('provisioned', 'The new tunnel was configured.')],
      clearPayTasks: ['tunnelsats-order:lnd'],
      busy: false,
    }),
  )
  assert.deepEqual(await runSettlementTick(ops), {
    state: 'settled',
    message: 'The new tunnel was configured.',
  })
  assert.deepEqual(calls.cleared, ['tunnelsats-order:lnd'])
  assert.deepEqual(calls.acked, [['tunnelsats-order:lnd']])
})

test('a bandwidth reset uses its own per-payment replay ID (matches bridge.py)', () => {
  assert.equal(
    payTaskReplayId('reset', 'lnd', H1),
    `tunnelsats-reset:lnd:${H1.slice(0, 16)}`,
  )
})

test('an applied bandwidth reset is reported settled and clears its task', async () => {
  const id = payTaskReplayId('reset', 'lnd', H1)
  const { ops, calls } = fakeOps(
    ok({
      outcomes: [outcome('reset', 'The bandwidth reset was applied.', 'reset')],
      clearPayTasks: [id],
      busy: false,
    }),
  )
  assert.deepEqual(await runSettlementTick(ops), {
    state: 'settled',
    message: 'The bandwidth reset was applied.',
  })
  assert.deepEqual(calls.cleared, [id])
})

test('a failed bandwidth reset surfaces as failed', async () => {
  const { ops } = fakeOps(
    ok({
      outcomes: [outcome('failed', 'Contact TunnelSats support', 'reset')],
      clearPayTasks: [],
      busy: false,
    }),
  )
  assert.deepEqual(await runSettlementTick(ops), {
    state: 'failed',
    error: 'Contact TunnelSats support',
  })
})

test('queued pay tasks from an earlier tick are cleared while idle', async () => {
  // The previous tick settled, then main restarted (config.json changed)
  // before clearTask ran.
  const { ops, calls } = fakeOps(
    ok({
      outcomes: [],
      clearPayTasks: ['tunnelsats-renewal:cln'],
      busy: false,
    }),
  )
  assert.deepEqual(await runSettlementTick(ops), { state: 'idle' })
  assert.deepEqual(calls.cleared, ['tunnelsats-renewal:cln'])
  assert.deepEqual(calls.acked, [['tunnelsats-renewal:cln']])
})

test('a pay task that could not be cleared is not acknowledged', async () => {
  const { ops, calls } = fakeOps(
    ok({
      outcomes: [outcome('renewed', 'The subscription was extended.')],
      clearPayTasks: ['tunnelsats-order:lnd', 'tunnelsats-renewal:lnd'],
      busy: false,
    }),
    { failClear: ['tunnelsats-order:lnd'] },
  )
  assert.deepEqual(await runSettlementTick(ops), {
    state: 'clearing-failed',
    error: 'no tunnelsats-order:lnd',
  })
  assert.deepEqual(calls.acked, [['tunnelsats-renewal:lnd']])
})

test('a failed acknowledgement is reported and retried next tick', async () => {
  const { ops } = fakeOps(
    ok({ outcomes: [], clearPayTasks: ['tunnelsats-order:lnd'], busy: false }),
    { ack: { exitCode: 1, stdout: '', stderr: 'Traceback\nOSError: disk\n' } },
  )
  assert.deepEqual(await runSettlementTick(ops), {
    state: 'clearing-failed',
    error: 'OSError: disk',
  })
})

test('a failed outcome wins over waiting and settled ones', async () => {
  const { ops } = fakeOps(
    ok({
      outcomes: [
        outcome('waiting'),
        outcome('failed', 'The claim has no valid vpnPort', 'renewal'),
      ],
      clearPayTasks: [],
      busy: false,
    }),
  )
  assert.deepEqual(await runSettlementTick(ops), {
    state: 'failed',
    error: 'The claim has no valid vpnPort',
  })
})

test('waiting wins over a settled outcome in the same tick', async () => {
  const { ops } = fakeOps(
    ok({
      outcomes: [outcome('expired'), outcome('waiting', 'w', 'renewal')],
      clearPayTasks: [],
      busy: false,
    }),
  )
  assert.deepEqual(await runSettlementTick(ops), {
    state: 'waiting',
    message: 'w',
  })
})

test('several settled outcomes are all reported', async () => {
  const { ops } = fakeOps(
    ok({
      outcomes: [outcome('provisioned', 'A.'), outcome('superseded', 'B.')],
      clearPayTasks: [],
      busy: false,
    }),
  )
  assert.deepEqual(await runSettlementTick(ops), {
    state: 'settled',
    message: 'A. B.',
  })
})

test('a crashed settle command fails with its last stderr line', async () => {
  const { ops, calls } = fakeOps({
    exitCode: 1,
    stdout: '',
    stderr: 'Traceback (most recent call last):\nPermissionError: meta\n',
  })
  assert.deepEqual(await runSettlementTick(ops), {
    state: 'failed',
    error: 'PermissionError: meta',
  })
  assert.deepEqual(calls, { cleared: [], acked: [] })
})

test('an exec that throws fails closed', async () => {
  const { ops } = fakeOps(async () => {
    throw new Error('subcontainer gone')
  })
  assert.deepEqual(await runSettlementTick(ops), {
    state: 'failed',
    error: 'subcontainer gone',
  })
})

for (const [name, stdout] of [
  ['not JSON', 'Traceback'],
  ['missing fields', '{"outcomes": []}'],
  ['non-string replay IDs', '{"outcomes":[],"clearPayTasks":[1],"busy":false}'],
  [
    'an unknown result',
    JSON.stringify({
      outcomes: [outcome('done')],
      clearPayTasks: [],
      busy: false,
    }),
  ],
] as const) {
  test(`unparsable settle output (${name}) fails closed and clears nothing`, async () => {
    const { ops, calls } = fakeOps({ exitCode: 0, stdout, stderr: '' })
    const status = await runSettlementTick(ops)
    assert.equal(status.state, 'failed')
    assert.deepEqual(calls, { cleared: [], acked: [] })
  })
}

const QUEUED = 'tunnelsats-order:lnd:' + 'd'.repeat(16)

test('replacedPayTaskPatch: queues the replaced payment task after those already queued', () => {
  const previous = { paymentHash: 'b'.repeat(64), targetNode: 'cln' }
  assert.deepEqual(
    replacedPayTaskPatch('renewal', previous, [QUEUED], 'c'.repeat(64)),
    {
      payTasksToClear: [
        QUEUED,
        payTaskReplayId('renewal', 'cln', 'b'.repeat(64)),
      ],
    },
  )
})

test('replacedPayTaskPatch: never queues an ID twice', () => {
  const previous = { paymentHash: 'b'.repeat(64), targetNode: 'cln' }
  const id = payTaskReplayId('renewal', 'cln', 'b'.repeat(64))
  assert.deepEqual(
    replacedPayTaskPatch('renewal', previous, [id], 'c'.repeat(64)),
    { payTasksToClear: [id] },
  )
})

test('replacedPayTaskPatch: adds no key when nothing is replaced', () => {
  // The queue already on disk is kept as is; merge() deletes keys set to
  // undefined, so the patch must omit the key entirely.
  for (const previous of [
    null,
    undefined,
    {},
    { paymentHash: 'c'.repeat(64), targetNode: 'lnd' },
    { paymentHash: 'b'.repeat(64) },
    { paymentHash: 'b'.repeat(64), targetNode: 'bogus' },
  ]) {
    const patch = replacedPayTaskPatch(
      'order',
      previous,
      [QUEUED],
      'c'.repeat(64),
    )
    assert.deepEqual(patch, {})
    assert.equal('payTasksToClear' in patch, false)
  }
})

test('replacedPayTaskPatch: the real metadata merge keeps tasks already queued', async () => {
  // FileHelper.merge replaces arrays rather than merging them, so the patch
  // must carry the whole queue. This runs the SDK merge on the real schema.
  const dir = mkdtempSync(join(tmpdir(), 'meta-'))
  try {
    const meta = FileHelper.json(join(dir, 'meta.json'), metaShape)
    const previous = {
      paymentHash: 'b'.repeat(64),
      renewalId: 'r1',
      oldExpiry: '2026-10-01T00:00:00.000Z',
      newExpiry: '2026-11-01T00:00:00.000Z',
      createdAt: '2026-09-27T00:00:00.000Z',
      targetNode: 'cln' as const,
    }
    await meta.write({} as never, {
      pendingRenewal: previous,
      payTasksToClear: [QUEUED],
    })
    const current = await meta.read().once()
    await meta.merge({} as never, {
      pendingRenewal: { ...previous, paymentHash: 'c'.repeat(64) },
      ...replacedPayTaskPatch(
        'renewal',
        current?.pendingRenewal,
        current?.payTasksToClear,
        'c'.repeat(64),
      ),
    })
    assert.deepEqual((await meta.read().once())?.payTasksToClear, [
      QUEUED,
      payTaskReplayId('renewal', 'cln', 'b'.repeat(64)),
    ])
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('metaShape: a TypeScript merge keeps the quota fields bridge.py wrote', async () => {
  // bridge.py lazy_sync writes the monthly quota; the Buy, Renew and Reset
  // actions merge their pending state into the same file with the SDK.
  const dir = mkdtempSync(join(tmpdir(), 'meta-'))
  try {
    const path = join(dir, 'meta.json')
    writeFileSync(
      path,
      JSON.stringify({
        publicKey: 'pk',
        bandwidth_used_gb: 71.5,
        bandwidth_limit_gb: 150,
        bandwidth_resets_this_month: 1,
        max_resets_per_month: 'tampered',
      }),
    )
    const meta = FileHelper.json(path, metaShape)
    await meta.merge({} as never, { syncSuccess: true })
    const stored = JSON.parse(readFileSync(path, 'utf8'))
    assert.equal(stored.bandwidth_limit_gb, 150)
    assert.equal(stored.bandwidth_resets_this_month, 1)
    assert.equal(stored.bandwidth_used_gb, 71.5)
    assert.equal(stored.syncSuccess, true)
    // A malformed value parses as absent instead of failing the whole file.
    const read = await meta.read().once()
    assert.equal(read?.max_resets_per_month, undefined)
    assert.equal(read?.bandwidth_limit_gb, 150)
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

/** A metadata store shared by concurrent purchases, as on the device. */
function fakeMetaStore(initial: {
  pending?: { paymentHash: string; targetNode: string } | null
  payTasksToClear?: string[]
}) {
  let meta = { ...initial }
  const tasks = new Set<string>()
  const log: string[] = []
  return {
    tasks,
    log,
    meta: () => meta,
    purchase(hash: string, gate?: Promise<void>) {
      return recordPaymentThenRaiseTask('order', hash, {
        lockMeta: testMetaLock,
        readCurrent: async () => {
          log.push(`read ${hash[0]}`)
          return {
            pending: meta.pending,
            payTasksToClear: meta.payTasksToClear,
          }
        },
        record: async (patch) => {
          await gate
          meta = {
            ...meta,
            pending: { paymentHash: hash, targetNode: 'lnd' },
            ...patch,
          }
          log.push(`record ${hash[0]}`)
        },
        raiseTask: async () => {
          tasks.add(payTaskReplayId('order', 'lnd', hash))
          log.push(`raise ${hash[0]}`)
        },
      })
    },
  }
}

test('recordPaymentThenRaiseTask: overlapping purchases never interleave', async () => {
  const store = fakeMetaStore({})
  let open!: () => void
  const gate = new Promise<void>((resolve) => (open = resolve))
  const first = store.purchase('1'.repeat(64), gate)
  const second = store.purchase('2'.repeat(64))
  await new Promise((r) => setImmediate(r))
  open()
  await Promise.all([first, second])

  // The second purchase reads only after the first raised its task, so it
  // queues that task for clearing instead of racing its creation.
  assert.deepEqual(store.log, [
    'read 1',
    'record 1',
    'raise 1',
    'read 2',
    'record 2',
    'raise 2',
  ])
  assert.deepEqual(store.meta().payTasksToClear, [
    payTaskReplayId('order', 'lnd', '1'.repeat(64)),
  ])
})

test('recordPaymentThenRaiseTask: a failed record raises no task and frees the queue', async () => {
  const raised: string[] = []
  await assert.rejects(
    recordPaymentThenRaiseTask('renewal', 'e'.repeat(64), {
      lockMeta: testMetaLock,
      readCurrent: async () => null,
      record: async () => {
        throw new Error('disk full')
      },
      raiseTask: async () => {
        raised.push('e')
      },
    }),
    /disk full/,
  )
  assert.deepEqual(raised, [])
  const store = fakeMetaStore({})
  await store.purchase('3'.repeat(64))
  assert.equal(store.tasks.size, 1)
})

test('recordPaymentThenRaiseTask: passes the replaced task with the current queue', async () => {
  const store = fakeMetaStore({
    pending: { paymentHash: '4'.repeat(64), targetNode: 'lnd' },
    payTasksToClear: [QUEUED],
  })
  await store.purchase('5'.repeat(64))
  assert.deepEqual(store.meta().payTasksToClear, [
    QUEUED,
    payTaskReplayId('order', 'lnd', '4'.repeat(64)),
  ])
})

test('recordPaymentThenRaiseTask: a failed read records nothing and raises no task', async () => {
  // Treating an unreadable metadata file as "nothing pending" would replace
  // a pending payment without queuing its task for clearing.
  const calls: string[] = []
  await assert.rejects(
    recordPaymentThenRaiseTask('order', 'f'.repeat(64), {
      lockMeta: testMetaLock,
      readCurrent: async () => {
        throw new Error('EIO')
      },
      record: async () => {
        calls.push('record')
      },
      raiseTask: async () => {
        calls.push('raise')
      },
    }),
    /EIO/,
  )
  assert.deepEqual(calls, [])
})

test('recordThenRaise refuses to overwrite pending when concurrent settlement tick marks it paid', async () => {
  const oldHash = '1'.repeat(64)
  const newHash = '2'.repeat(64)

  for (const [kind, pending] of [
    ['order', { paymentHash: oldHash, paymentReceivedFor: oldHash }],
    ['order', { paymentHash: oldHash, paidViaNwc: true }],
    [
      'order',
      {
        paymentHash: oldHash,
        lastError: 'The payment was received, but claim failed.',
      },
    ],
    [
      'renewal',
      {
        paymentHash: oldHash,
        lastError: 'The renewal is paid, but status refresh failed.',
      },
    ],
  ] as const) {
    const calls: string[] = []
    await assert.rejects(
      recordThenRaise(kind, newHash, {
        lockMeta: testMetaLock,
        readCurrent: async () => ({ pending }),
        record: async () => {
          calls.push('record')
        },
        raiseTask: async () => {
          calls.push('raise')
        },
      }),
      PendingPaymentConflictError,
    )
    assert.deepEqual(calls, [])
  }
})

test('recordThenRaise refuses to overwrite an unexpired renewal when nwcAttempted is true', async () => {
  const now = new Date('2026-10-01T12:00:00.000Z')
  const oldHash = '3'.repeat(64)
  const newHash = '4'.repeat(64)
  const calls: string[] = []

  await assert.rejects(
    recordThenRaise('renewal', newHash, {
      now: () => now,
      lockMeta: testMetaLock,
      readCurrent: async () => ({
        pending: {
          paymentHash: oldHash,
          nwcAttempted: true,
          expiresAt: new Date(now.getTime() + 30 * 60_000).toISOString(),
        },
      }),
      record: async () => {
        calls.push('record')
      },
      raiseTask: async () => {
        calls.push('raise')
      },
    }),
    (err: unknown) =>
      err instanceof PendingPaymentConflictError &&
      /automatic NWC renewal payment is already in progress/.test(err.message),
  )
  assert.deepEqual(calls, [])
})

test('replacedOrderPatch preserves keys until settlement confirms an order can be retired', () => {
  const now = new Date('2026-10-01T12:00:00.000Z')
  const unexpired = {
    paymentHash: 'a'.repeat(64),
    orderId: 'ord-a',
    privateKey: 'priv-a',
    publicKey: 'pub-a',
    targetNode: 'lnd' as const,
    serverId: 'eu-de',
    createdAt: new Date(now.getTime() - 5 * 60_000).toISOString(),
    expiresAt: new Date(now.getTime() + 55 * 60_000).toISOString(),
  }
  const expired = {
    ...unexpired,
    paymentHash: 'e'.repeat(64),
    orderId: 'ord-e',
    expiresAt: new Date(now.getTime() - 1_000).toISOString(),
  }

  const patch = replacedOrderPatch(unexpired, [expired], 'b'.repeat(64))
  assert.equal(patch.previousPendingOrders?.length, 2)
  assert.equal(patch.previousPendingOrders?.[0]?.paymentHash, 'e'.repeat(64))
  assert.equal(patch.previousPendingOrders?.[1]?.privateKey, 'priv-a')
  const expiredPatch = replacedOrderPatch(expired, [], 'b'.repeat(64))
  assert.equal(expiredPatch.previousPendingOrders?.[0]?.privateKey, 'priv-a')
})

test('recordThenRaise refuses replacement when the retained order queue is full', async () => {
  const now = new Date('2026-10-01T12:00:00.000Z')
  const entry = {
    paymentHash: 'a'.repeat(64),
    orderId: 'order-a',
    privateKey: 'private-a',
    publicKey: 'public-a',
    targetNode: 'lnd' as const,
    serverId: 'eu-de',
    createdAt: now.toISOString(),
    expiresAt: new Date(now.getTime() + 60 * 60_000).toISOString(),
  }
  const retained = Array.from({ length: 5 }, (_, n) => ({
    ...entry,
    paymentHash: String(n).repeat(64),
  }))
  const calls: string[] = []
  await assert.rejects(
    recordThenRaise('order', 'b'.repeat(64), {
      now: () => now,
      lockMeta: testMetaLock,
      readCurrent: async () => ({
        pending: entry,
        previousPendingOrders: retained,
      }),
      record: async () => {
        calls.push('record')
      },
      raiseTask: async () => {
        calls.push('raise')
      },
    }),
    PendingPaymentConflictError,
  )
  assert.deepEqual(calls, [])
})
