let statusData = {}
let countdownInterval = null
let targetExpiry = null
let selectedNode = 'lnd'
let selectedDuration = 3
let selectedRenewalDuration = 3
let activePaymentHash = null
let activePollingInterval = null
let currentKeypair = null
// Each checkout gets a number; a response for a superseded one is dropped.
let checkoutSeq = 0
// Payment hash of a paid order whose claim is still being saved. Its key
// exists only in this page, so no new checkout may start until it is done.
let paidClaimInFlight = null
let serversList = []

// ─────────────────────────────────────────────
// Initializer & Status Fetch
// ─────────────────────────────────────────────
async function fetchStatus(force = false) {
  try {
    const url = force ? '/api/status?force=1' : '/api/status'
    const response = await fetch(url)
    if (response.ok) {
      statusData = await response.json()
      updateUI()
    }
  } catch (error) {
    console.error('Failed to fetch status:', error)
  }
}

function getCsrfToken() {
  const meta = document.querySelector('meta[name="csrf-token"]')
  if (meta && meta.content) return meta.content
  if (statusData && statusData.csrf_token) return statusData.csrf_token
  return ''
}

function updateUI() {
  const isConfigured = Boolean(statusData.configured && statusData.enabled)
  const storefrontView = document.getElementById('view-storefront')
  const telemetryView = document.getElementById('view-telemetry')
  const backBtn = document.getElementById('btn-back-to-telemetry')

  // Determine initial view if not manually navigated
  if (!storefrontView.dataset.userNavigated) {
    if (isConfigured) {
      storefrontView.style.display = 'none'
      telemetryView.style.display = 'flex'
      if (backBtn) backBtn.style.display = 'inline-flex'
    } else {
      storefrontView.style.display = 'flex'
      telemetryView.style.display = 'none'
      if (backBtn) backBtn.style.display = 'none'
    }
  }

  // 1. Status Badge
  const badge = document.getElementById('status-badge')
  const badgeText = badge.querySelector('.status-text')

  if (statusData.enabled) {
    if (statusData.status === 'running' || statusData.subscription_active) {
      badge.className = 'status-badge active'
      badgeText.textContent = 'SUBSCRIPTION ACTIVE'
    } else if (statusData.status === 'expired') {
      badge.className = 'status-badge inactive'
      badgeText.textContent = 'SUBSCRIPTION EXPIRED'
    } else if (statusData.status === 'unconfigured') {
      badge.className = 'status-badge inactive'
      badgeText.textContent = 'UNCONFIGURED'
    } else {
      badge.className = 'status-badge inactive'
      badgeText.textContent = 'SYNCING'
    }
  } else {
    badge.className = 'status-badge inactive'
    badgeText.textContent = 'TUNNEL DISABLED'
  }

  // 2. Telemetry Properties
  const targetNodeEl = document.getElementById('val-target-node')
  if (targetNodeEl) {
    targetNodeEl.textContent =
      statusData.target_host && statusData.target_host.includes('c-lightning')
        ? 'Core Lightning'
        : 'LND'
  }

  const endpointEl = document.getElementById('val-public-endpoint')
  if (endpointEl) {
    if (statusData.public_ip && statusData.public_ip !== 'Unknown') {
      endpointEl.textContent = `${statusData.public_ip}:${statusData.vpn_port || 9735}`
    } else {
      endpointEl.textContent = '...'
    }
  }

  const pubkeyEl = document.getElementById('val-pubkey')
  if (pubkeyEl) {
    pubkeyEl.textContent = statusData.pubkey || '...'
    pubkeyEl.title = statusData.pubkey || ''
  }

  const vpnIpEl = document.getElementById('val-vpn-ip')
  if (vpnIpEl) {
    vpnIpEl.textContent = statusData.vpn_ip || '...'
  }

  const lastSyncEl = document.getElementById('val-last-sync')
  if (lastSyncEl) {
    if (statusData.last_sync) {
      try {
        lastSyncEl.textContent = new Date(statusData.last_sync).toLocaleString()
      } catch {
        lastSyncEl.textContent = statusData.last_sync
      }
    } else {
      lastSyncEl.textContent = 'Pending sync'
    }
  }

  // Bandwidth Telemetry
  const usedGb =
    typeof statusData.bandwidth_used_gb === 'number'
      ? statusData.bandwidth_used_gb
      : 0.0
  const limitGb = statusData.bandwidth_limit_gb || 100
  const bwPct = Math.min(100, Math.max(0, (usedGb / limitGb) * 100))

  const valBwUsed = document.getElementById('val-bandwidth-used')
  if (valBwUsed) {
    valBwUsed.textContent = `${usedGb.toFixed(2)} GB`
  }

  const bwBar = document.getElementById('bandwidth-progress')
  if (bwBar) {
    bwBar.style.width = `${bwPct}%`
    bwBar.classList.remove('warning', 'critical')
    if (bwPct >= 90) {
      bwBar.classList.add('critical')
    } else if (bwPct >= 70) {
      bwBar.classList.add('warning')
    }
  }

  // Update Bandwidth Modal Stats
  const modalBwUsed = document.getElementById('modal-bandwidth-used')
  if (modalBwUsed) modalBwUsed.textContent = usedGb.toFixed(2)

  const modalBwFill = document.getElementById('modal-bandwidth-fill')
  if (modalBwFill) {
    modalBwFill.style.width = `${bwPct}%`
    modalBwFill.classList.remove('warning', 'critical')
    if (bwPct >= 90) modalBwFill.classList.add('critical')
    else if (bwPct >= 70) modalBwFill.classList.add('warning')
  }

  const modalStatUsed = document.getElementById('modal-stat-used')
  if (modalStatUsed) modalStatUsed.textContent = `${usedGb.toFixed(2)} GB`

  const modalStatRemaining = document.getElementById('modal-stat-remaining')
  if (modalStatRemaining) {
    const remaining = Math.max(0, limitGb - usedGb)
    modalStatRemaining.textContent = `${remaining.toFixed(2)} GB`
  }

  // Footer Version
  if (statusData.version) {
    const versionEl = document.getElementById('footer-version')
    if (versionEl) versionEl.textContent = 'v' + statusData.version
  }

  // IPv6 Exposure Notice
  const ipv6Banner = document.getElementById('ipv6-warning-banner')
  if (ipv6Banner) {
    ipv6Banner.style.display = statusData.allow_ipv6 ? 'block' : 'none'
  }

  // 3. Expiry / Countdown Timer
  const expiryRaw = document.getElementById('expiry-date-raw')
  const timerEl = document.getElementById('countdown-timer')
  const progressEl = document.getElementById('subscription-progress')

  if (statusData.expires_at && statusData.expires_at !== 'Unknown') {
    const parsedDate = new Date(statusData.expires_at)
    if (!isNaN(parsedDate.getTime())) {
      expiryRaw.textContent = parsedDate.toLocaleString()
      targetExpiry = parsedDate
    } else {
      targetExpiry = null
      expiryRaw.textContent = 'Invalid Expiry Date'
      timerEl.textContent = 'No Active Subscription'
      progressEl.style.width = '0%'
    }
  } else {
    targetExpiry = null
    expiryRaw.textContent = 'Unconfigured / Inactive'
    timerEl.textContent = 'No Active Subscription'
    progressEl.style.width = '0%'
  }

  if (!countdownInterval) {
    countdownInterval = setInterval(() => {
      if (!targetExpiry) return

      const now = new Date()
      const timeDiff = targetExpiry - now

      const tEl = document.getElementById('countdown-timer')
      const pEl = document.getElementById('subscription-progress')
      if (!tEl || !pEl) return

      if (timeDiff <= 0) {
        tEl.textContent = 'Expired'
        tEl.style.color = '#ef4444'
        pEl.style.width = '0%'
      } else {
        tEl.style.color = ''
        const days = Math.floor(timeDiff / (1000 * 60 * 60 * 24))
        const hours = Math.floor(
          (timeDiff % (1000 * 60 * 60 * 24)) / (1000 * 60 * 60),
        )
        const minutes = Math.floor((timeDiff % (1000 * 60 * 60)) / (1000 * 60))
        const seconds = Math.floor((timeDiff % (1000 * 60)) / 1000)

        if (days > 0) {
          tEl.textContent = `${days}d ${hours}h ${minutes}m`
        } else {
          tEl.textContent = `${hours}h ${minutes}m ${seconds}s`
        }

        const maxTerm = 30 * 24 * 60 * 60 * 1000
        const percentage = Math.min(
          100,
          Math.max(0, (timeDiff / maxTerm) * 100),
        )
        pEl.style.width = `${percentage}%`
      }
    }, 1000)
  }
}

