import test from 'node:test'
import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { join } from 'node:path'
import {
  bridgeCommands,
  bridgeDaemonExec,
  bridgeEnv,
  HEALTH_SUBSCRIPTION_TIMEOUT_MS,
  readTorSocksAddress,
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

/** Tor's socks binding as StartOS reports it, published on `port`. */
const torHost = (port: number) => {
  const address = (hostname: string, gateway: string) => ({
    ssl: false,
    public: false,
    hostname,
    port,
    metadata: { kind: 'ipv4', gateway },
  })
  return {
    bindings: {
      [TOR_SOCKS_PORT]: {
        addresses: {
          enabled: [],
          disabled: [],
          guaWan: [],
          available: [
            address('127.0.0.1', 'lo'),
            address('10.0.3.1', 'lxcbr0'),
          ],
        },
        interfaces: {},
      },
    },
  }
}

test('an installed Tor resolves to its bridge address, which equals the fallback', async () => {
  const effects = {
    getHostInfo: async () => torHost(TOR_SOCKS_PORT),
    getOsIp: async () => '10.0.3.1',
  }
  assert.equal(await torSocksAddress(effects as never).once(), '10.0.3.1:9050')
})

test('main re-runs when the Tor proxy address changes, not when Tor is installed', async () => {
  let host: ReturnType<typeof torHost> | null = null // Tor not installed
  let hostChanged = () => {}
  let reruns = 0
  const effects = {
    isInContext: true,
    onLeaveContext: () => {},
    constRetry: () => {
      reruns++
    },
    getHostInfo: async (opts: { callback?: () => void }) => {
      hostChanged = opts.callback ?? (() => {})
      return host
    },
    getOsIp: async () => '10.0.3.1',
  }
  const settled = () => new Promise((resolve) => setImmediate(resolve))
  assert.equal(await readTorSocksAddress(effects as never), '10.0.3.1:9050')

  host = torHost(TOR_SOCKS_PORT)
  hostChanged()
  await settled()
  assert.equal(reruns, 0)

  host = torHost(9051)
  hostChanged()
  await settled()
  assert.equal(reruns, 1)
})

test('a failed first read of the Tor proxy address leaves Tor connections refused, not main down', async (t) => {
  const warn = t.mock.method(console, 'warn', () => {})
  const effects = {
    isInContext: true,
    onLeaveContext: () => {},
    constRetry: () => {},
    getHostInfo: async () => {
      throw new Error('host info unavailable')
    },
    getOsIp: async () => '10.0.3.1',
  }
  const address = await readTorSocksAddress(effects as never)
  assert.equal(address, null)
  assert.deepEqual(bridgeEnv(address), {
    PACKAGE_VERSION: current.options.version,
  })
  assert.match(
    String(warn.mock.calls[0]?.arguments[0]),
    /Tor SOCKS address unavailable: Error: host info unavailable/,
  )
})

test('main runs every bridge.py command with the env, and health subscription for up to 300 s', async () => {
  const calls: [string[], { env: Record<string, string> }, number?][] = []
  const exec = async (
    command: string[],
    options: { env: Record<string, string> },
    timeoutMs?: number,
  ) => {
    calls.push([command, options, timeoutMs])
    return { exitCode: 0 }
  }
  const env = bridgeEnv('10.0.3.1:9050')
  const bridge = bridgeCommands(exec, env)
  await bridge.healthSubscription()
  await bridge.settle()
  await bridge.settleAck(['renewal:lnd:ab', 'order:lnd:cd'])
  // The health command runs NWC auto-renewal: SubContainer.exec's default
  // 30 s would SIGKILL a renewal before its failure is recorded.
  assert.equal(HEALTH_SUBSCRIPTION_TIMEOUT_MS, 300_000)
  assert.deepEqual(calls, [
    [
      ['python3', '/app/bridge.py', 'health', 'subscription'],
      { env },
      HEALTH_SUBSCRIPTION_TIMEOUT_MS,
    ],
    [['python3', '/app/bridge.py', 'settle'], { env }, undefined],
    [
      [
        'python3',
        '/app/bridge.py',
        'settle-ack',
        'renewal:lnd:ab',
        'order:lnd:cd',
      ],
      { env },
      undefined,
    ],
  ])
  // The daemon: docker_entrypoint.sh execs `bridge.py start` with this env.
  assert.deepEqual(bridgeDaemonExec(env), {
    command: ['/app/docker_entrypoint.sh'],
    env,
  })
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
