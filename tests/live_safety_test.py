"""Order-safety faults, each driven by the artificial broker. No network, no real orders."""
import json
import sys
import time
import unittest
import uuid
from datetime import datetime
from pathlib import Path
from zoneinfo import ZoneInfo
sys.path.insert(0,str(Path(__file__).resolve().parent));sys.path.insert(0,str(Path(__file__).resolve().parents[1]/'aws/live'))
import live_runtime_test as base
from manager import Manager
from market import Market
from runtime import Runtime

def ist(hh,mm,ss=0):return datetime(2026,11,25,hh,mm,ss,tzinfo=ZoneInfo('Asia/Kolkata')).timestamp()

class Case(unittest.TestCase):
    tearDown=base.RuntimeTests.tearDown;entry=base.RuntimeTests.entry
    def setUp(self):
        base.RuntimeTests.setUp(self);self.place=self.broker.place_order
    def tick(self,price,advance=0):
        # The shared test clock drives quotes, retry spacing and expiry.
        self.now=max(time.time(),self.now+advance);self.quote.update(bid=price,ask=price,at=self.now)
    def cycle(self,price,advance=6):
        self.tick(price,advance);return self.runtime.cycle()
    def shape(self,match,**change):
        """Make the artificial broker leave matching new orders in a chosen state."""
        def placed(payload):
            result=self.place(payload)
            if match(payload):
                row=self.broker.orders_by_tag('1:'+payload['orderTag'])[0]
                row.update(filledQty=0,remainingQuantity=row['qty'],tradedPrice=0,**change);self.broker._write(row,'SHAPED')
            return result
        self.broker.place_order=placed
    def sells(self):
        return [r for r in self.broker._rows() if r['side']==-1 and r['type']==1]
    def stops(self):
        return [r for r in self.broker._rows() if r['type']==4]
    def held(self):return self.broker.net_quantity(self.symbol)

is_sale=lambda p:p['side']==-1 and p['type']==1
is_stop=lambda p:p['type']==4
is_buy=lambda p:p['side']==1

class StuckEntryTests(Case):
    def test_price_moving_after_review_sends_nothing_and_frees_the_strategy(self):
        id=str(uuid.uuid4());self.runtime.prepare(id,'SCALP');self.tick(230.05)
        with self.assertRaisesRegex(ValueError,'PRICE_MOVED'):self.runtime.submit(id)
        status=self.cycle(230.05)
        self.assertEqual((self.broker.calls(),status['positions'],status['attentionRequired']),(0,[],None))
        self.tick(230);self.entry()
    def test_restart_between_request_and_order_record_is_released(self):
        id=str(uuid.uuid4());self.runtime.prepare(id,'SCALP');self.runtime._state(id,'SUBMIT_REQUESTED')
        status=self.cycle(230)
        self.assertEqual((self.broker.calls(),status['positions'],status['attentionRequired']),(0,[],None))
    def refuse(self,match,error):
        def refused(payload):
            if match(payload):raise ValueError(error)
            return self.place(payload)
        self.broker.place_order=refused
    def test_clearly_refused_buy_is_released_only_after_a_wait(self):
        self.refuse(is_buy,'BROKER_REQUEST_REJECTED_RECONCILE')
        id=str(uuid.uuid4());self.runtime.prepare(id,'SCALP');self.runtime.submit(id)
        self.assertEqual(self.cycle(230,1)['positions'][0]['id'],id)
        self.orders.clock=lambda:time.time()+61
        status=self.cycle(230)
        self.assertEqual((status['positions'],status['attentionRequired']),([],None))
    def test_buy_with_unknown_outcome_stays_locked(self):
        self.refuse(is_buy,'BROKER_REQUEST_UNAVAILABLE_RECONCILE')
        id=str(uuid.uuid4());self.runtime.prepare(id,'SCALP')
        self.runtime.submit(id);self.orders.clock=lambda:time.time()+3600
        status=self.cycle(230)
        self.assertEqual(len(status['positions']),1);self.assertTrue(status['attentionRequired'])
    def test_lost_buy_cancel_is_resent(self):
        self.shape(is_buy,status=6);cancel=self.broker.cancel_order;sent=[]
        def lost(order_id):sent.append(order_id);raise TimeoutError()
        id=str(uuid.uuid4());self.runtime.prepare(id,'SCALP');self.runtime.submit(id)
        self.broker.cancel_order=lost;self.cycle(230)
        self.broker.cancel_order=lambda i:(sent.append(i) or cancel(i));status=self.cycle(230)
        self.assertEqual((len(sent),status['positions']),(2,[]))

