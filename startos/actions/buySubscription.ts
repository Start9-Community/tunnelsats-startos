import { T } from '@start9labs/start-sdk'
import { sdk } from '../sdk'
import { tunnelsatsMeta } from '../fileModels/tunnelsatsMeta'
import { metaLockFor, type MetaLock } from '../metaLock'
import { i18n } from '../i18n'
import { generateWireguardKeypair } from '../keygen'
import {
  bolt11AmountSats,
  createSubscriptionOrder,
  type SubscriptionOrder,
} from '../apiClient'
import {
  NothingToResumeError,
  payTaskReplayId,
  recordThenRaise,
  runPaymentExclusive,
  type TargetNode,
} from '../settlement'
import { resolvePayInvoice } from './resolvePayInvoice'
import { defaultServerRegion, loadServerRegions } from '../serverRegions'

export const INVOICE_TTL_MS = 60 * 60 * 1000
export const VALID_DURATIONS = [1, 3, 6, 12] as const

export interface PendingOrderRecord {
  paymentHash: string
  orderId: string
  privateKey: string
  publicKey: string
  targetNode: TargetNode
  serverId: string
  createdAt: string
  duration?: number
  invoice?: string
  amountSats?: number
  expiresAt?: string
  paymentReceivedFor?: string
}

export interface PurchaseInput {
  targetNode: TargetNode
  serverRegion: string
  duration: number
  /**
   * Dashboard intents: never replace a still-payable order. An identical
   * request reuses it (and raises its Pay Invoice task again); a different
   * one fails with PendingPaymentConflictError. The Buy action leaves this
   * unset: the operator may replace a payable order.
   */
  keepPayable?: boolean
  /**
   * A dashboard request resumed after StartOS restarted mid-request, past
   * the dashboard TTL: only the invoice it already recorded (or its paid
   * state) may be returned; a new invoice is never created for it.
   */
  reuseOnly?: boolean
}

/**
 * A dashboard request that would replace a still-payable invoice of the same
 * kind. Only an operator-authenticated StartOS action may do that.
 */
export class PendingPaymentConflictError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'PendingPaymentConflictError'
  }
}

/** " until <ISO time>", or "" when the pending record has no usable time. */
export function untilText(untilMs: number): string {
  return Number.isFinite(untilMs)
    ? ` until ${new Date(untilMs).toISOString()}`
    : ''
}

export interface PurchaseOps {
  now(): Date
  /** The cross-runtime metadata lock around the record (metaLockFor). */
  lockMeta: MetaLock
  readCurrent(): Promise<{
    pending?: PendingOrderRecord | null
    payTasksToClear?: string[]
  } | null>
  generateKeypair(): { privateKey: string; publicKey: string }
  createOrder(params: {
    serverId: string
    duration: number
    wgPublicKey: string
  }): Promise<SubscriptionOrder>
  record(
    entry: PendingOrderRecord,
    patch: { payTasksToClear?: string[] },
  ): Promise<unknown>
  raiseTask(task: {
    invoice: string
    paymentHash: string
    amountSats: number
    targetNode: TargetNode
  }): Promise<unknown>
}

export type PurchaseRunResult =
  | {
      kind: 'created'
      order: SubscriptionOrder & { expiresAt: string }
      targetNode: TargetNode
    }
  | {
      kind: 'reused'
      order: SubscriptionOrder & { expiresAt: string }
      targetNode: TargetNode
    }
  | {
      kind: 'already-paid'
      paymentHash: string
      targetNode: TargetNode
    }

/**
 * The expiry (epoch ms) of an unpaid invoice that can still be paid, or
 * null. Without a stored expiry the invoice counts as valid for
 * INVOICE_TTL_MS after createdAt.
 */
