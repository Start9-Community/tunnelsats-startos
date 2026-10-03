/**
 * The settlement tick: finishes paid Buy/Renew payments on-device.
 *
 * bridge.py `settle` does the work (claim, assemble, save, confirm; see the
 * settlement section there). This module runs it, clears the Pay Invoice
 * tasks of settled or expired payments and maps the result to a health
 * status. It is free of SDK imports so the tests run the real code; main.ts
 * injects the exec and clearTask effects.
 */

import type { MetaLock } from './metaLock'

export type TargetNode = 'lnd' | 'cln' | 'eclair'
export type PaymentKind = 'order' | 'renewal' | 'reset'
const PAYMENT_KINDS: readonly string[] = ['order', 'renewal', 'reset']

const TARGET_NODES: readonly string[] = ['lnd', 'cln', 'eclair']

/**
 * Replay ID of the Pay Invoice task a Buy (order) or Renew (renewal) raises
 * on `node` for one payment. Unique per payment, so clearing a settled
 * payment's task can never remove a newer payment's task. Must match
 * pay_task_replay_id() in bridge.py, which queues these IDs for clearing.
 */
export function payTaskReplayId(
  kind: PaymentKind,
  node: TargetNode,
  paymentHash: string,
): string {
  return `tunnelsats-${kind}:${node}:${paymentHash.slice(0, 16)}`
}

/**
 * The pay task of the pending entry that a new payment (`newHash`) is about
 * to replace, or null. A Buy/Renew clears it: the replaced payment is no
 * longer tracked, so its invoice must not stay on the node as a task.
 */
export function replacedPayTaskId(
  kind: PaymentKind,
  previous: { paymentHash?: string; targetNode?: string } | null | undefined,
  newHash: string,
): string | null {
  if (
    !previous?.paymentHash ||
    previous.paymentHash === newHash ||
    !previous.targetNode ||
    !TARGET_NODES.includes(previous.targetNode)
  ) {
    return null
  }
  return payTaskReplayId(
    kind,
    previous.targetNode as TargetNode,
    previous.paymentHash,
  )
}

export const INVOICE_TTL_MS = 60 * 60 * 1000
export const MAX_PREVIOUS_PENDING_ORDERS = 5

/**
 * Matches settlement lastError messages written by bridge.py only after
 * payment was received (mirroring _PAID_ERROR_RE in bridge.py).
 */
export const PAID_ERROR_RE =
  /payment was received|already been paid|renewal is paid|bandwidth reset was applied|bandwidth reset failed|claim|provisioning failed|stored private key/i

export interface PendingOrderRecord {
  paymentHash: string
  orderId: string
  privateKey: string
  publicKey: string
  targetNode: TargetNode
  serverId: string
  createdAt: string
  duration?: number
  invoice?: string
  amountSats?: number
  expiresAt?: string
  paymentReceivedFor?: string
  lastError?: string
  nextAttemptAt?: string
}

/**
 * A request that would replace a paid invoice awaiting settlement, an
 * in-flight NWC auto-renewal, or (for dashboard intents) a still-payable
 * invoice of the same kind.
 */
export class PendingPaymentConflictError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'PendingPaymentConflictError'
  }
}

/**
 * True when a pending entry has already been paid locally or recorded a
 * post-payment settlement error, so it must never be overwritten before the
 * settlement tick finishes it.
 */
export function isPaymentReceived(
  pending:
    | {
        paymentHash?: string
        paymentReceivedFor?: string
        paidViaNwc?: boolean
        lastError?: string
      }
    | null
    | undefined,
): boolean {
  if (!pending || !pending.paymentHash) return false
  return (
    pending.paymentReceivedFor === pending.paymentHash ||
    pending.paidViaNwc === true ||
    Boolean(
      typeof pending.lastError === 'string' &&
      PAID_ERROR_RE.test(pending.lastError),
    )
  )
}

/**
 * Until when (epoch ms) an unpaid pending payment may still be paid, whether
 * or not its invoice was stored: records written before invoices were kept
 * have none, yet their invoice can still be paid on the node. Returns
 * Infinity when the record has no usable time (fail closed), null when
 * nothing unpaid is pending or it has expired. Paid records return null;
 * callers check isPaymentReceived separately.
 */
