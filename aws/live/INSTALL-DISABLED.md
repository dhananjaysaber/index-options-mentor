# Install the disabled modules

`public/iom-live-stage.py` is a self-contained staging installer. Its package contains the live modules and 38 simulated-broker tests from its content-addressed source package. It has no credentials and makes no FYERS requests. It uses the server's installed journal implementation in disposable test databases.

Before running, verify the published installer's SHA-256 against the value supplied with the release. Run it with `sudo python3 /tmp/iom-live-stage.py`. It requires Python 3.12+, the mentor account, the installed journal/store.py and both existing app/journal services active.

It installs a versioned, root-owned release under `/opt/index-options-mentor/live/releases/` and selects it using `live/current` only after tests pass. Repeating the same verified installation is safe. Existing release content must match exactly; unexpected directories, symlinks and changed releases are refused. It does not install or start a systemd service, touch broker credentials, read or migrate the production database, change nginx or alter the daily timer. `installed.json` records `tradingEnabled: false` and `serviceInstalled: false`.

A successful installation ends with `stage: INSTALLED_DISABLED`, `tests: PASS`, both existing services active and `liveServiceStarted: false`. This confirms staging only; the authenticated app proxy, deployed host, recovery worker, strategy integration and broker protection orders still require implementation and verification before real money can be enabled.

Rebuild with `python3 scripts/build-live-stage.py`. Test locally using `python3 public/iom-live-stage.py --verify-only --journal-store aws/journal/store.py`. CI also tests successful/repeat installation, failure without release selection and unsafe installation paths against a disposable fake server tree.
