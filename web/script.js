// TunnelSats dashboard: read model + intent bridge.
//
// State comes from GET /api/dashboard, an allow-listed read model without
// secrets (bridge.py get_dashboard). Buying, renewing and resetting can be
// requested from this dashboard via POST /api/intents (CSRF-protected,
// single-writer intent file picked up by the StartOS service) or run as
// StartOS actions. Every payment raises a Pay Invoice task on the target
// Lightning node and shows the same payable BOLT11 invoice here as a pure-DOM
// offline SVG QR code. It makes no request to any other host: the server
// list (GET /api/servers) and the inbound reachability check
// (POST /api/reachability) are fetched by bridge.py on its behalf.

const DASHBOARD_URL = '/api/dashboard'
const INTENTS_URL = '/api/intents'
const SERVERS_URL = '/api/servers'
const REACHABILITY_URL = '/api/reachability'
const SERVERS_REFRESH_MS = 10 * 60 * 1000
const NODE_PUBKEY_RE = /^0[23][0-9a-fA-F]{64}$/
// The operator's node public key for the reachability check; kept in this
// browser only.
const NODE_PUBKEY_STORAGE_KEY = 'tunnelsats.nodePubkey'
const DEFAULT_SERVER_ID = 'eu-de'
const POLL_MS = 30000
const FAST_POLL_MS = 3000
const DAY_MS = 24 * 60 * 60 * 1000
// The expiry progress bar is scaled to a one-month plan.
const PROGRESS_TERM_MS = 30 * DAY_MS
const BANDWIDTH_WARN_PCT = 70
const BANDWIDTH_CRITICAL_PCT = 90
// The renewal timeline spans at least the last 30 days before the expiry.
const TIMELINE_MIN_WINDOW_MS = 30 * DAY_MS
// The Subscription health check posts reminders 7 and 3 days before expiry.
const REMINDER_MARKERS = Object.freeze([
  Object.freeze({ kind: '7d', days: 7, label: '7-day reminder' }),
  Object.freeze({ kind: '3d', days: 3, label: '3-day reminder' }),
])
const SVG_NS = 'http://www.w3.org/2000/svg'
const BOLT11_RE = /^ln(?:bcrt|bc|tbs|tb|sb)[0-9a-z]{20,4000}$/i

// Reference USD plan pricing from the TunnelSats backend's pricing module
// (Tunnelsats/tunnelsats-v2-web, src/lib/pricing.ts: BASE_PRICE_USD = 3 per
// month, DISCOUNTS 1/3/6/12 months = 0/5/10/20 %). GET /api/dashboard supplies
// m.plans from bridge.py; the Buy/Renew action fetches the live quote and
// shows the exact amount in sats on the invoice.
const BASE_PRICE_USD = 3
const PLAN_DISCOUNTS_PCT = Object.freeze([
  Object.freeze({ months: 1, discountPct: 0 }),
  Object.freeze({ months: 3, discountPct: 5 }),
  Object.freeze({ months: 6, discountPct: 10 }),
  Object.freeze({ months: 12, discountPct: 20 }),
])
const PLAN_PRICES_USD = Object.freeze(
  PLAN_DISCOUNTS_PCT.map(({ months, discountPct }) =>
    Object.freeze({
      months,
      usd: Math.round(BASE_PRICE_USD * months * (100 - discountPct)) / 100,
      discountPct,
    }),
  ),
)

const NODE_LABELS = Object.freeze({
  lnd: 'LND',
  cln: 'Core Lightning',
  'c-lightning': 'Core Lightning',
  eclair: 'Eclair',
})

// StartOS package IDs, for `start-cli package attach <id>`.
const NODE_PACKAGE_IDS = Object.freeze({
  lnd: 'lnd',
  cln: 'c-lightning',
  'c-lightning': 'c-lightning',
  eclair: 'eclair',
})

const VALID_TABS = Object.freeze(['overview', 'actions', 'verify'])
const VALID_DURATIONS = Object.freeze(['1m', '3m', '6m', '12m'])

let model = null
let loadFailed = false
let countdownTimer = null
let lastPollAt = 0
let submittingIntent = false
let localIntentFeedback = null
let lastRenderedInvoice = null
let selectedInvoiceKind = null
let activeTab = 'overview'
let selectedBuyDuration = '3m'
let selectedRenewDuration = '3m'
let selectedServerId = DEFAULT_SERVER_ID
// Whether the operator picked selectedServerId. A picked region that drops
// out of a refreshed list is never swapped for another: the selection is
// cleared (withdrawnServerId) and Buy waits for a new pick.
let serverPickedByOperator = false
let withdrawnServerId = null
let serverList = null
let serversFailed = false
let serversLoadedAt = 0
let reachabilityInFlight = false
let reachabilityResult = null

// ─────────────────────────────────────────────
// Pure-DOM ISO/IEC 18004 QR Code Generator (Byte mode, Level L, V1–V40)
// ─────────────────────────────────────────────
// Byte mode encodes the invoice exactly as displayed and copied (lowercase),
// so scanning and copying always yield the same string.

// Error correction level L, indexed by version (index 0 unused).
const QR_ECC_CODEWORDS_PER_BLOCK_L = Object.freeze([
  -1, 7, 10, 15, 20, 26, 18, 20, 24, 30, 18, 20, 24, 26, 30, 22, 24, 28, 30, 28,
  28, 28, 28, 30, 30, 26, 28, 30, 30, 30, 30, 30, 30, 30, 30, 30, 30, 30, 30,
  30, 30,
])
const QR_NUM_ECC_BLOCKS_L = Object.freeze([
  -1, 1, 1, 1, 1, 1, 2, 2, 2, 2, 4, 4, 4, 4, 4, 6, 6, 6, 6, 7, 8, 8, 9, 9, 10,
  12, 12, 12, 13, 14, 15, 16, 17, 18, 19, 19, 20, 21, 22, 24, 25,
])
const QR_MAX_VERSION = 40

// Modules available for data and ECC in a version (ISO/IEC 18004 §7.1).
function qrRawDataModules(version) {
  let result = (16 * version + 128) * version + 64
  if (version >= 2) {
    const numAlign = Math.floor(version / 7) + 2
    result -= (25 * numAlign - 10) * numAlign - 55
    if (version >= 7) result -= 36
  }
  return result
}

function qrAlignmentCenters(version) {
  if (version === 1) return []
  const size = 17 + version * 4
  const numAlign = Math.floor(version / 7) + 2
  const step =
    Math.floor((version * 8 + numAlign * 3 + 5) / (numAlign * 4 - 4)) * 2
  const result = [6]
  for (let pos = size - 7; result.length < numAlign; pos -= step) {
    result.splice(1, 0, pos)
  }
  return result
}

// Block layout of a version at level L: short blocks first, long blocks
// carry one more data codeword.
function qrBlockLayout(version) {
  const rawCodewords = Math.floor(qrRawDataModules(version) / 8)
  const numBlocks = QR_NUM_ECC_BLOCKS_L[version]
  const ecPerBlock = QR_ECC_CODEWORDS_PER_BLOCK_L[version]
  const numShortBlocks = numBlocks - (rawCodewords % numBlocks)
  const shortDataCw = Math.floor(rawCodewords / numBlocks) - ecPerBlock
  return {
    ecPerBlock,
    numBlocks,
    numShortBlocks,
    shortDataCw,
    totalDataCw: rawCodewords - ecPerBlock * numBlocks,
  }
}

const GF_EXP = new Uint8Array(512)
const GF_LOG = new Uint8Array(256)
;(function initGaloisField() {
  let x = 1
  for (let i = 0; i < 255; i++) {
    GF_EXP[i] = x
    GF_LOG[x] = i
    x <<= 1
    if (x & 0x100) x ^= 0x11d
  }
  for (let i = 255; i < 512; i++) {
    GF_EXP[i] = GF_EXP[i - 255]
  }
})()

function gfMul(a, b) {
  if (a === 0 || b === 0) return 0
  return GF_EXP[GF_LOG[a] + GF_LOG[b]]
}

function rsGeneratorPoly(degree) {
  let poly = new Uint8Array([1])
  for (let i = 0; i < degree; i++) {
    const next = new Uint8Array(poly.length + 1)
    const root = GF_EXP[i]
    for (let j = 0; j < poly.length; j++) {
      next[j] ^= poly[j]
      next[j + 1] ^= gfMul(poly[j], root)
    }
    poly = next
  }
  return poly
}

function rsRemainder(data, ecLen) {
  const gen = rsGeneratorPoly(ecLen)
  const rem = new Uint8Array(ecLen)
  for (let i = 0; i < data.length; i++) {
    const factor = data[i] ^ rem[0]
    rem.copyWithin(0, 1)
    rem[ecLen - 1] = 0
    if (factor !== 0) {
      for (let j = 0; j < ecLen; j++) {
        rem[j] ^= gfMul(gen[j + 1], factor)
      }
    }
  }
  return rem
}

function pushBits(bits, value, length) {
  for (let i = length - 1; i >= 0; i--) {
    bits.push((value >>> i) & 1)
  }
}

function bchFormatBits(ecLevelBits, mask) {
  const data = (ecLevelBits << 3) | mask
  let rem = data << 10
  for (let i = 14; i >= 10; i--) {
    if ((rem >>> i) & 1) rem ^= 0x537 << (i - 10)
  }
  return ((data << 10) | rem) ^ 0x5412
}

function bchVersionBits(version) {
  let rem = version << 12
  for (let i = 17; i >= 12; i--) {
    if ((rem >>> i) & 1) rem ^= 0x1f25 << (i - 12)
  }
  return (version << 12) | rem
}

function maskBit(mask, r, c) {
  switch (mask) {
    case 0:
      return (r + c) % 2 === 0
    case 1:
      return r % 2 === 0
    case 2:
      return c % 3 === 0
    case 3:
      return (r + c) % 3 === 0
    case 4:
      return (Math.floor(r / 2) + Math.floor(c / 3)) % 2 === 0
    case 5:
      return ((r * c) % 2) + ((r * c) % 3) === 0
    case 6:
      return (((r * c) % 2) + ((r * c) % 3)) % 2 === 0
    default:
      return (((r + c) % 2) + ((r * c) % 3)) % 2 === 0
  }
}

function placeFormatBits(modules, isFunc, size, mask) {
  // Error Correction Level L = 01
  const bits = bchFormatBits(1, mask)
  for (let i = 0; i < 15; i++) {
    const bit = ((bits >>> i) & 1) === 1
    // Around top-left finder
    if (i < 6) modules[i][8] = bit
    else if (i < 8) modules[i + 1][8] = bit
    else if (i === 8) modules[8][7] = bit
    else modules[8][14 - i] = bit

    // Split between bottom-left and top-right finders
    if (i < 8) modules[8][size - 1 - i] = bit
    else modules[size - 15 + i][8] = bit
  }
  if (isFunc) {
    for (let i = 0; i < 9; i++) {
      if (i !== 6) {
        isFunc[8][i] = true
        isFunc[i][8] = true
      }
    }
    for (let i = 0; i < 8; i++) {
      isFunc[8][size - 1 - i] = true
      isFunc[size - 1 - i][8] = true
    }
  }
}

