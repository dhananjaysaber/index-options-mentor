"""The 2-lot limit, and part fills and part sales, as the app really runs it (not lifted). Artificial broker only."""
import concurrent.futures
import json
import sys
from decimal import Decimal
import unittest
import uuid
from pathlib import Path
sys.path.insert(0,str(Path(__file__).resolve().parent));sys.path.insert(0,str(Path(__file__).resolve().parents[1]/'aws/live'))
import live_safety_test as safety
import planner
from execution import Execution
from manager import Manager
from orders import Orders
from runtime import Runtime


class LotLimitCase(safety.Case):
    real_lot_limit=True
    def setUp(self):
        super().setUp()
        tickets={k:self.ticket for k in ('SCALP_MANUAL','SCALP_AUTO')}
        tickets.update({k:{**self.ticket,'strategyFamily':'CORE','setupId':'core-setup'} for k in ('CORE_MANUAL','CORE_AUTO')})
        self.market.current=lambda:{'tickets':tickets,'snapshot':{}}
    def buys(self):return [r for r in self.broker._rows() if r['side']==1]
    def prepared(self,strategy='SCALP'):
        id=str(uuid.uuid4());self.runtime.prepare(id,strategy);return id
    def open_two(self):
        id=self.prepared();self.runtime.submit(id);return id
    def next_buy_works(self):
        self.tick(230,6);before=len(self.buys())
        id=self.prepared();self.runtime.submit(id)
        self.assertEqual((len(self.buys()),self.held()),(before+1,130))


