import test from 'node:test'
import assert from 'node:assert/strict'
import {
  planClearnetVpnTasks,
  readNodeVpnState,
  executeClearnetVpnPlan,
  nextStateAfter,
  handoffProgress,
  runHandoffRecheck,
  buildOnTaskInput,
  buildOffTaskInput,
  tunnelFingerprint,
  sameHandoffState,
  createHandoffQueue,
  type ClearnetVpnPlan,
  type VpnHandoffState,
} from '../startos/vpnHandoff'
import { generateWireguardKeypair } from '../startos/keygen'
import { getTargetVpnConfig } from '../startos/dependencies'

/** The fields every plan test asserts on; handedOutKeys has its own tests. */
const core = (s: VpnHandoffState) => ({
  activeTarget: s.activeTarget,
  pendingOff: s.pendingOff,
})

const CONF =
  '[Interface]\nPrivateKey = x\n[Peer]\nEndpoint = de2.tunnelsats.com:51820\n'
const ALL_INSTALLED = ['lnd', 'c-lightning', 'eclair']
const ALL_OFF = { lnd: 'off', 'c-lightning': 'off', eclair: 'off' } as const

function desired(
  targetPackage: 'lnd' | 'c-lightning' | 'eclair',
  announceEndpoint: string | null = 'de2.tunnelsats.com:24556',
) {
  return { targetPackage, announceEndpoint, wgConf: CONF }
}

// --- bootstrap (no handoff record: fresh install, upgrade, unreadable file)

test('bootstrap: nodes without a tunnel are retired and the target gets its on-task at once', () => {
  const plan = planClearnetVpnTasks({
    desired: desired('lnd'),
    state: null,
    installed: ALL_INSTALLED,
    nodeVpn: ALL_OFF,
  })
  assert.deepEqual(plan.on, {
    packageId: 'lnd',
    config: CONF,
    announce: 'de2.tunnelsats.com:24556',
  })
  assert.equal(plan.held, null)
  assert.deepEqual(plan.off, [])
  assert.deepEqual(plan.retire, ['c-lightning', 'eclair'])
  assert.deepEqual(core(plan.next), { activeTarget: 'lnd', pendingOff: [] })
})

test('bootstrap: a node that already runs a tunnel is asked to turn off first', () => {
  // e.g. a box upgraded from a build that handed out clearnet-vpn tasks
  // before the handoff record existed.
  const plan = planClearnetVpnTasks({
    desired: desired('c-lightning'),
    state: null,
    installed: ALL_INSTALLED,
    nodeVpn: { lnd: 'on', eclair: 'off' },
  })
  assert.equal(plan.on, null)
  assert.deepEqual(plan.held, {
    packageId: 'c-lightning',
    waitingFor: ['lnd'],
  })
  assert.deepEqual(plan.off, ['lnd'])
  assert.deepEqual(plan.retire, ['eclair'])
  assert.deepEqual(core(plan.next), { activeTarget: null, pendingOff: ['lnd'] })
})

test('bootstrap: a VPN TunnelSats did not configure is left alone and does not block activation', () => {
  const plan = planClearnetVpnTasks({
    desired: desired('lnd'),
    state: null,
    installed: ALL_INSTALLED,
    nodeVpn: { 'c-lightning': 'foreign', eclair: 'off' },
  })
  assert.equal(plan.on?.packageId, 'lnd')
  assert.equal(plan.held, null)
  assert.deepEqual(plan.off, [])
  assert.deepEqual(plan.retire, ['c-lightning', 'eclair'])
})

test('a tracked node whose tunnel was replaced by an unrelated VPN is left alone', () => {
  const plan = planClearnetVpnTasks({
    desired: desired('c-lightning'),
    state: { activeTarget: 'lnd', pendingOff: [] },
    installed: ALL_INSTALLED,
    nodeVpn: { lnd: 'foreign' },
  })
  assert.equal(plan.on?.packageId, 'c-lightning')
  assert.deepEqual(plan.off, [])
  assert.deepEqual(plan.retire, ['lnd'])
})

test('bootstrap: a node whose state cannot be read holds the on-task (fail closed)', () => {
  const plan = planClearnetVpnTasks({
    desired: desired('lnd'),
    state: null,
    installed: ['lnd', 'eclair'],
    nodeVpn: {},
  })
  assert.equal(plan.on, null)
  assert.deepEqual(plan.off, ['eclair'])
})

