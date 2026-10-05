import { chmod, rm } from 'node:fs/promises'
import { T } from '@start9labs/start-sdk'
import { sdk } from '../sdk'
import { nwcWallet, type NwcWalletRecord } from '../fileModels/nwcWallet'
import { tunnelsatsMeta } from '../fileModels/tunnelsatsMeta'
import { metaLockFor, type MetaLock } from '../metaLock'
import { i18n } from '../i18n'
import {
  type NwcAutoRenewDuration,
  type RecommendedBudget,
  type ValidRenewalMonths,
  getRecommendedBudgetForSetting,
  parseNwcUri,
} from '../nwc'

export interface ConnectWalletInput {
  mode: 'connect' | 'disconnect'
  nwcUri?: string | null
  autoRenewDuration?: NwcAutoRenewDuration
  routeViaTor?: boolean
}

export interface ConnectWalletOps {
  now(): Date
  lockMeta: MetaLock
  readMeta(): Promise<{
    lastDuration?: number
    lastAmountSats?: number
    nwcConnected?: boolean
    nwcRelayHost?: string
    nwcRouteViaTor?: boolean
    nwcAutoRenewDuration?: NwcAutoRenewDuration
  } | null>
  writeWalletFile(record: NwcWalletRecord): Promise<void>
  removeWalletFile(): Promise<void>
  writeMeta(patch: {
    nwcConnected: boolean
    nwcRelayHost?: string
    nwcRouteViaTor?: boolean
    nwcAutoRenewDuration?: NwcAutoRenewDuration
    nwcAutoRenewState?: null
  }): Promise<unknown>
}

export type ConnectWalletResult =
  | {
      kind: 'connected'
      relayHost: string
      routeViaTor: boolean
      isOnionRelay: boolean
      autoRenewDuration: NwcAutoRenewDuration
      resolvedDurationMonths: ValidRenewalMonths
      recommendedBudget: RecommendedBudget
    }
  | {
      kind: 'disconnected'
    }

const VALID_AUTO_RENEW_DURATIONS: readonly NwcAutoRenewDuration[] = [
  'match',
  '1m',
  '3m',
  '6m',
  '12m',
]

export async function runConnectWallet(
  input: ConnectWalletInput,
  ops: ConnectWalletOps,
): Promise<ConnectWalletResult> {
  if (input.mode === 'disconnect') {
    await ops.lockMeta(async () => {
      await ops.removeWalletFile()
      await ops.writeMeta({
        nwcConnected: false,
        nwcRelayHost: undefined,
        nwcRouteViaTor: undefined,
        nwcAutoRenewDuration: undefined,
        nwcAutoRenewState: null,
      })
    })
    return { kind: 'disconnected' }
  }

  const parsed = parseNwcUri(input.nwcUri ?? '')
  const autoRenewDuration: NwcAutoRenewDuration =
    input.autoRenewDuration &&
    VALID_AUTO_RENEW_DURATIONS.includes(input.autoRenewDuration)
      ? input.autoRenewDuration
      : 'match'
  const routeViaTor = Boolean(input.routeViaTor || parsed.isOnionRelay)

  let lastDuration: number | undefined
  let lastAmountSats: number | undefined

  await ops.lockMeta(async () => {
    const currentMeta = await ops.readMeta()
    lastDuration = currentMeta?.lastDuration
    lastAmountSats = currentMeta?.lastAmountSats

    await ops.writeWalletFile({
      uri: parsed.uri,
      relayHost: parsed.relayHost,
      routeViaTor,
      autoRenewDuration,
      updatedAt: ops.now().toISOString(),
    })

    await ops.writeMeta({
      nwcConnected: true,
      nwcRelayHost: parsed.relayHost,
      nwcRouteViaTor: routeViaTor,
      nwcAutoRenewDuration: autoRenewDuration,
      nwcAutoRenewState: null,
    })
  })

  const recommendedBudget = getRecommendedBudgetForSetting({
    autoRenewDuration,
    lastAmountSats,
    lastDuration,
  })

  return {
    kind: 'connected',
    relayHost: parsed.relayHost,
    routeViaTor,
    isOnionRelay: parsed.isOnionRelay,
    autoRenewDuration,
    resolvedDurationMonths: recommendedBudget.durationMonths,
    recommendedBudget,
  }
}

export function startConnectWallet(
  effects: T.Effects,
  input: ConnectWalletInput,
  opsOverride?: Partial<ConnectWalletOps>,
): Promise<ConnectWalletResult> {
  const walletPath = sdk.volumes.main.subpath('./nwc-wallet.json')
  const defaultOps: ConnectWalletOps = {
    now: () => new Date(),
    lockMeta: metaLockFor(effects),
    readMeta: () =>
      tunnelsatsMeta
        .read()
        .once()
        .catch(() => null),
    writeWalletFile: async (record) => {
      await nwcWallet.write(effects, record)
      try {
        await chmod(walletPath, 0o600)
      } catch (e) {
        await rm(walletPath, { force: true }).catch(() => undefined)
        throw new Error(
          `Could not apply restrictive 0600 permissions to nwc-wallet.json: ${e instanceof Error ? e.message : String(e)}`,
        )
      }
    },
    removeWalletFile: async () => {
      await rm(walletPath, { force: true })
    },
    writeMeta: (patch) => tunnelsatsMeta.merge(effects, patch),
  }
  return runConnectWallet(input, { ...defaultOps, ...opsOverride })
}

const { InputSpec, Value } = sdk