export function payableUntil(
  pending:
    | {
        paymentHash?: string
        invoice?: string
        paymentReceivedFor?: string
        createdAt: string
        expiresAt?: string
      }
    | null
    | undefined,
  now: Date,
): number | null {
  if (!pending || !pending.paymentHash || !pending.invoice) return null
  if (pending.paymentReceivedFor === pending.paymentHash) return null
  const createdMs = Date.parse(pending.createdAt)
  const expiresMs = pending.expiresAt
    ? Date.parse(pending.expiresAt)
    : Number.isFinite(createdMs)
      ? createdMs + INVOICE_TTL_MS
      : NaN
  if (!Number.isFinite(expiresMs) || expiresMs <= now.getTime()) return null
  return expiresMs
}

/**
 * Until when (epoch ms) an unpaid pending payment may still be paid, whether
 * or not its invoice was stored: records written before invoices were kept
 * have none, yet their invoice can still be paid on the node. Returns
 * Infinity when the record has no usable time (fail closed), null when
 * nothing unpaid is pending or it has expired. Paid records return null;
 * callers check paymentReceivedFor separately.
 */
export function unsettledUntil(
  pending:
    | {
        paymentHash?: string
        paymentReceivedFor?: string
        createdAt?: string
        expiresAt?: string
      }
    | null
    | undefined,
  now: Date,
): number | null {
  if (!pending || !pending.paymentHash) return null
  if (pending.paymentReceivedFor === pending.paymentHash) return null
  const createdMs = pending.createdAt ? Date.parse(pending.createdAt) : NaN
  const expiresMs = pending.expiresAt
    ? Date.parse(pending.expiresAt)
    : createdMs + INVOICE_TTL_MS
  if (!Number.isFinite(expiresMs)) return Number.POSITIVE_INFINITY
  return expiresMs > now.getTime() ? expiresMs : null
}

/** A payable pending order for exactly this server, plan and node, or null. */
export function reusablePendingOrder(
  pending: PendingOrderRecord | null | undefined,
  input: PurchaseInput,
  now: Date,
): (PendingOrderRecord & { invoice: string; expiresAt: string }) | null {
  const expiresMs = payableUntil(pending, now)
  if (!pending || expiresMs === null || !pending.invoice) return null
  if (
    pending.serverId !== input.serverRegion ||
    pending.duration !== input.duration ||
    pending.targetNode !== input.targetNode
  ) {
    return null
  }
  return {
    ...pending,
    invoice: pending.invoice,
    expiresAt: new Date(expiresMs).toISOString(),
  }
}

