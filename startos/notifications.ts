/**
 * StartOS notifications for the subscription (G8): 7 and 3 days before the
 * confirmed expiry, on lapse, and when TunnelSats has no subscription for
 * the configured key.
 *
 * sdk.notification.create is not idempotent, so what was sent is persisted
 * (subscription-notices.json) and each notice goes out once per period. A
 * period is one confirmed expiry of one key: a renewal or a new key starts a
 * new one. A renewal is an expiry later than any seen in the period, or
 * later than the one the last stage was announced for and never seen in the
 * period before (a correction back to an earlier answer is not a renewal;
 * see planNotifications). Only the most
 * severe due stage is posted; the milder ones count as sent, so a box that
 * was off for a week reports the lapse once instead of three notices.
 *
 * Delivery is at most once: a notice is recorded before it is posted and
 * the record is rolled back when posting fails. A failing state write thus
 * never turns into a notice repeated on every health check tick. A rollback
 * that cannot be written is kept in memory and written before the next
 * run. What remains is a notice lost when the service stops between the
 * record and the post, a deliberate trade against duplicate notices; the
 * Renew and unknown-key tasks keep reminding in that case.
 *
 * Limitation: the notices are driven by the Subscription health check, so
 * nothing is sent while TunnelSats is stopped; a due notice goes out once it
 * runs again. The Renew task raised by setDependencies stays the persistent
 * reminder.
 *
 * SDK-free on purpose (the caller passes the effects-bound operations), so
 * the planning and the runner are unit-tested as they run in production.
 */

import { i18n } from './i18n'

export type ExpiryStage = '7d' | '3d' | 'lapsed'
export type NoticeKind =
  ExpiryStage | 'unknown-key' | 'nwc-renewed' | 'nwc-fallback' | 'nwc-restore'

/** Mildest first. */
const STAGES: readonly ExpiryStage[] = ['7d', '3d', 'lapsed']
const DAY_MS = 24 * 60 * 60 * 1000
/**
 * How many other expiries of a period are remembered (#100), oldest dropped
 * first. Expiries a stage was announced for are kept apart (announcedFor, at
 * most one per stage) and never dropped, so a correction back to one never
 * repeats its notice. Only a correction back to an expiry that announced
 * nothing and was dropped can open a new period; it then posts only what is
 * due for it, which was not posted for that expiry before.
 */
export const SEEN_EXPIRIES_LIMIT = 8
/** Pause after a failed post, so a host without notifications is not asked on every tick. */
export const NOTICE_RETRY_MS = 15 * 60 * 1000

/**
 * The reminder stage for an expiry: 'lapsed' at or after it, '3d' with at
 * most 3 days left, '7d' with at most 7, else null. Compared on the exact
 * remaining time, so a reminder is never early. Shared with the Renew task
 * (getSubscriptionExpiryTask).
 */
export function expiryStage(expiry: Date, now: Date): ExpiryStage | null {
  const diff = expiry.getTime() - now.getTime()
  if (diff <= 0) return 'lapsed'
  if (diff <= 3 * DAY_MS) return '3d'
  if (diff <= 7 * DAY_MS) return '7d'
  return null
}

export interface NoticeInputs {
  /** Public key of the stored configuration; null: nothing to notify about. */
  publicKey: string | null
  /** The API-confirmed expiry for publicKey, or null. */
  expiry: Date | null
  /** TunnelSats has no subscription for publicKey. */
  keyUnknown: boolean
  /** Set when an NWC auto-renewal payment has been settled. */
  nwcRenewed?: {
    paymentHash: string
    duration: number
    amountSats: number
    newExpiry: string
  }
  /** Set when NWC auto-renewal tripped fallback or detected insufficient budget. */
  nwcFallback?: {
    key: string
    reason: string
  }
  /** Set when nwcConnected is true in meta but /data/nwc-wallet.json is missing after restore. */
  nwcRestoreNeeded?: boolean
}

export interface NoticeState {
  /** Key of the current period and the latest confirmed expiry it saw. */
  publicKey?: string
  expiresAt?: string
  /** Stages announced in the current period; unknown entries are ignored. */
  sent?: readonly string[]
  /** The expiry the latest stage was announced for. */
  sentFor?: string
  /**
   * Other confirmed expiries seen in the current period (below expiresAt),
   * oldest first, at most SEEN_EXPIRIES_LIMIT.
   */
  seen?: readonly string[]
  /** The expiries a stage of the current period was announced for. */
  announcedFor?: readonly string[]
  /** The key the unknown-key notice was sent for. */
  unknownKey?: string
  /** Payment hash of the last NWC auto-renewal announced. */
  nwcRenewedHash?: string
  /** Deduplication key of the last NWC fallback/budget warning announced. */
  nwcFallbackKey?: string
  /** True while the post-restore reconnect notice has been sent. */
  nwcRestoreNotified?: boolean
}

