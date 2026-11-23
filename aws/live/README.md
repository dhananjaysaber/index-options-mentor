# Live execution foundation

This branch introduces a durable, disabled-by-default order coordinator. It has no public route, active broker adapter or deployment switch. Tests use a fake broker and a temporary database.

Every user action needs a stable UUID. The coordinator commits an order reservation before contacting the broker. Repeating the same request returns its saved state. Reusing the UUID for different parameters fails. A timeout or crash leaves an unresolved order that must be reconciled against the broker's order book. An empty response never automatically resubmits the order.

Acknowledgements and actual fills are tracked separately. Partial fills remain visible after cancellation. Order IDs, symbols, quantities, sides and tags are checked before broker updates are adopted. A persistent stop control blocks new submissions. It does not cancel existing orders or close positions. It cannot recall an order already being transmitted to FYERS.

Before any real use, implement and verify all remaining integration work

- A FYERS adapter running on the approved AWS static IP, with current live app credentials and owner verification.
- A protected API and explicit user confirmation flow with stable intent IDs.
- Server-owned contract lookup, lot sizes, fresh quotes, available-funds checks, and limits selected by the user.
- Exit intents limited to confirmed owned quantities, broker protection orders, cancellation and partial-fill handling.
- Continuous reconciliation and recovery of unresolved orders after a process restart.
- Durable execution audit records integrated with the production journal and its backups.
- End-to-end tests for entries, exits, rejection, timeout and restart before enabling any live switch.

FYERS order tags are tracking fields. The application enforces its own retry protection. SDK order responses cannot be treated as evidence of an exchange fill.

References

- https://fyers.in/api-docs/v3/getting-started/guides/order-placement-guide/
- https://fyers.in/api-docs/v3/api/trading/order-book/get-orders/
- https://fyers.in/api-docs/v3/api/trading/order-book/get-orders-by-order-tag/
- https://support.fyers.in/portal/en/kb/articles/what-are-the-new-sebi-rules-for-retail-algo-trading-from-april-01-2026

Run `python3 -m unittest discover -s tests -p 'live_orders_test.py' -v`.
