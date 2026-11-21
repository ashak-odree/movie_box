#!/usr/bin/env bash
set -euo pipefail

cd "$(dirname "$0")"

PORT="${PORT:-8080}"
PASSCODE="${PASSCODE:-mamamiakoi}"
AUTO_UPDATE_INTERVAL_SECS="${AUTO_UPDATE_INTERVAL_SECS:-1800}"

export PORT PASSCODE AUTO_UPDATE_INTERVAL_SECS

echo "[MovieBox-Web] Building release binary..."
cargo build --release

while true; do
  echo "[MovieBox-Web] Starting server on http://0.0.0.0:${PORT} ..."
  set +e
  ./target/release/moviebox-web
  EXIT_CODE=$?
  set -e

  if [ "$EXIT_CODE" -eq 42 ]; then
    echo "[MovieBox-Web] Auto-update applied! Restarting with new binary..."
    sleep 1
    continue
  fi

  echo "[MovieBox-Web] Exited with code ${EXIT_CODE}. Stopping."
  exit "$EXIT_CODE"
done