export const inputSpec = InputSpec.of({
  mode: Value.select({
    name: i18n('Wallet Action'),
    description: i18n(
      'Connect or update an NWC wallet for automatic renewals, or disconnect the currently stored wallet.',
    ),
    default: 'connect',
    values: {
      connect: 'Connect / Update NWC Wallet',
      disconnect: 'Disconnect NWC Wallet',
    },
  }),
  nwcUri: Value.text({
    name: i18n('NWC Connection URI'),
    description: i18n(
      'Paste your nostr+walletconnect:// URI (from Alby Hub, LNbits, Mutiny, or your NWC wallet). Leave only pay_invoice, lookup_invoice, get_budget, and get_balance permissions enabled with a 1.2x satoshi budget cap.',
    ),
    required: false,
    default: null,
    masked: true,
    placeholder:
      'nostr+walletconnect://<pubkey>?relay=wss://...&secret=<64-char-hex>',
  }),
  autoRenewDuration: Value.select({
    name: i18n('Auto-Renew Duration'),
    description: i18n(
      'Select the subscription extension period to request when auto-renewing. Because BTC/fiat rates cannot be foreseen over 12 months, set your NWC wallet budget to at least 1.2x the current satoshi estimate for your chosen interval.',
    ),
    default: 'match',
    values: {
      match: 'Match Last Purchase (1m fallback)',
      '1m': '1 Month',
      '3m': '3 Months',
      '6m': '6 Months',
      '12m': '12 Months',
    },
  }),
  routeViaTor: Value.toggle({
    name: i18n('Route Wallet Traffic Through Tor'),
    description: i18n(
      "Route NWC WebSocket relay connections through the Tor service's SOCKS5 proxy so the relay never sees your home IP. Automatically enforced for .onion relays.",
    ),
    default: false,
  }),
})

export const connectWallet = sdk.Action.withInput(
  'connect-wallet',
  {
    name: i18n('Connect Wallet'),
    description: i18n(
      'Connect or disconnect a Nostr Wallet Connect (NIP-47) wallet for automatic subscription renewal before expiry.',
    ),
    warning: i18n(
      'Automatic Renewal Disclosure: Connecting an NWC wallet authorizes TunnelSats to automatically pay a renewal invoice when your confirmed subscription is within 7 days of expiry. Because BTC/fiat exchange rates fluctuate over a 12-month period, configure your NWC wallet with a 1.2x safety buffer above the current satoshi price for your chosen renewal interval. If the wallet budget or balance is insufficient, or after 3 failed relay attempts, TunnelSats automatically falls back to raising a manual Pay Invoice task on your Lightning node.',
    ),
    allowedStatuses: 'any',
    group: i18n('Subscription'),
    visibility: 'enabled',
  },
  inputSpec,
  async () => {
    const meta = await tunnelsatsMeta
      .read()
      .once()
      .catch(() => null)
    // Never return the raw NWC URI or secret from getInput so StartOS logs
    // and UI prefill calls cannot leak the wallet secret.
    return {
      mode: 'connect' as const,
      nwcUri: null,
      autoRenewDuration: meta?.nwcAutoRenewDuration ?? 'match',
      routeViaTor: meta?.nwcRouteViaTor ?? false,
    }
  },
  async ({ effects, input }) => {
    const outcome = await startConnectWallet(effects, {
      mode: input.mode,
      nwcUri: input.nwcUri,
      autoRenewDuration: input.autoRenewDuration,
      routeViaTor: input.routeViaTor,
    })

    if (outcome.kind === 'disconnected') {
      return {
        version: '1' as const,
        title: i18n('NWC Wallet Disconnected'),
        message: i18n(
          'The stored NWC connection URI has been removed. Future renewals will raise a manual Pay Invoice task on your Lightning node.',
        ),
        result: null,
      }
    }

    const transportLabel = outcome.routeViaTor ? 'Tor SOCKS5' : 'Clearnet WSS'

    return {
      version: '1' as const,
      title: i18n('NWC Wallet Connected'),
      message: i18n(
        'NWC auto-renewal is active via relay ${relayHost} (${transport}). TunnelSats will automatically renew for ${duration} month(s) when your confirmed subscription is within 7 days of expiry. Recommended NWC wallet budget (1.2x buffer): ${perRenewalSats} sats per renewal (${annualSats} sats/year).',
        {
          relayHost: outcome.relayHost,
          transport: transportLabel,
          duration: String(outcome.resolvedDurationMonths),
          perRenewalSats: String(outcome.recommendedBudget.perRenewalSats),
          annualSats: String(outcome.recommendedBudget.annualSats),
        },
      ),
      result: {
        type: 'group' as const,
        value: [
          {
            name: i18n('Relay Host'),
            description: null,
            type: 'single' as const,
            value: outcome.relayHost,
            copyable: true,
            masked: false,
            qr: false,
          },
          {
            name: i18n('Transport'),
            description: null,
            type: 'single' as const,
            value: transportLabel,
            copyable: false,
            masked: false,
            qr: false,
          },
          {
            name: i18n('Auto-Renew Duration'),
            description: null,
            type: 'single' as const,
            value: `${outcome.resolvedDurationMonths} Month(s) (${outcome.autoRenewDuration})`,
            copyable: false,
            masked: false,
            qr: false,
          },
          {
            name: i18n('Recommended Budget (1.2x Buffer)'),
            description: null,
            type: 'single' as const,
            value: `${outcome.recommendedBudget.perRenewalSats} sats / renewal (${outcome.recommendedBudget.annualSats} sats / year)`,
            copyable: true,
            masked: false,
            qr: false,
          },
        ],
      },
    }
  },
)
