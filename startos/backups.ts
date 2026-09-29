import { sdk } from './sdk'

export const NWC_BACKUP_EXCLUDES = ['nwc-wallet.json'] as const

export function buildMainBackups() {
  return sdk.Backups.ofVolumes('main').setOptions({
    exclude: [...NWC_BACKUP_EXCLUDES],
  })
}

export const { createBackup, restoreInit } = sdk.setupBackups(
  async () => buildMainBackups(),
)

