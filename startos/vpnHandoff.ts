/**
 * Clearnet-VPN handoff between TunnelSats and the Lightning nodes.
 *
 * The node owns the tunnel (`clearnet-vpn` action in lnd/cln/eclair-startos);
 * this package only raises tasks. An empty `config` turns the node's VPN off,
 * so whenever the subscription moves to another node or is switched off, the
 * node we previously handed the tunnel to receives an "off" task. Otherwise
 * that node would keep running the same WireGuard key as the new node, and
 * the two would fight over one tunnel (handshake flapping, inbound delivered
 * to whichever node handshook last).
 *
 * Whether a node is off is read from the node itself: the current input of
 * its clearnet-vpn action (effects.action.getInput), the same value StartOS
 * compares a task against. Anything unreadable counts as on (fail closed).
 * Only a TunnelSats tunnel counts as on: our current key, a key we handed
 * out before (`handedOutKeys`, public keys only), or a tunnelsats.com
 * endpoint. Any other VPN is 'foreign' and left alone, even on a node we
 * track: the operator replaced our tunnel, and turning theirs off would cut
 * a VPN we never configured. Deciding by key rather than by the record keeps
 * both cases right: an older TunnelSats key behind a bare IP is still ours,
 * a replacement VPN never is.
 *
 * Limitation: a tunnel handed out before `handedOutKeys` existed is only
 * recognised by our current key or its endpoint host. TunnelSats configs use
 * tunnelsats.com hostnames, and no released build handed out clearnet-vpn
 * tunnels, so this only affects hand-edited or pre-release installs.
 *
 * StartOS does not reap tasks that are not re-raised, and it hides tasks on
 * packages that are not current dependencies, so every node that still owes
 * an off stays in `pendingOff` (declared as an `exists` dependency by the
 * caller) until it is off or uninstalled.
 *
 * StartOS cannot order tasks across packages either, so the new node's
 * on-task is withheld until every previous node is off or uninstalled. The
 * caller watches those nodes' status, so accepting the off-task on a running
 * node (which restarts it) re-runs the planner and releases the on-task.
 * StartOS offers no change notification for action input, so an off-task
 * accepted on a node that stays stopped changes nothing the status watch
 * sees. For that case a TunnelSats health check polls pending nodes
 * (runHandoffRecheck) and requests a re-run once one of them is off.
 *
 * Without a handoff record (fresh install, upgrade from a build that had
 * none, unreadable file) every installed node other than the target is
 * checked, so a tunnel handed out before the record existed is found too.
 */

import { derivePublicKey } from './keygen'

export type PackageId = 'lnd' | 'c-lightning' | 'eclair'

export const ALL_PACKAGE_IDS: readonly PackageId[] = [
  'lnd',
  'c-lightning',
  'eclair',
]

export const CLEARNET_VPN_ACTION_ID = 'clearnet-vpn'

export function clearnetVpnReplayId(packageId: PackageId): string {
  return `${packageId}:${CLEARNET_VPN_ACTION_ID}`
}

export interface VpnHandoffState {
  /** The node we last raised an on-task for. */
  activeTarget: PackageId | null
  /** Nodes that still owe us an off. */
  pendingOff: PackageId[]
  /**
   * Public keys of the tunnels we raised an on-task with, oldest first.
   * Deliberately uncapped: an evicted key would make a node still running
   * that tunnel read as foreign, so it would never be asked to turn it off.
   * A key is only added when a new WireGuard key is handed out (a new
   * subscription), so the list stays small. Missing in records written
   * before it existed.
   */
  handedOutKeys?: string[]
  /**
   * Nodes whose on- or off-task could not be raised on the last run. The
   * handoff health check requests a re-run while any is installed, so a
   * transient failure never leaves the operator without a task.
   */
  unraised?: PackageId[]
  /**
   * Updating our own tasks (Renew reminder, retired task keys) failed on the
   * last run; the handoff health check requests a re-run while set.
   */
  retryOwnTasks?: boolean
}