class LotLimitTests(LotLimitCase):
    def test_limit_is_two_lots(self):
        self.assertEqual(planner.MAX_LOTS,2)
    def test_a_large_amount_still_buys_only_two_lots(self):
        self.execution.planner.max_amount=self.runtime.max_amount=Decimal(100000)
        shown=self.runtime.preview(100000)['trades']['SCALP']
        self.assertEqual((shown['quantity'],shown['lots'],shown['premiumCost']),(130,2,29900))
        self.runtime.buy(str(uuid.uuid4()),'SCALP',self.symbol,130,230,100000)
        self.assertEqual(([r['qty'] for r in self.buys()],self.held(),[r['qty'] for r in self.stops()]),([130],130,[130]))
    def test_one_tap_cannot_ask_for_three_lots(self):
        with self.assertRaisesRegex(ValueError,'TRADE_CHANGED_LOOK_AGAIN'):
            self.runtime.buy(str(uuid.uuid4()),'SCALP',self.symbol,195,230,30000)
        self.assertEqual(self.broker.calls(),0)
    def test_an_amount_for_one_lot_buys_one_and_below_one_lot_buys_nothing(self):
        self.assertEqual(self.runtime.preview(20000)['trades']['SCALP']['lots'],1)
        self.assertEqual(self.runtime.preview(100)['trades']['SCALP'],{'available':False,'reason':'AMOUNT_CANNOT_BUY_ONE_LOT'})
    def test_other_strategy_cannot_buy_while_one_is_held(self):
        self.runtime.submit(self.prepared('SCALP'));calls=self.broker.calls()
        self.assertEqual(self.runtime.preview(30000)['trades']['CORE'],{'available':False,'reason':'LOT_LIMIT_IN_USE'})
        with self.assertRaisesRegex(ValueError,'LOT_LIMIT_IN_USE'):self.prepared('CORE')
        with self.assertRaisesRegex(ValueError,'LOT_LIMIT_IN_USE'):
            self.runtime.buy(str(uuid.uuid4()),'CORE',self.symbol,130,230,30000)
        self.assertEqual((self.broker.calls(),self.held()),(calls,130))
    def test_two_buys_prepared_before_either_is_sent_give_one_order(self):
        first,second=self.prepared('SCALP'),self.prepared('CORE')
        self.runtime.submit(first)
        with self.assertRaisesRegex(ValueError,'LOT_LIMIT_IN_USE'):self.runtime.submit(second)
        self.assertEqual((len(self.buys()),self.held()),(1,130))
        self.assertIsNone(self.runtime.cycle()['attentionRequired'])
    def test_two_buys_at_the_same_instant_give_one_order(self):
        ids=[str(uuid.uuid4()) for _ in range(2)]
        for id in ids:self.execution.prepare(id,self.symbol,30000,'SCALP')
        def send(id):
            try:self.execution.submit(id);return 'SENT'
            except ValueError as error:return str(error)
        with concurrent.futures.ThreadPoolExecutor(2) as pool:results=sorted(pool.map(send,ids))
        self.assertEqual((results,len(self.buys())),(['LOT_LIMIT_IN_USE','SENT'],1))
    def test_a_larger_plan_saved_before_the_limit_is_refused(self):
        planner.MAX_LOTS=3;self.execution.planner.max_amount=Decimal(100000)
        try:
            id=str(uuid.uuid4());self.assertEqual(self.execution.prepare(id,self.symbol,50000,'SCALP')['lots'],3)
        finally:planner.MAX_LOTS=2
        with self.assertRaisesRegex(ValueError,'LOT_LIMIT_EXCEEDED'):self.execution.submit(id)
        self.assertEqual(self.broker.calls(),0)
    def test_unknown_buy_result_keeps_new_buys_blocked_even_after_restart(self):
        def lost(payload):raise ValueError('BROKER_REQUEST_UNAVAILABLE_RECONCILE')
        self.broker.place_order=lost
        self.runtime.submit(self.prepared('SCALP'))
        self.assertTrue(Orders(self.file,self.broker,'OWNER',1755,True).buy_in_use())
        with self.assertRaisesRegex(ValueError,'LOT_LIMIT_IN_USE'):self.prepared('CORE')
    def test_unfilled_buy_frees_the_limit_after_cancel_is_confirmed(self):
        self.shape(safety.is_buy,status=6)
        self.runtime.submit(self.prepared('SCALP'));self.assertTrue(self.orders.buy_in_use())
        self.cycle(230);self.cycle(230);self.assertFalse(self.orders.buy_in_use())
        self.broker.place_order=self.place;self.next_buy_works()
    def test_sale_is_never_blocked_and_frees_the_limit(self):
        id=self.prepared();self.runtime.submit(id)
        self.tick(231,6);self.runtime.request_exit(id)
        for _ in range(4):self.cycle(231)
        self.assertEqual((self.held(),self.manager.get(id)['state'],self.orders.buy_in_use()),(0,'CLOSED',False))
        self.next_buy_works()
    def test_trade_sold_outside_the_app_frees_the_limit_only_when_confirmed(self):
        id=self.prepared();self.runtime.submit(id)
        self.broker._write({'id':'OUT-1','orderTag':'','clientId':'OWNER','symbol':self.symbol,'side':-1,'qty':130,'type':1,
            'productType':'INTRADAY','status':2,'limitPrice':230,'filledQty':130,'remainingQuantity':0,'tradedPrice':230},'OUTSIDE')
        self.cycle(231);self.assertTrue(self.orders.buy_in_use())
        for _ in range(4):self.cycle(231)
        self.assertEqual((self.manager.get(id)['state'],self.orders.buy_in_use()),('CLOSED',False))
    def test_automatic_buying_on_both_strategies_places_one_buy(self):
        self.runtime.set_settings({'mentorAutoOpen':True,'scalpAutoOpen':True})
        for _ in range(4):status=self.cycle(230,1)
        self.assertEqual((len(self.buys()),self.held(),len(status['positions']),status['attentionRequired']),(1,130,1,None))


