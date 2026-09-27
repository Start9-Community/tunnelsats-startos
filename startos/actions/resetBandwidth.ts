import { sdk } from '../sdk'
import { configJson } from '../fileModels/config.json'
import { tunnelsatsMeta } from '../fileModels/tunnelsatsMeta'
import { i18n } from '../i18n'
import { parseWireguardTunnelInfo } from '../utils'
import { derivePublicKey } from '../keygen'
import {
  ApiHttpError,
  fetchBandwidthResetStatus,
  requestBandwidthReset,
} from '../apiClient'
import {
  ResetFailedError,
  resetAvailability,
  runBandwidthReset,
  type ResetRunResult,
} from '../bandwidthReset'
import { payTaskReplayId, type TargetNode } from '../settlement'
import { resolvePayInvoice } from './resolvePayInvoice'

/** The configured key, or null without an enabled config with a private key. */
function configuredKey(
  config: { enabled?: boolean; 'tunnelsats-conf'?: string | null } | null,
): string | null {
  if (!config?.enabled || !config['tunnelsats-conf']) return null
  const { privateKey } = parseWireguardTunnelInfo(config['tunnelsats-conf'])
  if (!privateKey) return null
  try {
    return derivePublicKey(privateKey)
  } catch {
    return null
  }
}

const sameJson = (a: unknown, b: unknown) =>
  JSON.stringify(a) === JSON.stringify(b)

