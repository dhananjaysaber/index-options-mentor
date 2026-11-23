"""Durable trade journal. Only the AWS HTTP service opens this database."""
import hashlib
import json
import math
import os
import sqlite3
import time
import uuid
from contextlib import contextmanager
from datetime import datetime, timezone
from pathlib import Path
from zoneinfo import ZoneInfo


def encoded(value):
    return json.dumps(value, separators=(",", ":"), allow_nan=False, sort_keys=True)


def timestamp(value):
    if not isinstance(value, str):
        raise ValueError("INVALID_TIMESTAMP")
    return datetime.fromisoformat(value.replace("Z", "+00:00")).timestamp()


def identifier(value):
    if not isinstance(value, str) or not value or len(value) > 250:
        raise ValueError("INVALID_ID")
    return value


class Journal:
    def __init__(self, file):
        self.file = Path(file)
        self.file.parent.mkdir(parents=True, exist_ok=True, mode=0o700)
        with self.connection() as db:
            db.execute("PRAGMA journal_mode=WAL")
            db.executescript("""
                CREATE TABLE IF NOT EXISTS trades (
                    id TEXT PRIMARY KEY, payload TEXT NOT NULL,
                    closed INTEGER NOT NULL, version INTEGER NOT NULL DEFAULT 1,
                    event_at REAL NOT NULL, updated_at REAL NOT NULL
                );
                CREATE TABLE IF NOT EXISTS events (
                    id TEXT PRIMARY KEY, trade_id TEXT NOT NULL,
                    payload TEXT NOT NULL, received_at REAL NOT NULL
                );
                CREATE TABLE IF NOT EXISTS setups (
                    id TEXT PRIMARY KEY, payload TEXT NOT NULL,
                    version INTEGER NOT NULL DEFAULT 1, event_at REAL NOT NULL
                );
                CREATE TABLE IF NOT EXISTS exports (
                    kind TEXT NOT NULL, id TEXT NOT NULL, version INTEGER NOT NULL,
                    PRIMARY KEY(kind,id)
                );
                CREATE TABLE IF NOT EXISTS metadata (key TEXT PRIMARY KEY, value TEXT NOT NULL);
                CREATE TABLE IF NOT EXISTS nonces (id TEXT PRIMARY KEY, expires REAL NOT NULL);
                CREATE INDEX IF NOT EXISTS closed_trades ON trades(closed,event_at DESC);
            """)
        os.chmod(self.file, 0o600)

    @contextmanager
    def connection(self):
        db = sqlite3.connect(self.file, timeout=15, isolation_level=None)
        db.row_factory = sqlite3.Row
        db.execute("PRAGMA busy_timeout=15000")
        db.execute("PRAGMA synchronous=FULL")
        try:
            yield db
        finally:
            db.close()

    @contextmanager
    def transaction(self):
        with self.connection() as db:
            db.execute("BEGIN IMMEDIATE")
            try:
                yield db
                db.commit()
            except Exception:
                db.rollback()
                raise

    def remember_nonce(self, nonce, expires):
        with self.transaction() as db:
            db.execute("DELETE FROM nonces WHERE expires < ?", (time.time(),))
            try:
                db.execute("INSERT INTO nonces VALUES (?,?)", (nonce, expires))
            except sqlite3.IntegrityError as error:
                raise ValueError("REPLAYED_REQUEST") from error

    def event(self, event, db=None, imported=False):
        if db is None:
            with self.transaction() as transaction:
                return self.event(event, transaction, imported)
        identifier(event.get("id"))
        trade = event.get("trade")
        if not isinstance(trade, dict):
            raise ValueError("INVALID_TRADE")
        trade_id = identifier(trade.get("id"))
        event_type = event.get("type")
        if event_type not in ("TRADE_OPENED", "POSITION_CHECKPOINT", "TRADE_CLOSED"):
            raise ValueError("INVALID_EVENT_TYPE")
        closed = event_type == "TRADE_CLOSED"
        event_at = timestamp(trade.get("closedAt") if closed else event.get("queuedAt"))
        if event_at > time.time() + 60:
            raise ValueError("FUTURE_EVENT")
        if closed:
            for key in ("entry", "exit", "quantity"):
                value = trade.get(key)
                if isinstance(value, bool) or not isinstance(value, (int, float)) or not math.isfinite(value) or value <= 0:
                    raise ValueError("INVALID_CLOSED_TRADE_" + key.upper())
            if int(trade["quantity"]) != trade["quantity"]:
                raise ValueError("INVALID_QUANTITY")
        payload = encoded(event)
        existing_event = db.execute("SELECT trade_id,payload FROM events WHERE id=?", (event["id"],)).fetchone()
        if existing_event:
            prior = json.loads(existing_event["payload"])
            if existing_event["trade_id"] != trade_id or prior.get("type") != event_type:
                raise ValueError("EVENT_ID_CONFLICT")
            return {"ok": True, "eventId": event["id"], "tradeId": trade_id, "result": "ALREADY_RECORDED"}
        existing = db.execute("SELECT * FROM trades WHERE id=?", (trade_id,)).fetchone()
        db.execute("INSERT INTO events VALUES (?,?,?,?)", (event["id"], trade_id, payload, time.time()))
        # A final exit is immutable. Late checkpoints and competing closes remain in the audit log.
        if existing and (existing["closed"] or (not closed and event_at < existing["event_at"])):
            return {"ok": True, "tradeId": trade_id, "eventId": event["id"], "result": "FINAL_RESULT_PRESERVED"}
        merged = {**(json.loads(existing["payload"]) if existing else {}), **trade}
        merged["status"] = "CLOSED" if closed else "OPEN"
        db.execute("""INSERT INTO trades VALUES (?,?,?,1,?,?)
            ON CONFLICT(id) DO UPDATE SET payload=excluded.payload,closed=excluded.closed,
            version=trades.version+1,event_at=excluded.event_at,updated_at=excluded.updated_at""",
            (trade_id, encoded(merged), int(closed), event_at, time.time()))
        if imported and not existing:
            db.execute("INSERT OR REPLACE INTO exports VALUES ('trade',?,1)", (trade_id,))
        return {"ok": True, "eventId": event["id"], "tradeId": trade_id}

    def setup(self, setup):
        identifier(setup.get("id"))
        if not setup.get("sessionDate") or setup.get("side") not in ("CE", "PE"):
            raise ValueError("INVALID_SETUP")
        event_at = timestamp(setup.get("updatedAt") or setup.get("firstSeenAt"))
        payload = encoded(setup)
        with self.transaction() as db:
            db.execute("""INSERT INTO setups VALUES (?,?,1,?)
                ON CONFLICT(id) DO UPDATE SET payload=excluded.payload,
                version=setups.version+1,event_at=excluded.event_at
                WHERE excluded.event_at>=setups.event_at AND excluded.payload!=setups.payload""",
                (setup["id"], payload, event_at))
        return {"ok": True, "setupId": setup["id"]}

    def health(self):
        with self.connection() as db:
            counts = {name: db.execute("SELECT COUNT(*) FROM " + name).fetchone()[0] for name in ("trades", "events", "setups")}
            metadata = dict(db.execute("SELECT key,value FROM metadata"))
        return {"ok": True, "storage": "sqlite", **counts, "maintenance": metadata}

    def list_trades(self, limit=500):
        with self.connection() as db:
            rows = db.execute("SELECT payload FROM trades WHERE closed=1 ORDER BY event_at DESC,id LIMIT ?", (max(1, min(1000, int(limit))),))
            return {"ok": True, "trades": [json.loads(row[0]) for row in rows]}

    def import_trades(self, trades):
        if not isinstance(trades, list) or len(trades) > 1000:
            raise ValueError("INVALID_IMPORT")
        with self.transaction() as db:
            for trade in trades:
                self.event({"id": "sheet-import:" + identifier(trade.get("id")), "type": "TRADE_CLOSED",
                    "trade": trade, "queuedAt": trade.get("closedAt"), "source": "sheets_migration"}, db, imported=True)
            db.execute("INSERT OR REPLACE INTO metadata VALUES ('sheets_imported_at',?)", (datetime.now(timezone.utc).isoformat(),))
        return {"ok": True, "imported": len(trades)}

    def pending_exports(self, limit=50):
        result = []
        with self.connection() as db:
            for kind, table in (("trade", "trades"), ("setup", "setups")):
                rows = db.execute(f"""SELECT t.* FROM {table} t LEFT JOIN exports e ON e.id=t.id AND e.kind=?
                    WHERE e.version IS NULL OR e.version<t.version ORDER BY t.event_at,t.id LIMIT ?""", (kind, limit))
                for row in rows:
                    value = json.loads(row["payload"])
                    if kind == "trade":
                        event = {"id": f"sqlite:{row['id']}:{row['version']}", "type": "TRADE_CLOSED" if row["closed"] else "POSITION_CHECKPOINT",
                            "trade": value, "queuedAt": datetime.fromtimestamp(row["event_at"], timezone.utc).isoformat(), "source": "sqlite_daily_export"}
                        payload = {"action": "journal_event", "event": event}
                    else:
                        payload = {"action": "setup_decision", "setup": value}
                    result.append({"kind": kind, "id": row["id"], "version": row["version"], "payload": payload})
        return result

    def acknowledge_export(self, job):
        if job.get("kind") not in ("trade", "setup") or not isinstance(job.get("version"), int):
            raise ValueError("INVALID_EXPORT_ACK")
        with self.transaction() as db:
            db.execute("""INSERT INTO exports VALUES (?,?,?) ON CONFLICT(kind,id)
                DO UPDATE SET version=MAX(exports.version,excluded.version)""", (job["kind"], identifier(job.get("id")), job["version"]))

    def mark(self, key, value):
        with self.transaction() as db:
            db.execute("INSERT OR REPLACE INTO metadata VALUES (?,?)", (key, str(value)))

    def backup(self, directory, retain=30):
        directory = Path(directory)
        directory.mkdir(parents=True, exist_ok=True, mode=0o700)
        name = datetime.now(ZoneInfo("Asia/Kolkata")).strftime("journal-%Y-%m-%d.sqlite3")
        destination = directory / name
        temporary = directory / (name + "." + uuid.uuid4().hex + ".tmp")
        with self.connection() as source:
            target = sqlite3.connect(temporary)
            try:
                source.backup(target)
                if target.execute("PRAGMA integrity_check").fetchone()[0] != "ok":
                    raise RuntimeError("BACKUP_INTEGRITY_FAILED")
            finally:
                target.close()
        os.chmod(temporary, 0o600)
        with temporary.open("rb") as stream:
            os.fsync(stream.fileno())
        temporary.rename(destination)
        descriptor = os.open(directory, os.O_RDONLY)
        try:
            os.fsync(descriptor)
        finally:
            os.close(descriptor)
        digest = hashlib.sha256(destination.read_bytes()).hexdigest()
        self.mark("last_backup", name)
        self.mark("last_backup_sha256", digest)
        for old in sorted(directory.glob("journal-*.sqlite3"), reverse=True)[retain:]:
            old.unlink()
        return {"ok": True, "file": str(destination), "sha256": digest}