class PartCaseTests(LotLimitCase):
    """What happens today when only 1 of the 2 lots goes through."""
    def part_fill(self,match,status=6):
        """The broker fills 1 lot of a matching 2-lot order and leaves 1 lot waiting."""
        def placed(payload):
            result=self.place(payload)
            if match(payload):
                row=self.broker.orders_by_tag('1:'+payload['orderTag'])[0]
                row.update(status=status,filledQty=65,remainingQuantity=65,tradedPrice=230);self.broker._write(row,'PART')
            return result
        self.broker.place_order=placed
    def fill_part_of_stop(self):
        row=next(r for r in self.stops() if r['status']==6)
        row.update(filledQty=65,remainingQuantity=65,tradedPrice=219.95);self.broker._write(row,'PART_STOP')
    def waiting_stops(self):return [r['qty'] for r in self.stops() if r['status']==6]
    def sale_quantities(self):return [r['qty'] for r in self.sells()]

    def test_buy_part_filled_cancels_the_rest_and_protects_one_lot(self):
        self.part_fill(safety.is_buy);id=self.open_two()
        self.assertEqual((self.held(),self.broker.calls('CANCEL'),self.waiting_stops(),self.manager.get(id)['state']),(65,1,[65],'MANAGING'))
    def test_app_sale_part_filled_sells_only_the_other_lot_afterwards(self):
        id=self.open_two();self.tick(231,6);self.part_fill(safety.is_sale);self.runtime.request_exit(id)
        # 1 lot sold. The other lot waits on the sale order, with no stop at the broker.
        self.assertEqual((self.held(),self.waiting_stops(),self.sale_quantities()),(65,[],[130]))
        self.broker.place_order=self.place
        for price in (230,229,228):self.cycle(price)
        self.assertEqual((self.held(),self.sale_quantities(),self.manager.get(id)['state']),(0,[130,65],'CLOSED'))
    def test_stop_part_filled_and_price_below_it_sells_the_other_lot(self):
        id=self.open_two();self.fill_part_of_stop();self.assertEqual(self.held(),65)
        for _ in range(4):self.cycle(219,4)
        self.assertEqual((self.held(),self.waiting_stops(),self.sale_quantities(),self.manager.get(id)['state']),(0,[],[65],'CLOSED'))
    def test_part_filled_stop_gets_a_few_seconds_to_finish_itself(self):
        id=self.open_two();self.fill_part_of_stop();self.cycle(231,1);self.cycle(231,1)
        self.assertEqual((self.held(),self.waiting_stops(),self.sale_quantities()),(65,[130],[]))
        stop=next(r for r in self.stops() if r['status']==6)
        stop.update(status=2,filledQty=130,remainingQuantity=0);self.broker._write(stop,'REST_OF_STOP')
        for _ in range(3):self.cycle(219,4)
        self.assertEqual((self.held(),self.sale_quantities(),self.manager.get(id)['state']),(0,[],'CLOSED'))
    def test_stop_still_part_filled_after_the_wait_sells_the_other_lot_even_if_price_recovered(self):
        id=self.open_two();self.fill_part_of_stop();self.cycle(245,1)
        for _ in range(4):self.cycle(245,4)
        self.assertEqual((self.held(),self.waiting_stops(),self.sale_quantities(),self.manager.get(id)['state'],self.manager.get(id)['exit_reason']),
                         (0,[],[65],'CLOSED','STOP_PART_FILLED'))
    def test_part_filled_stop_is_not_sold_until_its_cancel_is_confirmed(self):
        self.open_two();self.fill_part_of_stop();real=self.broker.cancel_order;self.broker.cancel_order=lambda i:{'s':'ok','id':i}
        for _ in range(4):self.cycle(245,4)
        self.assertEqual((self.held(),self.sale_quantities()),(65,[]))
        self.broker.cancel_order=real
        for _ in range(4):self.cycle(245,4)
        self.assertEqual((self.held(),self.sale_quantities()),(0,[65]))


