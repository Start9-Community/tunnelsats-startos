import test from 'node:test'
import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { existsSync, readdirSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import vm from 'node:vm'

/**
 * Runs the real web/script.js in a VM context with a small fake DOM and a
 * recording fetch, so the dashboard's read-only contract is tested on the
 * shipped code.
 */
const SCRIPT_PATH = join(__dirname, '..', 'web', 'script.js')
const SCRIPT = readFileSync(SCRIPT_PATH, 'utf8')

type Json = Record<string, any>

class FakeClassList {
  private set = new Set<string>()
  add(...names: string[]) {
    names.forEach((n) => this.set.add(n))
  }
  remove(...names: string[]) {
    names.forEach((n) => this.set.delete(n))
  }
  toggle(name: string, force?: boolean) {
    const on = force === undefined ? !this.set.has(name) : force
    if (on) this.set.add(name)
    else this.set.delete(name)
    return on
  }
  contains(name: string) {
    return this.set.has(name)
  }
}

interface FakeDocument {
  activeElement: FakeElement | null
  body: FakeElement
}

class FakeElement {
  id = ''
  textContent = ''
  className = ''
  title = ''
  hidden = true
  disabled = false
  value = ''
  style: Json = {}
  classList = new FakeClassList()
  children: FakeElement[] = []
  attributes: Record<string, string> = {}
  parent: FakeElement | null = null
  ownerDocument: FakeDocument | null = null
  constructor(public tagName = 'DIV') {}
  append(...nodes: FakeElement[]) {
    for (const node of nodes) node.parent = this
    this.children.push(...nodes)
  }
  replaceChildren(...nodes: FakeElement[]) {
    const doc = this.ownerDocument
    const focused = doc?.activeElement ?? null
    const hadFocus = focused !== this && this.contains(focused)
    for (const child of this.children) child.parent = null
    for (const node of nodes) node.parent = this
    this.children = nodes
    // Like a browser: a focused element that leaves the page drops focus to <body>.
    if (doc && hadFocus && !this.contains(focused)) doc.activeElement = doc.body
  }
  setAttribute(name: string, value: string) {
    this.attributes[name] = value
  }
  getAttribute(name: string) {
    return this.attributes[name] ?? null
  }
  contains(node: FakeElement | null): boolean {
    for (let n = node; n; n = n.parent) if (n === this) return true
    return false
  }
  /** The selector forms the script uses: `[attribute]` and a tag name. */
  matches(selector: string): boolean {
    const attribute = /^\[([\w-]+)\]$/.exec(selector)
    if (attribute) return attribute[1] in this.attributes
    return this.tagName === selector.toUpperCase()
  }
  closest(selector: string): FakeElement | null {
    for (let n: FakeElement | null = this; n; n = n.parent) {
      if (n.matches(selector)) return n
    }
    return null
  }
  querySelectorAll(selector: string): FakeElement[] {
    return this.children.flatMap((child) => [
      ...(child.matches(selector) ? [child] : []),
      ...child.querySelectorAll(selector),
    ])
  }
  focus() {
    if (this.ownerDocument) this.ownerDocument.activeElement = this
  }
  addEventListener() {}
  remove() {}
  select() {}
}

interface Harness {
  context: vm.Context
  doc: FakeDocument
  storage: Map<string, string>
  requests: { url: string; init: Json | undefined }[]
  elements: Map<string, FakeElement>
  el: (id: string) => FakeElement
  /** Runs the script's own document listeners, as a browser event would. */
  dispatch: (type: string, target: FakeElement, init?: Json) => void
  run: <T = any>(code: string) => T
  settle: () => Promise<void>
}

function load(
  model: Json | null,
  status = 200,
  intentResponse: { status: number; body: Json } = {
    status: 202,
    body: { status: 'accepted' },
  },
  routes: Record<string, { status: number; body: Json }> = {},
  stored: Record<string, string> = {},
): Harness {
  const requests: { url: string; init: Json | undefined }[] = []
  const storage = new Map<string, string>(Object.entries(stored))
  const elements = new Map<string, FakeElement>()
  const listeners = new Map<string, ((event: Json) => void)[]>()
  const body = new FakeElement('BODY')
  const doc: FakeDocument = { activeElement: body, body }
  const own = (element: FakeElement) => {
    element.ownerDocument = doc
    return element
  }
  own(body)
  const el = (id: string) => {
    let element = elements.get(id)
    if (!element) {
      element = own(new FakeElement())
      element.id = id
      elements.set(id, element)
    }
    return element
  }
  const csrfMeta = new FakeElement('META')
  csrfMeta.setAttribute('content', 'csrf-test-token-123')
  const context = vm.createContext({
    console: { log() {}, warn() {}, error() {}, info() {} },
    document: Object.assign(doc, {
      hidden: false,
      getElementById: el,
      createElement: (tag: string) => own(new FakeElement(tag.toUpperCase())),
      createElementNS: (_ns: string, tag: string) =>
        own(new FakeElement(tag.toUpperCase())),
      querySelector: (selector: string) =>
        selector === 'meta[name="csrf-token"]' ? csrfMeta : null,
      addEventListener: (type: string, handler: (event: Json) => void) => {
        listeners.set(type, [...(listeners.get(type) ?? []), handler])
      },
    }),
    window: { isSecureContext: false },
    navigator: {},
    localStorage: {
      getItem: (key: string) => storage.get(key) ?? null,
      setItem: (key: string, value: string) => {
        storage.set(key, String(value))
      },
    },
    HTMLDialogElement: { prototype: { closedBy: '' } },
    Date,
    setInterval: () => 0,
    clearInterval() {},
    setTimeout: () => 0,
    fetch: async (url: string, init?: Json) => {
      requests.push({ url: String(url), init })
      const route = routes[String(url)]
      if (route) {
        return {
          ok: route.status >= 200 && route.status < 300,
          status: route.status,
          json: async () => route.body,
        }
      }
      if (String(url) === '/api/servers') {
        return { ok: false, status: 503, json: async () => ({}) }
      }
      if (String(url) === '/api/intents') {
        return {
          ok: intentResponse.status >= 200 && intentResponse.status < 300,
          status: intentResponse.status,
          json: async () => intentResponse.body,
        }
      }
      return {
        ok: status >= 200 && status < 300,
        status,
        json: async () => model,
      }
    },
  })
  vm.runInContext(SCRIPT, context, { filename: 'script.js' })
  return {
    context,
    doc,
    storage,
    requests,
    elements,
    el,
    dispatch: (type: string, target: FakeElement, init: Json = {}) => {
      for (const handler of listeners.get(type) ?? []) {
        handler({ type, target, preventDefault() {}, ...init })
      }
    },
    run: (code: string) => {
      const value = vm.runInContext(code, context)
      // parent and ownerDocument point back up the tree: copy children only.
      const down = (key: string, v: unknown) =>
        key === 'parent' || key === 'ownerDocument' ? undefined : v
      return value && typeof value === 'object'
        ? JSON.parse(JSON.stringify(value, down))
        : value
    },
    settle: () => new Promise((resolve) => setImmediate(resolve)),
  }
}

function model(overrides: Json = {}): Json {
  return {
    version: '0.4.0',
    enabled: true,
    configured: true,
    status: 'running',
    targetNode: 'lnd',
    subscription: {
      active: true,
      linked: true,
      expiresAt: new Date(Date.now() + 20 * 86400000).toISOString(),
      daysRemaining: 20,
      keyUnknown: false,
      lastSync: '2026-09-01T10:00:00.000Z',
      syncError: null,
    },
    connection: {
      server: 'de2.tunnelsats.com',
      vpnPort: 24556,
      vpnIp: '10.9.0.7',
      publicKey: 'cHVibGljLWtleS1wdWJsaWMta2V5LXB1YmxpYy1rZXk=',
      allowIpv6: false,
    },
    bandwidth: { usedGb: 12.5, limitGb: 100 },
    pending: { order: null, renewal: null, reset: null },
    intents: { buy: null, renew: null, reset: null },
    handoff: { activeTarget: 'lnd', pendingOff: [], unraised: [] },
    notices: null,
    ...overrides,
  }
}

const titles = (notices: Json[]) => notices.map((n) => n.title)
const texts = (notices: Json[]) => notices.map((n) => n.text).join('\n')

test('the dashboard only GETs /api/dashboard and /api/servers on initial load on its own origin', async () => {
  const h = load(model())
  await h.settle()
  assert.deepEqual(
    h.requests.map((r) => r.url),
    ['/api/dashboard', '/api/servers'],
  )
  for (const request of h.requests) {
    assert.equal(request.init?.method ?? 'GET', 'GET')
    assert.equal(request.init?.body, undefined)
    assert.equal(request.init?.credentials, 'same-origin')
  }
})

test('the shipped script has no legacy write paths, third-party calls or HTML sinks', () => {
  for (const banned of [
    'innerHTML',
    'outerHTML',
    'insertAdjacentHTML',
    'document.write',
    'eval(',
    'new Function',
    'mempool.space',
    'blockchain.info',
    'tunnelsats.com/api',
    '/api/keys/generate',
    '/api/config/save',
    'privateKey',
    'sessionStorage',
    'indexedDB',
    'document.cookie',
  ]) {
    assert.ok(!SCRIPT.includes(banned), `script.js must not contain ${banned}`)
  }
  // Browser storage holds only the node public key for the reachability check.
  const storageUses = SCRIPT.match(/localStorage\.[a-zA-Z]+\([^)]*\)?/g) ?? []
  assert.deepEqual(storageUses, [
    'localStorage.getItem(NODE_PUBKEY_STORAGE_KEY)',
    'localStorage.setItem(NODE_PUBKEY_STORAGE_KEY, value)',
  ])
  // Every fetch in the script goes to the bridge on the same origin.
  const fetches = SCRIPT.match(/fetch\(([^,)]+)/g) ?? []
  assert.deepEqual(fetches, [
    'fetch(DASHBOARD_URL',
    'fetch(SERVERS_URL',
    'fetch(REACHABILITY_URL',
    'fetch(INTENTS_URL',
  ])
  assert.match(SCRIPT, /const SERVERS_URL = '\/api\/servers'/)
  assert.match(SCRIPT, /const REACHABILITY_URL = '\/api\/reachability'/)
})

test('a configured model shows the overview and fills it with textContent', async () => {
  const h = load(model())
  await h.settle()
  assert.equal(h.el('view-setup').hidden, true)
  assert.equal(h.el('view-overview').hidden, false)
  assert.equal(h.el('val-target-node').textContent, 'LND')
  assert.equal(h.el('val-endpoint').textContent, 'de2.tunnelsats.com:24556')
  assert.equal(h.el('val-vpn-ip').textContent, '10.9.0.7')
  assert.equal(h.el('val-handoff').textContent, 'Task raised on LND')
  assert.equal(h.el('bandwidth-used').textContent, '12.50 GB')
  assert.equal(h.el('bandwidth-limit').textContent, '/ 100 GB')
  assert.equal(h.el('status-text').textContent, 'Subscription active')
  assert.equal(h.el('status-badge').className, 'status-badge active')
  assert.equal(
    h.el('attach-command').textContent,
    'start-cli package attach lnd',
  )
  assert.equal(h.el('footer-version').textContent, 'v0.4.0')
  assert.equal(h.el('load-error').hidden, true)
  assert.equal(h.el('notices').hidden, true)

  const hIpv6 = load(
    model({
      connection: {
        server: '2001:db8::42',
        vpnPort: 24556,
        vpnIp: '10.9.0.7',
        publicKey: 'cHVibGljLWtleS1wdWJsaWMta2V5LXB1YmxpYy1rZXk=',
        allowIpv6: true,
      },
    }),
  )
  await hIpv6.settle()
  assert.equal(hIpv6.el('val-endpoint').textContent, '[2001:db8::42]:24556')
})