export function unsettledUntil(
  pending:
    | {
        paymentHash?: string
        paymentReceivedFor?: string
        paidViaNwc?: boolean
        lastError?: string
        createdAt?: string
        expiresAt?: string
      }
    | null
    | undefined,
  now: Date,
): number | null {
  if (!pending || !pending.paymentHash) return null
  if (isPaymentReceived(pending)) return null
  const createdMs = pending.createdAt ? Date.parse(pending.createdAt) : NaN
  const expiresMs = pending.expiresAt
    ? Date.parse(pending.expiresAt)
    : createdMs + INVOICE_TTL_MS
  if (!Number.isFinite(expiresMs)) return Number.POSITIVE_INFINITY
  return expiresMs > now.getTime() ? expiresMs : null
}

/**
 * True when an automatic NWC renewal payment has been dispatched for an
 * unexpired renewal invoice or has an active in-flight hold.
 */
export function isNwcRenewalInFlight(
  pending:
    | {
        paymentHash?: string
        paymentReceivedFor?: string
        paidViaNwc?: boolean
        lastError?: string
        nwcAttempted?: boolean
        nwcPayInFlightUntil?: string
        raisePayTask?: boolean
        createdAt?: string
        expiresAt?: string
      }
    | null
    | undefined,
  now: Date,
): boolean {
  if (!pending || !pending.paymentHash) return false
  const inFlightMs = pending.nwcPayInFlightUntil
    ? Date.parse(pending.nwcPayInFlightUntil)
    : NaN
  if (Number.isFinite(inFlightMs) && inFlightMs > now.getTime()) {
    return true
  }
  if (pending.raisePayTask === true) return false
  return pending.nwcAttempted === true && unsettledUntil(pending, now) !== null
}

/**
 * The metadata patch a Buy/Renew merges together with its new pending entry:
 * it queues the replaced payment's pay task in payTasksToClear, so the
 * settlement health check clears it (retrying until acknowledged) and the
 * node never keeps offering an invoice this package no longer tracks.
 *
 * FileHelper.merge replaces arrays instead of merging them, so the patch
 * carries the whole queue: `queued` must come from the same fresh read as
 * `previous`, taken right before the merge. Returns an empty patch when
 * nothing is replaced, omitting the key, because merge() writes undefined
 * values as deletions.
 */
export function replacedPayTaskPatch(
  kind: PaymentKind,
  previous: { paymentHash?: string; targetNode?: string } | null | undefined,
  queued: readonly string[] | null | undefined,
  newHash: string,
): { payTasksToClear?: string[] } {
  const replayId = replacedPayTaskId(kind, previous, newHash)
  if (!replayId) return {}
  const tasks = (queued ?? []).filter((t) => typeof t === 'string')
  return {
    payTasksToClear: tasks.includes(replayId) ? tasks : [...tasks, replayId],
  }
}

/**
 * Preserves an unexpired replaced `pendingOrder` (including its `privateKey`)
 * in `previousPendingOrders` alongside any still-unexpired entries, deduplicated
 * by `paymentHash` and capped at the 5 most recent.
 */
