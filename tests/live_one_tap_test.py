"""One-tap manual buy: one tap, at most one order, never dearer than shown. Artificial broker only."""
import json
import sys
import threading
import time
import unittest
import urllib.error
import urllib.request
import uuid
from pathlib import Path
sys.path.insert(0,str(Path(__file__).resolve().parent));sys.path.insert(0,str(Path(__file__).resolve().parents[1]/'aws/live'))
import live_runtime_test as base
from live_safety_test import Case
from bridge import signature
from order_host import server

class OneTapCase(Case):
    def shown(self):
        return self.runtime.preview(30000)['trades']['SCALP']
    def buy(self,id=None,shown=None,**change):
        shown=shown or self.shown();id=id or str(uuid.uuid4())
        values={'symbol':shown['symbol'],'quantity':shown['quantity'],'max_price':shown['buyPrice'],'amount':30000,**change}
        return self.runtime.buy(id,'SCALP',**values)
    def requests(self):
        with self.orders.transaction() as db:return [dict(r) for r in db.execute('SELECT * FROM live_requests')]

class PreviewTests(OneTapCase):
    def test_shows_option_quantity_and_cost_without_saving_or_sending_anything(self):
        def no_funds_call():raise AssertionError('preview must not call the broker')
        self.broker.available_funds=no_funds_call
        before=self.runtime.settings()
        shown=self.shown()
        self.assertEqual((shown['available'],shown['symbol'],shown['quantity'],shown['lots'],shown['buyPrice'],shown['premiumCost'],shown['initialStop']),
                         (True,self.symbol,130,2,230,29900,220))
        self.assertEqual((self.broker.calls(),self.requests(),self.runtime.settings()),(0,[],before))
    def test_each_strategy_says_why_it_cannot_be_bought(self):
        trades=self.runtime.preview(30000)['trades']
        self.assertEqual(trades['CORE'],{'available':False,'reason':'MENTOR_ENTRY_NOT_READY'})
        self.assertEqual(self.runtime.preview(100)['trades']['SCALP'],{'available':False,'reason':'AMOUNT_CANNOT_BUY_ONE_LOT'})
        self.entry()
        self.assertEqual(self.shown(),{'available':False,'reason':'STRATEGY_POSITION_ALREADY_ACTIVE'})
    def test_amount_above_server_limit_is_refused(self):
        with self.assertRaisesRegex(ValueError,'AMOUNT_LIMIT'):self.runtime.preview(30001)