// ─────────────────────────────────────────────
// Navigation & Views
// ─────────────────────────────────────────────
function showStorefrontView() {
  const storefrontView = document.getElementById('view-storefront')
  const telemetryView = document.getElementById('view-telemetry')
  const backBtn = document.getElementById('btn-back-to-telemetry')
  const byocHomeBtn = document.getElementById('btn-byoc-home')

  storefrontView.dataset.userNavigated = 'true'
  storefrontView.style.display = 'flex'
  telemetryView.style.display = 'none'
  const isConfigured = Boolean(statusData && statusData.configured)
  if (backBtn) backBtn.style.display = isConfigured ? 'inline-flex' : 'none'
  if (byocHomeBtn)
    byocHomeBtn.style.display = isConfigured ? 'inline-flex' : 'none'
}

function showTelemetryView() {
  const storefrontView = document.getElementById('view-storefront')
  const telemetryView = document.getElementById('view-telemetry')

  storefrontView.dataset.userNavigated = 'true'
  storefrontView.style.display = 'none'
  telemetryView.style.display = 'flex'
}

function goToHomepage() {
  closeAllModals()
  toggleByoc(false)
  if (statusData && statusData.configured) {
    showTelemetryView()
  } else {
    showStorefrontView()
    window.scrollTo({ top: 0, behavior: 'smooth' })
  }
}

function closeAllModals() {
  ;[
    'bandwidth-modal',
    'payment-modal',
    'renewal-modal',
    'faq-modal',
    'export-modal',
  ].forEach((id) => {
    const modal = document.getElementById(id)
    if (modal && modal.open) {
      modal.close()
    }
  })
  if (activePollingInterval) {
    clearInterval(activePollingInterval)
    activePollingInterval = null
  }
}