export const resetBandwidth = sdk.Action.withoutInput(
  'reset-bandwidth',
  async ({ effects }) => {
    const config = await configJson
      .read((c) => c, sameJson)
      .const(effects)
      .catch(() => null)
    const availability = resetAvailability(configuredKey(config))
    return {
      name: i18n('Reset Bandwidth'),
      description: i18n(
        "Reset this month's bandwidth usage once it reaches 70% of the monthly limit. Resets per month are limited; the invoice is paid from your Lightning node.",
      ),
      warning: null,
      allowedStatuses: 'only-running' as const,
      group: i18n('Subscription'),
      visibility: availability.available
        ? ('enabled' as const)
        : {
            disabled: i18n(
              'No active subscription found. Import or purchase a subscription first.',
            ),
          },
    }
  },
  async ({ effects }) => {
    const config = await configJson
      .read()
      .once()
      .catch(() => null)
    const publicKey = configuredKey(config)
    if (!config || !publicKey) {
      throw new Error(
        i18n(
          'No active subscription found. Import or purchase a subscription first.',
        ),
      )
    }
    const tunnelInfo = parseWireguardTunnelInfo(config['tunnelsats-conf'])
    const targetNode: TargetNode = config['target-node'] || 'lnd'
    // Not payment state: read outside the payment queue, like Renew.
    const serverMeta = await tunnelsatsMeta
      .read()
      .once()
      .catch(() => null)
    const metaServerDomain =
      serverMeta?.publicKey === publicKey ? serverMeta.serverDomain : undefined
    const serverId = tunnelInfo.serverDomain || metaServerDomain || 'eu-de'

    let outcome: ResetRunResult
    try {
      outcome = await runBandwidthReset(publicKey, {
        now: () => new Date(),
        targetNode,
        // A read error fails the action: taking it for "nothing pending"
        // would reserve another reset while an invoice is still payable.
        // A missing file reads as null.
        readCurrent: async () => {
          const current = await tunnelsatsMeta.read().once()
          return (
            current && {
              pending: current.pendingReset,
              payTasksToClear: current.payTasksToClear,
            }
          )
        },
        fetchStatus: (hash) => fetchBandwidthResetStatus(hash),
        requestReset: () =>
          requestBandwidthReset({ wgPublicKey: publicKey, serverId }),
        record: (order, patch) =>
          tunnelsatsMeta.merge(effects, {
            pendingReset: {
              paymentHash: order.paymentHash,
              resetId: order.resetId,
              invoice: order.invoice,
              expiresAt: order.expiresAt,
              createdAt: new Date().toISOString(),
              publicKey,
              serverId,
              targetNode,
              amountSats: order.amountSats,
              // merge() is a deep merge: without these, a backoff left by an
              // earlier reset would delay settling this one.
              lastError: undefined,
              nextAttemptAt: undefined,
            },
            ...patch,
          }),
        raiseTask: ({ invoice, paymentHash, targetNode: node }) => {
          const { packageId, payInvoiceAction } = resolvePayInvoice(node)
          return sdk.action.createTask(
            effects,
            packageId,
            payInvoiceAction,
            'important',
            {
              replayId: payTaskReplayId('reset', node, paymentHash),
              input: {
                kind: 'partial',
                accept: [],
                set: {
                  invoice,
                  amount: { selection: 'invoice', value: {} },
                  'max-fee-percent': 1,
                  confirmed: false,
                },
              },
              reason: i18n('Pay TunnelSats bandwidth reset invoice'),
            },
          )
        },
      })
    } catch (e) {
      if (e instanceof ResetFailedError) {
        throw new Error(
          i18n(
            'The payment was received, but the bandwidth reset failed. Contact TunnelSats support with payment hash ${paymentHash}.',
            { paymentHash: e.paymentHash },
          ),
        )
      }
      if (e instanceof ApiHttpError && e.status === 400) {
        throw new Error(e.apiMessage)
      }
      if (e instanceof ApiHttpError && e.status === 429) {
        throw new Error(
          i18n(
            'The monthly bandwidth reset limit is reached (${message}). An unpaid reset invoice keeps its reset reserved until it expires.',
            { message: e.apiMessage },
          ),
        )
      }
      throw e
    }

    const field = (name: string, value: string, qr = false) => ({
      name,
      description: null,
      type: 'single' as const,
      value,
      copyable: true,
      masked: false,
      qr,
    })

    if (outcome.kind === 'already-paid') {
      return {
        version: '1' as const,
        title: i18n('Bandwidth Reset Paid'),
        message: i18n(
          'The payment for this bandwidth reset was received; the reset is being applied.',
        ),
        result: field(i18n('Payment Hash'), outcome.paymentHash),
      }
    }

    if (outcome.kind === 'reused') {
      const { pending } = outcome
      return {
        version: '1' as const,
        title: i18n('Pending Bandwidth Reset Invoice'),
        message: i18n(
          'This reset was already requested and its invoice can still be paid until ${expiresAt}. Its payment task has been raised on your Lightning node again.',
          { expiresAt: pending.expiresAt ?? '' },
        ),
        result: {
          type: 'group' as const,
          value: [
            field(i18n('BOLT11 Invoice'), pending.invoice, true),
            field(i18n('Payment Hash'), pending.paymentHash),
          ],
        },
      }
    }

    const { order } = outcome
    const details = [
      field(i18n('BOLT11 Invoice'), order.invoice, true),
      field(i18n('Amount'), `${order.amountSats} sats`),
      field(i18n('Invoice Expires'), order.expiresAt),
      field(i18n('Payment Hash'), order.paymentHash),
    ]
    if (order.currentUsagePercent !== undefined) {
      details.push(
        field(
          i18n('Current Usage'),
          `${order.currentUsagePercent.toFixed(1)}%`,
        ),
      )
    }
    if (order.resetsThisMonth !== undefined) {
      details.push(
        field(
          i18n('Resets Confirmed This Month'),
          order.maxResetsPerMonth !== undefined
            ? `${order.resetsThisMonth} / ${order.maxResetsPerMonth}`
            : `${order.resetsThisMonth}`,
        ),
      )
    }
    return {
      version: '1' as const,
      title: i18n('Bandwidth Reset Invoice Created'),
      message: i18n(
        "A payment task has been raised on your Lightning node. Once it is paid, this month's bandwidth usage is reset.",
      ),
      result: { type: 'group' as const, value: details },
    }
  },
)