test('bootstrap with TunnelSats off and no node tunnels leaves nothing behind', () => {
  const plan = planClearnetVpnTasks({
    desired: null,
    state: null,
    installed: ALL_INSTALLED,
    nodeVpn: ALL_OFF,
  })
  assert.equal(plan.on, null)
  assert.deepEqual(plan.off, [])
  assert.deepEqual(core(plan.next), { activeTarget: null, pendingOff: [] })
})

// --- tracked transitions

test('first activation with an empty record raises the on-task on the target only', () => {
  const plan = planClearnetVpnTasks({
    desired: desired('lnd'),
    state: { activeTarget: null, pendingOff: [] },
    installed: ALL_INSTALLED,
    nodeVpn: {},
  })
  assert.equal(plan.on?.packageId, 'lnd')
  assert.deepEqual(plan.off, [])
  assert.deepEqual(plan.retire, [])
  assert.deepEqual(core(plan.next), { activeTarget: 'lnd', pendingOff: [] })
})

test('switching nodes raises the off-task on the previous node and holds the new on-task', () => {
  const plan = planClearnetVpnTasks({
    desired: desired('c-lightning'),
    state: { activeTarget: 'lnd', pendingOff: [] },
    installed: ALL_INSTALLED,
    nodeVpn: { lnd: 'on' },
  })
  // lnd still runs the tunnel: raising c-lightning's on-task now would let
  // both nodes run the same WireGuard key.
  assert.equal(plan.on, null)
  assert.deepEqual(plan.held, {
    packageId: 'c-lightning',
    waitingFor: ['lnd'],
  })
  assert.deepEqual(plan.off, ['lnd'])
  assert.deepEqual(plan.retire, [])
  assert.deepEqual(core(plan.next), { activeTarget: null, pendingOff: ['lnd'] })
})

test('the held on-task is raised once the previous node is off', () => {
  const plan = planClearnetVpnTasks({
    desired: desired('c-lightning'),
    state: { activeTarget: null, pendingOff: ['lnd'] },
    installed: ALL_INSTALLED,
    nodeVpn: { lnd: 'off' },
  })
  assert.equal(plan.on?.packageId, 'c-lightning')
  assert.equal(plan.held, null)
  assert.deepEqual(plan.retire, ['lnd'])
  assert.deepEqual(core(plan.next), {
    activeTarget: 'c-lightning',
    pendingOff: [],
  })
})

test('the held on-task is raised when the previous node is uninstalled', () => {
  const plan = planClearnetVpnTasks({
    desired: desired('c-lightning'),
    state: { activeTarget: null, pendingOff: ['lnd'] },
    installed: ['c-lightning'],
    nodeVpn: {},
  })
  assert.equal(plan.on?.packageId, 'c-lightning')
  assert.deepEqual(plan.retire, ['lnd'])
})

test('a previous node whose state cannot be read keeps holding the on-task (fail closed)', () => {
  // Covers a stopped or still-initializing node: started before turning its
  // tunnel off, it would bring the tunnel back up next to the new node.
  const plan = planClearnetVpnTasks({
    desired: desired('c-lightning'),
    state: { activeTarget: 'lnd', pendingOff: [] },
    installed: ALL_INSTALLED,
    nodeVpn: { lnd: 'unknown' },
  })
  assert.equal(plan.on, null)
  assert.deepEqual(plan.held, { packageId: 'c-lightning', waitingFor: ['lnd'] })
  assert.deepEqual(plan.off, ['lnd'])
})

test('an already-active target is never held (the owing node stays tracked)', () => {
  const plan = planClearnetVpnTasks({
    desired: desired('c-lightning'),
    state: { activeTarget: 'c-lightning', pendingOff: ['lnd'] },
    installed: ALL_INSTALLED,
    nodeVpn: { lnd: 'on' },
  })
  assert.equal(plan.on?.packageId, 'c-lightning')
  assert.deepEqual(core(plan.next), {
    activeTarget: 'c-lightning',
    pendingOff: ['lnd'],
  })
})

test('turning the subscription off raises the off-task on the active node', () => {
  const plan = planClearnetVpnTasks({
    desired: null,
    state: { activeTarget: 'eclair', pendingOff: [] },
    installed: ALL_INSTALLED,
    nodeVpn: { eclair: 'on' },
  })
  assert.equal(plan.on, null)
  assert.deepEqual(plan.off, ['eclair'])
  assert.deepEqual(core(plan.next), {
    activeTarget: null,
    pendingOff: ['eclair'],
  })
})

