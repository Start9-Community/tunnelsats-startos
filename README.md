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
> - **Native Storefront**: Browse plans, generate BOLT11 invoices, and pay directly through StartOS Actions and a Pay Invoice task on your Lightning node (or with any external Lightning wallet).
> - **In-Container Egress Privacy**: The Lightning node owns the WireGuard tunnel directly inside its own container (`wg0` with routing table 51820). Egress policy routing sends outgoing clearnet peer traffic (gossip, handshakes, ping/pong acks) through the tunnel, while hybrid Tor traffic continues across the bridge network. See the kill switch caveat under [Network & Privacy Disclosure](#network--privacy-disclosure).
> - **No Box-Wide Changes**: Nothing is configured in the StartOS system settings, no config markers, no firewall toggles, and no multi-node port 9735 race. Only the target node's own traffic uses the tunnel.
> - **Bandwidth Telemetry**: 100GB monthly bandwidth limit per calendar month, synced by the background daemon and shown in the read-only Web Dashboard.
> - **Sovereign Config Export**: Export your raw `.conf` anytime via the **Export WireGuard Configuration** action.
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

1. **Native Storefront**: Users purchase or renew subscriptions via StartOS Actions (**Buy Subscription** / **Renew Subscription**). The action generates a fresh Curve25519 WireGuard keypair locally, submits an order to `api.tunnelsats.com`, raises a **Pay Invoice** task on the target Lightning node, and displays the BOLT11 invoice. Once settled, the active `.conf` is provisioned automatically.
2. **Bring Your Own Config**: Users with an existing TunnelSats subscription can paste their `.conf` via the **Import Subscription** action.
3. **In-Container Clearnet VPN & Egress**: The WireGuard tunnel runs directly inside the target Lightning node container (`lnd`, `c-lightning` or `eclair`). Inbound peer connections arrive directly on `<tunnel-ip>:9735` where the daemon is already listening—eliminating host-level port forwards and port 9735 multi-node conflicts. The container's policy routing (`table 51820`) sends all outbound clearnet peer traffic (handshakes, gossip, ping/pong acknowledgments) through the tunnel while it is up (see the kill switch caveat below), while Tor traffic continues across the bridge network (`eth0`). The operator simply accepts a 1-click prompt on their node: **"Route [Node] through the TunnelSats tunnel"**.
4. **Subscription Lifecycle & Renewal**: The background daemon monitors subscription expiration, updating the local dashboard, raising StartOS tasks when renewal is required, and posting StartOS notifications 7 and 3 days before expiry, on lapse, and when the configured key has no subscription.

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
- **Configure (`configure`)**: Enable/disable TunnelSats, pick the target Lightning node (`lnd`, `cln` or `eclair`), replace the WireGuard configuration, and allow an IPv6 server endpoint to be announced.
- **Export Configuration (`export-config`)**: Displays the stored WireGuard configuration as-is in a masked, copyable modal.
- **Automated Tasks**:
  - `tunnelsats:renew-subscription`: Raised (Important) when the confirmed expiry is `<= 7 days` away, updated at `<= 3 days` and on expiry. Cleared once a renewal is confirmed.
  - `<node>:clearnet-vpn` (on `lnd`, `c-lightning` or `eclair`): the on-task asks the target node, with 1 click, to run the tunnel and announce its public endpoint (`<VPN_IP>:<VPN_PORT>`); the off-task asks a node that used the tunnel before to turn it off.
  - `tunnelsats:unknown-key`: Raised (Important, opens Import Subscription) when TunnelSats has no subscription for the configured key. Cleared once the key is confirmed or replaced.
  - When the TunnelSats API reports a new forwarded port for the key, the stored configuration's port marker is updated and the node's `clearnet-vpn` task is raised again with the new announce address (active once the API returns the port).
  - Task keys of earlier versions (`tunnelsats:configure`, `tunnelsats:import-subscription`, `lnd:custom-external-host-config`, `c-lightning:config`) are cleared on every run.

## Network & Privacy Disclosure

- **Subscription API & Status**: This package queries `https://api.tunnelsats.com` for server discovery, order generation, and on-demand subscription status / bandwidth usage using your WireGuard public key.
- **Routing**: The tunnel runs inside the node container, and outbound clearnet peer traffic is sent through it while `wg0` is up. IPv6 routing is decided by the node package: current builds send IPv6 through the tunnel when `AllowedIPs` include `::/0`, and block it otherwise. **Allow IPv6 Endpoint** only lets TunnelSats hand the node an IPv6 server endpoint to announce.
- **Kill Switch Caveat**: The tunnel and its routing belong to your Lightning node package, not to TunnelSats. With current node builds, clearnet traffic can fall back to your home connection if `wg0` goes down or is removed; a fix in the node packages is pending. While `wg0` is up, clearnet peer traffic uses the tunnel.

## Development & Testing

```bash
# Run all tests (TypeScript, Python, BATS)
npm run test:all

# Typecheck and build bundle
npm run check && npm run build
```

## License

This project is licensed under the MIT License - see the [LICENSE](LICENSE) file for details.
