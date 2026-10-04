import { sdk } from '../sdk'
import { tunnelsatsConf } from '../fileModels/tunnelsatsConf'
import { configJson } from '../fileModels/config.json'
import { tunnelsatsMeta } from '../fileModels/tunnelsatsMeta'
import { i18n } from '../i18n'
import { parseWireguardTunnelInfo } from '../utils'

export const exportConfig = sdk.Action.withoutInput(
  'export-config',
  {
    name: i18n('Export WireGuard Configuration'),
    description: i18n(
      'View and export active and recovered TunnelSats WireGuard configurations (.conf).',
    ),
    warning: null,
    allowedStatuses: 'any',
    group: null,
    visibility: 'enabled',
  },
  async ({ effects }) => {
    let conf: string | null | undefined = await tunnelsatsConf
      .read()
      .once()
      .catch(() => null)

    if (!conf || !conf.trim()) {
      const config = await configJson
        .read()
        .once()
        .catch(() => null)
      conf = config?.['tunnelsats-conf'] ?? null
    }

    const recovered = await tunnelsatsMeta
      .read((meta) => meta.recoveredOrderConfigs)
      .once()
      .catch(() => null)

    // A recovered order that became the active tunnel stays recorded (it is
    // kept before activation, so a crash cannot lose it); list it once, as
    // the active configuration.
    const activeKey = parseWireguardTunnelInfo(conf).privateKey
    const recoveredEntries = Object.entries(recovered ?? {}).filter(
      ([, value]) =>
        !activeKey || parseWireguardTunnelInfo(value).privateKey !== activeKey,
    )

    if (recoveredEntries.length > 0) {
      return {
        version: '1' as const,
        title: i18n('WireGuard Configuration'),
        message: i18n(
          'Recovered configurations belong to paid replaced orders. Import one to activate it. Keep all private keys confidential.',
        ),
        result: {
          type: 'group' as const,
          value: [
            ...(conf?.trim()
              ? [{ name: i18n('Active WireGuard Configuration'), value: conf }]
              : []),
            ...recoveredEntries.map(([hash, value]) => ({
              name: i18n('Recovered Order') + ' ' + hash,
              value,
            })),
          ].map((entry) => ({
            ...entry,
            description: null,
            type: 'single' as const,
            copyable: true,
            masked: true,
            qr: false,
          })),
        },
      }
    }

    if (!conf || !conf.trim()) {
      return {
        version: '1' as const,
        title: i18n('No Configuration Found'),
        message: i18n(
          'No active WireGuard configuration found. Please purchase a subscription or configure a tunnel first.',
        ),
        result: null,
      }
    }

    return {
      version: '1' as const,
      title: i18n('Active WireGuard Configuration'),
      message: i18n(
        'Below is your active TunnelSats WireGuard configuration (.conf). Keep your private key confidential.',
      ),
      result: {
        type: 'single' as const,
        value: conf,
        copyable: true,
        masked: true,
        qr: false,
      },
    }
  },
)