export function replacedOrderPatch(
  previous:
    | {
        paymentHash?: string
        orderId?: string
        privateKey?: string
        publicKey?: string
        targetNode?: string
        serverId?: string
        createdAt?: string
        duration?: number
        invoice?: string
        amountSats?: number
        expiresAt?: string
        paymentReceivedFor?: string
        lastError?: string
        nextAttemptAt?: string
      }
    | null
    | undefined,
  existingPrevious: readonly PendingOrderRecord[] | null | undefined,
  newHash: string,
  now: Date,
): { previousPendingOrders?: PendingOrderRecord[] } {
  const canRetainPrevious = Boolean(
    previous &&
    typeof previous.paymentHash === 'string' &&
    previous.paymentHash.length > 0 &&
    previous.paymentHash !== newHash &&
    typeof previous.orderId === 'string' &&
    previous.orderId.length > 0 &&
    typeof previous.privateKey === 'string' &&
    previous.privateKey.length > 0 &&
    typeof previous.publicKey === 'string' &&
    previous.publicKey.length > 0 &&
    typeof previous.targetNode === 'string' &&
    TARGET_NODES.includes(previous.targetNode) &&
    typeof previous.serverId === 'string' &&
    previous.serverId.length > 0 &&
    typeof previous.createdAt === 'string' &&
    previous.createdAt.length > 0 &&
    unsettledUntil(previous, now) !== null,
  )

  if (!canRetainPrevious && existingPrevious === undefined) {
    return {}
  }

  const deduped: PendingOrderRecord[] = []
  for (const item of existingPrevious ?? []) {
    if (
      !item ||
      typeof item.paymentHash !== 'string' ||
      !item.paymentHash ||
      item.paymentHash === newHash ||
      typeof item.privateKey !== 'string' ||
      !item.privateKey ||
      typeof item.publicKey !== 'string' ||
      !item.publicKey ||
      (unsettledUntil(item, now) === null && !isPaymentReceived(item))
    ) {
      continue
    }
    const existingIdx = deduped.findIndex(
      (x) => x.paymentHash === item.paymentHash,
    )
    if (existingIdx !== -1) deduped.splice(existingIdx, 1)
    deduped.push(item)
  }

  if (canRetainPrevious && previous) {
    const entry: PendingOrderRecord = {
      paymentHash: previous.paymentHash!,
      orderId: previous.orderId!,
      privateKey: previous.privateKey!,
      publicKey: previous.publicKey!,
      targetNode: previous.targetNode as TargetNode,
      serverId: previous.serverId!,
      createdAt: previous.createdAt!,
      ...(previous.duration !== undefined
        ? { duration: previous.duration }
        : {}),
      ...(previous.invoice !== undefined ? { invoice: previous.invoice } : {}),
      ...(previous.amountSats !== undefined
        ? { amountSats: previous.amountSats }
        : {}),
      ...(previous.expiresAt !== undefined
        ? { expiresAt: previous.expiresAt }
        : {}),
      ...(previous.paymentReceivedFor !== undefined
        ? { paymentReceivedFor: previous.paymentReceivedFor }
        : {}),
      ...(previous.lastError !== undefined
        ? { lastError: previous.lastError }
        : {}),
      ...(previous.nextAttemptAt !== undefined
        ? { nextAttemptAt: previous.nextAttemptAt }
        : {}),
    }
    const existingIdx = deduped.findIndex(
      (x) => x.paymentHash === entry.paymentHash,
    )
    if (existingIdx !== -1) deduped.splice(existingIdx, 1)
    deduped.push(entry)
  }

  return {
    previousPendingOrders: deduped.slice(-MAX_PREVIOUS_PENDING_ORDERS),
  }
}

export interface PaymentRecordPatch {
  payTasksToClear?: string[]
  previousPendingOrders?: PendingOrderRecord[]
}

/** What recordPaymentThenRaiseTask needs from the package; injected. */
export interface PaymentRecordOps {
  /** Current clock; defaults to `() => new Date()` when omitted. */
  now?(): Date
  /**
   * The cross-runtime metadata lock (metaLockFor): the read and the record
   * run under it, so a bridge.py write cannot land between them.
   */
  lockMeta: MetaLock
  /** A fresh read of the pending entry being replaced and the queue. */
  readCurrent(): Promise<{
    pending?: {
      paymentHash?: string
      targetNode?: string
      paymentReceivedFor?: string
      lastError?: string
      paidViaNwc?: boolean
      nwcAttempted?: boolean
      nwcPayInFlightUntil?: string
      raisePayTask?: boolean
      createdAt?: string
      expiresAt?: string
      invoice?: string
      orderId?: string
      privateKey?: string
      publicKey?: string
      serverId?: string
      duration?: number
      amountSats?: number
      nextAttemptAt?: string
    } | null
    previousPendingOrders?: PendingOrderRecord[]
    payTasksToClear?: string[]
  } | null>
  /** Writes the new pending entry together with the given patch. */
  record(patch: PaymentRecordPatch): Promise<unknown>
  /** Raises the new payment's Pay Invoice task. */
  raiseTask(): Promise<unknown>
}