test('an unconfigured model shows the setup view and suggests Buy and Import', async () => {
  const h = load(
    model({
      configured: false,
      status: 'unconfigured',
      connection: {},
      handoff: null,
    }),
  )
  await h.settle()
  assert.equal(h.el('view-setup').hidden, false)
  assert.equal(h.el('view-overview').hidden, true)
  assert.equal(h.el('status-text').textContent, 'Not set up')
  assert.ok(h.el('action-buy').classList.contains('is-suggested'))
  assert.ok(h.el('action-import').classList.contains('is-suggested'))
  assert.ok(!h.el('action-renew').classList.contains('is-suggested'))
})

test('a failed load keeps the last view and says so', async () => {
  const h = load(null, 500)
  await h.settle()
  assert.equal(h.el('load-error').hidden, false)
  assert.match(h.el('load-error').textContent, /did not answer/)
  assert.equal(h.el('status-text').textContent, 'Status unavailable')
})

test('until the first answer, Overview offers neither Buy nor a stale overview', async () => {
  const html = readFileSync(join(__dirname, '..', 'web', 'index.html'), 'utf8')
  // Before the script runs, only the loading line is visible.
  assert.match(html, /<section\s+id="view-setup"[^>]*\shidden\s*>/)
  assert.match(html, /<section id="view-overview"[^>]*\shidden>/)
  assert.doesNotMatch(html, /<p id="view-loading"[^>]*\shidden/)

  const routes: Record<string, { status: number; body: Json }> = {
    '/api/dashboard': { status: 503, body: {} },
  }
  const h = load(null, 200, undefined, routes)
  const views = () =>
    ['view-loading', 'view-setup', 'view-overview'].map((id) => h.el(id).hidden)
  // init() has rendered; the first request has not been answered.
  assert.deepEqual(views(), [false, true, true])

  await settleAll(h)
  assert.deepEqual(views(), [true, true, true])
  // Nothing is shown below the banner, so it does not mention old values.
  assert.equal(
    h.el('load-error').textContent,
    'The TunnelSats service did not answer; retrying.',
  )
  // However the operator gets back to Overview, it is the same state, even
  // if a view was left visible by an earlier render.
  h.run(`switchTab('actions')`)
  h.el('view-setup').hidden = false
  h.run(`switchTab('overview')`)
  assert.deepEqual(views(), [true, true, true])

  routes['/api/dashboard'] = { status: 200, body: model() }
  await vm.runInContext('refresh()', h.context)
  assert.deepEqual(views(), [true, true, false])
  assert.equal(h.el('load-error').hidden, true)

  // Once values are shown, a failed poll keeps them and says they may be old.
  routes['/api/dashboard'] = { status: 503, body: {} }
  await vm.runInContext('refresh()', h.context)
  assert.deepEqual(views(), [true, true, false])
  assert.match(
    h.el('load-error').textContent,
    /values below may be out of date/,
  )
})

test('read-model strings are rendered as text, never parsed', async () => {
  const hostile = '<img src=x onerror=alert(1)>'
  const h = load(
    model({
      status: 'sync_error',
      subscription: { ...model().subscription, syncError: hostile },
    }),
  )
  await h.settle()
  const items = h.el('notice-list').children
  const text = items.flatMap((li) => li.children.map((c) => c.textContent))
  assert.ok(text.some((t) => t.includes(hostile)))
})

test('nodeLabel and nodePackageId cover LND, Core Lightning and Eclair', () => {
  const h = load(model())
  assert.equal(h.run("nodeLabel('lnd')"), 'LND')
  assert.equal(h.run("nodeLabel('cln')"), 'Core Lightning')
  assert.equal(h.run("nodeLabel('c-lightning')"), 'Core Lightning')
  assert.equal(h.run("nodeLabel('eclair')"), 'Eclair')
  assert.equal(h.run("nodePackageId('cln')"), 'c-lightning')
  assert.equal(h.run("nodePackageId('eclair')"), 'eclair')
  assert.equal(
    h.run("listNodes(['lnd', 'c-lightning', 'eclair'])"),
    'LND, Core Lightning and Eclair',
  )
})

test('plan prices are the backend USD prices, rendered for all four plans', () => {
  const h = load(model())
  const plans = h.run<Json[]>('PLAN_PRICES_USD').map((p) => ({ ...p }))
  assert.deepEqual(plans, [
    { months: 1, usd: 3, discountPct: 0 },
    { months: 3, usd: 8.55, discountPct: 5 },
    { months: 6, usd: 16.2, discountPct: 10 },
    { months: 12, usd: 28.8, discountPct: 20 },
  ])
  // BASE_PRICE_USD 3 per month minus the plan discount.
  for (const p of plans) {
    assert.equal(p.usd, Math.round(3 * p.months * (100 - p.discountPct)) / 100)
  }
  const cards = h.el('plan-list').children.map((li) => li.children[0])
  assert.equal(cards.length, 4)
  assert.ok(cards.every((c) => c.tagName === 'BUTTON'))
  assert.deepEqual(
    cards.map((c) => c.children[1].textContent),
    ['$3.00', '$8.55', '$16.20', '$28.80'],
  )
  assert.equal(cards[3].children[2].textContent, '$2.40/mo · save 20%')
})

test('a pending order on Eclair asks for the Pay Invoice task on Eclair', () => {
  const h = load(model())
  const m = model({
    configured: false,
    targetNode: 'eclair',
    pending: {
      order: {
        targetNode: 'eclair',
        lastError: 'backend unreachable',
        nextAttemptAt: null,
      },
      renewal: null,
      reset: null,
    },
  })
  const notices = h.run<Json[]>(`buildNotices(${JSON.stringify(m)})`)
  assert.deepEqual(titles(notices), ['Payment pending'])
  assert.match(texts(notices), /accept the Pay Invoice task on Eclair\./)
  assert.match(texts(notices), /Last check failed: backend unreachable/)
  assert.deepEqual(
    h.run(`badgeState(${JSON.stringify(m)}, false)`).text,
    'Payment pending',
  )
  // Nothing to suggest while the order is being paid.
  assert.deepEqual([...h.run(`suggestedActions(${JSON.stringify(m)})`)], [])

  // Post-payment settlement errors and processing states must not ask the operator to pay again.
  const paidProcessing = model({
    configured: false,
    pending: {
      order: {
        targetNode: 'eclair',
        paymentReceived: true,
        lastError: null,
        nextAttemptAt: null,
      },
      renewal: null,
      reset: null,
    },
  })
  assert.deepEqual(
    h.run(`badgeState(${JSON.stringify(paidProcessing)}, false)`).text,
    'Provisioning tunnel',
  )
  const processingNotices = h.run<Json[]>(
    `buildNotices(${JSON.stringify(paidProcessing)})`,
  )
  assert.deepEqual(titles(processingNotices), ['Tunnel provisioning pending'])
  assert.doesNotMatch(texts(processingNotices), /Pay Invoice/)

  const paidFailed = model({
    pending: {
      order: {
        targetNode: 'eclair',
        paymentReceived: true,
        lastError: 'HTTP 502 from the TunnelSats API: Bad Gateway',
        nextAttemptAt: null,
      },
      renewal: {
        targetNode: 'eclair',
        paymentReceived: true,
        lastError:
          'The renewal is paid, but its new expiry could not be confirmed yet',
        nextAttemptAt: null,
      },
      reset: {
        targetNode: 'eclair',
        paymentReceived: true,
        lastError:
          'The payment was received, but the bandwidth reset failed. Contact TunnelSats support with the payment hash from the Reset Bandwidth action.',
        nextAttemptAt: null,
      },
    },
  })
  const paidNotices = h.run<Json[]>(
    `buildNotices(${JSON.stringify(paidFailed)})`,
  )
  assert.deepEqual(titles(paidNotices), [
    'Tunnel provisioning pending',
    'Renewal confirmation pending',
    'Bandwidth reset failed',
  ])
  assert.doesNotMatch(texts(paidNotices), /accept the Pay Invoice task/)
})

test('a handoff waiting on LND or retrying an unraised task says so in the notice and the connection card', () => {
  const h = load(model())
  const m = model({
    targetNode: 'cln',
    handoff: { activeTarget: 'lnd', pendingOff: ['lnd'], unraised: [] },
  })
  const notices = h.run<Json[]>(`buildNotices(${JSON.stringify(m)})`)
  assert.ok(titles(notices).includes('Waiting for LND to turn off the tunnel'))
  assert.match(texts(notices), /Core Lightning is asked to take over/)
  assert.equal(
    h.run(`handoffText(${JSON.stringify(m)})`),
    'Waiting for LND to turn off',
  )
  const unraised = model({
    targetNode: 'eclair',
    handoff: { activeTarget: 'eclair', pendingOff: [], unraised: ['eclair'] },
  })
  assert.equal(
    h.run(`handoffText(${JSON.stringify(unraised)})`),
    'Retrying task on Eclair',
  )
})

test('an unknown key points to Import or Buy, not Renew', () => {
  const h = load(model())
  const m = model({
    status: 'unknown_key',
    subscription: {
      ...model().subscription,
      keyUnknown: true,
      daysRemaining: 2,
    },
  })
  const notices = h.run<Json[]>(`buildNotices(${JSON.stringify(m)})`)
  assert.ok(titles(notices).includes('Key unknown to TunnelSats'))
  assert.match(texts(notices), /Import Subscription .* or Buy Subscription/)
  assert.deepEqual(
    [...h.run(`suggestedActions(${JSON.stringify(m)})`)],
    ['import', 'buy'],
  )
})

test('expiry and bandwidth thresholds suggest Renew and Reset', () => {
  const h = load(model())
  const m = model({
    subscription: { ...model().subscription, daysRemaining: 3 },
    bandwidth: { usedGb: 92, limitGb: 100 },
  })
  const notices = h.run<Json[]>(`buildNotices(${JSON.stringify(m)})`)
  assert.ok(titles(notices).includes('Subscription ends in 3 days'))
  assert.ok(titles(notices).includes("92% of this month's bandwidth used"))
  assert.deepEqual(
    [...h.run(`suggestedActions(${JSON.stringify(m)})`)],
    ['renew', 'reset'],
  )
  // A pending renewal/reset replaces the suggestion with the payment notice.
  const paying = {
    ...m,
    pending: {
      order: null,
      renewal: { targetNode: 'lnd' },
      reset: { targetNode: 'lnd' },
    },
  }
  assert.deepEqual(
    [...h.run(`suggestedActions(${JSON.stringify(paying)})`)],
    [],
  )
  const payingTitles = titles(h.run(`buildNotices(${JSON.stringify(paying)})`))
  assert.ok(payingTitles.includes('Renewal payment pending'))
  assert.ok(payingTitles.includes('Bandwidth reset payment pending'))
  assert.ok(!payingTitles.includes('Subscription ends in 3 days'))
})