export const EMPTY_HANDOFF_STATE: VpnHandoffState = {
  activeTarget: null,
  pendingOff: [],
  handedOutKeys: [],
  unraised: [],
  retryOwnTasks: false,
}

/** What identifies a tunnel as one TunnelSats handed out. */
export interface TunnelOwnership {
  /** The WireGuard config TunnelSats currently holds. */
  ownConf: string | null | undefined
  /** Public keys of tunnels handed out before (VpnHandoffState). */
  handedOutKeys: readonly string[]
}

export interface DesiredVpn {
  targetPackage: PackageId
  announceEndpoint: string | null
  wgConf: string
}

/**
 * A node's clearnet-vpn state as read from its action input: 'on' is a
 * TunnelSats tunnel, 'foreign' a VPN TunnelSats did not configure (never
 * ours to turn off), 'unknown' unreadable (treated as on).
 */
export type NodeVpnState = 'on' | 'off' | 'foreign' | 'unknown'

export interface ClearnetVpnPlan {
  on: { packageId: PackageId; config: string; announce: string } | null
  /** The target's on-task, withheld until these nodes are off. */
  held: { packageId: PackageId; waitingFor: PackageId[] } | null
  /** Nodes to raise (or keep raising) the off-task on. */
  off: PackageId[]
  /** Nodes that are off or gone; their task gets cleared. */
  retire: PackageId[]
  next: VpnHandoffState
}

function isPackageId(v: unknown): v is PackageId {
  return typeof v === 'string' && (ALL_PACKAGE_IDS as string[]).includes(v)
}

/**
 * The nodes that may still run a tunnel we handed out: those in the record,
 * or, without a record, every installed node. The target is never one.
 */
export function previousNodes(
  state: VpnHandoffState | null | undefined,
  installed: readonly string[],
  target: PackageId | null,
): PackageId[] {
  const from = state
    ? [...(state.pendingOff ?? []), state.activeTarget]
    : ALL_PACKAGE_IDS.filter((p) => installed.includes(p))
  const out: PackageId[] = []
  for (const p of from) {
    if (isPackageId(p) && p !== target && !out.includes(p)) out.push(p)
  }
  return out
}

/** Only a config we can announce is handed over; never a half-configured tunnel. */
export function handedOverTarget(desired: DesiredVpn | null): PackageId | null {
  return desired && desired.announceEndpoint ? desired.targetPackage : null
}

export function planClearnetVpnTasks(params: {
  desired: DesiredVpn | null
  /** null: no handoff record (see module doc). */
  state: VpnHandoffState | null | undefined
  installed: readonly string[]
  nodeVpn: Partial<Record<PackageId, NodeVpnState>>
}): ClearnetVpnPlan {
  const { desired, installed, nodeVpn } = params
  const prev = params.state ?? EMPTY_HANDOFF_STATE

  const target = handedOverTarget(desired)
  const onCandidate =
    desired && target
      ? {
          packageId: target,
          config: desired.wgConf,
          announce: desired.announceEndpoint as string,
        }
      : null

  // A foreign VPN is never ours to turn off, tracked node or not: ownership
  // is decided by key (see module doc), so an older TunnelSats key behind a
  // bare IP still reads as on.
  const off: PackageId[] = []
  const retire: PackageId[] = []
  for (const p of previousNodes(params.state, installed, target)) {
    const vpn = nodeVpn[p]
    if (!installed.includes(p) || vpn === 'off' || vpn === 'foreign') {
      retire.push(p)
    } else {
      off.push(p)
    }
  }

  // StartOS cannot order tasks across packages. If the new node's on-task
  // were raised while a previous node may still run the tunnel, accepting it
  // first would put one WireGuard key on two nodes. So it is withheld until
  // every previous node is off or uninstalled. A target that already holds
  // the tunnel is never withheld.
  const hold =
    onCandidate !== null && prev.activeTarget !== target && off.length > 0
  const on = hold ? null : onCandidate

  return {
    on,
    held: hold && target ? { packageId: target, waitingFor: [...off] } : null,
    off,
    retire,
    next: {
      activeTarget: on ? target : null,
      pendingOff: off,
      handedOutKeys: recordHandedOut(
        prev.handedOutKeys ?? [],
        on ? tunnelFingerprint(on.config) : null,
      ),
    },
  }
}