// Buy, Renew and Reset share one queue: all rewrite payTasksToClear.
let paymentRecordTail: Promise<unknown> = Promise.resolve()

/**
 * A dashboard request resumed after StartOS restarted mid-request (reuseOnly)
 * whose recorded invoice is gone: it is never given a new invoice.
 */
export class NothingToResumeError extends Error {
  constructor() {
    super(
      'StartOS restarted while this request was being processed, and no payable invoice from it remains. Request it again.',
    )
    this.name = 'NothingToResumeError'
  }
}

/**
 * Runs `job` after every earlier payment job has finished, one at a time.
 * All package procedures share one JS runtime, like the handoff queue
 * (createHandoffQueue). A job must not enqueue another one and wait for it:
 * that would wait on itself.
 */
export function runPaymentExclusive<T>(job: () => Promise<T>): Promise<T> {
  const run = paymentRecordTail.then(job, job)
  paymentRecordTail = run.catch(() => undefined)
  return run
}

/**
 * The body of recordPaymentThenRaiseTask, for callers that already run
 * inside runPaymentExclusive (and must read their own state there too).
 */
export async function recordThenRaise(
  kind: PaymentKind,
  newHash: string,
  ops: PaymentRecordOps,
): Promise<void> {
  // bridge.py rewrites payTasksToClear too (settlement, acknowledgements),
  // and the patch carries the whole queue: read and record under its lock.
  // The task is raised after the release; nothing under the lock may wait
  // for bridge.py or StartOS.
  await ops.lockMeta(async () => {
    const current = await ops.readCurrent()
    const now = (ops.now ?? (() => new Date()))()
    const pending = current?.pending
    if (pending?.paymentHash && pending.paymentHash !== newHash) {
      if (isPaymentReceived(pending)) {
        throw new PendingPaymentConflictError(
          kind === 'renewal'
            ? 'A previous renewal has already been paid and is being applied. Wait for it to finish settling before starting another renewal.'
            : 'A previous subscription order has already been paid and is being provisioned. Wait for it to finish settling before starting a new purchase.',
        )
      }
      if (kind === 'renewal' && isNwcRenewalInFlight(pending, now)) {
        throw new PendingPaymentConflictError(
          'An automatic NWC renewal payment is already in progress or awaiting confirmation for this subscription. Wait for it to settle before starting another renewal.',
        )
      }
    }
    await ops.record({
      ...replacedPayTaskPatch(kind, pending, current?.payTasksToClear, newHash),
      ...(kind === 'order'
        ? replacedOrderPatch(
            pending,
            current?.previousPendingOrders,
            newHash,
            now,
          )
        : {}),
    })
  })
  await ops.raiseTask()
}

/**
 * Records a new pending payment (queueing the task of the one it replaces)
 * and then raises its pay task, one purchase at a time. Without this, a
 * second Buy/Renew could replace the first between its record and its
 * task: the tick would clear and acknowledge the first task's ID before
 * the task existed, and the task raised afterwards would never be cleared.
 * The read happens inside the queue, so each purchase sees the previous
 * one's record.
 */
export function recordPaymentThenRaiseTask(
  kind: PaymentKind,
  newHash: string,
  ops: PaymentRecordOps,
): Promise<void> {
  return runPaymentExclusive(() => recordThenRaise(kind, newHash, ops))
}

const TERMINAL_RESULTS = [
  'provisioned',
  'renewed',
  'reset',
  'superseded',
  'expired',
] as const
const RESULTS = [...TERMINAL_RESULTS, 'waiting', 'failed'] as const

export interface SettlementOutcome {
  kind: PaymentKind
  result: (typeof RESULTS)[number]
  message: string
  paymentHash: string
}

export interface SettlementReport {
  outcomes: SettlementOutcome[]
  clearPayTasks: string[]
  busy: boolean
}

export interface ExecResult {
  exitCode: number | null
  stdout: string | Buffer
  stderr: string | Buffer
}

export interface SettlementOps {
  /** Runs `bridge.py settle`. */
  settle(): Promise<ExecResult>
  /** Runs `bridge.py settle-ack <ids...>`. */
  ack(replayIds: string[]): Promise<ExecResult>
  /** Clears this package's task with that replay ID (a no-op if absent). */
  clearTask(replayId: string): Promise<unknown>
}

