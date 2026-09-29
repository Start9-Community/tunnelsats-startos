#!/usr/bin/env bash
# ==============================================================================
# TunnelSats StartOS Service Diagnostic Tool
# ==============================================================================
# Checks what can really be checked from the TunnelSats container: the stored
# configuration, the subscription health check and the web dashboard API.
#
# The WireGuard tunnel itself runs on the Lightning node (its clearnet-vpn
# action), not in this container. This script therefore cannot see wg0, the
# node's policy routing or its egress. It prints the node-side commands as
# MANUAL steps and never reports the tunnel, routing or egress as verified.
#
# Usage (inside the TunnelSats container):  /app/verify.sh
#
# Overrides (for tests): TUNNELSATS_APP_DIR (default /app), DATA_DIR (default
# /data, same variable as bridge.py), TUNNELSATS_WEB_URL (default
# http://127.0.0.1).
# ==============================================================================

set -uo pipefail

APP_DIR="${TUNNELSATS_APP_DIR:-/app}"
DATA_DIR="${DATA_DIR:-/data}"
WEB_URL="${TUNNELSATS_WEB_URL:-http://127.0.0.1}"
BRIDGE="$APP_DIR/bridge.py"
CONF_PATH="$DATA_DIR/tunnelsatsv3.conf"
APP_CONFIG_PATH="$DATA_DIR/config.json"

RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
BLUE='\033[0;34m'
NC='\033[0m'

FAILED_CHECKS=0

log_ok() { echo -e "${GREEN}[ OK ]${NC} $1"; }
log_info() { echo -e "${BLUE}[INFO]${NC} $1"; }
log_warn() { echo -e "${YELLOW}[WARN]${NC} $1"; }
log_fail() {
    echo -e "${RED}[FAIL]${NC} $1"
    FAILED_CHECKS=$((FAILED_CHECKS + 1))
}
log_step() { echo -e "\n${BLUE}==> $1${NC}"; }

# Prints field $2 of the JSON object in $1 (or in its last line), or nothing
# if absent/unparseable.
json_field() {
    printf '%s' "$1" | python3 -c '
import json, sys
text = sys.stdin.read().strip()
try:
    try:
        data = json.loads(text)
    except ValueError:
        data = json.loads(text.splitlines()[-1])
    value = data.get(sys.argv[1])
except Exception:
    sys.exit(0)
if value is not None:
    print(value)
' "$2" 2>/dev/null
}

# 1. Environment
log_step "1. Environment"
if [ -f "$BRIDGE" ]; then
    log_ok "Running inside the TunnelSats container ($BRIDGE)."
else
    log_fail "bridge.py not found at $BRIDGE. Run this script inside the TunnelSats container; the checks below cannot pass elsewhere."
fi

# 2. TunnelSats configuration
log_step "2. TunnelSats configuration"
TARGET_NODE="lnd"
ENABLED=""
APP_CONFIG=""
if [ -f "$CONF_PATH" ]; then
    log_ok "Stored WireGuard configuration found."
else
    log_fail "No stored WireGuard configuration ($CONF_PATH). Run Buy Subscription or Import Subscription."
fi
if [ -f "$APP_CONFIG_PATH" ]; then
    APP_CONFIG=$(cat "$APP_CONFIG_PATH" 2>/dev/null || true)
    ENABLED=$(json_field "$APP_CONFIG" "enabled")
    STORED_TARGET=$(json_field "$APP_CONFIG" "target-node")
    case "$STORED_TARGET" in
        lnd | cln | eclair) TARGET_NODE="$STORED_TARGET" ;;
    esac
    # Mirrors the package's config.json model (enabled: z.boolean().catch(false)),
    # which drives the node task and the health check. bridge.py's legacy
    # "enabled when a config file exists" default does not route anything.
    if [ "$ENABLED" == "True" ]; then
        log_ok "TunnelSats is enabled for target node: $TARGET_NODE."
    elif [ -z "$ENABLED" ]; then
        log_fail "TunnelSats settings have no 'enabled' flag (settings from an older version). StartOS treats this as switched off, so no node is asked to run the tunnel. Run Configure → Enable TunnelSats."
    else
        log_fail "TunnelSats is switched off (Configure → Enable TunnelSats)."
    fi
else
    log_fail "No TunnelSats settings ($APP_CONFIG_PATH)."
fi

case "$TARGET_NODE" in
    cln) TARGET_PKG="c-lightning" ;;
    eclair) TARGET_PKG="eclair" ;;
    *) TARGET_PKG="lnd" ;;
esac

