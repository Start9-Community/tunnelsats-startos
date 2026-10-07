import { T } from '@start9labs/start-sdk'
import { sdk } from './sdk'
import { configJson } from './fileModels/config.json'
import { tunnelsatsMeta } from './fileModels/tunnelsatsMeta'
import { nwcWallet } from './fileModels/nwcWallet'
import { vpnHandoff } from './fileModels/vpnHandoff'
import { handoffRecheck } from './fileModels/handoffRecheck'
import { readNodeVpnStates } from './handoffIO'
import { i18n } from './i18n'
import { getAnnounceEndpoint, parseWireguardTunnelInfo } from './utils'
import { expiryStage, type NoticeInputs } from './notifications'
export { getAnnounceEndpoint } from './utils'
import { derivePublicKey } from './keygen'
import { renewSubscription } from './actions/renewSubscription'
import { importSubscription } from './actions/importSubscription'
import { connectWallet } from './actions/connectWallet'
import { resolvePayInvoice } from './actions/resolvePayInvoice'
import { payTaskReplayId } from './settlement'
import { metaLockFor, type MetaLock } from './metaLock'
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
 * Replay key of the unknown-key task. Set explicitly: the default for an
 * Import Subscription task would be `tunnelsats:import-subscription`, a
 * retired key that is cleared on every run.
 */
export const UNKNOWN_KEY_TASK_KEY = 'tunnelsats:unknown-key'
/** Replay key of the Connect Wallet own-task (post-restore or budget/fallback warning). */
export const NWC_WALLET_TASK_KEY = 'tunnelsats:connect-wallet'
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

export interface NwcAutoRenewMetaState {
  periodExpiry?: string
  attempts?: number
  lastAttemptAt?: string
  lastError?: string
  lastErrorCode?: string
  fallbackTaskRaised?: boolean
  budgetWarning?: boolean
  remainingBudgetSats?: number
  requiredSats?: number
  restoreReconnectNeeded?: boolean
  lastPaidHash?: string
  lastPaidAt?: string
  lastPaidDuration?: number
  lastPaidAmountSats?: number
  lastPaidNewExpiry?: string
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
  bandwidth_limit_gb?: number
  bandwidth_resets_this_month?: number
  max_resets_per_month?: number
  keyUnknown?: boolean
  nwcConnected?: boolean
  nwcRelayHost?: string
  nwcRouteViaTor?: boolean
  nwcAutoRenewDuration?: 'match' | '1m' | '3m' | '6m' | '12m'
  nwcAutoRenewState?: NwcAutoRenewMetaState | null
  pendingRenewal?: {
    paymentHash: string
    invoice?: string
    targetNode?: TargetNode
    publicKey?: string
    raisePayTask?: boolean
  } | null
  lastRecoveredOrder?: {
    paymentHash: string
    recoveredAt?: string
  }
}

export interface SubscriptionExpiryTask {
  shouldCreateTask: boolean
  severity?: 'important'
  reason?: string
  clearTaskKey: string
}

export interface UnknownKeyTask {
  shouldCreateTask: boolean
  reason?: string
  clearTaskKey: string
}

