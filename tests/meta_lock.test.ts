import test from 'node:test'
import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { FileHelper, type T } from '@start9labs/start-sdk'
import { metaShape } from '../startos/fileModels/tunnelsatsMeta'
import { createMetaLock, metaLockFor, MetaLockError } from '../startos/metaLock'
import { payTaskReplayId, recordThenRaise } from '../startos/settlement'
// The real bridge.py holder, run locally instead of in a subcontainer:
// metaLockFor(effects) differs only in where the same command runs.
import {
  BRIDGE,
  localScope,
  lockIsFree,
  stubMetaLockSubcontainer,
  type MetaLockSubcontainerCall,
} from './metaLockSupport'

function withDir(fn: (dir: string) => Promise<void>) {
  return async () => {
    const dir = mkdtempSync(join(tmpdir(), 'meta-lock-'))
    try {
      await fn(dir)
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  }
}

test(
  'withMetaLock holds bridge.py meta_lock while the job runs, then releases it',
  withDir(async (dir) => {
    const lock = createMetaLock(localScope(dir))
    const heldDuring = await lock(async () => lockIsFree(dir))
    assert.equal(heldDuring, false)
    assert.equal(lockIsFree(dir), true)
  }),
)

test(
  'metaLockFor spawns bridge.py meta-lock in a temporary main subcontainer with /data mounted read-write',
  withDir(async (dir) => {
    const calls: MetaLockSubcontainerCall[] = []
    const restore = stubMetaLockSubcontainer(dir, (call) => calls.push(call))
    const effects = { id: 'effects-stub' } as unknown as T.Effects
    try {
      const heldDuring = await metaLockFor(effects)(
        async () => !lockIsFree(dir),
      )
      assert.equal(heldDuring, true)
      assert.equal(lockIsFree(dir), true)
    } finally {
      restore()
    }
    assert.equal(calls.length, 1)
    assert.equal(calls[0].effects, effects)
    assert.deepEqual(calls[0].image, { imageId: 'main' })
    assert.equal(calls[0].name, 'meta-lock')
    assert.deepEqual(calls[0].command, [
      'python3',
      '/app/bridge.py',
      'meta-lock',
    ])
    assert.equal(calls[0].stdio, 'pipe')
    assert.equal(calls[0].mounts.length, 1)
    assert.equal(calls[0].mounts[0].mountpoint, '/data')
    assert.equal(calls[0].mounts[0].options.type, 'volume')
    assert.equal(calls[0].mounts[0].options.volumeId, 'main')
    assert.equal(calls[0].mounts[0].options.subpath, null)
    assert.equal(calls[0].mounts[0].options.readonly, false)
  }),
)

test(
  'withMetaLock releases the lock when the job throws',
  withDir(async (dir) => {
    const lock = createMetaLock(localScope(dir))
    await assert.rejects(
      lock(async () => {
        throw new Error('boom')
      }),
      /boom/,
    )
    assert.equal(lockIsFree(dir), true)
  }),
)

test(
  'withMetaLock is reentrant while held, but a deferred callback after release acquires a fresh lock',
  withDir(async (dir) => {
    let spawns = 0
    const baseScope = localScope(dir)
    const lock = createMetaLock((use) =>
      baseScope((spawnHolder) =>
        use(async () => {
          spawns++
          return spawnHolder()
        }),
      ),
    )
    const log: string[] = []
    let deferred!: Promise<boolean>
    const nested = await lock(async () => {
      deferred = new Promise<boolean>((resolve, reject) => {
        setTimeout(() => {
          lock(async () => !lockIsFree(dir)).then(resolve, reject)
        }, 30)
      })
      return lock(async () => {
        log.push('nested')
        return 'ok'
      })
    })
    assert.equal(nested, 'ok')
    assert.equal(spawns, 1, 'nested call must reuse the outer holder')
    assert.equal(
      await deferred,
      true,
      'deferred callback after release must acquire a new holder',
    )
    assert.equal(spawns, 2)
    let active = 0
    let maxActive = 0
    await Promise.all(
      [1, 2, 3].map((n) =>
        lock(async () => {
          active++
          maxActive = Math.max(maxActive, active)
          await new Promise((r) => setTimeout(r, 30))
          log.push(`job ${n}`)
          active--
        }),
      ),
    )
    assert.equal(maxActive, 1)
    assert.deepEqual(log, ['nested', 'job 1', 'job 2', 'job 3'])
  }),
)

test('withMetaLock fails closed when the holder cannot lock', async () => {
  let ran = false
  // A holder that reports bridge.py's acquire-timeout error and exits.
  const lock = createMetaLock((use) =>
    use(async () =>
      spawn(
        'python3',
        [
          '-c',
          'import json, sys; print(json.dumps({"error": "Timed out waiting for the TunnelSats metadata lock"})); sys.exit(2)',
        ],
        { stdio: 'pipe' },
      ),
    ),
  )
  await assert.rejects(
    lock(async () => {
      ran = true
    }),
    (e: unknown) =>
      e instanceof MetaLockError && /Timed out waiting/.test(e.message),
  )
  assert.equal(ran, false)
})

test('withMetaLock gives up (and kills the holder) after the acquire timeout', async () => {
  let ran = false
  let child: ReturnType<typeof spawn> | undefined
  const lock = createMetaLock(
    (use) =>
      use(async () => {
        child = spawn('python3', ['-c', 'import time; time.sleep(30)'], {
          stdio: 'pipe',
        })
        return child
      }),
    { acquireTimeoutMs: 200 },
  )
  await assert.rejects(
    lock(async () => {
      ran = true
    }),
    MetaLockError,
  )
  assert.equal(ran, false)
  await new Promise((r) => setTimeout(r, 100))
  assert.notEqual(child?.signalCode ?? child?.exitCode ?? null, null)
})

test('a job whose holder exits before the release fails', async () => {
  // A holder that locks and then goes away (lease expiry, killed).
  const lock = createMetaLock((use) =>
    use(async () =>
      spawn(
        'python3',
        ['-c', 'import time; print("locked", flush=True); time.sleep(0.1)'],
        { stdio: 'pipe' },
      ),
    ),
  )
  await assert.rejects(
    lock(async () => {
      await new Promise((r) => setTimeout(r, 500))
      return 'written'
    }),
    (e: unknown) => e instanceof MetaLockError && /lost/.test(e.message),
  )
})

test('a job whose holder exits as the job finishes (before close fires) still fails', async () => {
  let child: ReturnType<typeof spawn> | undefined
  const lock = createMetaLock((use) =>
    use(async () => {
      child = spawn(
        'python3',
        ['-c', 'import time; print("locked", flush=True); time.sleep(60)'],
        { stdio: 'pipe' },
      )
      return child
    }),
  )
  await assert.rejects(
    lock(async () => {
      // Kill the holder right as the job returns, before its 'close' event
      // has had a chance to run on the event loop.
      child!.kill('SIGKILL')
      return 'written'
    }),
    (e: unknown) => e instanceof MetaLockError && /lost/.test(e.message),
  )
})

test(
  'heartbeats to the real holder keep the lock held until the release',
  withDir(async (dir) => {
    // Lease renewal itself is tested in test_meta_lock.py; here the holder
    // takes several heartbeats and stays locked through a longer job.
    const lock = createMetaLock(localScope(dir), { heartbeatMs: 50 })
    const heldAtEnd = await lock(async () => {
      await new Promise((r) => setTimeout(r, 300))
      return !lockIsFree(dir)
    })
    assert.equal(heldAtEnd, true)
    assert.equal(lockIsFree(dir), true)
  }),
)

test(
  'a TypeScript record and a concurrent bridge.py writer never lose an update',
  withDir(async (dir) => {
    // pendingOrder P1 is being replaced by P2 (its pay task is queued for
    // clearing) while bridge.py acknowledges the already queued task A.
    const metaPath = join(dir, 'tunnelsats-meta.json')
    const meta = FileHelper.json(metaPath, metaShape)
    const effects = {} as T.Effects
    const p1 = '1'.repeat(64)
    const p2 = '2'.repeat(64)
    const queuedA = payTaskReplayId('order', 'lnd', 'a'.repeat(64))
    const order = (paymentHash: string) => ({
      paymentHash,
      orderId: `order-${paymentHash[0]}`,
      privateKey: 'priv',
      publicKey: 'pub',
      targetNode: 'lnd' as const,
      serverId: 'eu-de',
      createdAt: '2026-09-28T00:00:00.000Z',
    })
    writeFileSync(
      metaPath,
      JSON.stringify({
        pendingOrder: order(p1),
        payTasksToClear: [queuedA],
      }),
    )
    let ack: ReturnType<typeof spawn> | undefined
    let ackExit: Promise<number | null> | undefined
    await recordThenRaise('order', p2, {
      lockMeta: createMetaLock(localScope(dir)),
      readCurrent: async () => {
        const current = await meta.read().once()
        // bridge.py writes between this read and the record below.
        ack = spawn('python3', [BRIDGE, 'settle-ack', queuedA], {
          env: { ...process.env, DATA_DIR: dir },
          stdio: 'ignore',
        })
        ackExit = new Promise((r) => ack!.once('exit', r))
        await new Promise((r) => setTimeout(r, 700))
        return (
          current && {
            pending: current.pendingOrder,
            payTasksToClear: current.payTasksToClear,
          }
        )
      },
      record: (patch) =>
        meta.merge(effects, {
          pendingOrder: order(p2),
          ...patch,
        }),
      raiseTask: async () => undefined,
    })
    assert.equal(await ackExit, 0)
    const final = JSON.parse(readFileSync(metaPath, 'utf-8'))
    assert.equal(final.pendingOrder.paymentHash, p2)
    // The replaced P1 task is queued and A's acknowledgement is kept.
    assert.deepEqual(final.payTasksToClear, [
      payTaskReplayId('order', 'lnd', p1),
    ])
  }),
)
