import { FileHelper, z } from '@start9labs/start-sdk'
import { sdk } from '../sdk'

/**
 * Which subscription notices were sent (see notifications.ts). Written only
 * by the Subscription health check; nothing watches it.
 */
export const subscriptionNotices = FileHelper.json(
  { base: sdk.volumes.main, subpath: './subscription-notices.json' },
  z.object({
    publicKey: z.string().optional().catch(undefined),
    expiresAt: z.string().optional().catch(undefined),
    /** Unknown entries are ignored by the planner, never read as sent. */
    sent: z.array(z.string()).optional().catch(undefined),
    sentFor: z.string().optional().catch(undefined),
    /** Earlier expiries of the current period (notifications.ts, #100). */
    seen: z.array(z.string()).optional().catch(undefined),
    announcedFor: z.array(z.string()).optional().catch(undefined),
    unknownKey: z.string().optional().catch(undefined),
    nwcRenewedHash: z.string().optional().catch(undefined),
    nwcFallbackKey: z.string().optional().catch(undefined),
    nwcRestoreNotified: z.boolean().optional().catch(undefined),
    recoveredOrderHash: z.string().optional().catch(undefined),
  }),
)
