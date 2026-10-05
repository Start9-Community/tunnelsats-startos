import test from 'node:test'
import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { copyFileSync, mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { createServer } from 'node:http'
import type { AddressInfo } from 'node:net'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  createSubscriptionOrder,
  fetchOrderPaymentStatus,
  fetchServers,
} from '../startos/apiClient'
import { bridgeEnv } from '../startos/bridgeEnv'
import { USER_AGENT } from '../startos/userAgent'
import { current } from '../startos/versions/current'

const REPO = join(__dirname, '..')

/** version.json as scripts/sync-version.js writes it and the image ships it. */
const versionJson = JSON.parse(
  readFileSync(join(REPO, 'version.json'), 'utf8'),
) as { version: string; semver: string }

/** A local API that records the User-Agent of every request it answers. */
async function withRecordingApi(
  run: (baseUrl: string, userAgents: (string | undefined)[]) => Promise<void>,
): Promise<void> {
  const userAgents: (string | undefined)[] = []
  const server = createServer((req, res) => {
    userAgents.push(req.headers['user-agent'])
    req.resume()
    req.on('end', () => {
      res.setHeader('Content-Type', 'application/json')
      if (req.url === '/api/public/v1/servers') {
        res.end(JSON.stringify({ servers: [] }))
      } else if (req.url === '/api/public/v1/subscription/create') {
        res.end(
          JSON.stringify({
            invoice: 'lnbc1',
            paymentHash: 'a'.repeat(64),
            amountSats: 1,
            orderId: 'order',
          }),
        )
      } else {
        res.end(JSON.stringify({ status: 'paid' }))
      }
    })
  })
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
  try {
    const { port } = server.address() as AddressInfo
    await run(`http://127.0.0.1:${port}`, userAgents)
  } finally {
    await new Promise<void>((resolve) => server.close(() => resolve()))
  }
}

test('version.json carries the package version of versions/current.ts', () => {
  // bridge.py reads version.json; a stale copy would make the two runtimes
  // report different versions.
  assert.equal(versionJson.version, current.options.version)
})

test('TunnelSats API requests send the package version as User-Agent', async () => {
  await withRecordingApi(async (baseUrl, userAgents) => {
    await fetchServers(baseUrl)
    await createSubscriptionOrder(
      { serverId: 'eu-de', duration: 1, wgPublicKey: 'key' },
      baseUrl,
    )
    await fetchOrderPaymentStatus('a'.repeat(64), baseUrl)
    // The same value bridge.py builds from version.json.
    const expected = `TunnelSats-StartOS/${versionJson.semver}`
    assert.equal(USER_AGENT, expected)
    assert.deepEqual(userAgents, [expected, expected, expected])
  })
})

test('bridge.py processes get the package version of versions/current.ts', () => {
  assert.equal(bridgeEnv().PACKAGE_VERSION, current.options.version)
})

test('bridge.py sends the same User-Agent under the env main passes', () => {
  // A copy of bridge.py with no version.json beside it: its version can only
  // come from PACKAGE_VERSION.
  const dir = mkdtempSync(join(tmpdir(), 'tunnelsats-ua-'))
  try {
    copyFileSync(join(REPO, 'bridge.py'), join(dir, 'bridge.py'))
    const userAgentOf = (env: NodeJS.ProcessEnv) =>
      execFileSync(
        'python3',
        ['-c', 'import bridge; print(bridge.user_agent())'],
        { cwd: dir, env, encoding: 'utf8' },
      ).trim()
    const { PACKAGE_VERSION: _unset, ...withoutVersion } = process.env
    assert.equal(userAgentOf({ ...withoutVersion, ...bridgeEnv() }), USER_AGENT)
    // Without either source the version is not guessed.
    assert.equal(userAgentOf(withoutVersion), 'TunnelSats-StartOS/unknown')
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})