// ─────────────────────────────────────────────
// Storefront Selection Handlers
// ─────────────────────────────────────────────
function selectNode(node, btn) {
  selectedNode = node === 'cln' ? 'cln' : 'lnd'
  document.querySelectorAll('.node-selector-pills .pill-btn').forEach((el) => {
    el.classList.remove('active')
  })
  btn.classList.add('active')
}

function selectPlan(duration, card) {
  selectedDuration = duration
  document.querySelectorAll('.plan-cards-grid .plan-card').forEach((el) => {
    el.classList.remove('active')
  })
  card.classList.add('active')
}

function selectRenewalPlan(duration, card) {
  selectedRenewalDuration = duration
  document.querySelectorAll('#renewal-modal .plan-card').forEach((el) => {
    el.classList.remove('active')
  })
  card.classList.add('active')
}

function toggleByoc(forceOpen) {
  const harmonica = document.getElementById('byoc-harmonica')
  const btn = document.getElementById('byoc-toggle-btn')
  if (!harmonica || !btn) return
  const isOpen =
    typeof forceOpen === 'boolean'
      ? forceOpen
        ? (harmonica.classList.add('open'), true)
        : (harmonica.classList.remove('open'), false)
      : harmonica.classList.toggle('open')
  btn.setAttribute('aria-expanded', isOpen ? 'true' : 'false')
}

// ─────────────────────────────────────────────
// Dynamic Bitcoin & Subscription Pricing Logic
// ─────────────────────────────────────────────
const BASE_PRICE_USD = 3
const PLAN_DISCOUNTS = {
  1: 0,
  3: 0.05,
  6: 0.1,
  12: 0.2,
}
let currentSatsPerDollar = 1200 // Conservative fallback rate (~$83.3k BTC)

function calculatePlanPrice(months, satsPerDollar) {
  const discount = PLAN_DISCOUNTS[months] || 0
  const grossUsd = BASE_PRICE_USD * months
  const discountedUsd = grossUsd * (1 - discount)
  return Math.floor(discountedUsd * satsPerDollar)
}

async function fetchSatsPerDollar() {
  // Try Mempool.space first
  try {
    const res = await fetch('https://mempool.space/api/v1/prices')
    if (res.ok) {
      const data = await res.json()
      if (data && data.USD && Number(data.USD) > 0) {
        return Math.floor(100_000_000 / Number(data.USD))
      }
    }
  } catch (e) {
    console.warn('mempool.space price API failed, trying fallback:', e)
  }

  // Fallback: blockchain.info ticker
  try {
    const res = await fetch('https://blockchain.info/ticker')
    if (res.ok) {
      const data = await res.json()
      const btcPrice = data && data.USD && (data.USD.buy || data.USD.last)
      if (btcPrice && Number(btcPrice) > 0) {
        return Math.floor(100_000_000 / Number(btcPrice))
      }
    }
  } catch (e) {
    console.warn('blockchain.info price API failed:', e)
  }

  return currentSatsPerDollar
}

async function updateDynamicPricing() {
  try {
    currentSatsPerDollar = await fetchSatsPerDollar()
    const durations = [1, 3, 6, 12]
    durations.forEach((months) => {
      const sats = calculatePlanPrice(months, currentSatsPerDollar)
      const formatted = sats.toLocaleString()

      // Update storefront plan cards
      const storefrontPriceEl = document.getElementById(`plan-price-${months}`)
      if (storefrontPriceEl) {
        storefrontPriceEl.textContent = formatted
      }

      // Update renewal modal plan cards
      const renewalPriceEl = document.getElementById(
        `renewal-plan-price-${months}`,
      )
      if (renewalPriceEl) {
        renewalPriceEl.textContent = formatted
      }
    })
  } catch (e) {
    console.warn('Dynamic pricing update failed:', e)
  }
}

// ─────────────────────────────────────────────
// Checkout & Payment Modal Flow
// ─────────────────────────────────────────────
async function generateKeys() {
  try {
    const res = await fetch('/api/keys/generate', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'X-Requested-With': 'XMLHttpRequest',
        'X-TunnelSats-CSRF': getCsrfToken(),
        'X-CSRF-Token': getCsrfToken(),
      },
    })
    if (res.ok) {
      const data = await res.json()
      return { privateKey: data.private_key, publicKey: data.public_key }
    }
  } catch (err) {
    console.warn('Server-side keygen failed, using WebCrypto fallback:', err)
  }

  // Fallback: WebCrypto X25519 if supported
  if (window.crypto && window.crypto.subtle) {
    try {
      const pair = await window.crypto.subtle.generateKey(
        { name: 'X25519' },
        true,
        ['deriveKey', 'deriveBits'],
      )
      const privRaw = await window.crypto.subtle.exportKey(
        'pkcs8',
        pair.privateKey,
      )
      const pubRaw = await window.crypto.subtle.exportKey('raw', pair.publicKey)
      const privBytes = new Uint8Array(privRaw).slice(16)
      const pubBytes = new Uint8Array(pubRaw)
      return {
        privateKey: btoa(String.fromCharCode(...privBytes)),
        publicKey: btoa(String.fromCharCode(...pubBytes)),
      }
    } catch (e) {
      console.error('WebCrypto keygen error:', e)
    }
  }
  throw new Error('Unable to generate WireGuard keypair.')
}

