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

if __name__=='__main__':unittest.main()