test('a config that cannot be announced is handed over as off, never as a half-configured tunnel', () => {
  const plan = planClearnetVpnTasks({
    desired: desired('lnd', null),
    state: { activeTarget: 'lnd', pendingOff: [] },
    installed: ALL_INSTALLED,
    nodeVpn: { lnd: 'on' },
  })
  assert.equal(plan.on, null)
  assert.deepEqual(plan.off, ['lnd'])
  assert.deepEqual(core(plan.next), { activeTarget: null, pendingOff: ['lnd'] })
})

test('an uninstalled pending node is retired (its tunnel went with it)', () => {
  const plan = planClearnetVpnTasks({
    desired: desired('c-lightning'),
    state: { activeTarget: 'lnd', pendingOff: ['eclair'] },
    installed: ['c-lightning', 'lnd'],
    nodeVpn: { lnd: 'on' },
  })
  assert.deepEqual(plan.off, ['lnd'])
  assert.deepEqual(plan.retire, ['eclair'])
  assert.deepEqual(plan.next.pendingOff, ['lnd'])
})

test('switching back to a node that owes an off waits for the other node, then hands it the on-task', () => {
  const held = planClearnetVpnTasks({
    desired: desired('lnd'),
    state: { activeTarget: 'c-lightning', pendingOff: ['lnd'] },
    installed: ALL_INSTALLED,
    nodeVpn: { 'c-lightning': 'on', lnd: 'on' },
  })
  assert.equal(held.on, null)
  assert.deepEqual(held.off, ['c-lightning'])
  assert.deepEqual(core(held.next), {
    activeTarget: null,
    pendingOff: ['c-lightning'],
  })

  const released = planClearnetVpnTasks({
    desired: desired('lnd'),
    state: held.next,
    installed: ALL_INSTALLED,
    nodeVpn: { 'c-lightning': 'off' },
  })
  assert.equal(released.on?.packageId, 'lnd')
  assert.deepEqual(released.retire, ['c-lightning'])
  assert.deepEqual(core(released.next), { activeTarget: 'lnd', pendingOff: [] })
})

test('re-enabling the node that owes an off hands it the on-task directly', () => {
  const plan = planClearnetVpnTasks({
    desired: desired('lnd'),
    state: { activeTarget: null, pendingOff: ['lnd'] },
    installed: ALL_INSTALLED,
    nodeVpn: { lnd: 'on' },
  })
  assert.equal(plan.on?.packageId, 'lnd')
  assert.deepEqual(plan.off, [])
  assert.deepEqual(core(plan.next), { activeTarget: 'lnd', pendingOff: [] })
})

test('switching away and back before the previous node turned off never forces an off/on cycle', () => {
  // lnd runs the tunnel; the operator picks c-lightning, then lnd again
  // before lnd accepted its off-task.
  const away = planClearnetVpnTasks({
    desired: desired('c-lightning'),
    state: { activeTarget: 'lnd', pendingOff: [] },
    installed: ALL_INSTALLED,
    nodeVpn: { lnd: 'on' },
  })
  assert.equal(away.on, null)
  assert.deepEqual(core(away.next), { activeTarget: null, pendingOff: ['lnd'] })

  const back = planClearnetVpnTasks({
    desired: desired('lnd'),
    state: away.next,
    installed: ALL_INSTALLED,
    nodeVpn: { lnd: 'on' },
  })
  // lnd is the target again: its off-task is replaced by the on-task (same
  // replay id) at once, and c-lightning never received anything.
  assert.equal(back.on?.packageId, 'lnd')
  assert.equal(back.held, null)
  assert.deepEqual(back.off, [])
  assert.deepEqual(back.retire, [])
  assert.deepEqual(core(back.next), { activeTarget: 'lnd', pendingOff: [] })
})

test('duplicate and malformed state entries are normalised', () => {
  const plan = planClearnetVpnTasks({
    desired: null,
    state: {
      activeTarget: 'lnd',
      pendingOff: ['lnd', 'lnd', 'eclair', 'bogus' as never],
    },
    installed: ALL_INSTALLED,
    nodeVpn: {},
  })
  assert.deepEqual(plan.off, ['lnd', 'eclair'])
})

// --- contract helpers

