# TunnelSats

## Getting Started

TunnelSats provides dedicated, privacy-focused WireGuard VPN infrastructure specifically designed for Lightning Network nodes (LND, Core Lightning and Eclair).

### Option 1: Native Storefront (Recommended)

1. In StartOS, open the **TunnelSats Web Dashboard**, or run **Services** &rarr; **TunnelSats** &rarr; **Actions** &rarr; **Buy Subscription**.
2. Select your target Lightning node (`LND`, `Core Lightning` or `Eclair`) and your preferred plan duration.
3. The package generates a fresh Curve25519 WireGuard keypair locally in-process on your device (your private key never leaves your server).
4. Pay the Lightning invoice: through the **Pay Invoice** task the Buy Subscription action raises on your node, via WebLN, or by scanning the BOLT11 QR code with any Lightning wallet.
5. Once settled, TunnelSats automatically provisions your configuration and emits a routing task to your Lightning node.
6. **Activate Routing**:
   - Open your target Lightning node in StartOS.
   - Accept the 1-click prompt: **"Route [Node] through the TunnelSats tunnel"**.
   - Your node brings up WireGuard internally (`wg0`), announces its public address, and routes its clearnet peer traffic through the encrypted tunnel (see the kill switch caveat below).

### Option 2: Bring Your Own Configuration

1. If you already have an active TunnelSats WireGuard configuration, open **Services** &rarr; **TunnelSats** &rarr; **Actions** &rarr; **Import Subscription** (or click "Bring Your Own Config" in the Web Dashboard).
2. Select your **Target Lightning Node** (`LND`, `Core Lightning` or `Eclair`) and paste your `.conf` file.
3. Accept the 1-click routing prompt on your target Lightning node.

### Switching Off or Changing the Node

Use the **Configure** action to switch TunnelSats off, pick a different target node, or replace the WireGuard configuration. When TunnelSats is switched off or moves to another node, the node that used the tunnel asks you to turn it off first; the new node is asked to take over afterwards.

---

## Routing & Full Egress Privacy

- **In-Container Egress Privacy**: The Lightning node owns the WireGuard tunnel directly inside its container (`wg0`). Policy routing (table 51820) sends all clearnet peer traffic (inbound connections, gossip, ping/pong acknowledgments) through the tunnel.
- **Home IP Hidden While the Tunnel Is Up**: Clearnet peers see the TunnelSats server address, not your home ISP address.
- **Kill Switch Caveat**: The tunnel and its routing belong to your Lightning node package, not to TunnelSats. With current node builds, clearnet traffic can fall back to your home connection if `wg0` goes down or is removed; a fix in the node packages is pending. While `wg0` is up, clearnet peer traffic uses the tunnel.
- **Tor Hybrid Coexistence**: Onion peer connections continue to route normally over the Tor network across the container bridge, while clearnet peer traffic is routed through TunnelSats.
- **IPv6**: How your node routes IPv6 is decided by the Lightning node package. Current builds send IPv6 through the tunnel when the configuration's `AllowedIPs` include `::/0` (TunnelSats configurations do), and block it otherwise. The **Allow IPv6 Endpoint** setting only lets TunnelSats hand your node an IPv6 server endpoint to announce.
- **No Box-Wide Changes**: Nothing to set up in the StartOS system settings, no interface firewall toggling, and no port 9735 conflicts. Only the target node's own traffic uses the tunnel.

---

## Bandwidth & Renewals

- **Monthly Allowance**: Subscriptions include 100 GB of transfer bandwidth per calendar month. Bandwidth counters reset automatically on the 1st of every month.
- **On-Demand Telemetry**: Current bandwidth usage and subscription validity are fetched on-demand when opening the Web Dashboard.
- **Renewal Reminders**: TunnelSats raises a **Renew Subscription** task when the subscription expires in 7 days or less, updates it at 3 days or less, and again once it has expired. Run **Renew Subscription** at any time to extend it; the invoice is paid through a Pay Invoice task on your Lightning node.
- **Lapsed Subscription**: When the subscription expires, TunnelSats disables the tunnel on its server, so your node's clearnet peer connections through TunnelSats stop until you renew or turn off the clearnet VPN on your node.
- **Notifications**: TunnelSats also posts a StartOS notification 7 and 3 days before the subscription expires, once it has expired, and when TunnelSats has no subscription for the WireGuard key in your configuration (then an **Import Subscription** task asks you to import a valid configuration or buy a new one). Each notification is sent once per subscription period; none are sent while TunnelSats is stopped.
- **Bandwidth Reset**: Once this month's usage reaches 70% of the allowance, the **Reset Bandwidth** action (Subscription group) buys a reset of the monthly counter for a small fee, paid through a Pay Invoice task on your Lightning node. Resets per month are limited, and every requested invoice holds one of them until it is paid or expires, so running the action again while an invoice is still payable shows the same invoice instead of requesting a new one. The reset is confirmed automatically once the payment settles.

---

## Sovereign Config Export

You retain full ownership and sovereignty over your cryptographic keys and WireGuard tunnel:

- Download or copy your active `.conf` anytime via the **Web Dashboard** or the **Export WireGuard Configuration** action.
- WireGuard configurations and subscription metadata are securely preserved in encrypted StartOS system backups.

---

## Documentation

- [TunnelSats Documentation](https://tunnelsats.com/guide)