function qrPenaltyScore(modules, size) {
  let score = 0
  for (let r = 0; r < size; r++) {
    let runColor = modules[r][0]
    let runLen = 1
    for (let c = 1; c < size; c++) {
      if (modules[r][c] === runColor) {
        runLen++
        if (runLen === 5) score += 3
        else if (runLen > 5) score += 1
      } else {
        runColor = modules[r][c]
        runLen = 1
      }
    }
  }
  for (let c = 0; c < size; c++) {
    let runColor = modules[0][c]
    let runLen = 1
    for (let r = 1; r < size; r++) {
      if (modules[r][c] === runColor) {
        runLen++
        if (runLen === 5) score += 3
        else if (runLen > 5) score += 1
      } else {
        runColor = modules[r][c]
        runLen = 1
      }
    }
  }
  for (let r = 0; r < size - 1; r++) {
    for (let c = 0; c < size - 1; c++) {
      const color = modules[r][c]
      if (
        modules[r][c + 1] === color &&
        modules[r + 1][c] === color &&
        modules[r + 1][c + 1] === color
      ) {
        score += 3
      }
    }
  }
  return score
}

/**
 * Encodes an uppercased alphanumeric string (such as a BOLT11 invoice) into a
 * 2D boolean QR matrix using ISO/IEC 18004 Alphanumeric mode (Level L).
 */
function encodeQrMatrix(rawText) {
  const text = String(rawText || '').trim()
  if (!text) return null
  // ASCII only (BOLT11 is): one byte per character.
  const bytes = []
  for (let i = 0; i < text.length; i++) {
    const code = text.charCodeAt(i)
    if (code > 0x7e || code < 0x20) return null
    bytes.push(code)
  }

  let version = 0
  let layout = null
  for (let v = 1; v <= QR_MAX_VERSION; v++) {
    const candidate = qrBlockLayout(v)
    const countBits = v <= 9 ? 8 : 16
    if (4 + countBits + bytes.length * 8 <= candidate.totalDataCw * 8) {
      version = v
      layout = candidate
      break
    }
  }
  if (!layout) return null

  const { ecPerBlock, numBlocks, numShortBlocks, shortDataCw, totalDataCw } =
    layout
  const alignCoords = qrAlignmentCenters(version)
  const countBits = version <= 9 ? 8 : 16

  const bits = []
  pushBits(bits, 0b0100, 4)
  pushBits(bits, bytes.length, countBits)
  for (const byte of bytes) pushBits(bits, byte, 8)
  const maxDataBits = totalDataCw * 8
  const terminator = Math.min(4, maxDataBits - bits.length)
  pushBits(bits, 0, terminator)
  while (bits.length % 8 !== 0) bits.push(0)

  const dataCw = new Uint8Array(totalDataCw)
  let byteIdx = 0
  for (let i = 0; i < bits.length; i += 8) {
    let b = 0
    for (let j = 0; j < 8; j++) b = (b << 1) | bits[i + j]
    dataCw[byteIdx++] = b
  }
  let padToggle = true
  while (byteIdx < totalDataCw) {
    dataCw[byteIdx++] = padToggle ? 0xec : 0x11
    padToggle = !padToggle
  }

  const dataBlocks = []
  const ecBlocks = []
  let offset = 0
  for (let i = 0; i < numBlocks; i++) {
    const len = shortDataCw + (i < numShortBlocks ? 0 : 1)
    const block = dataCw.slice(offset, offset + len)
    offset += len
    dataBlocks.push(block)
    ecBlocks.push(rsRemainder(block, ecPerBlock))
  }

  const interleaved = []
  for (let col = 0; col <= shortDataCw; col++) {
    for (let b = 0; b < dataBlocks.length; b++) {
      if (col < dataBlocks[b].length) interleaved.push(dataBlocks[b][col])
    }
  }
  for (let col = 0; col < ecPerBlock; col++) {
    for (let b = 0; b < ecBlocks.length; b++) {
      interleaved.push(ecBlocks[b][col])
    }
  }

  const size = 17 + version * 4
  const modules = Array.from({ length: size }, () => Array(size).fill(false))
  const isFunc = Array.from({ length: size }, () => Array(size).fill(false))

  const placeFinder = (topR, leftC) => {
    for (let dr = -1; dr <= 7; dr++) {
      for (let dc = -1; dc <= 7; dc++) {
        const r = topR + dr
        const c = leftC + dc
        if (r < 0 || r >= size || c < 0 || c >= size) continue
        const inOuter = dr >= 0 && dr <= 6 && dc >= 0 && dc <= 6
        const onBorder = dr === 0 || dr === 6 || dc === 0 || dc === 6
        const inCenter = dr >= 2 && dr <= 4 && dc >= 2 && dc <= 4
        modules[r][c] = inOuter && (onBorder || inCenter)
        isFunc[r][c] = true
      }
    }
  }
  placeFinder(0, 0)
  placeFinder(0, size - 7)
  placeFinder(size - 7, 0)

  for (let i = 8; i < size - 8; i++) {
    modules[6][i] = i % 2 === 0
    isFunc[6][i] = true
    modules[i][6] = i % 2 === 0
    isFunc[i][6] = true
  }

  for (let i = 0; i < alignCoords.length; i++) {
    for (let j = 0; j < alignCoords.length; j++) {
      if (
        (i === 0 && j === 0) ||
        (i === 0 && j === alignCoords.length - 1) ||
        (i === alignCoords.length - 1 && j === 0)
      ) {
        continue
      }
      const cr = alignCoords[i]
      const cc = alignCoords[j]
      for (let dr = -2; dr <= 2; dr++) {
        for (let dc = -2; dc <= 2; dc++) {
          const dist = Math.max(Math.abs(dr), Math.abs(dc))
          modules[cr + dr][cc + dc] = dist !== 1
          isFunc[cr + dr][cc + dc] = true
        }
      }
    }
  }

  modules[4 * version + 9][8] = true
  isFunc[4 * version + 9][8] = true
  placeFormatBits(modules, isFunc, size, 0)

  if (version >= 7) {
    const vBits = bchVersionBits(version)
    for (let i = 0; i < 18; i++) {
      const bit = ((vBits >>> i) & 1) === 1
      const a = size - 11 + (i % 3)
      const b = Math.floor(i / 3)
      modules[a][b] = bit
      isFunc[a][b] = true
      modules[b][a] = bit
      isFunc[b][a] = true
    }
  }

  let bitOffset = 0
  const totalBits = interleaved.length * 8
  let upward = true
  for (let right = size - 1; right >= 1; right -= 2) {
    if (right === 6) right = 5
    for (let vert = 0; vert < size; vert++) {
      const r = upward ? size - 1 - vert : vert
      for (let j = 0; j < 2; j++) {
        const c = right - j
        if (!isFunc[r][c]) {
          let dark = false
          if (bitOffset < totalBits) {
            const cw = interleaved[bitOffset >>> 3]
            dark = ((cw >>> (7 - (bitOffset & 7))) & 1) === 1
            bitOffset++
          }
          modules[r][c] = dark
        }
      }
    }
    upward = !upward
  }

  let bestMask = 0
  let bestScore = Infinity
  let bestMatrix = null
  for (let m = 0; m < 8; m++) {
    const candidate = modules.map((row, r) =>
      row.map((val, c) => (!isFunc[r][c] && maskBit(m, r, c) ? !val : val)),
    )
    placeFormatBits(candidate, null, size, m)
    const score = qrPenaltyScore(candidate, size)
    if (score < bestScore) {
      bestScore = score
      bestMask = m
      bestMatrix = candidate
    }
  }
  placeFormatBits(bestMatrix, null, size, bestMask)
  return bestMatrix
}

/**
 * Builds a pure-DOM <svg> element for a BOLT11 Lightning invoice without
 * HTML string parsing or inline styles. Returns null if the invoice is invalid.
 */
function createInvoiceQrSvg(invoice) {
  if (typeof invoice !== 'string' || !BOLT11_RE.test(invoice.trim())) {
    return null
  }
  const matrix = encodeQrMatrix(invoice.trim())
  if (!matrix) return null

  const size = matrix.length
  const margin = 4
  const total = size + margin * 2
  const createEl = (tag) =>
    typeof document.createElementNS === 'function'
      ? document.createElementNS(SVG_NS, tag)
      : document.createElement(tag)

  const svg = createEl('svg')
  svg.setAttribute('viewBox', `0 0 ${total} ${total}`)
  svg.setAttribute('class', 'invoice-qr-svg')
  svg.setAttribute('aria-hidden', 'true')

  const bg = createEl('rect')
  bg.setAttribute('width', String(total))
  bg.setAttribute('height', String(total))
  bg.setAttribute('class', 'invoice-qr-bg')

  const parts = []
  for (let r = 0; r < size; r++) {
    for (let c = 0; c < size; c++) {
      if (matrix[r][c]) {
        parts.push(`M${c + margin},${r + margin}h1v1h-1z`)
      }
    }
  }
  const fg = createEl('path')
  fg.setAttribute('d', parts.join(''))
  fg.setAttribute('class', 'invoice-qr-fg')

  svg.append(bg, fg)
  return svg
}

// ─────────────────────────────────────────────
// Pure helpers (unit-tested in tests/web_dashboard.test.ts)
// ─────────────────────────────────────────────
function nodeLabel(id) {
  return NODE_LABELS[id] || 'your Lightning node'
}

function nodePackageId(id) {
  return NODE_PACKAGE_IDS[id] || 'lnd'
}

function listNodes(ids) {
  const labels = ids.map(nodeLabel)
  if (labels.length <= 1) return labels.join('')
  return `${labels.slice(0, -1).join(', ')} and ${labels[labels.length - 1]}`
}

function formatUsd(usd) {
  return `$${usd.toFixed(2)}`
}

function formatSats(sats) {
  if (typeof sats !== 'number' || !Number.isFinite(sats) || sats <= 0) {
    return 'Amount encoded in invoice'
  }
  return `${Math.round(sats).toLocaleString('en-US')} sats`
}

function formatTime(iso) {
  if (!iso) return null
  const date = new Date(iso)
  return Number.isNaN(date.getTime())
    ? null
    : date.toLocaleString(undefined, {
        dateStyle: 'medium',
        timeStyle: 'short',
      })
}

/** The day only, for estimates and reminders where the hour adds noise. */
function formatDate(iso) {
  if (!iso) return null
  const date = new Date(iso)
  return Number.isNaN(date.getTime())
    ? null
    : date.toLocaleDateString(undefined, { dateStyle: 'medium' })
}

function monthsLabel(months) {
  return `${months} month${months > 1 ? 's' : ''}`
}

function formatRemaining(ms) {
  if (ms <= 0) return 'Expired'
  const days = Math.floor(ms / DAY_MS)
  const hours = Math.floor((ms % DAY_MS) / 3600000)
  const minutes = Math.floor((ms % 3600000) / 60000)
  return days > 0 ? `${days}d ${hours}h` : `${hours}h ${minutes}m`
}

function bandwidthPercent(m) {
  const used = m && m.bandwidth ? m.bandwidth.usedGb : null
  const limit = m && m.bandwidth ? m.bandwidth.limitGb : null
  if (typeof used !== 'number' || typeof limit !== 'number' || limit <= 0) {
    return null
  }
  return Math.min(100, Math.max(0, (used / limit) * 100))
}

function isPaidPendingError(err) {
  if (!err) return false
  return /payment was received|renewal is paid|bandwidth reset was applied|bandwidth reset failed|claim|Provisioning failed|stored private key/i.test(
    String(err),
  )
}

function isPaymentReceived(pending) {
  if (!pending) return false
  return Boolean(
    pending.paymentReceived || isPaidPendingError(pending.lastError),
  )
}

function nextRetrySuffix(pending) {
  const at = pending && formatTime(pending.nextAttemptAt)
  return at ? ` Next try: ${at}.` : ''
}

function retryText(pending) {
  if (!pending || !pending.lastError) return ''
  return ` Last check failed: ${pending.lastError}${nextRetrySuffix(pending)}`
}

