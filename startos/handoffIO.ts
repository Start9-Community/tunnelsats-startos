import { sdk } from './sdk'
import { configJson } from './fileModels/config.json'
import { vpnHandoff } from './fileModels/vpnHandoff'
import { handoffRecheck } from './fileModels/handoffRecheck'
import {
  type PackageId,
  type NodeVpnState,
  type HandoffProgress,
  type TunnelOwnership,
  CLEARNET_VPN_ACTION_ID,
  readNodeVpnState,
  runHandoffRecheck,
} from './vpnHandoff'

type Effects = Parameters<typeof sdk.checkDependencies>[0]

/**
 * Reads each node's current clearnet-vpn input, the same value StartOS checks
 * a task against. Works whether or not the node is a declared dependency. A
 * node that cannot answer (stopped container, still initializing) is
 * unknown, which the planner treats as on.
 */
export async function readNodeVpnStates(
  effects: Effects,
  nodes: readonly PackageId[],
  ownership: TunnelOwnership,
): Promise<Partial<Record<PackageId, NodeVpnState>>> {
  const states: Partial<Record<PackageId, NodeVpnState>> = {}
  for (const p of nodes) {
    try {
      const input = await effects.action.getInput({
        packageId: p,
        actionId: CLEARNET_VPN_ACTION_ID,
      })
      states[p] = readNodeVpnState(input?.value, ownership)
      if (states[p] === 'foreign') {
        console.info(`TunnelSats: ${p} runs a VPN TunnelSats did not configure`)
      }
    } catch (e) {
      console.warn(
        `TunnelSats: could not read the clearnet-vpn state of ${p}; treating it as on:`,
        e,
      )
      states[p] = 'unknown'
    }
  }
  return states
}

/** Wires runHandoffRecheck to the real StartOS effects. */
export async function checkHandoffProgress(
  effects: Effects,
): Promise<HandoffProgress> {
  return runHandoffRecheck({
    readState: () => vpnHandoff.read().once(),
    readInstalled: () => effects.getInstalledPackages(),
    readNodeVpn: async (nodes, state) => {
      const config = await configJson.read().once()
      return readNodeVpnStates(effects, nodes, {
        ownConf: config?.['tunnelsats-conf'],
        handedOutKeys: state.handedOutKeys ?? [],
      })
    },
    requestRecheck: () =>
      handoffRecheck.write(effects, {
        requestedAt: new Date().toISOString(),
      }),
  })
}
