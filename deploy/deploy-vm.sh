#!/usr/bin/env bash
# Rebuild the website and upload it to the SkyProof VM (nginx + HTTPS already set up).
# Usage: bash deploy/deploy-vm.sh   (needs ~/.ssh/skyproof_vm)
set -euo pipefail
cd "$(dirname "$0")/.."
HOST=skyproof@skyproof-qorex.malaysiawest.cloudapp.azure.com
(cd web && npx vite build)
ssh -i ~/.ssh/skyproof_vm "$HOST" "rm -rf /var/www/skyproof/assets"
scp -i ~/.ssh/skyproof_vm -q -r web/dist/* "$HOST":/var/www/skyproof/
echo "deployed: https://skyproof-qorex.malaysiawest.cloudapp.azure.com"