class StopTests(Case):
    def test_stop_rejected_once_is_retried_and_confirmed(self):
        seen=[]
        self.shape(lambda p:is_stop(p) and not seen and not seen.append(1),status=5)
        id,_,result=self.entry()
        self.assertEqual((result['state'],result['protectionConfirmed'],len(self.stops())),('MANAGING',True,2))
    def test_stop_rejected_twice_records_the_position_and_sells(self):
        self.shape(is_stop,status=5);id,_,result=self.entry()
        self.assertFalse(result['protectionConfirmed']);self.assertEqual(self.manager.get(id)['exit_reason'],'PROTECTION_FAILED')
        self.cycle(229)
        self.assertEqual((self.manager.get(id)['state'],self.held(),len(self.stops())),('CLOSED',0,2))
        self.assertEqual(self.journal.health()['trades'],1)
    def test_stop_refused_outright_is_retried_then_the_position_is_sold(self):
        def refused(payload):
            if is_stop(payload):raise ValueError('BROKER_REQUEST_REJECTED_RECONCILE')
            return self.place(payload)
        self.broker.place_order=refused;id=str(uuid.uuid4());self.runtime.prepare(id,'SCALP')
        with self.assertRaises(ValueError):self.runtime.submit(id)
        self.assertEqual(self.manager.get(id)['state'],'PROTECTING')
        for seconds in (11,22,23):
            self.orders.clock=lambda s=seconds:time.time()+s
            status=self.cycle(230)
        self.assertEqual((self.manager.get(id)['exit_reason'],self.manager.get(id)['state'],self.held()),('PROTECTION_FAILED','CLOSED',0))
    def test_fill_already_below_the_stop_sells_instead_of_getting_stuck(self):
        self.ticket={**self.ticket,'hardOptionStop':229}
        def lower_fill(payload):
            if is_buy(payload):self.quote['ask']=228
            return self.place(payload)
        self.broker.place_order=lower_fill
        id,_,_=self.entry();self.cycle(228)
        self.assertEqual((self.manager.get(id)['state'],self.held(),len(self.stops())),('CLOSED',0,0))
    def test_lost_stop_cancel_is_resent_then_sale_completes(self):
        id,_,_=self.entry();cancel=self.broker.cancel_order;sent=[]
        def lost(order_id):sent.append(order_id);raise TimeoutError()
        self.broker.cancel_order=lost;self.tick(240)
        with self.assertRaises(ValueError):self.runtime.request_exit(id)
        self.assertEqual(len(self.sells()),0)
        self.broker.cancel_order=lambda i:(sent.append(i) or cancel(i))
        self.cycle(239)
        self.assertEqual((len(sent),self.manager.get(id)['state'],self.held()),(2,'CLOSED',0))
    def test_refused_trail_change_does_not_block_later_ones(self):
        id,_,_=self.entry();real=self.broker.modify_stop
        self.broker.modify_stop=lambda *a:{'s':'error'}
        self.cycle(260);self.broker.modify_stop=real
        status=self.cycle(300)
        stop=self.orders.get(self.manager.get(id)['stop_intent'])
        self.assertGreater(self.manager.protection.book(stop['id'])[1]['stopPrice'],220)
        self.assertIsNone(status['attentionRequired'])
    def test_price_through_an_unfilled_stop_triggers_a_sale_after_a_pause(self):
        id,_,_=self.entry();self.cycle(219,1)
        self.assertEqual(len(self.sells()),0)
        self.cycle(180,4);self.cycle(180,1)
        self.assertEqual((self.manager.get(id)['state'],self.held()),('CLOSED',0))
    def test_stop_cancelled_at_the_broker_leads_to_a_sale(self):
        id,_,_=self.entry();row=self.stops()[0];row.update(status=1);self.broker._write(row,'OUTSIDE_CANCEL')
        self.cycle(231);self.cycle(231)
        self.assertEqual((self.manager.get(id)['exit_reason'],self.held()),('PROTECTION_LOST',0))