async function startCheckout() {
  // The claim is saved for the node chosen now: the operator may change the
  // selection while a paid claim is still retrying.
  const targetNode = selectedNode
  if (paidClaimInFlight) {
    alert(
      `A paid order is still being provisioned (payment hash ${paidClaimInFlight}). Keep this page open until it is saved before starting another checkout.`,
    )
    return
  }
  const serverSelect = document.getElementById('select-server')
  const serverId = serverSelect ? serverSelect.value : ''
  if (!serverId) {
    alert('Please select a VPN server region.')
    return
  }

  const seq = ++checkoutSeq
  // A newer checkout started while this one awaited: drop this one. Its
  // invoice, if created, was never shown and cannot have been paid.
  const superseded = () => seq !== checkoutSeq

  openPaymentModal()
  setPaymentStatus('Generating WireGuard keypair...', 'pulse-amber')

  try {
    const keypair = await generateKeys()
    if (superseded()) return
    currentKeypair = keypair
    setPaymentStatus('Creating Lightning invoice...', 'pulse-amber')

    const orderRes = await fetch(
      'https://tunnelsats.com/api/public/v1/subscription/create',
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          serverId,
          duration: selectedDuration,
          wgPublicKey: keypair.publicKey,
        }),
      },
    )

    if (!orderRes.ok) {
      throw new Error(`Order creation failed (HTTP ${orderRes.status})`)
    }

    const order = await orderRes.json()
    if (superseded()) return
    renderPaymentDetails(
      order.invoice,
      order.amountSats ||
        calculatePlanPrice(selectedDuration, currentSatsPerDollar),
      `${selectedDuration} Month${selectedDuration > 1 ? 's' : ''} Subscription`,
    )
    pollOrderSettlement(order.paymentHash, keypair, serverId, targetNode)
  } catch (err) {
    if (superseded()) return
    console.error('Checkout error:', err)
    setPaymentStatus(`Error: ${err.message}`, 'pulse-amber')
  }
}

function renderPaymentDetails(invoice, sats, planDesc) {
  const amountEl = document.getElementById('payment-sats-amount')
  const planEl = document.getElementById('payment-plan-desc')
  const invoiceInput = document.getElementById('invoice-text')
  const walletBtn = document.getElementById('btn-open-wallet')
  const qrContainer = document.getElementById('payment-qr-container')

  if (amountEl) amountEl.textContent = sats.toLocaleString()
  if (planEl) planEl.textContent = planDesc
  if (invoiceInput) invoiceInput.value = invoice
  if (walletBtn) walletBtn.href = `lightning:${invoice}`

  // Render QR Code using qrcode.js
  if (qrContainer) {
    try {
      if (typeof qrcode !== 'undefined') {
        const qr = qrcode(0, 'M')
        qr.addData(invoice)
        qr.make()
        qrContainer.innerHTML = qr.createSvgTag(4, 0)
      } else {
        qrContainer.innerHTML =
          "<div class='qr-loading'>Invoice generated. Copy text below.</div>"
      }
    } catch (e) {
      console.error('QR render error:', e)
      qrContainer.innerHTML =
        "<div class='qr-loading'>Scan via wallet or copy invoice below.</div>"
    }
  }

  setPaymentStatus('Waiting for payment settlement...', 'pulse-amber')
}

function pollOrderSettlement(paymentHash, keypair, serverId, targetNode) {
  if (activePollingInterval) clearInterval(activePollingInterval)
  activePaymentHash = paymentHash

  activePollingInterval = setInterval(async () => {
    try {
      const res = await fetch(
        `https://tunnelsats.com/api/public/v1/subscription/${paymentHash}`,
      )
      if (res.ok) {
        const data = await res.json()
        if (data.status === 'paid') {
          clearInterval(activePollingInterval)
          activePollingInterval = null
          paidClaimInFlight = paymentHash
          setPaymentStatus(
            'Payment confirmed! Provisioning tunnel...',
            'pulse-green',
          )
          await claimAndSaveConfig(paymentHash, keypair, targetNode)
        }
      }
    } catch (err) {
      console.warn('Polling status error:', err)
    }
  }, 3500)
}

// Claim field validation, mirroring bridge.py (assemble_claimed_config).
const WG_KEY_RE = /^[A-Za-z0-9+/]{43}=$/
const HOSTNAME_RE =
  /^(?=.{1,253}$)[A-Za-z0-9](?:[A-Za-z0-9-]{0,61}[A-Za-z0-9])?(?:\.[A-Za-z0-9](?:[A-Za-z0-9-]{0,61}[A-Za-z0-9])?)*$/

function isIPv4(value) {
  const parts = value.split('.')
  return (
    parts.length === 4 &&
    parts.every((p) => /^(0|[1-9]\d{0,2})$/.test(p) && Number(p) <= 255)
  )
}

