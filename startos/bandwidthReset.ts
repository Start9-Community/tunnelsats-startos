/**
 * Bandwidth reset: when the Reset Bandwidth action is offered, and the
 * reuse-or-request decision it makes. I/O is injected (ResetOps) so the
 * decision runs unchanged in tests; the action only wires StartOS to it.
 *
 * Every reset request reserves one of the monthly resets (2 by default)
 * until its invoice expires, so a still-payable invoice is shown again
 * instead of requesting another.
 */
import type { BandwidthResetOrder, ResetState } from './apiClient'
import { runPaymentExclusive, recordThenRaise } from './settlement'
import type { TargetNode } from './settlement'

/** The fields of meta.pendingReset this module reads. */
export interface PendingReset {
  paymentHash: string
  invoice: string
  expiresAt?: string
  publicKey: string
  targetNode: TargetNode
}

/**
 * The pending reset whose invoice can be shown again: bought for this key
 * and not yet past its expiry. Without a valid expiry it is never reused
 * (the backend returns one; its absence means bad data).
 */
export function reusablePendingReset(
  pending: PendingReset | null | undefined,
  publicKey: string,
  now: Date,
): PendingReset | null {
  if (!pending || pending.publicKey !== publicKey) return null
  const expires = pending.expiresAt ? Date.parse(pending.expiresAt) : NaN
  if (!Number.isFinite(expires)) return null
  return expires > now.getTime() ? pending : null
}

export type ResetAvailability =
  { available: true } | { available: false; reason: 'no-config' }

/**
 * Whether to offer the action. It is only withheld when no subscription key
 * is configured; live usage is checked by the TunnelSats API when the action
 * runs (cached usage in tunnelsats.meta.json can be up to 24h old between
 * background syncs).
 */
export function resetAvailability(publicKey: string | null): ResetAvailability {
  if (!publicKey) return { available: false, reason: 'no-config' }
  return { available: true }
}

/** What runBandwidthReset needs from StartOS and the API. */
export interface ResetOps {
  now(): Date
  /**
   * A fresh read of meta.pendingReset and the pay-task queue. Must throw on
   * a read error: taking it for "nothing pending" would request (and
   * reserve) another reset while an invoice is still payable.
   */
  readCurrent(): Promise<{
    pending?: PendingReset | null
    payTasksToClear?: string[]
  } | null>
  fetchStatus(paymentHash: string): Promise<ResetState>
  requestReset(): Promise<BandwidthResetOrder>
  /** Writes meta.pendingReset for `order`, together with `patch`. */
  record(
    order: BandwidthResetOrder,
    patch: { payTasksToClear?: string[] },
  ): Promise<unknown>
  /** Raises (or raises again: same replay ID) the pay task. */
  raiseTask(task: {
    invoice: string
    paymentHash: string
    targetNode: TargetNode
  }): Promise<unknown>
  /** The node a new reset's pay task goes to. */
  targetNode: TargetNode
}

export type ResetRunResult =
  | { kind: 'reused'; pending: PendingReset }
  | { kind: 'requested'; order: BandwidthResetOrder }
  | { kind: 'already-paid'; paymentHash: string }

export class ResetFailedError extends Error {
  constructor(readonly paymentHash: string) {
    super(
      `The payment was received, but the bandwidth reset failed. Contact TunnelSats support with payment hash ${paymentHash}.`,
    )
    this.name = 'ResetFailedError'
  }
}

function hasExpired(pending: PendingReset, now: Date): boolean {
  const expires = pending.expiresAt ? Date.parse(pending.expiresAt) : NaN
  return Number.isFinite(expires) && now.getTime() >= expires
}

/**
 * Checks any pending reset first so a paid, processing, or failed reset
 * (even for a previous key awaiting its settlement tick) is never replaced,
 * and a still-payable invoice for this key is shown again; otherwise
 * requests a new reset and records it before raising its pay task. The
 * whole decision runs in the payment queue, so two runs cannot both
 * request a reset (each would reserve a monthly slot).
 */
export function runBandwidthReset(
  publicKey: string,
  ops: ResetOps,
): Promise<ResetRunResult> {
  return runPaymentExclusive(async () => {
    const current = await ops.readCurrent()
    const pending = current?.pending ?? null
    if (pending) {
      const state = await ops.fetchStatus(pending.paymentHash)
      switch (state) {
        case 'unpaid': {
          const now = ops.now()
          const reusable = reusablePendingReset(pending, publicKey, now)
          if (reusable) {
            await ops.raiseTask({
              invoice: reusable.invoice,
              paymentHash: reusable.paymentHash,
              targetNode: reusable.targetNode,
            })
            return { kind: 'reused', pending: reusable }
          }
          if (!hasExpired(pending, now)) {
            throw new Error(
              'A bandwidth reset invoice for the previous subscription is still pending; wait for it to settle or expire',
            )
          }
          break
        }
        case 'processing':
        case 'paid':
          // Settlement clears it; paying again or replacing it before the
          // tick runs would lose the settlement outcome.
          return { kind: 'already-paid', paymentHash: pending.paymentHash }
        case 'failed':
          throw new ResetFailedError(pending.paymentHash)
        case 'unknown':
          if (!hasExpired(pending, ops.now())) {
            throw new Error(
              'The TunnelSats API has no record of this bandwidth reset',
            )
          }
          break
        case 'expired':
          // Nothing payable remains; a new request replaces it below.
          break
      }
    }

    const order = await ops.requestReset()
    await recordThenRaise('reset', order.paymentHash, {
      readCurrent: ops.readCurrent,
      record: (patch) => ops.record(order, patch),
      raiseTask: () =>
        ops.raiseTask({
          invoice: order.invoice,
          paymentHash: order.paymentHash,
          targetNode: ops.targetNode,
        }),
    })
    return { kind: 'requested', order }
  })
}
