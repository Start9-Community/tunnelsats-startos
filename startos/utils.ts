import { isIPv6, isIPv4 } from 'node:net'

export interface WireguardTunnelInfo {
  privateKey?: string
  address?: string
  endpoint?: string
  serverDomain?: string
  publicKey?: string
  presharedKey?: string
  vpnPort?: number
}

export function validateWireguardConfig(wgConf: string | null | undefined): {
  valid: boolean
  error?: string
} {
  if (!wgConf || !wgConf.trim()) {
    return { valid: false, error: 'WireGuard configuration is empty.' }
  }

  if (!/^\s*(?!#|;)\s*PrivateKey\s*=/im.test(wgConf)) {
    return {
      valid: false,
      error: "Missing 'PrivateKey' property in [Interface].",
    }
  }

  if (!/^\s*(?!#|;)\s*Address\s*=/im.test(wgConf)) {
    return { valid: false, error: "Missing 'Address' property in [Interface]." }
  }

  if (!/^\s*(?!#|;)\s*Endpoint\s*=/im.test(wgConf)) {
    return { valid: false, error: "Missing 'Endpoint' property in [Peer]." }
  }

  if (!/#\s*(?:VPNPort|Port Forwarding):\s*\d+/i.test(wgConf)) {
    return {
      valid: false,
      error:
        'Missing port forwarding metadata (e.g. # Port Forwarding: XXXXX).',
    }
  }

  return { valid: true }
}

export function parseWireguardTunnelInfo(
  wgConf: string | null | undefined,
): WireguardTunnelInfo {
  if (!wgConf) return {}

  const info: WireguardTunnelInfo = {}

  const privMatch = wgConf.match(/^\s*(?!#|;)\s*PrivateKey\s*=\s*(.+)/im)
  if (privMatch) info.privateKey = privMatch[1].trim()

  const addrMatch = wgConf.match(/^\s*(?!#|;)\s*Address\s*=\s*(.+)/im)
  if (addrMatch) info.address = addrMatch[1].trim()

  const endMatch = wgConf.match(/^\s*(?!#|;)\s*Endpoint\s*=\s*(.+)/im)
  if (endMatch) info.endpoint = endMatch[1].trim()

  const pubMatch = wgConf.match(/^\s*(?!#|;)\s*PublicKey\s*=\s*(.+)/im)
  if (pubMatch) info.publicKey = pubMatch[1].trim()

  const pskMatch = wgConf.match(/^\s*(?!#|;)\s*PresharedKey\s*=\s*(.+)/im)
  if (pskMatch) info.presharedKey = pskMatch[1].trim()

  const portMatch = wgConf.match(/#\s*(?:VPNPort|Port Forwarding):\s*(\d+)/i)
  if (portMatch) info.vpnPort = parseInt(portMatch[1].trim(), 10)

  const serverMatch = wgConf.match(/#\s*Server:\s*(.+)/i)
  if (serverMatch) {
    info.serverDomain = serverMatch[1].trim()
  } else if (info.endpoint) {
    if (info.endpoint.startsWith('[')) {
      const closingBracket = info.endpoint.indexOf(']')
      if (closingBracket !== -1) {
        info.serverDomain = info.endpoint.substring(1, closingBracket)
      }
    } else {
      const lastColonIndex = info.endpoint.lastIndexOf(':')
      if (
        lastColonIndex !== -1 &&
        isIPv6(info.endpoint.substring(0, lastColonIndex))
      ) {
        info.serverDomain = info.endpoint.substring(0, lastColonIndex)
      } else if (isIPv6(info.endpoint)) {
        info.serverDomain = info.endpoint
      } else {
        info.serverDomain = info.endpoint.split(':')[0]
      }
    }
  }

  return info
}

export function getAnnounceEndpoint(
  wgConf: string | null | undefined,
  allowIpv6 = false,
): string | null {
  if (!wgConf) return null
  const info = parseWireguardTunnelInfo(wgConf)
  if (!info.endpoint || !info.vpnPort) return null

  const fullEndpoint = info.endpoint.trim()
  const vpnPort = info.vpnPort

  // 1. Bracketed IPv6 e.g. [2001:db8::1]:51820 or [2001:db8::1]
  if (fullEndpoint.startsWith('[')) {
    const closingBracket = fullEndpoint.indexOf(']')
    if (closingBracket === -1) return null
    const ipCandidate = fullEndpoint.substring(1, closingBracket)
    if (!isIPv6(ipCandidate)) return null
    if (!allowIpv6) return null
    return `[${ipCandidate}]:${vpnPort}`
  }

  // 2. Unbracketed IPv6 without port e.g. 2001:db8::1
  if (isIPv6(fullEndpoint)) {
    if (!allowIpv6) return null
    return `[${fullEndpoint}]:${vpnPort}`
  }

  // 3. Unbracketed IPv6 with explicit port e.g. 2001:db8::1:51820
  const lastColonIndex = fullEndpoint.lastIndexOf(':')
  if (lastColonIndex !== -1) {
    const ipCandidate = fullEndpoint.substring(0, lastColonIndex)
    const portCandidate = fullEndpoint.substring(lastColonIndex + 1)
    if (isIPv6(ipCandidate) && /^\d+$/.test(portCandidate)) {
      if (!allowIpv6) return null
      return `[${ipCandidate}]:${vpnPort}`
    }
  }

  // 4. Reject any remaining malformed IPv6 strings containing colons
  if (fullEndpoint.includes(':') && !isIPv4(fullEndpoint.split(':')[0])) {
    const parts = fullEndpoint.split(':')
    if (parts.length > 2) return null
  }

  const host = fullEndpoint.split(':')[0]
  if (!host) return null

  return `${host}:${vpnPort}`
}
