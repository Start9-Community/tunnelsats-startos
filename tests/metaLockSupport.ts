/**
 * The real metadata lock for tests: the production `bridge.py meta-lock`
 * holder, run locally against a temporary DATA_DIR instead of in a StartOS
 * subcontainer (which is all metaLockFor adds).
 */
import { spawn, spawnSync } from 'node:child_process'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  createMetaLock,
  type HolderScope,
  type MetaLock,
} from '../startos/metaLock'
import { sdk } from '../startos/sdk'

export const BRIDGE = join(__dirname, '..', 'bridge.py')

export function localScope(dataDir: string): HolderScope {
  return (use) =>
    use(async () =>
      spawn('python3', [BRIDGE, 'meta-lock'], {
        env: { ...process.env, DATA_DIR: dataDir },
        stdio: 'pipe',
      }),
    )
}

/** True when bridge.py's lock file in dataDir can be taken right now. */
export function lockIsFree(dataDir: string): boolean {
  const program = [
    'import fcntl, os, sys',
    `fd = os.open(${JSON.stringify(join(dataDir, 'tunnelsats-meta.json.lock'))}, os.O_RDWR | os.O_CREAT, 0o600)`,
    'try:',
    '    fcntl.flock(fd, fcntl.LOCK_EX | fcntl.LOCK_NB)',
    'except BlockingIOError:',
    '    sys.exit(1)',
  ].join('\n')
  return spawnSync('python3', ['-c', program]).status === 0
}

let sharedDir: string | null = null

/** The lock directory shared by testMetaLock (one per test process). */
export function testLockDir(): string {
  if (!sharedDir) {
    const dir = mkdtempSync(join(tmpdir(), 'meta-lock-shared-'))
    process.once('exit', () => rmSync(dir, { recursive: true, force: true }))
    sharedDir = dir
  }
  return sharedDir
}

/** A real MetaLock on the shared test lock directory. */
export const testMetaLock: MetaLock = <R>(job: () => Promise<R>) =>
  createMetaLock(localScope(testLockDir()))(job)

export interface MetaLockSubcontainerCall {
  effects: unknown
  image: { imageId: string; sharedRun?: boolean }
  mounts: Array<{ mountpoint: string; options: Record<string, unknown> }>
  name: string
  command: readonly string[]
  stdio: unknown
}

const origWithTemp = sdk.SubContainer.withTemp.bind(sdk.SubContainer)

/**
 * Intercepts `sdk.SubContainer.withTemp` for `'meta-lock'` so `metaLockFor`
 * runs its real `SubContainer.withTemp`, `Mounts` and `sub.spawn` setup
 * while executing the spawned `/app/bridge.py meta-lock` against `dataDir`.
 */
export function stubMetaLockSubcontainer(
  dataDir: string,
  onCall?: (call: MetaLockSubcontainerCall) => void,
): () => void {
  const prev = sdk.SubContainer.withTemp
  ;(sdk.SubContainer as any).withTemp = async (
    effects: unknown,
    image: { imageId: string; sharedRun?: boolean },
    mounts: {
      build(): Array<{ mountpoint: string; options: Record<string, unknown> }>
    },
    name: string,
    fn: (sub: {
      spawn: (
        cmd: readonly string[],
        opts?: { stdio?: unknown },
      ) => Promise<ReturnType<typeof spawn>>
    }) => Promise<unknown>,
  ) => {
    if (name !== 'meta-lock') {
      return (origWithTemp as any)(effects, image, mounts, name, fn)
    }
    const builtMounts = mounts.build()
    return fn({
      spawn: async (command, opts) => {
        onCall?.({
          effects,
          image,
          mounts: builtMounts,
          name,
          command,
          stdio: opts?.stdio,
        })
        if (
          command[0] !== 'python3' ||
          command[1] !== '/app/bridge.py' ||
          command[2] !== 'meta-lock' ||
          opts?.stdio !== 'pipe'
        ) {
          throw new Error(
            `Unexpected meta-lock subcontainer spawn: ${JSON.stringify({ command, opts })}`,
          )
        }
        return spawn('python3', [BRIDGE, 'meta-lock'], {
          env: { ...process.env, DATA_DIR: dataDir },
          stdio: 'pipe',
        })
      },
    })
  }
  return () => {
    ;(sdk.SubContainer as any).withTemp = prev
  }
}

/**
 * Routes `metaLockFor(effects)`'s temporary subcontainer spawn to the real
 * local `bridge.py meta-lock` holder on `testLockDir()`.
 */
export function useTestMetaLock(): void {
  stubMetaLockSubcontainer(testLockDir())
}
