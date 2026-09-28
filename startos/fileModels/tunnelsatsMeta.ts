import { FileHelper, z } from '@start9labs/start-sdk'
import { sdk } from '../sdk'

export const metaShape = z.object({
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
   * Set by bridge.py when the API has no subscription for `publicKey`
   * (see _record_not_found); only meaningful for that key.
   */
  keyUnknown: z.boolean().optional().catch(undefined),
  /** First "not found" answer since the last confirmation (bridge.py). */
  notFoundSince: z.string().optional().catch(undefined),
  /** Public key of the last settled purchase (bridge.py save_configuration). */
  provisionedKey: z.string().optional().catch(undefined),
  pendingOrder: z
    .object({
      paymentHash: z.string(),
      orderId: z.string(),
      privateKey: z.string(),
      publicKey: z.string(),
      targetNode: z.enum(['lnd', 'cln', 'eclair']),
      serverId: z.string(),
      createdAt: z.string(),
      /** Set by the settlement tick (bridge.py) after a failed attempt. */
      lastError: z.string().optional().catch(undefined),
      nextAttemptAt: z.string().optional().catch(undefined),
    })
    .optional()
    .nullable(),
  pendingRenewal: z
    .object({
      paymentHash: z.string(),
      renewalId: z.string(),
      oldExpiry: z.string(),
      newExpiry: z.string(),
      createdAt: z.string(),
      /** The key the renewal was paid for; absent on older renewals. */
      publicKey: z.string().optional().catch(undefined),
      /** The node its pay task was raised on; absent on older renewals. */
      targetNode: z.enum(['lnd', 'cln', 'eclair']).optional().catch(undefined),
      lastError: z.string().optional().catch(undefined),
      nextAttemptAt: z.string().optional().catch(undefined),
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
    .object({
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
})

export const tunnelsatsMeta = FileHelper.json(
  { base: sdk.volumes.main, subpath: './tunnelsats-meta.json' },
  metaShape,
)
