import { current } from './versions/current'

/**
 * The User-Agent of every TunnelSats API request. bridge.py sends the same
 * value (user_agent()): it reads PACKAGE_VERSION, which main passes from this
 * version (bridgeEnv.ts), or else version.json, which scripts/sync-version.js
 * writes from it. Both drop the ExVer revision (`1.0.0:0` -> `1.0.0`).
 */
export const USER_AGENT = `TunnelSats-StartOS/${current.options.version.split(':')[0]}`
