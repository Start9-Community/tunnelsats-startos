# TunnelSats

## Getting Started

TunnelSats provides dedicated, privacy-focused WireGuard VPN infrastructure specifically designed for Lightning Network nodes (LND, Core Lightning and Eclair).

### Option 1: Native Storefront (Recommended)

1. In StartOS, open **Services** &rarr; **TunnelSats** &rarr; **Actions** &rarr; **Buy Subscription**.
2. Select your target Lightning node (`LND`, `Core Lightning` or `Eclair`) and your preferred plan duration.
3. The package generates a fresh Curve25519 WireGuard keypair locally in-process on your device (your private key never leaves your server).
4. Pay the Lightning invoice: through the **Pay Invoice** task the Buy Subscription action raises on your node, or by scanning / copying the BOLT11 invoice returned by the action with any Lightning wallet.
5. Once settled, TunnelSats automatically provisions your configuration and emits a routing task to your Lightning node.
6. **Activate Routing**:
   - Open your target Lightning node in StartOS.
   - Accept the 1-click task: **"Activate TunnelSats VPN tunnel and advertise clearnet endpoint to the Lightning Network"**.
   - Your node brings up WireGuard internally (`wg0`), announces its public address, and routes its clearnet peer traffic through the encrypted tunnel (see the kill switch note below).

### Option 2: Bring Your Own Configuration

1. If you already have an active TunnelSats WireGuard configuration, open **Services** &rarr; **TunnelSats** &rarr; **Actions** &rarr; **Import Subscription**.
2. Select your **Target Lightning Node** (`LND`, `Core Lightning` or `Eclair`) and paste your `.conf` file.
3. Accept the 1-click routing prompt on your target Lightning node.

### Switching Off or Changing the Node

Use the **Configure** action to switch TunnelSats off, pick a different target node, or replace the WireGuard configuration. When TunnelSats is switched off or moves to another node, the node that used the tunnel asks you to turn it off first; the new node is asked to take over afterwards.

---

## Routing & Full Egress Privacy