class FailedSaleTests(Case):
    def limits(self):
        rows={r['orderTag']:r for r in self.sells()}
        return sorted((r['limitPrice'] for r in rows.values()),reverse=True)
    def test_unfilled_sale_steps_down_below_the_fresh_bid(self):
        id,_,_=self.entry();self.shape(is_sale,status=6);self.tick(240);self.runtime.request_exit(id)
        self.cycle(240,1);self.assertEqual(len(self.sells()),1)
        self.cycle(240,5);self.cycle(240,6);self.cycle(240,10)
        self.assertEqual(self.limits(),[240,237.6,235.2,228])
        self.assertEqual(sum(r['status']==6 for r in self.sells()),1)
        self.assertEqual(self.runtime.last_error,'OWNED_POSITION_REQUIRES_ATTENTION')
        self.broker.place_order=self.place;self.cycle(200)
        self.assertEqual((self.manager.get(id)['state'],self.held()),('CLOSED',0))
        self.assertEqual(self.journal.health()['trades'],1)
    def test_repeated_rejections_slow_down(self):
        id,_,_=self.entry();self.shape(is_sale,status=5);self.tick(240);self.runtime.request_exit(id)
        for _ in range(20):self.cycle(240)
        self.assertLessEqual(len(self.sells()),10)
        self.assertEqual(self.held(),130)
    def test_rejected_sale_is_retried_after_a_pause(self):
        id,_,_=self.entry();self.shape(is_sale,status=5);self.tick(240);self.runtime.request_exit(id)
        self.cycle(240,1);self.assertEqual(len(self.sells()),1)
        self.broker.place_order=self.place;self.cycle(240,5)
        self.assertEqual((len(self.sells()),self.manager.get(id)['state'],self.held()),(2,'CLOSED',0))
    def test_retry_never_sends_a_second_sale_while_the_first_cannot_be_cancelled(self):
        id,_,_=self.entry();self.shape(is_sale,status=6);self.tick(240);self.runtime.request_exit(id)
        self.broker.cancel_order=lambda i:{'s':'ok','id':i}
        for _ in range(5):self.cycle(200)
        self.assertEqual(len(self.sells()),1);self.assertTrue(self.runtime.last_error)
    def test_sale_with_unknown_outcome_is_not_repeated(self):
        id,_,_=self.entry()
        def vanish(payload):
            if is_sale(payload):raise TimeoutError()
            return self.place(payload)
        self.broker.place_order=vanish;self.tick(240);self.runtime.request_exit(id)
        self.broker.place_order=self.place;self.orders.clock=lambda:time.time()+3600
        for _ in range(4):self.cycle(240)
        self.assertEqual(len(self.sells()),0);self.assertTrue(self.runtime.last_error)
    def test_partly_filled_sale_retries_only_the_remainder_and_survives_restart(self):
        id,_,_=self.entry();self.shape(is_sale,status=6);self.tick(240);self.runtime.request_exit(id)
        row=self.sells()[0];row.update(filledQty=65,remainingQuantity=65,tradedPrice=240);self.broker._write(row,'PART')
        self.broker.place_order=self.place
        self.runtime=Runtime(self.execution,Manager(self.execution,self.journal),self.feed,self.market,clock=lambda:self.now,day_clock=self.runtime.day_clock)
        self.cycle(230)
        self.assertEqual((sorted(r['qty'] for r in self.sells()),self.held()),([65,130],0))
        self.assertEqual(self.journal.health()['trades'],1)
    def test_old_price_leaves_the_broker_stop_in_place(self):
        id,_,_=self.entry();self.runtime.manager._request_exit(id,'USER_EXIT')
        self.quote['at']=self.now-10
        with self.assertRaisesRegex(ValueError,'STALE_EXIT_QUOTE'):self.manager.pulse(id,{},{})
        self.assertEqual((self.stops()[0]['status'],len(self.sells())),(6,0))

class EndOfDayTests(Case):
    def at(self,*clock):self.runtime.day_clock=lambda:ist(*clock)
    def test_nothing_is_forced_before_1518(self):
        id,_,_=self.entry();self.at(15,17,59);self.cycle(230)
        self.assertEqual((self.manager.get(id)['state'],self.held()),('MANAGING',130))
    def test_open_trade_is_sold_from_1518_even_without_the_live_feed(self):
        id,_,_=self.entry();self.at(15,18);self.feed.stale=True;self.cycle(231);self.cycle(231)
        self.assertEqual((self.manager.get(id)['exit_reason'],self.manager.get(id)['state'],self.held()),('END_OF_DAY','CLOSED',0))
    def test_an_earlier_exit_reason_is_kept(self):
        id,_,_=self.entry();self.shape(is_sale,status=6);self.tick(240);self.runtime.request_exit(id)
        self.at(15,18);self.cycle(240,1)
        self.assertEqual(self.manager.get(id)['exit_reason'],'USER_EXIT')

