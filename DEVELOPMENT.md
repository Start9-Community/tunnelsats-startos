# Developing TunnelSats for StartOS

This document details the development workflow, architecture, testing procedures, and release processes for developers contributing to the TunnelSats StartOS package.

---

## 🏗 Package Architecture (StartOS TypeScript SDK)

TunnelSats is built using the StartOS TypeScript SDK (`@start9labs/start-sdk`).

### Core Components (`startos/`)

- **`startos/manifest/index.ts`**: Defines package identity, container images, volume mounts, and dynamic dependencies.
- **`startos/main.ts`**: Sets up the primary daemon, readiness probes for the Web Dashboard on port 80, and registers background subscription health checks.
- **`startos/actions/`**: Storefront actions: Buy, Renew and Import Subscription, Reset Bandwidth, Export WireGuard Configuration, and Configure (enable/disable TunnelSats, pick the target node `lnd` / `cln` / `eclair`, replace the WireGuard config, IPv6 coexistence).
- **`startos/dependencies.ts`** / **`startos/vpnHandoff.ts`**: Dynamic dependencies, the Renew reminder task, and the clearnet-vpn handoff: an on-task on the target node's `clearnet-vpn` action (which runs the tunnel as `wg0` inside the node container) and an off-task for a node that used the tunnel before.
- **`bridge.py`**: Python orchestrator serving the Web Dashboard and its API (`GET /api/dashboard`, `GET /api/servers` for the cached server list, `POST /api/intents` for dashboard-started Buy / Renew / Reset Bandwidth, `POST /api/reachability` for the rate-limited inbound ping test), plus telemetry synchronization and payment settlement. The POST endpoints require a trusted request with the CSRF token.
- **`verify.sh`**: In-container diagnostics (stored config, subscription health, dashboard API). The tunnel runs on the node, so the node-side checks (`wg show`, `ip rule`, `ip route show table 51820`, egress probes) are printed as manual steps and never reported as verified.

---

## 🛠 Local Development & Testing

### Prerequisites
- **Node.js**: v22.x / npm v10+
- **Python**: v3.11+
- **StartOS CLI**: `start-cli` (from [Start9 Technologies Releases](https://github.com/Start9Labs/start-technologies/releases))
- **Docker**: For multi-arch package compilation (`docker buildx`)

### Running the Test Suites

```bash
# 1. Complete Test Suite (TypeScript, Python, BATS)
npm run test:all

# 2. TypeScript Typecheck
npx tsc --noEmit

# 3. Package build gate (typecheck, SDK lint, format check, bundle)
rm -rf javascript && make javascript/index.js

# 4. Python Unit Tests (unittest)
python3 -m unittest discover -s tests -p "test_*.py"

# 5. BATS Diagnostic & Config Tests
npm run test:bats
```

---

## 🔒 Security & Privacy Guidelines

1. **Zero Secret Leaks**: Test fixtures and code examples must strictly use dummy test keys (`DUMMY_TEST_PRIVATE_KEY_...`). Active WireGuard private keys and residential IP addresses must never be committed or logged.
2. **Fail-Closed Verification**: Health checks and status probes must fail closed on unverified network state.
3. **IPv6 Leak Protection**: Ensure IPv6 WAN routes remain blocked or unadvertised unless the user explicitly opts into dual-stack coexistence.