- **In-Container Egress Privacy**: The Lightning node owns the WireGuard tunnel directly inside its container (`wg0`). Policy routing (table 51820) sends all clearnet peer traffic (inbound connections, gossip, ping/pong acknowledgments) through the tunnel.
- **Home IP Hidden While the Tunnel Is Up**: Clearnet peers see the TunnelSats server address, not your home ISP address.
- **Kill Switch**: The tunnel and its routing belong to your Lightning node package, not to TunnelSats. This package requires LND 0.21.3-beta:10, Core Lightning 26.6.8:3 or Eclair 0.14.3:3 or later. Their routing table keeps a blackhole fallback: if `wg0` goes down, is removed or loses its server, clearnet traffic is dropped instead of leaving through your home connection, and at startup the node waits for the tunnel before connecting to peers. Tor traffic keeps working. Turning the tunnel off on purpose (disable TunnelSats in Configure, then accept the node's task to turn off the TunnelSats tunnel) returns clearnet traffic to your home connection.
- **Tor Hybrid Coexistence**: Onion peer connections continue to route normally over the Tor network across the container bridge, while clearnet peer traffic is routed through TunnelSats.
- **IPv6**: How your node routes IPv6 is decided by the Lightning node package. Current builds send IPv6 through the tunnel when the configuration's `AllowedIPs` include `::/0` (TunnelSats configurations do), and block it otherwise. The **Allow IPv6 Endpoint** setting only lets TunnelSats hand your node an IPv6 server endpoint to announce.
- **No Box-Wide Changes**: Nothing to set up in the StartOS system settings, no interface firewall toggling, and no port 9735 conflicts. Only the target node's own traffic uses the tunnel.
- **Companion Package Egress**: TunnelSats's own control-plane calls to `https://tunnelsats.com/api/public/v1` (server list, order/renewal creation, invoice status, config claim, status sync, and the optional inbound port check) must work while the WireGuard tunnel is down or expired, so they leave your server through the StartOS outbound gateway configured for the TunnelSats service (or the system default connection). When NWC auto-renewal is enabled, Nostr relay traffic uses that same outbound gateway unless **Route wallet traffic through Tor** is enabled (or the relay is a `.onion` address), in which case relay traffic is routed through the Tor service's SOCKS5 proxy and fails closed if Tor is unreachable.

---

## Bandwidth & Renewals

- **Monthly Allowance**: Subscriptions include 100 GB of transfer bandwidth per calendar month. Bandwidth counters reset automatically on the 1st of every month.
- **Subscription & Bandwidth Telemetry**: Current bandwidth usage and subscription validity are synced by the TunnelSats daemon and displayed in the read-only Web Dashboard.
- **Renewal Reminders**: TunnelSats raises a **Renew Subscription** task when the subscription expires in 7 days or less, updates it at 3 days or less, and again once it has expired. Run **Renew Subscription** at any time to extend it; the invoice is paid through a Pay Invoice task on your Lightning node.
- **Automatic Renewal (NWC — Connect Wallet)**: Optionally open **Services** &rarr; **TunnelSats** &rarr; **Actions** &rarr; **Connect Wallet** and paste a `nostr+walletconnect://` (NIP-47) URI to enable unattended renewals (off by default). When the API-confirmed expiry is 7 days or less away, TunnelSats requests one renewal invoice for your chosen duration (matching your last purchase by default, or 1 / 3 / 6 / 12 months) and pays it via your connected wallet. Because BTC/fiat exchange rates cannot be foreseen over the next 12 months, we recommend setting a conservative wallet budget with a **1.2&times; buffer** above the current estimated satoshi cost (shown in the Connect Wallet action and dashboard). If the wallet reports insufficient budget/balance or if 3 renewal attempts fail across sync cycles, TunnelSats stops automatic retries for that period, raises the **Pay Invoice** task on your Lightning node (plus a **Connect Wallet** task if budget is insufficient), and posts a StartOS notification. Every successful auto-renewal also posts a StartOS notification with the amount paid and new expiry date. **Match Last Purchase** uses the last paid plan; creating an unpaid Buy or Renew invoice does not change the automatic renewal duration.
- **Lapsed Subscription**: When the subscription expires, TunnelSats disables the tunnel on its server, so your node's clearnet peer connections through TunnelSats stop until you renew or turn off the clearnet VPN on your node.
- **Notifications**: TunnelSats also posts a StartOS notification 7 and 3 days before the subscription expires, once it has expired, and when TunnelSats has no subscription for the WireGuard key in your configuration (then an **Import Subscription** task asks you to import a valid configuration or buy a new one). Each notification is sent once per subscription period; none are sent while TunnelSats is stopped or switched off, and a due one goes out once it runs again. A paid order you had replaced, recovered without replacing your active tunnel, is announced once as well (see **Export WireGuard Configuration** below).
- **Bandwidth Reset**: Once this month's usage reaches 70% of the allowance, the **Reset Bandwidth** action (Subscription group) buys a reset of the monthly counter for a small fee, paid through a Pay Invoice task on your Lightning node. Resets per month are limited, and every requested invoice holds one of them until it is paid or expires, so running the action again while an invoice is still payable shows the same invoice instead of requesting a new one. The reset is confirmed automatically once the payment settles.

---

## Sovereign Config Export

You retain full ownership and sovereignty over your cryptographic keys and WireGuard tunnel:

- Copy your active `.conf` anytime via **Services** &rarr; **TunnelSats** &rarr; **Actions** &rarr; **Export WireGuard Configuration**. This action also lists configurations recovered from paid invoices that you replaced. A recovered order never replaces a tunnel you already have (bought, imported, or switched off in **Configure**); use **Import Subscription** to activate one of the recovered configurations.
- If **Buy Subscription** reports too many replaced orders awaiting settlement, wait for their payments to settle or their unpaid invoices to expire. Their private keys are kept until payment status has been checked.
- WireGuard configurations and subscription metadata are securely preserved in encrypted StartOS system backups. For security, the NWC spending credential (`/data/nwc-wallet.json`) is excluded from StartOS backups; restoring from a backup raises a **Connect Wallet** task prompting you to reconnect your wallet.

---

## Documentation

- [TunnelSats Documentation](https://tunnelsats.com/guide)
