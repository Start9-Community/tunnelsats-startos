#!/usr/bin/env bats
# Tests for verify.sh. It runs only checks it can really execute from the
# TunnelSats container; the tunnel lives on the Lightning node, so node-side
# checks are printed as manual steps and never reported as verified.

setup() {
    export REPO_ROOT="$BATS_TEST_DIRNAME/.."
    FAKE="$(mktemp -d)"
    mkdir -p "$FAKE/app" "$FAKE/data"
    # Point the script at an app dir without bridge.py, an empty data dir
    # and a loopback port nothing listens on: every check must fail closed.
    export TUNNELSATS_APP_DIR="$FAKE/app"
    export DATA_DIR="$FAKE/data"
    export TUNNELSATS_WEB_URL="http://127.0.0.1:9"
}

teardown() {
    if [ -n "${WEB_PID:-}" ]; then kill "$WEB_PID" 2>/dev/null || true; fi
    rm -rf "$FAKE"
}

# Stand-in for the container's bridge.py CLI: `health subscription` prints
# $1 and exits with $2.
fake_bridge() {
    cat > "$FAKE/app/bridge.py" <<EOF
import sys
if sys.argv[1:3] == ["health", "subscription"]:
    print('$1')
    sys.exit($2)
sys.exit(2)
EOF
}

# Stored configuration as the Configure/Import actions write it.
fake_config() {
    printf '[Interface]\nPrivateKey = x\n# VPNPort: 24556\n' > "$DATA_DIR/tunnelsatsv3.conf"
    printf '{"enabled": %s, "target-node": "%s"}' "$1" "$2" > "$DATA_DIR/config.json"
}

# Serves $1 as /api/status on a free loopback port.
serve_status() {
    mkdir -p "$FAKE/web/api"
    printf '%s' "$1" > "$FAKE/web/api/status"
    local port
    port=$(python3 -c 'import socket; s = socket.socket(); s.bind(("127.0.0.1", 0)); print(s.getsockname()[1]); s.close()')
    python3 -m http.server "$port" --bind 127.0.0.1 --directory "$FAKE/web" >/dev/null 2>&1 &
    WEB_PID=$!
    export TUNNELSATS_WEB_URL="http://127.0.0.1:$port"
    for _ in $(seq 50); do
        python3 -c 'import sys, urllib.request; urllib.request.urlopen(sys.argv[1] + "/api/status", timeout=1)' "$TUNNELSATS_WEB_URL" 2>/dev/null && return 0
        sleep 0.1
    done
    return 1
}

# Fails when $2 (default: $output) matches the extended regex $1. A bare
# `! grep` would not fail a bats test: `set -e` ignores negated commands.
refute_match() {
    if grep -iE "$1" <<< "${2-$output}"; then
        echo "unexpected match for: $1"
        return 1
    fi
}

STATUS_OK='{"configured": true, "server": "de2.tunnelsats.com", "vpn_port": 24556, "allow_ipv6": false}'

healthy_service() {
    fake_bridge '{"result": "ok", "message": "Active until 2026-12-31"}' 0
    fake_config true "$1"
    serve_status "$STATUS_OK"
}

@test "verify.sh is executable and runs the diagnostic sections" {
    [ -x "$REPO_ROOT/verify.sh" ]
    run "$REPO_ROOT/verify.sh"
    [[ "$output" =~ "1. Environment" ]]
    [[ "$output" =~ "2. TunnelSats configuration" ]]
    [[ "$output" =~ "3. Subscription health" ]]
    [[ "$output" =~ "4. Web dashboard API" ]]
    [[ "$output" =~ "5. Node-side tunnel checks (MANUAL" ]]
    [[ "$output" =~ "Verification Summary" ]]
}

