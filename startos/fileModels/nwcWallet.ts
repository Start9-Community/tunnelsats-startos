import { FileHelper, z } from '@start9labs/start-sdk'
import { sdk } from '../sdk'

export const nwcWalletShape = z.looseObject({
  uri: z.string(),
  relayHost: z.string(),
  routeViaTor: z.boolean(),
  autoRenewDuration: z
    .enum(['match', '1m', '3m', '6m', '12m'])
    .optional()
    .catch('match'),
  updatedAt: z.string(),
})

export type NwcWalletRecord = z.infer<typeof nwcWalletShape>

/**
 * Isolated secret file for the connected NWC URI (/data/nwc-wallet.json).
 * Excluded from StartOS backups and never read by the web dashboard or
 * Export WireGuard Configuration action.
 */
export const nwcWallet = FileHelper.json(
  { base: sdk.volumes.main, subpath: './nwc-wallet.json' },
  nwcWalletShape,
)
