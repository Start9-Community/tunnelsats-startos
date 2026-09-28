import test from 'node:test'
import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { readFileSync } from 'node:fs'
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

class FakeElement {
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
  constructor(public tagName = 'DIV') {}
  append(...nodes: FakeElement[]) {
    this.children.push(...nodes)
  }
  replaceChildren(...nodes: FakeElement[]) {
    this.children = nodes
  }
  setAttribute(name: string, value: string) {
    this.attributes[name] = value
  }
  getAttribute(name: string) {
    return this.attributes[name] ?? null
  }
  addEventListener() {}
  remove() {}
  select() {}
}

interface Harness {
  context: vm.Context
  requests: { url: string; init: Json | undefined }[]
  elements: Map<string, FakeElement>
  el: (id: string) => FakeElement
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
): Harness {
  const requests: { url: string; init: Json | undefined }[] = []
  const elements = new Map<string, FakeElement>()
  const el = (id: string) => {
    let element = elements.get(id)
    if (!element) {
      element = new FakeElement()
      elements.set(id, element)
    }
    return element
  }
  const csrfMeta = new FakeElement('META')
  csrfMeta.setAttribute('content', 'csrf-test-token-123')
  const context = vm.createContext({
    console: { log() {}, warn() {}, error() {}, info() {} },
    document: {
      hidden: false,
      getElementById: el,
      createElement: (tag: string) => new FakeElement(tag.toUpperCase()),
      createElementNS: (_ns: string, tag: string) =>
        new FakeElement(tag.toUpperCase()),
      querySelector: (selector: string) =>
        selector === 'meta[name="csrf-token"]' ? csrfMeta : null,
      addEventListener() {},
      body: new FakeElement('BODY'),
    },
    window: { isSecureContext: false },
    navigator: {},
    HTMLDialogElement: { prototype: { closedBy: '' } },
    Date,
    setInterval: () => 0,
    clearInterval() {},
    setTimeout: () => 0,
    fetch: async (url: string, init?: Json) => {
      requests.push({ url: String(url), init })
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
    requests,
    elements,
    el,
    run: (code: string) => {
      const value = vm.runInContext(code, context)
      return value && typeof value === 'object'
        ? JSON.parse(JSON.stringify(value))
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

test('the dashboard only GETs /api/dashboard on initial load on its own origin', async () => {
  const h = load(model())
  await h.settle()
  assert.equal(h.requests.length, 1)
  const [request] = h.requests
  assert.equal(request.url, '/api/dashboard')
  assert.equal(request.init?.method ?? 'GET', 'GET')
  assert.equal(request.init?.body, undefined)
  assert.equal(request.init?.credentials, 'same-origin')
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
    'localStorage',
  ]) {
    assert.ok(!SCRIPT.includes(banned), `script.js must not contain ${banned}`)
  }
  // Every fetch in the script is either GET /api/dashboard or POST /api/intents.
  const fetches = SCRIPT.match(/fetch\(([^,)]+)/g) ?? []
  assert.deepEqual(fetches, ['fetch(DASHBOARD_URL', 'fetch(INTENTS_URL'])
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
  const cards = h.el('plan-list').children
  assert.equal(cards.length, 4)
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
    /<strong>Not yet\.<\/strong> Automatic renewals through Nostr\s+Wallet Connect \(NWC\) are planned\./,
  )
  assert.match(html, /Kill switch caveat:/)
  assert.match(html, /Services → TunnelSats → Actions → Buy Subscription/)
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
