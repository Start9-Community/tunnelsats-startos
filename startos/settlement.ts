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

/** What recordPaymentThenRaiseTask needs from the package; injected. */
export interface PaymentRecordOps {
  /**
   * The cross-runtime metadata lock (metaLockFor): the read and the record
   * run under it, so a bridge.py write cannot land between them.
   */
  lockMeta: MetaLock
  /** A fresh read of the pending entry being replaced and the queue. */
  readCurrent(): Promise<{
    pending?: { paymentHash?: string; targetNode?: string } | null
    payTasksToClear?: string[]
  } | null>
  /** Writes the new pending entry together with the given patch. */
  record(patch: { payTasksToClear?: string[] }): Promise<unknown>
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
    await ops.record(
      replacedPayTaskPatch(
        kind,
        current?.pending,
        current?.payTasksToClear,
        newHash,
      ),
    )
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
