import { IMPOSSIBLE, VersionInfo } from '@start9labs/start-sdk'

export const current = VersionInfo.of({
  version: '0.4.0:5',
  releaseNotes: {
    en_US:
      'Native storefront (Buy, Renew and Reset Bandwidth actions with on-device Curve25519 key generation and Lightning node Pay Invoice settlement), in-container clearnet-vpn routing handoff for LND, Core Lightning and Eclair, optional NIP-47 NWC automatic renewal with Tor SOCKS5 support and backup secret exclusion, and a read-only telemetry dashboard.',
    es_ES:
      'Tienda integrada (acciones Comprar, Renovar y Restablecer ancho de banda con generación local de claves Curve25519 y pago mediante la tarea Pay Invoice del nodo), traspaso de enrutamiento clearnet-vpn en contenedor para LND, Core Lightning y Eclair, renovación automática opcional NWC (NIP-47) con soporte Tor SOCKS5 y exclusión de secretos en copias de seguridad, y panel de telemetría de solo lectura.',
    de_DE:
      'Integrierter Storefront (Aktionen für Kauf, Verlängerung und Bandbreiten-Reset mit lokaler Curve25519-Schlüsselerzeugung und Bezahlung über die Pay-Invoice-Aufgabe der Node), In-Container-clearnet-vpn-Routing-Übergabe für LND, Core Lightning und Eclair, optionale automatische NIP-47-NWC-Verlängerung mit Tor-SOCKS5-Unterstützung und Backup-Ausschluss des Geheimnisses sowie ein schreibgeschütztes Telemetrie-Dashboard.',
    pl_PL:
      'Wbudowany sklep (akcje zakupu, odnowienia i resetu transferu z lokalnym generowaniem kluczy Curve25519 oraz rozliczeniem przez zadanie Pay Invoice węzła), przekazywanie routingu clearnet-vpn w kontenerze dla LND, Core Lightning i Eclair, opcjonalne automatyczne odnawianie NIP-47 NWC z obsługą Tor SOCKS5 i wykluczeniem sekretu z kopii zapasowych oraz panel telemetrii tylko do odczytu.',
    fr_FR:
      'Boutique intégrée (actions Acheter, Renouveler et Réinitialiser la bande passante avec génération locale de clés Curve25519 et règlement via la tâche Pay Invoice du nœud), transfert de routage clearnet-vpn en conteneur pour LND, Core Lightning et Eclair, renouvellement automatique optionnel NIP-47 NWC avec prise en charge Tor SOCKS5 et exclusion du secret des sauvegardes, et tableau de bord de télémétrie en lecture seule.',
  },
  migrations: {
    up: async ({ effects }) => {},
    down: IMPOSSIBLE,
  },
})