function isIPv6(value) {
  if (!value.includes(':') || !/^[0-9A-Fa-f:.]+$/.test(value)) return false
  try {
    new URL(`http://[${value}]/`)
    return true
  } catch {
    return false
  }
}

// An address or network with an optional prefix length.
function isIpWithPrefix(value) {
  const [ip, prefix, ...rest] = value.split('/')
  if (rest.length) return false
  const v4 = isIPv4(ip)
  if (!v4 && !isIPv6(ip)) return false
  if (prefix === undefined) return true
  return /^\d{1,3}$/.test(prefix) && Number(prefix) <= (v4 ? 32 : 128)
}

function isEndpoint(value) {
  const parts = value.split(':')
  if (parts.length !== 2) return false
  const [host, port] = parts
  return (
    HOSTNAME_RE.test(host) &&
    /^\d{1,5}$/.test(port) &&
    Number(port) >= 1 &&
    Number(port) <= 65535
  )
}

// A claim is only accepted for the key generated here; its config is built
// from the structured fields and the local private key. fullConfig, config
// and any private key in the response are never used, and every value is
// validated so the response cannot add lines (a PostUp) to the config or
// save a config that cannot form a tunnel.
function assembleWireguardConfig(claimData, keypair) {
  const server = claimData.server || {}
  const peer = claimData.peer || {}
  if (peer.publicKey !== keypair.publicKey) {
    throw new Error(
      'The claim was provisioned for a different WireGuard key; not saving it.',
    )
  }
  const vpnPort = claimData.vpnPort
  if (!Number.isInteger(vpnPort) || vpnPort < 1 || vpnPort > 65535) {
    throw new Error('The claim has no valid VPN port.')
  }
  const str = (v) => typeof v === 'string' && v === v.trim() && v !== ''
  const allowedIPs =
    server.allowedIPs === undefined || server.allowedIPs === null
      ? '0.0.0.0/0, ::/0'
      : server.allowedIPs
  const valid =
    str(server.endpoint) &&
    isEndpoint(server.endpoint) &&
    str(server.publicKey) &&
    WG_KEY_RE.test(server.publicKey) &&
    str(peer.address) &&
    isIpWithPrefix(peer.address) &&
    typeof allowedIPs === 'string' &&
    allowedIPs.split(',').every((n) => isIpWithPrefix(n.trim())) &&
    (peer.presharedKey == null ||
      (typeof peer.presharedKey === 'string' &&
        WG_KEY_RE.test(peer.presharedKey))) &&
    (claimData.subscriptionEnd == null ||
      (str(claimData.subscriptionEnd) &&
        !Number.isNaN(Date.parse(claimData.subscriptionEnd))))
  if (!valid) {
    throw new Error('The claim is incomplete or malformed.')
  }

  const lines = [
    '[Interface]',
    `PrivateKey = ${keypair.privateKey}`,
    `Address = ${peer.address}`,
  ]
  if (claimData.subscriptionEnd) {
    lines.push(
      `# Valid Until: ${new Date(claimData.subscriptionEnd).toISOString()}`,
    )
  }
  lines.push(`# VPNPort: ${vpnPort}`)
  lines.push(`# Server: ${server.endpoint.split(':')[0]}`)
  lines.push('')
  lines.push('[Peer]')
  lines.push(`PublicKey = ${server.publicKey}`)
  lines.push(`Endpoint = ${server.endpoint}`)
  lines.push(
    `AllowedIPs = ${allowedIPs
      .split(',')
      .map((n) => n.trim())
      .join(', ')}`,
  )
  if (peer.presharedKey != null) {
    lines.push(`PresharedKey = ${peer.presharedKey}`)
  }
  return lines.join('\n') + '\n'
}

// A paid claim is retried for as long as the page is open while the outcome
// is transient: the private key only exists in this page, so giving up would
// strand the payment. Only a claim that can never be accepted stops it.
const CLAIM_RETRY_BASE_MS = 3500
const CLAIM_RETRY_MAX_MS = 60000

function isTransientStatus(status) {
  return status === 429 || status >= 500
}

function retryClaim(paymentHash, keypair, targetNode, attempt, reason) {
  const delay = Math.min(
    CLAIM_RETRY_BASE_MS * 2 ** (attempt - 1),
    CLAIM_RETRY_MAX_MS,
  )
  setPaymentStatus(
    `${reason} Retrying in ${Math.round(delay / 1000)} s. Keep this page open (payment hash ${paymentHash}).`,
    'pulse-amber',
  )
  setTimeout(
    () => claimAndSaveConfig(paymentHash, keypair, targetNode, attempt + 1),
    delay,
  )
}

