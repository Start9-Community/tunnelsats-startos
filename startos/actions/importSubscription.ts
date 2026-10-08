import { sdk } from '../sdk'
import { configJson } from '../fileModels/config.json'
import { tunnelsatsConf } from '../fileModels/tunnelsatsConf'
import { metaLockFor } from '../metaLock'
import {
  validateWireguardConfig,
  parseWireguardTunnelInfo,
  getAnnounceEndpoint,
} from '../utils'
import { i18n } from '../i18n'
import { derivePublicKey } from '../keygen'

const { InputSpec, Value } = sdk

const inputSpec = InputSpec.of({
  'target-node': Value.select({
    name: i18n('Target Lightning Node'),
    description: i18n(
      'The Lightning node on this server that runs the imported tunnel and announces its address to the network. That node asks you to activate the tunnel.\n- LND: Lightning Network Daemon from Lightning Labs\n- Core Lightning: Core Lightning from Blockstream\n- Eclair: Eclair from ACINQ',
    ),
    default: 'lnd',
    values: {
      lnd: 'LND',
      cln: 'Core Lightning',
      eclair: 'Eclair',
    },
  }),
  'tunnelsats-conf': Value.textarea({
    name: i18n('WireGuard Configuration'),
    description: i18n(
      'Paste the full contents of your TunnelSats .conf file here.',
    ),
    required: true,
    default: null,
    placeholder: `[Interface]\nPrivateKey = <your_private_key>\nAddress = 10.x.x.x/32\n# VPNPort: 12345\n...`,
  }),
  'allow-ipv6': Value.toggle({
    name: i18n('Allow IPv6 Endpoint'),
    description: i18n(
      'Allow handing your Lightning node an IPv6 TunnelSats server endpoint to announce, if your configuration uses one. The announced address is the TunnelSats server, not your home connection. This setting does not change how your node routes IPv6; that is decided by the Lightning node package.',
    ),
    default: false,
  }),
})

export const importSubscription = sdk.Action.withInput(
  'import-subscription',
  {
    name: i18n('Import Subscription'),
    description: i18n(
      'Import an existing TunnelSats WireGuard configuration file (.conf) and activate it on a Lightning node.',
    ),
    warning: null,
    allowedStatuses: 'any',
    group: i18n('Subscription'),
    visibility: 'enabled',
  },
  inputSpec,
  async ({ effects }) => {
    const current = await configJson
      .read()
      .once()
      .catch(() => null)
    return {
      'target-node': current?.['target-node'] ?? 'lnd',
      'tunnelsats-conf': current?.['tunnelsats-conf'] ?? undefined,
      'allow-ipv6': current?.['allow-ipv6'] ?? false,
    }
  },
  async ({ effects, input }) => {
    const validation = validateWireguardConfig(input['tunnelsats-conf'])
    if (!validation.valid) {
      throw new Error(validation.error || 'Invalid WireGuard configuration')
    }

    const tunnelInfo = parseWireguardTunnelInfo(input['tunnelsats-conf'])
    if (!tunnelInfo.privateKey) {
      throw new Error('WireGuard configuration is missing a PrivateKey')
    }

    let publicKey = i18n('Unknown')
    try {
      publicKey = derivePublicKey(tunnelInfo.privateKey)
    } catch (e) {
      console.warn('Failed to derive public key:', e)
    }

    const announceEndpoint = getAnnounceEndpoint(
      input['tunnelsats-conf'],
      input['allow-ipv6'],
    )
    if (!announceEndpoint) {
      throw new Error(
        i18n(
          'This configuration has no endpoint that can be announced to the Lightning Network (an IPv6 endpoint needs Allow IPv6 Endpoint).',
        ),
      )
    }

    // Under bridge.py's lock: its port rewrite (apply_vpn_port) replaces
    // config.json and the conf file, and must not interleave with this save.
    await metaLockFor(effects)(async () => {
      await configJson.merge(effects, {
        enabled: true,
        'target-node': input['target-node'],
        'tunnelsats-conf': input['tunnelsats-conf'],
        'allow-ipv6': input['allow-ipv6'],
      })
      await tunnelsatsConf.write(effects, input['tunnelsats-conf'])
    })

    // The clearnet-vpn task (and the off-task for a previously targeted
    // node) is raised by handoffInit, which reacts to this config write.

    return {
      version: '1' as const,
      title: i18n('Subscription Imported'),
      message: i18n(
        'WireGuard configuration saved. Your Lightning node will ask you to activate the VPN tunnel. If TunnelSats routed a different node before, that node first asks you to turn its tunnel off.',
      ),
      result: {
        type: 'group' as const,
        value: [
          {
            name: i18n('Public Key'),
            description: null,
            type: 'single' as const,
            value: publicKey,
            copyable: true,
            masked: false,
            qr: false,
          },
          {
            name: i18n('Announce Endpoint'),
            description: null,
            type: 'single' as const,
            value: announceEndpoint || i18n('Not available'),
            copyable: true,
            masked: false,
            qr: false,
          },
        ],
      },
    }
  },
)
