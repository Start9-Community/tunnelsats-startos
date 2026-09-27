import { sdk } from '../sdk'
import { tunnelsatsMeta } from '../fileModels/tunnelsatsMeta'
import { i18n } from '../i18n'
import { generateWireguardKeypair } from '../keygen'
import { createSubscriptionOrder } from '../apiClient'
import { payTaskReplayId, recordPaymentThenRaiseTask } from '../settlement'
import { payInvoice as lndPayInvoice } from 'lnd-startos/startos/actions/payInvoice'
import { payInvoice as clnPayInvoice } from 'cln-startos/startos/actions/payInvoice'
import { payInvoice as eclairPayInvoice } from 'eclair-startos/startos/actions/payInvoice'

const { InputSpec, Value } = sdk

const inputSpec = InputSpec.of({
  'target-node': Value.select({
    name: i18n('Target Lightning Node'),
    description: i18n(
      'Select which Lightning node will pay the invoice and receive inbound connections.',
    ),
    default: 'lnd',
    values: {
      lnd: 'LND',
      cln: 'Core Lightning',
      eclair: 'Eclair',
    },
  }),
  'server-region': Value.select({
    name: i18n('Server Region'),
    description: i18n(
      'Select the geographic region for your VPN tunnel endpoint.',
    ),
    default: 'eu-de',
    values: {
      'eu-de': 'Europe — Frankfurt, DE',
      'eu-de2': 'Europe — Nuremberg, DE',
      'us-west': 'North America — Hillsboro, US',
    },
  }),
  duration: Value.select({
    name: i18n('Subscription Duration'),
    description: i18n('Choose how long the subscription should last.'),
    default: '1',
    values: {
      '1': '1 Month',
      '3': '3 Months',
      '6': '6 Months',
      '12': '12 Months',
    },
  }),
})

export const buySubscription = sdk.Action.withInput(
  'buy-subscription',
  {
    name: i18n('Buy Subscription'),
    description: i18n(
      'Purchase a new TunnelSats VPN subscription with Lightning. Generates a secure keypair on-device and raises a payment task on your Lightning node.',
    ),
    warning: null,
    allowedStatuses: 'only-running',
    group: i18n('Subscription'),
    visibility: 'enabled',
  },
  inputSpec,
  async ({ effects }) => ({}),
  async ({ effects, input }) => {
    const keypair = generateWireguardKeypair()
    const targetNode = input['target-node']

    const order = await createSubscriptionOrder({
      serverId: input['server-region'],
      duration: parseInt(input.duration, 10),
      wgPublicKey: keypair.publicKey,
    })

    let packageId: string
    let payInvoiceAction: any

    switch (targetNode) {
      case 'lnd':
        packageId = 'lnd'
        payInvoiceAction = lndPayInvoice
        break
      case 'cln':
        packageId = 'c-lightning'
        payInvoiceAction = clnPayInvoice
        break
      case 'eclair':
        packageId = 'eclair'
        payInvoiceAction = eclairPayInvoice
        break
      default: {
        // Compile-time exhaustiveness: a new target node must be handled above.
        const unsupported: never = targetNode
        throw new Error(`Unsupported target node: ${String(unsupported)}`)
      }
    }

    // Records the order, queueing the replaced order's pay task for the
    // settlement health check to clear in the same write, then raises this
    // order's task; serialized with other purchases (see
    // recordPaymentThenRaiseTask). The key is stored before the invoice is
    // payable, so a paid order can always be claimed.
    await recordPaymentThenRaiseTask('order', order.paymentHash, {
      // A read error fails the purchase: treating it as "nothing pending"
      // would replace a pending payment without queuing its task. A missing
      // file reads as null.
      readCurrent: async () => {
        const current = await tunnelsatsMeta.read().once()
        return (
          current && {
            pending: current.pendingOrder,
            payTasksToClear: current.payTasksToClear,
          }
        )
      },
      record: (patch) =>
        tunnelsatsMeta.merge(effects, {
          pendingOrder: {
            paymentHash: order.paymentHash,
            orderId: order.orderId,
            privateKey: keypair.privateKey,
            publicKey: keypair.publicKey,
            targetNode,
            serverId: input['server-region'],
            createdAt: new Date().toISOString(),
            // merge() is a deep merge: without these, a backoff left by an
            // earlier order would delay settling this one.
            lastError: undefined,
            nextAttemptAt: undefined,
          },
          ...patch,
        }),
      raiseTask: () =>
        sdk.action.createTask(
          effects,
          packageId,
          payInvoiceAction,
          'important',
          {
            // The settlement health check clears the task under this ID once the
            // order is settled or expired.
            replayId: payTaskReplayId('order', targetNode, order.paymentHash),
            input: {
              kind: 'partial',
              accept: [],
              set: {
                invoice: order.invoice,
                amount: { selection: 'invoice', value: {} },
                'max-fee-percent': 1,
                confirmed: false,
              },
            },
            reason: i18n(
              'Pay TunnelSats VPN subscription invoice (${amount} sats)',
              {
                amount: String(order.amountSats),
              },
            ),
          },
        ),
    })

    return {
      version: '1' as const,
      title: i18n('Invoice Created'),
      message: i18n(
        'A payment task has been raised on your Lightning node. You can also pay manually using the invoice below. Once payment is confirmed, the VPN tunnel will be activated automatically.',
      ),
      result: {
        type: 'group' as const,
        value: [
          {
            name: i18n('BOLT11 Invoice'),
            description: null,
            type: 'single' as const,
            value: order.invoice,
            copyable: true,
            masked: false,
            qr: true,
          },
          {
            name: i18n('Amount'),
            description: null,
            type: 'single' as const,
            value: `${order.amountSats} sats`,
            copyable: false,
            masked: false,
            qr: false,
          },
          {
            name: i18n('Payment Hash'),
            description: null,
            type: 'single' as const,
            value: order.paymentHash,
            copyable: true,
            masked: false,
            qr: false,
          },
        ],
      },
    }
  },
)
