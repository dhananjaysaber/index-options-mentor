import concurrent.futures
import importlib.util
import json
import sqlite3
import sys
import tempfile
import unittest
import uuid
from pathlib import Path

ROOT=Path(__file__).resolve().parents[1]
sys.path.insert(0,str(ROOT/'aws/live'))
from orders import Orders
from planner import EntryPlanner
from execution import Execution
from fyers_broker import FyersBroker

SYMBOL='NSE:NIFTY26NOV25450PE'

def uid(): return str(uuid.uuid4())

class FakeBroker:
    def __init__(self):
        self.owner='OWNER'; self.funds=100000; self.orders={}; self.calls=0; self.timeout=False
        self.extra=0
    def account_id(self): return self.owner
    def available_funds(self): return self.funds
    def place_order(self,payload):
        self.calls+=1
        key='broker-'+str(self.calls)
        self.orders[key]={**payload,'orderTag':'1:'+payload['orderTag'],'id':key,
            'status':6,'filledQty':0,'remainingQuantity':payload['qty'],'tradedPrice':0,'clientId':self.owner}
        if self.timeout: raise TimeoutError()
        return {'s':'ok','id':key}
    def orders_by_tag(self,tag): return [r.copy() for r in self.orders.values() if r['orderTag']==tag]
    def net_quantity(self,symbol):
        return self.extra+sum(r['side']*r['filledQty'] for r in self.orders.values() if r['symbol']==symbol)
    def fill(self,key,qty=None,price=230,status=2):
        row=self.orders[key]; qty=row['qty'] if qty is None else qty
        row.update(filledQty=qty,remainingQuantity=row['qty']-qty,tradedPrice=price,status=status)

