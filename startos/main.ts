import { i18n } from './i18n'
import { sdk } from './sdk'
import { configJson } from './fileModels/config.json'
import { checkHandoffProgress } from './handoffIO'
import { NODE_TITLES } from './vpnHandoff'
import { runSettlementTick } from './settlement'

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

  // 5. Define daemons and health checks
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
                message:
                  errData.message || i18n('Subscription verification failed'),
              }
            } catch {
              return {
                result: 'failure',
                message:
                  res.stderr?.toString() ||
                  i18n('Subscription verification failed'),
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
                  'Updating the TunnelSats renewal reminder failed; retrying automatically.',
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