@test "verify.sh fails closed outside the TunnelSats container" {
    run "$REPO_ROOT/verify.sh"
    [ "$status" -eq 1 ]
    [[ "$output" =~ "bridge.py not found" ]]
    [[ "$output" =~ "No stored WireGuard configuration" ]]
    [[ "$output" =~ "Web dashboard API unreachable" ]]
    [[ "$output" =~ "check(s) failed" ]]
}

@test "verify.sh passes when every TunnelSats-side check really passes" {
    healthy_service lnd
    run "$REPO_ROOT/verify.sh"
    [ "$status" -eq 0 ]
    [[ "$output" =~ "Active until 2026-12-31" ]]
    [[ "$output" =~ "server: de2.tunnelsats.com, forwarded port: 24556" ]]
    [[ "$output" =~ "TunnelSats service checks passed" ]]
}

@test "verify.sh never reports the tunnel, routing or egress as verified" {
    healthy_service lnd
    run "$REPO_ROOT/verify.sh"
    [[ "$output" =~ "NOT verified by this script" ]]
    refute_match '\[ OK \].*(\btunnel\b|egress|routing|wg0|handshake)'
}

@test "verify.sh prints the node-side commands as manual steps for the target node" {
    healthy_service eclair
    run "$REPO_ROOT/verify.sh"
    [[ "$output" =~ "not executed" ]]
    [[ "$output" =~ "start-cli package attach eclair" ]]
    [[ "$output" =~ "wg show wg0" ]]
    [[ "$output" =~ "ip rule" ]]
    [[ "$output" =~ "ip route show table 51820" ]]
    [[ "$output" =~ "curl -4 -s https://ifconfig.me" ]]
}

@test "verify.sh maps the cln target to the c-lightning package" {
    healthy_service cln
    run "$REPO_ROOT/verify.sh"
    [[ "$output" =~ "start-cli package attach c-lightning" ]]
}

@test "verify.sh never lets a failed IPv6 probe pass as isolation" {
    # A DNS failure or an unreachable probe service also makes curl fail;
    # only a refused connect (or the kernel's blackhole route) shows that
    # IPv6 cannot leave outside the tunnel.
    healthy_service lnd
    run "$REPO_ROOT/verify.sh"
    [[ "$output" =~ "ip -6 route show table 51820" ]]
    [[ "$output" =~ "blackhole default" ]]
    [[ "$output" =~ "curl -6 -sS --max-time 5 https://ifconfig.me" ]]
    [[ "$output" =~ "Could not resolve host" ]]
    [[ "$output" =~ "any other error: NOT verified" ]]
    refute_match 'curl -6 -s --max-time|must fail'
}

# Config as the handoff reads it: config.json's tunnelsats-conf, whose
# `# Server:` comment differs from the Endpoint host.
fake_config_with_endpoint() {
    local conf
    conf=$'[Interface]\nPrivateKey = x\n# VPNPort: 24556\n# Server: de2.tunnelsats.com\n\n[Peer]\nEndpoint = 198.51.100.1:51820\n'
    printf '%s' "$conf" > "$DATA_DIR/tunnelsatsv3.conf"
    python3 -c 'import json, sys; print(json.dumps({"enabled": True, "target-node": "lnd", "tunnelsats-conf": sys.argv[1]}))' "$conf" > "$DATA_DIR/config.json"
}

@test "verify.sh names the Endpoint host, not the # Server: name, as the public address" {
    # The node task announces the Endpoint host with the forwarded port;
    # /api/status.server prefers the `# Server:` comment.
    fake_bridge '{"result": "ok", "message": "Active until 2026-12-31"}' 0
    fake_config_with_endpoint
    serve_status "$STATUS_OK"
    run "$REPO_ROOT/verify.sh"
    [ "$status" -eq 0 ]
    [[ "$output" =~ "host of your WireGuard Endpoint (198.51.100.1:51820) with the forwarded port 24556" ]]
    [[ "$output" =~ "'Public Address' field of the lnd Clearnet VPN action" ]]
    refute_match 'de2\.tunnelsats\.com:24556|should announce de2'
}

