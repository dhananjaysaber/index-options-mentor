"""Trades sold outside the app: by the owner in FYERS, or by FYERS itself.

Owner decision 27 Nov 2026: confirm the position is closed, then cancel only the
app's own leftover stop and send no new sale. Anything unclear stays locked.
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
            state['matched_since'] = None; self._save(state); raise ValueError(UNCLEAR)
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