const INVOICE_KINDS = [
  { kind: 'order', title: 'Pay Subscription Invoice', label: 'Subscription' },
  { kind: 'renewal', title: 'Pay Renewal Invoice', label: 'Renewal' },
  {
    kind: 'reset',
    title: 'Pay Bandwidth Reset Invoice',
    label: 'Bandwidth reset',
  },
]

/**
 * Every unpaid BOLT11 invoice in m.pending, in a fixed order (subscription,
 * renewal, bandwidth reset). More than one can be payable at the same time,
 * for example a renewal and a bandwidth reset.
 */
function payableInvoices(m) {
  const pending = (m && m.pending) || {}
  const out = []
  for (const meta of INVOICE_KINDS) {
    const entry = pending[meta.kind]
    if (
      entry &&
      typeof entry.invoice === 'string' &&
      BOLT11_RE.test(entry.invoice) &&
      !isPaymentReceived(entry)
    ) {
      out.push({ kind: meta.kind, title: meta.title, label: meta.label, entry })
    }
  }
  return out
}

/**
 * The payable invoice the panel shows: the one the operator picked in the
 * invoice switcher while it is still payable, otherwise the first one.
 * Returns null when nothing is payable.
 */
function activePayableInvoice(m) {
  const all = payableInvoices(m)
  if (!all.length) return null
  return all.find((item) => item.kind === selectedInvoiceKind) || all[0]
}

/**
 * What needs the operator's attention, from the read model. Each notice
 * names the StartOS action or node task to use; none claims anything the
 * read model does not show.
 */
function buildNotices(m) {
  const notices = []
  if (!m) return notices
  const sub = m.subscription || {}
  const pending = m.pending || {}
  const handoff = m.handoff
  const target = nodeLabel(m.targetNode)

  if (pending.order) {
    if (isPaymentReceived(pending.order)) {
      notices.push({
        level: pending.order.lastError ? 'warning' : 'info',
        title: 'Tunnel provisioning pending',
        text: pending.order.lastError
          ? `${pending.order.lastError}${nextRetrySuffix(pending.order)}`
          : 'Payment received; TunnelSats is provisioning the tunnel and will save the configuration automatically.',
      })
    } else {
      const node = nodeLabel(pending.order.targetNode)
      notices.push({
        level: 'info',
        title: 'Payment pending',
        text: `If you have not paid yet, accept the Pay Invoice task on ${node}. Once paid, TunnelSats sets up the tunnel automatically.${retryText(pending.order)}`,
      })
    }
  }
  if (pending.renewal) {
    if (isPaymentReceived(pending.renewal)) {
      notices.push({
        level: pending.renewal.lastError ? 'warning' : 'info',
        title: 'Renewal confirmation pending',
        text: pending.renewal.lastError
          ? `${pending.renewal.lastError}${nextRetrySuffix(pending.renewal)}`
          : 'Payment received; waiting for TunnelSats to confirm the extended expiry.',
      })
    } else {
      const node = nodeLabel(pending.renewal.targetNode)
      notices.push({
        level: 'info',
        title: 'Renewal payment pending',
        text: `If you have not paid yet, accept the Pay Invoice task on ${node}. Once paid, the new expiry is confirmed automatically.${retryText(pending.renewal)}`,
      })
    }
  }
  if (pending.reset) {
    if (isPaymentReceived(pending.reset)) {
      const failed = /bandwidth reset failed/i.test(
        pending.reset.lastError || '',
      )
      notices.push({
        level: failed ? 'error' : pending.reset.lastError ? 'warning' : 'info',
        title: failed
          ? 'Bandwidth reset failed'
          : 'Bandwidth reset confirmation pending',
        text: pending.reset.lastError
          ? `${pending.reset.lastError}${failed ? '' : nextRetrySuffix(pending.reset)}`
          : 'Payment received; waiting for TunnelSats to apply the bandwidth reset.',
      })
    } else {
      const node = nodeLabel(pending.reset.targetNode)
      const expires = formatTime(pending.reset.expiresAt)
      notices.push({
        level: 'info',
        title: 'Bandwidth reset payment pending',
        text: `If you have not paid yet, accept the Pay Invoice task on ${node}; once paid, the reset is applied automatically.${expires ? ` The invoice expires ${expires}.` : ''}${retryText(pending.reset)}`,
      })
    }
  }

  if (handoff && handoff.pendingOff && handoff.pendingOff.length) {
    const nodes = listNodes(handoff.pendingOff)
    notices.push({
      level: 'warning',
      title: `Waiting for ${nodes} to turn off the tunnel`,
      text: `Accept the TunnelSats task on ${nodes} that turns its clearnet VPN off. ${target} is asked to take over afterwards.`,
    })
  }
  if (handoff && handoff.unraised && handoff.unraised.length) {
    notices.push({
      level: 'warning',
      title: `A task could not be raised on ${listNodes(handoff.unraised)}`,
      text: 'TunnelSats retries automatically. Check that the node is installed and running.',
    })
  }

  if (m.configured && !m.enabled) {
    notices.push({
      level: 'warning',
      title: 'TunnelSats is switched off',
      text: 'Turn it on again with the Configure action.',
    })
  }

  if (m.configured && m.enabled) {
    if (sub.keyUnknown) {
      notices.push({
        level: 'error',
        title: 'Key unknown to TunnelSats',
        text: 'TunnelSats has no subscription for the WireGuard key in this configuration. Run Import Subscription with a valid configuration, or Buy Subscription.',
      })
    } else if (m.status === 'expired') {
      notices.push({
        level: 'error',
        title: 'Subscription expired',
        text: 'Run Renew Subscription. Until then, TunnelSats has disabled the tunnel on its server, so clearnet peer connections through it stop.',
      })
    } else if (m.status === 'sync_error') {
      notices.push({
        level: 'warning',
        title: 'Subscription not confirmed',
        text: sub.syncError
          ? `TunnelSats could not confirm the subscription: ${sub.syncError}`
          : 'TunnelSats could not confirm the subscription yet; checking again.',
      })
    } else if (m.status === 'pending_sync') {
      notices.push({
        level: 'info',
        title: 'Checking the subscription',
        text: 'Waiting for TunnelSats to confirm the subscription for this key.',
      })
    } else if (
      sub.active &&
      typeof sub.daysRemaining === 'number' &&
      sub.daysRemaining < 7 &&
      !pending.renewal &&
      !(
        m.nwc &&
        m.nwc.connected &&
        !m.nwc.restoreReconnectNeeded &&
        !m.nwc.budgetWarning &&
        !m.nwc.fallbackTaskRaised
      )
    ) {
      notices.push({
        level: 'warning',
        title:
          sub.daysRemaining < 1
            ? 'Subscription ends within a day'
            : `Subscription ends in ${sub.daysRemaining} day${sub.daysRemaining === 1 ? '' : 's'}`,
        text: 'Run Renew Subscription to extend it.',
      })
    }

    const pct = bandwidthPercent(m)
    if (pct !== null && pct >= BANDWIDTH_WARN_PCT && !pending.reset) {
      notices.push({
        level: pct >= BANDWIDTH_CRITICAL_PCT ? 'warning' : 'info',
        title: `${Math.floor(pct)}% of this month's bandwidth used`,
        text: 'Run Reset Bandwidth to reset the counter early, or wait for the reset on the 1st.',
      })
    }
  }

  if (m.nwc && m.nwc.connected) {
    if (m.nwc.restoreReconnectNeeded) {
      notices.push({
        level: 'warning',
        title: 'NWC wallet reconnect needed',
        text: 'NWC wallet credentials are not included in StartOS backups. Run Services → TunnelSats → Actions → Connect Wallet to re-enter your NWC URI.',
      })
    } else if (m.nwc.budgetWarning) {
      notices.push({
        level: 'warning',
        title: 'NWC auto-renewal budget exceeded',
        text: 'Your NWC wallet budget or balance was below the renewal invoice. Accept the Pay Invoice task on your node or increase your NWC budget in Connect Wallet.',
      })
    } else if (m.nwc.fallbackTaskRaised) {
      notices.push({
        level: 'warning',
        title: 'NWC auto-renewal fell back to manual payment',
        text: 'Automatic renewal via NWC could not complete. Accept the Pay Invoice task on your node or check Connect Wallet.',
      })
    }
  }

  if (m.connection && m.connection.allowIpv6) {
    notices.push({
      level: 'info',
      title: 'Allow IPv6 Endpoint is on',
      text: 'TunnelSats may hand your node an IPv6 server endpoint to announce. How your node routes its own IPv6 traffic is decided by the Lightning node package.',
    })
  }
  return notices
}

/** Read-only NWC auto-renewal status badge and 1.2x budget note. */
function nwcStatusView(m) {
  const nwc = m && m.nwc
  if (!nwc || !nwc.connected) {
    return {
      cls: 'neutral',
      badge: 'Off',
      note: 'Optional: connect a wallet in Services → TunnelSats → Actions → Connect Wallet to renew automatically.',
    }
  }
  const rec =
    typeof nwc.recommendedBudgetSats === 'number'
      ? formatSats(nwc.recommendedBudgetSats)
      : '5,400 sats'
  const annual =
    typeof nwc.recommendedAnnualSats === 'number'
      ? formatSats(nwc.recommendedAnnualSats)
      : '64,800 sats'
  if (nwc.restoreReconnectNeeded) {
    return {
      cls: 'alert',
      badge: 'Reconnect needed',
      note: 'Wallet credentials are not part of backups. Re-enter the NWC URI in Services → TunnelSats → Actions → Connect Wallet.',
    }
  }
  if (nwc.budgetWarning) {
    return {
      cls: 'alert',
      badge: 'Budget too low',
      note: `${nwc.lastError ? `${nwc.lastError} ` : ''}Raise the wallet budget to at least ${rec} per renewal, or accept the Pay Invoice task.`,
    }
  }
  if (nwc.fallbackTaskRaised) {
    return {
      cls: 'alert',
      badge: 'Manual fallback',
      note: `${nwc.lastError ? `${nwc.lastError} ` : ''}Accept the Pay Invoice task on your node, or check Connect Wallet.`,
    }
  }
  const relay = nwc.relayHost || 'connected'
  const dur = nwc.resolvedDuration || '1m'
  return {
    cls: 'active',
    badge: nwc.routeViaTor ? 'On · Tor' : 'On',
    note: `Relay ${relay} · ${dur} plan · wallet budget at least ${rec} per renewal (about ${annual} a year, 1.2× buffer).`,
  }
}

/** The StartOS actions that fit the current state (highlighted in the list). */
function suggestedActions(m) {
  const suggested = []
  if (!m) return suggested
  const sub = m.subscription || {}
  const pending = m.pending || {}
  if (!m.configured) {
    if (!pending.order) suggested.push('buy', 'import')
    return suggested
  }
  if (!m.enabled) return ['configure']
  if (sub.keyUnknown) return ['import', 'buy']
  const nwcHealthy = Boolean(
    m.nwc &&
    m.nwc.connected &&
    !m.nwc.restoreReconnectNeeded &&
    !m.nwc.budgetWarning &&
    !m.nwc.fallbackTaskRaised,
  )
  if (
    !pending.renewal &&
    (m.status === 'expired' ||
      (!nwcHealthy &&
        sub.active &&
        typeof sub.daysRemaining === 'number' &&
        sub.daysRemaining < 7))
  ) {
    suggested.push('renew')
  }
  if (
    m.nwc &&
    m.nwc.connected &&
    (m.nwc.restoreReconnectNeeded ||
      m.nwc.budgetWarning ||
      m.nwc.fallbackTaskRaised)
  ) {
    suggested.push('connect-wallet')
  }
  const pct = bandwidthPercent(m)
  if (pct !== null && pct >= BANDWIDTH_WARN_PCT && !pending.reset) {
    suggested.push('reset')
  }
  return suggested
}