export interface Notice {
  kind: NoticeKind
  level: 'info' | 'warning' | 'error'
  title: string
  message: string
}

export interface NoticeStep {
  notice: Notice
  /** State to restore when posting fails. */
  before: NoticeState
  /** State that records the notice as sent. */
  after: NoticeState
}

export interface NoticePlan {
  steps: NoticeStep[]
  next: NoticeState
}

function isoDate(d: Date): string {
  return d.toISOString().slice(0, 10)
}

export function noticeFor(
  kind: NoticeKind,
  expiry: Date | null,
  extra?: {
    duration?: number
    amountSats?: number
    newExpiry?: string
    reason?: string
  },
): Notice {
  const date = expiry ? isoDate(expiry) : ''
  switch (kind) {
    case '7d':
      return {
        kind,
        level: 'warning',
        title: i18n('TunnelSats subscription expires within 7 days'),
        message: i18n(
          'Your TunnelSats subscription expires on ${date}. Run Renew Subscription in TunnelSats to keep your node reachable over clearnet.',
          { date },
        ),
      }
    case '3d':
      return {
        kind,
        level: 'warning',
        title: i18n('TunnelSats subscription expires within 3 days'),
        message: i18n(
          'Your TunnelSats subscription expires on ${date}. Run Renew Subscription in TunnelSats to keep your node reachable over clearnet.',
          { date },
        ),
      }
    case 'lapsed':
      return {
        kind,
        level: 'error',
        title: i18n('TunnelSats subscription expired'),
        message: i18n(
          "Your TunnelSats subscription expired on ${date}. The TunnelSats server disables your tunnel, so your node's clearnet peer connections through TunnelSats stop working. Run Renew Subscription in TunnelSats, or turn off the clearnet VPN on your Lightning node.",
          { date },
        ),
      }
    case 'unknown-key':
      return {
        kind,
        level: 'error',
        title: i18n('TunnelSats does not know your WireGuard key'),
        message: i18n(
          'TunnelSats has no subscription for the WireGuard key in your configuration. Run Import Subscription in TunnelSats with a valid configuration, or Buy Subscription to get a new one.',
        ),
      }
    case 'nwc-renewed': {
      const parsedNew = extra?.newExpiry ? new Date(extra.newExpiry) : expiry
      const newDate =
        parsedNew && !isNaN(parsedNew.getTime())
          ? isoDate(parsedNew)
          : (extra?.newExpiry ?? date)
      return {
        kind,
        level: 'info',
        title: i18n('TunnelSats subscription auto-renewed via NWC'),
        message: i18n(
          'Your TunnelSats subscription was automatically renewed for ${duration} month(s) (${amount} sats via NWC). New expiry: ${date}.',
          {
            duration: String(extra?.duration ?? 1),
            amount: String(extra?.amountSats ?? 0),
            date: newDate,
          },
        ),
      }
    }
    case 'nwc-fallback':
      return {
        kind,
        level: 'warning',
        title: i18n('NWC auto-renewal requires attention'),
        message: i18n(
          'Automatic NWC renewal could not complete (${reason}). A manual Pay Invoice task has been raised on your Lightning node, or you can update your wallet in Connect Wallet.',
          {
            reason:
              extra?.reason || 'insufficient wallet budget or relay failure',
          },
        ),
      }
    case 'nwc-restore':
      return {
        kind,
        level: 'warning',
        title: i18n('Reconnect NWC wallet after backup restore'),
        message: i18n(
          'Your NWC wallet secret is excluded from StartOS backups. Run Connect Wallet in TunnelSats to reconnect automatic renewals.',
        ),
      }
  }
}

function sentStages(state: NoticeState | null | undefined): ExpiryStage[] {
  return STAGES.filter((s) => state?.sent?.includes(s))
}

/**
 * What to post now and the state that records it. Pure: `prev` is the
 * persisted state (null when missing or unreadable).
 */