test('expired and switched-off states name the action to run', () => {
  const h = load(model())
  const expired = model({
    status: 'expired',
    subscription: { ...model().subscription, active: false, daysRemaining: 0 },
  })
  assert.match(
    texts(h.run(`buildNotices(${JSON.stringify(expired)})`)),
    /Run Renew Subscription/,
  )
  const off = model({ enabled: false, status: 'disabled' })
  assert.deepEqual(titles(h.run(`buildNotices(${JSON.stringify(off)})`)), [
    'TunnelSats is switched off',
  ])
  assert.deepEqual(
    [...h.run(`suggestedActions(${JSON.stringify(off)})`)],
    ['configure'],
  )
})

test('no notice claims the tunnel is verified or leak-free', () => {
  const h = load(model())
  const states = [
    model(),
    model({ connection: { ...model().connection, allowIpv6: true } }),
    model({ status: 'pending_sync' }),
    model({
      handoff: { activeTarget: 'eclair', pendingOff: [], unraised: ['eclair'] },
    }),
  ]
  for (const m of states) {
    const all = JSON.stringify(h.run(`buildNotices(${JSON.stringify(m)})`))
    assert.doesNotMatch(all, /verified|fail-closed|zero.leak|protected|secure/i)
  }
})

test('index.html obeys the strict CSP and includes Eclair, NWC and kill-switch honesty', () => {
  const html = readFileSync(join(__dirname, '..', 'web', 'index.html'), 'utf8')
  assert.ok(!html.includes('qrcode.js'), 'qrcode.js must not be referenced')
  assert.doesNotMatch(
    html,
    /\son[a-z]+\s*=/i,
    'no inline event handler attributes',
  )
  assert.doesNotMatch(html, /\sstyle\s*=/i, 'no inline style attributes')
  const scripts = [...html.matchAll(/<script\b([^>]*)>([\s\S]*?)<\/script>/gi)]
  assert.equal(scripts.length, 1)
  assert.match(scripts[0][1], /\bsrc="script\.js"/)
  assert.equal(scripts[0][2].trim(), '')
  assert.match(html, /LND, Core Lightning or Eclair/)
  assert.match(
    html,
    /<strong>Yes, via Nostr Wallet Connect \(NWC\)\.<\/strong>\s+Run\s+<strong\s*>Services → TunnelSats → Actions → Connect Wallet<\/strong\s*>/,
  )
  assert.match(html, /Kill switch:/)
  assert.match(
    html,
    /LND\s+0\.21\.3-beta:10, Core Lightning 26\.6\.8:3 or Eclair 0\.14\.3:3/,
  )
  assert.doesNotMatch(html, /fix in the\s+node\s+packages is pending/)
  assert.match(html, /Services → TunnelSats → Actions → Buy Subscription/)
  assert.match(html, /Services → TunnelSats → Actions →\s+Connect Wallet/)
})

test('createInvoiceQrSvg builds a valid pure-DOM SVG QR code and rejects non-BOLT11 strings', () => {
  const h = load(model())
  const invoice = 'lnbc250u1pjorderinvoiceorderinvoiceorderinvoice'
  const matrix = h.run<boolean[][]>(
    `encodeQrMatrix(${JSON.stringify(invoice)})`,
  )
  assert.ok(Array.isArray(matrix))
  const size = matrix.length
  assert.equal((size - 17) % 4, 0)
  // Top-left, top-right, and bottom-left 7x7 finder corners have dark outer border and 3x3 center
  for (const [topR, leftC] of [
    [0, 0],
    [0, size - 7],
    [size - 7, 0],
  ]) {
    assert.equal(matrix[topR][leftC], true)
    assert.equal(matrix[topR + 6][leftC + 6], true)
    assert.equal(matrix[topR + 3][leftC + 3], true)
    assert.equal(matrix[topR + 1][leftC + 1], false)
  }

  const svg = h.run<Json>(`createInvoiceQrSvg(${JSON.stringify(invoice)})`)
  assert.equal(svg.tagName, 'SVG')
  assert.equal(svg.attributes.class, 'invoice-qr-svg')
  assert.equal(svg.attributes.viewBox, `0 0 ${size + 8} ${size + 8}`)
  assert.equal(svg.children.length, 2)
  assert.equal(svg.children[0].tagName, 'RECT')
  assert.equal(svg.children[1].tagName, 'PATH')
  assert.match(svg.children[1].attributes.d, /^M\d+,\d+h1v1h-1z/)

  // Rejects non-BOLT11 input
  assert.equal(h.run(`createInvoiceQrSvg('javascript:alert(1)')`), null)
  assert.equal(h.run(`createInvoiceQrSvg('')`), null)
})

test('encodeQrMatrix encodes the exact lowercase invoice in byte mode up to version 40', () => {
  // Golden matrices: each was decoded back to the exact input string by an
  // independent QR reader (jsQR 1.4.0) when these values were recorded, for
  // lengths across versions 1-40. A change to the encoder must re-verify.
  const CHARSET = 'qpzry9x8gf2tvdw0s3jn54khce6mua7l'
  const invoiceOfLength = (n: number, seed: number) => {
    let s = 'lnbc250u1p'
    let x = seed
    while (s.length < n) {
      x = (x * 1103515245 + 12345) & 0x7fffffff
      s += CHARSET[x % 32]
    }
    return s
  }
  const golden: Array<[number, number, number, string]> = [
    [
      47,
      2,
      3,
      '01aafca12eee7f544f2c188e1010e320deba4733ae93ed5987529cc18871e4a7',
    ],
    [
      400,
      8,
      13,
      '2cad794504f712ff18a34fdc2ae898357cef847b4d1f8c22349053608f7efa95',
    ],
    [
      1000,
      15,
      22,
      '4388b617466f051b84c8a8e4e0804d030ab1e3456e61de05109dddc979810f30',
    ],
    [
      2940,
      22,
      40,
      '43fbde9ecf83eb2e45c17a305f54bdb3964c27c7a884fc7d5f60e4cc5474213a',
    ],
  ]
  const h = load(model())
  for (const [length, seed, version, hash] of golden) {
    const invoice = invoiceOfLength(length, seed)
    const matrix = h.run<boolean[][]>(
      `encodeQrMatrix(${JSON.stringify(invoice)})`,
    )
    assert.equal((matrix.length - 17) / 4, version, `version for ${length}`)
    const bits = matrix
      .map((row) => row.map((b) => (b ? '1' : '0')).join(''))
      .join('\n')
    assert.equal(
      createHash('sha256').update(bits).digest('hex'),
      hash,
      `matrix for ${length} chars`,
    )
  }
  // Beyond version 40 at level L there is no QR code (copy still works).
  assert.equal(
    h.run(`encodeQrMatrix(${JSON.stringify(invoiceOfLength(3000, 9))})`),
    null,
  )
  // The SVG encodes the invoice as given: no case change.
  const upper = h.run<boolean[][]>(
    `encodeQrMatrix('LNBC250U1P' + 'Q'.repeat(40))`,
  )
  const lower = h.run<boolean[][]>(
    `encodeQrMatrix('lnbc250u1p' + 'q'.repeat(40))`,
  )
  assert.notDeepEqual(upper, lower)
})

test('an unpaid pending invoice renders the QR panel with dual-path framing and hides once paid', async () => {
  const invoice = 'lnbc250u1pjorderinvoiceorderinvoiceorderinvoice'
  const h = load(
    model({
      configured: false,
      targetNode: 'eclair',
      pending: {
        order: {
          targetNode: 'eclair',
          serverId: 'eu-de',
          duration: '3m',
          amountSats: 25000,
          expiresAt: '2026-09-28T12:00:00Z',
          paymentReceived: false,
          invoice,
        },
        renewal: null,
        reset: null,
      },
    }),
  )
  await h.settle()
  assert.equal(h.el('invoice-panel').hidden, false)
  assert.equal(h.el('invoice-title').textContent, 'Pay Subscription Invoice')
  assert.equal(
    h.el('invoice-framing').textContent,
    'A Pay Invoice task has been raised on Eclair. Accept it in StartOS, or scan/copy the same invoice below.',
  )
  assert.equal(h.el('invoice-amount').textContent, '25,000 sats')
  assert.equal(h.el('val-invoice').textContent, invoice)
  assert.equal(h.el('invoice-qr').children.length, 1)
  assert.equal(h.el('invoice-qr').children[0].tagName, 'SVG')

  // Once paid, the invoice panel hides and clears the QR SVG
  const hPaid = load(
    model({
      configured: false,
      targetNode: 'eclair',
      pending: {
        order: {
          targetNode: 'eclair',
          serverId: 'eu-de',
          duration: '3m',
          amountSats: 25000,
          paymentReceived: true,
          invoice: null,
        },
        renewal: null,
        reset: null,
      },
    }),
  )
  await hPaid.settle()
  assert.equal(hPaid.el('invoice-panel').hidden, true)
  assert.equal(hPaid.el('invoice-qr').children.length, 0)
})

test('an invoice too long for any QR version shows a copy-instead note, not an empty box', async () => {
  const invoice = 'lnbc250u1p' + 'q'.repeat(3100)
  const h = load(
    model({
      pending: {
        order: {
          targetNode: 'lnd',
          serverId: 'eu-de',
          duration: '3m',
          amountSats: 25000,
          expiresAt: '2026-09-28T12:00:00Z',
          paymentReceived: false,
          invoice,
        },
        renewal: null,
        reset: null,
      },
    }),
  )
  await h.settle()
  const box = h.el('invoice-qr')
  assert.equal(h.el('invoice-panel').hidden, false)
  assert.equal(h.el('val-invoice').textContent, invoice)
  assert.equal(box.children.length, 1)
  assert.equal(box.children[0].tagName, 'P')
  assert.match(box.children[0].textContent, /too long for a QR code/)
  assert.equal(box.getAttribute('aria-label'), box.children[0].textContent)
})

