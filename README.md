# TunnelSats for StartOS

<img src="https://raw.githubusercontent.com/Tunnelsats/tunnelsats/ffb4732328045922dc90eb5580654077e8d3f246/images/brand/logos/ts_logo_rectangle.svg" alt="TunnelSats Logo" width="400"/>

A privacy-focused companion package and routing guide for Lightning Network nodes (LND, Core Lightning and Eclair) on StartOS.

## Table of Contents

- [Overview](#overview)
- [Quick Reference for AI Consumers](#quick-reference-for-ai-consumers)
- [Architecture & How It Works](#architecture--how-it-works)
- [Volumes & Mount Points](#volumes--mount-points)
- [Subcontainers](#subcontainers)
- [File Models](#file-models)
- [Actions & Tasks](#actions--tasks)
- [Network & Privacy Disclosure](#network--privacy-disclosure)
- [Development & Testing](#development--testing)
- [License](#license)

## Overview

TunnelSats provides dedicated WireGuard VPN infrastructure specifically designed for Lightning Network nodes (LND, Core Lightning and Eclair). The package features a native storefront for 1-click subscription purchasing and renewals via the Lightning Network, in-process Curve25519 WireGuard keypair generation, on-demand bandwidth telemetry (100GB monthly allowance), and seamless integration with StartOS in-container clearnet VPN routing.

> [!NOTE]
> **Native Storefront & In-Container Clearnet VPN Architecture**:
>
> - **In-Process Keygen**: Generates Curve25519 WireGuard keypairs in-process on your device; private keys never leave your node.
> - **Native Storefront**: Browse plans, generate BOLT11 invoices, and pay directly via WebLN or any Lightning wallet.
> - **In-Container Egress Privacy**: The Lightning node owns the WireGuard tunnel directly inside its own container (`wg0` with routing table 51820). Egress policy routing encapsulates outgoing clearnet peer traffic (gossip, handshakes, ping/pong acks) with fail-closed privacy, while hybrid Tor traffic continues across the bridge network.
> - **No Box-Wide Changes**: Nothing is configured in the StartOS system settings, no config markers, no firewall toggles, and no multi-node port 9735 race. Only the target node's own traffic uses the tunnel.
> - **Bandwidth Telemetry**: 100GB monthly bandwidth limit per calendar month, fetched on-demand when the UI is opened.
> - **Sovereign Config Export**: Download or export your raw `.conf` anytime.
> - **Renewal Reminders**: A Renew Subscription task is raised when the subscription expires in 7 days or less, updated at 3 days or less, and again once it has expired.

## Quick Reference for AI Consumers

```yaml
package_id: tunnelsats
title: TunnelSats
description: A privacy-focused VPN storefront and manager for Lightning Nodes (LND/CLN/Eclair).
architecture:
  model: native-storefront companion in-container clearnet vpn
  ui_port: 80
  telemetry_daemon: python3 bridge.py
  external_services:
    - https://tunnelsats.com (server discovery, subscription orders, and status sync)
volumes:
  - name: main
    path: /data
subcontainers:
  - name: main
    image: tunnelsats
actions:
  - id: import-subscription
    name: Import Subscription
  - id: buy-subscription
    name: Buy Subscription
  - id: renew-subscription
    name: Renew Subscription
  - id: reset-bandwidth
    name: Reset Bandwidth
  - id: export-config
    name: Export WireGuard Configuration
  - id: configure
    name: Configure
tasks:
  - tunnelsats:renew-subscription (renewal reminder)
  - <node>:clearnet-vpn on lnd / c-lightning / eclair (1-click tunnel on/off prompt, announces the tunnel address)
  - Pay Invoice tasks on the node for Buy / Renew / Reset Bandwidth
```

## Architecture & How It Works

1. **Native Storefront**: Users can purchase or renew subscriptions directly from the Web Dashboard. The package generates a fresh Curve25519 WireGuard keypair locally, submits an order to `api.tunnelsats.com`, and displays a BOLT11 invoice. Once settled, the active `.conf` is provisioned automatically.
2. **Bring Your Own Config**: Users with an existing TunnelSats subscription can paste their `.conf` via the **Import Subscription** action or Web Dashboard.
3. **In-Container Clearnet VPN & Fail-Closed Egress**: The WireGuard tunnel runs directly inside the target Lightning node container (`lnd`, `c-lightning` or `eclair`). Inbound peer connections arrive directly on `<tunnel-ip>:9735` where the daemon is already listening—eliminating host-level port forwards and port 9735 multi-node conflicts. The container's policy routing (`table 51820`) encapsulates all outbound clearnet peer traffic (handshakes, gossip, ping/pong acknowledgments) with fail-closed privacy—preventing home IP leaks even if the tunnel drops—while Tor traffic continues across the bridge network (`eth0`). The operator simply accepts a 1-click prompt on their node: **"Route [Node] through the TunnelSats tunnel"**.
4. **Subscription Lifecycle & Renewal**: The background daemon monitors subscription expiration, updating the local dashboard and raising StartOS tasks when renewal is required.

## Volumes & Mount Points

| Volume Name | Container Path | Purpose                                                                                        |
| ----------- | -------------- | ---------------------------------------------------------------------------------------------- |
| `main`      | `/data`        | Stores `config.json`, `tunnelsatsv3.conf`, and synchronized metadata (`tunnelsats-meta.json`). |

## Subcontainers

| Subcontainer | Base Image             | Entrypoint             | Purpose                                                                    |
| ------------ | ---------------------- | ---------------------- | -------------------------------------------------------------------------- |
| `main`       | Debian Slim (Python 3) | `docker_entrypoint.sh` | Serves web UI on port 80 and runs the subscription synchronization daemon. |

## File Models

- **`config.json`**: Primary service configuration (`enabled`, `target-node`, `tunnelsats-conf`, `allow-ipv6`).
- **`tunnelsatsv3.conf`**: WireGuard configuration file written to disk when enabled.
- **`tunnelsats-meta.json`**: Cached subscription metadata (`expiresAt`, `lastSync`, `syncSuccess`, `serverDomain`, `vpnPort`, `bandwidth_used_gb`).

## Actions & Tasks

- **Import / Buy / Renew Subscription**, **Reset Bandwidth**: Storefront actions. Keys are generated on the device; invoices are paid through Pay Invoice tasks on the node.
- **Configure (`configure`)**: Enable/disable TunnelSats, pick the target Lightning node (`lnd`, `cln` or `eclair`), replace the WireGuard configuration, and toggle IPv6 coexistence.
- **Export Configuration (`export-config`)**: Displays the stored WireGuard configuration as-is in a masked, copyable modal.
- **Automated Tasks**:
  - `tunnelsats:renew-subscription`: Raised (Important) when the confirmed expiry is `<= 7 days` away, updated at `<= 3 days` and on expiry. Cleared once a renewal is confirmed.
  - `<node>:clearnet-vpn` (on `lnd`, `c-lightning` or `eclair`): the on-task asks the target node, with 1 click, to run the tunnel and announce its public endpoint (`<VPN_IP>:<VPN_PORT>`); the off-task asks a node that used the tunnel before to turn it off.
  - Task keys of earlier versions (`tunnelsats:configure`, `tunnelsats:import-subscription`, `lnd:custom-external-host-config`, `c-lightning:config`) are cleared on every run.

## Network & Privacy Disclosure

- **Subscription API & Status**: This package queries `https://api.tunnelsats.com` for server discovery, order generation, and on-demand subscription status / bandwidth usage using your WireGuard public key.
- **IPv4 Routing & Fail-Closed Privacy**: TunnelSats WireGuard tunnels route IPv4 traffic directly inside the node container. Outbound clearnet peer traffic is encapsulated within the VPN tunnel. If you enable **Allow Home IPv6 Coexistence**, raw IPv6 traffic bypasses the VPN.

## Development & Testing

```bash
# Run all tests (TypeScript, Python, BATS)
npm run test:all

# Typecheck and build bundle
npm run check && npm run build
```

## License

This project is licensed under the MIT License - see the [LICENSE](LICENSE) file for details.
