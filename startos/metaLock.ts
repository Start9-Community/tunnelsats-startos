/**
 * The cross-runtime lock for tunnelsats-meta.json, config.json and the conf
 * file (#94).
 *
 * bridge.py serializes its read-modify-writes with meta_lock, an flock on
 * tunnelsats-meta.json.lock. Node cannot flock, so the TypeScript writers
 * take the same lock through a holder process: `bridge.py meta-lock` takes
 * it, prints `locked`, and keeps it until its stdin is closed. The kernel
 * releases it when the holder exits, so a crashed runtime (whose end of the
 * pipe closes) never leaves it taken. While the job runs this side sends a
 * heartbeat that renews the holder's lease: a slow write keeps the lock, an
 * owner whose event loop hangs loses it. A job whose holder exited before
 * the release fails with a MetaLockError instead of reporting success.
 *
 * Nothing that waits for bridge.py (an exec of `bridge.py settle`, an API
 * request, a task call) may run under the lock: bridge.py blocks on the
 * same lock. Hold it for the file read and write only.
 *
 * Fails closed: when the lock cannot be taken the job does not run and the
 * caller gets a MetaLockError, so nothing is written unlocked.
 */
import { AsyncLocalStorage } from 'node:async_hooks'
import type { ChildProcess } from 'node:child_process'
import type { T } from '@start9labs/start-sdk'
import { sdk } from './sdk'

/** Longer than the holder's own acquire timeout, so it reports first. */
export const META_LOCK_ACQUIRE_TIMEOUT_MS = 40_000
export const META_LOCK_RELEASE_TIMEOUT_MS = 5_000
/** Well inside bridge.py's META_LOCK_LEASE (30 s). */
export const META_LOCK_HEARTBEAT_MS = 5_000

/** Starts one `bridge.py meta-lock` holder with piped stdio. */
export type HolderSpawner = () => Promise<ChildProcess>
/**
 * Provides a spawner for the duration of `use` (production: a temporary
 * subcontainer of the package image, with the main volume at /data).
 */
export type HolderScope = <R>(
  use: (spawn: HolderSpawner) => Promise<R>,
) => Promise<R>
/** Runs `job` while this runtime holds the metadata lock. */
export type MetaLock = <R>(job: () => Promise<R>) => Promise<R>

export interface MetaLockOptions {
  acquireTimeoutMs?: number
  releaseTimeoutMs?: number
  heartbeatMs?: number
}

export class MetaLockError extends Error {
  constructor(detail: string) {
    super(`Could not lock the TunnelSats metadata: ${detail}`)
    this.name = 'MetaLockError'
  }
}

// Set while a job holds the lock: a nested request runs inside the outer
// hold instead of waiting for it (flock is not reentrant across holders).
// `active` is cleared as soon as the outer job finishes, so a deferred
// callback that outlives the job cannot bypass locking.
const holding = new AsyncLocalStorage<{ active: boolean }>()
// One holder at a time per runtime: all package procedures share one JS
// runtime, and a second holder would only queue on the flock.
let tail: Promise<unknown> = Promise.resolve()

function text(chunk: unknown): string {
  return Buffer.isBuffer(chunk) ? chunk.toString('utf-8') : String(chunk)
}

function lastLine(output: string): string {
  const line = output.trim().split('\n').pop() ?? ''
  try {
    const parsed = JSON.parse(line) as { error?: unknown }
    if (typeof parsed?.error === 'string') return parsed.error
  } catch {
    // Not the holder's JSON error: report the raw line.
  }
  return line
}

