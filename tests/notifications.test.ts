import test from 'node:test'
import assert from 'node:assert/strict'
import {
  expiryStage,
  planNotifications,
  SEEN_EXPIRIES_LIMIT,
  createNoticeRunner,
  noticeStateRecord,
  NOTICE_RETRY_MS,
  type NoticeInputs,
  type NoticeState,
  type Notice,
} from '../startos/notifications'
import { noticeInputsFor } from '../startos/dependencies'
import { generateWireguardKeypair } from '../startos/keygen'
import { subscriptionNotices } from '../startos/fileModels/subscriptionNotices'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { T } from '@start9labs/start-sdk'

const DAY = 24 * 60 * 60 * 1000
const NOW = new Date('2026-10-01T12:00:00Z')
const at = (days: number) => new Date(NOW.getTime() + days * DAY)

function inputs(over: Partial<NoticeInputs> = {}): NoticeInputs {
  return { publicKey: 'PK=', expiry: at(30), keyUnknown: false, ...over }
}

// --- expiryStage

test('expiryStage follows the reminder thresholds', () => {
  assert.equal(expiryStage(at(30), NOW), null)
  // Never early: "within 7 days" means at most 7 days left.
  assert.equal(expiryStage(at(7.9), NOW), null)
  assert.equal(expiryStage(at(7.01), NOW), null)
  assert.equal(expiryStage(at(7), NOW), '7d')
  assert.equal(expiryStage(at(3.9), NOW), '7d')
  assert.equal(expiryStage(at(3.01), NOW), '7d')
  assert.equal(expiryStage(at(3), NOW), '3d')
  assert.equal(expiryStage(at(0.1), NOW), '3d')
  assert.equal(expiryStage(at(0), NOW), 'lapsed')
  assert.equal(expiryStage(at(-5), NOW), 'lapsed')
})

// --- planNotifications

test('nothing is due while the expiry is far away; the period is recorded', () => {
  const plan = planNotifications(inputs(), null, NOW)
  assert.deepEqual(plan.steps, [])
  assert.deepEqual(plan.next, {
    publicKey: 'PK=',
    expiresAt: at(30).toISOString(),
    sent: [],
  })
})

test('each threshold is announced once per period', () => {
  const first = planNotifications(inputs({ expiry: at(6) }), null, NOW)
  assert.deepEqual(
    first.steps.map((s) => s.notice.kind),
    ['7d'],
  )
  assert.equal(first.steps[0].notice.level, 'warning')
  assert.deepEqual(first.next.sent, ['7d'])

  const again = planNotifications(inputs({ expiry: at(6) }), first.next, NOW)
  assert.deepEqual(again.steps, [])

  const three = planNotifications(inputs({ expiry: at(6) }), first.next, at(3))
  assert.deepEqual(
    three.steps.map((s) => s.notice.kind),
    ['3d'],
  )
  assert.deepEqual(three.next.sent, ['7d', '3d'])

  const lapsed = planNotifications(inputs({ expiry: at(6) }), three.next, at(6))
  assert.deepEqual(
    lapsed.steps.map((s) => s.notice.kind),
    ['lapsed'],
  )
  assert.equal(lapsed.steps[0].notice.level, 'error')
  assert.deepEqual(lapsed.next.sent, ['7d', '3d', 'lapsed'])
  assert.deepEqual(
    planNotifications(inputs({ expiry: at(6) }), lapsed.next, at(40)).steps,
    [],
  )
})

test('only the most severe due stage is posted; milder ones count as sent', () => {
  // e.g. the service was stopped for a week and comes back after the lapse.
  const plan = planNotifications(inputs({ expiry: at(-1) }), null, NOW)
  assert.deepEqual(
    plan.steps.map((s) => s.notice.kind),
    ['lapsed'],
  )
  assert.deepEqual(plan.next.sent, ['7d', '3d', 'lapsed'])
})