export function planNotifications(
  input: NoticeInputs,
  prev: NoticeState | null | undefined,
  now: Date,
): NoticePlan {
  const base: NoticeState = { ...(prev ?? {}) }
  if (prev?.sent) base.sent = sentStages(prev)
  const { publicKey, expiry, keyUnknown } = input
  if (!publicKey) return { steps: [], next: base }

  // The unknown-key marker lives only as long as the verdict, so a key that
  // is known again and later unknown once more is announced again.
  const unknownDue = keyUnknown && prev?.unknownKey !== publicKey
  if (!keyUnknown) delete base.unknownKey

  if (!input.nwcFallback) delete base.nwcFallbackKey
  if (!input.nwcRestoreNeeded) delete base.nwcRestoreNotified

  let stageDue: ExpiryStage | null = null
  if (expiry) {
    const valid = (iso: string | undefined) => {
      const d = iso ? new Date(iso) : null
      return d && !isNaN(d.getTime()) ? d : null
    }
    const prevExpiry = valid(prev?.expiresAt)
    const prevSentFor = valid(prev?.sentFor)
    const t = expiry.getTime()
    const dates = (list: readonly string[] | undefined) =>
      (list ?? []).map((iso) => valid(iso)).filter((d): d is Date => d !== null)
    // Earlier answers of this period; sentFor counts too (state written
    // before `seen` existed has only that).
    const prevSeen = dates(prev?.seen)
    const seenBefore = [
      ...prevSeen,
      ...dates(prev?.announcedFor),
      ...(prevSentFor ? [prevSentFor] : []),
    ]
    const stage = expiryStage(expiry, now)
    const newPeriod =
      prev?.publicKey !== publicKey ||
      !prevExpiry ||
      t > prevExpiry.getTime() ||
      (!!prevSentFor &&
        t > prevSentFor.getTime() &&
        t < prevExpiry.getTime() &&
        (stage === null || !seenBefore.some((d) => d.getTime() === t)))
    base.publicKey = publicKey
    base.expiresAt =
      newPeriod || !prevExpiry ? expiry.toISOString() : prevExpiry.toISOString()
    base.sent = newPeriod ? [] : sentStages(prev)
    if (newPeriod) {
      delete base.sentFor
      delete base.seen
      delete base.announcedFor
    } else if (prevExpiry && t < prevExpiry.getTime() && stage !== null) {
      const iso = expiry.toISOString()
      const kept = prevSeen.map((d) => d.toISOString())
      if (!kept.includes(iso)) {
        base.seen = [...kept, iso].slice(-SEEN_EXPIRIES_LIMIT)
      } else if (prev?.seen) {
        base.seen = kept
      }
    }
    if (stage && !base.sent.includes(stage)) stageDue = stage
  }

  const steps: NoticeStep[] = []
  let state = base
  if (unknownDue) {
    const after = { ...state, unknownKey: publicKey }
    steps.push({ notice: noticeFor('unknown-key', null), before: state, after })
    state = after
  }
  if (input.nwcRestoreNeeded && !state.nwcRestoreNotified) {
    const after = { ...state, nwcRestoreNotified: true }
    steps.push({
      notice: noticeFor('nwc-restore', expiry),
      before: state,
      after,
    })
    state = after
  }
  if (
    input.nwcRenewed?.paymentHash &&
    state.nwcRenewedHash !== input.nwcRenewed.paymentHash
  ) {
    const after = { ...state, nwcRenewedHash: input.nwcRenewed.paymentHash }
    steps.push({
      notice: noticeFor('nwc-renewed', expiry, {
        duration: input.nwcRenewed.duration,
        amountSats: input.nwcRenewed.amountSats,
        newExpiry: input.nwcRenewed.newExpiry,
      }),
      before: state,
      after,
    })
    state = after
  }
  if (
    input.nwcFallback?.key &&
    state.nwcFallbackKey !== input.nwcFallback.key
  ) {
    const after = { ...state, nwcFallbackKey: input.nwcFallback.key }
    steps.push({
      notice: noticeFor('nwc-fallback', expiry, {
        reason: input.nwcFallback.reason,
      }),
      before: state,
      after,
    })
    state = after
  }
  if (stageDue && expiry) {
    const upTo = STAGES.indexOf(stageDue)
    const iso = expiry.toISOString()
    const announced = (state.announcedFor ?? []).filter((a) => a !== iso)
    const after = {
      ...state,
      sent: STAGES.slice(0, upTo + 1),
      sentFor: iso,
      announcedFor: [...announced, iso].slice(-STAGES.length),
    }
    steps.push({ notice: noticeFor(stageDue, expiry), before: state, after })
    state = after
  }
  return { steps, next: state }
}

