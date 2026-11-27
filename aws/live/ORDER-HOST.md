# Owned execution host — installed with sending disabled

The separate FYERS trading app was activated with explicit user approval on
25 November 2026 at 10:38 IST. The user subsequently installed the shared-socket
publisher and completed the new hidden-prompt login. AWS confirmed pinned owner,
profile/funds/orders/positions reads, unchanged paper credentials and zero orders.

This package wires the actual REST client, server strategy generator, persistent
owned-intent coordinator, broker protection, shared exits and journal outbox into
one loopback HTTP host. Installation never enables real-money sending. It adds
`index-options-order-host.service` and a daily ledger backup at 20:25 IST; the
existing journal backup/Sheet export timer remains unchanged.

## Data and execution

- A fixed-route FYERS HTTPS client loads the separately stored trading token.
  It does not follow redirects, log broker responses or retry mutations.
- Entry qualifications and candidate symbols come from the existing production
  Core/Scalp functions and Mentor snapshot builder, loaded server-side from FYERS
  history/chain data. Browser prices, stop levels and arbitrary symbols are rejected.
- The existing single DataSocket supplies independently fresh NIFTY and option
  prices. Bid/ask, lot size, tick, expiry, trade status and freeze quantity are
  checked. Actual master string quantities are parsed; no quantity is guessed.
- Budget is copied explicitly from the app's Amount per trade field when preparing
  a live plan. Settings are capped by the host's configured maximum, initially
  ₹30,000. Whole lots and buy limit are recalculated from the current ask. There
  is no daily trade-count limit. Both live auto-entry switches default OFF.
- One slot per strategy, durable setup/request IDs, cancellation write-ahead and
  orderbook reconciliation prevent replay-created entries or exits. A partial
  entry cancels its unfilled remainder and protects only settled owned fills.
- Initial protection requires the broker orderbook's exact stop and limit prices,
  not an acknowledgement alone. Trailing tightening/cancellation shares the
  previously tested coordination. Unknown outcomes are not resubmitted.
- The continuous worker recovers the owned ledger and keeps managing confirmed
  fills without a browser. Broker protective fills reconcile even with no quotes.
  Journal outages cannot stop an already protected position's exit. Real broker
  fills create durable open/close events; each final exit has one stable ID.
- The sole production-journal HTTP writer remains the existing journal service.
  The order ledger has its own SQLite database and consistent daily backups.
  Existing Sheet export handles its actual trade events through the journal.

## App and authentication

The new Settings panel checks the signed order host and can prepare server-owned
Core/Scalp plans with buy premium, lots, quantity, premium cost and initial stop.
New buys and real auto-entry controls stay disabled while AWS sending is OFF.
Exit stays available only for trades the server already holds (see below).
Existing research-position controls remain simulations.

## Trades sold outside the app

If you or FYERS sell a held trade, the server confirms it only when today's
orderbook shows every app fill and no net holding, FYERS positions show that
option flat, and no other order for it is open, twice at least 5 seconds apart.
It then cancels only its own stop for that trade, confirms it, sends no sale and
unlocks. The journal gets a "needs checking" checkpoint with no sale price or
profit, so it is not part of closed-trade totals.

Anything else stays locked with attention: a part sale, missing or conflicting
FYERS data, another open order, an unfinished app sale or an unseen stop. The app
changes nothing, so a stop already at FYERS can still fire, possibly for more than
you still hold. Check positions and open orders by hand. There is no unlock
button, and evidence from an earlier day is not available in today's orderbook.

## Switching real money off

Set `realMoneyEnabled` to `false`, keep `operatorApprovedAppId`, and restart the
order service. New buys are blocked. Stops, stop changes, order cancellations and
sales still go to FYERS for trades this server already holds. A new stop or sale
is sent only when the FYERS holding matches the server's own record.

To block every order, also remove `operatorApprovedAppId` and restart. The server
then cannot sell or change anything; stops already at FYERS stay there, so check
FYERS by hand. A fresh install has no approval and cannot send any order.

The Netlify gateway verifies the existing encrypted browser session against FYERS,
derives the pinned owner proof and signs the request to `/monitor/orders/`. It
never forwards broker tokens to AWS. Writes need an explicit action header,
allowed origin, strict fields, fresh signature and one-use nonce. The installer
can verify only a signed status through Netlify; it cannot submit an order.

## Release boundary

Run the checksum-verified `public/iom-order-host.py` on AWS. It tests in disposable
storage as mentor, installs a root-managed DISABLED configuration, checks the new
host through Netlify and verifies daily backup execution. It restores its own
service/config/nginx changes on failure and does not restart the paper/feed/journal
services. Enabled hosts or unresolved broker intents block unattended replacement.

A passed installation proves software wiring, account ownership, read access and
simulated lifecycle behaviour. It does not prove actual broker stop acceptance,
fill latency, exchange execution or slippage. The user must perform the final
controlled real-order acceptance test. No automatic merge or real-money activation
is part of this installer; PR28 and PR30 remain unmerged.

## Private website

With Netlify's private lock on, the website answers the server's own check with
401. Add `--site-is-private` to the installer. Only a 401 is then accepted, and
the installer instead makes the same signed status check at
`https://api.optionsmentor.in`. This does not check website to server: sign in to
the app afterwards and confirm the server status appears. Without the flag, or
with any other error, the installer restores its changes.

## Contract-stream startup correction

The first AWS installation passed its isolated tests but rolled back at startup.
The real FYERS F&O JSON was 90,878,119 bytes, exceeding the original 40 MB cap.
The loader now decodes 64 KiB chunks, discards stock-option records as it goes,
and retains only matching NIFTY option contracts, with bounded per-record and
total input limits. A direct read of the actual official file loaded 7,534
matching contracts using about 53.5 MiB peak process memory. Tests cover chunk
boundaries, split UTF-8, malformed/truncated data and a generated master over
40 MB without constructing that whole file in memory.

The installer now runs a disabled account/master/journal preflight before any
service or nginx changes. Startup failures expose only a fixed stage and safe
constant reason. Rollback disables new units while their files still exist,
then restores/removes configuration, avoiding dangling enablement links.

## One-tap manual buy (see APP-SIGN-IN.md)

`preview` returns what a tap would ask for; it saves and sends nothing. `buy` runs prepare and submit once under one lock. It sends nothing if the option, quantity or highest price differ from the screen, or for a second manual tap on the same strategy within three seconds. The same request identity never buys twice. A refusal carries a fixed reason code; "unclear" means an order record exists.

## Connect trading account (app button)

Available only after the app's Google sign-in, and it still needs the app's FYERS connection for the owner check.

One-time setup, in this order (the installer's check still needs a working token from the older terminal sign-in):

1. Install while the trading app's redirect URL in FYERS is still the old one.
2. On the server: `sudo python3 <release>/aws/live/account_connect.py save-app`. It saves the trading App ID and Secret ID in `/etc/index-options-trading-app.json` (root:mentor 0640). The Secret ID never goes to Netlify or the browser.
3. In FYERS, change the trading app's redirect URL to `https://optionsmentor.netlify.app/trading-login`. The older terminal sign-in stops working after this.

Each day: tap Connect trading account. A start is valid for five minutes and one use. The server saves the token only after the owner and the funds, orders and positions reads pass, then restarts. If the saved sign-in does not work at startup, the service waits (sign-in and status only; it cannot send any order or manage a held trade) instead of restarting every few seconds. Not tried against real FYERS.