export function runPurchase(
  input: PurchaseInput,
  ops: PurchaseOps,
): Promise<PurchaseRunResult> {
  if (!VALID_DURATIONS.includes(input.duration as 1 | 3 | 6 | 12)) {
    return Promise.reject(
      new Error(`Invalid subscription duration: ${String(input.duration)}`),
    )
  }
  if (!['lnd', 'cln', 'eclair'].includes(input.targetNode)) {
    return Promise.reject(
      new Error(`Unsupported target node: ${String(input.targetNode)}`),
    )
  }
  if (!input.serverRegion || typeof input.serverRegion !== 'string') {
    return Promise.reject(new Error('Invalid server region'))
  }

  return runPaymentExclusive(async () => {
    const current = await ops.readCurrent()
    const pending = current?.pending ?? null
    if (
      pending &&
      pending.paymentReceivedFor === pending.paymentHash &&
      input.keepPayable
    ) {
      // Paid, not claimed yet: the settlement watcher finishes it. Only the
      // same selection is that payment; any other request would be marked
      // done without an invoice for what was asked.
      if (
        pending.serverId !== input.serverRegion ||
        pending.duration !== input.duration ||
        pending.targetNode !== input.targetNode
      ) {
        throw new PendingPaymentConflictError(
          `A subscription payment (${pending.serverId}, ${pending.duration ?? '?'} month(s), ${pending.targetNode}) was received and is still being set up. Try again once it has finished.`,
        )
      }
      return {
        kind: 'already-paid',
        paymentHash: pending.paymentHash,
        targetNode: pending.targetNode,
      }
    }

    const now = ops.now()
    const reusable = reusablePendingOrder(pending, input, now)
    if (reusable) {
      const amountSats =
        reusable.amountSats ?? bolt11AmountSats(reusable.invoice) ?? 0
      // Raised again under the same replay ID: recovers a task that failed
      // to raise, and is a no-op for one that exists.
      await ops.raiseTask({
        invoice: reusable.invoice,
        paymentHash: reusable.paymentHash,
        amountSats,
        targetNode: reusable.targetNode,
      })
      return {
        kind: 'reused',
        order: {
          invoice: reusable.invoice,
          paymentHash: reusable.paymentHash,
          amountSats,
          orderId: reusable.orderId,
          expiresAt: reusable.expiresAt,
        },
        targetNode: reusable.targetNode,
      }
    }
    const otherPayableUntil = unsettledUntil(pending, now)
    if (input.keepPayable && pending && otherPayableUntil !== null) {
      throw new PendingPaymentConflictError(
        `An unpaid subscription invoice (${pending.serverId}, ${pending.duration ?? '?'} month(s), ${pending.targetNode}) is still payable${untilText(otherPayableUntil)}. Pay it, or replace it with the Buy Subscription action in StartOS.`,
      )
    }
    if (input.reuseOnly) throw new NothingToResumeError()

    const keypair = ops.generateKeypair()
    const order = await ops.createOrder({
      serverId: input.serverRegion,
      duration: input.duration,
      wgPublicKey: keypair.publicKey,
    })
    const createdNow = ops.now()
    const expiresAt =
      order.expiresAt && !Number.isNaN(Date.parse(order.expiresAt))
        ? new Date(order.expiresAt).toISOString()
        : new Date(createdNow.getTime() + INVOICE_TTL_MS).toISOString()
    const entry: PendingOrderRecord = {
      paymentHash: order.paymentHash,
      orderId: order.orderId,
      privateKey: keypair.privateKey,
      publicKey: keypair.publicKey,
      targetNode: input.targetNode,
      serverId: input.serverRegion,
      createdAt: createdNow.toISOString(),
      duration: input.duration,
      invoice: order.invoice,
      amountSats: order.amountSats,
      expiresAt,
    }

    await recordThenRaise('order', order.paymentHash, {
      lockMeta: ops.lockMeta,
      readCurrent: ops.readCurrent,
      record: (patch) => ops.record(entry, patch),
      raiseTask: () =>
        ops.raiseTask({
          invoice: order.invoice,
          paymentHash: order.paymentHash,
          amountSats: order.amountSats,
          targetNode: input.targetNode,
        }),
    })

    return {
      kind: 'created',
      order: { ...order, expiresAt },
      targetNode: input.targetNode,
    }
  })
}

export function startPurchase(
  effects: T.Effects,
  input: PurchaseInput,
  opsOverride?: Partial<PurchaseOps>,
): Promise<PurchaseRunResult> {
  const defaultOps: PurchaseOps = {
    now: () => new Date(),
    lockMeta: metaLockFor(effects),
    readCurrent: async () => {
      const current = await tunnelsatsMeta.read().once()
      return (
        current && {
          pending: current.pendingOrder,
          payTasksToClear: current.payTasksToClear,
        }
      )
    },
    generateKeypair: () => generateWireguardKeypair(),
    createOrder: (params) => createSubscriptionOrder(params),
    record: (entry, patch) =>
      tunnelsatsMeta.merge(effects, {
        pendingOrder: {
          ...entry,
          // merge() is a deep merge: without these, a backoff or received
          // marker left by an earlier order would carry over to this one.
          paymentReceivedFor: undefined,
          lastError: undefined,
          nextAttemptAt: undefined,
        },
        ...patch,
      }),
    raiseTask: ({ invoice, paymentHash, amountSats, targetNode }) => {
      const { packageId, payInvoiceAction } = resolvePayInvoice(targetNode)
      return sdk.action.createTask(
        effects,
        packageId,
        payInvoiceAction,
        'important',
        {
          // The settlement health check clears the task under this ID once the
          // order is settled or expired.
          replayId: payTaskReplayId('order', targetNode, paymentHash),
          input: {
            kind: 'partial',
            accept: [],
            set: {
              invoice,
              amount: { selection: 'invoice', value: {} },
              'max-fee-percent': 1,
              confirmed: false,
            },
          },
          reason: i18n(
            'Pay TunnelSats VPN subscription invoice (${amount} sats)',
            {
              amount: String(amountSats),
            },
          ),
        },
      )
    },
  }
  return runPurchase(input, { ...defaultOps, ...opsOverride })
}

