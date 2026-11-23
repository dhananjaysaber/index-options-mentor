# SQLite trade journal

The production `/api/journal` contract stays the same. With `JOURNAL_STORAGE=sqlite`, Netlify signs journal requests and forwards them to the SQLite service on the existing AWS instance. Without that setting, it continues to use the current Sheets service.

The database stores trades, received events, research setups, export acknowledgements and request nonces. Trade IDs and event IDs are unique. A confirmed close is final. Competing closes and later updates remain in the audit log and cannot overwrite the final record.

## Deployment order

1. Deploy the companion Netlify functions to the existing `optionsmentor` production site while leaving `JOURNAL_STORAGE` unset. This adds the signed `/api/journal-maintenance` route used for migration and export.
2. Copy this directory to the Lightsail instance and run `sudo bash install.sh`. The installer verifies the existing shared bridge key, imports completed trades through the original Sheets service, validates a backup, starts the SQLite service, and adds a loopback nginx route. It stops if it cannot verify credentials, history exceeds the original API's 1,000-record limit, or nginx fails validation.
3. Verify the signed AWS journal health through the Netlify functions in staging. Check imported closed-trade counts and values, and submit a synthetic trade only to a separate test database. Do not seed fake trades into the production database.
4. Set `JOURNAL_STORAGE=sqlite` in the production Netlify function environment and redeploy. Confirm `/api/journal?health=1` reports `storage=sqlite` and the import metadata. Refresh the actual PWA and verify its journal reads the imported history.

The installer uses a dedicated `index-options-journal.service`, separate from the running market monitor. The production switch is deliberately a final activation step, after AWS installation succeeds. This work does not enable broker orders or merge PR #28.

## Backup and export

`index-options-journal-daily.timer` runs every day at 20:30 Asia/Kolkata, even while the app is closed. `Persistent=true` runs a missed job when the server returns. The job takes a SQLite online backup, runs an integrity check, and atomically replaces that date's backup. It retains 30 dated copies under `/var/lib/index-options-mentor/journal/backups`. These are local server backups. Google Sheets receives a separate daily copy of trade and setup records. Full off-server database backups require a separate durable destination.

After the backup succeeds, the job exports changed records through Netlify using the existing Google Apps Script connection and secrets. It spaces requests three seconds apart. A failure retains unacknowledged exports and systemd retries after five minutes. Event IDs are stable across retries. Only a successful Sheets acknowledgement advances the exported version. Concurrent database updates remain pending for the next pass.

History migration imports all completed trades returned by the existing Apps Script list endpoint. Existing open browser positions are recorded by the app's normal resume/open events. The source Sheets history and existing paper-state files are preserved. The export contains each trade's latest state and research setup. SQLite retains the complete received-event audit log.

## Operations

```bash
sudo systemctl status index-options-journal.service --no-pager
sudo systemctl list-timers index-options-journal-daily.timer --no-pager
sudo journalctl -u index-options-journal-daily.service -n 30 --no-pager
sudo -u mentor python3 /opt/index-options-mentor/journal/service.py health
sudo systemctl start index-options-journal-daily.service
```

The health response exposes the latest successful backup and export. It reports failed exports while keeping all pending records. Service logs contain no signing keys or trade payloads.

## Restore

Stop `index-options-journal.service` and its daily timer before restoring. Retain the current database, WAL and SHM files together as a recovery copy. Use Python's SQLite backup API to restore a selected verified backup into a fresh database, run `PRAGMA integrity_check`, and compare trade and event counts before replacing the stopped database. Restore ownership to `mentor:mentor` and permissions to `0600`. Restart the service and timer, verify journal health and counts, and review any trades entered after the selected backup before resuming writes. Never copy a running WAL database's main file by itself.

## Local verification

```bash
python3 -m unittest discover -s tests -p '*_test.py' -v
node --test tests/sqlite-journal-gateway.test.mjs
bash -n aws/journal/install.sh
```