test('every payable invoice stays reachable through the invoice switcher', async () => {
  const orderInvoice = 'lnbc250u1pjorderinvoiceorderinvoiceorderinvoice'
  const resetInvoice = 'lnbc30u1pjresetinvoiceresetinvoiceresetinvoice'
  const pending = {
    order: {
      targetNode: 'lnd',
      serverId: 'eu-de',
      duration: '3m',
      amountSats: 25000,
      expiresAt: '2026-09-28T12:00:00Z',
      paymentReceived: false,
      invoice: orderInvoice,
    },
    renewal: null,
    reset: {
      targetNode: 'lnd',
      amountSats: 3000,
      expiresAt: '2026-09-28T12:30:00Z',
      paymentReceived: false,
      invoice: resetInvoice,
    },
  }
  const h = load(model({ pending }))
  await h.settle()

  const switcher = h.el('invoice-switcher')
  assert.equal(switcher.hidden, false)
  const buttons = switcher.children
  assert.deepEqual(
    buttons.map((b) => b.getAttribute('data-invoice-kind')),
    ['order', 'reset'],
  )
  assert.deepEqual(
    buttons.map((b) => b.textContent),
    ['Subscription · 25,000 sats', 'Bandwidth reset · 3,000 sats'],
  )
  assert.deepEqual(
    buttons.map((b) => b.getAttribute('aria-pressed')),
    ['true', 'false'],
  )
  assert.ok(buttons.every((b) => b.getAttribute('type') === 'button'))
  assert.equal(h.el('invoice-title').textContent, 'Pay Subscription Invoice')
  assert.equal(h.el('val-invoice').textContent, orderInvoice)
  assert.equal(
    h.el('invoice-framing').textContent,
    'A Pay Invoice task has been raised on LND. Accept it in StartOS, or scan/copy the same invoice below. 2 invoices are waiting for payment.',
  )

  // Choosing the reset invoice swaps title, amount, invoice text and QR.
  const orderQr = h.el('invoice-qr').children[0]
  h.run(`selectInvoice('reset')`)
  assert.equal(h.el('invoice-title').textContent, 'Pay Bandwidth Reset Invoice')
  assert.equal(h.el('invoice-amount').textContent, '3,000 sats')
  assert.equal(h.el('val-invoice').textContent, resetInvoice)
  assert.equal(h.el('invoice-qr').children.length, 1)
  assert.notEqual(h.el('invoice-qr').children[0], orderQr)
  assert.deepEqual(
    h
      .el('invoice-switcher')
      .children.map((b) => b.getAttribute('aria-pressed')),
    ['false', 'true'],
  )

  // Unknown kinds are ignored; the selection stays put.
  h.run(`selectInvoice('bogus')`)
  assert.equal(h.el('val-invoice').textContent, resetInvoice)

  // Once the selected invoice is paid, the panel falls back to the other one
  // and the switcher hides because only one invoice is left.
  h.run(`model.pending.reset.paymentReceived = true; render()`)
  assert.equal(h.el('val-invoice').textContent, orderInvoice)
  assert.equal(h.el('invoice-switcher').hidden, true)
  assert.equal(h.el('invoice-switcher').children.length, 0)
  assert.equal(
    h.el('invoice-framing').textContent,
    'A Pay Invoice task has been raised on LND. Accept it in StartOS, or scan/copy the same invoice below.',
  )
})

test('submitIntent POSTs to /api/intents with CSRF header and handles rate-limit errors', async () => {
  const h = load(
    model({
      configured: true,
      targetNode: 'cln',
    }),
  )
  await h.settle()
  h.el('renew-duration-select').value = '6m'

  await vm.runInContext(`submitIntent('renew')`, h.context)
  await h.settle()

  const postReq = h.requests.find((r) => r.url === '/api/intents')
  assert.ok(postReq)
  assert.equal(postReq.init?.method, 'POST')
  assert.equal(postReq.init?.credentials, 'same-origin')
  assert.equal(postReq.init?.headers?.['X-CSRF-Token'], 'csrf-test-token-123')
  assert.deepEqual(JSON.parse(postReq.init?.body), {
    kind: 'renew',
    duration: '6m',
  })

  // Rate-limited 429 response renders the error in #intent-feedback
  const hRateLimited = load(model(), 200, {
    status: 429,
    body: {
      error: 'Please wait 28s before repeating this request.',
      retryAfterSeconds: 28,
    },
  })
  await hRateLimited.settle()
  await vm.runInContext(`submitIntent('reset')`, hRateLimited.context)
  await hRateLimited.settle()
  assert.equal(hRateLimited.el('intent-feedback').hidden, false)
  assert.ok(hRateLimited.el('intent-feedback').classList.contains('is-error'))
  assert.match(
    hRateLimited.el('intent-feedback').textContent,
    /Please wait 28s/,
  )
})

test('a request refused while an invoice is payable stays visible; older failures do not', async () => {
  const invoice = 'lnbc250u1pjorderinvoiceorderinvoiceorderinvoice'
  const conflict =
    'An unpaid subscription invoice (eu-de, 3 month(s), lnd) is still payable until 2026-09-28T12:00:00.000Z. Pay it, or replace it with the Buy Subscription action in StartOS.'
  const pendingWith = (createdAt: string) => ({
    order: {
      targetNode: 'lnd',
      serverId: 'eu-de',
      duration: '3m',
      amountSats: 25000,
      createdAt,
      expiresAt: '2026-09-28T12:00:00Z',
      paymentReceived: false,
      invoice,
    },
    renewal: null,
    reset: null,
  })
  const failedBuy = (updatedAt: string, error: string) => ({
    buy: {
      id: 'intent-buy-2',
      kind: 'buy',
      status: 'failed',
      createdAt: updatedAt,
      updatedAt,
      error,
    },
    renew: null,
    reset: null,
  })

  // Refused after the invoice was created: shown next to the invoice.
  const h = load(
    model({
      pending: pendingWith('2026-09-28T11:00:00Z'),
      intents: failedBuy('2026-09-28T11:05:00Z', conflict),
    }),
  )
  await h.settle()
  assert.equal(h.el('invoice-panel').hidden, false)
  assert.equal(h.el('intent-feedback').hidden, false)
  assert.equal(h.el('intent-feedback').textContent, conflict)
  assert.ok(h.el('intent-feedback').classList.contains('is-error'))

  // Failed before the invoice that a later request produced: superseded.
  const hOld = load(
    model({
      pending: pendingWith('2026-09-28T11:00:00Z'),
      intents: failedBuy('2026-09-28T10:55:00Z', 'An older failure.'),
    }),
  )
  await hOld.settle()
  assert.equal(hOld.el('invoice-panel').hidden, false)
  assert.equal(hOld.el('intent-feedback').hidden, true)
})

test('an invoice of another kind never hides a failed request', async () => {
  const invoice = 'lnbc250u1pjorderinvoiceorderinvoiceorderinvoice'
  const resetError =
    'The monthly bandwidth reset limit is reached (2 of 2 used). An unpaid reset invoice keeps its reset reserved until it expires.'
  const h = load(
    model({
      pending: {
        // A Buy invoice created after the Reset request failed.
        order: {
          targetNode: 'lnd',
          serverId: 'eu-de',
          duration: '3m',
          amountSats: 25000,
          createdAt: '2026-09-28T11:10:00Z',
          expiresAt: '2026-09-28T12:10:00Z',
          paymentReceived: false,
          invoice,
        },
        renewal: null,
        reset: null,
      },
      intents: {
        buy: {
          id: 'intent-buy-3',
          kind: 'buy',
          status: 'succeeded',
          createdAt: '2026-09-28T11:09:58Z',
          updatedAt: '2026-09-28T11:10:00Z',
        },
        renew: null,
        reset: {
          id: 'intent-reset-1',
          kind: 'reset',
          status: 'failed',
          createdAt: '2026-09-28T11:00:00Z',
          updatedAt: '2026-09-28T11:00:02Z',
          error: resetError,
        },
      },
    }),
  )
  await h.settle()
  assert.equal(h.el('invoice-panel').hidden, false)
  assert.equal(h.el('intent-feedback').hidden, false)
  assert.equal(h.el('intent-feedback').textContent, resetError)
})

// ─── W3: visuals and discovery ───────────────────────────────────────────────

const settleAll = async (h: Harness, rounds = 5) => {
  for (let i = 0; i < rounds; i++) await h.settle()
}

const NODE_PUBKEY = '02' + 'ab'.repeat(32)
const SEPT_16 = Date.UTC(2026, 8, 16)

test('monthPace projects usage to the end of the UTC month', () => {
  const h = load(model())
  const pace = (usedGb: number | null, now: number, limitGb = 100) =>
    h.run(
      `monthPace(${JSON.stringify({ bandwidth: { usedGb, limitGb } })}, ${now})`,
    )
  // 15 of 30 September days elapsed: usage doubles by the end of the month.
  assert.deepEqual(pace(50, SEPT_16), {
    usedGb: 50,
    limitGb: 100,
    projectedGb: 100,
    afterReset: false,
    exceedsLimit: false,
    resetsAt: '2026-10-01T00:00:00.000Z',
  })
  assert.equal(pace(60, SEPT_16).exceedsLimit, true)
  assert.equal(pace(60, SEPT_16).projectedGb, 120)
  // The first day says too little for a projection.
  assert.equal(pace(5, Date.UTC(2026, 8, 1, 12)).projectedGb, null)
  assert.equal(pace(null, SEPT_16), null)
  assert.equal(pace(5, SEPT_16, 0), null)
  const text = h.run(
    `paceText(monthPace(${JSON.stringify({ bandwidth: { usedGb: 60, limitGb: 100 } })}, ${SEPT_16}))`,
  )
  assert.match(
    text,
    /about 120 GB by the end of the month, above the 100 GB allowance/,
  )
  assert.match(h.run('paceText(null)'), /not known yet/)
  assert.match(
    h.run(
      `paceText(monthPace(${JSON.stringify({ bandwidth: { usedGb: 5, limitGb: 100 } })}, ${Date.UTC(2026, 8, 1, 12)}))`,
    ),
    /Too early in the month/,
  )
  // After a paid reset the counter restarted at an unknown time: dividing by
  // the time since the 1st would understate the pace, so no projection.
  const reset = { usedGb: 40, limitGb: 100, resetsThisMonth: 1 }
  const afterReset = h.run(
    `monthPace(${JSON.stringify({ bandwidth: reset })}, ${Date.UTC(2026, 8, 28)})`,
  )
  assert.equal(afterReset.afterReset, true)
  assert.equal(afterReset.projectedGb, null)
  assert.equal(afterReset.exceedsLimit, false)
  assert.match(
    h.run(
      `paceText(monthPace(${JSON.stringify({ bandwidth: reset })}, ${Date.UTC(2026, 8, 28)}))`,
    ),
    /40\.00 GB since this month's paid reset\. No projection/,
  )
  // No reset this month (0) still projects.
  assert.equal(
    h.run(
      `monthPace(${JSON.stringify({ bandwidth: { ...reset, resetsThisMonth: 0 } })}, ${SEPT_16})`,
    ).afterReset,
    false,
  )
})

test('resetEligibility and resetsText follow the confirmed quota, as hints only', () => {
  const h = load(model())
  const state = (bandwidth: Json, extra: Json = {}) =>
    h.run(`resetEligibility(${JSON.stringify(model({ bandwidth, ...extra }))})`)
  const bw = (
    usedGb: number | null,
    resetsThisMonth: number | null,
    maxResetsPerMonth: number | null,
  ) => ({
    usedGb,
    limitGb: 100,
    resetsThisMonth,
    maxResetsPerMonth,
    resetThresholdPct: 70,
  })
  assert.equal(state(bw(40, 0, 2)).state, 'below-threshold')
  assert.match(state(bw(40, 0, 2)).text, /TunnelSats decides/)
  assert.equal(state(bw(80, 1, 2)).state, 'eligible')
  assert.match(state(bw(80, 1, 2)).text, /1 of 2 resets left/)
  assert.equal(state(bw(80, 2, 2)).state, 'quota-used')
  assert.match(state(bw(80, 0, 0)).text, /not offered/)
  assert.equal(state(bw(80, null, null)).state, 'likely')
  assert.equal(state(bw(null, 0, 2)).state, 'unknown')
  assert.equal(
    state(bw(80, 0, 2), {
      pending: { order: null, renewal: null, reset: { targetNode: 'lnd' } },
    }).state,
    'pending',
  )
  assert.equal(
    state(bw(80, 0, 2), {
      subscription: { ...model().subscription, keyUnknown: true },
    }).state,
    'unavailable',
  )
  assert.equal(state(bw(80, 0, 2), { configured: false }).state, 'unavailable')
  for (const s of [state(bw(80, 1, 2)), state(bw(80, null, null))]) {
    assert.match(s.text, /TunnelSats confirms/)
  }
  const resets = (b: Json) =>
    h.run(`resetsText(${JSON.stringify({ bandwidth: b })})`)
  assert.equal(resets(bw(1, 1, 2)), '1 of 2')
  assert.equal(resets(bw(1, null, 2)), '? of 2')
  assert.equal(resets(bw(1, 1, null)), 'Unknown')
})

