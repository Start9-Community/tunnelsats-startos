import { IMPOSSIBLE, VersionInfo } from '@start9labs/start-sdk'

export const current = VersionInfo.of({
  version: '1.0.0:1',
  releaseNotes: {
    en_US:
      'TunnelSats shows as running while a node handoff or a payment is pending. Restarting TunnelSats while it starts up leaves exactly one copy of it running.',
    es_ES:
      'TunnelSats aparece en ejecución mientras hay pendiente un traspaso de nodo o un pago. Reiniciar TunnelSats mientras arranca deja exactamente una copia en ejecución.',
    de_DE:
      'TunnelSats wird als laufend angezeigt, solange eine Knotenübergabe oder eine Zahlung aussteht. Ein Neustart von TunnelSats während des Startvorgangs lässt genau eine Instanz laufen.',
    pl_PL:
      'TunnelSats jest pokazywany jako uruchomiony, gdy oczekuje przekazanie węzła lub płatność. Ponowne uruchomienie TunnelSats podczas startu pozostawia dokładnie jedną działającą kopię.',
    fr_FR:
      'TunnelSats apparaît comme en cours d’exécution tant qu’un transfert de nœud ou un paiement est en attente. Redémarrer TunnelSats pendant son démarrage laisse exactement une seule copie en cours d’exécution.',
  },
  migrations: {
    up: async ({ effects }) => {},
    down: IMPOSSIBLE,
  },
})