test('a renewal (later expiry) starts a new period', () => {
  const sent: NoticeState = {
    publicKey: 'PK=',
    expiresAt: at(-1).toISOString(),
    sent: ['7d', '3d', 'lapsed'],
  }
  const renewed = planNotifications(inputs({ expiry: at(30) }), sent, NOW)
  assert.deepEqual(renewed.steps, [])
  assert.deepEqual(renewed.next, {
    publicKey: 'PK=',
    expiresAt: at(30).toISOString(),
    sent: [],
  })
  // The next period announces its thresholds again.
  assert.deepEqual(
    planNotifications(
      inputs({ expiry: at(30) }),
      renewed.next,
      at(24),
    ).steps.map((s) => s.notice.kind),
    ['7d'],
  )
})

test('an earlier expiry for the same key keeps what was sent', () => {
  const sent: NoticeState = {
    publicKey: 'PK=',
    expiresAt: at(6).toISOString(),
    sent: ['7d'],
  }
  const plan = planNotifications(inputs({ expiry: at(5) }), sent, NOW)
  assert.deepEqual(plan.steps, [])
  assert.deepEqual(plan.next.sent, ['7d'])
  // The period keeps its latest expiry, so a correction back to it is not
  // mistaken for a renewal that re-announces the same threshold.
  assert.equal(plan.next.expiresAt, at(6).toISOString())
  const back = planNotifications(inputs({ expiry: at(6) }), plan.next, NOW)
  assert.deepEqual(back.steps, [])
  assert.deepEqual(back.next.sent, ['7d'])
})

test('a stage records the expiry it was announced for', () => {
  const plan = planNotifications(inputs({ expiry: at(6) }), null, NOW)
  assert.equal(plan.steps[0].after.sentFor, at(6).toISOString())
  assert.equal(plan.next.sentFor, at(6).toISOString())
  // A later stage of the same period moves it along.
  const three = planNotifications(inputs({ expiry: at(5) }), plan.next, at(2))
  assert.deepEqual(
    three.steps.map((s) => s.notice.kind),
    ['3d'],
  )
  assert.equal(three.next.sentFor, at(5).toISOString())
  assert.equal(three.next.expiresAt, at(6).toISOString())
})

test('a renewal after a shortened expiry starts a new period below the old high-water', () => {
  // Confirmed at 30 days, then shortened to 5: the 7-day notice goes out
  // for the shortened expiry.
  const recorded = planNotifications(inputs({ expiry: at(30) }), null, NOW)
  const shortened = planNotifications(
    inputs({ expiry: at(5) }),
    recorded.next,
    NOW,
  )
  assert.deepEqual(
    shortened.steps.map((s) => s.notice.kind),
    ['7d'],
  )
  assert.equal(shortened.next.expiresAt, at(30).toISOString())

  // A paid renewal extends the shortened expiry to 20 days: still below the
  // old 30-day high-water, but later than what the notice was sent for.
  const renewed = planNotifications(
    inputs({ expiry: at(20) }),
    shortened.next,
    NOW,
  )
  assert.deepEqual(renewed.steps, [])
  assert.deepEqual(renewed.next, {
    publicKey: 'PK=',
    expiresAt: at(20).toISOString(),
    sent: [],
  })
  // Its own thresholds are announced again.
  assert.deepEqual(
    planNotifications(
      inputs({ expiry: at(20) }),
      renewed.next,
      at(14),
    ).steps.map((s) => s.notice.kind),
    ['7d'],
  )
})

test('a correction back to the high-water after a stage keeps what was sent', () => {
  // The 7-day notice went out for a temporarily earlier answer; the API
  // then returns the period's latest expiry again and later flaps back.
  const prev: NoticeState = {
    publicKey: 'PK=',
    expiresAt: at(6).toISOString(),
    sent: ['7d'],
    sentFor: at(5).toISOString(),
  }
  const back = planNotifications(inputs({ expiry: at(6) }), prev, NOW)
  assert.deepEqual(back.steps, [])
  assert.deepEqual(back.next, prev)
  const flap = planNotifications(inputs({ expiry: at(5) }), back.next, NOW)
  assert.deepEqual(flap.steps, [])
  assert.deepEqual(flap.next.sent, ['7d'])
})

