"""Trades sold outside the app: by the owner in FYERS, or by FYERS itself.

Owner decision 27 Nov 2026: confirm the position is closed, then cancel only the
app's own leftover stop and send no new sale. Anything unclear stays locked.

Owner decision 27 Nov 2026 (part sale): when part of a trade is confirmed sold
outside the app, reduce the app's stop to the quantity still held, at the same
prices. Once that smaller stop is confirmed and everything still agrees, the app
manages what is left again, including trailing and end-of-day selling. Until
then the trade stays locked with a warning.
"""
import json
from orders import TERMINAL

# Two matching confirmations this far apart are needed before anything changes.
CONFIRM_SECONDS = 5
# FYERS positions can lag a fill. A lower holding must last this long to lock.
POSITIONS_LOW_SECONDS = 15
CHECK_EVERY = 5
UNCLEAR = 'CLOSED_OUTSIDE_APP_UNCLEAR_CHECK_BROKER'


class OutsideWatch:
    def __init__(self, execution, protection):
        self.execution, self.protection, self.orders = execution, protection, execution.orders
        with self.orders.transaction() as db:
            db.execute('''CREATE TABLE IF NOT EXISTS live_outside_watch (
                id TEXT PRIMARY KEY, sale_seen INTEGER NOT NULL DEFAULT 0, matched_since REAL,
                tried_at REAL, low_since REAL, positions_at REAL)''')
            # held: quantity last seen left after a part sale. confirmed: seen twice.
            db.execute('''CREATE TABLE IF NOT EXISTS live_part_sales (
                id TEXT PRIMARY KEY, held INTEGER NOT NULL, since REAL NOT NULL, confirmed INTEGER NOT NULL)''')

    def _load(self, entry_id):
        with self.orders.transaction() as db:
            db.execute('INSERT OR IGNORE INTO live_outside_watch(id) VALUES (?)', (entry_id,))
            return dict(db.execute('SELECT * FROM live_outside_watch WHERE id=?', (entry_id,)).fetchone())

    def _save(self, state):
        with self.orders.transaction() as db:
            db.execute('UPDATE live_outside_watch SET sale_seen=?,matched_since=?,tried_at=?,low_since=?,positions_at=? WHERE id=?',
                       tuple(state[k] for k in ('sale_seen','matched_since','tried_at','low_since','positions_at','id')))

    def _symbol(self, entry_id):
        return json.loads(self.orders.get(entry_id)['payload'])['symbol']

    def guard_close(self, entry_id):
        """Before a normal close unlocks: FYERS must not show extra selling."""
        view = self.execution.orderbook_view(self._symbol(entry_id), entry_id)
        if view['complete'] and view['total'] >= view['owned']: return
        if view['complete']:
            state = self._load(entry_id); state['sale_seen'] = 1; self._save(state)
        raise ValueError(UNCLEAR)

    def check(self, entry_id, remaining):
        """None: carry on. True: confirmed and recorded. Raises while unclear."""
        symbol = self._symbol(entry_id); state = self._load(entry_id)
        now = self.execution.planner.clock()
        view = self.execution.orderbook_view(symbol, entry_id)
        if view['complete'] and view['total'] < view['owned']: state['sale_seen'] = 1
        if not remaining:
            return None  # A close by the app's own fills is guarded by guard_close.
        if not state['sale_seen']:
            if state['positions_at'] is None or now-state['positions_at'] >= CHECK_EVERY:
                state['positions_at'] = now
                low = self.orders.broker.net_quantity(symbol) < view['owned']
                state['low_since'] = (state['low_since'] if state['low_since'] is not None else now) if low else None
            self._save(state)
            if state['low_since'] is not None and now-state['low_since'] >= POSITIONS_LOW_SECONDS:
                raise ValueError(UNCLEAR)
            return None
        self._save(state)
        if state['tried_at'] is not None and now-state['tried_at'] < CHECK_EVERY: raise ValueError(UNCLEAR)
        state['tried_at'] = now
        if not self._closed_at_broker(entry_id, symbol):
            state['matched_since'] = None; self._save(state)
            self._part_sale(entry_id, symbol, remaining, now)
            raise ValueError(UNCLEAR)
        if state['matched_since'] is None: state['matched_since'] = now
        self._save(state)
        if now-state['matched_since'] < CONFIRM_SECONDS: raise ValueError(UNCLEAR)
        for stop in self._own_stops(entry_id):
            if stop['state'] not in TERMINAL: self.protection.cancel(stop['id'])
        # Confirm again afterwards: the stop is inactive, unfilled, and still flat.
        if (any(s['state'] not in TERMINAL for s in self._own_stops(entry_id)) or
                not self._closed_at_broker(entry_id, symbol)):
            raise ValueError(UNCLEAR)
        self.orders.record_external_close(entry_id, remaining)
        return True

    def _part_sale(self, entry_id, symbol, remaining, now):
        """Shrink the app's stop once the same part holding is confirmed twice."""
        found = self._part_held(entry_id, symbol, remaining)
        with self.orders.transaction() as db:
            prior = db.execute('SELECT * FROM live_part_sales WHERE id=?', (entry_id,)).fetchone()
        if not found:
            # Restart the wait. A part sale already confirmed stays on record.
            if prior and not prior['confirmed']:
                with self.orders.transaction() as db: db.execute('DELETE FROM live_part_sales WHERE id=?', (entry_id,))
            return
        held, stop_id = found
        if not prior or prior['held'] != held:
            with self.orders.transaction() as db:
                db.execute('INSERT OR REPLACE INTO live_part_sales VALUES (?,?,?,0)', (entry_id, held, now))
            return
        if now-prior['since'] < CONFIRM_SECONDS: return
        with self.orders.transaction() as db: db.execute('UPDATE live_part_sales SET confirmed=1 WHERE id=?', (entry_id,))
        # Any failure leaves the trade locked; the next check looks again first.
        try: self.protection.shrink(stop_id, held)
        except ValueError: return
        # Look again after the change. The caller still stops here this time, so
        # nothing carries on using figures read before the part sale.
        if self._part_held(entry_id, symbol, remaining) == found:
            self.orders.adopt_part_close(entry_id, remaining-held, held)

    def _part_held(self, entry_id, symbol, remaining):
        """(quantity held, own stop) only when everything agrees; otherwise None."""
        view = self.execution.orderbook_view(symbol, entry_id)
        held = view['total']
        # view['owned'] covers every app trade in this option: it must be only this one.
        if not view['complete'] or view['owned'] != remaining or not 0 < held < remaining: return None
        if held % self.execution.planner.validate_contract(symbol)['lot_size']: return None
        entry = self.orders.get(entry_id)
        if entry['state'] not in TERMINAL: return None
        if not any(r.get('orderTag') == '1:'+entry['tag'] for r in view['book']): return None
        positions = self.orders.broker.position_rows(symbol)
        if not positions or self.orders.broker.net_quantity(symbol) != held: return None
        # No unfinished app sale, and exactly one untouched stop of the app's own.
        children = self._children(entry_id)
        live = [r for r in children if r['state'] not in TERMINAL]
        if len(live) != 1 or json.loads(live[0]['payload'])['type'] != 4: return None
        stop = live[0]
        if stop['state'] != 'PENDING' or stop['filled_qty']: return None
        stop_tag = '1:'+stop['tag']
        if sum(r.get('orderTag') == stop_tag and r['status'] == 6 for r in view['book']) != 1: return None
        rows, _, _ = self.execution.ledger(symbol)
        app_tags = {'1:'+r['tag'] for r in rows}
        for row in view['book']:
            if row.get('orderTag') != stop_tag and row['status'] not in (1,2,5,7): return None
            # Something bought outside the app: the holding may not be this trade.
            if row['side'] == 1 and row['filledQty'] and row.get('orderTag') not in app_tags: return None
        return held, stop['id']

    def part_sales(self):
        """Confirmed part sales on trades that are still open, for the message."""
        with self.orders.transaction() as db:
            rows = [dict(r) for r in db.execute('''SELECT p.id,p.held,p.confirmed,m.stop_intent FROM live_part_sales p
                JOIN live_managed_positions m ON m.id=p.id WHERE p.confirmed>0 AND m.state!='CLOSED' ''')]
        result = []
        for row in rows:
            stop = self.orders.get(row['stop_intent'])
            size = json.loads(stop['payload'])['qty'] if stop else None
            result.append({'id':row['id'], 'symbol':self._symbol(row['id']), 'held':row['held'], 'stopQuantity':size,
                           'stopReduced':size == row['held'], 'managing':row['confirmed'] == 2})
        return result

    def _children(self, entry_id):
        with self.orders.transaction() as db:
            return [dict(r) for r in db.execute('SELECT * FROM live_intents WHERE parent_id=?', (entry_id,))]

    def _own_stops(self, entry_id):
        return [r for r in self._children(entry_id) if json.loads(r['payload'])['type'] == 4]

    def _closed_at_broker(self, entry_id, symbol):
        """Orderbook and positions both show nothing held and nothing else open."""
        view = self.execution.orderbook_view(symbol, entry_id)
        if not view['complete'] or view['total'] != 0: return False
        entry = self.orders.get(entry_id)
        if not any(r.get('orderTag') == '1:'+entry['tag'] for r in view['book']): return False
        positions = self.orders.broker.position_rows(symbol)
        if not positions or self.orders.broker.net_quantity(symbol) != 0: return False
        # An unfinished app sale could still sell, so it makes the result unclear.
        if any(r['state'] not in TERMINAL and json.loads(r['payload'])['type'] != 4
               for r in self._children(entry_id)): return False
        rows, _, _ = self.execution.ledger(symbol)
        own_stops = {'1:'+r['tag'] for r in rows if json.loads(r['payload'])['type'] == 4}
        return all(r['status'] in (1,2,5,7) or r.get('orderTag') in own_stops for r in view['book'])