test('task inputs follow the node clearnet-vpn contract', () => {
  assert.deepEqual(buildOnTaskInput(CONF, 'h:1'), {
    kind: 'partial',
    accept: [{ config: CONF, announce: 'h:1' }],
    set: { config: CONF, announce: 'h:1' },
  })
  // An empty config turns the node's VPN off (lnd/cln/eclair clearnet-vpn).
  assert.deepEqual(buildOffTaskInput(), {
    kind: 'partial',
    accept: [{ config: null }],
    set: { config: null, announce: null },
  })
})

test('readNodeVpnState only claims TunnelSats-owned tunnels, unknown when unreadable', () => {
  const OWN =
    '[Interface]\nPrivateKey = OWNKEY=\n[Peer]\nEndpoint = 203.0.113.7:51820\n'
  const O = { ownConf: OWN, handedOutKeys: [] }
  const conf = (key: string, endpoint: string) =>
    `[Interface]\nPrivateKey = ${key}\nAddress = 10.9.0.2/32\n[Peer]\nEndpoint = ${endpoint}\n`
  // TunnelSats endpoint, any key (e.g. a previous subscription's key)
  assert.equal(
    readNodeVpnState(
      { config: conf('OLDKEY=', 'de2.tunnelsats.com:51820') },
      O,
    ),
    'on',
  )
  assert.equal(
    readNodeVpnState(
      { config: conf('OLDKEY=', 'DE2.TunnelSats.com:51820') },
      { ownConf: null, handedOutKeys: [] },
    ),
    'on',
  )
  // Our current key, even behind a bare IP endpoint
  assert.equal(
    readNodeVpnState({ config: conf('OWNKEY=', '203.0.113.7:51820') }, O),
    'on',
  )
  // Someone else's VPN
  assert.equal(
    readNodeVpnState({ config: conf('OTHER=', 'vpn.example.com:51820') }, O),
    'foreign',
  )
  assert.equal(
    readNodeVpnState({ config: conf('OTHER=', 'eviltunnelsats.com:51820') }, O),
    'foreign',
  )
  assert.equal(
    readNodeVpnState({ config: conf('OTHER=', '[2001:db8::1]:51820') }, O),
    'foreign',
  )
  // A commented-out key never matches
  assert.equal(
    readNodeVpnState(
      {
        config: '# PrivateKey = OWNKEY=\n[Peer]\nEndpoint = 203.0.113.7:51820',
      },
      O,
    ),
    'foreign',
  )
  assert.equal(readNodeVpnState({ config: null, announce: null }, O), 'off')
  assert.equal(readNodeVpnState({ config: '   ' }, O), 'off')
  assert.equal(readNodeVpnState({}, O), 'off')
  assert.equal(readNodeVpnState(null, O), 'unknown')
  assert.equal(readNodeVpnState(undefined, O), 'unknown')
  assert.equal(readNodeVpnState({ config: 42 }, O), 'unknown')
})

test('executeClearnetVpnPlan raises on/off, clears retired, and reports failures separately', async () => {
  const calls: string[] = []
  const plan: ClearnetVpnPlan = {
    on: { packageId: 'c-lightning', config: CONF, announce: 'h:1' },
    held: null,
    off: ['lnd', 'eclair'],
    retire: ['eclair'],
    next: { activeTarget: 'c-lightning', pendingOff: ['lnd', 'eclair'] },
  }
  const outcome = await executeClearnetVpnPlan(plan, {
    raiseOn: async (on) => {
      calls.push(`on:${on.packageId}`)
    },
    raiseOff: async (pkg) => {
      calls.push(`off:${pkg}`)
      if (pkg === 'eclair') throw new Error('boom')
    },
    clear: async (pkg) => {
      calls.push(`clear:${pkg}`)
    },
  })
  // Clears run first, the on-task last.
  assert.deepEqual(calls, [
    'clear:eclair',
    'off:lnd',
    'off:eclair',
    'on:c-lightning',
  ])
  assert.deepEqual(outcome.raised, ['lnd', 'c-lightning'])
  assert.deepEqual(outcome.cleared, ['eclair'])
  assert.equal(outcome.withheldOn, null)
  assert.equal(outcome.failures.length, 1)
  assert.equal(outcome.failures[0].packageId, 'eclair')
  assert.equal(outcome.failures[0].op, 'off')
})

