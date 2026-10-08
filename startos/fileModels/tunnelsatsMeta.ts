import { FileHelper, z } from '@start9labs/start-sdk'
import { sdk } from '../sdk'

export const pendingOrderShape = z.looseObject({
  paymentHash: z.string(),
  orderId: z.string(),
  privateKey: z.string(),
  publicKey: z.string(),
  targetNode: z.enum(['lnd', 'cln', 'eclair']),
  serverId: z.string(),
  createdAt: z.string(),
  duration: z.number().optional().catch(undefined),
  invoice: z.string().optional().catch(undefined),
  amountSats: z.number().optional().catch(undefined),
  expiresAt: z.string().optional().catch(undefined),
  paymentReceivedFor: z.string().optional().catch(undefined),
  /** Set by the settlement tick (bridge.py) after a failed attempt. */
  lastError: z.string().optional().catch(undefined),
  nextAttemptAt: z.string().optional().catch(undefined),
})

export const metaShape = z.looseObject({
  expiresAt: z.string().optional(),
  /**
   * 'api' only when `expiresAt` came from `subscription/status` for
   * `publicKey`. Anything else (legacy or comment-derived) is unconfirmed.
   */
  expirySource: z.literal('api').optional().catch(undefined),
  publicKey: z.string().optional().catch(undefined),
  lastSync: z.string().optional(),
  syncSuccess: z.boolean().optional(),
  syncError: z.string().optional().nullable(),
  serverDomain: z.string().optional(),
  vpnPort: z.number().optional(),
  bandwidth_used_gb: z.number().optional(),
  /**
   * The monthly quota from `subscription/status` for `publicKey`, written by
   * bridge.py lazy_sync only; dropped with the other confirmed fields.
   */
  bandwidth_limit_gb: z.number().optional().catch(undefined),
  bandwidth_resets_this_month: z.number().optional().catch(undefined),
  max_resets_per_month: z.number().optional().catch(undefined),
  /**
   * Set by bridge.py when the API has no subscription for `publicKey`
   * (see _record_not_found); only meaningful for that key.
   */
  keyUnknown: z.boolean().optional().catch(undefined),
  /** First "not found" answer since the last confirmation (bridge.py). */
  notFoundSince: z.string().optional().catch(undefined),
  /** Public key of the last settled purchase (bridge.py save_configuration). */
  provisionedKey: z.string().optional().catch(undefined),
  pendingOrder: pendingOrderShape.optional().nullable(),
  /**
   * Replaced pending orders, retained so bridge.py can still claim an
   * earlier invoice the operator pays. An entry and its key stay until the
   * settlement watcher retires it: claimed once paid, or reported unpaid
   * (or unknown) by a status check after its invoice expired. Never evicted
   * to make room.
   */
  previousPendingOrders: z.array(pendingOrderShape).optional().catch(undefined),
  /**
   * WireGuard configurations of paid replaced orders, claimed by bridge.py
   * and keyed by payment hash. Export WireGuard Configuration lists them;
   * never served to the dashboard.
   */
  recoveredOrderConfigs: z
    .record(z.string(), z.string())
    .optional()
    .catch(undefined),
  /**
   * The latest paid replaced order bridge.py recovered without replacing
   * the active tunnel; drives the one-time recovered-order notice.
   */
  lastRecoveredOrder: z
    .looseObject({
      paymentHash: z.string(),
      recoveredAt: z.string().optional().catch(undefined),
    })
    .optional()
    .catch(undefined),
  pendingRenewal: z
    .looseObject({
      paymentHash: z.string(),
      renewalId: z.string(),
      oldExpiry: z.string(),
      newExpiry: z.string(),
      createdAt: z.string(),
      duration: z.number().optional().catch(undefined),
      invoice: z.string().optional().catch(undefined),
      amountSats: z.number().optional().catch(undefined),
      expiresAt: z.string().optional().catch(undefined),
      paymentReceivedFor: z.string().optional().catch(undefined),
      /** The key the renewal was paid for; absent on older renewals. */
      publicKey: z.string().optional().catch(undefined),
      /** The node its pay task was raised on; absent on older renewals. */
      targetNode: z.enum(['lnd', 'cln', 'eclair']).optional().catch(undefined),
      lastError: z.string().optional().catch(undefined),
      nextAttemptAt: z.string().optional().catch(undefined),
      /** True when paid automatically via NWC. */
      paidViaNwc: z.boolean().optional().catch(undefined),
      /** True when an NWC pay_invoice attempt has been dispatched for this invoice. */
      nwcAttempted: z.boolean().optional().catch(undefined),
      /** ISO timestamp until which an in-flight NWC pay_invoice holds the renewal. */
      nwcPayInFlightUntil: z.string().optional().catch(undefined),
      /** True when NWC fell back and the node's Pay Invoice task must be raised. */
      raisePayTask: z.boolean().optional().catch(undefined),
    })
    .optional()
    .nullable(),
  /**
   * A bandwidth reset bought with the Reset Bandwidth action, settled by the
   * settlement tick. The invoice is kept so the action can show it again
   * instead of requesting another reset: each request reserves one of the
   * monthly resets until its invoice expires.
   */
  pendingReset: z
    .looseObject({
      paymentHash: z.string(),
      resetId: z.string(),
      invoice: z.string(),
      /** When the invoice expires (from the API); absent on older backends. */
      expiresAt: z.string().optional().catch(undefined),
      createdAt: z.string(),
      /** The key the reset was bought for. */
      publicKey: z.string(),
      serverId: z.string(),
      targetNode: z.enum(['lnd', 'cln', 'eclair']),
      amountSats: z.number().optional().catch(undefined),
      paymentReceivedFor: z.string().optional().catch(undefined),
      lastError: z.string().optional().catch(undefined),
      nextAttemptAt: z.string().optional().catch(undefined),
    })
    .optional()
    .nullable(),
  /**
   * Replay IDs of pay tasks whose payment is settled, expired or replaced by
   * a newer Buy/Renew, queued (by bridge.py or the purchase actions) until
   * the settlement health check has cleared them.
   */
  payTasksToClear: z.array(z.string()).optional().catch(undefined),
  /**
   * Duration in months (1, 3, 6, 12) of the last paid Buy/Renew, recorded by
   * bridge.py once its payment is received (never for an unpaid invoice).
   * NWC's Match Last Purchase renews this duration.
   */
  lastDuration: z.number().optional().catch(undefined),
  /**
   * Satoshi amount of the last paid Buy/Renew, recorded with lastDuration.
   * Bounds what NWC pays unattended and sizes the 1.2x budget guidance.
   */
  lastAmountSats: z.number().optional().catch(undefined),
  /** Non-secret NWC status mirrored from nwc-wallet.json. */
  nwcConnected: z.boolean().optional().catch(undefined),
  nwcRelayHost: z.string().optional().catch(undefined),
  nwcRouteViaTor: z.boolean().optional().catch(undefined),
  nwcAutoRenewDuration: z
    .enum(['match', '1m', '3m', '6m', '12m'])
    .optional()
    .catch(undefined),
  /** NWC auto-renewal state machine persisted by bridge.py under meta_lock. */
  nwcAutoRenewState: z
    .looseObject({
      periodExpiry: z.string().optional().catch(undefined),
      attempts: z.number().optional().catch(undefined),
      lastAttemptAt: z.string().optional().catch(undefined),
      nextAttemptAt: z.string().optional().catch(undefined),
      lastError: z.string().optional().catch(undefined),
      lastErrorCode: z.string().optional().catch(undefined),
      fallbackTaskRaised: z.boolean().optional().catch(undefined),
      budgetWarning: z.boolean().optional().catch(undefined),
      remainingBudgetSats: z.number().optional().catch(undefined),
      requiredSats: z.number().optional().catch(undefined),
      restoreReconnectNeeded: z.boolean().optional().catch(undefined),
      lastPaidHash: z.string().optional().catch(undefined),
      lastPaidAt: z.string().optional().catch(undefined),
      lastPaidDuration: z.number().optional().catch(undefined),
      lastPaidAmountSats: z.number().optional().catch(undefined),
      lastPaidNewExpiry: z.string().optional().catch(undefined),
    })
    .optional()
    .nullable()
    .catch(undefined),
})

export const tunnelsatsMeta = FileHelper.json(
  { base: sdk.volumes.main, subpath: './tunnelsats-meta.json' },
  metaShape,
)
