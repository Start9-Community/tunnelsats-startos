import { fetchServers, type ServerInfo } from './apiClient'

/**
 * The regions TunnelSats offers, by the ids of `GET /api/public/v1/servers`.
 * Used when the live list cannot be fetched; the dashboard's region pickers
 * (web/index.html) carry the same ids.
 */
export const STATIC_SERVER_REGIONS: Readonly<Record<string, string>> = {
  'eu-de': 'Europe — Nuremberg, DE',
  'eu-ch': 'Europe — Geneva, CH',
  'us-east': 'North America — Ashburn, US',
  'us-west': 'North America — Hillsboro, US',
  'sa-br': 'South America — Sao Paulo, BR',
  'asia-sg': 'Asia — Singapore, SG',
  'oc-au': 'Oceania — Sydney, AU',
}

export const DEFAULT_SERVER_REGION = 'eu-de'

/** How long the Buy form waits for the live list before using the fallback. */
export const SERVER_LIST_TIMEOUT_MS = 5000

// The server id format bridge.py accepts (_SERVER_ID_RE).
const SERVER_ID_RE = /^[A-Za-z0-9_-]{2,32}$/
const LABEL_PART_MAX = 64

function labelPart(value: unknown): string | null {
  if (typeof value !== 'string') return null
  const text = value.trim()
  return text ? text.slice(0, LABEL_PART_MAX) : null
}

/**
 * Select values (id → label) from a live server list. Entries without a
 * valid id are skipped; an unusable list yields the static regions.
 */
export function serverRegionValues(servers: unknown): Record<string, string> {
  const values: Record<string, string> = {}
  if (Array.isArray(servers)) {
    for (const server of servers) {
      if (!server || typeof server !== 'object') continue
      const { id, city, country, flag } = server as Partial<ServerInfo>
      if (typeof id !== 'string' || !SERVER_ID_RE.test(id) || id in values) {
        continue
      }
      const place = [labelPart(city), labelPart(country)]
        .filter((part): part is string => part !== null)
        .join(', ')
      const flagText = labelPart(flag)
      values[id] = place
        ? `${flagText ? `${flagText} ` : ''}${place}`
        : (STATIC_SERVER_REGIONS[id] ?? id)
    }
  }
  return Object.keys(values).length > 0 ? values : { ...STATIC_SERVER_REGIONS }
}

/** The default selection: eu-de when offered, else the first region. */
export function defaultServerRegion(values: Record<string, string>): string {
  return DEFAULT_SERVER_REGION in values
    ? DEFAULT_SERVER_REGION
    : Object.keys(values)[0]
}

/**
 * The live region list for the Buy form, falling back to the static regions
 * when TunnelSats cannot be reached within SERVER_LIST_TIMEOUT_MS.
 */
export async function loadServerRegions(
  load: () => Promise<unknown> = () =>
    fetchServers(undefined, SERVER_LIST_TIMEOUT_MS),
): Promise<Record<string, string>> {
  try {
    return serverRegionValues(await load())
  } catch {
    return { ...STATIC_SERVER_REGIONS }
  }
}