test('a failed clear withholds the on-task, so two nodes never hold an on-task at once', async () => {
  // lnd never accepted its on-task, so it reads off and is retired; if its
  // task cannot be cleared, the new node must not be offered one too.
  const calls: string[] = []
  const plan: ClearnetVpnPlan = {
    on: { packageId: 'c-lightning', config: CONF, announce: 'h:1' },
    held: null,
    off: [],
    retire: ['lnd'],
    next: { activeTarget: 'c-lightning', pendingOff: [], handedOutKeys: [] },
  }
  const outcome = await executeClearnetVpnPlan(plan, {
    raiseOn: async (on) => {
      calls.push(`on:${on.packageId}`)
    },
    raiseOff: async () => {},
    clear: async (pkg) => {
      calls.push(`clear:${pkg}`)
      throw new Error('boom')
    },
  })
  assert.deepEqual(calls, ['clear:lnd'])
  assert.deepEqual(outcome.raised, [])
  assert.deepEqual(outcome.withheldOn, {
    packageId: 'c-lightning',
    until: ['lnd'],
  })
  assert.deepEqual(outcome.failures, [
    { packageId: 'lnd', op: 'clear', error: 'boom' },
  ])
  // Nothing was handed over: no active target, the clear stays queued, and
  // the next run retries the clear before offering the on-task again.
  assert.deepEqual(core(nextStateAfter(plan, outcome)), {
    activeTarget: null,
    pendingOff: ['lnd'],
  })
})

test('nextStateAfter keeps a node whose task clear failed queued for a retry', () => {
  const plan: ClearnetVpnPlan = {
    on: { packageId: 'c-lightning', config: CONF, announce: 'h:1' },
    held: null,
    off: ['eclair'],
    retire: ['lnd'],
    next: {
      activeTarget: 'c-lightning',
      pendingOff: ['eclair'],
      handedOutKeys: ['K='],
    },
  }
  assert.deepEqual(
    core(
      nextStateAfter(plan, {
        raised: ['c-lightning', 'eclair'],
        cleared: [],
        withheldOn: null,
        failures: [{ packageId: 'lnd', op: 'clear', error: 'boom' }],
      }),
    ),
    { activeTarget: 'c-lightning', pendingOff: ['eclair', 'lnd'] },
  )
  // A raise failure keeps the plan's state and lists the node in unraised,
  // so the health check requests the retry.
  assert.deepEqual(
    nextStateAfter(plan, {
      raised: [],
      cleared: ['lnd'],
      withheldOn: null,
      failures: [
        { packageId: 'c-lightning', op: 'on', error: 'x' },
        { packageId: 'eclair', op: 'off', error: 'y' },
      ],
    }),
    { ...plan.next, unraised: ['c-lightning', 'eclair'], retryOwnTasks: false },
  )
})

test('handoffProgress splits pending nodes into waiting and resolved', () => {
  assert.deepEqual(
    handoffProgress(
      { activeTarget: 'c-lightning', pendingOff: ['lnd', 'eclair'] },
      ['lnd', 'c-lightning', 'eclair'],
      { lnd: 'on', eclair: 'off' },
    ),
    {
      waitingFor: ['lnd'],
      resolved: ['eclair'],
      retrying: [],
      retryingOwnTasks: false,
    },
  )
  // Uninstalled and foreign (the operator replaced our tunnel) resolve, the
  // same as in the planner; unknown keeps waiting (fail closed).
  assert.deepEqual(
    handoffProgress(
      { activeTarget: null, pendingOff: ['lnd', 'eclair', 'c-lightning'] },
      ['eclair', 'c-lightning'],
      { eclair: 'foreign' },
    ),
    {
      waitingFor: ['c-lightning'],
      resolved: ['lnd', 'eclair'],
      retrying: [],
      retryingOwnTasks: false,
    },
  )
  assert.deepEqual(handoffProgress(null, ALL_INSTALLED, {}), {
    waitingFor: [],
    resolved: [],
    retrying: [],
    retryingOwnTasks: false,
  })
  // Only installed nodes are retried: a task cannot be raised on a node that
  // is gone.
  assert.deepEqual(
    handoffProgress(
      { activeTarget: null, pendingOff: [], unraised: ['lnd', 'eclair'] },
      ['eclair'],
      {},
    ).retrying,
    ['eclair'],
  )
})