class ReadingTests(Case):
    def test_status_warns_when_the_strategy_reading_is_old_during_a_trade(self):
        self.entry();self.cycle(230,1);self.assertFalse(self.runtime.status()['strategyReadingStale'])
        current=self.market.current
        self.market.current=lambda:(_ for _ in ()).throw(ValueError('STRATEGY_STALE'))
        self.cycle(230,1);self.assertFalse(self.runtime.status()['strategyReadingStale'])
        self.assertTrue(self.cycle(230,16)['strategyReadingStale'])
        self.market.current=current;self.assertFalse(self.cycle(230,1)['strategyReadingStale'])
    def test_latest_reading_is_available_while_the_next_one_loads(self):
        import threading
        started,release=threading.Event(),threading.Event()
        class Slow:
            def market(self,path,params):started.set();release.wait(5);raise ValueError('END_TEST')
        market=Market(Slow(),lambda:{},clock=lambda:1000);market.master_at=1000;market.master={'SAMPLE':{}}
        market.latest={'generatedAt':datetime.fromtimestamp(999,ZoneInfo('UTC')).isoformat()}
        def run():
            try:market.refresh()
            except ValueError:pass
        worker=threading.Thread(target=run);worker.start();self.assertTrue(started.wait(2))
        got=[];reader=threading.Thread(target=lambda:got.append(market.current()));reader.start();reader.join(1)
        blocked=reader.is_alive();release.set();worker.join();reader.join()
        self.assertFalse(blocked);self.assertEqual(len(got),1)
    def test_reading_refresh_is_paced_to_stay_inside_its_12_second_life(self):
        from order_host import refresh_pause
        self.assertEqual([refresh_pause(t) for t in (0.5,3,9)],[4.5,2,1])