export interface NwcWalletTask {
  shouldCreateTask: boolean
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

/** The public key of the stored config, or null when it has none. */
export function currentPublicKey(
  wgConf: string | null | undefined,
): string | null {
  const privateKey = parseWireguardTunnelInfo(wgConf).privateKey
  if (!privateKey) return null
  try {
    return derivePublicKey(privateKey)
  } catch {
    return null
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
  if (currentPublicKey(wgConf) !== meta.publicKey) return null
  const expiry = new Date(meta.expiresAt.trim())
  return isNaN(expiry.getTime()) ? null : expiry
}

/**
 * Whether the TunnelSats API has no subscription for the key in the stored
 * config (bridge.py records the verdict, bound to the key it was given for).
 */
export function isKeyUnknown(
  wgConf: string | null | undefined,
  meta: SubscriptionMeta | null | undefined,
): boolean {
  if (meta?.keyUnknown !== true || !meta.publicKey) return false
  return currentPublicKey(wgConf) === meta.publicKey
}

/**
 * The task raised while the configured key is unknown to TunnelSats: it
 * points at Import Subscription, and its reason names Buy Subscription as
 * the other way out. 'important' like every own task (see
 * getSubscriptionExpiryTask).
 */
export function getUnknownKeyTask(
  config:
    | {
        enabled?: boolean
        'tunnelsats-conf'?: string | null
      }
    | null
    | undefined,
  meta?: SubscriptionMeta | null,
): UnknownKeyTask {
  const clearTaskKey = UNKNOWN_KEY_TASK_KEY
  if (
    !config?.enabled ||
    !config['tunnelsats-conf'] ||
    !isKeyUnknown(config['tunnelsats-conf'], meta)
  ) {
    return { shouldCreateTask: false, clearTaskKey }
  }
  return {
    shouldCreateTask: true,
    reason: i18n(
      'TunnelSats has no subscription for the WireGuard key in your configuration. Import a valid configuration here, or run Buy Subscription to get a new one.',
    ),
    clearTaskKey,
  }
}

/**
 * Whether NWC period-specific failure flags (fallbackTaskRaised or
 * budgetWarning) belong to the current confirmed subscription period.
 * Once a manual or external renewal advances `meta.expiresAt` past
 * `st.periodExpiry`, the old period's failure no longer blocks NWC.
 */
export function isCurrentPeriodNwcFailure(
  meta: SubscriptionMeta | null | undefined,
): boolean {
  const st = meta?.nwcAutoRenewState
  if (!st?.fallbackTaskRaised && !st?.budgetWarning) return false
  if (st.periodExpiry && meta?.expiresAt) {
    const periodMs = new Date(st.periodExpiry).getTime()
    const currentMs = new Date(meta.expiresAt).getTime()
    if (!isNaN(periodMs) && !isNaN(currentMs) && currentMs > periodMs) {
      return false
    }
  }
  return true
}

/**
 * Whether NWC automatic renewal is connected, has its secret file present, and
 * has not tripped a budget warning or fallback for the current period.
 */
export function isNwcAutoRenewHealthy(
  meta: SubscriptionMeta | null | undefined,
  walletExists = true,
): boolean {
  if (meta?.nwcConnected !== true || !walletExists) return false
  const st = meta.nwcAutoRenewState
  if (st?.restoreReconnectNeeded || isCurrentPeriodNwcFailure(meta)) {
    return false
  }
  return true
}

/**
 * The own-task pointing at Connect Wallet when:
 * 1. NWC was connected prior to a backup restore, and /data/nwc-wallet.json is
 *    missing (since NWC secrets are excluded from StartOS backups).
 * 2. NWC automatic renewal detected insufficient wallet budget/balance or
 *    failed and fell back to manual intervention for the current period.
 */
export function getNwcWalletTask(
  config:
    | {
        enabled?: boolean
        'tunnelsats-conf'?: string | null
      }
    | null
    | undefined,
  meta?: SubscriptionMeta | null,
  walletExists = true,
): NwcWalletTask {
  const clearTaskKey = NWC_WALLET_TASK_KEY
  if (
    !config?.enabled ||
    !config['tunnelsats-conf'] ||
    meta?.nwcConnected !== true
  ) {
    return { shouldCreateTask: false, clearTaskKey }
  }

  const st = meta.nwcAutoRenewState
  if (!walletExists || st?.restoreReconnectNeeded === true) {
    return {
      shouldCreateTask: true,
      reason: i18n(
        'Reconnect your NWC wallet after backup restore. For security, NWC wallet secrets are excluded from StartOS backups; run Connect Wallet to restore automatic renewals or disconnect NWC.',
      ),
      clearTaskKey,
    }
  }

  if (isCurrentPeriodNwcFailure(meta)) {
    const reasonDetail =
      st?.lastError || 'insufficient wallet budget or relay failure'
    return {
      shouldCreateTask: true,
      reason: i18n(
        'NWC automatic renewal requires attention (${reason}). Run Connect Wallet to update your NWC wallet budget/connection, or approve the Pay Invoice task on your Lightning node.',
        { reason: reasonDetail },
      ),
      clearTaskKey,
    }
  }

  return { shouldCreateTask: false, clearTaskKey }
}

/**
 * What the subscription notices (see notifications.ts) act on, or null while
 * TunnelSats is disabled or unconfigured: the same confirmed expiry and
 * unknown-key verdict as the tasks, bound to the stored key.
 */
export function noticeInputsFor(
  config:
    | {
        enabled?: boolean
        'tunnelsats-conf'?: string | null
      }
    | null
    | undefined,
  meta: SubscriptionMeta | null | undefined,
  walletExists?: boolean,
): NoticeInputs | null {
  if (!config?.enabled || !config['tunnelsats-conf']) return null
  const wgConf = config['tunnelsats-conf']
  const publicKey = currentPublicKey(wgConf)
  const expiry = getConfirmedExpiry(wgConf, meta)
  const keyUnknown = isKeyUnknown(wgConf, meta)

  const st = meta?.nwcAutoRenewState
  const nwcRestoreNeeded =
    meta?.nwcConnected === true &&
    (walletExists === false || st?.restoreReconnectNeeded === true)
  const nwcRenewed =
    st?.lastPaidHash && st.lastPaidNewExpiry
      ? {
          paymentHash: st.lastPaidHash,
          duration: st.lastPaidDuration ?? 1,
          amountSats: st.lastPaidAmountSats ?? 0,
          newExpiry: st.lastPaidNewExpiry,
        }
      : undefined
  const nwcFallback =
    meta?.nwcConnected === true && isCurrentPeriodNwcFailure(meta)
      ? {
          key: `${st?.periodExpiry ?? ''}:${st?.lastErrorCode ?? 'fallback'}`,
          reason:
            st?.lastError || 'insufficient wallet budget or relay failure',
        }
      : undefined
  const recoveredHash = meta?.lastRecoveredOrder?.paymentHash

  return {
    publicKey,
    expiry,
    keyUnknown,
    ...(nwcRestoreNeeded ? { nwcRestoreNeeded: true } : {}),
    ...(nwcRenewed ? { nwcRenewed } : {}),
    ...(nwcFallback ? { nwcFallback } : {}),
    ...(recoveredHash
      ? { recoveredOrder: { paymentHash: recoveredHash } }
      : {}),
  }
}

/**
 * Every expiry task is 'important'. An expiry task is an own task, and
 * StartOS stops the owning service while an own task is active and critical.
 * That would halt the subscription sync that confirms a renewal and clears
 * the task, which is a deadlock.
 *
 * When NWC automatic renewal is connected and healthy, the manual
 * renew-subscription task is suppressed during the 7d/3d pre-expiry window so
 * NWC can renew without nagging the operator; if NWC trips fallback or budget
 * warning (or the subscription lapses without renewal), the task is raised.
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
  walletExists = true,
): SubscriptionExpiryTask {
  const clearTaskKey = EXPIRY_TASK_KEY

  if (!config?.enabled || !config['tunnelsats-conf']) {
    return { shouldCreateTask: false, clearTaskKey }
  }

  const expiryDate = getConfirmedExpiry(config['tunnelsats-conf'], meta)
  if (!expiryDate) {
    return { shouldCreateTask: false, clearTaskKey }
  }

  const stage = expiryStage(expiryDate, currentDate)
  if (
    (stage === '7d' || stage === '3d') &&
    isNwcAutoRenewHealthy(meta, walletExists)
  ) {
    return { shouldCreateTask: false, clearTaskKey }
  }

  switch (stage) {
    case 'lapsed':
      return {
        shouldCreateTask: true,
        severity: 'important',
        reason: i18n(
          "Your TunnelSats subscription has expired. The TunnelSats server disables your tunnel, so your node's clearnet peer connections through TunnelSats stop working. Run Renew Subscription to restore them.",
        ),
        clearTaskKey,
      }
    case '3d':
      return {
        shouldCreateTask: true,
        severity: 'important',
        reason: i18n(
          'Your TunnelSats subscription expires in 3 days or less. Run Renew Subscription to keep your node reachable over clearnet.',
        ),
        clearTaskKey,
      }
    case '7d':
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
  lnd: '>=0.21.3-beta:10',
  'c-lightning': '>=26.6.8:3',
  eclair: '>=0.14.3:3',
} as const

const NODE_HEALTH_CHECKS = {
  lnd: 'lnd',
  'c-lightning': 'lightningd',
  eclair: 'eclair',
} as const

const TOR_VERSION_RANGE = '>=0.4.9.11:2' as const

/**
 * The target node is a running dependency. Nodes that still owe us a
 * confirmed "off" stay declared (as `exists`), because StartOS hides tasks on
 * packages that are not current dependencies. When NWC is connected with Tor
 * routing enabled, `tor` is also declared as a running dependency.
 */
export function getDependenciesForConfig(
  config: { enabled?: boolean; 'target-node'?: TargetNode } | null | undefined,
  pendingOff: readonly PackageId[] = [],
  meta?: { nwcConnected?: boolean; nwcRouteViaTor?: boolean } | null,
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
    > & {
      tor: {
        kind: 'running'
        versionRange: typeof TOR_VERSION_RANGE
        healthChecks: string[]
      }
    }
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

  if (meta?.nwcConnected && meta?.nwcRouteViaTor) {
    deps.tor = {
      kind: 'running',
      versionRange: TOR_VERSION_RANGE,
      healthChecks: ['tor'],
    }
  }

  return deps
}

/** Serializes handoff runs; see createHandoffQueue. */
const enqueueHandoff = createHandoffQueue()

/**
 * Registers a status watch on nodes that may still run the tunnel, so a
 * status change re-runs the handoff: accepting the off-task on a running
 * node rewrites its store.json, which restarts its main. Starting a stopped
 * node re-runs it as well.
 */
async function watchPreviousNodes(
  effects: T.Effects,
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
  raiseUnknownKey: (reason: string) => Promise<unknown>
  raiseNwcWallet?: (reason: string) => Promise<unknown>
  clear: (...keys: string[]) => Promise<unknown>
}

export interface OwnTaskFailure {
  op: 'expiry' | 'unknown-key' | 'nwc-wallet' | 'retired'
  error: string
}

const NO_UNKNOWN_KEY_TASK: UnknownKeyTask = {
  shouldCreateTask: false,
  clearTaskKey: UNKNOWN_KEY_TASK_KEY,
}

/**
 * Raises or clears the Renew reminder, the unknown-key task, and the NWC
 * Connect Wallet task, and clears retired task keys. Never throws: a failure
 * here must not keep the clearnet-vpn handoff from running. Failures are
 * returned so the caller records them for a retry.
 */
export async function updateOwnTasks(
  expiryTask: SubscriptionExpiryTask,
  ops: OwnTaskOps,
  unknownKeyTask: UnknownKeyTask = NO_UNKNOWN_KEY_TASK,
  nwcWalletTask?: NwcWalletTask,
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
  await attempt('unknown-key', () =>
    unknownKeyTask.shouldCreateTask && unknownKeyTask.reason
      ? ops.raiseUnknownKey(unknownKeyTask.reason)
      : ops.clear(unknownKeyTask.clearTaskKey),
  )
  if (nwcWalletTask && ops.raiseNwcWallet) {
    const raiseNwc = ops.raiseNwcWallet
    await attempt('nwc-wallet', () =>
      nwcWalletTask.shouldCreateTask && nwcWalletTask.reason
        ? raiseNwc(nwcWalletTask.reason)
        : ops.clear(nwcWalletTask.clearTaskKey),
    )
  }
  await attempt('retired', () => ops.clear(...RETIRED_TASK_KEYS))
  return failures
}

/**
 * When NWC auto-renewal creates a renewal invoice and falls back to manual
 * payment (insufficient wallet budget/balance or after K=3 transient failures),
 * raises the target Lightning node's Pay Invoice task via resolvePayInvoice
 * and clears `pendingRenewal.raisePayTask` under meta_lock.
 */
export async function raiseFallbackRenewalPayTask(params: {
  config: { 'target-node'?: TargetNode } | null | undefined
  meta: SubscriptionMeta | null | undefined
  lockMeta: MetaLock
  createTask: (task: {
    packageId: PackageId
    payInvoiceAction: ReturnType<typeof resolvePayInvoice>['payInvoiceAction']
    replayId: string
    invoice: string
    reason: string
  }) => Promise<unknown>
  clearRaiseFlag: (paymentHash: string) => Promise<unknown>
}): Promise<boolean> {
  const pending = params.meta?.pendingRenewal
  if (!pending?.raisePayTask || !pending.invoice || !pending.paymentHash) {
    return false
  }
  const targetNode: TargetNode =
    pending.targetNode ?? params.config?.['target-node'] ?? 'lnd'
  const { packageId, payInvoiceAction } = resolvePayInvoice(targetNode)
  await params.createTask({
    packageId: packageId as PackageId,
    payInvoiceAction,
    replayId: payTaskReplayId('renewal', targetNode, pending.paymentHash),
    invoice: pending.invoice,
    reason: i18n('Pay TunnelSats VPN subscription renewal invoice'),
  })
  await params.lockMeta(async () => {
    await params.clearRaiseFlag(pending.paymentHash)
  })
  return true
}

async function handOffClearnetVpn(
  effects: T.Effects,
  config: Parameters<typeof getTargetVpnConfig>[0],
  retryOwnTasks: boolean,
): Promise<void> {
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
}

/**
 * Own tasks, the fallback Pay Invoice task and the clearnet-vpn handoff. Its
 * vpn-handoff.json write re-runs the dependency declarations below.
 */
export const handoffInit = sdk.setupOnInit(async (effects) => {
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

  await enqueueHandoff(
    async () => ({
      config: await configJson.read().once(),
      meta: await tunnelsatsMeta
        .read()
        .once()
        .catch(() => null),
      wallet: await nwcWallet
        .read()
        .once()
        .catch(() => null),
    }),
    async ({ config, meta, wallet }) => {
      const walletExists = Boolean(wallet?.uri)
      // 1. Own tasks: the Renew reminder, the unknown-key task, the NWC
      // Connect Wallet task, and retired task keys. Guarded so a failure
      // never skips the handoff; it is recorded and retried via the handoff
      // health check.
      const ownTaskFailures = await updateOwnTasks(
        getSubscriptionExpiryTask(config, meta, new Date(), walletExists),
        {
          raiseExpiry: (severity, reason) =>
            sdk.action.createOwnTask(effects, renewSubscription, severity, {
              reason,
            }),
          raiseUnknownKey: (reason) =>
            sdk.action.createOwnTask(effects, importSubscription, 'important', {
              reason,
              replayId: UNKNOWN_KEY_TASK_KEY,
            }),
          raiseNwcWallet: (reason) =>
            sdk.action.createOwnTask(effects, connectWallet, 'important', {
              reason,
              replayId: NWC_WALLET_TASK_KEY,
            }),
          clear: (...keys) => sdk.action.clearTask(effects, ...keys),
        },
        getUnknownKeyTask(config, meta),
        getNwcWalletTask(config, meta, walletExists),
      )
      for (const f of ownTaskFailures) {
        console.error(
          `TunnelSats: updating the ${f.op} task failed (will retry): ${f.error}`,
        )
      }

      // 2. If NWC auto-renewal fell back on a pending renewal invoice, raise
      // the target node's Pay Invoice task via resolvePayInvoice.
      let fallbackFailed = false
      if (meta?.pendingRenewal?.raisePayTask) {
        await raiseFallbackRenewalPayTask({
          config,
          meta,
          lockMeta: metaLockFor(effects),
          createTask: ({
            packageId,
            payInvoiceAction,
            replayId,
            invoice,
            reason,
          }) =>
            sdk.action.createTask(
              effects,
              packageId,
              payInvoiceAction,
              'important',
              {
                replayId,
                input: {
                  kind: 'partial',
                  accept: [],
                  set: {
                    invoice,
                    amount: { selection: 'invoice', value: {} },
                    'max-fee-percent': 1,
                    confirmed: false,
                  },
                },
                reason,
              },
            ),
          clearRaiseFlag: async (paymentHash) => {
            const latest = await tunnelsatsMeta
              .read()
              .once()
              .catch(() => null)
            if (latest?.pendingRenewal?.paymentHash === paymentHash) {
              await tunnelsatsMeta.merge(effects, {
                pendingRenewal: {
                  ...latest.pendingRenewal,
                  raisePayTask: undefined,
                },
              })
            }
          },
        }).catch((e) => {
          fallbackFailed = true
          console.error(
            `TunnelSats: raising fallback Pay Invoice task failed (will retry): ${e}`,
          )
        })
      }

      // 3. Clearnet-VPN handoff: on-task for the target, off-task for the rest.
      await handOffClearnetVpn(
        effects,
        config,
        ownTaskFailures.length > 0 || fallbackFailed,
      )
    },
  )
})

/**
 * getDependenciesForConfig for the stored config, NWC routing and pending
 * nodes. Only installed nodes can be declared: a queued clear for an
 * uninstalled node must not surface as a missing dependency.
 */
async function declaredDependencies(effects: T.Effects) {
  const config = await configJson
    .read((c) => ({ enabled: c.enabled, 'target-node': c['target-node'] }))
    .const(effects)
  const meta = await tunnelsatsMeta
    .read((m) => ({
      nwcConnected: m.nwcConnected,
      nwcRouteViaTor: m.nwcRouteViaTor,
    }))
    .const(effects)
    .catch(() => null)
  const pendingOff =
    (await vpnHandoff
      .read((h) => h.pendingOff)
      .const(effects)
      .catch(() => null)) ?? []
  const installed =
    pendingOff.length > 0 ? await effects.getInstalledPackages() : []
  return getDependenciesForConfig(
    config,
    pendingOff.filter((p) => installed.includes(p)),
    meta,
  )
}

const node = (
  id: PackageId,
  description: string,
  title: string,
  icon: string,
) =>
  sdk.Dependency.optional(id, {
    description,
    metadata: { title, icon },
    versionRange: NODE_VERSION_RANGES[id],
    kind: 'exists',
    enabled: async ({ effects }) =>
      (await declaredDependencies(effects))[id] !== undefined,
  }).withDynamicNarrowing(async ({ effects }) =>
    (await declaredDependencies(effects))[id]?.kind === 'running'
      ? { kind: 'running', healthChecks: [NODE_HEALTH_CHECKS[id]] }
      : null,
  )

export const dependencies = sdk.Dependencies.of()
  .addDependency(
    node(
      'lnd',
      'Lightning Network Daemon. Required if you choose LND as your Target Lightning Node for inbound connections.',
      'LND',
      'https://raw.githubusercontent.com/Start9Labs/lnd-startos/refs/heads/master/icon.svg',
    ),
  )
  .addDependency(
    node(
      'c-lightning',
      'Core Lightning. Required if you choose Core Lightning as your Target Lightning Node for inbound connections.',
      'Core Lightning',
      'https://raw.githubusercontent.com/Start9Labs/cln-startos/refs/heads/master/icon.svg',
    ),
  )
  .addDependency(
    node(
      'eclair',
      'Eclair. Required if you choose Eclair as your Target Lightning Node for inbound connections.',
      'Eclair',
      'https://raw.githubusercontent.com/Start9Labs/eclair-startos/refs/heads/master/icon.png',
    ),
  )
  .addDependency(
    sdk.Dependency.optional('tor', {
      description:
        'Tor SOCKS5 Proxy. Required when routing NWC wallet connections through Tor or connecting to a .onion NWC relay.',
      metadata: {
        title: 'Tor',
        icon: 'https://raw.githubusercontent.com/Start9Labs/tor-startos/refs/heads/master/icon.svg',
      },
      versionRange: TOR_VERSION_RANGE,
      kind: 'running',
      healthChecks: ['tor'],
      enabled: async ({ effects }) =>
        (await declaredDependencies(effects)).tor !== undefined,
    }),
  )
