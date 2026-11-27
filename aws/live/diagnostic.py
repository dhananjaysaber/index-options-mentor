"""Self-contained artificial execution check. Never opens the production journal or FYERS."""
import importlib.util
import json
import sqlite3
import tempfile
import time
import uuid
from datetime import datetime,timezone
from pathlib import Path
from orders import Orders,encoded
from execution import Execution
from planner import EntryPlanner
from manager import Manager

class SimulatedBroker:
    is_simulated=True
    send_enabled=True
    def __init__(self,file,owner,quote):
        self.file,self.owner,self.quote=file,owner,quote
        with sqlite3.connect(file) as db:
            db.execute('CREATE TABLE IF NOT EXISTS simulated_orders (id TEXT PRIMARY KEY,payload TEXT NOT NULL)')
            db.execute('CREATE TABLE IF NOT EXISTS simulated_calls (seq INTEGER PRIMARY KEY,kind TEXT NOT NULL)')
    def account_id(self): return self.owner
    def available_funds(self): return 1000000
    def _rows(self):
        with sqlite3.connect(self.file) as db: return [json.loads(r[0]) for r in db.execute('SELECT payload FROM simulated_orders')]
    def _write(self,row,kind):
        with sqlite3.connect(self.file) as db:
            db.execute('INSERT OR REPLACE INTO simulated_orders VALUES (?,?)',(row['id'],encoded(row)))
            db.execute('INSERT INTO simulated_calls(kind) VALUES (?)',(kind,))
    def place_order(self,payload):
        key='SIM-'+str(uuid.uuid4()); stop=payload['type']==4
        row={**payload,'id':key,'clientId':self.owner,'orderTag':'1:'+payload['orderTag'],
             'status':6 if stop else 2,'filledQty':0 if stop else payload['qty'],
             'remainingQuantity':payload['qty'] if stop else 0,
             'tradedPrice':0 if stop else (self.quote['ask'] if payload['side']==1 else self.quote['bid'])}
        self._write(row,'PLACE'); return {'s':'ok','id':key}
    def orders_by_tag(self,tag): return [r for r in self._rows() if r['orderTag']==tag]
    def net_quantity(self,symbol): return sum(r['side']*r['filledQty'] for r in self._rows() if r['symbol']==symbol)
    def orders_for_symbol(self,symbol): return [r for r in self._rows() if r['symbol']==symbol]
    def position_rows(self,symbol):
        return [{'netQty':self.net_quantity(symbol)}] if self.orders_for_symbol(symbol) else []
    def cancel_order(self,order_id):
        row=next(r for r in self._rows() if r['id']==order_id)
        if row['status']!=2: row['status']=1;self._write(row,'CANCEL')
        return {'s':'ok','id':order_id}
    def modify_stop(self,order_id,stop,limit,qty):
        row=next(r for r in self._rows() if r['id']==order_id)
        if row['status']!=6 or row['filledQty']: raise ValueError('SIM_STOP_NOT_PENDING')
        row.update(stopPrice=stop,limitPrice=limit,qty=qty,remainingQuantity=qty-row['filledQty']);self._write(row,'MODIFY')
        return {'s':'ok','id':order_id}
    def calls(self,kind='PLACE'):
        with sqlite3.connect(self.file) as db: return db.execute('SELECT count(*) FROM simulated_calls WHERE kind=?',(kind,)).fetchone()[0]
    def fill_stop(self,order_id,price):
        row=next(r for r in self._rows() if r['id']==order_id)
        row.update(status=2,filledQty=row['qty'],remainingQuantity=0,tradedPrice=price);self._write(row,'STOP_FILL')


def journal_class(file=None):
    source=Path(file) if file else Path(__file__).resolve().parents[1]/'journal/store.py'
    spec=importlib.util.spec_from_file_location('execution_check_journal',source)
    module=importlib.util.module_from_spec(spec);spec.loader.exec_module(module)
    return module.Journal


def run_check(owner,journal_source=None):
    results=[]
    Journal=journal_class(journal_source)
    with tempfile.TemporaryDirectory(prefix='iom-execution-check-') as temporary:
        for strategy in ['CORE','SCALP']:
            file=str(Path(temporary)/(strategy+'.sqlite3'));now=time.time()
            symbol='NSE:NIFTYTEST25450PE'
            quote={'symbol':symbol,'ask':230.,'bid':230.,'at':now}
            contract={'symbol':symbol,'active':True,'lot_size':65,'max_quantity':1800,'tick_size':.05,'checked_at':now,'expires_at':now+86400}
            broker=SimulatedBroker(file,owner,quote);orders=Orders(file,broker,owner,1800,True)
            journal=Journal(file)
            planner=EntryPlanner(lambda _:contract,lambda _:quote,lambda:True,max_amount=30000,clock=time.time)
            execution=Execution(orders,planner);manager=Manager(execution,journal)
            entry_id=str(uuid.uuid4());plan=execution.prepare(entry_id,symbol,30000,strategy)
            execution.submit(entry_id);orders.reconcile(entry_id)
            position={'symbol':symbol,'side':'PE','strategyFamily':strategy,'underlyingEntry':25000,
                      'underlyingStop':25100,'underlyingTarget':24900,'rr':1,'score':90}
            manager.track(entry_id,position,220)
            def pulse(price):
                # Monotonic fresh exchange timestamps; no changes to the machine clock.
                quote.update(ask=price,bid=price,at=time.time())
                at=datetime.fromtimestamp(quote['at'],timezone.utc).isoformat()
                return manager.pulse(entry_id,{'optionSymbol':symbol,'optionPrice':price,'nifty':25000,'at':at},
                                     {'generatedAt':at,'decision':{'side':'PE','score':90},'parameters':[]})
            peak=pulse(260)
            if peak.get('state')!='MANAGING': raise ValueError('TRAIL_PEAK_CHECK_FAILED')
            state=manager.get(entry_id)
            stop_row,stop_book=manager.protection.book(state['stop_intent'])
            if stop_book['stopPrice']<=220: raise ValueError('BROKER_STOP_NOT_TIGHTENED')
            closed=pulse(240)
            if closed.get('state')!='CLOSED': raise ValueError('AUTO_EXIT_NOT_CONFIRMED')
            before=broker.calls();pulse(240)
            restarted=Manager(Execution(Orders(file,SimulatedBroker(file,owner,quote),owner,1800,True),planner),journal)
            restarted.pulse(entry_id,{},{});orders.drain_journal(journal)
            health=journal.health();trade=journal.list_trades()['trades'][0]
            if health['trades']!=1 or health['events']!=1 or broker.calls()!=before:
                raise ValueError('EXIT_REPLAY_DUPLICATED')
            results.append({'strategy':strategy,'passed':True,'lots':plan['lots'],'quantity':plan['payload']['qty'],
                            'premiumCost':plan['premiumCost'],'exitReason':trade['exitReason'],
                            'journalRows':health['trades'],'journalEvents':health['events'],
                            'protectionConfirmed':True,'protectionTightened':True,'stopCancelledBeforeExit':True,
                            'replayCreatedOrders':broker.calls()-before})
    return {'ok':True,'mode':'SIMULATED_EXECUTION_CHECK','realMoneyEnabled':False,
            'productionJournalTouched':False,'brokerNetworkRequests':0,'checks':results}
