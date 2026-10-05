import { FileHelper, z } from '@start9labs/start-sdk'
import { sdk } from '../sdk'

const packageId = z.enum(['lnd', 'c-lightning', 'eclair'])

/**
 * Which node we last handed the tunnel to, which nodes still owe us a
 * confirmed "off", the public keys of the tunnels we handed out, and the
 * nodes whose task could not be raised (retried by the health check).
 * Written only by setDependencies (see startos/vpnHandoff.ts).
 */
export const vpnHandoffShape = z.object({
  activeTarget: packageId.nullable().catch(null),
  pendingOff: z.array(packageId).catch([]),
  handedOutKeys: z.array(z.string()).catch([]),
  unraised: z.array(packageId).catch([]),
  retryOwnTasks: z.boolean().catch(false),
})

export const vpnHandoff = FileHelper.json(
  { base: sdk.volumes.main, subpath: './vpn-handoff.json' },
  vpnHandoffShape,
)