test('a return to an expiry already seen in the period is a correction (#100)', () => {
  // Confirmed at 30 days, shortened to 6 (7-day notice), then to 2 (3-day
  // notice), then corrected back to 6: no renewal, so nothing repeats.
  const recorded = planNotifications(inputs({ expiry: at(30) }), null, NOW)
  const six = planNotifications(inputs({ expiry: at(6) }), recorded.next, NOW)
  assert.deepEqual(
    six.steps.map((s) => s.notice.kind),
    ['7d'],
  )
  const two = planNotifications(inputs({ expiry: at(2) }), six.next, NOW)
  assert.deepEqual(
    two.steps.map((s) => s.notice.kind),
    ['3d'],
  )
  const back = planNotifications(inputs({ expiry: at(6) }), two.next, NOW)
  assert.deepEqual(back.steps, [])
  assert.deepEqual(back.next.sent, ['7d', '3d'])
  assert.equal(back.next.expiresAt, at(30).toISOString())
  // Flapping between the seen values stays quiet as well.
  const again = planNotifications(inputs({ expiry: at(2) }), back.next, NOW)
  assert.deepEqual(again.steps, [])
  const sixAgain = planNotifications(inputs({ expiry: at(6) }), again.next, NOW)
  assert.deepEqual(sixAgain.steps, [])
})

test('a return to an unannounced reminder-window expiry recorded only in seen is a correction', () => {
  // 30d -> 6d (7d notice announced for 6d) -> 5d (no new notice, so 5d is in
  // seen but not announcedFor) -> 2d (3d notice announced for 2d) -> 5d:
  // 5d must be recognised from seen alone so the period does not restart.
  const recorded = planNotifications(inputs({ expiry: at(30) }), null, NOW)
  const six = planNotifications(inputs({ expiry: at(6) }), recorded.next, NOW)
  const five = planNotifications(inputs({ expiry: at(5) }), six.next, NOW)
  assert.deepEqual(five.steps, [])
  assert.ok(five.next.seen?.includes(at(5).toISOString()))
  assert.ok(!five.next.announcedFor?.includes(at(5).toISOString()))
  const two = planNotifications(inputs({ expiry: at(2) }), five.next, NOW)
  assert.deepEqual(
    two.steps.map((s) => s.notice.kind),
    ['3d'],
  )
  const backToFive = planNotifications(inputs({ expiry: at(5) }), two.next, NOW)
  assert.deepEqual(backToFive.steps, [])
  assert.deepEqual(backToFive.next.sent, ['7d', '3d'])
  assert.equal(backToFive.next.expiresAt, at(30).toISOString())
})

test('a renewal to an unseen expiry after repeated shortening starts a new period', () => {
  const recorded = planNotifications(inputs({ expiry: at(30) }), null, NOW)
  const six = planNotifications(inputs({ expiry: at(6) }), recorded.next, NOW)
  const two = planNotifications(inputs({ expiry: at(2) }), six.next, NOW)
  const renewed = planNotifications(inputs({ expiry: at(20) }), two.next, NOW)
  assert.deepEqual(renewed.steps, [])
  assert.deepEqual(renewed.next, {
    publicKey: 'PK=',
    expiresAt: at(20).toISOString(),
    sent: [],
  })
})

test('legacy state without seen expiries still treats sentFor as seen', () => {
  const prev: NoticeState = {
    publicKey: 'PK=',
    expiresAt: at(30).toISOString(),
    sent: ['7d', '3d'],
    sentFor: at(2).toISOString(),
  }
  // Above sentFor, below the high-water, never seen: a renewal.
  const renewal = planNotifications(inputs({ expiry: at(10) }), prev, NOW)
  assert.deepEqual(renewal.next.sent, [])
  // sentFor itself is a correction.
  const same = planNotifications(inputs({ expiry: at(2) }), prev, NOW)
  assert.deepEqual(same.steps, [])
  assert.deepEqual(same.next.sent, ['7d', '3d'])
})

