import { sdk } from '../sdk'
import { configure } from './configure'
import { exportConfig } from './exportConfig'
import { importSubscription } from './importSubscription'
import { buySubscription } from './buySubscription'
import { renewSubscription } from './renewSubscription'
import { resetBandwidth } from './resetBandwidth'
import { connectWallet } from './connectWallet'

export const actions = sdk.Actions.of()
  .addAction(importSubscription)
  .addAction(buySubscription)
  .addAction(renewSubscription)
  .addAction(connectWallet)
  .addAction(resetBandwidth)
  .addAction(exportConfig)
  .addAction(configure)