class OffSwitchTests(Case):
    def off(self):self.orders.enabled=False
    def test_held_trade_can_still_be_sold_when_off(self):
        id,_,_=self.entry();self.off();self.tick(240)
        self.assertEqual((self.runtime.request_exit(id)['state'],self.held()),('CLOSED',0))
    def test_stop_still_trails_and_strategy_exit_still_sells_when_off(self):
        id,_,_=self.entry();self.off();self.cycle(300)
        stop=self.orders.get(self.manager.get(id)['stop_intent'])
        self.assertGreater(self.manager.protection.book(stop['id'])[1]['stopPrice'],220)
        self.cycle(240)
        self.assertEqual((self.manager.get(id)['state'],self.held()),('CLOSED',0))
    def test_a_buy_that_filled_just_before_off_still_gets_its_stop(self):
        def fills_then_off(payload):
            result=self.place(payload)
            if is_buy(payload):self.off()
            return result
        self.broker.place_order=fills_then_off;id,_,result=self.entry()
        self.assertEqual((result['protectionConfirmed'],len(self.stops())),(True,1))
    def test_no_new_buy_by_hand_or_automatically_when_off(self):
        self.off();self.runtime.set_settings({'scalpAutoOpen':True,'mentorAutoOpen':True});self.cycle(230)
        id=str(uuid.uuid4());self.runtime.prepare(id,'SCALP')
        with self.assertRaisesRegex(ValueError,'REAL_MONEY_DISABLED'):self.runtime.submit(id)
        with self.assertRaisesRegex(ValueError,'DISABLED'):
            self.orders.submit(str(uuid.uuid4()),self.execution.planner.plan(self.symbol,30000,100000)['payload'])
        self.assertEqual(self.broker.calls(),0)
        status=self.runtime.status();self.assertEqual((status['realMoneyEnabled'],status['exitsAllowed']),(False,True))
    def test_no_stop_is_sent_when_off_if_fyers_no_longer_holds_the_trade(self):
        def sold_outside(payload):
            result=self.place(payload)
            if is_buy(payload):self.off();self.broker.net_quantity=lambda symbol:0
            return result
        self.broker.place_order=sold_outside;id=str(uuid.uuid4());self.runtime.prepare(id,'SCALP')
        with self.assertRaisesRegex(ValueError,'BROKER_POSITION_MISMATCH'):self.runtime.submit(id)
        self.cycle(230);self.assertEqual(len(self.stops()),0);self.assertTrue(self.runtime.last_error)
    def test_full_lock_sends_nothing_at_all(self):
        id,_,_=self.entry();self.off();self.orders.exits_enabled=False;before=self.broker.calls();self.tick(240)
        with self.assertRaises(ValueError):self.runtime.request_exit(id)
        self.assertFalse(self.runtime.status()['exitsAllowed'])
        self.assertEqual((len(self.sells()),self.held()),(0,130))
    def test_broker_adapter_refuses_buys_but_passes_sales_when_off(self):
        from fyers_broker import FyersBroker
        sent=[]
        class Client:
            def place_order(self,data):sent.append(data['side']);return {'s':'ok','id':'X'}
        broker=FyersBroker(Client(),send_enabled=True,entries_enabled=False)
        for side in (1,None,0):
            with self.assertRaisesRegex(ValueError,'DISABLED'):broker.place_order({'side':side})
        broker.place_order({'side':-1});self.assertEqual(sent,[-1])
    def test_host_allows_exits_when_off_only_for_a_previously_approved_account(self):
        import order_host
        from unittest import mock
        def build(config):
            made={}
            def keep(name):
                def make(*a,**k):made[name]=(a,k);return mock.MagicMock(**({'exits_enabled':None} if name=='orders' else {}))
                return make
            market=mock.MagicMock();market.master={'X':{'qtyFreeze':'1755'}}
            holder={}
            def orders(*a,**k):holder['orders']=mock.MagicMock();holder['enabled']=k['enabled'];return holder['orders']
            with mock.patch.multiple(order_host,FyersRest=keep('client'),FyersBroker=keep('broker'),Orders=orders,verify_owner=lambda *a:'OWNER',
                    Market=lambda *a,**k:market,Feed=mock.MagicMock(),Execution=mock.MagicMock(),Manager=mock.MagicMock(),Runtime=mock.MagicMock(),
                    JournalBridge=mock.MagicMock(),startup=lambda stage,call:call()):
                order_host.build({'version':1,'maxTradeAmount':30000,'feeReserve':100,**config},{'appId':'APP','accessToken':'t','ownerProof':'p'},'s')
            return (made['client'][1]['send_enabled'],made['broker'][1]['send_enabled'],made['broker'][1]['entries_enabled'],holder['enabled'],holder['orders'].exits_enabled)
        self.assertEqual(build({'realMoneyEnabled':False}),(False,False,False,False,False))
        self.assertEqual(build({'realMoneyEnabled':False,'operatorApprovedAppId':'OTHER'}),(False,False,False,False,False))
        self.assertEqual(build({'realMoneyEnabled':False,'operatorApprovedAppId':'APP'}),(True,True,False,False,True))
        self.assertEqual(build({'realMoneyEnabled':True,'operatorApprovedAppId':'APP'}),(True,True,True,True,True))
        with self.assertRaisesRegex(ValueError,'SEPARATE_OPERATOR_APPROVAL'):build({'realMoneyEnabled':True})

