import test from 'node:test'
import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { join } from 'node:path'
import {
  bridgeEnv,
  TOR_SOCKS_HOST_ID,
  TOR_SOCKS_PORT,
  torSocksAddress,
} from '../startos/bridgeEnv'
import { current } from '../startos/versions/current'

const REPO = join(__dirname, '..')

test('the Tor SOCKS binding constants mirror tor-startos', async () => {
  // tor-startos is not a dependency of this package; it is installed with the
  // node packages that depend on it, which is enough to catch drift here.
  const tor = await import('tor-startos/startos/utils')
  assert.equal(TOR_SOCKS_HOST_ID, tor.socksHostId)
  assert.equal(TOR_SOCKS_PORT, tor.socksPort)
})

test('the Tor proxy is resolved on the tor package, with 9050 as fallback', async () => {
  const requests: { packageId?: string; hostId?: string }[] = []
  const effects = {
    // Tor not installed: StartOS has no host for it.
    getHostInfo: async (opts: { packageId?: string; hostId?: string }) => {
      requests.push({ packageId: opts.packageId, hostId: opts.hostId })
      return null
    },
    getOsIp: async () => '10.0.3.1',
  }
  assert.equal(await torSocksAddress(effects as never).once(), '10.0.3.1:9050')
  assert.deepEqual(requests, [{ packageId: 'tor', hostId: 'socks' }])
})

test('bridge.py processes get the Tor proxy bridge address', () => {
  assert.deepEqual(bridgeEnv('10.0.3.1:9050'), {
    PACKAGE_VERSION: current.options.version,
    TOR_SOCKS_HOST: '10.0.3.1',
    TOR_SOCKS_PORT: '9050',
  })
})

test('a Tor proxy address that is not <IPv4>:<port> is left out', () => {
  for (const address of [
    null,
    '',
    'tor.embassy:9050',
    '10.0.3.1',
    '10.0.3.1:',
    '10.0.3.1:0',
    '10.0.3.1:65536',
    '10.0.3.256:9050',
    '[fe80::1]:9050',
    ' 10.0.3.1:9050',
    '10.0.3.1:9050\n',
  ]) {
    assert.deepEqual(
      bridgeEnv(address),
      { PACKAGE_VERSION: current.options.version },
      JSON.stringify(address),
    )
  }
})

test('bridge.py dials the Tor proxy bridgeEnv names, and none without it', () => {
  const { TOR_SOCKS_HOST: _h, TOR_SOCKS_PORT: _p, ...base } = process.env
  const proxyOf = (env: Record<string, string>) =>
    execFileSync(
      'python3',
      ['-c', 'import bridge; print(*bridge._tor_socks_address())'],
      { cwd: REPO, env: { ...base, ...env }, encoding: 'utf8', stdio: 'pipe' },
    ).trim()
  assert.equal(proxyOf(bridgeEnv('10.0.3.1:9050')), '10.0.3.1 9050')
  assert.throws(
    () => proxyOf(bridgeEnv(null)),
    (e: { stderr?: string }) =>
      /Tor SOCKS5 proxy address is not set/.test(String(e.stderr)),
  )
})
