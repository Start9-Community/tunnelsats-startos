#!/bin/sh
set -e

# TunnelSats StartOS Entrypoint

# 1. Ensure the data directory exists
mkdir -p /data

# 2. Run the orchestrator in userspace
# bridge.py runs the Web Dashboard and background subscription/payment sync.

echo "Starting TunnelSats Bridge Orchestrator..."
exec python3 -u bridge.py start