/**
 * The persisted form of a NoticeState (subscription-notices.json): every
 * field the planner reads, arrays copied. main.ts writes exactly this.
 */
export function noticeStateRecord(state: NoticeState): {
  publicKey?: string
  expiresAt?: string
  sent?: string[]
  sentFor?: string
  seen?: string[]
  announcedFor?: string[]
  unknownKey?: string
  nwcRenewedHash?: string
  nwcFallbackKey?: string
  nwcRestoreNotified?: boolean
} {
  return {
    publicKey: state.publicKey,
    expiresAt: state.expiresAt,
    sent: state.sent ? [...state.sent] : undefined,
    sentFor: state.sentFor,
    seen: state.seen ? [...state.seen] : undefined,
    announcedFor: state.announcedFor ? [...state.announcedFor] : undefined,
    unknownKey: state.unknownKey,
    ...(state.nwcRenewedHash !== undefined
      ? { nwcRenewedHash: state.nwcRenewedHash }
      : {}),
    ...(state.nwcFallbackKey !== undefined
      ? { nwcFallbackKey: state.nwcFallbackKey }
      : {}),
    ...(state.nwcRestoreNotified !== undefined
      ? { nwcRestoreNotified: state.nwcRestoreNotified }
      : {}),
  }
}

function sameState(a: NoticeState | null | undefined, b: NoticeState) {
  if (!a) return false
  return (
    a.publicKey === b.publicKey &&
    a.expiresAt === b.expiresAt &&
    a.sentFor === b.sentFor &&
    (a.seen ?? []).join(',') === (b.seen ?? []).join(',') &&
    (a.announcedFor ?? []).join(',') === (b.announcedFor ?? []).join(',') &&
    a.unknownKey === b.unknownKey &&
    a.nwcRenewedHash === b.nwcRenewedHash &&
    a.nwcFallbackKey === b.nwcFallbackKey &&
    a.nwcRestoreNotified === b.nwcRestoreNotified &&
    sentStages(a).join(',') === sentStages(b).join(',')
  )
}

export interface NoticeOps {
  /** null: TunnelSats is disabled or has no configuration. */
  readInputs: () => Promise<NoticeInputs | null>
  readState: () => Promise<NoticeState | null>
  writeState: (state: NoticeState) => Promise<void>
  notify: (notice: Notice) => Promise<void>
  now?: () => Date
}

export interface NoticeRunResult {
  posted: NoticeKind[]
  /** Why the run stopped early; null when it completed. */
  error: string | null
}

function message(e: unknown): string {
  return e instanceof Error ? e.message : String(e)
}

/**
 * Returns a run function for the health check. Runs are serialised (one
 * notice is never planned by two overlapping runs), never throw, and pause
 * for NOTICE_RETRY_MS after a failed post.
 */
export function createNoticeRunner(ops: NoticeOps) {
  const now = ops.now ?? (() => new Date())
  let tail: Promise<unknown> = Promise.resolve()
  let retryAt = 0
  /** A rollback whose write failed; written before anything else. */
  let unwrittenRollback: NoticeState | null = null

  async function once(): Promise<NoticeRunResult> {
    const posted: NoticeKind[] = []
    try {
      if (now().getTime() < retryAt) return { posted, error: null }
      if (unwrittenRollback) {
        await ops.writeState(unwrittenRollback)
        unwrittenRollback = null
      }
      const input = await ops.readInputs()
      if (!input) return { posted, error: null }
      const prev = await ops.readState()
      const plan = planNotifications(input, prev, now())
      if (plan.steps.length === 0) {
        if (!sameState(prev, plan.next)) await ops.writeState(plan.next)
        return { posted, error: null }
      }
      for (const step of plan.steps) {
        await ops.writeState(step.after)
        try {
          await ops.notify(step.notice)
        } catch (e) {
          retryAt = now().getTime() + NOTICE_RETRY_MS
          await ops.writeState(step.before).catch(() => {
            unwrittenRollback = step.before
          })
          return { posted, error: message(e) }
        }
        posted.push(step.notice.kind)
      }
      return { posted, error: null }
    } catch (e) {
      return { posted, error: message(e) }
    }
  }

  return function run(): Promise<NoticeRunResult> {
    const result = tail.then(once, once)
    tail = result
    return result
  }
}