/** Routing handoff state in words; never claims the tunnel is up. */
function handoffText(m) {
  const handoff = m && m.handoff
  if (!handoff) return 'No task raised yet'
  if (handoff.pendingOff && handoff.pendingOff.length) {
    return `Waiting for ${listNodes(handoff.pendingOff)} to turn off`
  }
  if (handoff.unraised && handoff.unraised.length) {
    return `Retrying task on ${listNodes(handoff.unraised)}`
  }
  if (handoff.activeTarget) {
    return `Task raised on ${nodeLabel(handoff.activeTarget)}`
  }
  return 'No task raised yet'
}

function badgeState(m, failed) {
  if (failed) return { cls: 'neutral', text: 'Status unavailable' }
  if (!m) return { cls: 'neutral', text: 'Loading…' }
  if (!m.configured) {
    if (m.pending && m.pending.order) {
      return isPaymentReceived(m.pending.order)
        ? { cls: 'pending', text: 'Provisioning tunnel' }
        : { cls: 'pending', text: 'Payment pending' }
    }
    return { cls: 'neutral', text: 'Not set up' }
  }
  if (!m.enabled) return { cls: 'neutral', text: 'Switched off' }
  switch (m.status) {
    case 'running':
      return { cls: 'active', text: 'Subscription active' }
    case 'expired':
      return { cls: 'alert', text: 'Subscription expired' }
    case 'unknown_key':
      return { cls: 'alert', text: 'Key unknown' }
    case 'sync_error':
      return { cls: 'pending', text: 'Not confirmed' }
    default:
      return { cls: 'pending', text: 'Checking…' }
  }
}

/**
 * Linear projection of this month's usage to the end of the UTC month.
 * null without a usage figure; projectedGb is null during the first day of
 * the month, when a projection says little, and after a paid reset this
 * month: the counter restarted at a time the dashboard does not know, so
 * dividing by the time since the 1st would understate the pace.
 */
function monthPace(m, nowMs = Date.now()) {
  const bw = (m && m.bandwidth) || {}
  const used = bw.usedGb
  const limit = bw.limitGb
  if (typeof used !== 'number' || !Number.isFinite(used) || used < 0) {
    return null
  }
  if (typeof limit !== 'number' || !Number.isFinite(limit) || limit <= 0) {
    return null
  }
  const now = new Date(nowMs)
  const start = Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), 1)
  const end = Date.UTC(now.getUTCFullYear(), now.getUTCMonth() + 1, 1)
  const elapsed = nowMs - start
  const afterReset =
    Number.isInteger(bw.resetsThisMonth) && bw.resetsThisMonth > 0
  const projectedGb =
    !afterReset && elapsed >= DAY_MS ? (used * (end - start)) / elapsed : null
  return {
    usedGb: used,
    limitGb: limit,
    projectedGb,
    afterReset,
    exceedsLimit: projectedGb !== null && projectedGb > limit,
    resetsAt: new Date(end).toISOString(),
  }
}

function paceText(pace) {
  if (!pace) return 'Usage for this month is not known yet.'
  const resets = new Date(pace.resetsAt).toLocaleDateString(undefined, {
    timeZone: 'UTC',
  })
  if (pace.afterReset) {
    return `${pace.usedGb.toFixed(2)} GB since this month's paid reset. No projection: the reset time is not known. The counter resets on ${resets} (UTC).`
  }
  if (pace.projectedGb === null) {
    return `Too early in the month for a projection (${pace.usedGb.toFixed(2)} GB so far). The counter resets on ${resets} (UTC).`
  }
  const projected = Math.round(pace.projectedGb)
  return pace.exceedsLimit
    ? `At this pace: about ${projected} GB by the end of the month, above the ${pace.limitGb} GB allowance. The counter resets on ${resets} (UTC).`
    : `At this pace: about ${projected} GB of ${pace.limitGb} GB by the end of the month. The counter resets on ${resets} (UTC).`
}

/** Resets used this month as text, from the confirmed quota. */
function resetsText(m) {
  const bw = (m && m.bandwidth) || {}
  const max = Number.isInteger(bw.maxResetsPerMonth)
    ? bw.maxResetsPerMonth
    : null
  const used = Number.isInteger(bw.resetsThisMonth) ? bw.resetsThisMonth : null
  if (max === null) return 'Unknown'
  return `${used === null ? '?' : used} of ${max}`
}

/**
 * Whether a paid bandwidth reset looks possible from the confirmed numbers.
 * Only a hint: TunnelSats decides when the reset is requested (its usage
 * threshold is configurable; resetThresholdPct is its default).
 */
function resetEligibility(m) {
  if (!m || !m.configured || (m.subscription && m.subscription.keyUnknown)) {
    return {
      state: 'unavailable',
      text: 'Needs a subscription confirmed for this configuration.',
    }
  }
  if (m.pending && m.pending.reset) {
    return { state: 'pending', text: 'A bandwidth reset is in progress.' }
  }
  const bw = m.bandwidth || {}
  const max = Number.isInteger(bw.maxResetsPerMonth)
    ? bw.maxResetsPerMonth
    : null
  const used = Number.isInteger(bw.resetsThisMonth) ? bw.resetsThisMonth : null
  if (max !== null && used !== null && used >= max) {
    return {
      state: 'quota-used',
      text:
        max === 0
          ? 'Paid resets are not offered for this subscription.'
          : `All ${max} resets for this month are used; usage resets on the 1st (UTC).`,
    }
  }
  const pct = bandwidthPercent(m)
  if (pct === null) {
    return { state: 'unknown', text: 'Usage for this month is not known yet.' }
  }
  const threshold =
    typeof bw.resetThresholdPct === 'number'
      ? bw.resetThresholdPct
      : BANDWIDTH_WARN_PCT
  if (pct < threshold) {
    return {
      state: 'below-threshold',
      text: `Available from about ${threshold}% usage (${Math.floor(pct)}% used). TunnelSats decides when you request it.`,
    }
  }
  if (max !== null && used !== null) {
    return {
      state: 'eligible',
      text: `Looks eligible: ${max - used} of ${max} resets left this month. TunnelSats confirms when you request it.`,
    }
  }
  return {
    state: 'likely',
    text: `Looks eligible (${Math.floor(pct)}% used). TunnelSats confirms when you request it.`,
  }
}

/**
 * The expiry TunnelSats confirmed for this configuration, in ms; null
 * otherwise. An unlinked subscription can still carry the configuration's
 * "# Valid Until" hint as expiresAt, but that date is not confirmed, so the
 * timeline and the renewal preview never build on it.
 */
function expiryMs(m) {
  const sub = m && m.subscription
  if (!sub || sub.linked !== true || sub.keyUnknown) return null
  const ms = sub.expiresAt ? Date.parse(sub.expiresAt) : NaN
  return Number.isFinite(ms) ? ms : null
}

/**
 * The renewal timeline: a window ending at the confirmed expiry (at least 30
 * days, longer when more time is left), with the reminder markers 7 and 3
 * days before it. Positions are percentages of the window. null without a
 * confirmed expiry.
 */
function subscriptionTimeline(m, nowMs = Date.now()) {
  const end = expiryMs(m)
  if (end === null) return null
  const remainingMs = end - nowMs
  const windowMs = Math.max(TIMELINE_MIN_WINDOW_MS, remainingMs)
  const start = end - windowMs
  const pct = (ms) =>
    Math.min(100, Math.max(0, ((ms - start) / windowMs) * 100))
  const markers = REMINDER_MARKERS.map((marker) => {
    const at = end - marker.days * DAY_MS
    return {
      kind: marker.kind,
      label: marker.label,
      at: new Date(at).toISOString(),
      pct: pct(at),
      passed: nowMs >= at,
    }
  })
  let phase = 'ok'
  if (remainingMs <= 0) phase = 'expired'
  else if (remainingMs <= 3 * DAY_MS) phase = '3d'
  else if (remainingMs <= 7 * DAY_MS) phase = '7d'
  return {
    startAt: new Date(start).toISOString(),
    expiresAt: new Date(end).toISOString(),
    nowPct: pct(nowMs),
    remainingMs,
    phase,
    markers,
  }
}

const TIMELINE_PHASE_TEXT = Object.freeze({
  ok: 'On track',
  '7d': 'Renew soon',
  '3d': 'Renew now',
  expired: 'Expired',
})

/**
 * The expiry each plan would give: TunnelSats adds calendar months to the
 * later of the current expiry and the time of the renewal. An estimate; the
 * renewal invoice carries the exact date.
 *
 * Deliberately the same arithmetic as TunnelSats (JavaScript setMonth),
 * including its month-end rollover: January 31 plus one month is March 3
 * (March 2 in leap years), not the end of February. Clamping here would
 * show a date TunnelSats does not grant.
 */
function renewPreview(m, nowMs = Date.now()) {
  const end = expiryMs(m)
  if (end === null) return []
  const base = Math.max(end, nowMs)
  return usablePlans(m).map((plan) => {
    const next = new Date(base)
    next.setUTCMonth(next.getUTCMonth() + plan.months)
    return {
      duration: `${plan.months}m`,
      months: plan.months,
      usd: plan.usd,
      newExpiry: next.toISOString(),
    }
  })
}

const FLOW_KINDS = Object.freeze([
  Object.freeze({
    kind: 'buy',
    pendingKey: 'order',
    title: 'New subscription',
    done: 'Tunnel configured',
    working: 'Payment received; TunnelSats is provisioning the tunnel.',
  }),
  Object.freeze({
    kind: 'renew',
    pendingKey: 'renewal',
    title: 'Renewal',
    done: 'Expiry extended',
    working:
      'Payment received; waiting for TunnelSats to confirm the new expiry.',
  }),
  Object.freeze({
    kind: 'reset',
    pendingKey: 'reset',
    title: 'Bandwidth reset',
    done: 'Counter reset',
    working: 'Payment received; waiting for TunnelSats to apply the reset.',
  }),
])

function flowStepList(labels, current) {
  return labels.map((label, i) => ({
    label,
    state: i < current ? 'done' : i === current ? 'current' : 'todo',
  }))
}

/**
 * The in-flight flows as steps (requested → invoice → paid → done), plus the
 * node handoff while a node still has to turn its tunnel off. Built only
 * from what the read model shows; a flow whose last step completed is gone
 * from the model and therefore from this list.
 */
function flowSteps(m) {
  const flows = []
  if (!m) return flows
  const intents = m.intents || {}
  const pending = m.pending || {}
  for (const def of FLOW_KINDS) {
    const intent = intents[def.kind]
    const intentActive = Boolean(
      intent && (intent.status === 'pending' || intent.status === 'processing'),
    )
    const entry = pending[def.pendingKey]
    if (!entry && !intentActive) continue
    const node = nodeLabel((entry && entry.targetNode) || m.targetNode)
    let current
    let detail
    if (!entry) {
      current = 1
      detail = `Requesting the invoice from TunnelSats and raising the Pay Invoice task on ${node}…`
    } else if (!isPaymentReceived(entry)) {
      current = 2
      detail = `Accept the Pay Invoice task on ${node}, or pay the same invoice shown here.`
    } else {
      current = 3
      detail = def.working
    }
    flows.push({
      kind: def.kind,
      title: def.title,
      detail,
      steps: flowStepList(
        ['Request sent', 'Invoice', 'Payment', def.done],
        current,
      ),
    })
  }
  const handoff = m.handoff
  if (
    handoff &&
    Array.isArray(handoff.pendingOff) &&
    handoff.pendingOff.length
  ) {
    const old = listNodes(handoff.pendingOff)
    const target = nodeLabel(m.targetNode)
    flows.push({
      kind: 'handoff',
      title: 'Node handoff',
      detail: `Accept the TunnelSats task on ${old} that turns its clearnet VPN off; ${target} is asked to take over afterwards.`,
      steps: flowStepList(
        [
          'Configuration saved',
          `Waiting for ${old} to turn off`,
          `${target} takes over`,
        ],
        1,
      ),
    })
  }
  return flows
}

