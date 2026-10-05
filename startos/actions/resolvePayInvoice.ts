import { payInvoice as lndPayInvoice } from 'lnd-startos/startos/actions/payInvoice'
import { payInvoice as clnPayInvoice } from 'cln-startos/startos/actions/payInvoice'
import { payInvoice as eclairPayInvoice } from 'eclair-startos/startos/actions/payInvoice'

/** The Lightning package and its Pay Invoice action for a target node. */
export function resolvePayInvoice(targetNode: string) {
  switch (targetNode) {
    case 'cln':
      return { packageId: 'c-lightning', payInvoiceAction: clnPayInvoice }
    case 'eclair':
      return { packageId: 'eclair', payInvoiceAction: eclairPayInvoice }
    case 'lnd':
    default:
      return { packageId: 'lnd', payInvoiceAction: lndPayInvoice }
  }
}