test('subscriptionTimeline places the 7-day and 3-day reminders before the expiry', () => {
  const h = load(model())
  const now = Date.UTC(2026, 8, 1)
  const at = (days: number) => new Date(now + days * 86400000).toISOString()
  const timeline = (expiresAt: string | null, linked = true) =>
    h.run(
      `subscriptionTimeline(${JSON.stringify({ subscription: { expiresAt, linked } })}, ${now})`,
    )
  const t = timeline(at(20))
  assert.equal(t.phase, 'ok')
  assert.equal(t.startAt, at(-10))
  assert.ok(Math.abs(t.nowPct - 100 / 3) < 1e-9)
  assert.deepEqual(
    t.markers.map((m: Json) => [
      m.kind,
      m.at,
      Math.round(m.pct * 100) / 100,
      m.passed,
    ]),
    [
      ['7d', at(13), 76.67, false],
      ['3d', at(17), 90, false],
    ],
  )
  const soon = timeline(at(5))
  assert.equal(soon.phase, '7d')
  assert.deepEqual(
    soon.markers.map((m: Json) => m.passed),
    [true, false],
  )
  assert.equal(timeline(at(2)).phase, '3d')
  const long = timeline(at(60))
  assert.equal(long.nowPct, 0)
  assert.equal(long.startAt, at(0))
  const expired = timeline(at(-1))
  assert.equal(expired.phase, 'expired')
  assert.equal(expired.nowPct, 100)
  assert.equal(timeline(null), null)
  assert.equal(timeline('not a date'), null)
  // A "# Valid Until" hint on an unlinked subscription is not confirmed.
  assert.equal(timeline(at(20), false), null)
  assert.equal(
    h.run(
      `subscriptionTimeline(${JSON.stringify({ subscription: { expiresAt: at(20), linked: true, keyUnknown: true } })}, ${now})`,
    ),
    null,
  )
})

test('renewPreview adds calendar months to the later of expiry and now', () => {
  const h = load(model())
  const now = Date.UTC(2026, 8, 1)
  const preview = (expiresAt: string, linked = true) =>
    h.run(
      `renewPreview(${JSON.stringify({ subscription: { expiresAt, linked }, plans: model().plans })}, ${now})`,
    )
  assert.deepEqual(
    preview('2026-10-15T00:00:00.000Z').map((p: Json) => [
      p.duration,
      p.newExpiry,
    ]),
    [
      ['1m', '2026-11-15T00:00:00.000Z'],
      ['3m', '2027-01-15T00:00:00.000Z'],
      ['6m', '2027-04-15T00:00:00.000Z'],
      ['12m', '2027-10-15T00:00:00.000Z'],
    ],
  )
  // Expired: counted from now.
  assert.equal(
    preview('2026-08-01T00:00:00.000Z')[0].newExpiry,
    '2026-10-01T00:00:00.000Z',
  )
  assert.deepEqual(
    h.run(
      `renewPreview({ subscription: { expiresAt: null, linked: true } }, ${now})`,
    ),
    [],
  )
  // An unconfirmed "# Valid Until" hint never feeds the preview.
  assert.deepEqual(preview('2026-10-15T00:00:00.000Z', false), [])
  // Month ends roll over exactly like TunnelSats' setMonth: never clamped
  // to the end of February, which TunnelSats would not grant.
  assert.equal(
    preview('2027-01-31T12:00:00.000Z')[0].newExpiry,
    '2027-03-03T12:00:00.000Z',
  )
  assert.equal(
    preview('2028-01-31T12:00:00.000Z')[0].newExpiry,
    '2028-03-02T12:00:00.000Z',
  )
})

test('the poll loop refreshes a stale server list while the tab stays visible', async () => {
  const h = load(model(), 200, undefined, {
    '/api/servers': { status: 200, body: SERVERS },
  })
  await settleAll(h)
  const serverRequests = () =>
    h.requests.filter((r) => r.url === '/api/servers').length
  assert.equal(serverRequests(), 1)
  // A tick before the refresh interval leaves the list alone.
  h.run(`pollTick(Date.now() + 60 * 1000)`)
  assert.equal(serverRequests(), 1)
  h.run(`pollTick(Date.now() + SERVERS_REFRESH_MS)`)
  assert.equal(serverRequests(), 2)
  await settleAll(h)
  // The reload restarts the interval, so the next tick does not reload again.
  h.run(`pollTick(Date.now() + 60 * 1000)`)
  assert.equal(serverRequests(), 2)
  // A hidden tab does not poll at all.
  h.context.document.hidden = true
  h.run(`pollTick(Date.now() + 2 * SERVERS_REFRESH_MS)`)
  assert.equal(serverRequests(), 2)
})

test('flowSteps shows each in-flight flow and the node handoff step by step', () => {
  const h = load(model())
  const flows = (overrides: Json) =>
    h.run(`flowSteps(${JSON.stringify(model(overrides))})`)
  const current = (flow: Json) =>
    flow.steps.findIndex((s: Json) => s.state === 'current')
  assert.deepEqual(flows({}), [])

  const requested = flows({
    intents: { buy: { status: 'processing' }, renew: null, reset: null },
  })
  assert.equal(requested.length, 1)
  assert.equal(requested[0].kind, 'buy')
  assert.equal(current(requested[0]), 1)
  assert.deepEqual(
    requested[0].steps.map((s: Json) => s.label),
    ['Request sent', 'Invoice', 'Payment', 'Tunnel configured'],
  )

  const unpaid = flows({
    pending: {
      order: null,
      renewal: { targetNode: 'cln', invoice: 'lnbc1x' },
      reset: null,
    },
  })
  assert.equal(unpaid[0].kind, 'renew')
  assert.equal(current(unpaid[0]), 2)
  assert.match(unpaid[0].detail, /Pay Invoice task on Core Lightning/)

  const paid = flows({
    pending: {
      order: null,
      renewal: null,
      reset: { targetNode: 'lnd', paymentReceived: true },
    },
  })
  assert.equal(current(paid[0]), 3)
  assert.deepEqual(
    paid[0].steps.map((s: Json) => s.state),
    ['done', 'done', 'done', 'current'],
  )

  const handoff = flows({
    targetNode: 'eclair',
    handoff: { activeTarget: 'eclair', pendingOff: ['lnd'], unraised: [] },
  })
  assert.equal(handoff[0].kind, 'handoff')
  assert.equal(handoff[0].steps[1].label, 'Waiting for LND to turn off')
  assert.equal(handoff[0].steps[1].state, 'current')
  assert.equal(handoff[0].steps[2].label, 'Eclair takes over')
})

test('renderFlows marks the current step for assistive technology', async () => {
  const h = load(
    model({
      intents: { buy: null, renew: { status: 'pending' }, reset: null },
    }),
  )
  await settleAll(h)
  assert.equal(h.el('flow').hidden, false)
  const [flow] = h.el('flow-list').children
  const steps = flow.children[1]
  assert.equal(steps.tagName, 'OL')
  const currentSteps = steps.children.filter(
    (li) => li.attributes['aria-current'] === 'step',
  )
  assert.equal(currentSteps.length, 1)
  assert.equal(currentSteps[0].textContent, 'Invoice')

  const idle = load(model())
  await settleAll(idle)
  assert.equal(idle.el('flow').hidden, true)
})

const SERVERS = {
  servers: [
    {
      id: 'eu-de',
      country: 'Germany',
      city: 'Nuremberg',
      flag: '🇩🇪',
      status: 'online',
    },
    {
      id: 'us-east',
      country: 'USA',
      city: 'Ashburn',
      flag: '🇺🇸',
      status: 'online',
    },
    { id: '../x', country: 'X', city: 'Y', flag: '', status: 'online' },
  ],
  stale: false,
  fetchedAt: '2026-09-01T10:00:00Z',
}

test('server cards drive both Buy region pickers', async () => {
  const h = load(model({ configured: false }), 200, undefined, {
    '/api/servers': { status: 200, body: SERVERS },
  })
  await settleAll(h)
  const cards = h.el('server-cards')
  assert.equal(cards.hidden, false)
  const buttons = cards.children.map((li) => li.children[0])
  assert.deepEqual(
    buttons.map((b) => b.attributes['data-server-id']),
    ['eu-de', 'us-east'],
  )
  assert.deepEqual(
    buttons.map((b) => b.attributes['aria-pressed']),
    ['true', 'false'],
  )
  for (const id of ['buy-server-select', 'manage-buy-server-select']) {
    const select = h.el(id)
    assert.deepEqual(
      select.children.map((o) => [o.value, o.textContent]),
      [
        ['eu-de', 'Nuremberg, Germany'],
        ['us-east', 'Ashburn, USA'],
      ],
    )
    assert.equal(select.value, 'eu-de')
  }
  assert.equal(h.el('server-status-note').hidden, false)
  assert.match(
    readFileSync(join(__dirname, '..', 'web', 'index.html'), 'utf8'),
    /<p id="server-status-note"[^>]*>[\s\S]*?<a\s+href="https:\/\/tunnelsats\.com\/status"\s+target="_blank"\s+rel="noopener noreferrer"\s*>tunnelsats\.com\/status<\/a/,
  )
  assert.doesNotMatch(
    h.el('server-cards-note').textContent,
    /online|healthy|up\b/i,
  )

  h.run(`selectServer('us-east')`)
  assert.equal(h.el('buy-server-select').value, 'us-east')
  assert.equal(h.el('manage-buy-server-select').value, 'us-east')
  assert.deepEqual(
    h
      .el('server-cards')
      .children.map((li) => li.children[0].attributes['aria-pressed']),
    ['false', 'true'],
  )
  // Ids that are not offered or not valid are ignored.
  h.run(`selectServer('sa-br')`)
  h.run(`selectServer('../x')`)
  assert.equal(h.el('buy-server-select').value, 'us-east')

  // The chosen region is what a dashboard Buy request carries.
  h.run(`submitIntent('buy')`)
  await settleAll(h)
  const buy = h.requests.find((r) => r.url === '/api/intents')
  assert.equal(JSON.parse(buy!.init!.body).serverId, 'us-east')
})

