import { current } from './versions/current'

/**
 * The environment of every bridge.py process main starts: the daemon and the
 * health and settlement commands.
 *
 * PACKAGE_VERSION: bridge.py's User-Agent version, so both runtimes report the
 * version of this package build (version.json stays its fallback).
 */
export function bridgeEnv(): Record<string, string> {
  return { PACKAGE_VERSION: current.options.version }
}
