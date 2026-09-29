import { FileHelper, z } from '@start9labs/start-sdk'
import { sdk } from '../sdk'

export const shape = z.object({
  enabled: z.boolean().catch(false),
  'target-node': z.enum(['lnd', 'cln', 'eclair']).catch('lnd'),
  'tunnelsats-conf': z.string().optional().catch(undefined),
  'allow-ipv6': z.boolean().catch(false),
})

export const configJson = FileHelper.json(
  { base: sdk.volumes.main, subpath: './config.json' },
  shape,
)