class UnconfirmedStopTests(Case):
    def lost_stop(self):
        """The stop request times out and FYERS does not show it (yet)."""
        held=[]
        def placed(payload):
            if is_stop(payload):held.append(payload);raise TimeoutError()
            return self.place(payload)
        self.broker.place_order=placed;id=str(uuid.uuid4());self.runtime.prepare(id,'SCALP')
        with self.assertRaises(ValueError):self.runtime.submit(id)
        return id,held
    def odd_stop(self):
        """A stop rests at the broker, but at a price that cannot be confirmed."""
        def placed(payload):
            result=self.place(payload)
            if is_stop(payload):
                row=self.stops()[0];row.update(stopPrice=219.5);self.broker._write(row,'ODD')
            return result
        self.broker.place_order=placed;id=str(uuid.uuid4());self.runtime.prepare(id,'SCALP')
        with self.assertRaisesRegex(ValueError,'PRICE_MISMATCH'):self.runtime.submit(id)
        return id
    def nifty(self,value):
        real=type(self.feed).pair
        self.feed.pair=lambda symbol:{**real(self.feed,symbol),'nifty':value}
    def test_warns_and_sends_nothing_more_while_unconfirmed(self):
        id,held=self.lost_stop();status=self.cycle(231)
        self.assertEqual((self.manager.get(id)['state'],len(held),len(self.sells())),('PROTECTING',1,0))
        self.assertTrue(status['attentionRequired'])
    def test_strategy_exit_is_noticed_but_held_back_until_the_old_stop_is_gone(self):
        id,held=self.lost_stop();self.nifty(25101);self.cycle(228);self.cycle(228)
        self.assertEqual(self.manager.get(id)['exit_reason'],'STRUCTURE_INVALIDATED')
        self.assertEqual((len(held),len(self.sells()),self.held()),(1,0,130));self.assertTrue(self.runtime.last_error)
        self.broker.place_order=self.place;self.place(held[0]);self.cycle(228)
        self.assertEqual((self.manager.get(id)['state'],self.held(),self.stops()[0]['status']),('CLOSED',0,1))
    def test_a_stop_that_appears_late_is_confirmed(self):
        id,held=self.lost_stop();self.cycle(231);self.broker.place_order=self.place;self.place(held[0])
        status=self.cycle(231)
        self.assertEqual((self.manager.get(id)['state'],status['attentionRequired']),('MANAGING',None))
    def test_exit_sells_once_an_odd_resting_stop_is_confirmed_cancelled(self):
        id=self.odd_stop();self.nifty(25101);self.cycle(228)
        self.assertEqual((self.manager.get(id)['state'],self.held(),len(self.sells())),('CLOSED',0,1))
    def test_no_sale_while_the_odd_stop_cannot_be_cancelled(self):
        id=self.odd_stop();self.nifty(25101);self.broker.cancel_order=lambda i:{'s':'ok','id':i}
        for _ in range(4):self.cycle(228)
        self.assertEqual((self.held(),len(self.sells())),(130,0));self.assertTrue(self.runtime.last_error)
    def test_price_below_the_intended_stop_is_acted_on_while_unconfirmed(self):
        id=self.odd_stop();self.cycle(215,1);self.assertEqual(len(self.sells()),0);self.cycle(215,4)
        self.assertEqual((self.manager.get(id)['exit_reason'],self.held()),('STOP_NOT_FILLED',0))
    def test_end_of_day_waits_for_the_unknown_stop(self):
        id,_=self.lost_stop();self.runtime.day_clock=lambda:ist(15,18);self.cycle(231);self.cycle(231)
        self.assertEqual((self.manager.get(id)['exit_reason'],len(self.sells()),self.held()),('END_OF_DAY',0,130))
        self.assertTrue(self.runtime.last_error)

