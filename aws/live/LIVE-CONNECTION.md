# Separate trading login and single-socket feed

This release is preparatory. It does not enable real orders or expose real-order
HTTP routes. The actual server strategy/execution host and a user-executed broker
stop/fill acceptance test remain release blockers. Changing a setting in the
simulation checker cannot enable live trading.

## Verified journal evidence (25 November 2026)

The user ran the checksum-pinned consolidated checker on AWS. It reported 193
SQLite trades / 400 events, a verified daily backup, zero pending exports, and a
complete Google Sheets identifier scan. Replaying one existing exit twice left
one trade row and one total final-exit event for that trade. No production trade
or event was added by the replay. Core and Scalp checks passed with disposable
journals and a simulated broker. These results are not actual broker-fill proof.

## Installation

Build `python3 scripts/build-live-connect.py`; publish the resulting
`public/iom-live-connect.py` from this branch. Download it to a temporary file,
verify the published SHA256 and run with `sudo python3` on the existing host.

The installer:

- Runs 60 execution/ownership/feed/account tests and two Node publisher tests
  as the unprivileged mentor user in disposable storage.
- Finds the existing daemon's systemd service through its running process cgroup.
  Fails before edits if it cannot identify one service or source anchors differ.
- Refuses a feed restart while an existing Core/Scalp paper position is open.
- Adds one publisher to the existing validated FYERS message handler. It opens
  no second DataSocket, preserves both paper-dispatch calls and merges only
  separately requested NIFTY option subscriptions.
- Stores independently timestamped index and option prices in a private atomic
  cache. Fresh index ticks never refresh stale option prices; entries require a
  fresh positive, non-crossed bid/ask from the validated option packet.
- Checks a fresh subscription acknowledgement after the controlled restart.
  On failure it restores the source/publisher and restarts the original service.
- Does not touch paper credentials, paper positions or the production journal.

The fixed cache directory is `/var/lib/index-options-mentor/live-feed`. A future
execution host must refresh its bounded subscription manifest every few seconds
and inject `Feed.quote`/`Feed.pair` into the existing planner and manager. The cache
itself cannot trigger orders. Dynamic strategy qualification and real-entry
protection are not substituted with browser data or fake snapshots.

## FYERS trading app

The signed-in FYERS dashboard showed Algo Trading App as inactive. Its form is
prepared with Primary IP `13.207.238.61` and the official FYERS callback:
`https://trade.fyers.in/api-login/redirect-uri/index.html`.
Terms acceptance and granting trading access require user confirmation. Existing
non-trading applications and credentials stay unchanged.

After activation, run the `tradingLoginCommand` printed by the installer. Enter
only the NEW App ID ending `-200` and Secret ID into its hidden SSH prompts. Open
the generated FYERS URL, then paste the FULL resulting callback address into the
hidden terminal prompt, never into chat. The CLI verifies the five-minute nonce,
exact callback destination, broker profile against the already-pinned AWS owner,
then funds/orderbook/positions reads. Only after all checks pass does it atomically
save `/etc/index-options-live-account.json` with root:mentor 0640 permissions.
It does not persist the app secret/auth code, replace paper credentials, start
services or send orders. Its network allowlist has no broker mutation endpoint.

A trading app ID and successful account reads do not prove broker orders/stops.
Real-money stays OFF until the separate execution host and actual broker
acceptance checks pass. PR28 and PR30 remain unmerged.