const { InputSpec, Value } = sdk

export const inputSpec = InputSpec.of({
  'target-node': Value.select({
    name: i18n('Target Lightning Node'),
    description: i18n(
      'Select which Lightning node will pay the invoice and receive inbound connections.',
    ),
    default: 'lnd',
    values: {
      lnd: 'LND',
      cln: 'Core Lightning',
      eclair: 'Eclair',
    },
  }),
  // The regions TunnelSats offers right now, or the static list when the
  // API cannot be reached (see serverRegions.ts).
  'server-region': Value.dynamicSelect(async () => {
    const values = await loadServerRegions()
    return {
      name: i18n('Server Region'),
      description: i18n(
        'Select the geographic region for your VPN tunnel endpoint.',
      ),
      default: defaultServerRegion(values),
      values,
    }
  }),
  duration: Value.select({
    name: i18n('Subscription Duration'),
    description: i18n('Choose how long the subscription should last.'),
    default: '1',
    values: {
      '1': '1 Month',
      '3': '3 Months',
      '6': '6 Months',
      '12': '12 Months',
    },
  }),
})

export const buySubscription = sdk.Action.withInput(
  'buy-subscription',
  {
    name: i18n('Buy Subscription'),
    description: i18n(
      'Purchase a new TunnelSats VPN subscription with Lightning. Generates a secure keypair on-device and raises a payment task on your Lightning node.',
    ),
    warning: null,
    allowedStatuses: 'only-running',
    group: i18n('Subscription'),
    visibility: 'enabled',
  },
  inputSpec,
  async ({ effects }) => ({}),
  async ({ effects, input }) => {
    const outcome = await startPurchase(effects, {
      targetNode: input['target-node'],
      serverRegion: input['server-region'],
      duration: parseInt(input.duration, 10),
    })

    if (outcome.kind === 'already-paid') {
      return {
        version: '1' as const,
        title: i18n('Invoice Created'),
        message: i18n(
          'A payment task has been raised on your Lightning node. You can also pay manually using the invoice below. Once payment is confirmed, the VPN tunnel will be activated automatically.',
        ),
        result: {
          name: i18n('Payment Hash'),
          description: null,
          type: 'single' as const,
          value: outcome.paymentHash,
          copyable: true,
          masked: false,
          qr: false,
        },
      }
    }

    const { order } = outcome
    return {
      version: '1' as const,
      title: i18n('Invoice Created'),
      message: i18n(
        'A payment task has been raised on your Lightning node. You can also pay manually using the invoice below. Once payment is confirmed, the VPN tunnel will be activated automatically.',
      ),
      result: {
        type: 'group' as const,
        value: [
          {
            name: i18n('BOLT11 Invoice'),
            description: null,
            type: 'single' as const,
            value: order.invoice,
            copyable: true,
            masked: false,
            qr: true,
          },
          {
            name: i18n('Amount'),
            description: null,
            type: 'single' as const,
            value: `${order.amountSats} sats`,
            copyable: false,
            masked: false,
            qr: false,
          },
          {
            name: i18n('Payment Hash'),
            description: null,
            type: 'single' as const,
            value: order.paymentHash,
            copyable: true,
            masked: false,
            qr: false,
          },
        ],
      },
    }
  },
)
