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
   - Your node brings up WireGuard internally (`wg0`), announces its public address, and routes all clearnet peer traffic through the encrypted tunnel with fail-closed privacy.

### Option 2: Bring Your Own Configuration

1. If you already have an active TunnelSats WireGuard configuration, open **Services** &rarr; **TunnelSats** &rarr; **Actions** &rarr; **Import Subscription** (or click "Bring Your Own Config" in the Web Dashboard).
2. Select your **Target Lightning Node** (`LND`, `Core Lightning` or `Eclair`) and paste your `.conf` file.
3. Accept the 1-click routing prompt on your target Lightning node.

### Switching Off or Changing the Node

Use the **Configure** action to switch TunnelSats off, pick a different target node, or replace the WireGuard configuration. When TunnelSats is switched off or moves to another node, the node that used the tunnel asks you to turn it off first; the new node is asked to take over afterwards.

---

## Routing & Full Egress Privacy

- **In-Container Egress Privacy**: The Lightning node owns the WireGuard tunnel directly inside its container (`wg0`). Policy routing (table 51820) encapsulates all clearnet peer traffic (inbound connections, gossip, ping/pong acknowledgments) with fail-closed privacy.
- **Zero Residential IP Leakage**: Your home ISP IP address is never exposed to the clearnet Lightning Network.
- **Tor Hybrid Coexistence**: Onion peer connections continue to route normally over the Tor network across the container bridge, while clearnet peer traffic is routed through TunnelSats.
- **IPv4 Routing**: TunnelSats routes IPv4 traffic. Residential IPv6 traffic is disabled by default to prevent clearnet ISP address leaks.
- **No Box-Wide Changes**: Nothing to set up in the StartOS system settings, no interface firewall toggling, and no port 9735 conflicts. Only the target node's own traffic uses the tunnel.

---

## Bandwidth & Renewals

- **Monthly Allowance**: Subscriptions include 100 GB of transfer bandwidth per calendar month. Bandwidth counters reset automatically on the 1st of every month.
- **On-Demand Telemetry**: Current bandwidth usage and subscription validity are fetched on-demand when opening the Web Dashboard.
- **Renewal Reminders**: TunnelSats raises a **Renew Subscription** task when the subscription expires in 7 days or less, updates it at 3 days or less, and again once it has expired. Run **Renew Subscription** at any time to extend it; the invoice is paid through a Pay Invoice task on your Lightning node.
- **Bandwidth Reset**: Once this month's usage reaches 70% of the allowance, the **Reset Bandwidth** action (Subscription group) buys a reset of the monthly counter for a small fee, paid through a Pay Invoice task on your Lightning node. Resets per month are limited, and every requested invoice holds one of them until it is paid or expires, so running the action again while an invoice is still payable shows the same invoice instead of requesting a new one. The reset is confirmed automatically once the payment settles.

---

## Sovereign Config Export

You retain full ownership and sovereignty over your cryptographic keys and WireGuard tunnel:

- Download or copy your active `.conf` anytime via the **Web Dashboard** or the **Export WireGuard Configuration** action.
- WireGuard configurations and subscription metadata are securely preserved in encrypted StartOS system backups.

---

## Documentation

- [TunnelSats Documentation](https://tunnelsats.com/guide)
