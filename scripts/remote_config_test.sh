#!/usr/bin/env bash
# remote_config_test.sh - Push a WireGuard config to a live StartOS node and verify logs.
#
# Usage:
#   HOST=https://my-node.local SDK_CLI=/path/to/start-cli ./scripts/remote_config_test.sh
#
# Environment variables (can also be set in .env.local):
#   HOST          - StartOS host URL (default: https://public-fallacy.local)
#   SDK_CLI       - Path to start-cli binary (default: uses start-cli from PATH)
#   MASTER_PWD    - StartOS master password (read from .env.local if not set)
set -e

# Load master password from git-ignored .env.local if MASTER_PWD not set
if [ -z "$MASTER_PWD" ]; then
    ENV_FILE=".env.local"
    if [ ! -f "$ENV_FILE" ]; then
        echo "Error: \$MASTER_PWD not set and $ENV_FILE not found."
        exit 1
    fi
    # Extract safely ignoring stray trailing quotes
    MASTER_PWD=$(grep '^startOS-Master-pwd=' "$ENV_FILE" | cut -d '=' -f 2- | tr -d '"' | tr -d "'" | tr -d '\r\n')
fi

# Resolve defaults from environment or fallback
HOST="${HOST:-https://start9.local}"
SDK_CLI="${SDK_CLI:-$(command -v start-cli 2>/dev/null || true)}"
if [ -z "$SDK_CLI" ] && [ -x "$HOME/.cargo/bin/start-cli" ]; then
    SDK_CLI="$HOME/.cargo/bin/start-cli"
fi

if [ -z "$SDK_CLI" ]; then
    echo "Error: start-cli not found in PATH or \$HOME/.cargo/bin/start-cli"
    exit 1
fi

if [ -z "$MASTER_PWD" ]; then
    echo "Error: password not found in \$MASTER_PWD or .env.local"
    exit 1
fi

echo "Phase 1: Authenticating to $HOST..."
"$SDK_CLI" -h "$HOST" auth login "$MASTER_PWD"

echo "Phase 2: Preparing and Pushing Configuration..."
CONF_CONTENT=$(cat tunnelsats-test.conf)
JSON_CONF=$(jq -n --arg conf "$CONF_CONTENT" '{"target-node": "lnd", "tunnelsats-conf": $conf}')

echo "Pushing tunnelsats configuration..."
echo "$JSON_CONF" | "$SDK_CLI" -h "$HOST" package config tunnelsats set

echo "Phase 3: Verifying Remote Logs..."
sleep 5
echo "Fetching tunnelsats logs..."
"$SDK_CLI" -h "$HOST" package logs tunnelsats --limit 50
