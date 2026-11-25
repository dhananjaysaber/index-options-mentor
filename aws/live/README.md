# Disabled live execution integration

This is tested server code, not an enabled trading deployment. Importing these modules opens no network listener, reads no credentials and starts no background worker. Nothing here changes production, paper positions, FYERS app credentials or the existing journal database.

## Implemented

- `fyers_broker.py`: narrow adapter for an injected official synchronous FYERS Python SDK client. Reads account identity, available balance, tagged orders and net intraday quantities. Sending is disabled by default. Broker profile details and raw error responses are not logged or returned by the bridge.
- `planner.py`: server-owned contract lookup and fresh option ask. Computes whole lots from the amount per trade, rounds limit prices upwards to the exchange tick and checks contract expiry, exchange quantity limits, market-session state and available funds plus a configured charge reserve. The browser cannot submit its own quantity or broker payload.
- `execution.py`: persisted 15-second entry plans with stable UUIDs. Submission rechecks account, funds, contract and price. A higher ask requires a new plan; it never silently exceeds the approved limit price or quantity. Unresolved entries reserve cash atomically. External/manual changes to net exposure block an exit.
- `orders.py`: durable entry and owned-exit reservations, confirmed fill tracking, partial-fill handling, restart recovery and audit snapshots. Uncertain outcomes are reconciled instead of resubmitted. Concurrent exits cannot reserve more than the entry's confirmed, settled fills. New-entry stop leaves owned protective exits available. There is no broad account-wide exit operation or market-order fallback.
- `bridge.py`: a loopback-only HTTP server factory. Every POST requires a verified owner and HMAC over the exact body, path, timestamp and nonce. Nonces survive restarts. No listener is started automatically; no public nginx or Netlify route is added.
- A durable close outbox delivers broker-confirmed closes to the production `Journal` implementation. The trade ID is the entry intent ID. Replay after a crash leaves one final row. Gross P&L comes from broker-confirmed weighted fill prices; charges are not invented or deducted.

The signed internal routes are `/live/prepare` (`intentId`, `symbol`, `amount`, `strategy`), `/live/submit` (`intentId`), `/live/exit` (`intentId`, `entryId`, `price`, `quantity`), `/live/reconcile` and `/live/stop`. Strategy is `CORE` or `SCALP`. Reconciliation and stop take empty JSON objects. These are internal service routes, not public browser APIs.

## Storage and backups

At eventual deployment, initialise `Orders` and `Journal` with the **same existing `journal.sqlite3` path**. The table names do not conflict. The existing SQLite daily backup then captures plans, intents, audit, replay receipts and journal rows together; the Sheets exporter continues exporting the journal's final trades. A test runs the current backup implementation, verifies SQLite integrity and checks that the order ledger and close receipt are included. No separate, unbacked production live database should be used. Tests use disposable databases only.

## Production integration still required

This branch is not ready to enable real money. There is no credential-loading host, running reconciliation worker, authenticated browser/Netlify live proxy or active strategy-to-live-order wiring. The actual FYERS SDK connection has not been exercised with this account.

Before enabling, the host must:

1. Run on the approved AWS static IP with a trading-enabled FYERS app/token and verify the expected account. Preserve the current non-trading paper app and its credentials.
2. Supply server-owned contract/master data, timestamped quote readers and the existing market/calendar and strategy signals. Do not accept a browser's claim that a strategy qualifies. Apply the user's saved amount and explicit server limits. Configure charge reserve and verify broker permissions and margin behaviour.
3. Authenticate the app user and same-origin request at Netlify, bind to the verified FYERS account and sign only permitted internal bridge requests. Keep the bridge HMAC key server-side. An open plan alone is not authorisation to submit a real trade.
4. Wire the current Core/Scalp management signals to owned live exits, including confirmed protective broker stops, cancellation of pending entries/protection orders, partial-fill recovery and broker-fill journal reconciliation. Do not run paper exits against live positions.
5. Install the periodic recovery worker and verify live order/position streams, reconnects, market/expiry handling, existing daily backup/Sheets export, controlled broker rejection and restart recovery before any real-money enablement.

The order book endpoint covers today's orders. Unresolved orders surviving a trading-day boundary require broker trade/history investigation; absence from today's book never permits an automatic resend.

## Validation

Run `python3 -m unittest discover -s tests -p 'live_*test.py' -v` from the repository root. All SDK interactions in the suite use simulated clients. Tests cover HTTP authentication, replay, whole-lot sizing, limit-price moves, account mismatch, cash reservations, simultaneous exits, partial fills, uncertain submissions, stop/restart recovery, immutable journal delivery and the current backup implementation. CI runs the same suite without credentials.

Official protocol references checked on 23 November 2026:

- https://fyers.in/api-docs/v3/api/trading/order-placement/sync/single-order/
- https://fyers.in/api-docs/v3/api/trading/order-book/get-orders/
- https://fyers.in/api-docs/v3/api/trading/order-book/get-orders-by-order-tag/
- https://fyers.in/api-docs/v3/api/account/profile/
- https://fyers.in/api-docs/v3/api/account/funds/


## Authenticated execution connection (simulation only)

`diagnostic_host.py` is a loopback host for `/monitor/live/status` and `/monitor/live/check`. It has no real-order routes, SDK credentials or production journal handle. The app's Settings connection button uses `netlify/functions/execution.mjs`: the existing encrypted FYERS session is verified against the FYERS profile, bound to the pinned AWS account using the existing bridge HMAC, then forwarded as an expiring signed request with a durable nonce. The browser never receives the shared key, raw account identity or FYERS token from this gateway. Wrong accounts and attempts to call submit/prepare fail closed.

The check uses persisted fake broker orders and a disposable journal, the same `Orders` and `Execution` coordinators, `Protection` cancellation/modification reconciliation, and `Manager` with the PWA's shared pure position and exit engines. It exercises automatic Core and Scalp profit-trail exits, broker stop tightening, cancellation before replacement sells, replay, restart and one close row per strategy. A filled broker stop prevents a second sell. A cancellation acknowledgement alone cannot release reserved quantity. Stop-limit orders remain subject to actual broker/exchange behaviour; simulated acceptance does not establish real broker readiness.

`public/iom-execution-connect.py` packages and verifies the whole simulation host. On explicit installation it creates a dedicated diagnostic service, separate receipt database and narrowly scoped nginx route; it reuses the existing pinned owner and bridge key without changing paper credentials. Its service permits network traffic only to localhost. A final server-authenticated request goes through the deployed Netlify PR28 function back to AWS, runs the check and validates the results before reporting success. Failures roll back this service/config/route change. Existing app/journal services and daily timer must stay active. The production journal database and open paper/real positions are never opened by this host.

This completes the simulation connection, not real-money activation. The credential-loading trading host, trusted live strategy/data integration, continuous order/feed worker and real broker order/stop verification are still required before any real-money release. No browser switch enables real money in this version.
