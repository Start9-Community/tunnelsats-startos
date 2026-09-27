import { sdk } from './sdk'
import { configJson } from './fileModels/config.json'
import { tunnelsatsMeta } from './fileModels/tunnelsatsMeta'
import { vpnHandoff } from './fileModels/vpnHandoff'
import { handoffRecheck } from './fileModels/handoffRecheck'
import { readNodeVpnStates } from './handoffIO'
import { i18n } from './i18n'
import { getAnnounceEndpoint, parseWireguardTunnelInfo } from './utils'
export { getAnnounceEndpoint } from './utils'
import { derivePublicKey } from './keygen'
import { renewSubscription } from './actions/renewSubscription'
import {
  type PackageId,
  planClearnetVpnTasks,
  executeClearnetVpnPlan,
  nextStateAfter,
  sameHandoffState,
  createHandoffQueue,
  previousNodes,
  handedOverTarget,
  buildOnTaskInput,
  buildOffTaskInput,
  clearnetVpnReplayId,
} from './vpnHandoff'
import { clearnetVpn as lndClearnetVpn } from 'lnd-startos/startos/actions/clearnetVpn'
import { clearnetVpn as clnClearnetVpn } from 'cln-startos/startos/actions/clearnetVpn'
import { clearnetVpn as eclairClearnetVpn } from 'eclair-startos/startos/actions/clearnetVpn'

export type { PackageId } from './vpnHandoff'
export type TargetNode = 'lnd' | 'cln' | 'eclair'

/** All three clearnet-vpn actions share the same input shape */
const clearnetVpnActions = {
  lnd: lndClearnetVpn,
  'c-lightning': clnClearnetVpn,
  eclair: eclairClearnetVpn,
} as const

/** Replay key of the expiry task. */
export const EXPIRY_TASK_KEY = 'tunnelsats:renew-subscription'
/**
 * Task keys raised by earlier versions: expiry tasks that pointed at
 * Configure / Import Subscription, and the external-host announcement tasks
 * of the retired gateway routing. StartOS never reaps a replay key that is no
 * longer written, so an upgraded box would keep offering obsolete routing
 * changes. They are cleared on every run.
 */
export const RETIRED_TASK_KEYS: readonly string[] = [
  'tunnelsats:configure',
  'tunnelsats:import-subscription',
  'lnd:custom-external-host-config',
  'c-lightning:config',
]

export interface TargetVpnConfig {
  targetPackage: PackageId
  clearPackages: PackageId[]
  announceEndpoint: string | null
  wgConf: string
}

export interface SubscriptionMeta {
  expiresAt?: string
  expirySource?: 'api'
  publicKey?: string
  lastSync?: string
  syncSuccess?: boolean
  syncError?: string | null
  serverDomain?: string
  vpnPort?: number
  bandwidth_used_gb?: number
}

export interface SubscriptionExpiryTask {
  shouldCreateTask: boolean
  severity?: 'important'
  reason?: string
  clearTaskKey: string
}

/**
 * Maps a config target-node value to the StartOS package ID.
 */
export function resolvePackageId(targetNode: TargetNode): PackageId {
  switch (targetNode) {
    case 'cln':
      return 'c-lightning'
    case 'eclair':
      return 'eclair'
    case 'lnd':
    default:
      return 'lnd'
  }
}

/**
 * Returns all package IDs except the active one (for clearing stale tasks).
 */
export function getInactivePackageIds(active: PackageId): PackageId[] {
  return (['lnd', 'c-lightning', 'eclair'] as PackageId[]).filter(
    (id) => id !== active,
  )
}

export function getTargetVpnConfig(
  config:
    | {
        enabled?: boolean
        'target-node'?: TargetNode
        'tunnelsats-conf'?: string | null
        'allow-ipv6'?: boolean
      }
    | null
    | undefined,
): TargetVpnConfig | null {
  if (!config?.enabled || !config['tunnelsats-conf']) return null

  const targetPackage = resolvePackageId(config['target-node'] ?? 'lnd')
  const clearPackages = getInactivePackageIds(targetPackage)
  const announceEndpoint = getAnnounceEndpoint(
    config['tunnelsats-conf'],
    config['allow-ipv6'],
  )

  return {
    targetPackage,
    clearPackages,
    announceEndpoint,
    wgConf: config['tunnelsats-conf'],
  }
}

