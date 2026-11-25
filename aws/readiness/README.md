# One-shot FYERS read-only readiness

Run `sudo python3 public/iom-fyers-readiness.py` on the existing AWS host. The script reads the running mentor service App ID and existing protected token file, verifies the FYERS profile against the pinned paper-owner HMAC, then reads funds, orders and positions. It uses Python standard-library HTTPS with a fixed GET-only allowlist, no redirects and no environment proxy. The FYERS Python SDK is not required.

This does not install a service, refresh credentials, change configuration, write to any journal or submit, modify or cancel an order. It never reports balances, symbols, account identity, credentials or raw broker errors. Wrong ownership stops all subsequent reads. The only returned order/position information is counts. An expired login or unsafe token-file permissions produces a redacted blocker; the script does not silently repair or replace credentials. Service states/PIDs are compared before and after.

`readOnlyBrokerAccessPassed` proves only authenticated reads. Trading permissions, registered static IP, live WebSocket exit management, actual broker stop acceptance and real-order behaviour are not established by it; all readiness flags for those remain false. The existing AWS credentials may belong to a non-trading app. Do not replace them with trading credentials or infer order permission from successful profile/funds reads.

Build the public copy using `python3 scripts/build-fyers-readiness.py`; it is byte-for-byte identical to `aws/readiness/fyers_readiness.py`. Run `python3 -m unittest discover -s tests -p 'test_fyers_readiness.py' -v` for read-only boundary, wrong-owner, credential redaction, token ambiguity, HTTP failures and file-permission checks. The current diagnostic and disabled-live installers are unchanged.

Official API references checked 25 November 2026:
- https://fyers.in/api-docs/v3/api/account/profile/
- https://fyers.in/api-docs/v3/api/account/funds/
- https://fyers.in/api-docs/v3/getting-started/create-an-app/individual-app/
- https://github.com/FyersDev/fyers-skills/blob/master/skills/fyers-trading/references/endpoints.md
