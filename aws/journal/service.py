"""Loopback journal service, signed Netlify bridge, import and daily maintenance."""
import hashlib
import hmac
import json
import os
import re
import sys
import time
import urllib.error
import urllib.request
import uuid
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path

from store import Journal, encoded

ROOT = Path(os.environ.get("IOM_JOURNAL_ROOT", "/var/lib/index-options-mentor/journal"))
DATABASE = ROOT / "journal.sqlite3"
MAX_BODY = 8 * 1024 * 1024


def credentials():
    # Shared key stays in a root-managed file, never in browser JavaScript.
    data = json.loads(Path(os.environ.get("IOM_JOURNAL_CONFIG", "/etc/index-options-journal.json")).read_text())
    if len(data.get("secret", "")) < 32:
        raise RuntimeError("JOURNAL_SECRET_NOT_CONFIGURED")
    url = data.get("netlify", "")
    if not re.fullmatch(r"https://[a-z0-9-]+\.netlify\.app", url):
        raise RuntimeError("INVALID_NETLIFY_ORIGIN")
    return data


def signature(secret, stamp, nonce, method, path, body):
    canonical = "\n".join((stamp, nonce, method, path, hashlib.sha256(body).hexdigest()))
    return hmac.new(secret.encode(), canonical.encode(), hashlib.sha256).hexdigest()


def sheet_request(payload):
    config = credentials()
    path = "/api/journal-maintenance"
    body = encoded(payload).encode()
    stamp, nonce = str(int(time.time() * 1000)), uuid.uuid4().hex
    request = urllib.request.Request(config["netlify"] + path, body, headers={
        "Content-Type": "application/json", "x-iom-time": stamp, "x-iom-nonce": nonce,
        "x-iom-signature": signature(config["secret"], stamp, nonce, "POST", path, body)
    })
    with urllib.request.urlopen(request, timeout=90) as response:
        result = json.load(response)
    if not result.get("ok"):
        raise RuntimeError("SHEET_REQUEST_FAILED")
    return result


def migrate(journal):
    health = sheet_request({"action": "health"})
    result = sheet_request({"action": "list_trades", "limit": 1000})
    trades = result.get("trades")
    if not isinstance(trades, list):
        raise RuntimeError("INVALID_SHEET_HISTORY")
    # Refuse a truncated export. The original Apps Script caps this action at 1,000.
    if health.get("trades", 0) > 1000:
        raise RuntimeError("SHEET_HISTORY_EXCEEDS_API_LIMIT")
    imported = journal.import_trades(trades)
    journal.backup(ROOT / "backups")
    return imported


def maintenance(journal):
    backup = journal.backup(ROOT / "backups")
    print(encoded({"backup": backup}), flush=True)
    exported = 0
    while True:
        jobs = journal.pending_exports()
        if not jobs:
            break
        for job in jobs:
            # Every retry has a deterministic export event ID. Sheets upserts trades by ID.
            sheet_request(job["payload"])
            journal.acknowledge_export(job)
            exported += 1
            time.sleep(3)
    journal.mark("last_export_at", time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime()))
    journal.mark("last_export_error", "")
    print(encoded({"ok": True, "exported": exported}), flush=True)


class Handler(BaseHTTPRequestHandler):
    server_version = "IOMJournal/1"

    def log_message(self, format, *args):
        # Never log payloads, signatures or credentials.
        return

    def respond(self, code, payload):
        data = encoded(payload).encode()
        self.send_response(code)
        self.send_header("Content-Type", "application/json")
        self.send_header("Cache-Control", "no-store")
        self.send_header("Content-Length", str(len(data)))
        self.end_headers()
        self.wfile.write(data)

    def do_POST(self):
        if self.path != "/journal/bridge":
            return self.respond(404, {"ok": False, "error": "UNKNOWN_ROUTE"})
        try:
            size = int(self.headers.get("Content-Length", "0"))
            if size < 1 or size > MAX_BODY:
                return self.respond(413, {"ok": False, "error": "INVALID_BODY_SIZE"})
            self.connection.settimeout(15)
            body = self.rfile.read(size)
            if len(body) != size:
                raise ValueError("INCOMPLETE_BODY")
            stamp = self.headers.get("x-iom-time", "")
            nonce = self.headers.get("x-iom-nonce", "")
            supplied = self.headers.get("x-iom-signature", "")
            if not re.fullmatch(r"\d{13}", stamp) or abs(time.time() * 1000 - int(stamp)) > 60000:
                return self.respond(401, {"ok": False, "error": "EXPIRED_SIGNATURE"})
            if not re.fullmatch(r"[a-f0-9]{32}", nonce):
                return self.respond(401, {"ok": False, "error": "INVALID_NONCE"})
            expected = signature(credentials()["secret"], stamp, nonce, "POST", self.path, body)
            if not hmac.compare_digest(expected, supplied):
                return self.respond(401, {"ok": False, "error": "INVALID_SIGNATURE"})
            self.server.journal.remember_nonce(nonce, time.time() + 120)
            payload = json.loads(body)
            if not isinstance(payload, dict):
                raise ValueError("INVALID_JSON")
            journal = self.server.journal
            action = payload.get("action")
            if action == "health":
                result = journal.health()
            elif action == "list_trades":
                result = journal.list_trades(payload.get("limit", 500))
            elif action == "journal_event":
                result = journal.event(payload.get("event", {}))
            elif action == "setup_decision":
                result = journal.setup(payload.get("setup", {}))
            else:
                raise ValueError("UNKNOWN_ACTION")
            self.respond(200, result)
        except (ValueError, TypeError, AttributeError, OverflowError):
            self.respond(400, {"ok": False, "error": "INVALID_JOURNAL_REQUEST"})
        except Exception:
            self.respond(503, {"ok": False, "error": "JOURNAL_UNAVAILABLE"})


def main():
    journal = Journal(DATABASE)
    command = sys.argv[1] if len(sys.argv) > 1 else "serve"
    if command == "migrate":
        print(encoded(migrate(journal)))
    elif command == "daily":
        try:
            maintenance(journal)
        except Exception:
            journal.mark("last_export_error", "Export failed; pending rows retained for retry")
            raise
    elif command == "health":
        print(encoded(journal.health()))
    elif command == "backup":
        print(encoded(journal.backup(ROOT / "backups")))
    else:
        credentials()
        server = ThreadingHTTPServer(("127.0.0.1", 9076), Handler)
        server.journal = journal
        server.serve_forever()


if __name__ == "__main__":
    os.umask(0o077)
    main()
