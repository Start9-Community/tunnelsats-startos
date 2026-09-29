export type NwcAutoRenewDuration = 'match' | '1m' | '3m' | '6m' | '12m'
export type ValidRenewalMonths = 1 | 3 | 6 | 12

export const NWC_BUDGET_MULTIPLIER = 1.2
export const NWC_MAX_TRANSIENT_FAILURES = 3

/**
 * Baseline satoshi estimates per duration used only when no prior purchase or
 * live renewal quote has been recorded in tunnelsats-meta.json yet.
 */
export const DEFAULT_ESTIMATED_SATS_BY_DURATION: Readonly<
  Record<ValidRenewalMonths, number>
> = {
  1: 4_500,
  3: 12_000,
  6: 22_500,
  12: 42_000,
}

export interface ParsedNwcUri {
  /** Normalized nostr+walletconnect:// URI. */
  uri: string
  /** 64-character lowercase hex wallet service pubkey. */
  walletPubkey: string
  /** Primary validated relay WebSocket URL (wss:// or ws://*.onion). */
  relayUrl: string
  /** All validated relay URLs present in the URI. */
  relays: string[]
  /** Hostname of the primary relay (safe for display/logging, no secrets). */
  relayHost: string
  /** True when the primary relay (or any relay) uses a .onion hidden service. */
  isOnionRelay: boolean
  /** 64-character lowercase hex client secret key. */
  secret: string
  /** Optional lightning address hint included in the URI. */
  lud16?: string
}

const HEX_64_RE = /^[0-9a-f]{64}$/i

/**
 * Parses and validates a NIP-47 Nostr Wallet Connect URI:
 * nostr+walletconnect://<walletPubkeyHex64>?relay=<wss://...|ws://...onion>&secret=<hex64>
 *
 * Never includes the raw URI or secret in thrown error messages.
 */
export function parseNwcUri(rawInput: string): ParsedNwcUri {
  const trimmed = (rawInput ?? '').trim()
  if (!trimmed) {
    throw new Error('NWC connection URI is required.')
  }

  const schemePrefix = 'nostr+walletconnect://'
  if (!trimmed.toLowerCase().startsWith(schemePrefix)) {
    throw new Error(
      'Invalid NWC URI scheme: expected nostr+walletconnect://<pubkey>?relay=...&secret=...',
    )
  }

  const rest = trimmed.slice(schemePrefix.length)
  const qIndex = rest.indexOf('?')
  if (qIndex === -1) {
    throw new Error(
      'Invalid NWC URI: missing query parameters (?relay=...&secret=...).',
    )
  }

  const rawPubkey = rest.slice(0, qIndex).replace(/^\/+|\/+$/g, '')
  if (!HEX_64_RE.test(rawPubkey)) {
    throw new Error(
      'Invalid NWC wallet public key: expected a 64-character hex string.',
    )
  }
  const walletPubkey = rawPubkey.toLowerCase()

  const searchParams = new URLSearchParams(rest.slice(qIndex + 1))
  const rawRelays = searchParams
    .getAll('relay')
    .map((r) => r.trim())
    .filter(Boolean)
  if (rawRelays.length === 0) {
    throw new Error('Invalid NWC URI: missing required relay parameter.')
  }

  const rawSecret = (searchParams.get('secret') ?? '').trim()
  if (!rawSecret) {
    throw new Error('Invalid NWC URI: missing required secret parameter.')
  }
  if (!HEX_64_RE.test(rawSecret)) {
    throw new Error(
      'Invalid NWC secret: expected a 64-character hexadecimal secret.',
    )
  }
  const secret = rawSecret.toLowerCase()

  const validatedRelays: { url: string; host: string; isOnion: boolean }[] = []
  for (const candidate of rawRelays) {
    let parsedRelay: URL
    try {
      parsedRelay = new URL(candidate)
    } catch {
      throw new Error('Invalid NWC relay URL format.')
    }
    const protocol = parsedRelay.protocol.toLowerCase()
    const hostname = parsedRelay.hostname.toLowerCase()
    if (!hostname) {
      throw new Error('Invalid NWC relay URL: missing hostname.')
    }
    const isOnion = hostname.endsWith('.onion')
    if (protocol !== 'wss:' && !(protocol === 'ws:' && isOnion)) {
      throw new Error(
        'Invalid NWC relay protocol: clearnet relays must use wss:// (ws:// is only permitted for .onion relays).',
      )
    }
    validatedRelays.push({
      url: parsedRelay.toString().replace(/\/$/, ''),
      host: hostname,
      isOnion,
    })
  }

  const primary = validatedRelays[0]
  const isOnionRelay = validatedRelays.some((r) => r.isOnion)
  const lud16Raw = searchParams.get('lud16')?.trim()

  const canonicalParams = new URLSearchParams()
  for (const r of validatedRelays) {
    canonicalParams.append('relay', r.url)
  }
  canonicalParams.set('secret', secret)
  if (lud16Raw) {
    canonicalParams.set('lud16', lud16Raw)
  }

  return {
    uri: `${schemePrefix}${walletPubkey}?${canonicalParams.toString()}`,
    walletPubkey,
    relayUrl: primary.url,
    relays: validatedRelays.map((r) => r.url),
    relayHost: primary.host,
    isOnionRelay,
    secret,
    ...(lud16Raw ? { lud16: lud16Raw } : {}),
  }
}

