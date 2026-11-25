# Host the website on your own VM (nginx)

The website is static files plus a small proxy to QoreChain testnet. It runs next to any other site on the same nginx, on its **own subdomain**, because the page loads `/skyproof.json` and `/api/...` from the root.

## 1. DNS
Add an `A` record, for example `skyproof.yourdomain.com`, pointing at the VM's public IP. In Azure, also allow inbound ports 80 and 443 in the VM's network security group, if your other site doesn't already.

## 2. Build (on your computer)
```
cd web
npm ci
npx vite build          # writes web/dist
```

## 3. Copy to the VM
```
scp -r web/dist/* <user>@<vm-ip>:/tmp/skyproof/
ssh <user>@<vm-ip> "sudo mkdir -p /var/www/skyproof && sudo cp -r /tmp/skyproof/* /var/www/skyproof/"
```

## 4. nginx
```
scp deploy/nginx-skyproof.conf <user>@<vm-ip>:/tmp/
ssh <user>@<vm-ip>
sudo cp /tmp/nginx-skyproof.conf /etc/nginx/sites-available/skyproof
sudo nano /etc/nginx/sites-available/skyproof     # set server_name to your subdomain
sudo ln -s /etc/nginx/sites-available/skyproof /etc/nginx/sites-enabled/
sudo nginx -t && sudo systemctl reload nginx
sudo certbot --nginx -d skyproof.yourdomain.com  # HTTPS
```
HTTPS is required: the claim wallet uses the browser's Web Crypto, which works only on secure pages.

## 5. Check
Open `https://skyproof.yourdomain.com`. The top-right badge should say **Live · block …**. If it says *Offline · saved data*, the `/api/rest` proxy isn't reaching QoreChain; check `sudo tail /var/log/nginx/error.log`.

## Updating the data
After new batches or claims: `npm run export-web` in `rollup/`, rebuild, and copy `web/dist` again (or only `web/dist/skyproof.json`).
