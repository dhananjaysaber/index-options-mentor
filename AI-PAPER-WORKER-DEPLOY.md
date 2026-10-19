# Mentor AI — server-side autonomous paper research

## What is implemented

This isolated branch contains an autonomous **paper-only** trading worker that does NOT submit any real FYERS orders.

- Node.js 24 long-running worker with quote-based stop/exit checks every 5 seconds **during regular weekday market hours**.
- One Claude market assessment every 60 seconds while the owner has enabled automation.
- Claude proposes WAIT/ENTER and HOLD/TRAIL/EXIT for every tracked simulated position.
- Deterministic risk gate prevents trades without valid CE/PE contract and protective stops; paper risk per lot, 5x portfolio risk budget, 25-position cap, duplicate-setup guard and 3% daily drawdown entry lock.
- End-of-session simulated exits when an observed quote is available after 15:25 IST.
- SQLite WAL tables for restart-safe open/closed positions, Claude decisions, settings and encrypted FYERS access token.
- Separate FYERS non-trading app OAuth flow and protected AI login.
- Standalone API supports journal and automated engine controls from the public PWA.

**Deployment is NOT active simply because the code is committed.** A Node 24 server, HTTPS domain and persistent volume are required. Do not turn on automatic Claude polling or paid hosting until you choose the server.

### Where the source lives

- `server/aiPaperService.mjs` — HTTPS-reverse-proxy-target API (listens on localhost port 8787)
- `server/aiPaperWorker.mjs` — long-running autonomous strategy worker
- `server/aiPaperStore.mjs` — SQLite persistence and encrypted FYERS token
- `server/aiPaperWorker.test.mjs` — paper safety and persistence tests
- `src/ai-paper/engine.js` — deterministic paper entry and stop simulation
- `server/aiSessionAuth.mjs` — seven-day signed research sessions

### Host checklist (AWS Lightsail VPS, or another always-on Node host)

1. Provision an Ubuntu machine with Node **24**, a persistent disk, a firewall and a HTTPS reverse proxy such as Caddy/Nginx. Port 8787 must stay private; expose only HTTPS port 443 externally. **GitHub Pages cannot run this worker.**
2. Clone the **private** repository and check out branch `mentor-ai-paper-lab`. Use `npm install`, then `npm run test:ai-paper` before starting it.
3. Configure private environment variables on the host (not in GitHub Pages and not in a Vite-prefixed variable):

```dotenv
TRADING_MODE=paper
LIVE_ORDER_EXECUTION_ENABLED=false
AI_WORKER_ENABLED=true
AI_PAPER_DB_PATH=/var/lib/mentor-ai/paper.sqlite
AI_PAPER_HOST=127.0.0.1
AI_PAPER_PORT=8787
ANTHROPIC_API_KEY=<copy-secret-to-host-privately>
MENTOR_AI_ACCESS_KEY=<copy-private-AI-access-password>
FYERS_APP_ID=<AI-non-trading-FYERS-app-id>
FYERS_APP_SECRET=<AI-non-trading-FYERS-app-secret>
FYERS_SESSION_SECRET=<strong-random-secret-at-least-24-characters>
FYERS_REDIRECT_URI=https://<your-worker-hostname>/api/fyers/callback
CLAUDE_MODEL=claude-sonnet-5-5
```

Use a systemd EnvironmentFile or equivalent protected secret store, readable only by the service account. Restrict SQLite file/directory to the same user; backup its volume. **Never commit the `.env` file or its contents.**

4. Register the exact new HTTPS redirect URL in the **separate Mentor AI Paper Lab FYERS non-trading application**, not the original Index Options Mentor application.
5. Run the worker under systemd/supervisor so it automatically restarts if it crashes. Command: `npm run start:ai-paper`. Reverse proxy HTTPS to `127.0.0.1:8787`.
6. The worker startup defaults to **paused for new entries** until you explicitly enable it from the PWA Control Centre. Existing protective paper stops continue checking while the process is running and FYERS supplies quotes.
7. Once HTTPS worker is operational, update ONLY the separate **public AI PWA** Actions workflow environment variables:

```yaml
VITE_AI_API_BASE: https://<your-worker-hostname>
VITE_AI_BACKEND_MODE: standalone
```

The GitHub Pages PWA already supports this optional mode; publishing the updated workflow will switch the same public viewing URL over to the worker.

8. Sign into Claude AI in the PWA. Connect FYERS again using the separate non-trading app; the worker will encrypt/store the broker market-data token. Test market-data status and open-position simulation with paper balances only.
9. In Control Centre, press **Enable server research**. Verify decisions and persisted positions in the Independent Learning Journal. Close/reopen the PWA to confirm the server continues and positions remain. Pause new entries when needed.

### Important restrictions and operational notes

- **No dedicated FYERS static IP is required just to read market data for this paper-only application.** Live order automation is not implemented.
- FYERS API sessions can expire and may require **regular reauthentication**, potentially daily. If tokens expire, the worker does not invent quotes and cannot manage simulated exits until it reconnects.
- Automatic quote checks are at ~5s intervals subject to broker rate limits, network availability and actual API latency. A missed quote can mean a worse paper exit than a stop level.
- Cloud storage is NOT Netlify Blobs or Supabase; SQLite persists on the host disk. If the host's disk is ephemeral, data will be lost. Set backups.
- The standalone service currently supports a single-owner research session and one FYERS non-trading app.
- Risk caps, a 15:15 last-entry cutoff, 15:25 end-of-session simulated exits and maximum simultaneous positions are **protective operational boundaries**, not arbitrary trading entry triggers.
- Claude can be wrong; P&L is a quote-based simulation without realistic bid-ask fills, brokerage, spread and slippage.
- A news/economic calendar feed has **not** been integrated: Claude is explicitly instructed not to fabricate events.
- Do not compare this research version to profitable live strategies until realistic cost modeling, data outage alerts, data quality checks and several weeks of forward testing have been completed.
- Reusing the GitHub Pages frontend alone does NOT save backend hosting/API costs. Your current Netlify backend remains the live gateway until the new server is configured and the PWA build is switched.