test('a refresh never swaps the region the operator picked for another', async () => {
  const routes: Record<string, { status: number; body: Json }> = {
    '/api/servers': { status: 200, body: SERVERS },
  }
  const h = load(model({ configured: false }), 200, undefined, routes)
  await settleAll(h)
  h.run(`selectServer('us-east')`)
  // TunnelSats withdraws us-east before the operator presses Buy.
  routes['/api/servers'] = {
    status: 200,
    body: { servers: [SERVERS.servers[0]] },
  }
  h.run('loadServers()')
  await settleAll(h)
  for (const id of ['buy-server-select', 'manage-buy-server-select']) {
    const select = h.el(id)
    assert.equal(select.value, '')
    assert.deepEqual(
      select.children.map((o) => [o.value, o.disabled]),
      [
        ['', true],
        ['eu-de', false],
      ],
    )
  }
  assert.deepEqual(
    h
      .el('server-cards')
      .children.map((li) => li.children[0].attributes['aria-pressed']),
    ['false'],
  )
  assert.match(
    h.el('server-cards-note').textContent,
    /The region you picked \(us-east\) is no longer offered\. Choose another region before buying\./,
  )
  h.run(`submitIntent('buy')`)
  h.run(`submitIntent('buy-manage')`)
  await settleAll(h)
  assert.equal(
    h.requests.filter((r) => r.url === '/api/intents').length,
    0,
    'Buy must not substitute a region',
  )
  assert.match(h.el('intent-feedback').textContent, /Choose a server region/)

  // A new pick clears the notice and Buy carries it.
  h.run(`selectServer('eu-de')`)
  assert.equal(h.el('buy-server-select').value, 'eu-de')
  assert.doesNotMatch(h.el('server-cards-note').textContent, /no longer/)
  h.run(`submitIntent('buy')`)
  await settleAll(h)
  const buy = h.requests.find((r) => r.url === '/api/intents')
  assert.equal(JSON.parse(buy!.init!.body).serverId, 'eu-de')
})

test('an unpicked default region follows the live list', async () => {
  const h = load(model({ configured: false }), 200, undefined, {
    '/api/servers': {
      status: 200,
      body: { servers: [SERVERS.servers[1]] },
    },
  })
  await settleAll(h)
  assert.equal(h.el('buy-server-select').value, 'us-east')
  assert.doesNotMatch(h.el('server-cards-note').textContent, /no longer/)
})

test('a stale or missing server list says so', async () => {
  const stale = load(model(), 200, undefined, {
    '/api/servers': { status: 200, body: { ...SERVERS, stale: true } },
  })
  await settleAll(stale)
  assert.match(
    stale.el('server-cards-note').textContent,
    /did not answer; regions as of/,
  )

  const failed = load(model())
  await settleAll(failed)
  assert.equal(failed.el('server-cards').hidden, true)
  assert.match(failed.el('server-cards-note').textContent, /built in/)
  assert.equal(failed.el('server-cards-note').hidden, false)
})

test('the reachability check sends only the node key and says it is inbound only', async () => {
  const h = load(model(), 200, undefined, {
    '/api/reachability': {
      status: 200,
      body: {
        success: true,
        latencyMs: 412,
        error: null,
        host: 'de2.tunnelsats.com',
        port: 24556,
      },
    },
  })
  await settleAll(h)
  assert.equal(h.el('reach-target').textContent, 'de2.tunnelsats.com:24556')

  h.el('reach-pubkey').value = 'not-a-key'
  h.run('checkReachability()')
  await settleAll(h)
  assert.equal(
    h.requests.some((r) => r.url === '/api/reachability'),
    false,
  )
  assert.match(h.el('reach-result').textContent, /66 hex characters/)
  assert.equal(h.storage.size, 0)

  h.el('reach-pubkey').value = ` ${NODE_PUBKEY} `
  h.run('checkReachability()')
  await settleAll(h)
  const request = h.requests.find((r) => r.url === '/api/reachability')!
  assert.equal(request.init!.method, 'POST')
  assert.equal(request.init!.headers['X-CSRF-Token'], 'csrf-test-token-123')
  assert.deepEqual(JSON.parse(request.init!.body), { nodePubkey: NODE_PUBKEY })
  assert.equal(h.storage.get('tunnelsats.nodePubkey'), NODE_PUBKEY)
  const text = h.el('reach-result').textContent
  assert.match(
    text,
    /Inbound OK: TunnelSats reached your node through de2\.tunnelsats\.com:24556 in 412 ms/,
  )
  assert.match(text, /does not show that outbound traffic uses the tunnel/)
  assert.ok(h.el('reach-result').classList.contains('is-success'))
  assert.equal(h.el('btn-reachability').disabled, false)
})

test('reachability failures and rate limits are reported, never as success', async () => {
  const limited = load(model(), 200, undefined, {
    '/api/reachability': {
      status: 429,
      body: {
        error: 'Please wait 42s before checking again.',
        retryAfterSeconds: 42,
      },
    },
  })
  await settleAll(limited)
  limited.el('reach-pubkey').value = NODE_PUBKEY
  limited.run('checkReachability()')
  await settleAll(limited)
  assert.equal(
    limited.el('reach-result').textContent,
    'Please wait 42s before checking again.',
  )
  assert.ok(limited.el('reach-result').classList.contains('is-error'))

  const refused = load(model(), 200, undefined, {
    '/api/reachability': {
      status: 200,
      body: {
        success: false,
        latencyMs: null,
        error: 'Connection refused',
        host: 'de2.tunnelsats.com',
        port: 24556,
      },
    },
  })
  await settleAll(refused)
  refused.el('reach-pubkey').value = NODE_PUBKEY
  refused.run('checkReachability()')
  await settleAll(refused)
  assert.equal(
    refused.el('reach-result').textContent,
    'Inbound check failed through de2.tunnelsats.com:24556: Connection refused.',
  )
  for (const result of [
    { kind: 'result', success: true, latencyMs: 1, host: 'h', port: 1 },
    { kind: 'result', success: false, error: 'x' },
  ]) {
    assert.doesNotMatch(
      refused.run(`reachabilityText(${JSON.stringify(result)})`),
      /verified|protected|private|secure|leak/i,
    )
  }
})

test('a stored node key is restored into the reachability form', async () => {
  const h = load(
    model(),
    200,
    undefined,
    {},
    { 'tunnelsats.nodePubkey': NODE_PUBKEY },
  )
  await settleAll(h)
  assert.equal(h.el('reach-pubkey').value, NODE_PUBKEY)
  const junk = load(
    model(),
    200,
    undefined,
    {},
    { 'tunnelsats.nodePubkey': '<img>' },
  )
  await settleAll(junk)
  assert.equal(junk.el('reach-pubkey').value, '')
})

test('the overview renders native gauges, the timeline and the quota', async () => {
  const h = load(
    model({
      bandwidth: {
        usedGb: 120,
        limitGb: 150,
        resetsThisMonth: 1,
        maxResetsPerMonth: 2,
        resetThresholdPct: 70,
      },
    }),
  )
  await settleAll(h)
  const meter = h.el('bandwidth-meter') as unknown as Json
  assert.equal(meter.max, 150)
  assert.equal(meter.value, 120)
  assert.equal(meter.low, 105)
  assert.equal(meter.high, 135)
  assert.equal(meter.optimum, 0)
  assert.equal(h.el('bandwidth-limit').textContent, '/ 150 GB')
  const progress = h.el('subscription-progress') as unknown as Json
  assert.equal(progress.max, 100)
  assert.ok(progress.value > 60 && progress.value <= 67)
  assert.equal(h.el('val-resets').textContent, '1 of 2')
  assert.equal(
    h.el('val-reset-eligibility').attributes['data-state'],
    'eligible',
  )
  assert.match(h.el('pace-text').textContent, /GB/)
  assert.equal(h.el('timeline-phase').textContent, 'On track')
  assert.equal(h.el('timeline-phase').getAttribute('data-phase'), 'ok')
  const svg = h.el('timeline-chart').children[0]
  assert.equal(svg.tagName, 'SVG')
  assert.equal(svg.attributes['aria-hidden'], 'true')
  assert.ok(
    svg.children.every((child) => !('style' in child.attributes)),
    'the timeline uses SVG attributes, not inline styles',
  )
  const legend = h.el('timeline-legend').children
  assert.deepEqual(
    legend.map((chip) => chip.getAttribute('data-kind')),
    ['7d', '3d'],
  )
  assert.ok(legend.every((chip) => chip.className === 'legend-chip'))
  assert.match(legend[0].textContent, /^7-day reminder · \S/)
  // One estimate for the selected plan, and a button that names it.
  const preview = h.el('renew-preview')
  assert.equal(preview.hidden, false)
  assert.equal(preview.children[0].textContent, 'New expiry about ')
  assert.equal(
    preview.children[1].textContent,
    h.run(
      `formatDate(renewPreview(model).find((p) => p.duration === '3m').newExpiry)`,
    ),
  )
  assert.equal(h.el('renew-cta-label').textContent, 'Renew 3 months · $8.55')
})

test('index.html labels the reachability check as inbound only and uses native gauges', () => {
  const html = readFileSync(join(__dirname, '..', 'web', 'index.html'), 'utf8')
  assert.match(
    html,
    /Inbound TCP port check only; does not verify outbound VPN\s+egress\./,
  )
  assert.match(html, /<meter\s+id="bandwidth-meter"/)
  assert.match(html, /<meter\s+id="modal-bandwidth-meter"/)
  assert.match(html, /<progress\s+id="subscription-progress"/)
  for (const command of ['wg show', 'ip rule', 'ip route', 'ifconfig.me']) {
    assert.ok(html.includes(command), `privacy commands include ${command}`)
  }
  assert.doesNotMatch(html, /\sstyle\s*=/i)
})

test('every meter and progress bar in index.html has an accessible name', () => {
  // The SVG gauges are aria-hidden: these elements are what a screen reader reads.
  const html = readFileSync(join(__dirname, '..', 'web', 'index.html'), 'utf8')
  const gauges = [...html.matchAll(/<(meter|progress)\b([^>]*)>/g)]
  assert.equal(gauges.length, 3)
  for (const [, tag, attributes] of gauges) {
    const id = /\sid="([^"]+)"/.exec(attributes)?.[1]
    const label = /\saria-label="([^"]*)"/.exec(attributes)?.[1] ?? ''
    assert.ok(label.trim().length > 0, `<${tag} id="${id}"> has no aria-label`)
  }
})

