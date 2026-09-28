// TunnelSats dashboard: read-only.
//
// Everything shown here comes from GET /api/dashboard, an allow-listed read
// model without secrets (bridge.py get_dashboard). Buying, renewing,
// resetting, importing, configuring and exporting run as StartOS actions,
// which need the operator's StartOS login and pay through the node's Pay
// Invoice task; this page only explains where to find them. It makes no
// request to any other host.

const DASHBOARD_URL = '/api/dashboard'
const POLL_MS = 30000
const DAY_MS = 24 * 60 * 60 * 1000
// The expiry progress bar is scaled to a one-month plan.
const PROGRESS_TERM_MS = 30 * DAY_MS
const BANDWIDTH_WARN_PCT = 70
const BANDWIDTH_CRITICAL_PCT = 90

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

let model = null
let loadFailed = false
let countdownTimer = null

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

function formatTime(iso) {
  if (!iso) return null
  const date = new Date(iso)
  return Number.isNaN(date.getTime()) ? null : date.toLocaleString()
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
      !pending.renewal
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

  if (m.connection && m.connection.allowIpv6) {
    notices.push({
      level: 'info',
      title: 'Allow IPv6 Endpoint is on',
      text: 'TunnelSats may hand your node an IPv6 server endpoint to announce. How your node routes its own IPv6 traffic is decided by the Lightning node package.',
    })
  }
  return notices
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
  if (
    !pending.renewal &&
    (m.status === 'expired' ||
      (sub.active &&
        typeof sub.daysRemaining === 'number' &&
        sub.daysRemaining < 7))
  ) {
    suggested.push('renew')
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

// ─────────────────────────────────────────────
// Rendering (textContent only: values from the read model are never parsed
// as HTML)
// ─────────────────────────────────────────────
function byId(id) {
  return document.getElementById(id)
}

function setText(id, text) {
  const el = byId(id)
  if (el) el.textContent = text
}

function setWidth(id, pct) {
  const el = byId(id)
  if (el) el.style.width = `${pct}%`
}

function setLevel(el, pct) {
  if (!el) return
  el.classList.remove('warning', 'critical')
  if (pct >= BANDWIDTH_CRITICAL_PCT) el.classList.add('critical')
  else if (pct >= BANDWIDTH_WARN_PCT) el.classList.add('warning')
}

function renderPlans(m) {
  const list = byId('plan-list')
  if (!list) return
  const plans =
    m && Array.isArray(m.plans) && m.plans.length ? m.plans : PLAN_PRICES_USD
  const items = plans.map((plan) => {
    const li = document.createElement('li')
    li.className = 'plan-card'
    const duration = document.createElement('span')
    duration.className = 'plan-duration'
    duration.textContent = `${plan.months} month${plan.months > 1 ? 's' : ''}`
    const price = document.createElement('span')
    price.className = 'plan-price'
    price.textContent = formatUsd(plan.usd)
    const perMonth = document.createElement('span')
    perMonth.className = 'plan-per-mo'
    perMonth.textContent =
      plan.discountPct > 0
        ? `${formatUsd(plan.usd / plan.months)}/mo · save ${plan.discountPct}%`
        : `${formatUsd(plan.usd)}/mo`
    li.append(duration, price, perMonth)
    return li
  })
  list.replaceChildren(...items)
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
  for (const id of ['buy', 'renew', 'reset', 'import', 'configure', 'export']) {
    const item = byId(`action-${id}`)
    if (item) item.classList.toggle('is-suggested', suggested.includes(id))
  }
}

function renderCountdown() {
  const expiresAt =
    model && model.subscription ? model.subscription.expiresAt : null
  const expiry = expiresAt ? new Date(expiresAt) : null
  const timer = byId('countdown')
  if (!expiry || Number.isNaN(expiry.getTime())) {
    setText('expiry-date', 'Not confirmed')
    setText('countdown', 'Unknown')
    if (timer) timer.classList.remove('expired')
    setWidth('subscription-progress', 0)
    return
  }
  const remaining = expiry.getTime() - Date.now()
  setText('expiry-date', `Expires ${expiry.toLocaleString()}`)
  setText('countdown', formatRemaining(remaining))
  if (timer) timer.classList.toggle('expired', remaining <= 0)
  setWidth(
    'subscription-progress',
    Math.min(100, Math.max(0, (remaining / PROGRESS_TERM_MS) * 100)),
  )
}

function formatPublicAddress(server, vpnPort) {
  if (!server || !vpnPort) return 'Unknown'
  const clean = String(server).replace(/^\[|\]$/g, '')
  const host = clean.includes(':') ? `[${clean}]` : clean
  return `${host}:${vpnPort}`
}

function renderOverview(m) {
  const conn = m.connection || {}
  setText('val-target-node', nodeLabel(m.targetNode))
  setText('val-handoff', handoffText(m))
  setText('val-endpoint', formatPublicAddress(conn.server, conn.vpnPort))
  const pubkey = byId('val-pubkey')
  if (pubkey) {
    pubkey.textContent = conn.publicKey || 'Unknown'
    pubkey.title = conn.publicKey || ''
  }
  setText('val-vpn-ip', conn.vpnIp || 'Unknown')
  setText(
    'val-last-sync',
    formatTime(m.subscription && m.subscription.lastSync) || 'Not yet',
  )

  const pct = bandwidthPercent(m)
  const used = m.bandwidth ? m.bandwidth.usedGb : null
  const limit = m.bandwidth ? m.bandwidth.limitGb : 100
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
  setWidth('bandwidth-progress', pct || 0)
  setWidth('modal-bandwidth-fill', pct || 0)
  setLevel(byId('bandwidth-progress'), pct || 0)
  setLevel(byId('modal-bandwidth-fill'), pct || 0)
  renderCountdown()
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
  if (!model) return
  const setup = byId('view-setup')
  const overview = byId('view-overview')
  if (setup) setup.hidden = model.configured
  if (overview) overview.hidden = !model.configured
  setText(
    'attach-command',
    `start-cli package attach ${nodePackageId(model.targetNode)}`,
  )
  if (model.version) setText('footer-version', `v${model.version}`)
  renderPlans(model)
  renderNotices(model)
  renderActions(model)
  if (model.configured) renderOverview(model)
}

// ─────────────────────────────────────────────
// Data
// ─────────────────────────────────────────────
async function refresh() {
  try {
    const response = await fetch(DASHBOARD_URL, {
      cache: 'no-store',
      credentials: 'same-origin',
    })
    if (!response.ok) throw new Error(`HTTP ${response.status}`)
    model = await response.json()
    loadFailed = false
  } catch (error) {
    console.error('Failed to load the dashboard state:', error)
    loadFailed = true
  }
  render()
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
    // Light dismiss: .app-modal fills the viewport around .modal-dialog-inner,
    // so a click on the backdrop targets the <dialog> element directly.
    if (target.tagName === 'DIALOG' && target.open) {
      target.close()
    }
  })

  const refreshButton = byId('btn-refresh')
  if (refreshButton) refreshButton.addEventListener('click', () => refresh())

  document.addEventListener('visibilitychange', () => {
    if (!document.hidden) refresh()
  })
}

function init() {
  renderPlans()
  bindEvents()
  render()
  refresh()
  setInterval(() => {
    if (!document.hidden) refresh()
  }, POLL_MS)
  if (!countdownTimer) countdownTimer = setInterval(renderCountdown, 30000)
}

init()