/** Server ids the bridge accepts (bridge.py _SERVER_ID_RE). */
const SERVER_ID_RE = /^[A-Za-z0-9_-]{2,32}$/

function serverLabel(server) {
  const parts = [server.city, server.country].filter(
    (part) => typeof part === 'string' && part.trim(),
  )
  return parts.length ? parts.join(', ') : server.id
}

/** The usable entries of a GET /api/servers answer. */
function usableServers(data) {
  const list = data && Array.isArray(data.servers) ? data.servers : []
  const seen = new Set()
  return list.filter((server) => {
    if (!server || typeof server.id !== 'string') return false
    if (!SERVER_ID_RE.test(server.id) || seen.has(server.id)) return false
    seen.add(server.id)
    return true
  })
}

function isValidNodePubkey(value) {
  return typeof value === 'string' && NODE_PUBKEY_RE.test(value.trim())
}

/** The reachability answer in words; never claims more than inbound. */
function reachabilityText(result) {
  if (!result) return ''
  if (result.kind === 'error') return result.text
  const where =
    result.host && result.port
      ? `${result.host}:${result.port}`
      : 'the forwarded port'
  if (result.success) {
    const ms =
      typeof result.latencyMs === 'number'
        ? ` in ${Math.round(result.latencyMs)} ms`
        : ''
    return `Inbound OK: TunnelSats reached your node through ${where}${ms}. This does not show that outbound traffic uses the tunnel.`
  }
  return `Inbound check failed through ${where}: ${result.error || 'no answer'}.`
}

// ─────────────────────────────────────────────
// Rendering (textContent / createElementNS only: values from the read model
// are never parsed as HTML)
// ─────────────────────────────────────────────
function byId(id) {
  return document.getElementById(id)
}

function setText(id, text) {
  const el = byId(id)
  if (el) el.textContent = text
}

/**
 * Sets a native <progress> or <meter>: max first, so the value is never
 * clamped to a previous max. Attributes, not inline styles (strict CSP).
 */
function setGauge(id, value, max, levels) {
  const el = byId(id)
  if (!el) return
  el.max = max
  if (levels) {
    el.low = levels.low
    el.high = levels.high
    el.optimum = 0
  }
  el.value = Math.min(max, Math.max(0, value))
}

function svgEl(tag, attrs) {
  const el = document.createElementNS(SVG_NS, tag)
  for (const [name, value] of Object.entries(attrs)) {
    el.setAttribute(name, String(value))
  }
  return el
}

function usablePlans(m) {
  return m &&
    Array.isArray(m.plans) &&
    m.plans.length &&
    m.plans.every(
      (p) => p && typeof p.usd === 'number' && typeof p.months === 'number',
    )
    ? m.plans
    : PLAN_PRICES_USD
}

/**
 * Fills a group of toggle buttons (plan cards, duration pills, server cards)
 * and marks the selected one. render() runs on every poll (every 3 s while a
 * payment is pending) and a detached button drops keyboard focus to <body>,
 * so the buttons are rebuilt only when the options change (`key`) and the
 * pressed state is updated in place. After a rebuild, focus returns to the
 * button with the same value.
 */
function renderToggleGroup(group, key, buildItems, valueAttr, selectedValue) {
  if (group.getAttribute('data-key') !== key) {
    const active = document.activeElement
    const focused =
      active && group.contains(active) ? active.closest(`[${valueAttr}]`) : null
    const focusedValue = focused ? focused.getAttribute(valueAttr) : null
    group.replaceChildren(...buildItems())
    group.setAttribute('data-key', key)
    if (focusedValue !== null) {
      for (const button of group.querySelectorAll(`[${valueAttr}]`)) {
        if (button.getAttribute(valueAttr) === focusedValue) {
          button.focus({ preventScroll: true })
          break
        }
      }
    }
  }
  for (const button of group.querySelectorAll(`[${valueAttr}]`)) {
    const on = button.getAttribute(valueAttr) === selectedValue
    button.setAttribute('aria-pressed', on ? 'true' : 'false')
    button.classList.toggle('is-selected', on)
  }
}

/** What a plan button shows: rebuild the plan groups only when this changes. */
function plansKey(plans) {
  return JSON.stringify(
    plans.map((plan) => [plan.months, plan.usd, plan.discountPct]),
  )
}

function buildPlanCard(plan) {
  const li = document.createElement('li')
  const card = document.createElement('button')
  card.setAttribute('type', 'button')
  card.className = 'plan-card'
  card.setAttribute('data-plan-duration', `${plan.months}m`)
  const duration = document.createElement('span')
  duration.className = 'plan-duration'
  duration.textContent = monthsLabel(plan.months)
  const price = document.createElement('span')
  price.className = 'plan-price'
  price.textContent = formatUsd(plan.usd)
  const perMonth = document.createElement('span')
  perMonth.className = 'plan-per-mo'
  perMonth.textContent =
    plan.discountPct > 0
      ? `${formatUsd(plan.usd / plan.months)}/mo · save ${plan.discountPct}%`
      : `${formatUsd(plan.usd)}/mo`
  card.append(duration, price, perMonth)
  li.append(card)
  return li
}

function buildDurationPill(plan, valueAttr) {
  const btn = document.createElement('button')
  btn.setAttribute('type', 'button')
  btn.className = 'duration-pill'
  btn.setAttribute(valueAttr, `${plan.months}m`)
  const durSpan = document.createElement('span')
  durSpan.className = 'pill-dur'
  durSpan.textContent = `${plan.months} mo`
  const priceSpan = document.createElement('span')
  priceSpan.className = 'pill-price'
  priceSpan.textContent = formatUsd(plan.usd)
  btn.append(durSpan, priceSpan)
  if (plan.discountPct > 0) {
    const badge = document.createElement('span')
    badge.className = 'pill-save'
    badge.textContent = `-${plan.discountPct}%`
    btn.append(badge)
  }
  return btn
}

function renderPlans(m) {
  const list = byId('plan-list')
  const plans = usablePlans(m)
  if (list) {
    renderToggleGroup(
      list,
      plansKey(plans),
      () => plans.map(buildPlanCard),
      'data-plan-duration',
      selectedBuyDuration,
    )
  }
  const chosen = plans.find((plan) => `${plan.months}m` === selectedBuyDuration)
  setText(
    'buy-cta-label',
    chosen
      ? `Buy ${monthsLabel(chosen.months)} · ${formatUsd(chosen.usd)}`
      : 'Buy subscription',
  )
  renderRenewPills(m)
}

function renderRenewPills(m) {
  const plans = usablePlans(m)
  const renewGroup = byId('renew-pills')
  if (renewGroup) {
    renderToggleGroup(
      renewGroup,
      plansKey(plans),
      () => plans.map((plan) => buildDurationPill(plan, 'data-renew-duration')),
      'data-renew-duration',
      selectedRenewDuration,
    )
  }
  const manageGroup = byId('manage-duration-pills')
  if (manageGroup) {
    renderToggleGroup(
      manageGroup,
      plansKey(plans),
      () => plans.map((plan) => buildDurationPill(plan, 'data-plan-duration')),
      'data-plan-duration',
      selectedBuyDuration,
    )
  }
}

function selectBuyDuration(dur) {
  if (!VALID_DURATIONS.includes(dur)) return
  selectedBuyDuration = dur
  for (const id of ['buy-duration-select', 'manage-buy-duration-select']) {
    const select = byId(id)
    if (select) select.value = dur
  }
  renderPlans(model)
}

function selectRenewDuration(dur) {
  if (!VALID_DURATIONS.includes(dur)) return
  selectedRenewDuration = dur
  const select = byId('renew-duration-select')
  if (select) select.value = dur
  renderRenewPills(model)
  renderRenewSummary(model)
}

/**
 * One toggle button per payable invoice when more than one is waiting.
 * Buttons are rebuilt only when the set of invoices changes, so a poll does
 * not steal keyboard focus from them.
 */
function renderInvoiceSwitcher(all, active) {
  const switcher = byId('invoice-switcher')
  if (!switcher) return
  if (all.length < 2) {
    switcher.hidden = true
    switcher.replaceChildren()
    switcher.setAttribute('data-key', '')
    return
  }
  const labels = all.map(
    (item) => `${item.label} · ${formatSats(item.entry.amountSats)}`,
  )
  const key = all.map((item, i) => `${item.kind}:${labels[i]}`).join('|')
  if (switcher.getAttribute('data-key') !== key) {
    const buttons = all.map((item, i) => {
      const button = document.createElement('button')
      button.setAttribute('type', 'button')
      button.className = 'invoice-switch'
      button.setAttribute('data-invoice-kind', item.kind)
      button.textContent = labels[i]
      return button
    })
    switcher.replaceChildren(...buttons)
    switcher.setAttribute('data-key', key)
  }
  for (const button of switcher.children) {
    const on = button.getAttribute('data-invoice-kind') === active.kind
    button.setAttribute('aria-pressed', on ? 'true' : 'false')
  }
  switcher.hidden = false
}

function renderInvoicePanel(m) {
  const panel = byId('invoice-panel')
  const qrBox = byId('invoice-qr')
  if (!panel || !qrBox) return
  const all = payableInvoices(m)
  const active = activePayableInvoice(m)
  renderInvoiceSwitcher(all, active)
  if (!active) {
    panel.hidden = true
    qrBox.replaceChildren()
    lastRenderedInvoice = null
    return
  }

  const entry = active.entry
  const nodeName = nodeLabel(entry.targetNode || (m && m.targetNode))
  panel.hidden = false
  setText('invoice-title', active.title)
  setText(
    'invoice-framing',
    `A Pay Invoice task has been raised on ${nodeName}. Accept it in StartOS, or scan/copy the same invoice below.${all.length > 1 ? ` ${all.length} invoices are waiting for payment.` : ''}`,
  )
  setText('invoice-amount', formatSats(entry.amountSats))
  const expiresFormatted = formatTime(entry.expiresAt)
  setText(
    'invoice-expiry',
    expiresFormatted ? `Expires ${expiresFormatted}` : 'Awaiting payment',
  )
  const invEl = byId('val-invoice')
  if (invEl) {
    invEl.textContent = entry.invoice
    invEl.title = entry.invoice
  }
  if (lastRenderedInvoice !== entry.invoice) {
    const svg = createInvoiceQrSvg(entry.invoice)
    if (svg) {
      qrBox.replaceChildren(svg)
      qrBox.setAttribute('aria-label', 'Lightning invoice QR code')
    } else {
      // Longer than a QR code can hold (version 40, level L): say so rather
      // than leave an empty box; the Pay Invoice task and Copy still work.
      const text =
        'This invoice is too long for a QR code. Accept the Pay Invoice task or copy the invoice instead.'
      const note = document.createElement('p')
      note.className = 'invoice-qr-fallback'
      note.textContent = text
      qrBox.replaceChildren(note)
      qrBox.setAttribute('aria-label', text)
    }
    lastRenderedInvoice = entry.invoice
  }
}

/** Shows the chosen payable invoice; unknown or unpayable kinds are ignored. */
function selectInvoice(kind) {
  if (!payableInvoices(model).some((item) => item.kind === kind)) return
  selectedInvoiceKind = kind
  renderInvoicePanel(model)
}