@test "verify.sh points to the node's Public Address when the Endpoint is unknown" {
    healthy_service lnd
    run "$REPO_ROOT/verify.sh"
    [[ "$output" =~ "'Public Address' field of the lnd Clearnet VPN action" ]]
    refute_match 'should announce de2'
}

@test "verify.sh reads the health result from stdout despite log noise" {
    cat > "$FAKE/app/bridge.py" <<'EOF'
import sys
print("sync: retrying", file=sys.stderr)
print("Synchronizing subscription for key abc")
print('{"result": "ok", "message": "Active until 2026-12-31"}')
EOF
    fake_config true lnd
    serve_status "$STATUS_OK"
    run "$REPO_ROOT/verify.sh"
    [ "$status" -eq 0 ]
    [[ "$output" =~ "Subscription confirmed by the TunnelSats API: Active until 2026-12-31" ]]
}

@test "verify.sh does not report an unconfigured subscription as confirmed" {
    # bridge.py answers "ok" with an "Unconfigured" message when no config
    # is stored; that confirms nothing.
    fake_bridge '{"result": "ok", "message": "Unconfigured: Add WireGuard configuration in settings"}' 0
    printf '{"enabled": true, "target-node": "lnd"}' > "$DATA_DIR/config.json"
    serve_status "$STATUS_OK"
    run "$REPO_ROOT/verify.sh"
    [ "$status" -eq 1 ]
    [[ "$output" =~ "Subscription not checked: no stored WireGuard configuration" ]]
    refute_match 'Subscription confirmed'
}

@test "verify.sh reports a failing subscription health check" {
    fake_bridge '{"result": "failure", "message": "Subscription expired on 2026-01-01"}' 1
    fake_config true lnd
    serve_status "$STATUS_OK"
    run "$REPO_ROOT/verify.sh"
    [ "$status" -eq 1 ]
    [[ "$output" =~ "Subscription expired on 2026-01-01" ]]
}

@test "verify.sh treats an unconfirmed subscription as unverified" {
    fake_bridge '{"result": "loading", "message": "Synchronizing subscription status with TunnelSats..."}' 0
    fake_config true lnd
    serve_status "$STATUS_OK"
    run "$REPO_ROOT/verify.sh"
    [ "$status" -eq 1 ]
    [[ "$output" =~ "not confirmed" ]]
}

@test "verify.sh fails when TunnelSats is switched off" {
    fake_bridge '{"result": "disabled", "message": "TunnelSats is disabled."}' 0
    fake_config false lnd
    serve_status "$STATUS_OK"
    run "$REPO_ROOT/verify.sh"
    [ "$status" -eq 1 ]
    [[ "$output" =~ "TunnelSats is switched off" ]]
}

@test "verify.sh explains legacy settings without an enabled flag" {
    fake_bridge '{"result": "ok", "message": "Active until 2026-12-31"}' 0
    printf '[Interface]\nPrivateKey = x\n# VPNPort: 24556\n' > "$DATA_DIR/tunnelsatsv3.conf"
    printf '{"target-node": "lnd"}' > "$DATA_DIR/config.json"
    serve_status "$STATUS_OK"
    run "$REPO_ROOT/verify.sh"
    [ "$status" -eq 1 ]
    [[ "$output" =~ "no 'enabled' flag" ]]
    [[ "$output" =~ "StartOS treats this as switched off" ]]
}

@test "verify.sh carries no guidance from the retired StartOS gateway model" {
    healthy_service lnd
    run "$REPO_ROOT/verify.sh"
    refute_match 'Outbound Gateway|Peer Interface|net gateway|Gateway Mode|System → Gateways'
    refute_match 'Outbound Gateway|Peer Interface|net gateway|gateway_mode|System → Gateways' "$(cat "$REPO_ROOT/verify.sh")"
}
