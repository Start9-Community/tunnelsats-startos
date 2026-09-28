import test from 'node:test'
import assert from 'node:assert/strict'
import {
  DEFAULT_SERVER_REGION,
  STATIC_SERVER_REGIONS,
  defaultServerRegion,
  loadServerRegions,
  serverRegionValues,
} from '../startos/serverRegions'
import { inputSpec } from '../startos/actions/buySubscription'

// The ids GET /api/public/v1/servers answers with.
const LIVE_IDS = [
  'eu-de',
  'eu-ch',
  'us-east',
  'us-west',
  'sa-br',
  'asia-sg',
  'oc-au',
]

test('static fallback carries exactly the live server ids', () => {
  assert.deepEqual(
    Object.keys(STATIC_SERVER_REGIONS).sort(),
    [...LIVE_IDS].sort(),
  )
  assert.ok(DEFAULT_SERVER_REGION in STATIC_SERVER_REGIONS)
  // The retired ids the Buy form used to offer are gone.
  assert.equal('eu-de2' in STATIC_SERVER_REGIONS, false)
})

test('serverRegionValues labels live servers and skips invalid entries', () => {
  const values = serverRegionValues([
    {
      id: 'eu-de',
      city: 'Nuremberg',
      country: 'Germany',
      flag: '🇩🇪',
      status: 'online',
    },
    {
      id: 'eu-de',
      city: 'Duplicate',
      country: 'Germany',
      flag: '',
      status: 'online',
    },
    { id: '../etc', city: 'X', country: 'Y', flag: '', status: 'online' },
    { id: 'oc-au', city: 7, country: null, flag: null, status: 'online' },
    { id: 'new-1', city: ' ', country: '', flag: '', status: 'online' },
    null,
    'eu-ch',
  ])
  assert.deepEqual(values, {
    'eu-de': '🇩🇪 Nuremberg, Germany',
    'oc-au': STATIC_SERVER_REGIONS['oc-au'],
    'new-1': 'new-1',
  })
})

test('serverRegionValues falls back to the static regions', () => {
  for (const list of [[], null, 'x', [{ id: '!' }], { servers: [] }]) {
    assert.deepEqual(serverRegionValues(list), STATIC_SERVER_REGIONS)
  }
})

test('defaultServerRegion prefers eu-de, else the first region', () => {
  assert.equal(defaultServerRegion(STATIC_SERVER_REGIONS), 'eu-de')
  assert.equal(defaultServerRegion({ 'us-east': 'A', 'sa-br': 'B' }), 'us-east')
})

test('loadServerRegions uses the live list and survives a failed fetch', async () => {
  assert.deepEqual(
    await loadServerRegions(async () => [
      {
        id: 'us-west',
        city: 'Hillsboro',
        country: 'USA',
        flag: '',
        status: 'online',
      },
    ]),
    { 'us-west': 'Hillsboro, USA' },
  )
  assert.deepEqual(
    await loadServerRegions(async () => {
      throw new Error('offline')
    }),
    STATIC_SERVER_REGIONS,
  )
})

test('the Buy form region select is built from the region loader', async () => {
  // Builds the real input spec; the network is unreachable in tests, so the
  // select falls back to the static regions with eu-de preselected.
  const originalFetch = globalThis.fetch
  globalThis.fetch = (async () => {
    throw new Error('offline')
  }) as typeof fetch
  try {
    const built = await inputSpec.build({
      effects: {} as never,
      prefill: null,
    })
    const spec = built.spec['server-region'] as unknown as {
      type: string
      default: string
      values: Record<string, string>
    }
    assert.equal(spec.type, 'select')
    assert.equal(spec.default, 'eu-de')
    assert.deepEqual(spec.values, STATIC_SERVER_REGIONS)
  } finally {
    globalThis.fetch = originalFetch
  }
})