test('runHandoffRecheck requests a dependency re-run only when a pending node resolved', async () => {
  const run = async (
    state: Parameters<typeof handoffProgress>[0],
    nodeVpn: Parameters<typeof handoffProgress>[2],
  ) => {
    const calls: string[] = []
    const progress = await runHandoffRecheck({
      readState: async () => state,
      readInstalled: async () => ALL_INSTALLED,
      readNodeVpn: async (nodes, passed) => {
        assert.equal(passed, state)
        calls.push(`read:${nodes.join(',')}`)
        return nodeVpn
      },
      requestRecheck: async () => {
        calls.push('recheck')
      },
    })
    return { progress, calls }
  }

  // An off-task accepted on a stopped node: no status change, but the
  // recheck notices the node is off and re-runs setupDependencies.
  const accepted = await run(
    { activeTarget: null, pendingOff: ['lnd'] },
    { lnd: 'off' },
  )
  assert.deepEqual(accepted.calls, ['read:lnd', 'recheck'])
  assert.deepEqual(accepted.progress, {
    waitingFor: [],
    resolved: ['lnd'],
    retrying: [],
    retryingOwnTasks: false,
  })

  const waiting = await run(
    { activeTarget: null, pendingOff: ['lnd'] },
    { lnd: 'on' },
  )
  assert.deepEqual(waiting.calls, ['read:lnd'])
  assert.deepEqual(waiting.progress.waitingFor, ['lnd'])

  // Nothing pending: no node is read at all.
  const idle = await run({ activeTarget: 'lnd', pendingOff: [] }, {})
  assert.deepEqual(idle.calls, [])
})

function realConf(privateKey: string, endpoint: string) {
  return `[Interface]\nPrivateKey = ${privateKey}\nAddress = 10.9.0.2/32\n[Peer]\nPublicKey = ${generateWireguardKeypair().publicKey}\nEndpoint = ${endpoint}\n`
}

test('the planner records the key of every tunnel it hands out', () => {
  const kp = generateWireguardKeypair()
  const conf = realConf(kp.privateKey, 'de2.tunnelsats.com:51820')
  const plan = planClearnetVpnTasks({
    desired: { targetPackage: 'lnd', announceEndpoint: 'h:1', wgConf: conf },
    state: { activeTarget: null, pendingOff: [], handedOutKeys: ['OLD='] },
    installed: ALL_INSTALLED,
    nodeVpn: {},
  })
  assert.equal(tunnelFingerprint(conf), kp.publicKey)
  assert.deepEqual(plan.next.handedOutKeys, ['OLD=', kp.publicKey])

  // Held: nothing handed out, keys unchanged.
  const held = planClearnetVpnTasks({
    desired: { targetPackage: 'lnd', announceEndpoint: 'h:1', wgConf: conf },
    state: { activeTarget: 'eclair', pendingOff: [], handedOutKeys: ['OLD='] },
    installed: ALL_INSTALLED,
    nodeVpn: { eclair: 'on' },
  })
  assert.equal(held.on, null)
  assert.deepEqual(held.next.handedOutKeys, ['OLD='])
})

test('handedOutKeys stays de-duplicated and never forgets a key', () => {
  const kp = generateWireguardKeypair()
  const conf = realConf(kp.privateKey, 'de2.tunnelsats.com:51820')
  const many = Array.from({ length: 40 }, (_, i) => `K${i}=`)
  const plan = planClearnetVpnTasks({
    desired: { targetPackage: 'lnd', announceEndpoint: 'h:1', wgConf: conf },
    state: {
      activeTarget: 'lnd',
      pendingOff: [],
      handedOutKeys: [...many, kp.publicKey],
    },
    installed: ALL_INSTALLED,
    nodeVpn: {},
  })
  // No cap: an evicted key would make a node still running that tunnel read
  // as foreign and keep it running.
  const keys = plan.next.handedOutKeys ?? []
  assert.equal(keys.length, 41)
  assert.equal(keys[0], 'K0=')
  assert.equal(keys[keys.length - 1], kp.publicKey)
  assert.equal(new Set(keys).size, keys.length)
})