/**
 * Appends a handed-out key (moved to the end if already known). Recorded
 * when the on-task is planned, even if raising it then fails: the key is
 * ours either way.
 */
function recordHandedOut(
  keys: readonly string[],
  key: string | null,
): string[] {
  const out = [
    ...new Set(keys.filter((k) => typeof k === 'string' && k && k !== key)),
  ]
  if (key) out.push(key)
  return out
}

export function buildOnTaskInput(config: string, announce: string) {
  return {
    kind: 'partial' as const,
    accept: [{ config, announce }],
    set: { config, announce },
  }
}

export function buildOffTaskInput() {
  return {
    kind: 'partial' as const,
    accept: [{ config: null }],
    set: { config: null, announce: null },
  }
}

const PRIVATE_KEY_LINE = /^[ \t]*PrivateKey[ \t]*=[ \t]*(\S+)/im
const ENDPOINT_LINE = /^[ \t]*Endpoint[ \t]*=[ \t]*(\S+)/im

function endpointHost(endpoint: string): string {
  if (endpoint.startsWith('[')) {
    const end = endpoint.indexOf(']')
    return end === -1 ? endpoint : endpoint.slice(1, end)
  }
  return endpoint.replace(/:\d+$/, '')
}

/**
 * The public key of a WireGuard config's interface, or null when the config
 * has no parsable private key. Public keys are what we persist, so the
 * handoff record never holds a secret.
 */
export function tunnelFingerprint(
  config: string | null | undefined,
): string | null {
  const key = config?.match(PRIVATE_KEY_LINE)?.[1]
  if (!key) return null
  try {
    return derivePublicKey(key)
  } catch {
    return null
  }
}

/**
 * A tunnel TunnelSats handed out: it uses our current WireGuard key or one we
 * handed out before, or it peers with a TunnelSats server.
 */
export function isTunnelsatsTunnel(
  config: string,
  ownership: TunnelOwnership,
): boolean {
  const key = config.match(PRIVATE_KEY_LINE)?.[1]
  const ownKey = ownership.ownConf?.match(PRIVATE_KEY_LINE)?.[1]
  if (key && ownKey && key === ownKey) return true
  const fingerprint = tunnelFingerprint(config)
  if (fingerprint && ownership.handedOutKeys.includes(fingerprint)) return true
  const endpoint = config.match(ENDPOINT_LINE)?.[1]
  if (!endpoint) return false
  const host = endpointHost(endpoint).toLowerCase()
  return host === 'tunnelsats.com' || host.endsWith('.tunnelsats.com')
}

/**
 * A node's clearnet-vpn state from its current action input
 * (`{ config, announce }`). Unreadable or unexpected input is unknown.
 */
export function readNodeVpnState(
  value: Record<string, unknown> | null | undefined,
  ownership: TunnelOwnership,
): NodeVpnState {
  if (!value) return 'unknown'
  const config = value.config
  if (config === null || config === undefined) return 'off'
  if (typeof config !== 'string') return 'unknown'
  if (!config.trim()) return 'off'
  return isTunnelsatsTunnel(config, ownership) ? 'on' : 'foreign'
}

export interface ClearnetVpnOps {
  raiseOn: (on: NonNullable<ClearnetVpnPlan['on']>) => Promise<unknown>
  raiseOff: (packageId: PackageId) => Promise<unknown>
  /**
   * Clears the task TunnelSats raised on this node, if any. StartOS keeps
   * tasks in the raising package's task map and clear_tasks only mutates the
   * caller's own map, so retiring a node (including one running a foreign
   * VPN) never removes a prompt another package raised there.
   */
  clear: (packageId: PackageId) => Promise<unknown>
}

export interface ClearnetVpnOutcome {
  raised: PackageId[]
  cleared: PackageId[]
  /**
   * The on-task this run did not raise because clearing another node's task
   * failed (not an operational failure of the on-task itself).
   */
  withheldOn: { packageId: PackageId; until: PackageId[] } | null
  failures: {
    packageId: PackageId
    op: 'on' | 'off' | 'clear'
    error: string
  }[]
}

