#!/usr/bin/env bash
# Rebuild the website and upload it to the SkyProof VM (nginx + HTTPS already set up).
# Order matters: new hashed assets first, index.html last, old assets removed only after,
# so a dropped connection never leaves the live site pointing at missing files.
# skyproof.json and skyproof-bodies.json are not uploaded: the SkyProof service on the VM
# (deploy/skyproof.service) re-exports them from the chain every minute.
# Usage: bash deploy/deploy-vm.sh   (needs ~/.ssh/skyproof_vm)
set -euo pipefail
cd "$(dirname "$0")/.."
HOST=skyproof@skyproof-qorex.malaysiawest.cloudapp.azure.com
SSH=(-i ~/.ssh/skyproof_vm -o StrictHostKeyChecking=accept-new -o ConnectTimeout=20)
(cd web && npx vite build)
rm -f web/dist/skyproof.json web/dist/skyproof-bodies.json
scp "${SSH[@]}" -q -r web/dist/assets "$HOST":/var/www/skyproof/
for f in web/dist/*; do [ "$(basename "$f")" = index.html ] || [ -d "$f" ] || scp "${SSH[@]}" -q "$f" "$HOST":/var/www/skyproof/; done
scp "${SSH[@]}" -q web/dist/index.html "$HOST":/var/www/skyproof/index.html.new
ssh "${SSH[@]}" "$HOST" 'cd /var/www/skyproof && mv index.html.new index.html && for a in assets/*; do grep -q "$(basename "$a")" index.html assets/*.js assets/*.css 2>/dev/null || rm -f "$a"; done'
echo "deployed: https://skyproof-qorex.malaysiawest.cloudapp.azure.com"