async function holdWhile<R>(
  spawn: HolderSpawner,
  job: () => Promise<R>,
  options: MetaLockOptions,
): Promise<R> {
  const acquireTimeoutMs =
    options.acquireTimeoutMs ?? META_LOCK_ACQUIRE_TIMEOUT_MS
  const releaseTimeoutMs =
    options.releaseTimeoutMs ?? META_LOCK_RELEASE_TIMEOUT_MS
  let child: ChildProcess
  try {
    child = await spawn()
  } catch (e) {
    throw new MetaLockError(e instanceof Error ? e.message : String(e))
  }
  // A write to a holder that already exited must not crash the runtime.
  child.stdin?.on('error', () => undefined)
  let exited = false
  // 'close' (not 'exit'): fires once the holder's output is fully read, so
  // an error it printed right before exiting is never lost.
  const exit = new Promise<void>((resolve) => {
    child.once('close', () => {
      exited = true
      resolve()
    })
    child.once('error', () => {
      exited = true
      resolve()
    })
  })

  let output = ''
  try {
    await new Promise<void>((resolve, reject) => {
      const timer = setTimeout(
        () => reject(new MetaLockError('timed out waiting for the lock')),
        acquireTimeoutMs,
      )
      const done = (err?: Error) => {
        clearTimeout(timer)
        if (err) reject(err)
        else resolve()
      }
      child.stdout?.on('data', (chunk: unknown) => {
        output += text(chunk)
        if (output.split('\n').includes('locked')) done()
      })
      child.stderr?.on('data', (chunk: unknown) => {
        output += text(chunk)
      })
      void exit.then(() => {
        if (!output.split('\n').includes('locked')) {
          done(
            new MetaLockError(
              lastLine(output) || 'the lock holder exited before locking',
            ),
          )
        }
      })
    })
  } catch (e) {
    // EOF first: if the kill does not reach a holder inside a subcontainer,
    // it still releases the lock as soon as it gets it.
    child.stdin?.destroy()
    if (!exited) child.kill('SIGKILL')
    throw e
  }

  const heartbeat = setInterval(
    () => child.stdin?.write('\n'),
    options.heartbeatMs ?? META_LOCK_HEARTBEAT_MS,
  )
  heartbeat.unref()
  const hold = { active: true }
  let heldUntilRelease = false
  let result: R
  try {
    result = await holding.run(hold, job)
  } finally {
    hold.active = false
    clearInterval(heartbeat)
    const activeAtEnd = !exited
    child.stdin?.end()
    const closed = await Promise.race([
      exit.then(() => true),
      new Promise<boolean>((resolve) =>
        setTimeout(() => resolve(false), releaseTimeoutMs).unref(),
      ),
    ])
    if (!closed) child.kill('SIGKILL')
    // Checked after `exit` (the 'close' event) resolves: a holder that
    // exited while `job` was finishing may not have fired 'close' yet when
    // `finally` began, and only a holder still waiting on stdin when `end()`
    // ran prints `released` and exits 0.
    heldUntilRelease =
      activeAtEnd &&
      closed &&
      child.exitCode === 0 &&
      child.signalCode === null &&
      output.split('\n').includes('released')
  }
  if (!heldUntilRelease) {
    // The hold ended early (lease or holder killed), so the job's writes
    // may have interleaved with bridge.py: never report them as done.
    throw new MetaLockError('the lock was lost before the write finished')
  }
  return result
}

/** A MetaLock whose holders come from `scope`. */
export function createMetaLock(
  scope: HolderScope,
  options: MetaLockOptions = {},
): MetaLock {
  return <R>(job: () => Promise<R>): Promise<R> => {
    if (holding.getStore()?.active) return job()
    const run = tail.then(
      () => scope((spawn) => holdWhile(spawn, job, options)),
      () => scope((spawn) => holdWhile(spawn, job, options)),
    )
    tail = run.catch(() => undefined)
    return run
  }
}

/**
 * The production lock: the holder runs in a temporary subcontainer of the
 * package image with the main volume at /data, where bridge.py keeps its
 * lock file. Works while the service is stopped too.
 */
export function metaLockFor(effects: T.Effects): MetaLock {
  return createMetaLock((use) =>
    sdk.SubContainer.withTemp(
      effects,
      { imageId: 'main' },
      sdk.Mounts.of().mountVolume({
        volumeId: 'main',
        subpath: null,
        mountpoint: '/data',
        readonly: false,
      }),
      'meta-lock',
      (sub) =>
        use(() =>
          sub.spawn(['python3', '/app/bridge.py', 'meta-lock'], {
            stdio: 'pipe',
          }),
        ),
    ),
  )
}
