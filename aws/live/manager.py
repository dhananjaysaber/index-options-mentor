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

# Failed-sale handling. Untested starting values, to be tuned on evidence.
# Each replacement sale is a limit order this far below the fresh best bid.
EXIT_REPRICE_SECONDS = 5
EXIT_FAST_ATTEMPTS, EXIT_SLOW_SECONDS = 6, 30
EXIT_STEPS = ('0', '0.01', '0.02')
# After this long (or after the small steps) use the widest allowance and raise
# attention. It stands in for the broker's lowest allowed price, which this
# code does not receive. There is never a market-order fallback.
EXIT_URGENT_SECONDS = 20
EXIT_URGENT_ALLOWANCE = '0.05'
# How long the price may sit below an unfilled stop's limit before selling.
STOP_PASSED_SECONDS = 3
STOP_ATTEMPTS = 2

class Manager:
    def __init__(self,execution,journal,node='node'):
        self.execution,self.orders,self.journal=execution,execution.orders,journal
        self.node=node;self.lock=threading.RLock();self.protection=Protection(execution)
        with self.orders.transaction() as db:
            db.execute('''CREATE TABLE IF NOT EXISTS live_managed_positions (
                id TEXT PRIMARY KEY, payload TEXT NOT NULL, stop_intent TEXT NOT NULL,
                exit_intent TEXT, exit_reason TEXT, state TEXT NOT NULL)''')
            db.execute('''CREATE TABLE IF NOT EXISTS live_exit_progress (
                id TEXT PRIMARY KEY, attempt INTEGER NOT NULL, started REAL NOT NULL, sent_at REAL NOT NULL)''')
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
            position['initialStop']=float(decimal(hard_option_stop))
            # Record ownership at the fill, before protection, so a failed stop
            # can never leave a position the app does not know it holds.
            with self.orders.transaction() as db:
                db.execute('INSERT OR IGNORE INTO live_managed_positions VALUES (?,?,?,?,?,?)',(entry_id,encoded(position),self.protection.key(entry_id),None,None,'PROTECTING'))
            return self.protect(entry_id)
    def protect(self,entry_id):
        """Place and confirm the first stop: one retry, otherwise ask to sell."""
        with self.lock:
            managed=self.get(entry_id)
            if managed['state']!='PROTECTING':return managed
            entry=self.orders.get(entry_id);position=json.loads(managed['payload'])
            symbol=json.loads(entry['payload'])['symbol']
            tick=decimal(self.execution.planner.validate_contract(symbol)['tick_size']);stop=decimal(position['initialStop'])
            if not tick<stop<decimal(entry['average_price']):
                return self._request_exit(entry_id,'PROTECTION_FAILED')
            attempt=1
            while managed['stop_intent']!=self.protection.key(entry_id,attempt):attempt+=1
            while True:
                key=self.protection.key(entry_id,attempt);row=self.orders.get(key)
                if row:row=self.orders.reconcile(key)
                if not row or row['state'] not in TERMINAL:
                    result=self.protection.ensure(entry_id,float(stop),float(stop-tick),entry['filled_qty'],key)
                    if result['state']=='PROTECTION_CONFIRMED':
                        position['stopConfirmed']=True
                        with self.orders.transaction() as db:db.execute("UPDATE live_managed_positions SET payload=?,state='MANAGING' WHERE id=?",(encoded(position),entry_id))
                        return self.get(entry_id)
                    row=self.orders.get(key)
                    if row['state'] not in TERMINAL:raise ValueError('PROTECTION_NOT_CONFIRMED')
                if row['filled_qty'] or attempt>=STOP_ATTEMPTS:
                    return self._request_exit(entry_id,'PROTECTION_FAILED')
                attempt+=1
                with self.orders.transaction() as db:db.execute('UPDATE live_managed_positions SET stop_intent=? WHERE id=?',(self.protection.key(entry_id,attempt),entry_id))
    def try_protect(self,entry_id):
        """As protect(), but an unconfirmed stop leaves the trade still watched."""
        try:return self.protect(entry_id)
        except ValueError:return self.get(entry_id)
    def _request_exit(self,entry_id,reason):
        with self.lock:
            managed=self.get(entry_id)
            exit_id=managed['exit_intent'] or str(uuid.uuid5(uuid.NAMESPACE_URL,'iom-auto-exit:'+entry_id))
            with self.orders.transaction() as db:
                db.execute("UPDATE live_managed_positions SET exit_intent=?,exit_reason=COALESCE(exit_reason,?),state='EXIT_REQUESTED' WHERE id=?",(exit_id,reason,entry_id))
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
            if managed['state']=='PROTECTING':
                managed=self.try_protect(entry_id)
            # Until the first stop is confirmed, strategy exits are still watched.
            # A sale still waits in _work_exit until any old stop is confirmed gone.
            unconfirmed=managed['state']=='PROTECTING'
            if self.orders.get(managed['stop_intent']): self.orders.reconcile(managed['stop_intent'])
            if self._remaining(entry_id)==0: return self._closed(entry_id)
            if not managed['exit_intent'] and not unconfirmed:
                stop=self.orders.get(managed['stop_intent'])
                if stop['state'] in TERMINAL:
                    # Rejected, cancelled or expired while we still hold units.
                    managed=self._request_exit(entry_id,'PROTECTION_LOST')
            if not managed['exit_intent']:
                args={'position':json.loads(managed['payload']),'quote':quote,'snapshot':snapshot,'nowMs':self.execution.planner.clock()*1000}
                process=subprocess.run([self.node,str(Path(__file__).with_name('exitSignals.mjs'))],input=encoded(args),text=True,capture_output=True,check=True,timeout=5)
                decision=json.loads(process.stdout)
                if not decision.get('accepted'): return decision
                state=decision['position'];reason=decision.get('exitReason')
                if not reason and self._stop_passed(managed,unconfirmed,state,quote): reason='STOP_NOT_FILLED'
                with self.orders.transaction() as db:
                    db.execute('UPDATE live_managed_positions SET payload=?,state=? WHERE id=?',(encoded(state),managed['state'],entry_id))
                if reason: self._request_exit(entry_id,reason)
                elif unconfirmed: return {'state':'PROTECTING','position':state}
                else:
                    floor=state.get('optionTrailingFloorPnl') if state['strategyFamily']=='SCALP' else state.get('coreOptionTrailingFloorPnl')
                    if floor is not None:
                        tick=decimal(self.execution.planner.validate_contract(state['symbol'])['tick_size'])
                        trigger=((decimal(state['entry'])+decimal(floor)/state['quantity'])/tick).to_integral_value(rounding=ROUND_FLOOR)*tick
                        row,book=self.protection.book(managed['stop_intent'])
                        if trigger>decimal(book.get('stopPrice')) and trigger<decimal(quote['optionPrice']): self.protection.tighten(managed['stop_intent'],float(trigger),float(trigger-tick))
                    return {'state':'MANAGING','position':state}
            return self._work_exit(entry_id)
    def _stop_passed(self,managed,unconfirmed,state,quote):
        now=self.execution.planner.clock()
        if unconfirmed:
            # The broker's copy cannot be relied on: use the intended stop.
            tick=decimal(self.execution.planner.validate_contract(state['symbol'])['tick_size'])
            limit=decimal(state['initialStop'])-tick
        else:limit=decimal(self.protection.book(managed['stop_intent'])[1].get('limitPrice'))
        if decimal(quote['optionPrice'])>=limit:
            state.pop('stopPassedSince',None);return False
        state.setdefault('stopPassedSince',now)
        return now-state['stopPassedSince']>=STOP_PASSED_SECONDS
    def _remaining(self,entry_id):
        with self.orders.transaction() as db:
            sold=sum(r['filled_qty'] for r in db.execute('SELECT filled_qty FROM live_intents WHERE parent_id=?',(entry_id,)))
        return self.orders.get(entry_id)['filled_qty']-sold
    def progress(self,entry_id):
        with self.orders.transaction() as db: row=db.execute('SELECT * FROM live_exit_progress WHERE id=?',(entry_id,)).fetchone()
        return dict(row) if row else None
    def exit_overdue(self,entry_id):
        progress=self.progress(entry_id)
        return bool(progress and self.execution.planner.clock()-progress['started']>=EXIT_URGENT_SECONDS)
    def _work_exit(self,entry_id):
        """One sale at a time: confirm the last one is finished before another."""
        managed=self.get(entry_id);entry=self.orders.get(entry_id)
        symbol=json.loads(entry['payload'])['symbol'];now=self.execution.planner.clock()
        progress=self.progress(entry_id);prior=self.orders.get(managed['exit_intent'])
        if prior:
            prior=self.orders.reconcile(prior['id'])
            if self._remaining(entry_id)==0: return self._closed(entry_id)
            waiting={'state':prior['state'],'exitReason':managed['exit_reason']}
            # A restart can lose the timing row; start a new wait in that case.
            if not progress: progress=self._save_progress(entry_id,1,now,now)
            # Slow down after repeated attempts so a broker that keeps rejecting
            # (for example after the market shuts) is not hit every few seconds.
            pause=EXIT_SLOW_SECONDS if progress['attempt']>=EXIT_FAST_ATTEMPTS else EXIT_REPRICE_SECONDS
            due=now-progress['sent_at']>=pause
            if prior['state'] not in TERMINAL:
                if not due: return waiting
                if not prior['broker_id']: raise ValueError('EXIT_OUTCOME_UNKNOWN_CHECK_BROKER')
                # Leave a resting order alone unless a new one would be cheaper.
                if self._exit_limit(symbol,progress)>=decimal(json.loads(prior['payload'])['limitPrice']): return waiting
                self.protection.cancel_exit(prior['id'])
                if self._remaining(entry_id)==0: return self._closed(entry_id)
            elif not due: return waiting
        self._exit_limit(symbol,progress)  # Validate a fresh bid before removing existing protection.
        stop=self.orders.get(managed['stop_intent'])
        if stop:
            stop=self.orders.reconcile(stop['id'])
            if stop['state'] not in TERMINAL:
                if self.protection.cancel(stop['id'])['state'] not in TERMINAL: raise ValueError('CANCELLATION_NOT_CONFIRMED')
        remaining=self._remaining(entry_id)
        if not remaining: return self._closed(entry_id)
        # A replacement that failed before its order record keeps its step.
        attempt=progress['attempt']+(1 if prior else 0) if progress else 1
        exit_id=managed['exit_intent']
        if prior:
            exit_id=str(uuid.uuid5(uuid.NAMESPACE_URL,'iom-auto-exit:'+entry_id+':'+str(attempt)))
        limit=self._exit_limit(symbol,progress)
        self._save_progress(entry_id,attempt,progress['started'] if progress else now,now)
        with self.orders.transaction() as db: db.execute('UPDATE live_managed_positions SET exit_intent=? WHERE id=?',(exit_id,entry_id))
        result=self.execution.exit(exit_id,entry_id,float(limit),remaining)
        result=self.orders.reconcile(result['id'])
        if self._remaining(entry_id)==0: return self._closed(entry_id)
        return {'state':result['state'],'exitReason':managed['exit_reason']}
    def _save_progress(self,entry_id,attempt,started,sent_at):
        with self.orders.transaction() as db:
            db.execute('INSERT OR REPLACE INTO live_exit_progress VALUES (?,?,?,?)',(entry_id,attempt,started,sent_at))
        return {'id':entry_id,'attempt':attempt,'started':started,'sent_at':sent_at}
    def _exit_limit(self,symbol,progress=None):
        quote=self.execution.planner.quotes(symbol)
        age=self.execution.planner.clock()-float(quote.get('at',0))
        if quote.get('symbol')!=symbol or not -1<=age<=3: raise ValueError('STALE_EXIT_QUOTE')
        bid=decimal(quote.get('bid'));tick=decimal(self.execution.planner.validate_contract(symbol)['tick_size'])
        if bid<=0: raise ValueError('INVALID_EXIT_BID')
        allowance=EXIT_STEPS[0]
        if progress:
            late=self.execution.planner.clock()-progress['started']>=EXIT_URGENT_SECONDS
            allowance=EXIT_URGENT_ALLOWANCE if late or progress['attempt']>=len(EXIT_STEPS) else EXIT_STEPS[progress['attempt']]
        limit=(bid*(1-decimal(allowance))/tick).to_integral_value(rounding=ROUND_FLOOR)*tick
        if limit<=0: raise ValueError('INVALID_EXIT_BID')
        return limit
    def _closed(self,entry_id):
        with self.orders.transaction() as db: db.execute("UPDATE live_managed_positions SET state='CLOSED' WHERE id=?",(entry_id,))
        self.orders.drain_journal(self.journal)
        return {'state':'CLOSED'}
