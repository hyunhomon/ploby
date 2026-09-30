# Raspberry Pi deployment

Public URL: https://ploby.qucord.com

The `rpi` SSH host runs the repository from `/srv/ploby`. Caddy serves the production Vite build and proxies `/api` to the Python API. Cloudflare Tunnel provides public HTTPS using the host's existing tunnel; the Ploby ingress targets `http://127.0.0.1:18771`. Both Caddy and the API bind only to loopback.

| Component | Location |
| --- | --- |
| Git checkout | `/srv/ploby` |
| Frontend | `/srv/ploby/frontend/dist` |
| Backend service | `ploby.service`, dedicated `ploby` system user |
| API listener | `127.0.0.1:3010` |
| Persistent projects and originals | `/var/lib/ploby/data` |
| Kiln cache and usage | `/srv/ploby/harness/runs` |
| Runtime secrets | `/etc/ploby/ploby.env`, root-owned mode 0600 |
| Caddy fragment | `/etc/caddy/conf.d/ploby.caddy` |
| Tunnel routes | `/etc/cloudflared/config.yml` |
| ARM64 Cast | `/var/lib/ploby/.foundry/bin/cast` |

The versioned service and Caddy templates are in [`deploy/`](../deploy/). Secrets are passed by systemd and are never copied into the web root or Git. The service restarts after failure and starts at boot. Data persists independently of the checkout. Back up both data and the usage/cache directory before maintenance.

This is the same Monad testnet demo described in the README, with real Kiln calls, server-held testnet keys, demo role switching and optional engine-verified wallet approvals. It is not a production custody service. The fresh deployment uses the real clock, without the filmed demo's three-day offset. Existing Kiln safeguards remain enabled: 20 requests/minute, two concurrent calls, $0.50 process cap, $5 local recorded-call cap and $80 shared-key stop threshold.

## Update and inspect

```sh
ssh rpi
cd /srv/ploby
git pull --ff-only origin main
.venv/bin/pip install -r requirements.txt
cd frontend
npm ci --no-audit --no-fund
npm run build
sudo systemctl restart ploby
sudo systemctl status ploby --no-pager
sudo journalctl -u ploby -n 50 --no-pager
curl --fail https://ploby.qucord.com/api/meta
```

Copy updated `deploy/ploby.service` or `deploy/ploby.caddy` only when those templates change. Validate Caddy before reloading it. Never print the environment file in logs. Do not run a second service against the same data directory.

For a release rollback, restore the previously deployed Git commit, rebuild the frontend and restart the API; preserve `/var/lib/ploby/data`. Changes to log or storage formats require a separately reviewed migration.

ARM64 Foundry v1.8.3 was installed from the [official release](https://github.com/foundry-rs/foundry/releases/tag/v1.8.3); the release archive SHA-256 was checked against GitHub's release asset digest.