/**
 * Applies a plan. Every operation is idempotent, and a failed one is retried
 * on the next run because the plan's `next` state keeps it pending. Failures
 * are returned rather than thrown, so one unreachable node cannot block the
 * handoff on the others.
 *
 * Retired tasks are cleared first and the on-task is raised last, only when
 * every clear succeeded. A node that never accepted its on-task reads as off
 * and is retired; if its task survived, the operator could accept both it
 * and the new node's on-task and run one WireGuard key on two nodes.
 */
export async function executeClearnetVpnPlan(
  plan: ClearnetVpnPlan,
  ops: ClearnetVpnOps,
): Promise<ClearnetVpnOutcome> {
  const outcome: ClearnetVpnOutcome = {
    raised: [],
    cleared: [],
    withheldOn: null,
    failures: [],
  }
  const attempt = async (
    packageId: PackageId,
    op: 'on' | 'off' | 'clear',
    fn: () => Promise<unknown>,
  ) => {
    try {
      await fn()
      ;(op === 'clear' ? outcome.cleared : outcome.raised).push(packageId)
    } catch (e) {
      outcome.failures.push({
        packageId,
        op,
        error: e instanceof Error ? e.message : String(e),
      })
    }
  }

  for (const p of plan.retire) await attempt(p, 'clear', () => ops.clear(p))
  for (const p of plan.off) await attempt(p, 'off', () => ops.raiseOff(p))
  if (plan.on) {
    const on = plan.on
    const uncleared = outcome.failures
      .filter((f) => f.op === 'clear')
      .map((f) => f.packageId)
    if (uncleared.length > 0) {
      outcome.withheldOn = { packageId: on.packageId, until: uncleared }
    } else {
      await attempt(on.packageId, 'on', () => ops.raiseOn(on))
    }
  }
  return outcome
}

/**
 * The state to persist after a plan ran. A node whose task clear failed stays
 * in `pendingOff`, so the next run retries the clear instead of stranding an
 * obsolete prompt. A withheld on-task leaves no active target, so the next
 * run treats the target as new again. A node whose raise failed is already
 * pending (off) or the target (on), so the next run raises it again; it is
 * listed in `unraised` so the handoff health check requests that run.
 */
export function nextStateAfter(
  plan: ClearnetVpnPlan,
  outcome: ClearnetVpnOutcome,
): Required<VpnHandoffState> {
  const pendingOff = [...plan.next.pendingOff]
  const unraised: PackageId[] = []
  for (const f of outcome.failures) {
    const list = f.op === 'clear' ? pendingOff : unraised
    if (!list.includes(f.packageId)) list.push(f.packageId)
  }
  return {
    activeTarget: outcome.withheldOn ? null : plan.next.activeTarget,
    pendingOff,
    handedOutKeys: [...(plan.next.handedOutKeys ?? [])],
    unraised,
    retryOwnTasks: false,
  }
}

/**
 * Whether persisting `next` would change nothing. A missing record (null) is
 * never the same, so the first run always writes one.
 */
export function sameHandoffState(
  prev: VpnHandoffState | null | undefined,
  next: VpnHandoffState,
): boolean {
  if (!prev) return false
  const same = (a: readonly string[], b: readonly string[]) =>
    a.length === b.length && a.every((v, i) => v === b[i])
  return (
    (prev.activeTarget ?? null) === next.activeTarget &&
    same(prev.pendingOff ?? [], next.pendingOff) &&
    same(prev.handedOutKeys ?? [], next.handedOutKeys ?? []) &&
    same(prev.unraised ?? [], next.unraised ?? []) &&
    (prev.retryOwnTasks ?? false) === (next.retryOwnTasks ?? false)
  )
}

/** Display names for operator-facing messages. */
export const NODE_TITLES: Record<PackageId, string> = {
  lnd: 'LND',
  'c-lightning': 'Core Lightning',
  eclair: 'Eclair',
}

