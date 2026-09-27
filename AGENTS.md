# Agent & Developer Guidelines for TunnelSats StartOS

This document defines architecture, conventions, testing, and contribution standards for developers and AI agents working on the TunnelSats StartOS package.

## Architecture Overview

- **Node-Owned Clearnet VPN Model**: The WireGuard tunnel runs inside the target Lightning node's own container (LND, Core Lightning or Eclair), brought up by the node's `clearnet-vpn` action as `wg0` with policy routing table 51820 (fail-closed: clearnet peer traffic stops if the tunnel drops; Tor keeps working). Nothing is configured box-wide in StartOS; the retired host gateway model (config markers, system gateways, routing node egress through a host gateway) must not be reintroduced.
- **Companion Package**: The `tunnelsats` container never carries tunnel traffic. It provides:
  - Storefront actions (Buy, Renew, Import, Reset Bandwidth, Export, Configure) with on-device keygen; invoices are paid through Pay Invoice tasks on the node.
  - The clearnet-vpn handoff (`startos/dependencies.ts`, `startos/vpnHandoff.ts`): an on-task (`accept: [{ config, announce }]`, matched exactly against the stored config) for the target node, an off-task for any node that used the tunnel before.
  - Web UI Dashboard on port 80 (monitoring subscription status and connection properties).
  - Background daemon (`subscription_sync_loop`) synchronizing metadata from `https://tunnelsats.com/api/public/v1/subscription/status`, and the settlement watcher for Buy/Renew/Reset payments.
  - StartOS 0.4.0 Actions & Tasks (`sdk.action.createTask`, `sdk.action.createOwnTask`, `sdk.action.clearTask`) for the node handoff and renewal reminders.
  - Fail-closed health checks monitoring subscription validity, the VPN handoff and payment settlement.
- **Stored config is passed through verbatim**: never rewrite a stored WireGuard config (e.g. to strip markers written by earlier versions). The node task accepts the exact string, so any rewrite re-raises it on every upgraded box.

## Project Structure

```
├── startos/                # StartOS TypeScript SDK package definition
│   ├── actions/            # User-facing StartOS actions (buy, renew, import, reset, export, configure)
│   ├── fileModels/         # Typed filesystem bindings (config.json, tunnelsatsConf, tunnelsatsMeta)
│   ├── i18n/               # Multi-language dictionaries (en_US, es_ES, de_DE, pl_PL, fr_FR)
│   ├── manifest/           # Package metadata, icons, and descriptions
│   ├── versions/           # Version graph and migration history
│   ├── dependencies.ts     # Dynamic dependencies, renewal reminder and clearnet-vpn handoff tasks
│   ├── vpnHandoff.ts       # Handoff planning between target nodes
│   ├── interfaces.ts       # Service interface bindings
│   ├── main.ts             # Service process and health check definitions
│   └── utils.ts            # WireGuard parsing and validation utilities
├── web/                    # Dashboard UI (HTML, CSS, Vanilla JS)
├── tests/                  # Unit and integration test suites
├── bridge.py               # Python service bridge, telemetry sync daemon, settlement and HTTP server
├── verify.sh               # In-container diagnostics; node-side tunnel checks are printed as manual steps
└── docker_entrypoint.sh    # Container entrypoint
```

## Development & Test Commands

```bash
# Run complete test suite (TypeScript, Python, BATS)
npm run test:all

# TypeScript typecheck
npm run check

# Bundle JavaScript package
npm run build

# Python unit tests
python3 -m unittest discover -s tests -p 'test_*.py'

# BATS integration tests
npm run test:bats
```

## Coding & Security Standards

- **Zero Mocked Dataplanes**: Never mock or stub network dataplanes. Health checks and telemetry must be honest and fail-closed.
- **Outbound Disclosure**: Explicitly document outbound network calls to `https://tunnelsats.com/api/public/v1/subscription/status` for subscription telemetry.
- **Commit Conventions**: Use Conventional Commits (`feat:`, `fix:`, `refactor:`, `test:`, `docs:`).
