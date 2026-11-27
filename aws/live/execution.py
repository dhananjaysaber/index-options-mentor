"""Persisted preparation and recovery for a future authenticated application host.

No HTTP listener, credentials, scheduler or enabled production configuration is
created here. Strategy signals must come from the existing server strategy engine.
"""
import json
import uuid
from orders import TERMINAL, encoded
from planner import decimal


class Execution:
    def __init__(self, orders, planner):
        self.orders,self.planner = orders,planner
        with orders.transaction() as db:
            db.execute('''CREATE TABLE IF NOT EXISTS live_plans (
                id TEXT PRIMARY KEY, request TEXT NOT NULL, plan TEXT NOT NULL, expires REAL NOT NULL
            )''')

    def owner(self):
        if self.orders.broker.account_id() != self.orders.account_id:
            raise ValueError('ACCOUNT_MISMATCH')

    def prepare(self, intent_id, symbol, amount, strategy='CORE'):
        if str(uuid.UUID(intent_id)) != intent_id: raise ValueError('INVALID_INTENT_ID')
        self.owner()
        if strategy not in ('CORE','SCALP'): raise ValueError('INVALID_STRATEGY')
        request = encoded({'symbol':symbol,'amount':str(decimal(amount).normalize()),'strategy':strategy})
        with self.orders.transaction() as db:
            existing = db.execute('SELECT * FROM live_plans WHERE id=?',(intent_id,)).fetchone()
        if existing:
            if existing['request'] != request: raise ValueError('INTENT_REUSED_WITH_DIFFERENT_ORDER')
            return json.loads(existing['plan'])
        plan = self.planner.plan(symbol,amount,self.orders.broker.available_funds())
        expires = self.planner.clock()+15
        plan.update({'intentId':intent_id,'expiresAt':expires,'strategyFamily':strategy})
        with self.orders.transaction() as db:
            db.execute('INSERT OR IGNORE INTO live_plans VALUES (?,?,?,?)',(intent_id,request,encoded(plan),expires))
            # Concurrent prepares converge on the first durable plan.
            saved = db.execute('SELECT * FROM live_plans WHERE id=?',(intent_id,)).fetchone()
            if saved['request'] != request: raise ValueError('INTENT_REUSED_WITH_DIFFERENT_ORDER')
            return json.loads(saved['plan'])

    def submit(self, intent_id):
        self.owner()
        # A timed-out submission must remain retrievable after the plan expires.
        existing = self.orders.get(intent_id)
        if existing: return existing
        with self.orders.transaction() as db:
            row = db.execute('SELECT * FROM live_plans WHERE id=?',(intent_id,)).fetchone()
        if not row: raise ValueError('UNKNOWN_PLAN')
        if self.planner.clock() > row['expires']: raise ValueError('PLAN_EXPIRED')
        if self.planner.market_open() is not True: raise ValueError('ENTRY_SESSION_CLOSED')
        plan = json.loads(row['plan'])
        contract = self.planner.validate_contract(plan['payload']['symbol'])
        if plan['payload']['qty'] % contract['lot_size'] or plan['payload']['qty'] > contract['max_quantity']:
            raise ValueError('CONTRACT_CHANGED_REFRESH_PLAN')
        if self.planner.quote(plan['payload']['symbol']) > decimal(plan['buyPrice']):
            raise ValueError('PRICE_MOVED_REFRESH_PLAN')
        available = self.orders.broker.available_funds()
        self.planner.check_funds(available,plan['premiumCost'])
        return self.orders.submit(intent_id,plan['payload'],cash_available=available,fee_reserve=self.planner.fee_reserve)

    def exit(self, intent_id, entry_id, price, quantity):
        self.owner()
        prior = self.orders.get(intent_id)
        if prior:
            payload = json.loads(prior['payload'])
            if prior['parent_id'] != entry_id or payload['qty'] != quantity or decimal(payload['limitPrice']) != decimal(price):
                raise ValueError('INTENT_REUSED_WITH_DIFFERENT_ORDER')
            return prior
        entry = self.orders.reconcile(entry_id)
        if entry['parent_id'] or entry['state'] not in TERMINAL:
            raise ValueError('ENTRY_NOT_SETTLED')
        symbol = json.loads(entry['payload'])['symbol']
        # Detect outside/manual changes to aggregate broker exposure before any sell.
        # Also reconcile older exits before calculating our remaining exposure.
        with self.orders.transaction() as db:
            children = [r['id'] for r in db.execute('SELECT id FROM live_intents WHERE parent_id=?',(entry_id,))]
        for child in children: self.orders.reconcile(child)
        self.check_holding(symbol)
        # Exit price must be a valid tick. There is no market-order fallback.
        contract = self.planner.validate_contract(symbol)
        if type(quantity) is not int or quantity <= 0 or quantity % contract['lot_size']:
            raise ValueError('EXIT_QUANTITY_NOT_WHOLE_LOTS')
        tick = decimal(contract.get('tick_size'))
        if tick <= 0 or decimal(price) <= 0 or decimal(price)%tick:
            raise ValueError('INVALID_EXIT_PRICE')
        return self.orders.submit_exit(intent_id,entry_id,price,quantity)

    def ledger(self, symbol):
        """This app's orders for one option, and the quantity it still owns."""
        with self.orders.transaction() as db:
            rows = [dict(r) for r in db.execute('SELECT * FROM live_intents')
                    if json.loads(r['payload'])['symbol'] == symbol]
            gone = {r['entry_id']:r['quantity'] for r in db.execute('SELECT * FROM live_external_closes')}
        owned = sum((1 if not r['parent_id'] else -1)*r['filled_qty'] for r in rows)
        return rows, owned-sum(gone.get(r['id'],0) for r in rows), gone

    def orderbook_view(self, symbol, entry_id=None):
        """Compare today's FYERS orderbook with the ledger.

        `complete` is false unless every fill of each relevant app trade is shown,
        so an empty, partial or late orderbook is never read as an outside sale.
        """
        book = self.orders.broker.orders_for_symbol(symbol)
        rows, owned, gone = self.ledger(symbol)
        shown = {r.get('orderTag'):r for r in book if r.get('orderTag')}
        trades = {}
        for row in rows: trades.setdefault(row['parent_id'] or row['id'], []).append(row)
        complete = True
        for key, orders in trades.items():
            held = sum((1 if not r['parent_id'] else -1)*r['filled_qty'] for r in orders)-gone.get(key,0)
            if key == entry_id or held or any('1:'+r['tag'] in shown for r in orders):
                for r in orders:
                    seen = shown.get('1:'+r['tag'])
                    if r['filled_qty'] != (seen['filledQty'] if seen else 0): complete = False
        return {'complete':complete,'total':sum(r['side']*r['filledQty'] for r in book),'owned':owned,'book':book}

    def check_holding(self, symbol):
        """FYERS must hold exactly what this ledger says it owns."""
        view = self.orderbook_view(symbol)
        if (self.orders.broker.net_quantity(symbol) != view['owned'] or
                not view['complete'] or view['total'] < view['owned']):
            raise ValueError('BROKER_POSITION_MISMATCH')

    def recover(self, journal):
        results = self.orders.recover()
        self.orders.drain_journal(journal)
        return results