class ExecutionTests(unittest.TestCase):
    def setUp(self):
        self.temp=tempfile.TemporaryDirectory(); self.file=str(Path(self.temp.name)/'live.sqlite3')
        self.broker=FakeBroker(); self.now=1800000000.; self.ask=230.; self.open=True
        self.contract={'symbol':SYMBOL,'active':True,'lot_size':65,'max_quantity':1800,
                       'tick_size':.05,'checked_at':self.now,'expires_at':self.now+86400}
        self.quote={'symbol':SYMBOL,'ask':230,'at':self.now}
        self.planner=EntryPlanner(lambda _:self.contract,lambda _:self.quote,lambda:self.open,
                                  max_amount=30000,fee_reserve=100,clock=lambda:self.now)
        self.orders=Orders(self.file,self.broker,'OWNER',max_quantity=1800,enabled=True)
        self.execution=Execution(self.orders,self.planner)
    def tearDown(self): self.temp.cleanup()
    def entry(self,amount=30000):
        i=uid(); plan=self.execution.prepare(i,SYMBOL,amount); row=self.execution.submit(i)
        return i,plan,row
    def settled(self):
        i,plan,row=self.entry(); self.broker.fill(row['broker_id']); self.orders.reconcile(i)
        return i,plan,row
    def test_amount_computed_on_server_and_fills_separate(self):
        i,plan,row=self.entry()
        self.assertEqual((plan['lots'],plan['payload']['qty'],plan['premiumCost']),(2,130,29900))
        self.assertEqual(row['filled_qty'],0)
        self.broker.fill(row['broker_id']); self.assertEqual(self.orders.reconcile(i)['filled_qty'],130)
    def test_tick_rounding_stays_inside_budget(self):
        self.quote['ask']=230.001
        plan=self.execution.prepare(uid(),SYMBOL,30000)
        self.assertEqual(plan['buyPrice'],230.05)
        self.assertLessEqual(plan['premiumCost'],30000)
    def test_insufficient_one_lot_and_funds_no_broker_calls(self):
        with self.assertRaisesRegex(ValueError,'ONE_LOT'): self.execution.prepare(uid(),SYMBOL,100)
        self.broker.funds=29999
        with self.assertRaisesRegex(ValueError,'FUNDS'): self.execution.prepare(uid(),SYMBOL,30000)
        self.assertEqual(self.broker.calls,0)
    def test_bad_owner_expiry_contract_quote_and_market_blocked(self):
        self.broker.owner='OTHER'
        with self.assertRaisesRegex(ValueError,'ACCOUNT'): self.execution.prepare(uid(),SYMBOL,30000)
        self.broker.owner='OWNER'; self.contract['expires_at']=self.now
        with self.assertRaisesRegex(ValueError,'CONTRACT'): self.execution.prepare(uid(),SYMBOL,30000)
        self.contract['expires_at']=self.now+86400; self.quote['at']=self.now-4
        with self.assertRaisesRegex(ValueError,'QUOTE'): self.execution.prepare(uid(),SYMBOL,30000)
        self.quote['at']=self.now; self.open=False
        with self.assertRaisesRegex(ValueError,'SESSION'): self.execution.prepare(uid(),SYMBOL,30000)
        self.assertEqual(self.broker.calls,0)
    def test_limit_and_server_lot_size_cannot_be_overridden(self):
        with self.assertRaisesRegex(ValueError,'LIMIT'): self.execution.prepare(uid(),SYMBOL,30001)
        self.contract['lot_size']=75
        self.assertEqual(self.execution.prepare(uid(),SYMBOL,30000)['payload']['qty'],75)
    def test_prepare_is_stable_changed_request_rejected(self):
        i=uid(); first=self.execution.prepare(i,SYMBOL,30000)
        self.quote['ask']=200
        self.assertEqual(self.execution.prepare(i,SYMBOL,30000),first)
        with self.assertRaisesRegex(ValueError,'REUSED'): self.execution.prepare(i,SYMBOL,20000)
    def test_expired_plan_or_price_rise_requires_new_plan(self):
        i=uid(); self.execution.prepare(i,SYMBOL,30000); self.now+=16
        with self.assertRaisesRegex(ValueError,'EXPIRED'): self.execution.submit(i)
        self.quote['at']=self.now; j=uid(); self.execution.prepare(j,SYMBOL,30000); self.quote['ask']=231
        with self.assertRaisesRegex(ValueError,'PRICE_MOVED'): self.execution.submit(j)
        self.assertEqual(self.broker.calls,0)
    def test_funds_and_owner_rechecked_at_submit(self):
        i=uid(); self.execution.prepare(i,SYMBOL,30000); self.broker.funds=0
        with self.assertRaisesRegex(ValueError,'FUNDS'): self.execution.submit(i)
        self.broker.funds=100000; self.broker.owner='OTHER'
        with self.assertRaisesRegex(ValueError,'ACCOUNT'): self.execution.submit(i)
        self.assertEqual(self.broker.calls,0)
    def test_pending_entry_cannot_be_sold(self):
        i,_,row=self.entry(); self.broker.fill(row['broker_id'],10,status=6)
        with self.assertRaisesRegex(ValueError,'NOT_SETTLED'): self.execution.exit(uid(),i,240,65)
        self.assertEqual(self.broker.calls,1)
    def test_cancelled_partial_entry_only_sells_filled_units(self):
        i,_,row=self.entry(); self.broker.fill(row['broker_id'],65,status=1)
        with self.assertRaisesRegex(ValueError,'OWNED'): self.execution.exit(uid(),i,240,130)
        out=self.execution.exit(uid(),i,240,65)
        self.assertEqual(json.loads(out['payload'])['qty'],65)
    def test_duplicate_and_concurrent_distinct_exits_never_oversell(self):
        i,_,_=self.settled(); out=uid()
        with concurrent.futures.ThreadPoolExecutor(max_workers=6) as pool:
            list(pool.map(lambda _:self.execution.exit(out,i,240,130),range(12)))
        self.assertEqual(self.broker.calls,2)
        with self.assertRaisesRegex(ValueError,'OWNED'): self.execution.exit(uid(),i,240,65)
        with self.assertRaisesRegex(ValueError,'REUSED'): self.execution.exit(out,i,241,130)
    def test_different_exit_ids_race_for_same_quantity(self):
        i,_,_=self.settled()
        def attempt(_):
            try: return self.execution.exit(uid(),i,240,130)
            except ValueError as error: return str(error)
        with concurrent.futures.ThreadPoolExecutor(max_workers=6) as pool: results=list(pool.map(attempt,range(6)))
        self.assertEqual(sum(isinstance(r,dict) for r in results),1)
        self.assertEqual(self.broker.calls,2)
    def test_uncertain_exit_reserves_quantity_across_restart(self):
        i,_,_=self.settled(); self.broker.timeout=True; exit_id=uid()
        out=self.execution.exit(exit_id,i,240,130); self.assertEqual(out['state'],'UNKNOWN')
        restarted=Execution(Orders(self.file,self.broker,'OWNER',1800,True),self.planner)
        restarted.exit(exit_id,i,240,130)
        with self.assertRaisesRegex(ValueError,'OWNED'): restarted.exit(uid(),i,240,65)
        self.assertEqual(self.broker.calls,2)
    def test_stop_entries_still_allows_owned_exit(self):
        i,_,_=self.settled(); self.orders.stop()
        with self.assertRaisesRegex(ValueError,'STOPPED'): self.entry()
        self.execution.exit(uid(),i,240,130); self.assertEqual(self.broker.calls,2)
    def test_outside_position_change_blocks_exit(self):
        i,_,_=self.settled(); self.broker.extra=-65
        with self.assertRaisesRegex(ValueError,'POSITION_MISMATCH'): self.execution.exit(uid(),i,240,130)
        self.assertEqual(self.broker.calls,1)
    def test_ledger_cannot_be_rebound_to_another_owner(self):
        with self.assertRaisesRegex(ValueError,'LEDGER_OWNER'): Orders(self.file,self.broker,'OTHER',1800,True)
    def test_close_survives_restart_and_journal_replay_once(self):
        # This is the production journal implementation, using a disposable database.
        journal_path=ROOT/'aws/journal/store.py'
        spec=importlib.util.spec_from_file_location('live_test_journal',journal_path)
        module=importlib.util.module_from_spec(spec); spec.loader.exec_module(module)
        journal=module.Journal(Path(self.temp.name)/'journal.sqlite3')
        i,_,_=self.settled(); out=self.execution.exit(uid(),i,240,130)
        self.broker.fill(out['broker_id'],price=240)
        self.orders.reconcile(out['id'])
        # Simulate a crash after journal accepted the close but before outbox ack.
        with self.orders.transaction() as db:
            event=json.loads(db.execute('SELECT payload FROM live_journal_outbox').fetchone()[0])
        journal.event(event)
        restarted=Orders(self.file,self.broker,'OWNER',1800,True)
        self.assertEqual(restarted.drain_journal(journal),1)
        self.assertEqual(restarted.drain_journal(journal),0)
        self.assertEqual(journal.health()['trades'],1)
        self.assertEqual(journal.health()['events'],1)
        trade=journal.list_trades()['trades'][0]
        self.assertEqual((trade['quantity'],trade['entry'],trade['exit'],trade['grossPnl']),(130,230,240,1300))
        self.assertTrue(trade['brokerOrderPlaced']); self.assertEqual(trade['mode'],'LIVE')
    def test_partial_exit_cancellation_keeps_remaining_quantity(self):
        i,_,_=self.settled(); first=self.execution.exit(uid(),i,240,130)
        self.broker.fill(first['broker_id'],qty=65,price=240,status=1); self.orders.reconcile(first['id'])
        with self.assertRaisesRegex(ValueError,'OWNED'): self.execution.exit(uid(),i,240,130)
        second=self.execution.exit(uid(),i,240,65)
        self.broker.fill(second['broker_id'],price=250); self.orders.reconcile(second['id'])
        with self.orders.transaction() as db:
            event=json.loads(db.execute('SELECT payload FROM live_journal_outbox').fetchone()[0])
        self.assertEqual(event['trade']['grossPnl'],1950)

    def test_unresolved_entries_reserve_cash_atomically(self):
        self.broker.funds=30000
        a,b=uid(),uid()
        self.execution.prepare(a,SYMBOL,30000); self.execution.prepare(b,SYMBOL,30000)
        self.execution.submit(a)
        with self.assertRaisesRegex(ValueError,'FUNDS_RESERVED'): self.execution.submit(b)
        self.assertEqual(self.broker.calls,1)
    def test_contract_changed_after_prepare_blocks_submission(self):
        i=uid(); self.execution.prepare(i,SYMBOL,30000); self.contract['lot_size']=75
        with self.assertRaisesRegex(ValueError,'CONTRACT_CHANGED'): self.execution.submit(i)
        self.assertEqual(self.broker.calls,0)

    def test_exit_must_be_exchange_whole_lots_and_valid_tick(self):
        i,_,_=self.settled()
        with self.assertRaisesRegex(ValueError,'WHOLE_LOTS'): self.execution.exit(uid(),i,240,1)
        with self.assertRaisesRegex(ValueError,'EXIT_PRICE'): self.execution.exit(uid(),i,240.01,65)
        self.assertEqual(self.broker.calls,1)