async function claimAndSaveConfig(
  paymentHash,
  keypair,
  targetNode,
  attempt = 1,
) {
  try {
    if (targetNode !== 'lnd' && targetNode !== 'cln') {
      throw new Error('No Lightning node was chosen for this checkout.')
    }
    let claimRes
    try {
      claimRes = await fetch(
        'https://tunnelsats.com/api/public/v1/subscription/claim',
        {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            paymentHash: paymentHash,
            wgPublicKey: keypair.publicKey,
          }),
        },
      )
    } catch (err) {
      retryClaim(
        paymentHash,
        keypair,
        targetNode,
        attempt,
        `Network error: ${err.message}.`,
      )
      return
    }

    if (isTransientStatus(claimRes.status)) {
      retryClaim(
        paymentHash,
        keypair,
        targetNode,
        attempt,
        `The TunnelSats API is unavailable (HTTP ${claimRes.status}).`,
      )
      return
    }
    if (!claimRes.ok) {
      throw new Error(`Failed to claim configuration (HTTP ${claimRes.status})`)
    }

    const claimData = await claimRes.json()
    if (claimRes.status === 202 || claimData.status === 'processing') {
      retryClaim(
        paymentHash,
        keypair,
        targetNode,
        attempt,
        'Payment confirmed! The tunnel is being provisioned.',
      )
      return
    }
    const fullConfig = assembleWireguardConfig(claimData, keypair)

    // Save to local container bridge
    let saveRes
    try {
      saveRes = await fetch('/api/config/save', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'X-Requested-With': 'XMLHttpRequest',
          'X-TunnelSats-CSRF': getCsrfToken(),
          'X-CSRF-Token': getCsrfToken(),
        },
        body: JSON.stringify({
          config: fullConfig,
          target_node: targetNode,
        }),
      })
    } catch (err) {
      retryClaim(
        paymentHash,
        keypair,
        targetNode,
        attempt,
        `Could not reach StartOS to save the configuration: ${err.message}.`,
      )
      return
    }

    if (isTransientStatus(saveRes.status)) {
      retryClaim(
        paymentHash,
        keypair,
        targetNode,
        attempt,
        `Saving the configuration failed (HTTP ${saveRes.status}).`,
      )
      return
    }
    if (!saveRes.ok) {
      const errJson = await saveRes.json().catch(() => ({}))
      throw new Error(
        errJson.error || 'Failed to save configuration to StartOS',
      )
    }

    if (paidClaimInFlight === paymentHash) paidClaimInFlight = null
    setPaymentStatus(
      'Configuration provisioned! Accept the routing prompt on your Lightning node.',
      'pulse-green',
    )
    setTimeout(() => {
      closePaymentModal()
      delete document.getElementById('view-storefront').dataset.userNavigated
      fetchStatus(true)
      alert(
        'Configuration provisioned successfully!\n\nTo activate routing, accept the 1-click prompt on your Lightning node: "Route [Node] through the TunnelSats tunnel". Your node will start its in-container WireGuard tunnel and announce its public address.',
      )
    }, 1600)
  } catch (err) {
    console.error('Claim error:', err)
    // A permanent failure: retrying cannot save this claim, so a new
    // checkout is allowed again.
    if (paidClaimInFlight === paymentHash) paidClaimInFlight = null
    // Nothing was saved. The payment hash lets support recover the paid
    // order; keep this page open, the private key only exists here.
    setPaymentStatus(
      `Provisioning error: ${err.message} Keep this page open and contact support with payment hash ${paymentHash}.`,
      'pulse-amber',
    )
  }
}

// ─────────────────────────────────────────────
// Bring Your Own Config (BYOC)
// ─────────────────────────────────────────────
async function saveManualConfig() {
  const textarea = document.getElementById('byoc-conf-input')
  const conf = textarea ? textarea.value.trim() : ''
  if (!conf) {
    alert('Please paste a valid WireGuard configuration file.')
    return
  }

  try {
    const res = await fetch('/api/config/save', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'X-Requested-With': 'XMLHttpRequest',
        'X-TunnelSats-CSRF': getCsrfToken(),
        'X-CSRF-Token': getCsrfToken(),
      },
      body: JSON.stringify({ config: conf, target_node: selectedNode }),
    })

    if (res.ok) {
      alert(
        'Configuration saved successfully!\n\nTo complete activation, accept the 1-click prompt on your Lightning node: "Route [Node] through the TunnelSats tunnel".',
      )
      if (textarea) textarea.value = ''
      delete document.getElementById('view-storefront').dataset.userNavigated
      fetchStatus(true)
    } else {
      const err = await res.json().catch(() => ({ error: 'Validation failed' }))
      alert(`Failed to save configuration: ${err.error || 'Unknown error'}`)
    }
  } catch (e) {
    alert(`Error saving configuration: ${e.message}`)
  }
}

// ─────────────────────────────────────────────
// Renewal Flow
// ─────────────────────────────────────────────
const SERVER_DOMAIN_TO_ID = {
  'de2.tunnelsats.com': 'eu-de',
  'de3.tunnelsats.com': 'eu-de',
  'ch1.tunnelsats.com': 'eu-ch',
  'us3.tunnelsats.com': 'us-east',
  'us1.tunnelsats.com': 'us-east',
  'us2.tunnelsats.com': 'us-west',
  'sg1.tunnelsats.com': 'asia-sg',
  'au1.tunnelsats.com': 'oc-au',
  'br1.tunnelsats.com': 'sa-br',
}