/**
 * Resolves the concrete renewal duration in months (1, 3, 6, or 12) from the
 * configured NwcAutoRenewDuration and the last purchased/renewed duration.
 */
export function resolveNwcDurationMonths(
  autoRenewDuration?: NwcAutoRenewDuration | null,
  lastDuration?: number | null,
): ValidRenewalMonths {
  switch (autoRenewDuration) {
    case '1m':
      return 1
    case '3m':
      return 3
    case '6m':
      return 6
    case '12m':
      return 12
    case 'match':
    default:
      if (
        lastDuration === 1 ||
        lastDuration === 3 ||
        lastDuration === 6 ||
        lastDuration === 12
      ) {
        return lastDuration
      }
      return 1
  }
}

export interface RecommendedBudget {
  durationMonths: ValidRenewalMonths
  estimatedSats: number
  /** Recommended per-renewal wallet budget using the 1.2x buffer. */
  perRenewalSats: number
  /** Recommended annual wallet budget across renewals using the 1.2x buffer. */
  annualSats: number
  multiplier: number
  isExactQuote: boolean
}

/**
 * Calculates the recommended NWC wallet budget with a 1.2x safety buffer
 * (matching tunnelsats-v2-web RecurringPaymentControl.tsx):
 *   perRenewalSats = Math.ceil(estimatedSats * 1.2)
 *   annualSats     = Math.ceil((12 / durationMonths) * estimatedSats * 1.2)
 */
export function calculateRecommendedBudget(
  estimatedSats: number,
  durationMonths: ValidRenewalMonths,
  isExactQuote = false,
): RecommendedBudget {
  const safeEstimated = Math.max(1, Math.round(estimatedSats))
  const perRenewalSats = Math.ceil(safeEstimated * NWC_BUDGET_MULTIPLIER)
  const annualSats = Math.ceil(
    (12 / durationMonths) * safeEstimated * NWC_BUDGET_MULTIPLIER,
  )
  return {
    durationMonths,
    estimatedSats: safeEstimated,
    perRenewalSats,
    annualSats,
    multiplier: NWC_BUDGET_MULTIPLIER,
    isExactQuote,
  }
}

/**
 * Estimates the satoshi cost for a target renewal duration based on the last
 * known invoice amount/duration when available, or reference defaults.
 */
export function estimateRenewalSatsForDuration(
  durationMonths: ValidRenewalMonths,
  lastAmountSats?: number | null,
  lastDuration?: number | null,
): { estimatedSats: number; isExactQuote: boolean } {
  if (
    typeof lastAmountSats === 'number' &&
    Number.isFinite(lastAmountSats) &&
    lastAmountSats > 0
  ) {
    if (!lastDuration || lastDuration === durationMonths) {
      return { estimatedSats: Math.round(lastAmountSats), isExactQuote: true }
    }
    if (lastDuration > 0) {
      return {
        estimatedSats: Math.ceil(
          (lastAmountSats / lastDuration) * durationMonths,
        ),
        isExactQuote: false,
      }
    }
  }
  return {
    estimatedSats: DEFAULT_ESTIMATED_SATS_BY_DURATION[durationMonths],
    isExactQuote: false,
  }
}

export function getRecommendedBudgetForSetting(params: {
  autoRenewDuration?: NwcAutoRenewDuration | null
  lastAmountSats?: number | null
  lastDuration?: number | null
}): RecommendedBudget {
  const durationMonths = resolveNwcDurationMonths(
    params.autoRenewDuration,
    params.lastDuration,
  )
  const { estimatedSats, isExactQuote } = estimateRenewalSatsForDuration(
    durationMonths,
    params.lastAmountSats,
    params.lastDuration,
  )
  return calculateRecommendedBudget(estimatedSats, durationMonths, isExactQuote)
}
