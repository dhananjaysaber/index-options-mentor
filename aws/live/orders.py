"""Durable order-intent coordinator. No HTTP routes or live credentials are enabled here."""
import hashlib
import json
import math
import sqlite3
import uuid
from contextlib import contextmanager


class Orders:
    def __init__(self, file, broker, account_id, max_quantity=0, enabled=False):
        self.file, self.broker, self.account_id = file, broker, account_id
        self.max_quantity, self.enabled = max_quantity, enabled
        with self.transaction() as db:
            db.executescript('''
                CREATE TABLE IF NOT EXISTS live_intents (
                    id TEXT PRIMARY KEY, fingerprint TEXT NOT NULL,
                    tag TEXT UNIQUE NOT NULL, payload TEXT NOT NULL,
                    state TEXT NOT NULL, broker_id TEXT, filled_qty INTEGER DEFAULT 0,
                    average_price REAL, detail TEXT NOT NULL DEFAULT ''
                );
                CREATE TABLE IF NOT EXISTS live_controls (
                    id INTEGER PRIMARY KEY CHECK(id=1), stopped INTEGER NOT NULL
                );
                INSERT OR IGNORE INTO live_controls VALUES (1,0);
            ''')

    @contextmanager
    def transaction(self):
        db = sqlite3.connect(self.file, timeout=15, isolation_level=None)
        db.row_factory = sqlite3.Row
        db.execute('PRAGMA synchronous=FULL')
        db.execute('BEGIN IMMEDIATE')
        try:
            yield db
            db.commit()
        except Exception:
            db.rollback()
            raise
        finally:
            db.close()

    def stop(self):
        with self.transaction() as db:
            db.execute('UPDATE live_controls SET stopped=1 WHERE id=1')

    def get(self, intent_id):
        with self.transaction() as db:
            row = db.execute('SELECT * FROM live_intents WHERE id=?', (intent_id,)).fetchone()
        return dict(row) if row else None

    def submit(self, intent_id, payload):
        # Only a server-generated, validated NIFTY limit-order payload is supported.
        # Contract, lot size, available funds and quote checks belong to the caller.
        if str(uuid.UUID(intent_id)) != intent_id:
            raise ValueError('INVALID_INTENT_ID')
        symbol = payload.get('symbol', '')
        quantity = payload.get('qty')
        price = payload.get('limitPrice')
        if (not isinstance(symbol, str) or not symbol.startswith('NSE:NIFTY') or
                not symbol.endswith(('CE', 'PE')) or payload.get('side') != 1 or
                payload.get('type') != 1 or payload.get('productType') != 'INTRADAY' or
                payload.get('validity') != 'DAY' or payload.get('offlineOrder') is not False or
                type(quantity) is not int or quantity < 1 or
                isinstance(price, bool) or not isinstance(price, (int, float)) or
                not math.isfinite(price) or price <= 0):
            raise ValueError('INVALID_ENTRY_ORDER')
        body = json.dumps(payload, sort_keys=True, separators=(',', ':'), allow_nan=False)
        fingerprint = hashlib.sha256(body.encode()).hexdigest()
        tag = 'IOM' + hashlib.sha256(intent_id.encode()).hexdigest()[:27]
        with self.transaction() as db:
            existing = db.execute('SELECT * FROM live_intents WHERE id=?', (intent_id,)).fetchone()
            if existing:
                if existing['fingerprint'] != fingerprint:
                    raise ValueError('INTENT_REUSED_WITH_DIFFERENT_ORDER')
                return dict(existing)
            if not self.enabled or quantity > self.max_quantity:
                raise ValueError('LIVE_EXECUTION_DISABLED_OR_LIMIT_UNSET')
            if db.execute('SELECT stopped FROM live_controls WHERE id=1').fetchone()[0]:
                raise ValueError('NEW_ORDERS_STOPPED')
            # Commit the reservation before any network request. A crash leaves it unresolved.
            db.execute('INSERT INTO live_intents(id,fingerprint,tag,payload,state) VALUES (?,?,?,?,?)',
                       (intent_id, fingerprint, tag, body, 'SUBMITTING'))
        try:
            if self.broker.account_id() != self.account_id:
                self._update(intent_id, 'BLOCKED', detail='ACCOUNT_MISMATCH')
                return self.get(intent_id)
            # Recheck the persistent stop after the profile call and before submission.
            with self.transaction() as db:
                if db.execute('SELECT stopped FROM live_controls WHERE id=1').fetchone()[0]:
                    db.execute("UPDATE live_intents SET state='BLOCKED',detail='NEW_ORDERS_STOPPED' WHERE id=?", (intent_id,))
                    return dict(db.execute('SELECT * FROM live_intents WHERE id=?', (intent_id,)).fetchone())
            result = self.broker.place_order({**payload, 'orderTag': tag})
            if result.get('s') == 'ok' and isinstance(result.get('id'), str) and result['id']:
                self._update(intent_id, 'ACKNOWLEDGED', broker_id=result['id'])
            else:
                self._update(intent_id, 'UNKNOWN', detail='RECONCILE_WITH_BROKER')
        except Exception:
            self._update(intent_id, 'UNKNOWN', detail='RECONCILE_WITH_BROKER')
        return self.get(intent_id)

    def _update(self, intent_id, state, broker_id=None, detail=''):
        with self.transaction() as db:
            db.execute('UPDATE live_intents SET state=?,broker_id=COALESCE(?,broker_id),detail=? WHERE id=?',
                       (state, broker_id, detail, intent_id))

    def reconcile(self, intent_id):
        current = self.get(intent_id)
        if not current:
            raise ValueError('UNKNOWN_INTENT')
        if self.broker.account_id() != self.account_id:
            raise ValueError('ACCOUNT_MISMATCH')
        matches = self.broker.orders_by_tag('1:' + current['tag'])
        if len(matches) != 1:
            return current  # An empty order book cannot prove an order was never submitted.
        order = matches[0]
        expected = json.loads(current['payload'])
        if any(order.get(key) != expected[key] for key in ('symbol', 'qty', 'side')):
            raise ValueError('BROKER_ORDER_MISMATCH')
        if order.get('orderTag') != '1:' + current['tag'] or not order.get('id'):
            raise ValueError('BROKER_ORDER_MISMATCH')
        if current['broker_id'] and current['broker_id'] != order['id']:
            raise ValueError('BROKER_ORDER_MISMATCH')
        filled = order.get('filledQty')
        remaining = order.get('remainingQuantity')
        if type(filled) is not int or type(remaining) is not int or min(filled, remaining) < 0 or filled + remaining != expected['qty']:
            raise ValueError('INVALID_BROKER_FILL')
        price = order.get('tradedPrice')
        if filled and (isinstance(price, bool) or not isinstance(price, (int,float)) or not math.isfinite(price) or price <= 0):
            raise ValueError('INVALID_BROKER_FILL')
        status = order.get('status')
        if status == 2 and filled != expected['qty']:
            raise ValueError('INVALID_FILLED_STATUS')
        if status not in (1,2,4,5,6,7):
            raise ValueError('UNKNOWN_BROKER_STATUS')
        state = {1:'CANCELLED',2:'FILLED',4:'TRANSIT',5:'REJECTED',6:'PENDING',7:'EXPIRED'}[status]
        if filled and status in (4,6):
            state = 'PARTIALLY_FILLED'
        with self.transaction() as db:
            latest = db.execute('SELECT * FROM live_intents WHERE id=?', (intent_id,)).fetchone()
            if filled < latest['filled_qty'] or latest['state'] == 'FILLED':
                return dict(latest)
            db.execute('UPDATE live_intents SET state=?,broker_id=?,filled_qty=?,average_price=? WHERE id=?',
                       (state, order['id'], filled, price if filled else None, intent_id))
        return self.get(intent_id)
