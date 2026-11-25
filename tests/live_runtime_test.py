from datetime import datetime,timezone
import io
import json
from pathlib import Path
import sys
import tempfile
import threading
import time
import unittest
import urllib.request
import urllib.error
import uuid
ROOT=Path(__file__).resolve().parents[1];sys.path.insert(0,str(ROOT/'aws/live'))
from runtime import Runtime
from order_host import server
from orders import Orders
from planner import EntryPlanner
from execution import Execution
from manager import Manager
from diagnostic import SimulatedBroker,journal_class
from fyers_rest import FyersRest
from market import Market
from bridge import signature

class RuntimeTests(unittest.TestCase):
    def setUp(self):
        self.temp=tempfile.TemporaryDirectory();self.now=time.time();self.file=str(Path(self.temp.name)/'isolated.sqlite3')
        self.symbol='NSE:NIFTYTEST25450PE';self.quote={'symbol':self.symbol,'ask':230,'bid':230,'at':self.now}
        self.contract={'symbol':self.symbol,'active':True,'lot_size':65,'max_quantity':1755,'tick_size':.05,'checked_at':self.now,'expires_at':self.now+86400}
        self.broker=SimulatedBroker(self.file,'OWNER',self.quote);self.orders=Orders(self.file,self.broker,'OWNER',1755,True)
        self.journal=journal_class()(self.file)
        planner=EntryPlanner(lambda _:self.contract,lambda _:self.quote,lambda:True,30000,clock=lambda:self.now)
        self.execution=Execution(self.orders,planner);self.manager=Manager(self.execution,self.journal)
        outer=self
        class FakeFeed:
            stale=False
            def subscriptions(self,symbols):self.symbols=symbols
            def pair(self,symbol):
                if self.stale:raise ValueError('STALE')
                return {'optionSymbol':symbol,'optionPrice':outer.quote['bid'],'nifty':25000,'at':datetime.fromtimestamp(outer.now,timezone.utc).isoformat()}
        self.feed=FakeFeed()
        self.ticket={'symbol':self.symbol,'strategyFamily':'SCALP','side':'PE','underlyingEntry':25000,'underlyingStop':25100,'underlyingTarget':24900,'hardOptionStop':220,'rr':1,'score':90,'setupId':'SAME_SETUP'}
        class FakeMarket:
            def session_open(self):return True
            def current(self):return {'tickets':{'SCALP_MANUAL':outer.ticket,'SCALP_AUTO':outer.ticket},'snapshot':{}}
        self.market=FakeMarket();self.runtime=Runtime(self.execution,self.manager,self.feed,self.market,clock=lambda:self.now)
    def tearDown(self):self.temp.cleanup()
    def entry(self):
        id=str(uuid.uuid4());plan=self.runtime.prepare(id,'SCALP');result=self.runtime.submit(id);return id,plan,result
    def test_server_selects_symbol_sizes_amount_and_confirms_stop(self):
        id,plan,result=self.entry()
        self.assertEqual((plan['lots'],plan['payload']['qty'],plan['premiumCost']),(2,130,29900))
        self.assertTrue(result['protectionConfirmed']);self.assertEqual(result['state'],'MANAGING')
        self.assertEqual(self.broker.calls(),2)
    def test_disabled_gate_places_no_orders(self):
        self.orders.enabled=False;id=str(uuid.uuid4());self.runtime.prepare(id,'SCALP')
        with self.assertRaisesRegex(ValueError,'DISABLED'):self.runtime.submit(id)
        self.assertEqual(self.broker.calls(),0)
    def test_actual_quotes_not_browser_prices_and_fresh_structure_rechecked(self):
        id=str(uuid.uuid4());self.runtime.prepare(id,'SCALP');self.ticket={**self.ticket,'underlyingStop':25200}
        with self.assertRaisesRegex(ValueError,'PLAN_CHANGED'):self.runtime.submit(id)
        self.assertEqual(self.broker.calls(),0)
    def test_manual_exit_and_replay_one_journal_exit(self):
        id,_,_=self.entry();self.quote.update(bid=240,ask=240)
        self.assertEqual(self.runtime.request_exit(id)['state'],'CLOSED');before=self.broker.calls()
        self.assertEqual(self.runtime.request_exit(id)['state'],'CLOSED')
        self.assertEqual(self.broker.calls(),before);self.assertEqual(self.journal.health()['events'],2)
    def test_restart_continuous_trail_and_final_replay(self):
        id,_,_=self.entry();self.quote.update(bid=260,ask=260);self.now=time.time();self.runtime.cycle()
        self.runtime=Runtime(self.execution,Manager(self.execution,self.journal),self.feed,self.market,clock=lambda:self.now)
        self.quote.update(bid=240,ask=240);self.now=time.time();self.runtime.cycle();before=self.broker.calls()
        self.runtime.cycle();self.assertEqual(self.broker.calls(),before)
        self.assertEqual(self.manager.get(id)['state'],'CLOSED');self.assertEqual(self.journal.health()['trades'],1)
    def test_broker_stop_reconciles_even_when_feed_disconnected(self):
        id,_,_=self.entry();stop=self.orders.get(self.manager.get(id)['stop_intent']);self.broker.fill_stop(stop['broker_id'],219)
        self.feed.stale=True;before=self.broker.calls();self.runtime.cycle()
        self.assertEqual(self.runtime.status()['positions'],[]);self.assertEqual(self.broker.calls(),before)
        self.assertEqual(self.journal.health()['events'],2)
    def test_one_active_slot_per_strategy_and_no_daily_limit(self):
        self.entry()
        with self.assertRaisesRegex(ValueError,'ACTIVE'):self.runtime.prepare(str(uuid.uuid4()),'SCALP')
        self.assertNotIn('dailyLimit',self.runtime.settings())
    def test_expired_plan_removed_from_subscriptions_and_cannot_submit(self):
        id=str(uuid.uuid4());self.runtime.prepare(id,'SCALP');self.now+=16;self.runtime.cycle()
        with self.assertRaisesRegex(ValueError,'EXPIRED'):self.runtime.submit(id)
        self.assertEqual(self.broker.calls(),0)
    def test_auto_entry_once_per_setup_and_defaults_off(self):
        self.runtime.cycle();self.assertEqual(self.broker.calls(),0)
        self.runtime.set_settings({'scalpAutoOpen':True});self.runtime.cycle();self.assertEqual(self.broker.calls(),2)
        self.runtime.cycle();self.assertEqual(self.broker.calls(),2)
    def test_journal_outage_does_not_prevent_protected_position_exit(self):
        id,_,_=self.entry();real=self.journal.event
        self.journal.event=lambda event:(_ for _ in ()).throw(ValueError('JOURNAL_DOWN'))
        self.quote.update(bid=260,ask=260);self.now=time.time();self.runtime.cycle()
        self.quote.update(bid=240,ask=240);self.now=time.time()
        try:self.runtime.cycle()
        except ValueError:pass
        self.assertEqual(self.manager.get(id)['state'],'CLOSED')
        before=self.broker.calls();self.journal.event=real;self.runtime.cycle();self.runtime.cycle()
        self.assertEqual(self.broker.calls(),before);self.assertEqual(self.journal.health()['trades'],1)
        self.assertEqual(self.journal.health()['events'],2)
    def test_partial_entry_cancelled_then_only_filled_lot_is_protected(self):
        original=self.broker.place_order
        def partial(payload):
            result=original(payload)
            if payload['side']==1:
                row=self.broker.orders_by_tag('1:'+payload['orderTag'])[0]
                row.update(status=6,filledQty=65,remainingQuantity=65)
                self.broker._write(row,'PARTIAL_ENTRY')
            return result
        self.broker.place_order=partial
        id,_,result=self.entry();self.assertEqual(result['filledQuantity'],65)
        stop=self.orders.get(self.manager.get(id)['stop_intent']);self.assertEqual(json.loads(stop['payload'])['qty'],65)
        self.assertEqual(self.broker.calls('CANCEL'),1)
        with self.journal.connection() as db:trade=json.loads(db.execute('SELECT payload FROM trades WHERE id=?',(id,)).fetchone()[0])
        self.assertEqual((trade['lots'],trade['quantity'],trade['premiumCost']),(1,65,14950))
    def test_uncertain_entry_cancellation_is_not_sent_twice(self):
        original=self.broker.place_order
        def pending(payload):
            result=original(payload)
            if payload['side']==1:
                row=self.broker.orders_by_tag('1:'+payload['orderTag'])[0]
                row.update(status=6,filledQty=0,remainingQuantity=row['qty']);self.broker._write(row,'PENDING_ENTRY')
            return result
        self.broker.place_order=pending;id,_,result=self.entry();self.assertEqual(result['state'],'PENDING')
        calls=[];self.broker.cancel_order=lambda id:(calls.append(id) or {'s':'ok','id':id})
        self.now+=4;self.runtime.cycle()
        self.runtime=Runtime(self.execution,Manager(self.execution,self.journal),self.feed,self.market,clock=lambda:self.now)
        self.runtime.cycle();self.assertEqual(len(calls),1);self.assertEqual(self.broker.calls(),1)
        self.assertTrue(self.runtime.last_error)
    def test_wrong_broker_stop_price_is_never_called_confirmed(self):
        original=self.broker.place_order
        def wrong(payload):
            result=original(payload)
            if payload['type']==4:
                row=self.broker.orders_by_tag('1:'+payload['orderTag'])[0];row['stopPrice']=210;self.broker._write(row,'WRONG_STOP')
            return result
        self.broker.place_order=wrong
        with self.assertRaisesRegex(ValueError,'PRICE_MISMATCH'):self.entry()
        self.assertTrue(self.runtime.last_error)
    def test_http_owner_replay_injection_and_disabled_submit(self):
        key='a'*40;owner='b'*64;http=server(self.runtime,key,owner);thread=threading.Thread(target=http.serve_forever,daemon=True);thread.start()
        def call(action,payload,principal=owner,nonce=None):
            path='/monitor/orders/'+action;body=json.dumps(payload).encode();stamp=str(int(time.time()));nonce=nonce or uuid.uuid4().hex
            req=urllib.request.Request('http://127.0.0.1:'+str(http.server_port)+path,body,headers={'x-iom-time':stamp,'x-iom-nonce':nonce,'x-iom-owner':principal,'x-iom-signature':signature(key,stamp,nonce,principal,path,body)})
            try:
                with urllib.request.urlopen(req) as r:return r.status,json.load(r)
            except urllib.error.HTTPError as r:return r.code,json.load(r)
        try:
            self.assertEqual(call('status',{},principal='c'*64)[0],403)
            nonce=uuid.uuid4().hex;self.assertEqual(call('status',{},nonce=nonce)[0],200);self.assertEqual(call('status',{},nonce=nonce)[0],409)
            self.assertEqual(call('prepare',{'intentId':str(uuid.uuid4()),'strategy':'SCALP','symbol':'EVIL','qty':999})[0],409)
            id=str(uuid.uuid4());self.assertEqual(call('prepare',{'intentId':id,'strategy':'SCALP'})[0],200)
            self.orders.enabled=False;self.assertEqual(call('submit',{'intentId':id})[0],409);self.assertEqual(self.broker.calls(),0)
        finally:http.shutdown();http.server_close();thread.join()