/**
 * The subscription expiry this package may act on: the value the TunnelSats
 * API returned for the key in the stored config. The `# Valid Until` comment
 * is a hint only and never counts, and neither does an expiry that was
 * confirmed for a different key (e.g. before a new config was imported).
 */
export function getConfirmedExpiry(
  wgConf: string | null | undefined,
  meta: SubscriptionMeta | null | undefined,
): Date | null {
  if (!meta?.expiresAt || meta.expirySource !== 'api' || !meta.publicKey) {
    return null
  }
  const privateKey = parseWireguardTunnelInfo(wgConf).privateKey
  if (!privateKey) return null
  let currentPublicKey: string
  try {
    currentPublicKey = derivePublicKey(privateKey)
  } catch {
    return null
  }
  if (currentPublicKey !== meta.publicKey) return null
  const expiry = new Date(meta.expiresAt.trim())
  return isNaN(expiry.getTime()) ? null : expiry
}

/**
 * Every expiry task is 'important'. An expiry task is an own task, and
 * StartOS stops the owning service while an own task is active and critical.
 * That would halt the subscription sync that confirms a renewal and clears
 * the task, which is a deadlock.
 */
export function getSubscriptionExpiryTask(
  config:
    | {
        enabled?: boolean
        'tunnelsats-conf'?: string | null
      }
    | null
    | undefined,
  meta?: SubscriptionMeta | null,
  currentDate = new Date(),
): SubscriptionExpiryTask {
  const clearTaskKey = EXPIRY_TASK_KEY

  if (!config?.enabled || !config['tunnelsats-conf']) {
    return { shouldCreateTask: false, clearTaskKey }
  }

  const expiryDate = getConfirmedExpiry(config['tunnelsats-conf'], meta)
  if (!expiryDate) {
    return { shouldCreateTask: false, clearTaskKey }
  }

  const timeDiffMs = expiryDate.getTime() - currentDate.getTime()
  const daysRemaining = Math.floor(timeDiffMs / (1000 * 60 * 60 * 24))

  if (timeDiffMs <= 0) {
    return {
      shouldCreateTask: true,
      severity: 'important',
      reason: i18n(
        'Your TunnelSats subscription has expired, and your node holds its clearnet traffic until it is renewed. Run Renew Subscription to restore it.',
      ),
      clearTaskKey,
    }
  }

  if (daysRemaining <= 3) {
    return {
      shouldCreateTask: true,
      severity: 'important',
      reason: i18n(
        'Your TunnelSats subscription expires in 3 days or less. Run Renew Subscription to keep your node reachable over clearnet.',
      ),
      clearTaskKey,
    }
  }

  if (daysRemaining <= 7) {
    return {
      shouldCreateTask: true,
      severity: 'important',
      reason: i18n(
        'Your TunnelSats subscription expires in 7 days or less. Run Renew Subscription to keep your node reachable over clearnet.',
      ),
      clearTaskKey,
    }
  }

  return { shouldCreateTask: false, clearTaskKey }
}

const NODE_VERSION_RANGES = {
  lnd: '>=0.15.5:0',
  'c-lightning': '>=23.2.2:0',
  eclair: '>=0.10.0:0',
} as const

const NODE_HEALTH_CHECKS = {
  lnd: 'lnd',
  'c-lightning': 'lightningd',
  eclair: 'eclair',
} as const

/**
 * The target node is a running dependency. Nodes that still owe us a
 * confirmed "off" stay declared (as `exists`), because StartOS hides tasks on
 * packages that are not current dependencies.
 */
