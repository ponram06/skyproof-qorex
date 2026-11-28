#!/usr/bin/env bash
# Rebuild the website and upload it to the SkyProof VM (nginx + HTTPS already set up).
# skyproof.json is not uploaded: the SkyProof service on the VM (deploy/skyproof.service)
# re-exports it from the chain every minute.
# Usage: bash deploy/deploy-vm.sh   (needs ~/.ssh/skyproof_vm)
set -euo pipefail
cd "$(dirname "$0")/.."
HOST=skyproof@skyproof-qorex.malaysiawest.cloudapp.azure.com
SSH=(-i ~/.ssh/skyproof_vm -o StrictHostKeyChecking=accept-new)
(cd web && npx vite build)
rm -f web/dist/skyproof.json
ssh "${SSH[@]}" "$HOST" "rm -rf /var/www/skyproof/assets"
scp "${SSH[@]}" -q -r web/dist/* "$HOST":/var/www/skyproof/
echo "deployed: https://skyproof-qorex.malaysiawest.cloudapp.azure.com"