function mapDomainToServerId(domainOrId) {
  if (!domainOrId || domainOrId === 'Unknown' || domainOrId === 'None')
    return null
  const lower = String(domainOrId).toLowerCase().trim()
  if (SERVER_DOMAIN_TO_ID[lower]) return SERVER_DOMAIN_TO_ID[lower]
  if (
    [
      'eu-de',
      'eu-ch',
      'us-east',
      'us-west',
      'asia-sg',
      'sa-br',
      'oc-au',
    ].includes(lower)
  ) {
    return lower
  }
  if (
    lower.includes('de2') ||
    lower.includes('de3') ||
    lower.includes('frankfurt') ||
    lower.includes('nuremberg') ||
    lower.includes('germany')
  )
    return 'eu-de'
  if (
    lower.includes('ch1') ||
    lower.includes('zurich') ||
    lower.includes('geneva') ||
    lower.includes('switzerland')
  )
    return 'eu-ch'
  if (
    lower.includes('us3') ||
    lower.includes('us1') ||
    lower.includes('ashburn') ||
    lower.includes('new york') ||
    lower.includes('us-east')
  )
    return 'us-east'
  if (
    lower.includes('us2') ||
    lower.includes('hillsboro') ||
    lower.includes('oregon') ||
    lower.includes('los angeles') ||
    lower.includes('us-west')
  )
    return 'us-west'
  if (
    lower.includes('sg1') ||
    lower.includes('singapore') ||
    lower.includes('asia-sg')
  )
    return 'asia-sg'
  if (
    lower.includes('au1') ||
    lower.includes('sydney') ||
    lower.includes('australia') ||
    lower.includes('oc-au')
  )
    return 'oc-au'
  if (
    lower.includes('br1') ||
    lower.includes('sao paulo') ||
    lower.includes('brazil') ||
    lower.includes('sa-br')
  )
    return 'sa-br'
  return null
}

function openRenewalModal() {
  const modal = document.getElementById('renewal-modal')
  if (!modal) return

  const serverSelectEl = document.getElementById('renewal-server-select')
  const pubkeyEl = document.getElementById('renewal-pubkey')
  const expiryEl = document.getElementById('renewal-current-expiry')

  // Only derive from server domain or server metadata, never from public_ip
  const currentServer =
    statusData.server && statusData.server !== 'Unknown'
      ? statusData.server
      : statusData.server_domain && statusData.server_domain !== 'Unknown'
        ? statusData.server_domain
        : ''

  const canonicalServerId = mapDomainToServerId(currentServer)
  if (serverSelectEl) {
    if (canonicalServerId) {
      serverSelectEl.value = canonicalServerId
    } else {
      serverSelectEl.value = ''
    }
  }

  if (pubkeyEl) pubkeyEl.textContent = statusData.pubkey || '...'
  if (expiryEl) expiryEl.textContent = statusData.expiry_formatted || '...'

  modal.showModal()
}

function closeRenewalModal() {
  const modal = document.getElementById('renewal-modal')
  if (!modal) return
  modal.close()
}

async function startRenewalCheckout() {
  const pubkey = statusData.pubkey
  if (!pubkey || pubkey === 'None' || pubkey === 'Unknown') {
    alert(
      'No active WireGuard public key found for renewal. Please configure a tunnel first.',
    )
    return
  }

  const serverSelectEl = document.getElementById('renewal-server-select')
  let serverId = serverSelectEl ? serverSelectEl.value : ''
  if (!serverId) {
    const rawServer =
      statusData.server && statusData.server !== 'Unknown'
        ? statusData.server
        : statusData.server_domain && statusData.server_domain !== 'Unknown'
          ? statusData.server_domain
          : ''
    serverId = mapDomainToServerId(rawServer)
  }

  if (!serverId) {
    alert('Please select your VPN server region before renewing.')
    return
  }

  closeRenewalModal()
  openPaymentModal()
  setPaymentStatus('Requesting renewal invoice...', 'pulse-amber')

  try {
    const res = await fetch(
      'https://tunnelsats.com/api/public/v1/subscription/renew',
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          serverId: serverId,
          duration: selectedRenewalDuration,
          wgPublicKey: pubkey,
        }),
      },
    )

    if (!res.ok) {
      throw new Error(`Renewal request failed (HTTP ${res.status})`)
    }

    const data = await res.json()
    renderPaymentDetails(
      data.invoice,
      data.amountSats ||
        calculatePlanPrice(selectedRenewalDuration, currentSatsPerDollar),
      `${selectedRenewalDuration} Month${selectedRenewalDuration > 1 ? 's' : ''} Renewal`,
    )
    pollRenewalSettlement(data.paymentHash)
  } catch (err) {
    console.error('Renewal error:', err)
    setPaymentStatus(`Renewal error: ${err.message}`, 'pulse-amber')
  }
}

function pollRenewalSettlement(paymentHash) {
  if (activePollingInterval) clearInterval(activePollingInterval)
  activePaymentHash = paymentHash

  activePollingInterval = setInterval(async () => {
    try {
      const res = await fetch(
        `https://tunnelsats.com/api/public/v1/subscription/${paymentHash}`,
      )
      if (res.ok) {
        const data = await res.json()
        if (data.status === 'paid') {
          clearInterval(activePollingInterval)
          activePollingInterval = null
          setPaymentStatus(
            'Renewal settled! Synchronizing status...',
            'pulse-green',
          )

          if (data.new_expiry || data.newExpiry) {
            statusData.expires_at = data.new_expiry || data.newExpiry
            updateUI()
          }

          setTimeout(async () => {
            closePaymentModal()
            await fetchStatus(true) // Triggers immediate bridge-side lazy_sync
          }, 1500)
        }
      }
    } catch (err) {
      console.warn('Polling status error:', err)
    }
  }, 3500)
}

