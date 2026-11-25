"""Durable owned-order coordinator. Not installed or enabled by this module."""
import hashlib
import json
import math
import re
import sqlite3
import uuid
from contextlib import contextmanager
from datetime import datetime, timezone
from decimal import Decimal

TERMINAL = {'FILLED', 'CANCELLED', 'REJECTED', 'EXPIRED', 'BLOCKED'}


def encoded(value):
    return json.dumps(value, sort_keys=True, separators=(',', ':'), allow_nan=False)


def stamp():
    return datetime.now(timezone.utc).isoformat()


class Orders:
    def __init__(self, file, broker, account_id, max_quantity=0, enabled=False):
        if not isinstance(account_id, str) or not account_id:
            raise ValueError('OWNER_REQUIRED')
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
                CREATE TABLE IF NOT EXISTS live_meta (key TEXT PRIMARY KEY,value TEXT NOT NULL);
                CREATE TABLE IF NOT EXISTS live_audit (
                    seq INTEGER PRIMARY KEY, intent_id TEXT NOT NULL,
                    observed_at TEXT NOT NULL, payload TEXT NOT NULL
                );
                CREATE TABLE IF NOT EXISTS live_journal_outbox (
                    id TEXT PRIMARY KEY, payload TEXT NOT NULL, delivered INTEGER NOT NULL DEFAULT 0
                );
            ''')
        with self.transaction() as db:
            columns = {r['name'] for r in db.execute('PRAGMA table_info(live_intents)')}
            for name, declaration in [('parent_id','TEXT'), ('created_at',"TEXT NOT NULL DEFAULT ''"), ('reserved_cash','REAL NOT NULL DEFAULT 0')]:
                if name not in columns:
                    db.execute(f'ALTER TABLE live_intents ADD COLUMN {name} {declaration}')
            db.execute("INSERT OR IGNORE INTO live_meta VALUES ('owner',?)", (account_id,))
            if db.execute("SELECT value FROM live_meta WHERE key='owner'").fetchone()[0] != account_id:
                raise ValueError('LEDGER_OWNER_MISMATCH')

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
        # Blocks new entries, not protective exits of our own confirmed fills.
        with self.transaction() as db:
            db.execute('UPDATE live_controls SET stopped=1 WHERE id=1')

    def get(self, intent_id):
        with self.transaction() as db:
            row = db.execute('SELECT * FROM live_intents WHERE id=?', (intent_id,)).fetchone()
        return dict(row) if row else None

    def submit(self, intent_id, payload, cash_available=None, fee_reserve=0):
        return self._submit(intent_id, payload, cash_available=cash_available, fee_reserve=fee_reserve)

    def submit_exit(self, intent_id, entry_id, price, quantity):
        entry = self.get(entry_id)
        if not entry or entry['parent_id']:
            raise ValueError('UNKNOWN_ENTRY')
        payload = json.loads(entry['payload'])
        return self._submit(intent_id, {**payload, 'side': -1, 'qty': quantity, 'limitPrice': price}, entry_id)

    def submit_protection(self, intent_id, entry_id, stop_price, limit_price, quantity):
        entry=self.get(entry_id)
        if not entry or entry['parent_id']: raise ValueError('UNKNOWN_ENTRY')
        payload=json.loads(entry['payload'])
        return self._submit(intent_id,{**payload,'side':-1,'type':4,'stopPrice':stop_price,
                            'limitPrice':limit_price,'qty':quantity},entry_id,protection=True)

    def _submit(self, intent_id, payload, parent_id=None, cash_available=None, fee_reserve=0, protection=False):
        if str(uuid.UUID(intent_id)) != intent_id:
            raise ValueError('INVALID_INTENT_ID')
        quantity, price = payload.get('qty'), payload.get('limitPrice')
        allowed = {'symbol','qty','side','type','productType','limitPrice','validity','offlineOrder',
                   'stopPrice','disclosedQty','isSliceOrder'}
        if (set(payload) - allowed or
                not re.fullmatch(r'NSE:NIFTY[A-Z0-9]+(?:CE|PE)', str(payload.get('symbol',''))) or
                type(payload.get('side')) is not int or payload.get('side') != (-1 if parent_id else 1) or
                type(payload.get('type')) is not int or payload.get('type') != (4 if protection else 1) or payload.get('productType') != 'INTRADAY' or
                payload.get('validity') != 'DAY' or payload.get('offlineOrder') is not False or
                (not protection and payload.get('stopPrice', 0) != 0) or payload.get('disclosedQty', 0) != 0 or
                payload.get('isSliceOrder', False) is not False or
                type(quantity) is not int or quantity < 1 or
                isinstance(price, bool) or not isinstance(price, (int,float)) or
                not math.isfinite(price) or price <= 0):
            raise ValueError('INVALID_ENTRY_ORDER' if not parent_id else 'INVALID_EXIT_ORDER')
        if protection and (not parent_id or isinstance(payload.get('stopPrice'),bool) or not isinstance(payload.get('stopPrice'),(int,float)) or not math.isfinite(payload['stopPrice']) or payload['stopPrice'] <= price):
            raise ValueError('INVALID_PROTECTIVE_STOP')
        if getattr(self.broker,'send_enabled',True) is not True:
            raise ValueError('FYERS_SEND_DISABLED')
        body = encoded(payload)
        fingerprint = hashlib.sha256(encoded([payload,parent_id]).encode()).hexdigest()
        tag = 'IOM' + hashlib.sha256(intent_id.encode()).hexdigest()[:27]
        with self.transaction() as db:
            existing = db.execute('SELECT * FROM live_intents WHERE id=?', (intent_id,)).fetchone()
            if existing:
                # Also accept pre-upgrade fingerprints without changing old reservations.
                legacy = hashlib.sha256(body.encode()).hexdigest() if not parent_id else ''
                if existing['fingerprint'] not in (fingerprint, legacy) or existing['parent_id'] != parent_id:
                    raise ValueError('INTENT_REUSED_WITH_DIFFERENT_ORDER')
                return dict(existing)
            if self.enabled is not True or type(self.max_quantity) is not int or quantity > self.max_quantity:
                raise ValueError('LIVE_EXECUTION_DISABLED_OR_LIMIT_UNSET')
            if parent_id:
                entry = db.execute('SELECT * FROM live_intents WHERE id=?', (parent_id,)).fetchone()
                if (not entry or entry['parent_id'] or entry['state'] not in TERMINAL or
                        json.loads(entry['payload'])['symbol'] != payload['symbol']):
                    raise ValueError('ENTRY_NOT_SETTLED')
                reserved = 0
                for exit_order in db.execute('SELECT * FROM live_intents WHERE parent_id=?', (parent_id,)):
                    reserved += exit_order['filled_qty'] if exit_order['state'] in TERMINAL else json.loads(exit_order['payload'])['qty']
                if quantity > entry['filled_qty'] - reserved:
                    raise ValueError('EXIT_EXCEEDS_OWNED_QUANTITY')
            elif db.execute('SELECT stopped FROM live_controls WHERE id=1').fetchone()[0]:
                raise ValueError('NEW_ORDERS_STOPPED')
            reserve = Decimal('0')
            if not parent_id and cash_available is not None:
                available, fee = Decimal(str(cash_available)), Decimal(str(fee_reserve))
                if not available.is_finite() or not fee.is_finite() or min(available,fee) < 0:
                    raise ValueError('INVALID_FUNDS')
                reserve = Decimal(str(price))*quantity+fee
                pending = sum((max(Decimal(str(r['reserved_cash'])),Decimal(str(json.loads(r['payload'])['limitPrice']))*json.loads(r['payload'])['qty']) for r in db.execute(
                    'SELECT reserved_cash,payload FROM live_intents WHERE parent_id IS NULL AND state NOT IN (?,?,?,?,?)',tuple(TERMINAL))),Decimal('0'))
                if pending+reserve > available:
                    raise ValueError('FUNDS_RESERVED_FOR_UNRESOLVED_ORDERS')
            db.execute('''INSERT INTO live_intents(id,fingerprint,tag,payload,state,parent_id,created_at,reserved_cash)
                          VALUES (?,?,?,?,?,?,?,?)''', (intent_id,fingerprint,tag,body,'SUBMITTING',parent_id,stamp(),float(reserve)))
            self._audit(db,intent_id)
        try:
            if self.broker.account_id() != self.account_id:
                self._update(intent_id, 'BLOCKED', detail='ACCOUNT_MISMATCH')
                return self.get(intent_id)
            with self.transaction() as db:
                if not parent_id and db.execute('SELECT stopped FROM live_controls WHERE id=1').fetchone()[0]:
                    db.execute("UPDATE live_intents SET state='BLOCKED',detail='NEW_ORDERS_STOPPED' WHERE id=?", (intent_id,))
                    self._audit(db,intent_id)
                    return dict(db.execute('SELECT * FROM live_intents WHERE id=?', (intent_id,)).fetchone())
            result = self.broker.place_order({**payload, 'orderTag': tag})
            if result.get('s') == 'ok' and isinstance(result.get('id'), str) and result['id']:
                self._update(intent_id, 'ACKNOWLEDGED', broker_id=result['id'])
            else:
                self._update(intent_id, 'UNKNOWN', detail='RECONCILE_WITH_BROKER')
        except Exception:
            self._update(intent_id, 'UNKNOWN', detail='RECONCILE_WITH_BROKER')
        return self.get(intent_id)

    @staticmethod
    def _audit(db, intent_id):
        row = dict(db.execute('SELECT * FROM live_intents WHERE id=?',(intent_id,)).fetchone())
        db.execute('INSERT INTO live_audit(intent_id,observed_at,payload) VALUES (?,?,?)', (intent_id,stamp(),encoded(row)))

    def _update(self, intent_id, state, broker_id=None, detail=''):
        with self.transaction() as db:
            db.execute('UPDATE live_intents SET state=?,broker_id=COALESCE(?,broker_id),detail=? WHERE id=?',
                       (state, broker_id, detail, intent_id))
            self._audit(db,intent_id)

    def reconcile(self, intent_id):
        current = self.get(intent_id)
        if not current:
            raise ValueError('UNKNOWN_INTENT')
        if self.broker.account_id() != self.account_id:
            raise ValueError('ACCOUNT_MISMATCH')
        matches = self.broker.orders_by_tag('1:' + current['tag'])
        if len(matches) != 1:
            return current
        order, expected = matches[0], json.loads(current['payload'])
        if any(order.get(key) != expected[key] for key in ('symbol', 'qty', 'side')):
            raise ValueError('BROKER_ORDER_MISMATCH')
        if (order.get('orderTag') != '1:' + current['tag'] or not isinstance(order.get('id'),str) or
                not order['id'] or (current['broker_id'] and current['broker_id'] != order['id'])):
            raise ValueError('BROKER_ORDER_MISMATCH')
        if order.get('clientId',self.account_id) != self.account_id:
            raise ValueError('ACCOUNT_MISMATCH')
        if expected['type']==4 and (order.get('type')!=4 or order.get('productType')!='INTRADAY'):
            raise ValueError('BROKER_PROTECTION_MISMATCH')
        filled, remaining, price = order.get('filledQty'), order.get('remainingQuantity'), order.get('tradedPrice')
        if type(filled) is not int or type(remaining) is not int or min(filled,remaining) < 0 or filled+remaining != expected['qty']:
            raise ValueError('INVALID_BROKER_FILL')
        if filled and (isinstance(price,bool) or not isinstance(price,(int,float)) or not math.isfinite(price) or price <= 0):
            raise ValueError('INVALID_BROKER_FILL')
        status = order.get('status')
        if status == 2 and filled != expected['qty']:
            raise ValueError('INVALID_FILLED_STATUS')
        if type(status) is not int or status not in (1,2,4,5,6,7):
            raise ValueError('UNKNOWN_BROKER_STATUS')
        state = {1:'CANCELLED',2:'FILLED',4:'TRANSIT',5:'REJECTED',6:'PENDING',7:'EXPIRED'}[status]
        if filled and status in (4,6): state = 'PARTIALLY_FILLED'
        with self.transaction() as db:
            latest = db.execute('SELECT * FROM live_intents WHERE id=?', (intent_id,)).fetchone()
            if filled < latest['filled_qty'] or latest['state'] in TERMINAL:
                return dict(latest)
            db.execute('UPDATE live_intents SET state=?,broker_id=?,filled_qty=?,average_price=? WHERE id=?',
                       (state,order['id'],filled,price if filled else None,intent_id))
            self._audit(db,intent_id)
            self._queue_close(db,current['parent_id'] or intent_id)
        return self.get(intent_id)

    def _queue_close(self, db, entry_id):
        entry = db.execute('SELECT * FROM live_intents WHERE id=?',(entry_id,)).fetchone()
        exits = list(db.execute('SELECT * FROM live_intents WHERE parent_id=?',(entry_id,)))
        qty = entry['filled_qty']
        if entry['state'] not in TERMINAL or not qty or sum(r['filled_qty'] for r in exits) != qty:
            return
        now = stamp()
        value = sum(r['filled_qty']*(r['average_price'] or 0) for r in exits)
        plan = {}
        if db.execute("SELECT 1 FROM sqlite_master WHERE type='table' AND name='live_plans'").fetchone():
            saved = db.execute('SELECT plan FROM live_plans WHERE id=?',(entry_id,)).fetchone()
            if saved: plan = json.loads(saved['plan'])
        symbol = json.loads(entry['payload'])['symbol']
        trade = {'strategyFamily':plan.get('strategyFamily','CORE'),'lotSize':plan.get('lotSize'),
                 'lots':qty/plan['lotSize'] if plan.get('lotSize') else None,
                 'side':symbol[-2:],'id':entry_id,'mode':'LIVE','executionMode':'REAL','status':'CLOSED',
                 'symbol':json.loads(entry['payload'])['symbol'],'quantity':qty,
                 'entry':entry['average_price'],'exit':value/qty,
                 'pnl':value-entry['average_price']*qty,'grossPnl':value-entry['average_price']*qty,
                 'openedAt':entry['created_at'],'closedAt':now,'closedBy':'AWS',
                 'exitReason':'BROKER_CONFIRMED_EXIT','brokerOrderPlaced':True,
                 'entryOrderId':entry['broker_id'], 'exitOrderIds':[r['broker_id'] for r in exits if r['filled_qty']]}
        if db.execute("SELECT 1 FROM sqlite_master WHERE type='table' AND name='live_managed_positions'").fetchone():
            managed=db.execute('SELECT exit_reason FROM live_managed_positions WHERE id=?',(entry_id,)).fetchone()
            if managed and managed['exit_reason']: trade['exitReason']=managed['exit_reason']
            elif any(json.loads(r['payload'])['type']==4 and r['filled_qty'] for r in exits): trade['exitReason']='BROKER_PROTECTIVE_STOP'
        event = {'id':entry_id+':BROKER_CLOSED','type':'TRADE_CLOSED','queuedAt':now,'trade':trade}
        db.execute('INSERT OR IGNORE INTO live_journal_outbox(id,payload) VALUES (?,?)',(event['id'],encoded(event)))

    def recover(self):
        with self.transaction() as db:
            ids = [r['id'] for r in db.execute('SELECT id FROM live_intents WHERE state NOT IN (?,?,?,?,?)', tuple(TERMINAL))]
        return [self.reconcile(i) for i in ids]

    def drain_journal(self, journal):
        with self.transaction() as db:
            events = list(db.execute('SELECT id,payload FROM live_journal_outbox WHERE delivered=0 ORDER BY id'))
        for event in events:
            result = journal.event(json.loads(event['payload']))
            if result.get('ok') is not True:
                raise ValueError('JOURNAL_NOT_ACKNOWLEDGED')
            with self.transaction() as db:
                db.execute('UPDATE live_journal_outbox SET delivered=1 WHERE id=?',(event['id'],))
        return len(events)
