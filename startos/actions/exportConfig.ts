import { sdk } from '../sdk'
import { tunnelsatsConf } from '../fileModels/tunnelsatsConf'
import { configJson } from '../fileModels/config.json'
import { i18n } from '../i18n'

export const exportConfig = sdk.Action.withoutInput(
  'export-config',
  {
    name: i18n('Export WireGuard Configuration'),
    description: i18n(
      'View and export the active TunnelSats WireGuard configuration file (.conf).',
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