function activeIntentMessage(m) {
  const intents = (m && m.intents) || {}
  const target = nodeLabel(m && m.targetNode)
  for (const kind of ['buy', 'renew', 'reset']) {
    const slot = intents[kind]
    if (slot && (slot.status === 'pending' || slot.status === 'processing')) {
      return {
        level: 'info',
        text: `Requesting Lightning invoice from TunnelSats and raising the Pay Invoice task on ${target}…`,
      }
    }
  }
  if (localIntentFeedback) return localIntentFeedback
  const failure = latestIntentFailure(m)
  if (failure) return { level: 'error', text: failure.error }
  return null
}

/** The m.pending invoice kind each dashboard request kind produces. */
const INTENT_INVOICE_KIND = { buy: 'order', renew: 'renewal', reset: 'reset' }

/**
 * The most recent failed dashboard request. A failure is left out only when
 * a payable invoice of the same kind was created after it (a later request
 * of that kind produced it); an invoice of another kind never hides it, so
 * a refused or failed request stays explained next to any invoice.
 */
function latestIntentFailure(m) {
  const intents = (m && m.intents) || {}
  const invoiceMsByKind = {}
  for (const item of payableInvoices(m)) {
    const ms = Date.parse(item.entry.createdAt)
    if (Number.isFinite(ms)) invoiceMsByKind[item.kind] = ms
  }
  let latest = null
  let latestMs = -Infinity
  for (const kind of ['buy', 'renew', 'reset']) {
    const slot = intents[kind]
    if (!slot || slot.status !== 'failed' || !slot.error) continue
    const ms = Date.parse(slot.updatedAt || slot.createdAt)
    const when = Number.isFinite(ms) ? ms : -Infinity
    const supersededAt = invoiceMsByKind[INTENT_INVOICE_KIND[kind]]
    if (supersededAt !== undefined && when < supersededAt) continue
    if (!latest || when > latestMs) {
      latest = slot
      latestMs = when
    }
  }
  return latest
}

function renderIntentFeedback(m) {
  const el = byId('intent-feedback')
  if (!el) return
  const msg = activeIntentMessage(m)
  if (!msg) {
    el.hidden = true
    el.textContent = ''
    el.classList.remove('is-error', 'is-success')
    return
  }
  el.hidden = false
  el.textContent = msg.text
  el.classList.toggle('is-error', msg.level === 'error')
  el.classList.toggle('is-success', msg.level === 'success')
}

function renderIntentControls(m) {
  const intents = (m && m.intents) || {}
  const anyInFlight =
    submittingIntent ||
    ['buy', 'renew', 'reset'].some(
      (k) =>
        intents[k] &&
        (intents[k].status === 'pending' || intents[k].status === 'processing'),
    )
  const canRenewOrReset = Boolean(
    m && m.configured && !(m.subscription && m.subscription.keyUnknown),
  )

  const buyBtn = byId('btn-intent-buy')
  if (buyBtn) buyBtn.disabled = anyInFlight
  const manageBuyBtn = byId('btn-manage-buy')
  if (manageBuyBtn) manageBuyBtn.disabled = anyInFlight
  const renewBtn = byId('btn-intent-renew')
  if (renewBtn) renewBtn.disabled = anyInFlight || !canRenewOrReset
  const renewSelect = byId('renew-duration-select')
  if (renewSelect) renewSelect.disabled = anyInFlight || !canRenewOrReset
  const resetBtn = byId('btn-intent-reset')
  if (resetBtn) resetBtn.disabled = anyInFlight || !canRenewOrReset
}

function renderNotices(m) {
  const section = byId('notices')
  const list = byId('notice-list')
  if (!section || !list) return
  const items = buildNotices(m).map((notice) => {
    const li = document.createElement('li')
    li.className = `notice-item notice-${notice.level}`
    const title = document.createElement('strong')
    title.className = 'notice-title'
    title.textContent = notice.title
    const text = document.createElement('span')
    text.className = 'notice-text'
    text.textContent = notice.text
    li.append(title, text)
    return li
  })
  list.replaceChildren(...items)
  section.hidden = items.length === 0
}

function renderBadge() {
  const badge = byId('status-badge')
  const state = badgeState(model, loadFailed)
  if (badge) badge.className = `status-badge ${state.cls}`
  setText('status-text', state.text)
}

function renderActions(m) {
  const suggested = suggestedActions(m)
  for (const id of [
    'buy',
    'renew',
    'reset',
    'connect-wallet',
    'import',
    'configure',
    'export',
  ]) {
    const item = byId(`action-${id}`)
    if (item) item.classList.toggle('is-suggested', suggested.includes(id))
  }
}

function renderNwcStatus(m) {
  const view = nwcStatusView(m)
  const badge = byId('nwc-badge')
  if (badge) {
    badge.className = `nwc-badge ${view.cls}`
    badge.textContent = view.badge
  }
  setText('nwc-budget-note', view.note)
}

function renderCountdown() {
  const sub = model && model.subscription
  const expiresAt = sub ? sub.expiresAt : null
  const expiry = expiresAt ? new Date(expiresAt) : null
  const timer = byId('countdown')
  const ringArc = byId('subscription-ring-arc')
  if (!expiry || Number.isNaN(expiry.getTime())) {
    setText('expiry-date', 'Not confirmed')
    setText('countdown', '—')
    setText('countdown-sub', 'not confirmed')
    if (timer) timer.classList.remove('expired')
    setGauge('subscription-progress', 0, 100)
    if (ringArc) {
      ringArc.setAttribute('stroke-dashoffset', '100')
      ringArc.classList.remove('is-alert', 'is-warn')
      ringArc.classList.add('is-ok')
    }
    return
  }
  const remaining = expiry.getTime() - Date.now()
  // An unlinked subscription only carries the configuration's own date hint.
  const confirmed = sub.linked === true
  setText(
    'expiry-date',
    `${formatTime(expiresAt)}${confirmed ? '' : ' (not confirmed)'}`,
  )
  setText('countdown', formatRemaining(remaining))
  setText('countdown-sub', remaining > 0 ? 'remaining' : '')
  if (timer) timer.classList.toggle('expired', remaining <= 0)
  const pct = Math.min(100, Math.max(0, (remaining / PROGRESS_TERM_MS) * 100))
  setGauge('subscription-progress', pct, 100)
  if (ringArc) {
    const offset = Math.round((100 - pct) * 10) / 10
    ringArc.setAttribute('stroke-dashoffset', String(offset))
    const remDays = remaining / DAY_MS
    ringArc.classList.toggle('is-alert', remDays <= 3)
    ringArc.classList.toggle('is-warn', remDays > 3 && remDays <= 7)
    ringArc.classList.toggle('is-ok', remDays > 7)
  }
}

function formatPublicAddress(server, vpnPort) {
  if (!server || !vpnPort) return 'Unknown'
  const clean = String(server).replace(/^\[|\]$/g, '')
  const host = clean.includes(':') ? `[${clean}]` : clean
  return `${host}:${vpnPort}`
}

/**
 * Text plus the same text as tooltip, for values the layout may truncate.
 * copyText prefers the title, so it must always be the full value.
 */
function setTitled(id, text) {
  const el = byId(id)
  if (!el) return
  el.textContent = text
  el.title = text === 'Unknown' ? '' : text
}

function renderOverview(m) {
  const conn = m.connection || {}
  setTitled('val-target-node', nodeLabel(m.targetNode))
  setText('val-handoff', handoffText(m))
  setTitled('val-endpoint', formatPublicAddress(conn.server, conn.vpnPort))
  const pubkey = byId('val-pubkey')
  if (pubkey) {
    pubkey.textContent = conn.publicKey || 'Unknown'
    pubkey.title = conn.publicKey || ''
  }
  setTitled('val-vpn-ip', conn.vpnIp || 'Unknown')
  setText(
    'val-last-sync',
    formatTime(m.subscription && m.subscription.lastSync) || 'Not yet',
  )

  const used = m.bandwidth ? m.bandwidth.usedGb : null
  const limit =
    m.bandwidth && typeof m.bandwidth.limitGb === 'number'
      ? m.bandwidth.limitGb
      : 100
  setText(
    'bandwidth-used',
    typeof used === 'number' ? `${used.toFixed(2)} GB` : 'Unknown',
  )
  setText('bandwidth-limit', `/ ${limit} GB`)
  setText(
    'modal-bandwidth-used',
    typeof used === 'number' ? used.toFixed(2) : '–',
  )
  setText('modal-bandwidth-limit', `GB / ${limit} GB`)
  const levels = {
    low: (limit * BANDWIDTH_WARN_PCT) / 100,
    high: (limit * BANDWIDTH_CRITICAL_PCT) / 100,
  }
  const usedValue = typeof used === 'number' ? used : 0
  setGauge('bandwidth-meter', usedValue, limit, levels)
  setGauge('modal-bandwidth-meter', usedValue, limit, levels)
  const bwFill = byId('bandwidth-arc-fill')
  if (bwFill) {
    const usedPct =
      limit > 0 ? Math.min(100, Math.max(0, (usedValue / limit) * 100)) : 0
    const offset = Math.round((100 - usedPct) * 10) / 10
    bwFill.setAttribute('stroke-dashoffset', String(offset))
    bwFill.classList.toggle('is-alert', usedPct >= BANDWIDTH_CRITICAL_PCT)
    bwFill.classList.toggle(
      'is-warn',
      usedPct >= BANDWIDTH_WARN_PCT && usedPct < BANDWIDTH_CRITICAL_PCT,
    )
    bwFill.classList.toggle('is-ok', usedPct < BANDWIDTH_WARN_PCT)
  }
  renderCountdown()
  renderNwcStatus(m)
  renderTimeline(m)
  renderQuota(m)
  renderReachability(m)
}

function renderTimeline(m) {
  const chart = byId('timeline-chart')
  const legend = byId('timeline-legend')
  const timeline = subscriptionTimeline(m)
  const phase = byId('timeline-phase')
  if (phase) {
    phase.textContent = timeline
      ? TIMELINE_PHASE_TEXT[timeline.phase]
      : 'Not confirmed'
    phase.setAttribute('data-phase', timeline ? timeline.phase : 'unknown')
  }
  if (chart) {
    if (!timeline) {
      chart.replaceChildren()
    } else {
      const svg = svgEl('svg', {
        viewBox: '0 0 100 10',
        preserveAspectRatio: 'none',
        class: `timeline-svg phase-${timeline.phase}`,
        'aria-hidden': 'true',
        focusable: 'false',
      })
      const [seven, three] = timeline.markers
      svg.append(
        svgEl('rect', { x: 0, y: 3, width: 100, height: 4, class: 'tl-track' }),
        svgEl('rect', {
          x: seven.pct,
          y: 3,
          width: Math.max(0, three.pct - seven.pct),
          height: 4,
          class: 'tl-zone-7d',
        }),
        svgEl('rect', {
          x: three.pct,
          y: 3,
          width: Math.max(0, 100 - three.pct),
          height: 4,
          class: 'tl-zone-3d',
        }),
        svgEl('rect', {
          x: 0,
          y: 3,
          width: timeline.nowPct,
          height: 4,
          class: 'tl-elapsed',
        }),
      )
      for (const marker of timeline.markers) {
        svg.append(
          svgEl('rect', {
            x: Math.max(0, marker.pct - 0.3),
            y: 1,
            width: 0.6,
            height: 8,
            class: `tl-marker${marker.passed ? ' is-passed' : ''}`,
          }),
        )
      }
      svg.append(
        svgEl('rect', {
          x: Math.min(99, Math.max(0, timeline.nowPct - 0.5)),
          y: 0,
          width: 1,
          height: 10,
          class: 'tl-now',
        }),
      )
      chart.replaceChildren(svg)
    }
  }
  if (legend) {
    const items = timeline
      ? timeline.markers.map((marker) => {
          const li = document.createElement('li')
          li.className = 'legend-chip'
          li.setAttribute('data-kind', marker.kind)
          li.classList.toggle('is-passed', marker.passed)
          li.textContent = `${marker.label} · ${formatDate(marker.at)}${marker.passed ? ' (passed)' : ''}`
          return li
        })
      : [legendNote('The expiry is shown once TunnelSats confirms it.')]
    legend.replaceChildren(...items)
  }
  renderRenewSummary(m)
}