class OneTapTests(OneTapCase):
    def test_one_call_buys_what_was_shown_and_confirms_the_stop(self):
        result=self.buy()
        self.assertEqual((result['state'],result['protectionConfirmed'],result['symbol'],result['quantity']),('MANAGING',True,self.symbol,130))
        self.assertEqual(self.broker.calls(),2) # one buy and its stop
    def test_same_tap_delivered_twice_sends_one_order(self):
        id=str(uuid.uuid4());shown=self.shown();self.buy(id,shown);before=self.broker.calls()
        again=self.buy(id,shown)
        self.assertEqual((again['state'],again['duplicate'],self.broker.calls()),('MANAGING',True,before))
    def test_two_copies_arriving_together_send_one_order(self):
        id=str(uuid.uuid4());shown=self.shown();results=[];errors=[]
        def tap():
            try:results.append(self.buy(id,shown))
            except Exception as error:errors.append(error)
        threads=[threading.Thread(target=tap) for _ in range(4)]
        for thread in threads:thread.start()
        for thread in threads:thread.join()
        self.assertEqual((errors,len(results),self.broker.calls()),([],4,2))
        self.assertEqual(sum(not r.get('duplicate') for r in results),1)
    def test_second_tap_from_another_screen_is_refused_while_trade_is_open(self):
        shown=self.shown();self.buy(shown=shown);before=self.broker.calls()
        with self.assertRaisesRegex(ValueError,'DUPLICATE_TAP|ALREADY_ACTIVE'):self.buy(shown=shown)
        self.assertEqual(self.broker.calls(),before)
    def test_quick_second_tap_is_refused_even_if_first_trade_already_ended(self):
        shown=self.shown();first=self.buy(shown=shown);self.runtime.request_exit(first['id']);before=self.broker.calls()
        with self.assertRaisesRegex(ValueError,'DUPLICATE_TAP'):self.buy(shown=shown)
        self.assertEqual(self.broker.calls(),before)
        self.now+=4;self.tick(230);self.assertEqual(self.buy()['state'],'MANAGING') # no daily limit
    def test_never_pays_more_than_the_price_on_screen(self):
        shown=self.shown();self.tick(230.05)
        with self.assertRaisesRegex(ValueError,'PRICE_MOVED'):self.buy(shown=shown)
        self.assertEqual(self.broker.calls(),0)
        self.assertEqual(self.runtime.status()['positions'],[])
        self.assertEqual(self.buy()['state'],'MANAGING') # a fresh look can buy at once
    def test_a_cheaper_price_is_allowed(self):
        shown=self.shown();self.tick(229.95)
        self.assertEqual(self.buy(shown=shown)['state'],'MANAGING')
    def test_different_option_or_quantity_than_shown_sends_nothing(self):
        for change in ({'symbol':'NSE:NIFTYTEST25500PE'},{'quantity':65}):
            with self.assertRaisesRegex(ValueError,'TRADE_CHANGED'):self.buy(**change)
        self.assertEqual((self.broker.calls(),self.runtime.status()['positions']),(0,[]))
    def test_a_refused_tap_stays_refused_if_delivered_again(self):
        id=str(uuid.uuid4());shown=self.shown();self.tick(230.05)
        with self.assertRaisesRegex(ValueError,'PRICE_MOVED'):self.buy(id,shown)
        self.tick(230)
        self.assertEqual(self.buy(id,shown),{'id':id,'state':'NOT_SENT','duplicate':True})
        self.assertEqual(self.broker.calls(),0)
    def test_buying_off_refuses_and_changes_nothing(self):
        shown=self.shown();self.orders.enabled=False;before=self.runtime.settings()
        with self.assertRaisesRegex(ValueError,'REAL_MONEY_DISABLED'):self.buy(shown=shown,amount=20000)
        self.assertEqual((self.broker.calls(),self.requests(),self.runtime.settings()),(0,[],before))
    def test_paused_entries_refuse_with_nothing_sent(self):
        shown=self.shown();self.orders.stop()
        with self.assertRaises(ValueError):self.buy(shown=shown)
        self.assertEqual((self.broker.calls(),self.runtime.status()['positions']),(0,[]))
    def test_server_safety_checks_still_refuse(self):
        shown=self.shown();self.ticket={**self.ticket,'underlyingStop':24900}
        with self.assertRaisesRegex(ValueError,'STRUCTURAL_STOP'):self.buy(shown=shown)
        self.assertEqual(self.broker.calls(),0)
    def test_broker_check_failure_before_sending_says_no_order_sent(self):
        shown=self.shown()
        def offline():raise TimeoutError()
        self.broker.available_funds=offline
        with self.assertRaisesRegex(ValueError,'BROKER_CHECK_FAILED_NO_ORDER'):self.buy(shown=shown)
        self.assertEqual((self.broker.calls(),self.runtime.status()['positions']),(0,[]))
    def test_failure_after_the_order_left_is_reported_as_unclear(self):
        shown=self.shown();id=str(uuid.uuid4())
        def broken(*a):raise ValueError('ANY_LATER_FAILURE')
        self.runtime._entry_progress=broken
        self.assertEqual(self.buy(id,shown),{'id':id,'state':'UNCLEAR','symbol':self.symbol,'quantity':130})
        self.assertEqual(len(self.runtime.status()['positions']),1) # stays visible and locked
        del self.runtime._entry_progress
        self.assertTrue(self.buy(id,shown)['duplicate'])
        self.assertEqual(len([r for r in self.broker._rows() if r['side']==1]),1)
    def test_reused_identity_for_other_strategy_is_rejected(self):
        id=str(uuid.uuid4());shown=self.shown();self.buy(id,shown)
        with self.assertRaisesRegex(ValueError,'INTENT_REUSED'):
            self.runtime.buy(id,'CORE',shown['symbol'],130,230,30000)
    def test_bad_values_are_rejected(self):
        shown=self.shown()
        for change in ({'quantity':True},{'quantity':0},{'quantity':'130'},{'max_price':0},{'max_price':'x'},{'symbol':5}):
            with self.assertRaises(ValueError,msg=str(change)):self.buy(shown=shown,**change)
        self.assertEqual(self.broker.calls(),0)

class OneTapHttpTests(OneTapCase):
    def test_signed_host_actions_and_plain_reason(self):
        key='a'*40;owner='b'*64;http=server(self.runtime,key,owner);thread=threading.Thread(target=http.serve_forever,daemon=True);thread.start()
        def call(action,payload):
            path='/monitor/orders/'+action;body=json.dumps(payload).encode();stamp=str(int(time.time()));nonce=uuid.uuid4().hex
            req=urllib.request.Request('http://127.0.0.1:'+str(http.server_port)+path,body,headers={'x-iom-time':stamp,'x-iom-nonce':nonce,'x-iom-owner':owner,'x-iom-signature':signature(key,stamp,nonce,owner,path,body)})
            try:
                with urllib.request.urlopen(req) as r:return r.status,json.load(r)
            except urllib.error.HTTPError as r:return r.code,json.load(r)
        try:
            status,data=call('preview',{'tradeAmount':30000});self.assertEqual(status,200)
            shown=data['preview']['trades']['SCALP'];self.assertEqual(shown['quantity'],130)
            order={'intentId':str(uuid.uuid4()),'strategy':'SCALP','symbol':shown['symbol'],'quantity':130,'maxPrice':shown['buyPrice'],'tradeAmount':30000}
            self.assertEqual(call('buy',{**order,'initialStop':1})[0],409)
            self.tick(230.05);status,data=call('buy',order)
            self.assertEqual((status,data['reason'],self.broker.calls()),(409,'PRICE_MOVED_REFRESH_PLAN',0))
            self.tick(230);status,data=call('buy',{**order,'intentId':str(uuid.uuid4())})
            self.assertEqual((status,data['order']['state'],self.broker.calls()),(200,'MANAGING',2))
        finally:http.shutdown();http.server_close();thread.join()

if __name__=='__main__':unittest.main()