test('a renewal to an earlier pre-reminder expiry starts a new period and announces when due', () => {
  // 90d -> shortened to 35d (outside the 7d reminder window) -> shortened to
  // 5d (7d notice sent) -> renewed by 30d back to 35d: must start a new
  // period so the renewed subscription receives its 7d reminder when due.
  const ninety = planNotifications(inputs({ expiry: at(90) }), null, NOW)
  const thirtyFive = planNotifications(
    inputs({ expiry: at(35) }),
    ninety.next,
    NOW,
  )
  assert.equal(thirtyFive.next.seen, undefined)
  const five = planNotifications(
    inputs({ expiry: at(5) }),
    thirtyFive.next,
    NOW,
  )
  assert.deepEqual(
    five.steps.map((s) => s.notice.kind),
    ['7d'],
  )
  const renewed = planNotifications(inputs({ expiry: at(35) }), five.next, NOW)
  assert.deepEqual(renewed.steps, [])
  assert.deepEqual(renewed.next, {
    publicKey: 'PK=',
    expiresAt: at(35).toISOString(),
    sent: [],
  })
  const dueAgain = planNotifications(
    inputs({ expiry: at(35) }),
    renewed.next,
    at(28),
  )
  assert.deepEqual(
    dueAgain.steps.map((s) => s.notice.kind),
    ['7d'],
  )
})

test('the seen expiries of a period stay bounded', () => {
  let state = planNotifications(inputs({ expiry: at(30) }), null, NOW).next
  // Twelve distinct shortenings within the reminder window, each earlier than
  // the one before.
  for (let i = 0; i < 12; i++) {
    state = planNotifications(
      inputs({ expiry: at(7 - i * 0.5) }),
      state,
      NOW,
    ).next
  }
  assert.equal(state.expiresAt, at(30).toISOString())
  assert.ok((state.seen?.length ?? 0) <= SEEN_EXPIRIES_LIMIT)
  // The most recent ones are kept.
  assert.ok(state.seen?.includes(at(7 - 11 * 0.5).toISOString()))
})

test('an announced expiry is never forgotten, however many corrections follow', () => {
  // 7-day notice for 6 days, 3-day notice for 2 days, then more distinct
  // corrections than SEEN_EXPIRIES_LIMIT: 6 days drops out of seen and is
  // no longer sentFor, but it announced a notice.
  const recorded = planNotifications(inputs({ expiry: at(30) }), null, NOW)
  const six = planNotifications(inputs({ expiry: at(6) }), recorded.next, NOW)
  const two = planNotifications(inputs({ expiry: at(2) }), six.next, NOW)
  assert.deepEqual(
    [...six.steps, ...two.steps].map((s) => s.notice.kind),
    ['7d', '3d'],
  )
  let state = two.next
  for (let i = 1; i <= SEEN_EXPIRIES_LIMIT + 1; i++) {
    state = planNotifications(
      inputs({ expiry: at(2 - i * 0.1) }),
      state,
      NOW,
    ).next
  }
  assert.ok(!state.seen?.includes(at(6).toISOString()))
  assert.equal(state.sentFor, at(2).toISOString())
  const back = planNotifications(inputs({ expiry: at(6) }), state, NOW)
  assert.deepEqual(back.steps, [])
  assert.deepEqual(back.next.sent, ['7d', '3d'])
})

