#!/usr/bin/env bash
# Start the desktop using the private KoinCode development profile.
set -euo pipefail
cd "$(dirname "${BASH_SOURCE[0]}")"

# shellcheck disable=SC1091
. scripts/macos-env.sh
setup_macos_env

case "${1:-}" in
  "" | testnet) NETWORK=testnet ;;
  mainnet) NETWORK=mainnet ;;
  *) fail "Usage: ./run.sh [testnet|mainnet]" ;;
esac
[ "$#" -le 1 ] || fail "Usage: ./run.sh [testnet|mainnet]"

[ -f node_modules/typescript/bin/tsc ] || fail "Dependencies are missing. Run ./build.sh first."

if lsof -nP -iTCP:5174 -sTCP:LISTEN >/dev/null 2>&1; then
  fail "Port 5174 is already in use. Stop the previously started desktop dev process first."
fi

exec "${PNPM[@]}" dev:desktop:test --network "$NETWORK"