// ─────────────────────────────────────────────
// Export Configuration
// ─────────────────────────────────────────────
function exportConfiguration() {
  const modal = document.getElementById('export-modal')
  if (modal) {
    modal.showModal()
  } else {
    alert(
      'To export your WireGuard configuration with your private key securely masked, navigate to StartOS Actions → Export WireGuard Configuration.',
    )
  }
}

function closeExportModal() {
  const modal = document.getElementById('export-modal')
  if (modal) modal.close()
}

// ─────────────────────────────────────────────
// Modals Open / Close Helpers
// ─────────────────────────────────────────────
function openBandwidthModal() {
  const modal = document.getElementById('bandwidth-modal')
  if (modal) modal.showModal()
}

function closeBandwidthModal() {
  const modal = document.getElementById('bandwidth-modal')
  if (modal) modal.close()
}

function openPaymentModal() {
  const modal = document.getElementById('payment-modal')
  if (modal) modal.showModal()
}

function closePaymentModal() {
  const modal = document.getElementById('payment-modal')
  if (modal) {
    if (activePollingInterval) {
      clearInterval(activePollingInterval)
      activePollingInterval = null
    }
    modal.close()
  }
}

function setPaymentStatus(text, indicatorClass) {
  const textEl = document.getElementById('payment-status-text')
  const dotEl = document.getElementById('payment-status-dot')
  if (textEl) textEl.textContent = text
  if (dotEl) {
    dotEl.className = `status-indicator-dot ${indicatorClass}`
  }
}

function openFaqModal() {
  const modal = document.getElementById('faq-modal')
  if (modal) modal.showModal()
}

function closeFaqModal() {
  const modal = document.getElementById('faq-modal')
  if (modal) modal.close()
}

// ─────────────────────────────────────────────
// Copy Utilities
// ─────────────────────────────────────────────
function handleCopySuccess(btn, successText) {
  const originalText = btn.textContent
  btn.textContent = successText
  btn.classList.add('copied')
  setTimeout(() => {
    btn.textContent = originalText
    btn.classList.remove('copied')
  }, 1500)
}

function copyText(elementId, btn) {
  const el = document.getElementById(elementId)
  const text = el ? el.title || el.textContent : ''
  if (navigator.clipboard && navigator.clipboard.writeText) {
    navigator.clipboard
      .writeText(text)
      .then(() => handleCopySuccess(btn, 'Copied!'))
  } else {
    fallbackCopy(text, btn, 'Copied!')
  }
}

function copyInvoice(btn) {
  const input = document.getElementById('invoice-text')
  const text = input ? input.value : ''
  if (navigator.clipboard && navigator.clipboard.writeText) {
    navigator.clipboard
      .writeText(text)
      .then(() => handleCopySuccess(btn, 'Copied!'))
  } else {
    fallbackCopy(text, btn, 'Copied!')
  }
}

function fallbackCopy(text, btn, successText) {
  const textarea = document.createElement('textarea')
  textarea.value = text
  textarea.style.position = 'fixed'
  textarea.style.opacity = '0'
  document.body.appendChild(textarea)
  textarea.select()
  try {
    document.execCommand('copy')
    handleCopySuccess(btn, successText)
  } catch (err) {
    console.error('Fallback copy failed', err)
  }
  document.body.removeChild(textarea)
}

// Modal Backdrop Click Handlers
;[
  'bandwidth-modal',
  'payment-modal',
  'renewal-modal',
  'faq-modal',
  'export-modal',
].forEach((id) => {
  const modal = document.getElementById(id)
  if (modal) {
    modal.addEventListener('click', (e) => {
      const inner = modal.querySelector(
        '.modal-dialog-inner, .faq-dialog-inner',
      )
      if (inner) {
        if (!inner.contains(e.target)) {
          modal.close()
          if (id === 'payment-modal' && activePollingInterval) {
            clearInterval(activePollingInterval)
            activePollingInterval = null
          }
        }
      } else if (e.target === modal) {
        modal.close()
        if (id === 'payment-modal' && activePollingInterval) {
          clearInterval(activePollingInterval)
          activePollingInterval = null
        }
      }
    })
    modal.addEventListener('cancel', () => {
      if (id === 'payment-modal' && activePollingInterval) {
        clearInterval(activePollingInterval)
        activePollingInterval = null
      }
    })
  }
})

// Initial Status & Pricing Fetch
fetchStatus()
updateDynamicPricing()

// Sensible gentle polling (every 60s while dashboard open)
setInterval(() => {
  if (!document.hidden) {
    fetchStatus()
  }
}, 60000)

// Refresh BTC/USD exchange rate every 10 minutes
setInterval(() => {
  if (!document.hidden) {
    updateDynamicPricing()
  }
}, 600000)