test('the runner persists the period history through the file model and a rollback', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'notices-'))
  try {
    const file = subscriptionNotices.withPath(join(dir, 'notices.json'))
    const effects = {} as T.Effects
    let expiry = at(30)
    let now = NOW
    let failPost = false
    const posted: string[] = []
    const run = createNoticeRunner({
      readInputs: async () => inputs({ expiry }),
      readState: async () => (await file.read().once()) ?? null,
      writeState: async (state) => {
        await file.write(effects, noticeStateRecord(state))
      },
      notify: async (notice) => {
        if (failPost) throw new Error('no notifications')
        posted.push(notice.kind)
      },
      now: () => now,
    })
    await run()
    expiry = at(6)
    await run()
    // The 3-day notice fails once and is rolled back.
    expiry = at(2)
    failPost = true
    assert.match((await run()).error ?? '', /no notifications/)
    const rolledBack = await file.read().once()
    assert.deepEqual(rolledBack?.announcedFor, [at(6).toISOString()])
    assert.ok(rolledBack?.seen?.includes(at(6).toISOString()))
    failPost = false
    now = new Date(NOW.getTime() + NOTICE_RETRY_MS)
    await run()
    // Back to the first shortened expiry: nothing repeats.
    expiry = at(6)
    await run()
    assert.deepEqual(posted, ['7d', '3d'])
    const saved = await file.read().once()
    assert.deepEqual(saved?.announcedFor, [
      at(6).toISOString(),
      at(2).toISOString(),
    ])
    assert.deepEqual(saved?.sent, ['7d', '3d'])
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('a new key starts a new period', () => {
  const sent: NoticeState = {
    publicKey: 'OLD=',
    expiresAt: at(6).toISOString(),
    sent: ['7d'],
  }
  const plan = planNotifications(inputs({ expiry: at(6) }), sent, NOW)
  assert.deepEqual(
    plan.steps.map((s) => s.notice.kind),
    ['7d'],
  )
  assert.equal(plan.next.publicKey, 'PK=')
})

test('without a confirmed expiry the expiry state is left as it is', () => {
  const sent: NoticeState = {
    publicKey: 'PK=',
    expiresAt: at(6).toISOString(),
    sent: ['7d'],
  }
  const plan = planNotifications(inputs({ expiry: null }), sent, NOW)
  assert.deepEqual(plan.steps, [])
  assert.deepEqual(plan.next, sent)
})

test('an unknown key is announced once per key and re-armed once it is known', () => {
  const unknown = planNotifications(
    inputs({ expiry: null, keyUnknown: true }),
    null,
    NOW,
  )
  assert.deepEqual(
    unknown.steps.map((s) => s.notice.kind),
    ['unknown-key'],
  )
  assert.equal(unknown.steps[0].notice.level, 'error')
  assert.equal(unknown.next.unknownKey, 'PK=')
  assert.deepEqual(
    planNotifications(
      inputs({ expiry: null, keyUnknown: true }),
      unknown.next,
      NOW,
    ).steps,
    [],
  )
  // Another unknown key is announced again.
  assert.deepEqual(
    planNotifications(
      inputs({ publicKey: 'NEW=', expiry: null, keyUnknown: true }),
      unknown.next,
      NOW,
    ).steps.map((s) => s.notice.kind),
    ['unknown-key'],
  )
  // Known again: the marker goes, so a later unknown verdict notifies again.
  const known = planNotifications(inputs(), unknown.next, NOW)
  assert.equal(known.next.unknownKey, undefined)
})

test('without a key nothing is planned and nothing changes', () => {
  const sent: NoticeState = { publicKey: 'PK=', sent: ['7d'] }
  const plan = planNotifications(
    { publicKey: null, expiry: null, keyUnknown: false },
    sent,
    NOW,
  )
  assert.deepEqual(plan.steps, [])
  assert.deepEqual(plan.next, sent)
})

test('notice texts name the date and never claim the node holds its traffic', () => {
  const lapsed = planNotifications(inputs({ expiry: at(-1) }), null, NOW)
    .steps[0].notice
  assert.match(lapsed.message, /2026-09-30/)
  assert.match(lapsed.message, /Renew Subscription/)
  assert.match(lapsed.message, /turn off the clearnet VPN/)
  for (const n of [
    lapsed,
    planNotifications(inputs({ expiry: at(6) }), null, NOW).steps[0].notice,
    planNotifications(inputs({ expiry: null, keyUnknown: true }), null, NOW)
      .steps[0].notice,
  ]) {
    assert.ok(n.title.length > 0)
    assert.doesNotMatch(n.message, /\bholds?\b|fail.closed|cannot leak/i)
  }
})

// --- runner

function fakeOps(over: Partial<Record<string, unknown>> = {}) {
  const log: string[] = []
  let stored: NoticeState | null = null
  const ops = {
    readInputs: async () => inputs({ expiry: at(6) }) as NoticeInputs | null,
    readState: async () => stored,
    writeState: async (s: NoticeState) => {
      log.push(`write:${(s.sent ?? []).join(',')}`)
      stored = structuredClone(s)
    },
    notify: async (n: Notice) => {
      log.push(`notify:${n.kind}`)
    },
    now: () => NOW,
    ...over,
  }
  return { ops, log, stored: () => stored }
}

test('the runner records a notice before posting it and posts it once', async () => {
  const { ops, log } = fakeOps()
  const run = createNoticeRunner(ops)
  assert.deepEqual(await run(), { posted: ['7d'], error: null })
  assert.deepEqual(await run(), { posted: [], error: null })
  assert.deepEqual(log, ['write:7d', 'notify:7d'])
})

test('a failed post is rolled back and retried after a pause', async () => {
  let fail = true
  let now = NOW
  const { ops, log, stored } = fakeOps({
    notify: async (n: Notice) => {
      log.push(`notify:${n.kind}`)
      if (fail) throw new Error('no notifications here')
    },
    now: () => now,
  })
  const run = createNoticeRunner(ops)
  const first = await run()
  assert.deepEqual(first.posted, [])
  assert.match(String(first.error), /no notifications here/)
  assert.deepEqual(stored()?.sent, [])
  // No retry storm: the next health tick does not try again right away.
  assert.deepEqual(await run(), { posted: [], error: null })
  assert.deepEqual(log, ['write:7d', 'notify:7d', 'write:'])
  fail = false
  now = new Date(NOW.getTime() + 16 * 60 * 1000)
  assert.deepEqual((await run()).posted, ['7d'])
})

test('a failed state write posts nothing (never a duplicate notice)', async () => {
  const { ops, log } = fakeOps({
    writeState: async () => {
      throw new Error('disk full')
    },
  })
  const res = await createNoticeRunner(ops)()
  assert.deepEqual(res.posted, [])
  assert.match(String(res.error), /disk full/)
  assert.deepEqual(log, [])
})

test('state-only changes are persisted without a notice', async () => {
  const { ops, log, stored } = fakeOps({
    readInputs: async () => inputs({ expiry: at(30) }),
  })
  await createNoticeRunner(ops)()
  assert.deepEqual(log, ['write:'])
  assert.equal(stored()?.expiresAt, at(30).toISOString())
  // Unchanged state is not rewritten.
  await createNoticeRunner(ops)()
  assert.deepEqual(log, ['write:'])
})

test('the runner does nothing while disabled and never throws', async () => {
  const { ops, log } = fakeOps({ readInputs: async () => null })
  assert.deepEqual(await createNoticeRunner(ops)(), {
    posted: [],
    error: null,
  })
  assert.deepEqual(log, [])
  const broken = fakeOps({
    readState: async () => {
      throw new Error('unreadable')
    },
  })
  const res = await createNoticeRunner(broken.ops)()
  assert.match(String(res.error), /unreadable/)
})

test('overlapping runs are serialised, so a notice is never posted twice', async () => {
  const { ops, log } = fakeOps()
  const run = createNoticeRunner(ops)
  const [a, b] = await Promise.all([run(), run()])
  assert.deepEqual([...a.posted, ...b.posted], ['7d'])
  assert.deepEqual(log, ['write:7d', 'notify:7d'])
})

// --- inputs from the stored configuration and metadata

test('noticeInputsFor reads the key, the confirmed expiry and the unknown-key verdict', () => {
  const kp = generateWireguardKeypair()
  const conf = `[Interface]\nPrivateKey = ${kp.privateKey}\nAddress = 10.9.0.2/32\n# VPNPort: 24556\n[Peer]\nEndpoint = de2.tunnelsats.com:51820\n`
  const config = { enabled: true, 'tunnelsats-conf': conf }
  const meta = {
    expiresAt: '2026-10-07T00:00:00Z',
    expirySource: 'api' as const,
    publicKey: kp.publicKey,
  }
  assert.deepEqual(noticeInputsFor(config, meta), {
    publicKey: kp.publicKey,
    expiry: new Date('2026-10-07T00:00:00Z'),
    keyUnknown: false,
  })
  assert.deepEqual(
    noticeInputsFor(config, { publicKey: kp.publicKey, keyUnknown: true }),
    { publicKey: kp.publicKey, expiry: null, keyUnknown: true },
  )
  // Comment-only expiry never counts.
  assert.equal(
    noticeInputsFor(config, { expiresAt: '2026-10-07T00:00:00Z' })?.expiry,
    null,
  )
  assert.equal(noticeInputsFor({ ...config, enabled: false }, meta), null)
  assert.equal(noticeInputsFor(null, meta), null)
})

test('a rollback that could not be written is retried, so the notice is not lost', async () => {
  let failNotify = true
  let failWrites = 0
  let now = NOW
  const { ops, log, stored } = fakeOps({
    notify: async (n: Notice) => {
      log.push(`notify:${n.kind}`)
      if (failNotify) {
        failNotify = false
        failWrites = 1 // the rollback write fails too
        throw new Error('host busy')
      }
    },
    now: () => now,
  })
  const write = ops.writeState
  ops.writeState = async (s: NoticeState) => {
    if (failWrites > 0) {
      failWrites--
      throw new Error('disk busy')
    }
    await write(s)
  }
  const run = createNoticeRunner(ops)
  assert.deepEqual((await run()).posted, [])
  // The record still says sent; only the in-memory rollback remembers.
  assert.deepEqual(stored()?.sent, ['7d'])
  now = new Date(NOW.getTime() + 16 * 60 * 1000)
  assert.deepEqual((await run()).posted, ['7d'])
  assert.deepEqual(log, [
    'write:7d',
    'notify:7d',
    'write:',
    'write:7d',
    'notify:7d',
  ])
})

// --- recovered paid replaced orders

test('a recovered order is announced once per payment hash', () => {
  const hashA = 'a'.repeat(64)
  const first = planNotifications(
    inputs({ recoveredOrder: { paymentHash: hashA } }),
    null,
    NOW,
  )
  assert.deepEqual(
    first.steps.map((s) => s.notice.kind),
    ['recovered-order'],
  )
  const notice = first.steps[0].notice
  assert.equal(notice.level, 'warning')
  assert.match(notice.message, /active tunnel is unchanged/)
  assert.match(notice.message, /Export WireGuard Configuration/)
  assert.match(notice.message, /Import Subscription/)
  assert.equal(first.next.recoveredOrderHash, hashA)

  // The same recovery is never announced again, also once the input is gone.
  assert.deepEqual(
    planNotifications(
      inputs({ recoveredOrder: { paymentHash: hashA } }),
      first.next,
      NOW,
    ).steps,
    [],
  )
  const absent = planNotifications(inputs(), first.next, NOW)
  assert.deepEqual(absent.steps, [])
  assert.equal(absent.next.recoveredOrderHash, hashA)

  // A later recovery is announced.
  assert.deepEqual(
    planNotifications(
      inputs({ recoveredOrder: { paymentHash: 'b'.repeat(64) } }),
      first.next,
      NOW,
    ).steps.map((s) => s.notice.kind),
    ['recovered-order'],
  )
})

test('noticeInputsFor maps the latest recovered order from the metadata', () => {
  const kp = generateWireguardKeypair()
  const config = {
    enabled: true,
    'tunnelsats-conf': `[Interface]\nPrivateKey = ${kp.privateKey}\nAddress = 10.9.0.2/32\n`,
  }
  const hash = 'c'.repeat(64)
  assert.deepEqual(
    noticeInputsFor(config, {
      lastRecoveredOrder: {
        paymentHash: hash,
        recoveredAt: '2026-10-01T00:00:00Z',
      },
    })?.recoveredOrder,
    { paymentHash: hash },
  )
  assert.equal(noticeInputsFor(config, {})?.recoveredOrder, undefined)
})

test('the recovered-order marker survives the notices file model', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'notices-'))
  try {
    const file = subscriptionNotices.withPath(join(dir, 'notices.json'))
    const posted: string[] = []
    const run = createNoticeRunner({
      readInputs: async () =>
        inputs({ recoveredOrder: { paymentHash: 'd'.repeat(64) } }),
      readState: async () => (await file.read().once()) ?? null,
      writeState: async (state) => {
        await file.write({} as T.Effects, noticeStateRecord(state))
      },
      notify: async (notice) => {
        posted.push(notice.kind)
      },
      now: () => NOW,
    })
    await run()
    await run()
    assert.deepEqual(posted, ['recovered-order'])
    assert.equal((await file.read().once())?.recoveredOrderHash, 'd'.repeat(64))
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})
