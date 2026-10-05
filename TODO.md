# TunnelSats StartOS Package — Marketplace Submission Roadmap

## 🚀 Marketplace Submission Pipeline (Start9 Community Registry)

- [x] **Step 1: Initial Submission Email**
  - Sent email to `submissions@start9.com` requesting inclusion in the Start9 Community Registry.
  - Repository: `https://github.com/Tunnelsats/tunnelsats-startos`
  - Release Tag: `v0.4.0-beta3` (Released & Published)

- [x] **Step 2: Start9 Fork & Feedback**
  - Start9 fork created at `https://github.com/Start9-Community/tunnelsats-startos`.
  - Addressed comprehensive code review feedback from Start9 packaging engineers ([Issue #54](https://github.com/Tunnelsats/tunnelsats-startos/issues/54)):
    - [x] ~~Gateway-model setup items~~ (markers, 3-step gateway setup, host egress routing, port-check and port 9735 notes): superseded, see [Superseded: StartOS Gateway Model](#superseded-startos-gateway-model).
    - [x] **Full Multilingual Localization**: Full release notes and descriptions across `en_US`, `es_ES`, `de_DE`, `pl_PL`, and `fr_FR`.
    - [x] **Enhanced Fail-Closed Diagnostics**: `verify.sh` now runs only in-container checks it can really execute and prints the node-side tunnel checks as manual steps (the host-interface audit was superseded with the gateway model).
    - [x] **Version Bumps**: Released `0.4.0:4` ([PR #80](https://github.com/Tunnelsats/tunnelsats-startos/pull/80)) and `0.4.0:5` ([PR #82](https://github.com/Tunnelsats/tunnelsats-startos/pull/82)) with 5/5 Greptile confidence and 100% CI pass rates.

- [ ] **Step 3: Community Beta Deployment (`community-beta`)** 👈 **CURRENT FOCUS**
  - **Action**: Open a Pull Request from `Tunnelsats/tunnelsats-startos:main` to `Start9-Community/tunnelsats-startos:main` ([PR #1](https://github.com/Start9-Community/tunnelsats-startos/pull/1)).
  - Originally carried the gateway-model release; the upstream reset replaced it with the node-owned clearnet-vpn model (see [Superseded: StartOS Gateway Model](#superseded-startos-gateway-model)).
  - Merging into the fork triggers `tagAndRelease.yml`, automatically building and deploying `1.0.0:0` to `https://community-beta-registry.start9.com`.

- [ ] **Step 4: Beta Soak Period & Verification**
  - Sideload/install beta package directly from the `community-beta` registry on the live StartOS VM (`https://tunnelsats-040.local`).
  - Verify that instructions at `https://tunnelsats-040.local/services/tunnelsats/instructions` render properly with all 3-step setup flow items and Address Requirements port check guidance.
  - Verify live end-to-end inbound Lightning connectivity.

- [ ] **Step 5: Production Promotion (`community`)**
  - Notify Start9 (`submissions@start9.com` or via issue/comment on `Start9-Community/tunnelsats-startos`) giving the final go-ahead to promote the package from `community-beta` to the primary public community registry (`https://community-registry.start9.com`).

---

## 🔒 Enhancements, Dataplane & Security Track

- [x] **Issue #34: Clarify IPv6 non-support and prevent home IP leaks** ([#34](https://github.com/Tunnelsats/tunnelsats-startos/issues/34) / [PR #35](https://github.com/Tunnelsats/tunnelsats-startos/pull/35))
  - Add `allow-ipv6` toggle (`Allow Home IPv6 Coexistence`) in `configure.ts` and `config.json.ts`.
  - Filter out / reject IPv6 endpoints in `getAnnounceEndpoint` parser (`startos/dependencies.ts`).
  - Add `allow_ipv6` to `bridge.py` `/api/status` and render Option 3 Security Warning Banner in `web/index.html` and `web/script.js`.
  - Add FAQ Q9 in `web/index.html` and IPv6 privacy policy section in `instructions.md`.

- [x] **Issue #54: Address Start9 Packaging Review & Inbound Dataplane** ([#54](https://github.com/Tunnelsats/tunnelsats-startos/issues/54) / [PR #80](https://github.com/Tunnelsats/tunnelsats-startos/pull/80) / [PR #81](https://github.com/Tunnelsats/tunnelsats-startos/pull/81) / [PR #82](https://github.com/Tunnelsats/tunnelsats-startos/pull/82))
  - Gateway-model work from this issue is superseded, see [Superseded: StartOS Gateway Model](#superseded-startos-gateway-model).
  - Return copyable `ActionResultV1` guidance in `configure` modal.
  - Remove synthetic `vpn_connected` / `handshake` reporting in `bridge.py` in favor of honest subscription state.

- [ ] **Future Enhancement: Node-Funded Auto-Renewals via TunnelSats API** ([#83](https://github.com/Tunnelsats/tunnelsats-startos/issues/83) / [Issue #54 Discussion](https://github.com/Tunnelsats/tunnelsats-startos/issues/54#issuecomment-5359358874))
  - Automatically request renewal invoices from the TunnelSats public API (`https://tunnelsats.com/api/public/v1/subscription/renew`) using the stored WireGuard public key when the subscription enters the expiration warning window ($\le 7$ days).
  - Support automated or 1-click renewal payment via:
    1. Direct Lightning RPC from the target node (LND `lncli payinvoice` / CLN `lightning-cli pay`).
    2. Nostr Wallet Connect (NWC) or LNbits sub-wallet with a configurable maximum sat limit per renewal.
  - Automatically update `tunnelsats-meta.json` with the extended expiration date, clear pending warning tasks, and push a success notification to the StartOS notification center.

- [ ] **Future Enhancement: In-App WAN Reachability Self-Test** ([#84](https://github.com/Tunnelsats/tunnelsats-startos/issues/84))
  - Add a dedicated "Test Inbound Connection" button inside the TunnelSats companion web dashboard (`web/index.html` / `bridge.py`).
  - Probes the live assigned public endpoint (`server.tunnelsats.com:port`) directly from the node or via an external ping service, displaying a green checkmark to provide immediate peace of mind for operators when StartOS's generic port 9735 test fails.

- [ ] **Upstream Engagement: StartOS Custom External Port Mapping RFC**
  - Submit an issue / feature proposal to `Start9Labs/startos` requesting support for custom external port mappings or test port parameters on Gateways so non-symmetric NAT port forwarding services pass the built-in reachability check.

---

## Superseded: StartOS Gateway Model

The upstream reset (Sep 18) replaced the host-managed StartOS gateway model with the node-owned `clearnet-vpn` model: the Lightning node runs the tunnel itself (`wg0`, policy routing table 51820) and nothing is configured box-wide. The following completed items no longer apply and their code and guidance were removed:

- ~~Gateway classification markers injected into every WireGuard config~~. New configs carry none; configs stored with markers by earlier versions are kept byte-identical, because the node task accepts the stored string exactly.
- ~~3-step gateway setup guidance~~ (adding a system gateway, a custom external host, and the interface firewall toggle).
- ~~Routing node egress through a host gateway~~ and the matching `verify.sh` remediation hints.
- ~~Host-interface audit in `verify.sh`~~ (host gateway list, host port bindings).
- ~~"Later" workaround for the StartOS Address Requirements port test and the multi-node port 9735 notes~~. Inbound traffic now arrives on the node's own `wg0`, with no host port forward.
- ~~External host announcement tasks~~ (`lnd:custom-external-host-config`, `c-lightning:config`). Their keys are still cleared on upgrade.