test('readNodeVpnState recognises an older key TunnelSats handed out, even behind a bare IP', () => {
  const old = generateWireguardKeypair()
  const current = generateWireguardKeypair()
  const other = generateWireguardKeypair()
  const ownership = {
    ownConf: realConf(current.privateKey, 'de2.tunnelsats.com:51820'),
    handedOutKeys: [old.publicKey],
  }
  assert.equal(
    readNodeVpnState(
      { config: realConf(old.privateKey, '203.0.113.7:51820') },
      ownership,
    ),
    'on',
  )
  assert.equal(
    readNodeVpnState(
      { config: realConf(other.privateKey, '203.0.113.7:51820') },
      ownership,
    ),
    'foreign',
  )
  // A config whose key cannot be parsed falls back to the endpoint check.
  assert.equal(
    readNodeVpnState(
      {
        config:
          '[Interface]\nPrivateKey = junk\n[Peer]\nEndpoint = vpn.example.com:51820',
      },
      ownership,
    ),
    'foreign',
  )
})

test('sameHandoffState compares every persisted field; a missing record always differs', () => {
  const base = {
    activeTarget: 'lnd' as const,
    pendingOff: [],
    handedOutKeys: ['A='],
  }
  assert.equal(sameHandoffState(base, { ...base }), true)
  assert.equal(sameHandoffState(null, base), false)
  assert.equal(
    sameHandoffState(base, { ...base, handedOutKeys: ['A=', 'B='] }),
    false,
  )
  assert.equal(
    sameHandoffState(base, { ...base, pendingOff: ['eclair'] }),
    false,
  )
  assert.equal(sameHandoffState(base, { ...base, activeTarget: null }), false)
  // A record from before handedOutKeys existed equals an empty list.
  assert.equal(
    sameHandoffState(
      { activeTarget: null, pendingOff: [] },
      { activeTarget: null, pendingOff: [], handedOutKeys: [] },
    ),
    true,
  )
})

test('nextStateAfter records nodes whose task could not be raised, so they are retried', () => {
  const plan: ClearnetVpnPlan = {
    on: { packageId: 'c-lightning', config: CONF, announce: 'h:1' },
    held: null,
    off: ['eclair'],
    retire: ['lnd'],
    next: {
      activeTarget: 'c-lightning',
      pendingOff: ['eclair'],
      handedOutKeys: [],
    },
  }
  const failed = nextStateAfter(plan, {
    raised: [],
    cleared: [],
    withheldOn: null,
    failures: [
      { packageId: 'lnd', op: 'clear', error: 'a' },
      { packageId: 'eclair', op: 'off', error: 'b' },
      { packageId: 'c-lightning', op: 'on', error: 'c' },
    ],
  })
  // A failed clear is retried via pendingOff, not unraised.
  assert.deepEqual(failed.unraised, ['eclair', 'c-lightning'])
  const ok = nextStateAfter(plan, {
    raised: ['eclair', 'c-lightning'],
    cleared: ['lnd'],
    withheldOn: null,
    failures: [],
  })
  assert.deepEqual(ok.unraised, [])
  assert.equal(sameHandoffState(ok, failed), false)
})

test('runHandoffRecheck requests a re-run while a task could not be raised', async () => {
  const calls: string[] = []
  const progress = await runHandoffRecheck({
    readState: async () => ({
      activeTarget: null,
      pendingOff: [],
      unraised: ['c-lightning'],
    }),
    readInstalled: async () => ALL_INSTALLED,
    readNodeVpn: async (nodes) => {
      calls.push(`read:${nodes.join(',')}`)
      return {}
    },
    requestRecheck: async () => {
      calls.push('recheck')
    },
  })
  assert.deepEqual(calls, ['recheck'])
  assert.deepEqual(progress, {
    waitingFor: [],
    resolved: [],
    retrying: ['c-lightning'],
    retryingOwnTasks: false,
  })
})

test('the handoff queue reads the configuration only once a run holds the queue', async () => {
  const enqueue = createHandoffQueue()
  let config = 'lnd'
  const seen: string[] = []
  let release!: () => void
  const blocker = new Promise<void>((r) => (release = r))
  let started!: () => void
  const firstStarted = new Promise<void>((r) => (started = r))

  const first = enqueue(
    async () => config,
    async (c) => {
      seen.push(c)
      started()
      await blocker
      return c
    },
  )
  await firstStarted
  // Queued while the first run is still in progress...
  const second = enqueue(
    async () => config,
    async (c) => {
      seen.push(c)
      return c
    },
  )
  // ...then the operator switches the target before it starts.
  config = 'c-lightning'
  release()

  assert.deepEqual(await first, { config: 'lnd', result: 'lnd' })
  assert.deepEqual(await second, {
    config: 'c-lightning',
    result: 'c-lightning',
  })
  assert.deepEqual(seen, ['lnd', 'c-lightning'])
})