function legendNote(text) {
  const li = document.createElement('li')
  li.className = 'legend-note'
  li.textContent = text
  return li
}

/**
 * The renew button names the chosen plan and price; the line above it
 * estimates the new expiry (renewPreview). The estimate is hidden without a
 * confirmed expiry.
 */
function renderRenewSummary(m) {
  const plan = usablePlans(m).find(
    (p) => `${p.months}m` === selectedRenewDuration,
  )
  setText(
    'renew-cta-label',
    plan
      ? `Renew ${monthsLabel(plan.months)} · ${formatUsd(plan.usd)}`
      : 'Renew subscription',
  )
  const preview = byId('renew-preview')
  if (!preview) return
  const item = renewPreview(m).find((p) => p.duration === selectedRenewDuration)
  const date = item ? formatDate(item.newExpiry) : null
  if (!date) {
    preview.hidden = true
    preview.replaceChildren()
    return
  }
  const lead = document.createElement('span')
  lead.textContent = 'New expiry about '
  const strong = document.createElement('strong')
  strong.textContent = date
  preview.replaceChildren(lead, strong)
  preview.hidden = false
}

// Bandwidth arc geometry, as drawn in index.html: M 20 82 A 60 60 0 0 1 140 82.
const ARC_CENTER_X = 80
const ARC_CENTER_Y = 82
const ARC_RADIUS = 60

/** The point on the bandwidth arc for a percentage (0 left end, 100 right end). */
function arcPoint(pct) {
  const p = Math.min(100, Math.max(0, Number.isFinite(pct) ? pct : 0))
  const theta = Math.PI * (1 - p / 100)
  return {
    x: Math.round((ARC_CENTER_X + ARC_RADIUS * Math.cos(theta)) * 100) / 100,
    y: Math.round((ARC_CENTER_Y - ARC_RADIUS * Math.sin(theta)) * 100) / 100,
  }
}

function renderQuota(m, nowMs = Date.now()) {
  const pace = monthPace(m, nowMs)
  const projected =
    pace && typeof pace.projectedGb === 'number' ? pace.projectedGb : null
  const paceEl = byId('pace-text')
  if (paceEl) {
    paceEl.textContent = paceText(pace)
    paceEl.setAttribute(
      'data-projection',
      projected === null ? 'false' : 'true',
    )
  }
  const marker = byId('bandwidth-pace-marker')
  if (marker) {
    const point = arcPoint(
      projected === null ? 0 : (projected / pace.limitGb) * 100,
    )
    marker.setAttribute('cx', String(point.x))
    marker.setAttribute('cy', String(point.y))
    marker.classList.toggle('is-visible', projected !== null)
    marker.classList.toggle(
      'is-over',
      projected !== null && pace.exceedsLimit === true,
    )
  }
  setText('val-resets', resetsText(m))
  const pipsEl = byId('reset-pips')
  if (pipsEl) {
    const bw = (m && m.bandwidth) || {}
    const maxResets =
      typeof bw.maxResetsPerMonth === 'number' && bw.maxResetsPerMonth > 0
        ? Math.min(10, bw.maxResetsPerMonth)
        : 0
    const usedResets =
      typeof bw.resetsThisMonth === 'number' && bw.resetsThisMonth >= 0
        ? bw.resetsThisMonth
        : 0
    const pips = []
    for (let i = 0; i < maxResets; i++) {
      const pip = document.createElement('span')
      pip.className = 'reset-pip'
      pip.classList.toggle('is-used', i < usedResets)
      pip.setAttribute('aria-hidden', 'true')
      pips.push(pip)
    }
    pipsEl.replaceChildren(...pips)
  }
  const eligibility = resetEligibility(m)
  const el = byId('val-reset-eligibility')
  if (el) {
    el.textContent = eligibility.text
    el.setAttribute('data-state', eligibility.state)
  }
}

function renderReachability(m) {
  const conn = (m && m.connection) || {}
  setText('reach-target', formatPublicAddress(conn.server, conn.vpnPort))
  const button = byId('btn-reachability')
  if (button) button.disabled = reachabilityInFlight
  const out = byId('reach-result')
  if (!out) return
  const text = reachabilityInFlight
    ? 'Asking TunnelSats to connect to your node… this can take up to 30 seconds.'
    : reachabilityText(reachabilityResult)
  out.hidden = !text
  out.textContent = text
  out.classList.toggle(
    'is-error',
    Boolean(
      reachabilityResult &&
      !reachabilityInFlight &&
      (reachabilityResult.kind === 'error' || !reachabilityResult.success),
    ),
  )
  out.classList.toggle(
    'is-success',
    Boolean(
      reachabilityResult &&
      !reachabilityInFlight &&
      reachabilityResult.kind !== 'error' &&
      reachabilityResult.success,
    ),
  )
}

function renderFlows(m) {
  const section = byId('flow')
  const list = byId('flow-list')
  if (!section || !list) return
  const flows = flowSteps(m)
  list.replaceChildren(
    ...flows.map((flow) => {
      const wrap = document.createElement('div')
      wrap.className = 'flow'
      wrap.setAttribute('data-flow', flow.kind)
      const title = document.createElement('h3')
      title.className = 'flow-title'
      title.textContent = flow.title
      const steps = document.createElement('ol')
      steps.className = 'flow-steps'
      steps.setAttribute('aria-label', `${flow.title} progress`)
      for (const step of flow.steps) {
        const li = document.createElement('li')
        li.className = `flow-step is-${step.state}`
        if (step.state === 'current') li.setAttribute('aria-current', 'step')
        li.textContent = step.label
        steps.append(li)
      }
      const detail = document.createElement('p')
      detail.className = 'flow-detail'
      detail.textContent = flow.detail
      wrap.append(title, steps, detail)
      return wrap
    }),
  )
  section.hidden = flows.length === 0
}

function buildServerPillItem(server) {
  const li = document.createElement('li')
  const button = document.createElement('button')
  button.setAttribute('type', 'button')
  button.className = 'server-card'
  button.setAttribute('data-server-id', server.id)
  const flag = document.createElement('span')
  flag.className = 'server-flag'
  flag.setAttribute('aria-hidden', 'true')
  flag.textContent = server.flag || ''
  const city = document.createElement('span')
  city.className = 'server-city'
  city.textContent = server.city || server.id
  const country = document.createElement('span')
  country.className = 'server-country'
  country.textContent = server.country || ''
  button.append(flag, city, country)
  li.append(button)
  return li
}

function renderServers() {
  const cards = byId('server-cards')
  const manageCards = byId('manage-server-cards')
  const note = byId('server-cards-note')
  const statusNote = byId('server-status-note')
  const list = usableServers(serverList)
  if (!list.length) {
    for (const el of [cards, manageCards]) {
      if (el) {
        el.hidden = true
        el.replaceChildren()
        el.setAttribute('data-key', '')
      }
    }
    if (note) {
      note.textContent = serversFailed
        ? 'TunnelSats did not answer; the region list below is built in.'
        : ''
      note.hidden = !serversFailed
    }
    if (statusNote) statusNote.hidden = true
    return
  }
  const offered = (id) => list.some((server) => server.id === id)
  if (selectedServerId && !offered(selectedServerId)) {
    if (serverPickedByOperator) {
      withdrawnServerId = selectedServerId
      selectedServerId = ''
    } else {
      selectedServerId = offered(DEFAULT_SERVER_ID)
        ? DEFAULT_SERVER_ID
        : list[0].id
    }
  }
  const cardsKey = JSON.stringify(
    list.map((server) => [server.id, server.flag, server.city, server.country]),
  )
  for (const el of [cards, manageCards]) {
    if (el) {
      renderToggleGroup(
        el,
        cardsKey,
        () => list.map(buildServerPillItem),
        'data-server-id',
        selectedServerId,
      )
      el.hidden = false
    }
  }
  const needsPick = !selectedServerId
  for (const id of ['buy-server-select', 'manage-buy-server-select']) {
    const select = byId(id)
    if (!select) continue
    const key =
      (needsPick ? '!,' : '') + list.map((server) => server.id).join(',')
    if (select.getAttribute('data-key') !== key) {
      const options = list.map((server) => {
        const option = document.createElement('option')
        option.value = server.id
        option.textContent = serverLabel(server)
        return option
      })
      if (needsPick) {
        const placeholder = document.createElement('option')
        placeholder.value = ''
        placeholder.textContent = 'Choose a region'
        placeholder.disabled = true
        options.unshift(placeholder)
      }
      select.replaceChildren(...options)
      select.setAttribute('data-key', key)
    }
    select.value = selectedServerId
  }
  if (note) {
    const asOf = formatTime(serverList.fetchedAt)
    const lines = []
    if (needsPick && withdrawnServerId) {
      lines.push(
        `The region you picked (${withdrawnServerId}) is no longer offered. Choose another region before buying.`,
      )
    }
    lines.push(
      serverList.stale
        ? `TunnelSats did not answer; regions as of ${asOf || 'the last answer'}.`
        : 'Regions offered by TunnelSats.',
    )
    note.textContent = lines.join(' ')
    note.hidden = false
  }
  if (statusNote) statusNote.hidden = false
}

/** The operator picks a server region in the cards or a region select. */
function selectServer(id) {
  if (typeof id !== 'string' || !SERVER_ID_RE.test(id)) return
  const list = usableServers(serverList)
  if (list.length && !list.some((server) => server.id === id)) return
  selectedServerId = id
  serverPickedByOperator = true
  withdrawnServerId = null
  if (list.length) {
    renderServers()
    return
  }
  for (const selectId of ['buy-server-select', 'manage-buy-server-select']) {
    const select = byId(selectId)
    if (select) select.value = id
  }
}

function switchTab(tab) {
  if (!VALID_TABS.includes(tab)) return
  activeTab = tab
  renderTabs(model)
}

function renderTabs(m) {
  for (const tab of VALID_TABS) {
    const btn = byId(`tab-btn-${tab}`)
    if (btn) {
      const active = tab === activeTab
      btn.setAttribute('aria-pressed', active ? 'true' : 'false')
      btn.classList.toggle('is-active', active)
    }
  }
  const setup = byId('view-setup')
  const overview = byId('view-overview')
  const manage = byId('manage')
  const verify = byId('verify-section')
  if (activeTab === 'overview') {
    if (m) {
      if (setup) setup.hidden = Boolean(m.configured)
      if (overview) overview.hidden = !m.configured
    }
    if (manage) manage.hidden = true
    if (verify) verify.hidden = true
  } else if (activeTab === 'actions') {
    if (setup) setup.hidden = true
    if (overview) overview.hidden = true
    if (manage) manage.hidden = false
    if (verify) verify.hidden = true
  } else if (activeTab === 'verify') {
    if (setup) setup.hidden = true
    if (overview) overview.hidden = true
    if (manage) manage.hidden = true
    if (verify) verify.hidden = false
  }
}

