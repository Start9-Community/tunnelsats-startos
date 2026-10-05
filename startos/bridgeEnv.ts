import { isIPv4 } from 'node:net'
import { sdk } from './sdk'
import { current } from './versions/current'

type Effects = Parameters<typeof sdk.host.getBridgeAddress>[0]

/**
 * The Tor service's SOCKS5 binding: `socksHostId` and `socksPort` in
 * startos/utils.ts of Start9Labs/tor-startos, mirrored because tor-startos is
 * not a dependency of this package.
 */
export const TOR_SOCKS_HOST_ID = 'socks'
export const TOR_SOCKS_PORT = 9050

/**
 * The bridge address of the Tor service's SOCKS5 proxy (`10.0.3.1:9050`).
 * `<package>.startos` names (and StartOS 0.3's `tor.embassy`) are not
 * supported; dependents dial this address. 9050 is the one external port
 * StartOS guarantees, so with it as the fallback the value never changes when
 * Tor is installed or removed: `.const()` restarts main only if Tor's binding
 * moves. See "The Tor exception: always-on flags" in
 * https://docs.start9.com/packaging/0.4.0.x/service-to-service.html
 */
export function torSocksAddress(effects: Effects) {
  return sdk.host.getBridgeAddress(effects, {
    packageId: 'tor',
    hostId: TOR_SOCKS_HOST_ID,
    internalPort: TOR_SOCKS_PORT,
    fallbackPort: TOR_SOCKS_PORT,
  })
}

/**
 * torSocksAddress as main reads it: `.const()`, so main re-runs if the
 * address changes. If the first read fails, null (bridgeEnv then leaves the
 * proxy out and Tor-routed NWC connections are refused) instead of failing
 * all of main; main is not re-run when the address becomes readable later.
 */
export function readTorSocksAddress(effects: Effects): Promise<string | null> {
  return torSocksAddress(effects)
    .const()
    .catch((e: unknown) => {
      console.warn(`TunnelSats: Tor SOCKS address unavailable: ${String(e)}`)
      return null
    })
}

/**
 * The environment of every bridge.py process main starts: the daemon and the
 * health and settlement commands. The daemon's sync loop and the health
 * command run NWC auto-renewal.
 *
 * PACKAGE_VERSION: bridge.py's User-Agent version, so both runtimes report the
 * version of this package build (version.json stays its fallback).
 *
 * TOR_SOCKS_HOST, TOR_SOCKS_PORT: the Tor proxy address from torSocksAddress,
 * which Tor-routed NWC relay connections dial. Left out unless it is
 * `<IPv4>:<port>`; bridge.py then refuses those connections instead of
 * dialling anything else.
 */
export function bridgeEnv(
  torSocksAddress: string | null,
): Record<string, string> {
  const env: Record<string, string> = {
    PACKAGE_VERSION: current.options.version,
  }
  const match = /^([0-9.]+):([0-9]{1,5})$/.exec(torSocksAddress ?? '')
  const port = Number(match?.[2])
  if (match && isIPv4(match[1]) && port >= 1 && port <= 65535) {
    env.TOR_SOCKS_HOST = match[1]
    env.TOR_SOCKS_PORT = String(port)
  }
  return env
}

/**
 * How long main lets `bridge.py health subscription` run before SIGKILL
 * (SubContainer.exec's default is 30 s). The command runs NWC auto-renewal,
 * and a renewal killed midway records nothing: no retry is scheduled, the Pay
 * Invoice fallback is never raised, and Renew is refused while the unpaid
 * invoice is valid. A wallet that never answers costs about 50 s per relay
 * (get_budget, get_balance and lookup_invoice 10 s each, pay_invoice 20 s), up
 * to twice that while a relay or the Tor circuit is slow to open, plus the
 * TunnelSats API calls around it.
 */
export const HEALTH_SUBSCRIPTION_TIMEOUT_MS = 300_000

/** SubContainer.exec, as far as bridgeCommands uses it. */
type Exec<R> = (
  command: string[],
  options: { env: Record<string, string> },
  timeoutMs?: number,
) => Promise<R>

/**
 * The bridge.py commands main runs, each with `env` from bridgeEnv. Without a
 * timeout, SubContainer.exec's default applies.
 */
export function bridgeCommands<R>(exec: Exec<R>, env: Record<string, string>) {
  const run = (args: string[], timeoutMs?: number) =>
    exec(['python3', '/app/bridge.py', ...args], { env }, timeoutMs)
  return {
    healthSubscription: () =>
      run(['health', 'subscription'], HEALTH_SUBSCRIPTION_TIMEOUT_MS),
    settle: () => run(['settle']),
    settleAck: (replayIds: string[]) => run(['settle-ack', ...replayIds]),
  }
}

/** The daemon's exec: docker_entrypoint.sh runs `bridge.py start` with `env`. */
export function bridgeDaemonExec(env: Record<string, string>): {
  command: [string, ...string[]]
  env: Record<string, string>
} {
  return { command: ['/app/docker_entrypoint.sh'], env }
}