test('command deck segmented navigation switches between Overview, Actions & Plans, and Verify & CLI while preserving context emphasis', async () => {
  // Unconfigured customer: Overview tab emphasizes Setup (Server Region + Buy)
  const hNew = load(
    model({
      configured: false,
      status: 'unconfigured',
      connection: {},
      handoff: null,
    }),
  )
  await settleAll(hNew)
  assert.equal(hNew.el('view-setup').hidden, false)
  assert.equal(hNew.el('view-overview').hidden, true)
  assert.equal(hNew.el('manage').hidden, true)
  assert.equal(hNew.el('verify-section').hidden, true)
  assert.equal(hNew.el('tab-btn-overview').getAttribute('aria-pressed'), 'true')
  assert.equal(hNew.el('tab-btn-actions').getAttribute('aria-pressed'), 'false')
  assert.equal(hNew.el('tab-btn-verify').getAttribute('aria-pressed'), 'false')

  // Configured customer: Overview tab emphasizes Overview (Topology + Renew)
  const hExisting = load(model({ configured: true }))
  await settleAll(hExisting)
  assert.equal(hExisting.el('view-setup').hidden, true)
  assert.equal(hExisting.el('view-overview').hidden, false)
  assert.equal(hExisting.el('manage').hidden, true)
  assert.equal(hExisting.el('verify-section').hidden, true)

  // Switch to Actions & Plans tab
  hExisting.run(`switchTab('actions')`)
  assert.equal(hExisting.el('view-overview').hidden, true)
  assert.equal(hExisting.el('manage').hidden, false)
  assert.equal(hExisting.el('verify-section').hidden, true)
  assert.equal(
    hExisting.el('tab-btn-actions').getAttribute('aria-pressed'),
    'true',
  )
  assert.equal(
    hExisting.el('tab-btn-overview').getAttribute('aria-pressed'),
    'false',
  )

  // Switch to Verify & CLI tab
  hExisting.run(`switchTab('verify')`)
  assert.equal(hExisting.el('view-overview').hidden, true)
  assert.equal(hExisting.el('manage').hidden, true)
  assert.equal(hExisting.el('verify-section').hidden, false)
  assert.equal(
    hExisting.el('tab-btn-verify').getAttribute('aria-pressed'),
    'true',
  )

  // Unknown tab names are ignored
  hExisting.run(`switchTab('unknown-tab')`)
  assert.equal(
    hExisting.el('tab-btn-verify').getAttribute('aria-pressed'),
    'true',
  )
})

test('duration pills for Buy and Renew sync with select elements and drive submitIntent', async () => {
  const h = load(model({ configured: true }), 200, undefined, {
    '/api/servers': { status: 200, body: SERVERS },
  })
  await settleAll(h)

  // Renew duration pills default to 3m and update on selectRenewDuration
  const renewPills = h.el('renew-pills').children
  assert.equal(renewPills.length, 4)
  assert.deepEqual(
    renewPills.map((b) => b.getAttribute('data-renew-duration')),
    ['1m', '3m', '6m', '12m'],
  )
  assert.deepEqual(
    renewPills.map((b) => b.getAttribute('aria-pressed')),
    ['false', 'true', 'false', 'false'],
  )

  h.run(`selectRenewDuration('12m')`)
  assert.equal(h.el('renew-duration-select').value, '12m')
  assert.deepEqual(
    h.el('renew-pills').children.map((b) => b.getAttribute('aria-pressed')),
    ['false', 'false', 'false', 'true'],
  )
  assert.equal(h.el('renew-cta-label').textContent, 'Renew 12 months · $28.80')
  assert.equal(
    h.el('renew-preview').children[1].textContent,
    h.run(
      `formatDate(renewPreview(model).find((p) => p.duration === '12m').newExpiry)`,
    ),
  )

  // Invalid durations are ignored
  h.run(`selectRenewDuration('99m')`)
  assert.equal(h.el('renew-duration-select').value, '12m')

  await vm.runInContext(`submitIntent('renew')`, h.context)
  await settleAll(h)
  const renewReq = h.requests.find((r) => r.url === '/api/intents')
  assert.deepEqual(JSON.parse(renewReq!.init!.body), {
    kind: 'renew',
    duration: '12m',
  })

  // Buy duration pills update both buy-duration-select and manage-buy-duration-select
  h.run(`selectBuyDuration('6m')`)
  assert.equal(h.el('buy-duration-select').value, '6m')
  assert.equal(h.el('manage-buy-duration-select').value, '6m')
  assert.equal(h.el('buy-cta-label').textContent, 'Buy 6 months · $16.20')
  assert.equal(
    h.el('plan-list').children[2].children[0].getAttribute('aria-pressed'),
    'true',
  )
})

/** The button in a toggle group that carries `value`. */
const toggle = (h: Harness, group: string, attr: string, value: string) => {
  const button = h
    .el(group)
    .querySelectorAll(`[${attr}]`)
    .find((b) => b.getAttribute(attr) === value)
  assert.ok(button, `${group} has no ${attr}=${value}`)
  return button
}

test('polls and selections keep keyboard focus on pills, plan cards and server cards', async () => {
  const h = load(model({ configured: true }), 200, undefined, {
    '/api/servers': { status: 200, body: SERVERS },
  })
  await settleAll(h)
  // [group, value attribute, value to pick, the script's selection variable]
  const groups = [
    ['renew-pills', 'data-renew-duration', '12m', 'selectedRenewDuration'],
    ['plan-list', 'data-plan-duration', '6m', 'selectedBuyDuration'],
    [
      'manage-duration-pills',
      'data-plan-duration',
      '1m',
      'selectedBuyDuration',
    ],
    ['server-cards', 'data-server-id', 'us-east', 'selectedServerId'],
    ['manage-server-cards', 'data-server-id', 'eu-de', 'selectedServerId'],
  ]
  for (const [group, attr, value, selection] of groups) {
    const button = toggle(h, group, attr, value)
    assert.equal(
      button.tagName,
      'BUTTON',
      `${group}: Enter and Space must work`,
    )
    button.focus()
    // Every poll runs render(); while a payment is pending that is every 3 s.
    h.run('render(); renderServers()')
    assert.equal(toggle(h, group, attr, value), button, `${group}: rebuilt`)
    assert.equal(h.doc.activeElement, button, `${group}: a poll took focus`)
    h.dispatch('click', button)
    assert.equal(h.run(selection), value)
    assert.equal(h.doc.activeElement, button, `${group}: a pick took focus`)
    assert.equal(button.getAttribute('aria-pressed'), 'true')
    assert.ok(button.classList.contains('is-selected'))
  }
})

test('a rebuilt plan group gives focus back to the same duration', async () => {
  const h = load(model({ configured: true }))
  await settleAll(h)
  const before = toggle(h, 'plan-list', 'data-plan-duration', '6m')
  before.focus()
  // New prices from the backend change what the buttons show.
  h.run(
    'model.plans = PLAN_PRICES_USD.map((p) => ({ ...p, usd: p.usd + 1 })); render()',
  )
  const after = toggle(h, 'plan-list', 'data-plan-duration', '6m')
  assert.notEqual(after, before)
  assert.equal(after.children[1].textContent, '$17.20')
  assert.equal(h.doc.activeElement, after)
})

test('a link to another tab moves focus to that tab instead of <body>', async () => {
  const h = load(model({ configured: true }))
  await settleAll(h)
  for (const tab of ['overview', 'actions', 'verify']) {
    h.el(`tab-btn-${tab}`).setAttribute('data-tab-target', tab)
  }
  // "Verify on the node" sits in the Overview panel, which the switch hides.
  const link = vm.runInContext(
    "document.createElement('button')",
    h.context,
  ) as FakeElement
  link.setAttribute('data-tab-target', 'verify')
  h.el('view-overview').append(link)
  link.focus()
  h.dispatch('click', link)
  assert.equal(h.run('activeTab'), 'verify')
  assert.equal(h.el('view-overview').hidden, true)
  assert.equal(h.doc.activeElement, h.el('tab-btn-verify'))

  const actions = h.el('tab-btn-actions')
  actions.focus()
  h.dispatch('click', actions)
  assert.equal(h.run('activeTab'), 'actions')
  assert.equal(h.doc.activeElement, actions)
})

test('the fallback duration and region selects drive the same selection', async () => {
  const h = load(model({ configured: true }), 200, undefined, {
    '/api/servers': { status: 200, body: SERVERS },
  })
  await settleAll(h)
  const change = (id: string, value: string) => {
    const select = h.el(id)
    select.value = value
    h.dispatch('change', select)
  }
  change('renew-duration-select', '1m')
  assert.equal(h.run('selectedRenewDuration'), '1m')
  change('manage-buy-duration-select', '12m')
  assert.equal(h.run('selectedBuyDuration'), '12m')
  assert.equal(h.el('buy-duration-select').value, '12m')
  change('buy-server-select', 'us-east')
  assert.equal(h.run('selectedServerId'), 'us-east')
  assert.equal(
    toggle(h, 'manage-server-cards', 'data-server-id', 'us-east').getAttribute(
      'aria-pressed',
    ),
    'true',
  )
})

test('command deck renders SVG ring/arc gauges and visual reset pips without inline styles', async () => {
  const h = load(
    model({
      bandwidth: {
        usedGb: 75,
        limitGb: 150,
        resetsThisMonth: 1,
        maxResetsPerMonth: 2,
        resetThresholdPct: 70,
      },
    }),
  )
  await settleAll(h)

  const ringArc = h.el('subscription-ring-arc')
  const ringOffset = Number(ringArc.getAttribute('stroke-dashoffset'))
  assert.ok(ringOffset >= 30 && ringOffset <= 40)
  assert.equal('style' in ringArc.attributes, false)

  const bwFill = h.el('bandwidth-arc-fill')
  assert.equal(bwFill.getAttribute('stroke-dashoffset'), '50')
  assert.equal('style' in bwFill.attributes, false)

  const pips = h.el('reset-pips').children
  assert.equal(pips.length, 2)
  assert.equal(pips[0].classList.contains('is-used'), true)
  assert.equal(pips[1].classList.contains('is-used'), false)
})

const WEB_DIR = join(__dirname, '..', 'web')

/** Every file under web/, as POSIX paths relative to it. */
function webFiles(prefix = ''): string[] {
  return readdirSync(join(WEB_DIR, prefix), { withFileTypes: true })
    .flatMap((entry) =>
      entry.isDirectory()
        ? webFiles(`${prefix}${entry.name}/`)
        : [`${prefix}${entry.name}`],
    )
    .sort()
}