class HandPartSaleTests(LotLimitCase):
    """1 of 2 lots sold by hand in FYERS: the app's stop is reduced, nothing else."""
    def by_hand(self,quantity=65,side=-1,status=2,key='OUT-1'):
        done=quantity if status==2 else 0
        self.broker._write({'id':key,'orderTag':'','clientId':'OWNER','symbol':self.symbol,'side':side,'qty':quantity,'type':1,
            'productType':'INTRADAY','status':status,'limitPrice':230,'filledQty':done,'remainingQuantity':quantity-done,
            'tradedPrice':230 if done else 0},'OUTSIDE')
    def wait(self,price=231,times=5):
        for _ in range(times):status=self.cycle(price)
        return status
    def trade(self):return next(iter(self.runtime.status()['positions']))
    def journal_rows(self):
        with self.orders.transaction() as db:
            return [json.loads(r['payload']) for r in db.execute('SELECT payload FROM live_journal_outbox')]
    def restart(self):
        self.manager=Manager(self.execution,self.journal)
        self.runtime=Runtime(self.execution,self.manager,self.feed,self.market,clock=lambda:self.now,day_clock=self.runtime.day_clock)
    def app_sales(self):return [r for r in self.sells() if r['orderTag']]
    def stop_rows(self):return [(r['qty'],r['stopPrice'],r['limitPrice'],r['status']) for r in self.stops()]
    def modifies(self):return self.broker.calls('MODIFY')
    def counts(self):return (self.broker.calls(),self.broker.calls('CANCEL'),self.modifies())
    def untouched(self,id,before):
        status=self.wait(times=8)
        self.assertEqual((self.counts(),[r['qty'] for r in self.stops() if r['status']==6],status['partSales']),(before,[130],[]))
        self.assertTrue(status['attentionRequired']);self.assertNotEqual(self.manager.get(id)['state'],'CLOSED')

    def test_stop_is_reduced_at_the_same_price_with_no_sale_and_a_warning(self):
        id=self.open_two();before=self.counts();(row,)=self.stop_rows();self.by_hand()
        self.cycle(231);self.assertEqual(self.counts(),before) # one reading is not enough
        status=self.wait()
        self.assertEqual(self.stop_rows(),[(65,row[1],row[2],6)])
        self.assertEqual(self.counts(),(before[0],before[1],before[2]+1)) # one change; no new order or cancel
        self.assertEqual(status['partSales'],[{'id':id,'symbol':self.symbol,'held':65,'stopQuantity':65,'stopReduced':True,'managing':True}])
        self.assertTrue(self.orders.buy_in_use())
        self.assertEqual((status['needsChecking'],json.loads(self.manager.get(id)['payload'])['quantity'],status['attentionRequired']),([],65,None))
        self.assertEqual(json.loads(self.orders.get(self.manager.get(id)['stop_intent'])['payload'])['qty'],65)
    def path(self,sell_by_hand,strategy='SCALP'):
        """One price path; returns (stop price, state, exit reason) after each reading."""
        id=self.prepared(strategy);self.runtime.submit(id)
        for price in (231,245,260):self.cycle(price)
        if sell_by_hand:self.by_hand()
        self.wait(260,8)
        seen=[]
        for price in (262,266,275,274,290,300,297,296,285,270,255,250,245,240):
            self.cycle(price);waiting=[r['stopPrice'] for r in self.stops() if r['status']==6]
            seen.append((price,waiting,self.manager.get(id)['state'],self.manager.get(id)['exit_reason']))
        return seen,[r['qty'] for r in self.app_sales()]
    def test_trailing_restarts_with_exactly_the_same_prices_as_an_untouched_trade(self):
        untouched=self.path(False);self.tearDown();self.setUp();resumed=self.path(True)
        self.assertEqual(untouched[0],resumed[0])
        self.assertGreater(len({tuple(x[1]) for x in untouched[0] if x[1]}),1) # the stop really did move
        self.assertEqual((untouched[1],resumed[1],self.held()),([130],[65],0))
    def test_13_point_trailing_prices_also_match_an_untouched_trade(self):
        untouched=self.path(False,'CORE');self.tearDown();self.setUp();resumed=self.path(True,'CORE')
        self.assertEqual(untouched[0],resumed[0])
        self.assertGreater(len({tuple(x[1]) for x in untouched[0] if x[1]}),1)
        self.assertEqual((untouched[1],resumed[1],self.held()),([130],[65],0))
    def test_saved_profit_figures_shrink_with_the_quantity(self):
        id=self.open_two()
        for price in (231,245,260):self.cycle(price)
        before=json.loads(self.manager.get(id)['payload']);self.by_hand()
        self.cycle(260);self.cycle(260,6)
        after=json.loads(self.manager.get(id)['payload'])
        self.assertEqual((before['quantity'],after['quantity']),(130,65))
        for name in ('peakUnrealizedPnl','optionTrailingFloorPnl','coreOptionTrailingFloorPnl'):
            if before.get(name):self.assertAlmostEqual(after[name],before[name]/2)
    def test_end_of_day_sells_the_one_lot_left(self):
        id=self.open_two();self.by_hand();self.wait();self.runtime.day_clock=lambda:safety.ist(15,20);self.wait()
        self.assertEqual((self.held(),[r['qty'] for r in self.app_sales()],self.manager.get(id)['state'],self.manager.get(id)['exit_reason']),(0,[65],'CLOSED','END_OF_DAY'))
    def test_app_exit_works_again_and_the_journal_guesses_no_profit(self):
        id=self.open_two();self.by_hand();self.wait();self.tick(231,6);self.runtime.request_exit(id);status=self.wait()
        self.assertEqual((self.held(),[r['qty'] for r in self.app_sales()],self.manager.get(id)['state'],self.orders.buy_in_use()),(0,[65],'CLOSED',False))
        (done,)=[e['trade'] for e in self.journal_rows() if e['id']==id+':OUTSIDE_CLOSE']
        self.assertEqual((done['pnl'],done['exit'],done['grossPnl'],done['quantity'],done['closedOutsideQuantity'],done['appSoldQuantity'],done['needsChecking']),
                         (None,None,None,130,65,65,True))
        self.assertEqual([e for e in self.journal_rows() if e['id'] in (id+':EXIT',id+':CLOSED')],[])
        with self.journal.connection() as db:saved=json.loads(db.execute('SELECT payload FROM trades').fetchone()[0])
        self.assertEqual((saved['needsChecking'],saved['pnl'],saved['exitReason']),(True,None,'PART_CLOSED_OUTSIDE_APP'))
        self.assertEqual([(c['id'],c['quantity']) for c in status['needsChecking']],[(id,65)])
        self.next_buy_works()
    def test_the_app_cannot_sell_more_than_is_left(self):
        id=self.open_two();self.by_hand();self.wait()
        # Without the waiting stop, only the one lot left can be sold; never two.
        self.manager.protection.cancel(self.manager.get(id)['stop_intent'])
        with self.assertRaisesRegex(ValueError,'EXIT_EXCEEDS_OWNED_QUANTITY'):self.orders.submit_exit(str(uuid.uuid4()),id,230,130)
        self.assertEqual(self.app_sales(),[])
    def test_after_a_restart_the_one_lot_is_still_managed(self):
        id=self.open_two();self.by_hand();self.wait();self.restart();self.runtime.day_clock=lambda:safety.ist(15,20);self.wait()
        self.assertEqual((self.held(),[r['qty'] for r in self.app_sales()],self.manager.get(id)['state']),(0,[65],'CLOSED'))
    def test_no_management_until_the_smaller_stop_is_confirmed(self):
        id=self.open_two();self.broker.modify_stop=lambda *a:(_ for _ in ()).throw(ValueError('BROKER_REQUEST_UNAVAILABLE_RECONCILE'))
        self.by_hand();self.wait();calls=self.counts();self.runtime.day_clock=lambda:safety.ist(15,20);status=self.wait()
        self.assertEqual((self.counts(),self.held(),self.trade()['id']),(calls,65,id));self.assertTrue(status['attentionRequired'])
        with self.assertRaisesRegex(ValueError,'CLOSED_OUTSIDE_APP_UNCLEAR'):self.runtime.request_exit(id)
    def test_reduced_stop_sells_only_what_is_held_and_then_unlocks(self):
        id=self.open_two();self.by_hand();self.wait()
        stop=next(r for r in self.stops() if r['status']==6);self.broker.fill_stop(stop['id'],220)
        status=self.wait(219)
        self.assertEqual((self.held(),self.manager.get(id)['state'],status['partSales'],status['positions'],self.orders.buy_in_use()),(0,'CLOSED',[],[],False))
        self.assertEqual(self.app_sales(),[])
    def test_selling_the_rest_by_hand_cancels_the_reduced_stop(self):
        id=self.open_two();self.by_hand();self.wait();self.by_hand(key='OUT-2')
        status=self.wait()
        self.assertEqual((self.held(),self.manager.get(id)['state'],[r for r in self.stops() if r['status']==6],status['partSales'],self.orders.buy_in_use()),(0,'CLOSED',[],[],False))
        self.assertEqual(self.app_sales(),[])
        self.assertEqual([c['quantity'] for c in status['needsChecking']],[130])
        self.assertEqual([e['trade']['closedOutsideQuantity'] for e in self.journal_rows() if e['id'].endswith(':OUTSIDE_CLOSE')],[130])
    def test_lost_stop_change_warns_that_the_stop_may_be_too_big_and_tries_again(self):
        self.open_two();real=self.broker.modify_stop;tries=[]
        def lost(*args):tries.append(args);raise ValueError('BROKER_REQUEST_UNAVAILABLE_RECONCILE')
        self.broker.modify_stop=lost;self.by_hand();status=self.wait()
        self.assertGreater(len(tries),1);self.assertEqual({a[3] for a in tries},{65})
        self.assertEqual([(p['stopQuantity'],p['stopReduced'],p['managing']) for p in status['partSales']],[(130,False,False)])
        self.broker.modify_stop=real;status=self.wait()
        self.assertEqual((self.stop_rows()[0][0],status['partSales'][0]['stopReduced']),(65,True))
    def test_change_that_arrives_without_a_reply_is_recognised_after_a_restart(self):
        self.open_two();real=self.broker.modify_stop
        def silent(*args):real(*args);raise ValueError('BROKER_REQUEST_UNAVAILABLE_RECONCILE')
        self.broker.modify_stop=silent;self.by_hand()
        for _ in range(3):self.cycle(231)
        manager=Manager(self.execution,self.journal)
        self.runtime=Runtime(self.execution,manager,self.feed,self.market,clock=lambda:self.now,day_clock=self.runtime.day_clock);self.manager=manager
        status=self.wait();self.assertTrue(status['partSales'][0]['stopReduced']);self.assertEqual(self.modifies(),1)
    def test_works_with_the_real_money_switch_off(self):
        self.open_two();self.orders.enabled=False;self.orders.exits_enabled=True;self.by_hand();self.wait()
        self.assertEqual(self.stop_rows()[0][0],65)
    def test_unclear_when_positions_disagree(self):
        id=self.open_two();before=self.counts();self.by_hand();self.broker.net_quantity=lambda s:130;self.untouched(id,before)
    def test_unclear_when_another_order_is_waiting_in_fyers(self):
        id=self.open_two();before=self.counts();self.by_hand();self.by_hand(status=6,key='OUT-2');self.untouched(id,before)
    def test_unclear_when_something_was_also_bought_by_hand(self):
        id=self.open_two();before=self.counts();self.by_hand(130);self.by_hand(65,side=1,key='OUT-2');self.untouched(id,before)
    def test_unclear_when_the_amount_left_is_not_whole_lots(self):
        id=self.open_two();before=self.counts();self.by_hand(30);self.untouched(id,before)
    def test_a_stop_size_the_app_did_not_ask_for_is_never_accepted(self):
        id=self.open_two();row=next(r for r in self.stops() if r['status']==6)
        row.update(qty=65,remainingQuantity=65);self.broker._write(row,'OUTSIDE_EDIT')
        status=self.cycle(231);self.assertTrue(status['attentionRequired'])
        self.assertEqual(json.loads(self.orders.get(self.manager.get(id)['stop_intent'])['payload'])['qty'],130)
    def test_if_the_big_stop_fires_before_the_change_the_app_stays_locked(self):
        id=self.open_two();self.by_hand();self.cycle(231)
        stop=next(r for r in self.stops() if r['status']==6);self.broker.fill_stop(stop['id'],220)
        status=self.wait(219)
        self.assertEqual(self.held(),-65) # the artificial broker allows the oversell
        self.assertTrue(status['attentionRequired']);self.assertNotEqual(self.manager.get(id)['state'],'CLOSED');self.assertEqual(self.app_sales(),[])
    def test_a_stop_is_never_made_bigger(self):
        id=self.open_two();stop=self.manager.get(id)['stop_intent']
        for quantity in (195,0,-65):
            with self.assertRaisesRegex(ValueError,'INVALID_PROTECTION_QUANTITY'):self.manager.protection.shrink(stop,quantity)
        self.assertEqual(self.modifies(),0)


if __name__=='__main__':unittest.main()
