# Price feed: try again by itself

`index-options-marketdata.service` exits successfully when its FYERS sign-in has
expired (`FYERS_AUTH_REQUIRED TOKEN_EXPIRED`). With `Restart=on-failure` it then
stays stopped, even after a new sign-in.

`public/iom-feed-restart.py` adds one systemd drop-in, `zz-iom-restart.conf`
(`Restart=always`, every 120 seconds, no start limit). The server already has
`recovery.conf` (on-failure, 120 seconds, 6 starts an hour) and
`feed-status.conf`. Neither is edited; the new name sorts after both. `--undo` removes it. A manual `systemctl stop`
still keeps the service stopped.

It does not sign in to FYERS. The daily server data sign-in is still a manual
step on the server. Tested with a fake systemctl and `systemd-analyze verify`
only; restart behaviour must be checked on the server after installation. If
something else stops the service on a schedule, this setting will not undo it.