export function getDependenciesForConfig(
  config: { enabled?: boolean; 'target-node'?: TargetNode } | null | undefined,
  pendingOff: readonly PackageId[] = [],
) {
  const deps: Partial<
    Record<
      PackageId,
      | {
          kind: 'running'
          versionRange: (typeof NODE_VERSION_RANGES)[PackageId]
          healthChecks: string[]
        }
      | {
          kind: 'exists'
          versionRange: (typeof NODE_VERSION_RANGES)[PackageId]
        }
    >
  > = {}

  if (config?.enabled) {
    const target = resolvePackageId(config['target-node'] ?? 'lnd')
    deps[target] = {
      kind: 'running',
      versionRange: NODE_VERSION_RANGES[target],
      healthChecks: [NODE_HEALTH_CHECKS[target]],
    }
  }

  for (const p of pendingOff) {
    if (!deps[p]) {
      deps[p] = { kind: 'exists', versionRange: NODE_VERSION_RANGES[p] }
    }
  }

  return deps
}

/** Serializes handoff runs; see createHandoffQueue. */
const enqueueHandoff = createHandoffQueue()

/**
 * Registers a status watch on nodes that may still run the tunnel, so a
 * status change re-runs setupDependencies: accepting the off-task on a
 * running node rewrites its store.json, which restarts its main. Starting a
 * stopped node re-runs it as well.
 */
async function watchPreviousNodes(
  effects: Parameters<typeof sdk.checkDependencies>[0],
  nodes: readonly PackageId[],
): Promise<void> {
  for (const p of nodes) {
    try {
      await sdk.getStatus(effects, { packageId: p }).const()
    } catch (e) {
      console.warn(
        `TunnelSats: could not watch ${p} status; the held on-task is released on the next re-run:`,
        e,
      )
    }
  }
}

export interface OwnTaskOps {
  raiseExpiry: (
    severity: NonNullable<SubscriptionExpiryTask['severity']>,
    reason: string,
  ) => Promise<unknown>
  clear: (...keys: string[]) => Promise<unknown>
}

export interface OwnTaskFailure {
  op: 'expiry' | 'retired'
  error: string
}

/**
 * Raises or clears the Renew reminder and clears retired task keys. Never
 * throws: a failure here must not keep the clearnet-vpn handoff from
 * running. Failures are returned so the caller records them for a retry.
 */
export async function updateOwnTasks(
  expiryTask: SubscriptionExpiryTask,
  ops: OwnTaskOps,
): Promise<OwnTaskFailure[]> {
  const failures: OwnTaskFailure[] = []
  const attempt = async (
    op: OwnTaskFailure['op'],
    fn: () => Promise<unknown>,
  ) => {
    try {
      await fn()
    } catch (e) {
      failures.push({ op, error: e instanceof Error ? e.message : String(e) })
    }
  }
  await attempt('expiry', () =>
    expiryTask.shouldCreateTask && expiryTask.severity && expiryTask.reason
      ? ops.raiseExpiry(expiryTask.severity, expiryTask.reason)
      : ops.clear(expiryTask.clearTaskKey),
  )
  await attempt('retired', () => ops.clear(...RETIRED_TASK_KEYS))
  return failures
}

