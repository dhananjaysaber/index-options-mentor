"""Shared PWA exits for confirmed owned fills; requires trusted server quotes."""
import json
import subprocess
import threading
import uuid
from pathlib import Path
from decimal import ROUND_FLOOR
from orders import TERMINAL,encoded
from planner import decimal
from protection import Protection

class Manager:
    def __init__(self,execution,journal,node='node'):
        self.execution,self.orders,self.journal=execution,execution.orders,journal
        self.node=node;self.lock=threading.RLock();self.protection=Protection(execution)
        with self.orders.transaction() as db:
            db.execute('''CREATE TABLE IF NOT EXISTS live_managed_positions (
                id TEXT PRIMARY KEY, payload TEXT NOT NULL, stop_intent TEXT NOT NULL,
                exit_intent TEXT, exit_reason TEXT, state TEXT NOT NULL)''')
    def get(self,entry_id):
        with self.orders.transaction() as db: row=db.execute('SELECT * FROM live_managed_positions WHERE id=?',(entry_id,)).fetchone()
        return dict(row) if row else None
    def track(self,entry_id,position,hard_option_stop):
        with self.lock:
            prior=self.get(entry_id)
            if prior: return prior
            entry=self.orders.reconcile(entry_id)
            if entry['state'] not in TERMINAL or not entry['filled_qty'] or entry['parent_id']: raise ValueError('ENTRY_NOT_SETTLED')
            payload=json.loads(entry['payload'])
            if position.get('symbol')!=payload['symbol'] or position.get('side') not in ('CE','PE'): raise ValueError('POSITION_MISMATCH')
            direction=1 if position['side']=='CE' else -1
            if direction*(decimal(position.get('underlyingEntry'))-decimal(position.get('underlyingStop')))<=0: raise ValueError('INVALID_STRUCTURAL_STOP')
            if position.get('strategyFamily') not in ('CORE','SCALP'): raise ValueError('INVALID_STRATEGY')
            position={**position,'id':entry_id,'entry':entry['average_price'],'currentPrice':entry['average_price'],
                      'bestOptionPrice':entry['average_price'],'worstOptionPrice':entry['average_price'],
                      'quantity':entry['filled_qty'],'openedAt':entry['created_at'],'currentR':0,'bestR':0,'worstR':0}
            tick=decimal(self.execution.planner.validate_contract(payload['symbol'])['tick_size']); stop=decimal(hard_option_stop)
            if stop>=decimal(entry['average_price']): raise ValueError('INVALID_INITIAL_PROTECTION')
            protection=self.protection.ensure(entry_id,float(stop),float(stop-tick),entry['filled_qty'])
            if protection['state']!='PROTECTION_CONFIRMED': raise ValueError('PROTECTION_NOT_CONFIRMED')
            with self.orders.transaction() as db:
                db.execute('INSERT OR IGNORE INTO live_managed_positions VALUES (?,?,?,?,?,?)',(entry_id,encoded(position),protection['intentId'],None,None,'MANAGING'))
            return self.get(entry_id)
    def poll(self,entry_id):
        # Broker-side protection continues when the market feed is unavailable.
        with self.lock:
            managed=self.get(entry_id)
            if not managed:raise ValueError('UNKNOWN_MANAGED_POSITION')
            if managed['state']=='CLOSED':return {'state':'CLOSED'}
            with self.orders.transaction() as db:
                ids=[r['id'] for r in db.execute('SELECT id FROM live_intents WHERE parent_id=?',(entry_id,))]
            for id in ids:self.orders.reconcile(id)
            entry=self.orders.get(entry_id)
            with self.orders.transaction() as db:
                closed=sum(r['filled_qty'] for r in db.execute('SELECT filled_qty FROM live_intents WHERE parent_id=?',(entry_id,)))
            if closed==entry['filled_qty']:return self._closed(entry_id)
            return {'state':managed['state']}
    def pulse(self,entry_id,quote,snapshot):
        with self.lock:
            managed=self.get(entry_id)
            if not managed: raise ValueError('UNKNOWN_MANAGED_POSITION')
            if managed['state']=='CLOSED': return {'state':'CLOSED'}
            self.orders.reconcile(managed['stop_intent']); entry=self.orders.get(entry_id)
            with self.orders.transaction() as db: exits=list(db.execute('SELECT * FROM live_intents WHERE parent_id=?',(entry_id,)))
            if sum(r['filled_qty'] for r in exits)==entry['filled_qty']: return self._closed(entry_id)
            if not managed['exit_intent']:
                args={'position':json.loads(managed['payload']),'quote':quote,'snapshot':snapshot}
                process=subprocess.run([self.node,str(Path(__file__).with_name('exitSignals.mjs'))],input=encoded(args),text=True,capture_output=True,check=True,timeout=5)
                decision=json.loads(process.stdout)
                if not decision.get('accepted'): return decision
                reason=decision.get('exitReason')
                with self.orders.transaction() as db:
                    db.execute('UPDATE live_managed_positions SET payload=?,exit_intent=?,exit_reason=?,state=? WHERE id=?',
                        (encoded(decision['position']),str(uuid.uuid5(uuid.NAMESPACE_URL,'iom-auto-exit:'+entry_id)) if reason else None,reason,'EXIT_REQUESTED' if reason else 'MANAGING',entry_id))
                managed=self.get(entry_id)
                if not reason:
                    state=decision['position']; floor=state.get('optionTrailingFloorPnl') if state['strategyFamily']=='SCALP' else state.get('coreOptionTrailingFloorPnl')
                    if floor is not None:
                        tick=decimal(self.execution.planner.validate_contract(state['symbol'])['tick_size'])
                        trigger=((decimal(state['entry'])+decimal(floor)/state['quantity'])/tick).to_integral_value(rounding=ROUND_FLOOR)*tick
                        row,book=self.protection.book(managed['stop_intent'])
                        if trigger>decimal(book.get('stopPrice')) and trigger<decimal(quote['optionPrice']): self.protection.tighten(managed['stop_intent'],float(trigger),float(trigger-tick))
                    return {'state':'MANAGING','position':state}
            prior=self.orders.get(managed['exit_intent'])
            if prior:
                result=self.orders.reconcile(prior['id'])
                if result['state']=='FILLED': return self._closed(entry_id)
                return {'state':result['state'],'exitReason':managed['exit_reason']}
            symbol=json.loads(entry['payload'])['symbol']
            self._exit_limit(symbol)  # Validate a fresh bid before removing existing protection.
            cancelled=self.protection.cancel(managed['stop_intent'])
            if cancelled['state'] not in TERMINAL: raise ValueError('CANCELLATION_NOT_CONFIRMED')
            remaining=entry['filled_qty']-cancelled['filled_qty']
            if not remaining: return self._closed(entry_id)
            limit=self._exit_limit(symbol)
            result=self.execution.exit(managed['exit_intent'],entry_id,float(limit),remaining)
            result=self.orders.reconcile(result['id'])
            if result['state']=='FILLED': return self._closed(entry_id)
            return {'state':result['state'],'exitReason':managed['exit_reason']}
    def _exit_limit(self,symbol):
        quote=self.execution.planner.quotes(symbol)
        age=self.execution.planner.clock()-float(quote.get('at',0))
        if quote.get('symbol')!=symbol or not -1<=age<=3: raise ValueError('STALE_EXIT_QUOTE')
        bid=decimal(quote.get('bid'));tick=decimal(self.execution.planner.validate_contract(symbol)['tick_size'])
        if bid<=0: raise ValueError('INVALID_EXIT_BID')
        limit=(bid/tick).to_integral_value(rounding=ROUND_FLOOR)*tick
        if limit<=0: raise ValueError('INVALID_EXIT_BID')
        return limit
    def _closed(self,entry_id):
        with self.orders.transaction() as db: db.execute("UPDATE live_managed_positions SET state='CLOSED' WHERE id=?",(entry_id,))
        self.orders.drain_journal(self.journal)
        return {'state':'CLOSED'}
