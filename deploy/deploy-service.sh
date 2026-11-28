#!/usr/bin/env bash
# Upload the rollup code to the SkyProof VM and restart the service.
# The VM keeps its own state (rollup/flights/local) and rollup/.env: neither is touched.
# Usage: bash deploy/deploy-service.sh   (needs ~/.ssh/skyproof_vm)
set -euo pipefail
cd "$(dirname "$0")/.."
HOST=skyproof@skyproof-qorex.malaysiawest.cloudapp.azure.com
SSH=(-i ~/.ssh/skyproof_vm -o StrictHostKeyChecking=accept-new)
tar -czf /tmp/skyproof-rollup.tgz rollup/src rollup/package.json rollup/package-lock.json rollup/tsconfig.json
scp "${SSH[@]}" -q /tmp/skyproof-rollup.tgz deploy/skyproof.service "$HOST":/tmp/
ssh "${SSH[@]}" "$HOST" 'set -e; cd ~/skyproof && tar -xzf /tmp/skyproof-rollup.tgz && rm /tmp/skyproof-rollup.tgz
  cd rollup && npm ci --no-audit --no-fund --silent
  sudo cp /tmp/skyproof.service /etc/systemd/system/ && sudo systemctl daemon-reload && sudo systemctl restart skyproof
  systemctl is-active skyproof'
rm -f /tmp/skyproof-rollup.tgz
echo "service restarted"