# 3. Subscription health (the same check StartOS runs)
log_step "3. Subscription health"
if [ -f "$BRIDGE" ]; then
    # stdout carries the JSON result; bridge.py logs to stderr.
    HEALTH_OUT=$(python3 "$BRIDGE" health subscription 2>/dev/null)
    HEALTH_EXIT=$?
    HEALTH_RESULT=$(json_field "$HEALTH_OUT" "result")
    HEALTH_MSG=$(json_field "$HEALTH_OUT" "message")
    if [ "$HEALTH_RESULT" == "ok" ] && [ ! -f "$CONF_PATH" ]; then
        # bridge.py answers "ok" ("Unconfigured") when no config is stored.
        log_fail "Subscription not checked: no stored WireGuard configuration (${HEALTH_MSG})."
    elif [ "$HEALTH_EXIT" -eq 0 ] && [ "$HEALTH_RESULT" == "ok" ]; then
        log_ok "Subscription confirmed by the TunnelSats API: ${HEALTH_MSG}"
    elif [ "$HEALTH_RESULT" == "loading" ]; then
        log_fail "Subscription not confirmed yet: ${HEALTH_MSG}"
    elif [ "$HEALTH_RESULT" == "disabled" ]; then
        log_fail "Subscription health skipped: ${HEALTH_MSG}"
    elif [ -n "$HEALTH_RESULT" ]; then
        log_fail "Subscription health check failed: ${HEALTH_MSG}"
    else
        log_fail "Subscription health check returned no result (exit ${HEALTH_EXIT})."
    fi
else
    log_fail "Subscription health check cannot run without bridge.py."
fi

# 4. Web dashboard API
log_step "4. Web dashboard API"
SERVER=""
VPN_PORT=""
ALLOW_IPV6=""
API_DATA=$(python3 -c '
import sys, urllib.request
req = urllib.request.Request(sys.argv[1] + "/api/status", headers={"Host": "localhost"})
with urllib.request.urlopen(req, timeout=5) as r:
    print(r.read().decode("utf-8"))
' "$WEB_URL" 2>/dev/null || true)
if [ -n "$(json_field "$API_DATA" "configured")" ]; then
    log_ok "Web dashboard API reachable ($WEB_URL/api/status)."
    SERVER=$(json_field "$API_DATA" "server")
    VPN_PORT=$(json_field "$API_DATA" "vpn_port")
    ALLOW_IPV6=$(json_field "$API_DATA" "allow_ipv6")
    if [ "$(json_field "$API_DATA" "configured")" == "True" ] && [ -n "$SERVER" ] &&
        [ "$SERVER" != "Unknown" ] && [ -n "$VPN_PORT" ]; then
        log_ok "Configured TunnelSats server: ${SERVER}, forwarded port: ${VPN_PORT}"
    else
        log_fail "The service reports no usable server/forwarded port."
    fi
else
    log_fail "Web dashboard API unreachable or invalid at $WEB_URL/api/status."
fi

# 5. Node-side checks: printed, never executed or claimed
log_step "5. Node-side tunnel checks (MANUAL, not executed by this script)"
log_info "The tunnel runs on ${TARGET_PKG}. Open a shell in that container, e.g."
echo "    start-cli package attach ${TARGET_PKG}"
echo "  and run:"
echo "    wg show wg0                    # recent handshake, non-zero rx/tx"
echo "    ip rule                        # a rule with 'lookup 51820' (fwmark 0xca6c = 51820)"
echo "    ip route show table 51820      # 'default dev wg0'"
echo "    curl -4 -s https://ifconfig.me # must print the TunnelSats server IP, not your home IP"
if [ "$ALLOW_IPV6" == "True" ]; then
    echo "    (Allow Home IPv6 Coexistence is ON: IPv6 leaves via your home ISP by design.)"
else
    echo "    ip -6 route show table 51820   # 'blackhole default': IPv6 cannot leave outside the tunnel"
    echo "    curl -6 -sS --max-time 5 https://ifconfig.me; echo \" curl exit \$?\""
    echo "      # prints an IP address: IPv6 LEAKS past the tunnel."
    echo "      # 'Failed to connect' / 'Network is unreachable' (exit 7): no IPv6 egress."
    echo "      # 'Could not resolve host' (exit 6), a timeout (exit 28) or any other error: NOT verified, the probe itself did not run."
fi
# The node task announces the Endpoint host of the stored config with the
# forwarded port (getAnnounceEndpoint), not the `# Server:` comment that
# /api/status reports as the server.
ENDPOINT=$(json_field "$APP_CONFIG" "tunnelsats-conf" | python3 -c '
import re, sys
m = re.search(r"^\s*Endpoint\s*=\s*([^\s#]+)", sys.stdin.read(), re.IGNORECASE | re.MULTILINE)
if m:
    print(m.group(1))
' 2>/dev/null || true)
if [ -n "$ENDPOINT" ] && [ -n "$VPN_PORT" ]; then
    echo "  Public address: the node should announce the host of your WireGuard Endpoint (${ENDPOINT}) with the forwarded port ${VPN_PORT}."
    echo "  The exact value TunnelSats requested is the 'Public Address' field of the ${TARGET_PKG} Clearnet VPN action."
else
    echo "  Public address: compare what the node announces with the 'Public Address' field of the ${TARGET_PKG} Clearnet VPN action."
fi

# Summary
log_step "Verification Summary"
if [ "$FAILED_CHECKS" -gt 0 ]; then
    log_fail "Diagnostics finished: $FAILED_CHECKS check(s) failed."
    echo "Tunnel, routing and IPv4/IPv6 egress are NOT verified by this script."
    exit 1
fi
log_ok "TunnelSats service checks passed."
echo "Tunnel, routing and IPv4/IPv6 egress are NOT verified by this script; run the manual node-side checks above."
exit 0
