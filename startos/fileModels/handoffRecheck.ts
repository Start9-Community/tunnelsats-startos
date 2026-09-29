import { FileHelper, z } from '@start9labs/start-sdk'
import { sdk } from '../sdk'

/**
 * Written by the VPN handoff health check when a pending node turned off
 * without a status change; setDependencies watches it and re-runs. The value
 * only needs to change.
 */
export const handoffRecheck = FileHelper.json(
  { base: sdk.volumes.main, subpath: './handoff-recheck.json' },
  z.object({ requestedAt: z.string().catch('') }),
)
