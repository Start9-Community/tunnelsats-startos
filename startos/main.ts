import { i18n } from './i18n'
import { sdk } from './sdk'
import { configJson } from './fileModels/config.json'
import { checkHandoffProgress } from './handoffIO'
import { NODE_TITLES } from './vpnHandoff'
import { runSettlementTick } from './settlement'
import { tunnelsatsMeta } from './fileModels/tunnelsatsMeta'
import { subscriptionNotices } from './fileModels/subscriptionNotices'
import { dashboardIntents } from './fileModels/dashboardIntents'
import { processDashboardIntents } from './intentRunner'
import { createNoticeRunner, noticeStateRecord } from './notifications'
import { noticeInputsFor } from './dependencies'

export const main = sdk.setupMain(async ({ effects }) => {
  console.info(i18n('Starting TunnelSats!'))

  // 1. Read configuration reactively
  const config = await configJson.read().const(effects)
  const targetNode = config?.['target-node'] ?? 'lnd'

  // 2. Resolve target Lightning node internal DNS address
  const targetAddr =
    targetNode === 'cln'
      ? 'c-lightning.embassy:9735'
      : targetNode === 'eclair'
        ? 'eclair.embassy:9735'
        : 'lnd.embassy:9735'

  // 3. Setup environment variables
  const env: Record<string, string> = {}
  if (config?.enabled && targetAddr) {
    env.TARGET_NODE_ADDR = targetAddr
  }

  // 4. Create subcontainer reference
  const subcontainer = sdk.SubContainer.of(
    effects,
    { imageId: 'main' },
    sdk.Mounts.of().mountVolume({
      volumeId: 'main',
      subpath: null,
      mountpoint: '/data',
      readonly: false,
    }),
    'main',
  )

  // 5. Subscription notices (7 and 3 days before expiry, lapse, unknown
  // key), driven by the Subscription health check. See notifications.ts.
  const runNotices = createNoticeRunner({
    readInputs: async () =>
      noticeInputsFor(
        await configJson.read().once(),
        await tunnelsatsMeta
          .read()
          .once()
          .catch(() => null),
      ),
    // An unreadable record counts as missing: at worst one notice repeats,
    // and the next write replaces the broken file.
    readState: async () =>
      (await subscriptionNotices
        .read()
        .once()
        .catch(() => null)) ?? null,
    writeState: async (state) => {
      await subscriptionNotices.write(effects, noticeStateRecord(state))
    },
    notify: async (notice) => {
      await sdk.notification.create(effects, {
        level: notice.level,
        title: notice.title,
        message: notice.message,
      })
    },
  })

  const checkSubscription = async (): Promise<{
    result: 'success' | 'failure' | 'loading' | 'disabled'
    message: string
  }> => {
    if (!config?.enabled) {
      return {
        result: 'disabled',
        message: i18n('TunnelSats is disabled.'),
      }
    }
    const res = await subcontainer.exec([
      'python3',
      '/app/bridge.py',
      'health',
      'subscription',
    ])
    if (res.exitCode !== 0) {
      try {
        const errData = JSON.parse(
          res.stdout.toString() || res.stderr.toString(),
        )
        return {
          result: 'failure',
          message: errData.message || i18n('Subscription verification failed'),
        }
      } catch {
        return {
          result: 'failure',
          message:
            res.stderr?.toString() || i18n('Subscription verification failed'),
        }
      }
    }
    try {
      const data = JSON.parse(res.stdout.toString())
      const isOk = data.result === 'ok' || data.result === 'success'
      return {
        result: isOk
          ? 'success'
          : data.result === 'loading'
            ? 'loading'
            : 'failure',
        message:
          data.message ||
          (isOk ? i18n('Subscription is active') : String(data.result)),
      }
    } catch {
      return {
        result: 'failure',
        message: i18n('Failed to parse health check result'),
      }
    }
  }

  // 6. Watch dashboard-intents.json (written by bridge.py POST /api/intents)
  // so Buy/Renew/Reset requests from the dashboard run immediately through
  // the shared action core, with a fallback poll in the settlement health check.
  let intentsWatcherActive = true
  effects.onLeaveContext(() => {
    intentsWatcherActive = false
  })
  dashboardIntents.read().onChange(effects, async (intents) => {
    if (!intentsWatcherActive) return { cancel: true }
    if (intents) {
      await processDashboardIntents(effects).catch((e: unknown) =>
        console.warn(`TunnelSats dashboard intent runner failed: ${String(e)}`),
      )
    }
    return { cancel: !intentsWatcherActive }
  })

  // 7. Define daemons and health checks
  return sdk.Daemons.of(effects)
    .addDaemon('main', {
      subcontainer,
      exec: {
        command: ['/app/docker_entrypoint.sh'],
        env,
      },
      ready: {
        display: i18n('Web Dashboard'),
        fn: async () => {
          return sdk.healthCheck.checkPortListening(effects, 80, {
            successMessage: i18n('Web Dashboard is accessible'),
            errorMessage: i18n('Web Dashboard is not accessible'),
          })
        },
      },
      requires: [],
    })
    .addHealthCheck('subscription', {
      ready: {
        display: i18n('Subscription Status'),
        fn: async () => {
          const status = await checkSubscription()
          // After the bridge check, which may just have synced the
          // metadata. Never changes the health result.
          if (config?.enabled) {
            const notices = await runNotices()
            if (notices.error) {
              console.warn(
                `TunnelSats subscription notice not sent: ${notices.error}`,
              )
            }
          }
          return status
        },
      },
      requires: ['main'],
    })
    .addHealthCheck('vpn-handoff', {
      ready: {
        display: i18n('VPN Handoff'),
        // Shows a pending node switch and, when the previous node turned its
        // tunnel off without a status change (off-task accepted while it was
        // stopped), makes setupDependencies release the new node's task.
        fn: async () => {
          try {
            const progress = await checkHandoffProgress(effects)
            if (progress.waitingFor.length > 0) {
              return {
                result: 'waiting',
                message: i18n(
                  'Waiting for ${nodes} to turn off the TunnelSats tunnel. Accept the task on that node to finish the handoff.',
                  {
                    nodes: progress.waitingFor
                      .map((p) => NODE_TITLES[p])
                      .join(', '),
                  },
                ),
              }
            }
            if (progress.retrying.length > 0) {
              return {
                result: 'waiting',
                message: i18n(
                  'Offering the TunnelSats task to ${nodes} failed; retrying automatically.',
                  {
                    nodes: progress.retrying
                      .map((p) => NODE_TITLES[p])
                      .join(', '),
                  },
                ),
              }
            }
            if (progress.retryingOwnTasks) {
              return {
                result: 'waiting',
                message: i18n(
                  'Updating the TunnelSats reminder tasks failed; retrying automatically.',
                ),
              }
            }
            return {
              result: 'success',
              message: i18n('No node handoff pending'),
            }
          } catch (e) {
            return {
              result: 'failure',
              message: i18n('Could not check the VPN handoff: ${error}', {
                error: e instanceof Error ? e.message : String(e),
              }),
            }
          }
        },
      },
      requires: [],
    })
    .addHealthCheck('settlement', {
      ready: {
        display: i18n('Payment Settlement'),
        // Finishes paid Buy/Renew payments. Runs while disabled too: a first
        // Buy completes on a package that has no configuration yet.
        trigger: sdk.trigger.cooldownTrigger(20_000),
        fn: async () => {
          await processDashboardIntents(effects).catch((e) =>
            console.warn(`TunnelSats dashboard intent check failed: ${e}`),
          )
          const status = await runSettlementTick({
            settle: () =>
              subcontainer.exec(['python3', '/app/bridge.py', 'settle']),
            ack: (ids) =>
              subcontainer.exec([
                'python3',
                '/app/bridge.py',
                'settle-ack',
                ...ids,
              ]),
            clearTask: (id) => sdk.action.clearTask(effects, id),
          })
          switch (status.state) {
            case 'idle':
              return {
                result: 'success',
                message: i18n('No payment pending'),
              }
            case 'busy':
              return {
                result: 'waiting',
                message: i18n('Checking pending payments'),
              }
            case 'waiting':
              return { result: 'waiting', message: status.message }
            case 'settled':
              return { result: 'success', message: status.message }
            case 'failed':
              return {
                result: 'failure',
                message: i18n('Payment settlement failed: ${error}', {
                  error: status.error,
                }),
              }
            case 'clearing-failed':
              return {
                result: 'failure',
                message: i18n(
                  'The payment was settled, but clearing its payment task on the Lightning node failed: ${error}. Retrying automatically.',
                  { error: status.error },
                ),
              }
          }
        },
      },
      requires: ['main'],
    })
})
