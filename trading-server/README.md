# Index Options Mentor — Dedicated Trading Server

This service is deliberately separate from the public GitHub Pages PWA.

## Phase 1 boundary

Implemented now:

- server-side FYERS OAuth/token storage
- AES-256-GCM encrypted token vault
- control API authentication
- CORS allowlist
- independent server-side risk preflight
- capital/risk/lot limits
- one-position-at-a-time protection
- daily loss protection
- emergency kill switch
- stale-data and broker-connection gates for non-simulation modes
- persistent idempotency records
- append-only SHA-256 chained audit log
- SIMULATION/PAPER recording path
- LIVE mode hard-rejected

Not implemented in phase 1:

- real broker order submission
- broker order modification/cancellation
- FYERS data WebSocket
- FYERS order-update WebSocket
- server-owned option quote cache
- PWA execution bridge

The existing Mentor and Scalp strategy engines are not changed by this service.

## Secret handling

Never put FYERS App ID, App Secret, access tokens, encryption keys, or the control key in the public PWA or in GitHub.

Configure them only in the server environment.

Generate private server values directly on the server, for example:

```bash
openssl rand -hex 32
openssl rand -base64 32
```

Use the hex value for `CONTROL_API_KEY` / `STATE_SIGNING_SECRET` and the base64 32-byte value for `TOKEN_ENCRYPTION_KEY`.

## Local start

```bash
cd trading-server
cp .env.example .env
npm install
npm start
```

The default bind address is `127.0.0.1`. In production, keep Node private behind an HTTPS reverse proxy such as Caddy or nginx.

## Production host requirements

Use a long-running VM/VPS with:

- a stable outbound IPv4 address suitable for FYERS allowlisting
- HTTPS
- persistent disk for the encrypted session and audit files
- automatic restart (systemd/Docker)
- firewall allowing only SSH and HTTPS externally
- outbound connectivity to FYERS
- regular encrypted backups of the audit/runtime data

Do not use the existing Netlify function as the final live-trading execution host.

## Execution modes

`EXECUTION_MODE=SIMULATION` is the default.

`PAPER` activates the stricter broker/data freshness gates but still does not submit a broker order.

`LIVE` is intentionally rejected in phase 1 even if the environment variable is changed.

## Data files

The service creates these files under `DATA_DIR`:

- `fyers-session.enc` — encrypted FYERS session
- `runtime-state.json` — kill switch, broker/market status, idempotency state
- `audit.jsonl` — append-only hash-chained audit events

Keep this directory outside any public web root and back it up securely.

## Next phase

After deployment to the static-IP host:

1. verify the server's actual outbound IPv4
2. configure/activate the FYERS API app using that IP and the server callback URL
3. complete daily FYERS authentication
4. add FYERS market-data WebSocket and server quote cache
5. add order-update WebSocket in observation mode
6. connect the PWA to the server with a short-lived user session rather than broker credentials
7. run PAPER tests and reconcile every event against the existing Trade Journal
