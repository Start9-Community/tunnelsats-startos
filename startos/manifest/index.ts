import { setupManifest } from '@start9labs/start-sdk'
import { long, short } from './i18n'

export const manifest = setupManifest({
  id: 'tunnelsats',
  title: 'TunnelSats',
  license: 'MIT',
  packageRepo: 'https://github.com/Start9-Community/tunnelsats-startos',
  upstreamRepo: 'https://github.com/Tunnelsats/tunnelsats',
  marketingUrl: 'https://tunnelsats.com',
  donationUrl: null,
  description: { short, long },
  volumes: ['main'],
  images: {
    main: {
      source: { dockerBuild: {} },
      arch: ['x86_64', 'aarch64'],
    },
  },
  alerts: {
    install: null,
    update: null,
    uninstall: null,
    restore: null,
    start: null,
    stop: null,
  },
  dependencies: {
    lnd: {
      description:
        'Lightning Network Daemon. Required if you choose LND as your Target Lightning Node for inbound connections.',
      optional: true,
      metadata: {
        title: 'LND',
        icon: 'https://raw.githubusercontent.com/Start9Labs/lnd-startos/refs/heads/master/icon.svg',
      },
    },
    'c-lightning': {
      description:
        'Core Lightning. Required if you choose Core Lightning as your Target Lightning Node for inbound connections.',
      optional: true,
      metadata: {
        title: 'Core Lightning',
        icon: 'https://raw.githubusercontent.com/Start9Labs/cln-startos/refs/heads/master/icon.svg',
      },
    },
    eclair: {
      description:
        'Eclair. Required if you choose Eclair as your Target Lightning Node for inbound connections.',
      optional: true,
      metadata: {
        title: 'Eclair',
        icon: 'https://raw.githubusercontent.com/Start9Labs/eclair-startos/refs/heads/master/icon.png',
      },
    },
    tor: {
      description:
        'Tor SOCKS5 Proxy. Required when routing NWC wallet connections through Tor or connecting to a .onion NWC relay.',
      optional: true,
      metadata: {
        title: 'Tor',
        icon: 'https://raw.githubusercontent.com/Start9Labs/tor-startos/refs/heads/master/icon.svg',
      },
    },
  },
})