/**
 * Most severe first: `failed` (a payment could not be finished, or the tick
 * itself failed), `clearing-failed` (a paid invoice's task is still on the
 * node), `waiting`, `settled`, then `idle`/`busy`.
 */
export type SettlementStatus =
  | { state: 'idle' }
  | { state: 'busy' }
  | { state: 'failed'; error: string }
  | { state: 'clearing-failed'; error: string }
  | { state: 'waiting'; message: string }
  | { state: 'settled'; message: string }

const text = (value: string | Buffer) => value.toString()

function lastLine(value: string | Buffer): string {
  const lines = text(value).trim().split('\n')
  return lines[lines.length - 1]?.trim() ?? ''
}

const errorMessage = (e: unknown) =>
  e instanceof Error ? e.message : String(e)

function isOutcome(value: unknown): value is SettlementOutcome {
  if (typeof value !== 'object' || value === null) return false
  const o = value as Record<string, unknown>
  return (
    PAYMENT_KINDS.includes(o.kind as string) &&
    RESULTS.includes(o.result as SettlementOutcome['result']) &&
    typeof o.message === 'string' &&
    typeof o.paymentHash === 'string'
  )
}

/** Parses `bridge.py settle` output; throws on anything unexpected. */
export function parseSettlementReport(stdout: string): SettlementReport {
  const data: unknown = JSON.parse(stdout)
  if (typeof data !== 'object' || data === null) {
    throw new Error('settle printed no report')
  }
  const { outcomes, clearPayTasks, busy } = data as Record<string, unknown>
  if (
    !Array.isArray(outcomes) ||
    !outcomes.every(isOutcome) ||
    !Array.isArray(clearPayTasks) ||
    !clearPayTasks.every((t) => typeof t === 'string') ||
    typeof busy !== 'boolean'
  ) {
    throw new Error('settle printed an unexpected report')
  }
  return { outcomes, clearPayTasks, busy }
}

/**
 * Clears each queued pay task, then acknowledges the cleared ones so
 * bridge.py stops listing them. Returns the first error, if any; anything
 * not acknowledged is listed (and cleared, a no-op) again next tick.
 */
async function clearPayTasks(
  ops: SettlementOps,
  replayIds: string[],
): Promise<string | null> {
  const cleared: string[] = []
  let error: string | null = null
  for (const id of replayIds) {
    try {
      await ops.clearTask(id)
      cleared.push(id)
    } catch (e) {
      error ??= errorMessage(e)
    }
  }
  if (cleared.length > 0) {
    try {
      const res = await ops.ack(cleared)
      if (res.exitCode !== 0) {
        error ??= lastLine(res.stderr) || 'settle-ack failed'
      }
    } catch (e) {
      error ??= errorMessage(e)
    }
  }
  return error
}

export async function runSettlementTick(
  ops: SettlementOps,
): Promise<SettlementStatus> {
  let report: SettlementReport
  try {
    const res = await ops.settle()
    if (res.exitCode !== 0) {
      return {
        state: 'failed',
        error: lastLine(res.stderr) || lastLine(res.stdout) || 'settle failed',
      }
    }
    report = parseSettlementReport(text(res.stdout))
  } catch (e) {
    return { state: 'failed', error: errorMessage(e) }
  }
  if (report.busy) return { state: 'busy' }

  const clearError = await clearPayTasks(ops, report.clearPayTasks)

  const failed = report.outcomes.find((o) => o.result === 'failed')
  if (failed) return { state: 'failed', error: failed.message }
  if (clearError) return { state: 'clearing-failed', error: clearError }
  const waiting = report.outcomes.filter((o) => o.result === 'waiting')
  if (waiting.length > 0) {
    return {
      state: 'waiting',
      message: waiting.map((o) => o.message).join(' '),
    }
  }
  if (report.outcomes.length > 0) {
    return {
      state: 'settled',
      message: report.outcomes.map((o) => o.message).join(' '),
    }
  }
  return { state: 'idle' }
}
