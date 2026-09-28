# Secure Trading Server Architecture

Status: Phase 1 foundation. Real FYERS order placement is intentionally not implemented.

## Security boundary

```
GitHub Pages PWA
    |
    | HTTPS: trade intent / status / server-streamed market + order events
    v
Dedicated trading server
    |- application session
    |- FYERS OAuth + encrypted token vault
    |- FYERS market-data WebSocket
    |- FYERS order-update WebSocket
    |- independent risk engine
    |- execution-mode controller
    |- idempotency / duplicate protection
    |- audit event store
    |- Trade Journal bridge
    v
FYERS API v3
```

The browser must never receive FYERS App Secret or the FYERS access/refresh token. The current encrypted FYERS session blob in the PWA URL hash/localStorage is a migration target: the new server will replace it with a one-time application-session exchange. The browser may receive an opaque, short-lived Mentor session credential, but never a broker credential.

## Execution modes

- SIMULATION: existing browser research behaviour remains unchanged. No broker order call.
- PAPER: the trading server receives a TradeIntent, runs the same independent risk checks, then creates synthetic order/fill events from server-side FYERS market data. No broker order call.
- LIVE: reserved for a later phase. It requires an explicit server-side enable flag, a daily authenticated FYERS session, healthy market/order connections, risk approval and the emergency kill switch to be clear.

Phase 1 contains no live broker order adapter, so a real order cannot be submitted even if an environment variable is changed.

## FYERS 2026 requirements reflected in this design

For API trading after 1 April 2026 the server must originate order traffic from the static IP registered against the activated Algo Trading App. The runtime therefore needs a stable outbound IPv4 address. Authentication must support daily 2FA/re-login rather than assuming a long-running refresh-token session.

The production server will maintain two independent FYERS WebSockets:
1. Market-data socket for NIFTY and the active/candidate option contracts.
2. Order socket for order, trade and position updates.

REST order submission will use synchronous order acknowledgement first; all final state is reconciled against the order-update stream and order book.

## Independent risk gate

The strategy creates a TradeIntent. It cannot call the broker adapter directly. The only allowed path is:

```
TradeIntent -> schema validation -> risk engine -> idempotency -> execution service -> FYERS adapter
```

Entry checks include:
- server execution mode and LIVE enable state
- emergency kill switch
- daily FYERS authentication
- market-data connection health
- order-update connection health
- stale-tick age
- symbol/product allowlist
- capital/risk configuration
- maximum estimated risk per trade
- maximum lots/quantity
- one-position-at-a-time
- daily loss limit
- funds/margin check before LIVE placement
- duplicate intent/idempotency key
- rate limit protection

Every rejection returns a stable machine-readable reason code plus a human-readable explanation.

Risk-reducing exits are treated separately from new entries. A kill switch blocks new risk but must not prevent a valid emergency position exit.

## Audit and Trade Journal

The server audit stream is append-only and redacts token/secret/cookie/authorization fields before writing.

Planned event sequence:
- INTENT_RECEIVED
- RISK_ACCEPTED / RISK_REJECTED
- BROKER_REQUEST_CREATED
- BROKER_ACKNOWLEDGED / BROKER_REJECTED
- ORDER_UPDATE
- TRADE_FILL
- POSITION_UPDATE
- MODIFY_REQUESTED / CANCEL_REQUESTED
- EXIT_REQUESTED / POSITION_CLOSED
- CONNECTION_CHANGED
- EXECUTION_MODE_CHANGED
- KILL_SWITCH_CHANGED

These broker lifecycle events will be bridged into the existing Trade Journal alongside the existing research events so one trade can be reconstructed from Mentor decision through broker fill and exit.

## Hosting recommendation

Recommended first production host: one small always-on Linux VM in India with a static IPv4.

Suggested starting sizes:
- AWS Lightsail Mumbai: 2 GB plan for headroom.
- DigitalOcean Bangalore: 2 GB Basic Droplet with an assigned Reserved IP.

A 1 GB instance can run the service, but 2 GB gives safer headroom for Node.js, WebSockets, local audit storage, reverse proxy and monitoring. Managed/serverless platforms are less attractive here because FYERS order traffic now needs a stable whitelisted outbound IP and the server must keep long-lived WebSocket connections.

## Migration plan

### Phase 1 — foundation (this branch)
- Keep both strategy engines unchanged.
- Add execution-mode/risk configuration.
- Add server-owned runtime health state.
- Add independent risk preflight with explicit rejection reasons.
- Add redacted append-only audit log.
- Add GET /api/trading/status and disabled-by-default POST /api/trading/preflight.
- No FYERS order placement.

### Phase 2 — dedicated host and auth
- Provision VM + static IPv4.
- Activate/verify FYERS Algo Trading App and whitelist that IPv4.
- Move FYERS OAuth callback to the dedicated server.
- Encrypt broker tokens at rest with a server-only master key.
- Remove the current FYERS bearer blob from PWA localStorage/hash.
- Use one-time session exchange and short-lived Mentor application sessions.

### Phase 3 — live data + PAPER
- Run persistent FYERS market-data WebSocket with reconnect/backoff.
- Run persistent FYERS order WebSocket in observe/reconcile mode.
- Replace 2-second browser quote polling with server-streamed quotes.
- Implement PAPER fills and position lifecycle behind the risk engine.
- Extend Trade Journal with execution/audit lifecycle events.

### Phase 4 — broker write adapter, still locked
- Implement FYERS place/modify/cancel/position-exit adapter.
- Add funds/margin checks and authoritative broker reconciliation.
- Add persistent idempotency and daily P&L state.
- Keep LIVE disabled.

### Phase 5 — controlled LIVE validation
- Test rejection paths, disconnects, stale data, duplicate clicks, partial fills, rejections and restart recovery.
- Run tiny-size supervised validation only after explicit user approval.
- Enable LIVE only via server-side controls; never from a public-PWA-only toggle.