test('every asset the dashboard references ships, and nothing unreferenced ships', () => {
  const html = readFileSync(join(WEB_DIR, 'index.html'), 'utf8')
  const css = readFileSync(join(WEB_DIR, 'style.css'), 'utf8')
  const isLocal = (ref: string) => !/^(?:[a-z][a-z0-9+.-]*:|#|\/\/)/i.test(ref)
  const referenced = new Set(
    [
      ...[...html.matchAll(/\s(?:src|href)="([^"]+)"/g)].map((m) => m[1]),
      ...[...css.matchAll(/url\(\s*['"]?([^'")]+)['"]?\s*\)/g)].map(
        (m) => m[1],
      ),
    ].filter(isLocal),
  )
  for (const ref of referenced) {
    assert.ok(
      existsSync(join(WEB_DIR, ref)),
      `${ref} is referenced but missing`,
    )
  }
  // The font licences ship next to the fonts without a link from the page.
  const unreferenced = webFiles().filter(
    (file) =>
      file !== 'index.html' &&
      !referenced.has(file) &&
      !/^fonts\/LICENSE-[A-Za-z]+\.txt$/.test(file),
  )
  assert.deepEqual(unreferenced, [])
})

test('shipped SVG, PNG and font files carry no active content or metadata', () => {
  const files = webFiles()
  const svgs = files.filter((file) => file.endsWith('.svg'))
  assert.ok(svgs.length > 0)
  for (const file of svgs) {
    const svg = readFileSync(join(WEB_DIR, file), 'utf8')
    for (const [pattern, what] of [
      [/<script/i, 'a script element'],
      [/\son[a-z]+\s*=/i, 'an event handler attribute'],
      [/javascript:/i, 'a javascript: URL'],
      [/<foreignObject/i, 'foreignObject'],
      [/<!(?:DOCTYPE|ENTITY)/i, 'a DTD or entity'],
      [/(?:\s|:)href\s*=\s*["'](?!#)/i, 'an external reference'],
      [/\bstyle\s*=/i, 'an inline style attribute (CSP)'],
      [/<style[\s>]/i, 'a style element (CSP)'],
      [/url\((?!\s*['"]?#)/i, 'an external url() reference'],
    ] as const) {
      assert.doesNotMatch(svg, pattern, `${file} must not contain ${what}`)
    }
  }

  const pngs = files.filter((file) => file.endsWith('.png'))
  assert.ok(pngs.length > 0)
  const signature = Buffer.from([
    0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a,
  ])
  for (const file of pngs) {
    const png = readFileSync(join(WEB_DIR, file))
    assert.ok(png.subarray(0, 8).equals(signature), `${file} is a PNG`)
    const chunks: string[] = []
    let offset = 8
    while (offset + 8 <= png.length) {
      const type = png.toString('latin1', offset + 4, offset + 8)
      chunks.push(type)
      offset += 12 + png.readUInt32BE(offset)
      if (type === 'IEND') break
    }
    assert.equal(chunks.at(-1), 'IEND', `${file} ends with IEND`)
    assert.equal(offset, png.length, `${file} has no data after IEND`)
    for (const meta of ['tEXt', 'iTXt', 'zTXt', 'tIME', 'eXIf']) {
      assert.ok(!chunks.includes(meta), `${file} carries no ${meta} chunk`)
    }
  }

  const fonts = files.filter((file) => file.endsWith('.woff2'))
  assert.deepEqual(fonts, [
    'fonts/inter-latin-wght-normal.woff2',
    'fonts/jetbrains-mono-latin-wght-normal.woff2',
  ])
  for (const file of fonts) {
    const magic = readFileSync(join(WEB_DIR, file)).toString('latin1', 0, 4)
    assert.equal(magic, 'wOF2', `${file} is a WOFF2 font`)
  }
  for (const license of [
    'fonts/LICENSE-Inter.txt',
    'fonts/LICENSE-JetBrainsMono.txt',
  ]) {
    assert.match(
      readFileSync(join(WEB_DIR, license), 'utf8'),
      /SIL OPEN FONT LICENSE Version 1\.1/,
    )
  }
})

test('the dashboard icons ship at twice their largest display size', () => {
  // .brand-tile-icon is 2rem (32 px): 64 px covers 2x screens. Larger files
  // only cost load time, which shows when the dashboard is opened over Tor.
  const icons = webFiles().filter((file) => /^icons\/[^/]+\.png$/.test(file))
  assert.equal(icons.length, 10)
  for (const file of icons) {
    const png = readFileSync(join(WEB_DIR, file))
    // IHDR is always the first chunk; width and height follow its type.
    assert.equal(png.toString('latin1', 12, 16), 'IHDR', `${file} IHDR`)
    assert.deepEqual(
      [png.readUInt32BE(16), png.readUInt32BE(20)],
      [64, 64],
      `${file} is 64x64`,
    )
  }
})

/** BIP-173 checksum, as used by NIP-19 identifiers (no length limit). */
function bech32ChecksumValid(value: string): boolean {
  const charset = 'qpzry9x8gf2tvdw0s3jn54khce6mua7l'
  const lower = value.toLowerCase()
  const sep = lower.lastIndexOf('1')
  if (sep < 1 || sep + 7 > lower.length) return false
  const hrp = [...lower.slice(0, sep)].map((c) => c.charCodeAt(0))
  const data = [...lower.slice(sep + 1)].map((c) => charset.indexOf(c))
  if (data.some((d) => d < 0)) return false
  const gen = [0x3b6a57b2, 0x26508e6d, 0x1ea119fa, 0x3d4233dd, 0x2a1462b3]
  let chk = 1
  for (const v of [
    ...hrp.map((c) => c >> 5),
    0,
    ...hrp.map((c) => c & 31),
    ...data,
  ]) {
    const top = chk >> 25
    chk = ((chk & 0x1ffffff) << 5) ^ v
    for (let i = 0; i < 5; i++) if ((top >> i) & 1) chk ^= gen[i]
  }
  return chk === 1
}

test('external links are https, on an exact allow-list and open without an opener', () => {
  const html = readFileSync(join(WEB_DIR, 'index.html'), 'utf8')
  const allowed = new Set([
    'https://tunnelsats.com',
    'https://tunnelsats.com/guide',
    'https://tunnelsats.com/status',
    'https://tunnelsats.com/join-telegram',
    'https://tunnelsats.com/faq#what-happens-if-i-reach-the-100gb-limit',
    'https://primal.net/p/nprofile1qqsfj32jgnfp7asvcr5sj3ljar2v6elhm5560zfh0xqfeqsgl84s0rc37zmgx',
    'https://x.com/TunnelSats',
    'https://github.com/Tunnelsats/tunnelsats-startos',
  ])
  const anchors = [...html.matchAll(/<a\b[^>]*>/g)].map((m) => m[0])
  let external = 0
  for (const anchor of anchors) {
    const href = /\shref="([^"]*)"/.exec(anchor)?.[1] ?? ''
    if (/^[a-z][a-z0-9+.-]*:/i.test(href)) {
      external++
      assert.ok(allowed.has(href), `${href} is not on the link allow-list`)
      assert.match(anchor, /\starget="_blank"/, `${href} opens in a new tab`)
    }
    if (/\starget="_blank"/.test(anchor)) {
      assert.match(anchor, /\srel="noopener noreferrer"/, `${href} rel`)
    }
  }
  assert.ok(external >= allowed.size)
  // Previously linked but dead or not ours.
  assert.ok(!html.includes('docs.tunnelsats.com'))
  assert.ok(!html.includes('t.me/+'))
  const nprofile = /nprofile1[02-9ac-hj-np-z]+/.exec(html)?.[0] ?? ''
  assert.ok(bech32ChecksumValid(nprofile), 'the Nostr profile link is intact')
  const typo = nprofile.slice(0, -1) + (nprofile.endsWith('q') ? 'p' : 'q')
  assert.ok(!bech32ChecksumValid(typo), 'the checksum catches a typo')
})

test('the bandwidth pace marker sits on the arc at the projected usage', () => {
  const h = load(model())
  // The arc in index.html: M 20 82 A 60 60 0 0 1 140 82.
  assert.deepEqual(h.run('arcPoint(0)'), { x: 20, y: 82 })
  assert.deepEqual(h.run('arcPoint(50)'), { x: 80, y: 22 })
  assert.deepEqual(h.run('arcPoint(100)'), { x: 140, y: 82 })
  assert.deepEqual(h.run('arcPoint(250)'), { x: 140, y: 82 })
  assert.deepEqual(h.run('arcPoint(-5)'), { x: 20, y: 82 })
  assert.deepEqual(h.run('arcPoint(NaN)'), { x: 20, y: 82 })

  const marker = h.el('bandwidth-pace-marker')
  const pace = h.el('pace-text')
  const quota = (bandwidth: Json, now: number) =>
    h.run(`renderQuota(${JSON.stringify(model({ bandwidth }))}, ${now})`)
  // Half of September gone, 50 GB used: 100 GB projected of 150 GB.
  quota({ usedGb: 50, limitGb: 150 }, SEPT_16)
  assert.equal(marker.getAttribute('cx'), '110')
  assert.equal(marker.getAttribute('cy'), '30.04')
  assert.equal(marker.classList.contains('is-visible'), true)
  assert.equal(marker.classList.contains('is-over'), false)
  assert.equal(pace.getAttribute('data-projection'), 'true')
  // 120 GB projected of 100 GB: pinned to the end and flagged.
  quota({ usedGb: 60, limitGb: 100 }, SEPT_16)
  assert.equal(marker.getAttribute('cx'), '140')
  assert.equal(marker.getAttribute('cy'), '82')
  assert.equal(marker.classList.contains('is-over'), true)
  // No projection on the first day of the month: no marker.
  quota({ usedGb: 5, limitGb: 100 }, Date.UTC(2026, 8, 1, 12))
  assert.equal(marker.classList.contains('is-visible'), false)
  assert.equal(marker.classList.contains('is-over'), false)
  assert.equal(pace.getAttribute('data-projection'), 'false')
})

test('the NWC badge reads Off, On or On · Tor and names problems plainly', async () => {
  const view = (h: Harness, nwc: Json | undefined) =>
    h.run(`nwcStatusView(${JSON.stringify(model({ nwc }))})`)
  const h = load(model())
  await settleAll(h)
  assert.equal(h.el('nwc-badge').textContent, 'Off')
  assert.equal(h.el('nwc-badge').className, 'nwc-badge neutral')
  assert.equal(view(h, { connected: false }).badge, 'Off')
  const on = view(h, {
    connected: true,
    relayHost: 'relay.example.com',
    resolvedDuration: '3m',
    recommendedBudgetSats: 12000,
    recommendedAnnualSats: 48000,
  })
  assert.deepEqual([on.cls, on.badge], ['active', 'On'])
  assert.match(on.note, /Relay relay\.example\.com · 3m plan · .*12,000 sats/)
  assert.equal(
    view(h, { connected: true, routeViaTor: true }).badge,
    'On · Tor',
  )
  for (const [flags, badge] of [
    [{ restoreReconnectNeeded: true }, 'Reconnect needed'],
    [{ budgetWarning: true }, 'Budget too low'],
    [{ fallbackTaskRaised: true }, 'Manual fallback'],
  ] as const) {
    const problem = view(h, { connected: true, ...flags })
    assert.deepEqual([problem.cls, problem.badge], ['alert', badge])
  }
})

test('truncated connection values keep the full value as their tooltip', async () => {
  const h = load(model())
  await settleAll(h)
  assert.equal(h.el('val-endpoint').title, 'de2.tunnelsats.com:24556')
  assert.equal(h.el('val-vpn-ip').title, '10.9.0.7')
  assert.equal(h.el('val-target-node').title, 'LND')
  const bare = load(model({ connection: {} }))
  await settleAll(bare)
  assert.equal(bare.el('val-endpoint').textContent, 'Unknown')
  assert.equal(bare.el('val-endpoint').title, '')
  assert.equal(bare.el('val-vpn-ip').title, '')
})

test('times are shown to the minute and estimates to the day', () => {
  const h = load(model())
  const time = h.run(`formatTime('2026-09-16T10:20:30.000Z')`)
  assert.match(time, /2026/)
  assert.match(time, /\d[:.]\d{2}/)
  assert.doesNotMatch(time, /\d[:.]\d{2}[:.]\d{2}/, 'no seconds')
  const date = h.run(`formatDate('2026-09-16T10:20:30.000Z')`)
  assert.match(date, /2026/)
  assert.doesNotMatch(date, /\d[:.]\d{2}/, 'no time of day')
  assert.equal(h.run(`formatTime('not a date')`), null)
  assert.equal(h.run(`formatDate(null)`), null)
  assert.equal(h.run('monthsLabel(1)'), '1 month')
  assert.equal(h.run('monthsLabel(12)'), '12 months')
})