class RestTests(unittest.TestCase):
    def test_default_gate_blocks_all_mutation_methods_before_network(self):
        class Trap:
            def open(self,*a,**kw):raise AssertionError('network')
        client=FyersRest('TRADINGAPP-200','x'*40,opener=Trap())
        for fn in (client.place_order,client.modify_order,client.cancel_order):
            with self.assertRaisesRegex(ValueError,'DISABLED'):fn(data={'id':'fake'})
    def test_master_string_freeze_and_expiry_are_validated_not_guessed(self):
        market=Market(None,lambda:{},clock=lambda:1000);market.master_at=1000
        market.master={'NSE:NIFTYTESTCE':{'minLotSize':65,'qtyFreeze':'1755','tickSize':.05,'expiryDate':'2000','tradeStatus':1}}
        contract=market.contract('NSE:NIFTYTESTCE');self.assertEqual(contract['max_quantity'],1755);self.assertEqual(contract['lot_size'],65)
        del market.master['NSE:NIFTYTESTCE']['qtyFreeze']
        with self.assertRaisesRegex(ValueError,'UNVERIFIED'):market.contract('NSE:NIFTYTESTCE')

if __name__=='__main__':unittest.main()

class LedgerBackupTests(unittest.TestCase):
    def test_daily_ledger_backup_is_consistent_and_private(self):
        import sqlite3
        from unittest.mock import patch
        import order_host
        with tempfile.TemporaryDirectory() as directory:
            root=Path(directory);source=root/'orders.sqlite3'
            with sqlite3.connect(source) as db:db.execute('CREATE TABLE receipt(id TEXT PRIMARY KEY)');db.execute("INSERT INTO receipt VALUES ('durable-owned-exit')")
            with patch.object(order_host,'DATA',root):result=order_host.backup()
            backup=root/'backups'/result['ledgerBackup']
            self.assertEqual(backup.stat().st_mode & 0o777,0o600)
            with sqlite3.connect(backup) as db:
                self.assertEqual(db.execute('PRAGMA integrity_check').fetchone()[0],'ok');self.assertEqual(db.execute('SELECT id FROM receipt').fetchone()[0],'durable-owned-exit')