function render() {
  renderBadge()
  const error = byId('load-error')
  if (error) {
    error.hidden = !loadFailed
    error.textContent = loadFailed
      ? 'The TunnelSats service did not answer. The values below may be out of date; retrying.'
      : ''
  }
  renderIntentFeedback(model)
  renderIntentControls(model)
  renderTabs(model)
  if (!model) return
  setText(
    'attach-command',
    `start-cli package attach ${nodePackageId(model.targetNode)}`,
  )
  if (model.version) setText('footer-version', `v${model.version}`)
  renderPlans(model)
  renderFlows(model)
  renderInvoicePanel(model)
  renderNotices(model)
  renderActions(model)
  if (model.configured) renderOverview(model)
}

// ─────────────────────────────────────────────
// Data & Intent Bridge
// ─────────────────────────────────────────────
function getCsrfToken() {
  if (typeof document.querySelector === 'function') {
    const meta = document.querySelector('meta[name="csrf-token"]')
    if (meta && typeof meta.getAttribute === 'function') {
      return meta.getAttribute('content') || ''
    }
  }
  return ''
}

function hasActiveAsyncWork(m) {
  if (!m) return false
  if (activePayableInvoice(m)) return true
  const intents = m.intents || {}
  return ['buy', 'renew', 'reset'].some(
    (k) =>
      intents[k] &&
      (intents[k].status === 'pending' || intents[k].status === 'processing'),
  )
}

async function refresh() {
  lastPollAt = Date.now()
  try {
    const response = await fetch(DASHBOARD_URL, {
      cache: 'no-store',
      credentials: 'same-origin',
    })
    if (!response.ok) throw new Error(`HTTP ${response.status}`)
    model = await response.json()
    loadFailed = false
    if (activePayableInvoice(model)) {
      localIntentFeedback = null
    }
  } catch (error) {
    console.error('Failed to load the dashboard state:', error)
    loadFailed = true
  }
  render()
}

async function loadServers() {
  serversLoadedAt = Date.now()
  try {
    const response = await fetch(SERVERS_URL, {
      cache: 'no-store',
      credentials: 'same-origin',
    })
    if (!response.ok) throw new Error(`HTTP ${response.status}`)
    const data = await response.json()
    if (!usableServers(data).length) throw new Error('empty server list')
    serverList = data
    serversFailed = false
  } catch (error) {
    console.error('Failed to load the server list:', error)
    serversFailed = true
  }
  renderServers()
}

function readStoredNodePubkey() {
  try {
    const value = localStorage.getItem(NODE_PUBKEY_STORAGE_KEY)
    return isValidNodePubkey(value) ? value.trim() : ''
  } catch {
    return ''
  }
}

function storeNodePubkey(value) {
  try {
    localStorage.setItem(NODE_PUBKEY_STORAGE_KEY, value)
  } catch {
    // Storage may be unavailable (private mode); the check still runs.
  }
}

async function checkReachability() {
  if (reachabilityInFlight) return
  const input = byId('reach-pubkey')
  const pubkey = input ? String(input.value || '').trim() : ''
  if (!isValidNodePubkey(pubkey)) {
    reachabilityResult = {
      kind: 'error',
      text: 'Enter your node public key: 66 hex characters starting with 02 or 03.',
    }
    renderReachability(model)
    return
  }
  storeNodePubkey(pubkey)
  reachabilityInFlight = true
  reachabilityResult = null
  renderReachability(model)
  try {
    const response = await fetch(REACHABILITY_URL, {
      method: 'POST',
      cache: 'no-store',
      credentials: 'same-origin',
      headers: {
        'Content-Type': 'application/json',
        'X-CSRF-Token': getCsrfToken(),
      },
      body: JSON.stringify({ nodePubkey: pubkey }),
    })
    const data = await response.json().catch(() => ({}))
    if (!response.ok) {
      reachabilityResult = {
        kind: 'error',
        text:
          data.error || `The check could not run (HTTP ${response.status}).`,
      }
    } else {
      reachabilityResult = {
        kind: 'result',
        success: data.success === true,
        latencyMs: typeof data.latencyMs === 'number' ? data.latencyMs : null,
        error: typeof data.error === 'string' ? data.error : null,
        host: typeof data.host === 'string' ? data.host : null,
        port: typeof data.port === 'number' ? data.port : null,
      }
    }
  } catch (error) {
    console.error('Reachability check failed:', error)
    reachabilityResult = {
      kind: 'error',
      text: 'Could not reach the TunnelSats service to run the check.',
    }
  } finally {
    reachabilityInFlight = false
  }
  renderReachability(model)
}

async function submitIntent(actionKey) {
  if (submittingIntent) return
  let payload = null
  if (actionKey === 'buy' || actionKey === 'buy-manage') {
    const manage = actionKey === 'buy-manage'
    const serverSelect = byId(
      manage ? 'manage-buy-server-select' : 'buy-server-select',
    )
    const durationSelect = byId(
      manage ? 'manage-buy-duration-select' : 'buy-duration-select',
    )
    // selectedServerId is '' while the operator's pick is withdrawn: Buy
    // then waits for a new pick instead of buying some other region.
    const serverId = selectedServerId
      ? (serverSelect && serverSelect.value) || selectedServerId
      : ''
    if (!serverId) {
      localIntentFeedback = {
        level: 'error',
        text: 'Choose a server region first.',
      }
      render()
      return
    }
    payload = {
      kind: 'buy',
      serverId,
      duration:
        (durationSelect && durationSelect.value) || selectedBuyDuration || '3m',
    }
  } else if (actionKey === 'renew') {
    const durationSelect = byId('renew-duration-select')
    payload = {
      kind: 'renew',
      duration:
        (durationSelect && durationSelect.value) ||
        selectedRenewDuration ||
        '3m',
    }
  } else if (actionKey === 'reset') {
    payload = { kind: 'reset' }
  } else {
    return
  }

  submittingIntent = true
  localIntentFeedback = {
    level: 'info',
    text: 'Submitting request to TunnelSats…',
  }
  render()

  try {
    const response = await fetch(INTENTS_URL, {
      method: 'POST',
      cache: 'no-store',
      credentials: 'same-origin',
      headers: {
        'Content-Type': 'application/json',
        'X-CSRF-Token': getCsrfToken(),
      },
      body: JSON.stringify(payload),
    })
    const data = await response.json().catch(() => ({}))
    if (!response.ok) {
      localIntentFeedback = {
        level: 'error',
        text: data.error || `Request failed (HTTP ${response.status})`,
      }
      submittingIntent = false
      render()
      return
    }
    localIntentFeedback = {
      level: 'info',
      text: 'Request accepted; preparing the invoice and raising the Pay Invoice task…',
    }
  } catch (error) {
    console.error('Intent submission failed:', error)
    localIntentFeedback = {
      level: 'error',
      text: 'Could not reach the TunnelSats service to submit the request.',
    }
  } finally {
    submittingIntent = false
  }
  await refresh()
}

// ─────────────────────────────────────────────
// Interaction
// ─────────────────────────────────────────────
function copyText(elementId, button) {
  const el = byId(elementId)
  const text = el ? el.title || el.textContent : ''
  if (!text || text === 'Unknown') return
  const done = () => {
    const original = button.textContent
    button.textContent = 'Copied'
    button.classList.add('copied')
    setTimeout(() => {
      button.textContent = original
      button.classList.remove('copied')
    }, 1500)
  }
  if (navigator.clipboard && window.isSecureContext) {
    navigator.clipboard.writeText(text).then(done, () => {})
    return
  }
  // Plain-HTTP LAN access has no clipboard API.
  const area = document.createElement('textarea')
  area.value = text
  area.setAttribute('readonly', '')
  area.className = 'copy-buffer'
  document.body.append(area)
  area.select()
  try {
    if (document.execCommand('copy')) done()
  } catch (error) {
    console.error('Copy failed:', error)
  }
  area.remove()
}

function bindEvents() {
  document.addEventListener('click', (event) => {
    const target = event.target
    if (!target || typeof target.closest !== 'function') return
    const tabBtn = target.closest('[data-tab-target]')
    if (tabBtn) {
      const tab = tabBtn.getAttribute('data-tab-target')
      switchTab(tab)
      // A link inside a panel is hidden with that panel: move focus to the
      // selected tab instead of letting it fall back to <body>.
      const selectedTab = byId(`tab-btn-${tab}`)
      if (selectedTab && selectedTab !== tabBtn) selectedTab.focus()
      return
    }
    const opener = target.closest('[data-open-dialog]')
    if (opener) {
      const dialog = byId(opener.getAttribute('data-open-dialog'))
      if (dialog && !dialog.open) dialog.showModal()
      return
    }
    const closer = target.closest('[data-close-dialog]')
    if (closer) {
      const dialog = closer.closest('dialog')
      if (dialog) dialog.close()
      return
    }
    const copier = target.closest('[data-copy]')
    if (copier) {
      copyText(copier.getAttribute('data-copy'), copier)
      return
    }
    const intentBtn = target.closest('[data-submit-intent]')
    if (intentBtn && !intentBtn.disabled) {
      submitIntent(intentBtn.getAttribute('data-submit-intent'))
      return
    }
    const serverCard = target.closest('[data-server-id]')
    if (serverCard) {
      selectServer(serverCard.getAttribute('data-server-id'))
      return
    }
    if (target.closest('[data-reachability]')) {
      checkReachability()
      return
    }
    const invoiceSwitch = target.closest('[data-invoice-kind]')
    if (invoiceSwitch) {
      selectInvoice(invoiceSwitch.getAttribute('data-invoice-kind'))
      return
    }
    const planCard = target.closest('[data-plan-duration]')
    if (planCard) {
      selectBuyDuration(planCard.getAttribute('data-plan-duration'))
      return
    }
    const renewPill = target.closest('[data-renew-duration]')
    if (renewPill) {
      selectRenewDuration(renewPill.getAttribute('data-renew-duration'))
      return
    }
    // Light dismiss: .app-modal fills the viewport around .modal-dialog-inner,
    // so a click on the backdrop targets the <dialog> element directly.
    if (target.tagName === 'DIALOG' && target.open) {
      target.close()
    }
  })

  document.addEventListener('change', (event) => {
    const target = event.target
    if (!target) return
    if (
      target.id === 'buy-server-select' ||
      target.id === 'manage-buy-server-select'
    ) {
      selectServer(target.value)
    } else if (
      target.id === 'buy-duration-select' ||
      target.id === 'manage-buy-duration-select'
    ) {
      selectBuyDuration(target.value)
    } else if (target.id === 'renew-duration-select') {
      selectRenewDuration(target.value)
    }
  })

  const refreshButton = byId('btn-refresh')
  if (refreshButton) refreshButton.addEventListener('click', () => refresh())

  document.addEventListener('visibilitychange', () => {
    if (document.hidden) return
    refresh()
    if (serversStale()) loadServers()
  })
}

function serversStale(nowMs = Date.now()) {
  return nowMs - serversLoadedAt >= SERVERS_REFRESH_MS
}

/** One tick of the poll loop: the dashboard state, and the server list once it is stale. */
function pollTick(nowMs = Date.now()) {
  if (document.hidden) return
  const interval = hasActiveAsyncWork(model) ? FAST_POLL_MS : POLL_MS
  if (nowMs - lastPollAt >= interval) refresh()
  if (serversStale(nowMs)) loadServers()
}

function init() {
  renderPlans()
  bindEvents()
  const pubkeyInput = byId('reach-pubkey')
  if (pubkeyInput) pubkeyInput.value = readStoredNodePubkey()
  render()
  refresh()
  loadServers()
  setInterval(() => pollTick(), FAST_POLL_MS)
  if (!countdownTimer) countdownTimer = setInterval(renderCountdown, 30000)
}

init()