class AdapterTests(unittest.TestCase):
    def test_adapter_disabled_and_only_exposes_owner(self):
        class Client:
            def get_profile(self): return {'s':'ok','data':{'fy_id':'OWNER','pan':'PRIVATE'}}
            def place_order(self,**_): raise AssertionError('must not send')
        broker=FyersBroker(Client())
        self.assertEqual(broker.account_id(),'OWNER')
        with self.assertRaisesRegex(ValueError,'DISABLED'): broker.place_order({})
    def test_funds_id_and_tag_filter(self):
        class Client:
            def funds(self): return {'s':'ok','fund_limit':[{'id':1,'equityAmount':999999},{'id':10,'equityAmount':30000}]}
            def orderbook(self): return {'s':'ok','orderBook':[{'orderTag':'1:ours'},{'orderTag':'2:Untagged'}]}
            def positions(self): return {'s':'ok','netPositions':[{'symbol':SYMBOL,'productType':'INTRADAY','netQty':130}]}
        broker=FyersBroker(Client())
        self.assertEqual(broker.available_funds(),30000)
        self.assertEqual(broker.orders_by_tag('1:ours'),[{'orderTag':'1:ours'}])
        self.assertEqual(broker.net_quantity(SYMBOL),130)
    def test_failed_reads_cannot_be_treated_as_zero_exposure(self):
        class Client:
            def positions(self): return {'s':'error','message':'private'}
        with self.assertRaisesRegex(ValueError,'READ_FAILED'): FyersBroker(Client()).net_quantity(SYMBOL)

if __name__=='__main__':unittest.main()