class ClosedOutsideTests(Case):
    def outside(self,quantity=130,side=-1,status=2,key=None):
        """An order the app did not send, as the owner or FYERS would create."""
        self.broker._write({'id':key or 'OUT-'+str(uuid.uuid4()),'orderTag':'','clientId':'OWNER','symbol':self.symbol,
            'side':side,'qty':quantity,'type':1,'productType':'INTRADAY','status':status,'limitPrice':230,
            'filledQty':quantity if status==2 else 0,'remainingQuantity':0 if status==2 else quantity,
            'tradedPrice':230 if status==2 else 0},'OUTSIDE')
    def wait(self,times=4):
        for _ in range(times):status=self.cycle(231)
        return status
    def counts(self):return (self.broker.calls(),self.broker.calls('CANCEL'),self.broker.calls('MODIFY'))
    def locked(self,id,status):
        self.assertNotEqual(self.manager.get(id)['state'],'CLOSED')
        self.assertEqual([p['id'] for p in status['positions']],[id]);self.assertTrue(status['attentionRequired'])
    def trade(self):
        with self.journal.connection() as db:return json.loads(db.execute('SELECT payload FROM trades').fetchone()[0])
    def test_confirmed_outside_sale_cancels_own_stop_sends_no_sale_and_unlocks(self):
        id,_,_=self.entry();before=self.broker.calls();self.outside();status=self.cycle(231)
        self.assertEqual((self.broker.calls('CANCEL'),self.stops()[0]['status']),(0,6));self.locked(id,status)
        status=self.wait()
        self.assertEqual((self.manager.get(id)['state'],self.manager.get(id)['exit_reason']),('CLOSED','CLOSED_OUTSIDE_APP'))
        self.assertEqual((self.stops()[0]['status'],self.broker.calls(),self.broker.calls('CANCEL')),(1,before,1))
        self.assertEqual((status['positions'],status['attentionRequired']),([],None))
        self.assertEqual([(n['id'],n['quantity'],n['symbol']) for n in status['needsChecking']],[(id,130,self.symbol)])
    def test_journal_says_needs_checking_without_a_price_or_profit(self):
        self.entry();self.outside();self.wait();row=self.trade()
        self.assertEqual((row.get('exit'),row.get('pnl'),row.get('grossPnl'),row.get('needsChecking')),(None,None,None,True))
        self.assertIn('NEEDS CHECKING',row['notes']);self.assertEqual(self.journal.list_trades()['trades'],[])
    def test_the_next_trade_on_the_same_option_works_normally(self):
        self.entry();self.outside();self.wait();self.ticket={**self.ticket,'setupId':'NEXT'}
        id,_,result=self.entry();self.assertTrue(result['protectionConfirmed']);self.tick(240)
        self.assertEqual((self.runtime.request_exit(id)['state'],self.held()),('CLOSED',0))
    def test_survives_a_restart_midway(self):
        id,_,_=self.entry();self.outside();self.cycle(231)
        self.manager=Manager(self.execution,self.journal)
        self.runtime=Runtime(self.execution,self.manager,self.feed,self.market,clock=lambda:self.now,day_clock=self.runtime.day_clock)
        self.wait();self.assertEqual(self.manager.get(id)['state'],'CLOSED')
    def test_stop_already_cancelled_by_fyers_sends_nothing(self):
        id,_,_=self.entry();row=self.stops()[0];row.update(status=1);self.broker._write(row,'BROKER_CANCEL');self.outside();before=self.counts()
        self.wait();self.assertEqual((self.manager.get(id)['state'],self.counts(),len(self.sells())),('CLOSED',before,1))
    def test_exit_button_and_1518_send_no_sale(self):
        id,_,_=self.entry();self.outside();self.tick(240)
        with self.assertRaisesRegex(ValueError,'CLOSED_OUTSIDE'):self.runtime.request_exit(id)
        self.runtime.day_clock=lambda:ist(15,18);self.wait()
        self.assertEqual([r['orderTag'] for r in self.sells()],[''])
    def test_works_with_buying_off(self):
        id,_,_=self.entry();self.orders.enabled=False;self.outside();self.wait()
        self.assertEqual((self.manager.get(id)['state'],self.stops()[0]['status']),('CLOSED',1))
    def test_both_strategies_on_one_option_sold_together(self):
        a,_,_=self.entry();core=str(uuid.uuid4())
        self.market.current=lambda:{'tickets':{'CORE_MANUAL':{**self.ticket,'strategyFamily':'CORE','setupId':'C'}},'snapshot':{}}
        self.runtime.prepare(core,'CORE');self.runtime.submit(core);before=self.broker.calls()
        self.outside(260);status=self.wait(8)
        self.assertEqual((status['positions'],self.broker.calls(),self.broker.calls('CANCEL')),([],before,2))
    def unclear(self,id,rounds=6):
        before=self.counts();status=self.wait(rounds)
        self.assertEqual(self.counts(),before);self.locked(id,status)
        self.assertEqual((self.stops()[0]['status'],status['needsChecking']),(6,[]))
    def test_part_sold_outside_reduces_only_the_stop_and_stays_locked(self):
        id,_,_=self.entry();calls,cancels,modifies=self.counts();self.outside(65);status=self.wait(6)
        self.assertEqual(self.counts(),(calls,cancels,modifies+1));self.locked(id,status)
        self.assertEqual(([(r['qty'],r['status']) for r in self.stops()],status['needsChecking']),([(65,6)],[]))
    def test_positions_alone_showing_zero_stays_locked(self):
        id,_,_=self.entry();self.broker.net_quantity=lambda s:0;self.unclear(id)
    def test_a_brief_late_positions_reading_changes_nothing(self):
        id,_,_=self.entry();real=self.broker.net_quantity;self.broker.net_quantity=lambda s:0
        self.assertIsNone(self.cycle(231)['attentionRequired']);self.broker.net_quantity=real
        status=self.wait();self.assertEqual((self.manager.get(id)['state'],status['attentionRequired']),('MANAGING',None))
    def test_orderbook_shows_sale_but_positions_still_show_holding(self):
        id,_,_=self.entry();self.outside();self.broker.net_quantity=lambda s:130;self.unclear(id)
    def test_no_positions_row_is_not_proof(self):
        id,_,_=self.entry();self.outside();self.broker.position_rows=lambda s:[];self.unclear(id)
    def test_an_empty_orderbook_never_cancels_the_stop(self):
        id,_,_=self.entry();real=self.broker.orders_for_symbol;self.broker.orders_for_symbol=lambda s:[]
        self.broker.net_quantity=lambda s:0;self.unclear(id)
    def test_open_order_from_outside_stays_locked(self):
        id,_,_=self.entry();self.outside();self.outside(65,side=1,status=6);self.unclear(id)
    def test_our_own_unfilled_sale_stays_locked_and_is_not_cancelled(self):
        id,_,_=self.entry();self.shape(is_sale,status=6);self.tick(240);self.runtime.request_exit(id)
        self.broker.place_order=self.place;self.outside();before=self.counts();status=self.wait()
        self.assertEqual(self.counts(),before);self.locked(id,status)
    def test_unseen_own_stop_stays_locked(self):
        held=[]
        def placed(payload):
            if is_stop(payload):held.append(1);raise TimeoutError()
            return self.place(payload)
        self.broker.place_order=placed;id=str(uuid.uuid4());self.runtime.prepare(id,'SCALP')
        with self.assertRaises(ValueError):self.runtime.submit(id)
        self.outside();before=self.counts();status=self.wait()
        self.assertEqual((self.counts(),len(held)),(before,1));self.locked(id,status)
    def test_unconfirmed_cancel_stays_locked_until_confirmed(self):
        id,_,_=self.entry();real=self.broker.cancel_order;self.broker.cancel_order=lambda i:{'s':'ok','id':i}
        self.outside();status=self.wait();self.locked(id,status)
        self.broker.cancel_order=real;self.wait();self.assertEqual(self.manager.get(id)['state'],'CLOSED')
    def test_never_unlocks_a_double_sale(self):
        id,_,_=self.entry();self.outside();self.broker.fill_stop(self.stops()[0]['id'],219)
        status=self.wait();self.assertEqual(self.held(),-130);self.locked(id,status)
    def test_buying_back_after_a_seen_sale_does_not_resume_trading(self):
        id,_,_=self.entry();self.outside();self.cycle(231);self.outside(130,side=1);before=self.counts()
        status=self.wait();self.assertEqual(self.counts(),before);self.locked(id,status)
    def test_sale_before_the_first_stop_sends_no_stop(self):
        def sold_at_once(payload):
            result=self.place(payload)
            if is_buy(payload):self.outside()
            return result
        self.broker.place_order=sold_at_once;id=str(uuid.uuid4());self.runtime.prepare(id,'SCALP')
        with self.assertRaisesRegex(ValueError,'CLOSED_OUTSIDE'):self.runtime.submit(id)
        self.wait();self.assertEqual((len(self.stops()),self.manager.get(id)['state']),(0,'CLOSED'))
    def test_fyers_reader_returns_only_this_intraday_option_and_rejects_odd_rows(self):
        from fyers_broker import FyersBroker
        rows=[{'symbol':'A','productType':'INTRADAY','side':1,'filledQty':65,'status':2},
              {'symbol':'A','productType':'MARGIN','side':-1,'filledQty':65,'status':2},
              {'symbol':'B','productType':'INTRADAY','side':1,'filledQty':65,'status':2}]
        class Client:
            def orderbook(self):return {'s':'ok','orderBook':rows}
            def positions(self):return {'s':'ok','netPositions':[{'symbol':'A','productType':'INTRADAY','netQty':0},{'symbol':'A','productType':'MARGIN','netQty':65}]}
        broker=FyersBroker(Client())
        self.assertEqual(broker.orders_for_symbol('A'),rows[:1]);self.assertEqual(len(broker.position_rows('A')),1)
        self.assertEqual(broker.net_quantity('A'),0)
        rows[0]={**rows[0],'filledQty':'65'}
        with self.assertRaises(ValueError):broker.orders_for_symbol('A')
    def test_old_database_tables_are_unchanged_so_a_rollback_can_still_write(self):
        with self.runtime.orders.transaction() as db:
            # The previous version inserts into these two tables by position.
            db.execute('INSERT INTO live_stop_actions VALUES (?,?,?,?,?)',('old','t','CANCEL','{}','SUBMITTING'))
            db.execute('INSERT INTO live_entry_cancels VALUES (?,?)',('old','SUBMITTING'))

if __name__=='__main__':unittest.main()