export interface HandoffProgress {
  /** Pending nodes that may still run the tunnel. */
  waitingFor: PackageId[]
  /**
   * Pending nodes that are off, uninstalled or now run a foreign VPN; the
   * next run retires them.
   */
  resolved: PackageId[]
  /** Installed nodes whose task could not be raised; the next run retries. */
  retrying: PackageId[]
  /** Updating our own tasks failed; the next run retries. */
  retryingOwnTasks: boolean
}

/** Classifies the recorded pending nodes the same way the planner does. */
export function handoffProgress(
  state: VpnHandoffState | null | undefined,
  installed: readonly string[],
  nodeVpn: Partial<Record<PackageId, NodeVpnState>>,
): HandoffProgress {
  const progress: HandoffProgress = {
    waitingFor: [],
    resolved: [],
    retrying: [
      ...new Set(
        (state?.unraised ?? []).filter(
          (p) => isPackageId(p) && installed.includes(p),
        ),
      ),
    ],
    retryingOwnTasks: state?.retryOwnTasks ?? false,
  }
  for (const p of new Set((state?.pendingOff ?? []).filter(isPackageId))) {
    const vpn = nodeVpn[p]
    if (!installed.includes(p) || vpn === 'off' || vpn === 'foreign') {
      progress.resolved.push(p)
    } else {
      progress.waitingFor.push(p)
    }
  }
  return progress
}

export interface HandoffRecheckOps {
  readState: () => Promise<VpnHandoffState | null>
  readInstalled: () => Promise<readonly string[]>
  /** `state` carries the handed-out keys ownership is decided by. */
  readNodeVpn: (
    nodes: readonly PackageId[],
    state: VpnHandoffState,
  ) => Promise<Partial<Record<PackageId, NodeVpnState>>>
  /** Makes setupDependencies re-run (it watches the recheck file). */
  requestRecheck: () => Promise<unknown>
}

/**
 * Polled by a health check. Reports handoff progress and requests a
 * setupDependencies re-run when a pending node turned off without a status
 * change (off-task accepted on a stopped node), so the held on-task is
 * released, or when a task (a node's or our own) could not be updated last
 * run, so it is retried (the poll interval is the backoff).
 */
export async function runHandoffRecheck(
  ops: HandoffRecheckOps,
): Promise<HandoffProgress> {
  const state = await ops.readState()
  const pending = (state?.pendingOff ?? []).filter(isPackageId)
  if (
    !state ||
    (pending.length === 0 &&
      (state.unraised ?? []).length === 0 &&
      !state.retryOwnTasks)
  ) {
    return {
      waitingFor: [],
      resolved: [],
      retrying: [],
      retryingOwnTasks: false,
    }
  }
  const installed = await ops.readInstalled()
  const toRead = pending.filter((p) => installed.includes(p))
  const nodeVpn = toRead.length > 0 ? await ops.readNodeVpn(toRead, state) : {}
  const progress = handoffProgress(state, installed, nodeVpn)
  if (
    progress.resolved.length > 0 ||
    progress.retrying.length > 0 ||
    progress.retryingOwnTasks
  ) {
    await ops.requestRecheck()
  }
  return progress
}

/**
 * setupDependencies re-runs whenever a watched file changes, and runs can
 * overlap. The handoff reads its previous state and writes the next one, so
 * runs are serialized; otherwise a quick lnd->cln->eclair switch could lose
 * the off-task for lnd. The configuration is read only once a run holds the
 * queue: a run that read it before queueing could, after a newer target
 * change completed, redo the handoff for the old target.
 */
export function createHandoffQueue() {
  let tail: Promise<unknown> = Promise.resolve()
  return function enqueue<C, T>(
    readConfig: () => Promise<C>,
    run: (config: C) => Promise<T>,
  ): Promise<{ config: C; result: T }> {
    const job = async () => {
      const config = await readConfig()
      return { config, result: await run(config) }
    }
    const p = tail.then(job, job)
    tail = p.catch(() => undefined)
    return p
  }
}