test('a failed handoff run does not block the queue', async () => {
  const enqueue = createHandoffQueue()
  await assert.rejects(
    enqueue(
      async () => 1,
      async () => {
        throw new Error('boom')
      },
    ),
  )
  assert.deepEqual(
    await enqueue(
      async () => 2,
      async (c) => c * 2,
    ),
    {
      config: 2,
      result: 4,
    },
  )
})

test('a failed own-task update is retried through the handoff health check', async () => {
  const calls: string[] = []
  const progress = await runHandoffRecheck({
    readState: async () => ({
      activeTarget: 'lnd',
      pendingOff: [],
      retryOwnTasks: true,
    }),
    readInstalled: async () => ALL_INSTALLED,
    readNodeVpn: async () => {
      calls.push('read')
      return {}
    },
    requestRecheck: async () => {
      calls.push('recheck')
    },
  })
  assert.deepEqual(calls, ['recheck'])
  assert.deepEqual(progress, {
    waitingFor: [],
    resolved: [],
    retrying: [],
    retryingOwnTasks: true,
  })
  const base = { activeTarget: null, pendingOff: [], retryOwnTasks: false }
  assert.equal(sameHandoffState(base, { ...base, retryOwnTasks: true }), false)
})

// --- port change (G7): the sync rewrites the stored config's port marker

function portConf(privateKey: string, port: number) {
  return `[Interface]\nPrivateKey = ${privateKey}\nAddress = 10.9.0.2/32\n# VPNPort: ${port}\n\n[Peer]\nPublicKey = bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb=\nEndpoint = de2.tunnelsats.com:51820\n`
}

function desiredFor(conf: string, targetNode: 'lnd' | 'cln' = 'lnd') {
  const target = getTargetVpnConfig({
    enabled: true,
    'target-node': targetNode,
    'tunnelsats-conf': conf,
  })
  assert.ok(target)
  return target
}

test('a changed port marker re-raises the active node on-task with the new announce address', () => {
  const kp = generateWireguardKeypair()
  const before = portConf(kp.privateKey, 24556)
  const after = portConf(kp.privateKey, 30111)
  const state: VpnHandoffState = {
    activeTarget: 'lnd',
    pendingOff: [],
    handedOutKeys: [kp.publicKey],
  }
  const plan = planClearnetVpnTasks({
    desired: desiredFor(after),
    state,
    installed: ALL_INSTALLED,
    // The node still runs the tunnel with the old port marker: same key, so
    // it is ours and never blocks its own update.
    nodeVpn: {
      lnd: readNodeVpnState(
        { config: before, announce: 'de2.tunnelsats.com:24556' },
        { ownConf: after, handedOutKeys: state.handedOutKeys ?? [] },
      ),
    },
  })
  assert.deepEqual(plan.on, {
    packageId: 'lnd',
    config: after,
    announce: 'de2.tunnelsats.com:30111',
  })
  assert.equal(plan.held, null)
  assert.deepEqual(core(plan.next), { activeTarget: 'lnd', pendingOff: [] })
  // Same key: nothing new is recorded as handed out.
  assert.deepEqual(plan.next.handedOutKeys, [kp.publicKey])
  // The task input differs from what the node accepted, so StartOS raises
  // the task again; once accepted, the same plan is satisfied.
  assert.notDeepEqual(
    buildOnTaskInput(after, 'de2.tunnelsats.com:30111'),
    buildOnTaskInput(before, 'de2.tunnelsats.com:24556'),
  )
})

test('a port change during a node switch stays held until the previous node is off', () => {
  const kp = generateWireguardKeypair()
  const after = portConf(kp.privateKey, 30111)
  const plan = planClearnetVpnTasks({
    desired: desiredFor(after, 'cln'),
    state: {
      activeTarget: 'lnd',
      pendingOff: [],
      handedOutKeys: [kp.publicKey],
    },
    installed: ALL_INSTALLED,
    nodeVpn: { lnd: 'on' },
  })
  assert.equal(plan.on, null)
  assert.deepEqual(plan.held, { packageId: 'c-lightning', waitingFor: ['lnd'] })
  assert.deepEqual(plan.off, ['lnd'])
  assert.deepEqual(core(plan.next), { activeTarget: null, pendingOff: ['lnd'] })
})
