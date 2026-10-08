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
      emulateMissing: false,
    },
  },
})
