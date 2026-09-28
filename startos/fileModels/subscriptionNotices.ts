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
    unknownKey: z.string().optional().catch(undefined),
  }),
)
