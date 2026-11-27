"""One serial owner for real intents, shared exits and restart protection.

All broker mutations still require the separately configured host's send gate.
The browser supplies actions and budget only; never contract/quote/stop decisions.
"""
from datetime import datetime,timezone
from zoneinfo import ZoneInfo
from decimal import ROUND_FLOOR
import json
import threading
import time
import uuid
from orders import TERMINAL,encoded
from planner import decimal
from protection import RESEND_AFTER

TZ=ZoneInfo('Asia/Kolkata')
# Owner decision 27 Nov 2026: whatever is still open is sold from 15:18 IST.
FORCED_CLOSE=(15,18)
STALE_READING_ALERT_SECONDS=15
# Sales for these reasons say nothing about whether a strategy exit works.
NOT_STRATEGY_EXITS={'USER_EXIT','END_OF_DAY','PROTECTION_FAILED','PROTECTION_LOST','STOP_NOT_FILLED','CLOSED_OUTSIDE_APP'}

class Runtime:
    def __init__(self,execution,manager,feed,market,*,max_amount=30000,clock=time.time,day_clock=None):
        self.execution,self.orders,self.manager,self.feed,self.market=execution,execution.orders,manager,feed,market
        self.day_clock=day_clock or clock;self.reading_missing_since=None;self.reading_stale=False
        self.max_amount=decimal(max_amount);self.clock=clock;self.lock=threading.RLock();self.last_error=None
        with self.orders.transaction() as db:
            db.executescript('''CREATE TABLE IF NOT EXISTS live_requests (
                id TEXT PRIMARY KEY, strategy TEXT NOT NULL, automatic INTEGER NOT NULL,
                ticket TEXT NOT NULL, stop REAL NOT NULL, state TEXT NOT NULL, created REAL NOT NULL);
                CREATE TABLE IF NOT EXISTS live_runtime_settings (id INTEGER PRIMARY KEY CHECK(id=1), payload TEXT NOT NULL);
                CREATE TABLE IF NOT EXISTS live_entry_cancels (id TEXT PRIMARY KEY,state TEXT NOT NULL);''')
            if 'sent_at' not in {r['name'] for r in db.execute('PRAGMA table_info(live_entry_cancels)')}:
                db.execute('ALTER TABLE live_entry_cancels ADD COLUMN sent_at REAL NOT NULL DEFAULT 0')
            db.execute('INSERT OR IGNORE INTO live_runtime_settings VALUES (1,?)',(encoded({'tradeAmount':float(self.max_amount),'mentorAutoOpen':False,'scalpAutoOpen':False,'controlledResearch':True,'experimentalResearch':False}),))
    def settings(self):
        with self.orders.transaction() as db:return json.loads(db.execute('SELECT payload FROM live_runtime_settings WHERE id=1').fetchone()[0])
    def set_settings(self,payload):
        if set(payload)-{'tradeAmount','mentorAutoOpen','scalpAutoOpen','controlledResearch','experimentalResearch'}:raise ValueError('INVALID_SETTINGS')
        with self.lock:
            prior=self.settings();value={**prior,**payload};amount=decimal(value['tradeAmount'])
            if not 0<amount<=self.max_amount:raise ValueError('AMOUNT_LIMIT_EXCEEDED')
            if any(type(value[k]) is not bool for k in value if k!='tradeAmount'):raise ValueError('INVALID_SETTINGS')
            value['tradeAmount']=float(amount)
            with self.orders.transaction() as db:db.execute('UPDATE live_runtime_settings SET payload=? WHERE id=1',(encoded(value),))
            return value
    def _active(self):
        with self.orders.transaction() as db:
            return [dict(r) for r in db.execute("SELECT * FROM live_requests WHERE state NOT IN ('CLOSED','NO_FILL','EXPIRED')")]
    def _enabled(self):
        return self.orders.enabled is True and getattr(self.orders.broker,'send_enabled',False) is True
    def _exits_allowed(self):
        return ((self.orders.enabled is True or self.orders.exits_enabled is True)
                and getattr(self.orders.broker,'send_enabled',False) is True)
    def acceptance(self):
        from fyers_broker import FyersBroker
        from fyers_rest import FyersRest
        real=isinstance(self.orders.broker,FyersBroker) and isinstance(self.orders.broker.client,FyersRest)
        with self.orders.transaction() as db:
            managed=list(db.execute('SELECT * FROM live_managed_positions'))
            stops={r['id']:dict(r) for r in db.execute('SELECT * FROM live_intents WHERE parent_id IS NOT NULL')}
            delivered={r['id'] for r in db.execute('SELECT id FROM live_journal_outbox WHERE delivered=1')}
        stop_proof=real and any(json.loads(r['payload']).get('stopConfirmed') is True and r['exit_reason']!='PROTECTION_FAILED' and stops.get(r['stop_intent'],{}).get('state') in ('PENDING','FILLED','CANCELLED') for r in managed)
        verified=set()
        for row in managed:
            if real and row['state']=='CLOSED' and row['exit_reason'] and row['exit_reason'] not in NOT_STRATEGY_EXITS and row['id']+':BROKER_CLOSED' in delivered:
                verified.add(json.loads(row['payload'])['strategyFamily'])
        return {'brokerStopsVerified':bool(stop_proof),'webSocketExitStrategiesVerified':sorted(verified),
                'actualBrokerAcceptanceVerified':stop_proof and verified=={'CORE','SCALP'}}
    def status(self):
        with self.lock:
            rows=self._active()
            return {'ok':True,'mode':'OWNED_EXECUTION_HOST','actualLiveExecutionHostReleased':True,
                'realMoneyEnabled':self._enabled(),'exitsAllowed':self._exits_allowed(),'settings':self.settings(),'positions':[
                    {'id':r['id'],'strategy':r['strategy'],'state':r['state'],'symbol':json.loads(r['ticket'])['symbol']} for r in rows],
                'attentionRequired':self.last_error,'strategyReadingStale':self.reading_stale,
                'needsChecking':self.orders.external_closes(),**self.acceptance()}
    def prepare(self,intent_id,strategy,automatic=False):
        with self.lock:
            if strategy not in ('CORE','SCALP') or type(automatic) is not bool:raise ValueError('INVALID_STRATEGY')
            if str(uuid.UUID(intent_id))!=intent_id:raise ValueError('INVALID_INTENT_ID')
            with self.orders.transaction() as db:prior=db.execute('SELECT * FROM live_requests WHERE id=?',(intent_id,)).fetchone()
            if prior:
                if prior['strategy']!=strategy or bool(prior['automatic'])!=automatic:raise ValueError('INTENT_REUSED')
                return self.execution.prepare(intent_id,json.loads(prior['ticket'])['symbol'],self.settings()['tradeAmount'],strategy)
            if any(r['strategy']==strategy  for r in self._active()):raise ValueError('STRATEGY_POSITION_ALREADY_ACTIVE')
            if self.last_error:raise ValueError('RECONCILIATION_ATTENTION_REQUIRED')
            if self.market.session_open() is not True:raise ValueError('ENTRY_SESSION_CLOSED')
            data=self.market.current();ticket=data['tickets'].get(strategy+('_AUTO' if automatic else '_MANUAL'))
            if not isinstance(ticket,dict):raise ValueError('MENTOR_ENTRY_NOT_READY')
            symbol=ticket['symbol'];pair=self.feed.pair(symbol)
            tick=decimal(self.execution.planner.validate_contract(symbol)['tick_size'])
            stop=(decimal(ticket.get('hardOptionStop'))/tick).to_integral_value(rounding=ROUND_FLOOR)*tick
            if not tick<stop<decimal(pair['optionPrice']):raise ValueError('VALID_INITIAL_BROKER_STOP_REQUIRED')
            # Revalidate structural stop against the current shared-socket index.
            direction=1 if ticket.get('side')=='CE' else -1
            if ticket.get('side') not in ('CE','PE') or direction*(decimal(pair['nifty'])-decimal(ticket.get('underlyingStop')))<=0:raise ValueError('STRUCTURAL_STOP_ALREADY_HIT')
            ticket={**ticket,'underlyingEntry':pair['nifty']}
            plan=self.execution.prepare(intent_id,symbol,self.settings()['tradeAmount'],strategy)
            plan.update({'initialStop':float(stop),'underlyingStop':ticket['underlyingStop'],'strategyFamily':strategy})
            with self.orders.transaction() as db:
                db.execute('INSERT INTO live_requests VALUES (?,?,?,?,?,?,?)',(intent_id,strategy,int(automatic),encoded(ticket),float(stop),'PREPARED',self.clock()))
            return plan
    def submit(self,intent_id):
        with self.lock:
            if not self._enabled():raise ValueError('REAL_MONEY_DISABLED')
            with self.orders.transaction() as db:row=db.execute('SELECT * FROM live_requests WHERE id=?',(intent_id,)).fetchone()
            if not row:raise ValueError('UNKNOWN_PREPARED_ENTRY')
            if row['state'] in ('CLOSED','NO_FILL'):return {'id':intent_id,'state':row['state']}
            if row['state']=='EXPIRED':raise ValueError('PLAN_EXPIRED')
            existing=self.orders.get(intent_id)
            if existing:return self._entry_progress(intent_id)
            # Expired or changed strategy is not silently approved at submit time.
            data=self.market.current();ticket=json.loads(row['ticket'])
            current=data['tickets'].get(row['strategy']+('_AUTO' if row['automatic'] else '_MANUAL'))
            if not current or current.get('symbol')!=ticket['symbol'] or current.get('underlyingStop')!=ticket.get('underlyingStop'):raise ValueError('MENTOR_PLAN_CHANGED_REFRESH')
            pair=self.feed.pair(ticket['symbol'])
            direction=1 if ticket.get('side')=='CE' else -1
            if direction*(decimal(pair['nifty'])-decimal(ticket['underlyingStop']))<=0:raise ValueError('STRUCTURAL_STOP_ALREADY_HIT')
            if decimal(pair['optionPrice'])<=decimal(row['stop']):raise ValueError('INITIAL_STOP_ALREADY_HIT')
            with self.orders.transaction() as db:
                if db.execute("SELECT 1 FROM live_requests WHERE strategy=? AND id!=? AND state NOT IN ('PREPARED','CLOSED','NO_FILL')",(row['strategy'],intent_id)).fetchone():raise ValueError('STRATEGY_POSITION_ALREADY_ACTIVE')
                db.execute("UPDATE live_requests SET state='SUBMIT_REQUESTED' WHERE id=?",(intent_id,))
            try:self.execution.submit(intent_id)
            except Exception:
                # The order record is saved before anything is sent, so no
                # record means nothing reached the broker.
                if not self.orders.get(intent_id):self._state(intent_id,'NO_FILL')
                raise
            try:return self._entry_progress(intent_id)
            except Exception:
                self.last_error='OWNED_POSITION_REQUIRES_ATTENTION';raise
    def _state(self,id,state):
        with self.orders.transaction() as db:db.execute('UPDATE live_requests SET state=? WHERE id=?',(state,id))
    def _cancel_unfilled_entry(self,entry):
        if entry['state'] in TERMINAL:return entry
        if not entry['broker_id']:raise ValueError('ENTRY_OUTCOME_UNKNOWN_CHECK_BROKER')
        now=self.clock()
        with self.orders.transaction() as db:
            prior=db.execute('SELECT sent_at FROM live_entry_cancels WHERE id=?',(entry['id'],)).fetchone()
            send=not prior or now-prior['sent_at']>=RESEND_AFTER
            if send:db.execute('INSERT OR REPLACE INTO live_entry_cancels(id,state,sent_at) VALUES (?,?,?)',(entry['id'],'SUBMITTING',now))
        if send:
            try:self.orders.broker.cancel_order(entry['broker_id'])
            except Exception:pass
        # Acknowledgement is not enough; only a terminal orderbook result settles.
        entry=self.orders.reconcile(entry['id'])
        if entry['state'] not in TERMINAL:raise ValueError('ENTRY_CANCEL_NOT_CONFIRMED')
        return entry
    def _entry_progress(self,id):
        if not self.orders.get(id):
            self._state(id,'NO_FILL');return {'id':id,'state':'NO_FILL'}
        entry=self.orders.reconcile(id)
        with self.orders.transaction() as db:request=dict(db.execute('SELECT * FROM live_requests WHERE id=?',(id,)).fetchone())
        if entry['state'] not in TERMINAL:
            # Any partial fill triggers cancellation immediately; otherwise expire
            # the unfilled order after three seconds, without resubmitting it.
            if entry['filled_qty'] or self.clock()-datetime.fromisoformat(entry['created_at'].replace('Z','+00:00')).timestamp()>=3:entry=self._cancel_unfilled_entry(entry)
            else:return {'id':id,'state':entry['state'],'filledQuantity':entry['filled_qty']}
        if not entry['filled_qty']:
            self._state(id,'NO_FILL');return {'id':id,'state':'NO_FILL'}
        ticket=json.loads(request['ticket'])
        self.orders.record_open(id,ticket)
        try:tracked=self.manager.track(id,ticket,request['stop'])
        except Exception:
            with self.orders.transaction() as db:closed=sum(r['filled_qty'] for r in db.execute('SELECT filled_qty FROM live_intents WHERE parent_id=?',(id,)))
            if closed==entry['filled_qty']:
                self.orders.drain_journal(self.manager.journal);self._state(id,'CLOSED');return {'id':id,'state':'CLOSED'}
            raise
        self._state(id,'MANAGING' if tracked['state']!='CLOSED' else 'CLOSED')
        self.orders.drain_journal(self.manager.journal)
        return {'id':id,'state':tracked['state'],'filledQuantity':entry['filled_qty'],'protectionConfirmed':tracked['state']=='MANAGING'}
    def request_exit(self,entry_id):
        with self.lock:
            managed=self.manager.get(entry_id)
            if not managed:raise ValueError('UNKNOWN_OWNED_POSITION')
            if managed['state']=='CLOSED':return {'state':'CLOSED'}
            self.manager._request_exit(entry_id,'USER_EXIT')
            # A sale is priced from its own fresh bid check, not the paired feed.
            result=self.manager.pulse(entry_id,{},{})
            if result.get('state')=='CLOSED':self._state(entry_id,'CLOSED')
            return result
    def cycle(self):
        with self.lock:
            with self.orders.transaction() as db:db.execute("UPDATE live_requests SET state='EXPIRED' WHERE state='PREPARED' AND created<?",(self.clock()-15,))
            errors=[];rows=self._active();symbols=set()
            reading_ok=False
            try:
                data=self.market.current();snapshot=data.get('snapshot',{});reading_ok=True
                symbols.update(t['symbol'] for t in data['tickets'].values() if isinstance(t,dict))
            except Exception:snapshot={}
            if reading_ok or not any(self.manager.get(r['id']) for r in rows):self.reading_missing_since=None
            elif self.reading_missing_since is None:self.reading_missing_since=self.clock()
            self.reading_stale=self.reading_missing_since is not None and self.clock()-self.reading_missing_since>=STALE_READING_ALERT_SECONDS
            local=datetime.fromtimestamp(self.day_clock(),TZ);closing=(local.hour,local.minute)>=FORCED_CLOSE
            for row in rows:symbols.add(json.loads(row['ticket'])['symbol'])
            self.feed.subscriptions(symbols)
            for row in rows:
                if row['state']=='PREPARED':continue
                try:
                    managed=self.manager.get(row['id'])
                    if not managed:self._entry_progress(row['id']);managed=self.manager.get(row['id'])
                    if managed:
                        # Reconcile protective fills even without a fresh market tick.
                        polled=self.manager.poll(row['id'])
                        if polled['state']=='CLOSED':
                            self._state(row['id'],'CLOSED');continue
                        managed=self.manager.get(row['id'])
                        if closing and not managed['exit_intent']:managed=self.manager._request_exit(row['id'],'END_OF_DAY')
                        if managed['state']=='PROTECTING':managed=self.manager.try_protect(row['id'])
                        if managed['exit_intent']:pair={}
                        else:pair=self.feed.pair(json.loads(managed['payload'])['symbol'])
                        result=self.manager.pulse(row['id'],pair,snapshot)
                        if result.get('state')=='CLOSED':self._state(row['id'],'CLOSED')
                        elif self.manager.exit_overdue(row['id']):errors.append('EXIT_OVERDUE')
                        if self.manager.get(row['id'])['state']=='PROTECTING':errors.append('STOP_UNCONFIRMED')
                except Exception as error:errors.append(type(error).__name__)
            self.last_error='OWNED_POSITION_REQUIRES_ATTENTION' if errors else None
            self.orders.drain_journal(self.manager.journal)
            if self._enabled() and not errors:
                settings=self.settings()
                for strategy,key in [('CORE','mentorAutoOpen'),('SCALP','scalpAutoOpen')]:
                    if settings.get(key) is not True or any(r['strategy']==strategy for r in self._active()):continue
                    try:
                        ticket=self.market.current()['tickets'].get(strategy+'_AUTO')
                        if not ticket or not ticket.get('setupId'):continue
                        id=str(uuid.uuid5(uuid.NAMESPACE_URL,'iom-live:'+self.orders.account_id+':'+strategy+':'+ticket['setupId']))
                        if self.orders.get(id):continue
                        self.prepare(id,strategy,True);self.submit(id)
                    except ValueError:pass
            return self.status()