async function handOffClearnetVpn(
  effects: Parameters<typeof sdk.checkDependencies>[0],
  config: Parameters<typeof getTargetVpnConfig>[0],
  retryOwnTasks: boolean,
): Promise<PackageId[]> {
  const state = await vpnHandoff
    .read()
    .once()
    .catch((e) => {
      console.error(
        'TunnelSats: could not read vpn-handoff.json; checking every installed node instead:',
        e,
      )
      return null
    })
  const installed = await effects.getInstalledPackages()
  const desired = getTargetVpnConfig(config)
  const nodes = previousNodes(state, installed, handedOverTarget(desired))
  await watchPreviousNodes(effects, nodes)
  const nodeVpn = await readNodeVpnStates(effects, nodes, {
    ownConf: config?.['tunnelsats-conf'],
    handedOutKeys: state?.handedOutKeys ?? [],
  })

  const plan = planClearnetVpnTasks({ desired, state, installed, nodeVpn })
  if (plan.held) {
    console.info(
      `TunnelSats: holding the clearnet-vpn on-task for ${plan.held.packageId} until ${plan.held.waitingFor.join(', ')} confirm off`,
    )
  }

  const outcome = await executeClearnetVpnPlan(plan, {
    raiseOn: (on) =>
      sdk.action.createTask(
        effects,
        on.packageId,
        clearnetVpnActions[on.packageId],
        'important',
        {
          input: buildOnTaskInput(on.config, on.announce),
          when: { condition: 'input-not-matches', once: false },
          reason: i18n(
            'Activate TunnelSats VPN tunnel and advertise clearnet endpoint to the Lightning Network',
          ),
        },
      ),
    raiseOff: (packageId) =>
      sdk.action.createTask(
        effects,
        packageId,
        clearnetVpnActions[packageId],
        'important',
        {
          input: buildOffTaskInput(),
          when: { condition: 'input-not-matches', once: false },
          reason: i18n(
            'Turn off the TunnelSats tunnel on this node. TunnelSats now routes a different node or has been switched off; the new node is asked to take over once this one is off.',
          ),
        },
      ),
    clear: (packageId) =>
      sdk.action.clearTask(effects, clearnetVpnReplayId(packageId)),
  })
  for (const f of outcome.failures) {
    console.error(
      `TunnelSats: clearnet-vpn ${f.op} task on ${f.packageId} failed (will retry): ${f.error}`,
    )
  }
  if (outcome.withheldOn) {
    console.warn(
      `TunnelSats: withholding the clearnet-vpn on-task for ${outcome.withheldOn.packageId} until the task on ${outcome.withheldOn.until.join(', ')} is cleared`,
    )
  }

  const next = { ...nextStateAfter(plan, outcome), retryOwnTasks }
  if (!sameHandoffState(state, next)) {
    await vpnHandoff.write(effects, next)
  }

  // Only installed nodes can be declared: a queued clear for an uninstalled
  // node must not surface as a missing dependency.
  return next.pendingOff.filter((p) => installed.includes(p))
}

export const setDependencies = sdk.setupDependencies(async ({ effects }) => {
  // These reads only register the watches that re-run this hook. The run
  // itself acts on what is read inside the queue (see createHandoffQueue):
  // a run that waited behind a newer change must not act on older state.
  await configJson.read().const(effects)
  await tunnelsatsMeta
    .read()
    .const(effects)
    .catch(() => null)
  // The handoff health check writes handoffRecheck when a pending node turned
  // off without a status change, or a task could not be raised.
  await handoffRecheck
    .read()
    .const(effects)
    .catch(() => null)

  const { config, result: pendingOff } = await enqueueHandoff(
    async () => ({
      config: await configJson.read().once(),
      meta: await tunnelsatsMeta
        .read()
        .once()
        .catch(() => null),
    }),
    async ({ config, meta }) => {
      // 1. Own tasks: the Renew reminder, driven only by the API-confirmed
      // expiry, and retired task keys. Guarded so a failure never skips the
      // handoff; it is recorded and retried via the handoff health check.
      const ownTaskFailures = await updateOwnTasks(
        getSubscriptionExpiryTask(config, meta),
        {
          raiseExpiry: (severity, reason) =>
            sdk.action.createOwnTask(effects, renewSubscription, severity, {
              reason,
            }),
          clear: (...keys) => sdk.action.clearTask(effects, ...keys),
        },
      )
      for (const f of ownTaskFailures) {
        console.error(
          `TunnelSats: updating the ${f.op} task failed (will retry): ${f.error}`,
        )
      }

      // 2. Clearnet-VPN handoff: on-task for the target, off-task for the rest.
      return handOffClearnetVpn(effects, config, ownTaskFailures.length > 0)
    },
  )

  return getDependenciesForConfig(config.config, pendingOff)
})
