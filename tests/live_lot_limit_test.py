"""The 2-lot limit, and part fills and part sales, as the app really runs it (not lifted). Artificial broker only."""
import concurrent.futures
import sys
from decimal import Decimal
import unittest
import uuid
from pathlib import Path
sys.path.insert(0,str(Path(__file__).resolve().parent));sys.path.insert(0,str(Path(__file__).resolve().parents[1]/'aws/live'))
import live_safety_test as safety
import planner
from execution import Execution
from orders import Orders


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
    def test_one_lot_sold_by_hand_locks_the_trade_and_leaves_a_two_lot_stop(self):
        id=self.open_two()
        self.broker._write({'id':'OUT-1','orderTag':'','clientId':'OWNER','symbol':self.symbol,'side':-1,'qty':65,'type':1,
            'productType':'INTRADAY','status':2,'limitPrice':230,'filledQty':65,'remainingQuantity':0,'tradedPrice':230},'OUTSIDE')
        calls=(self.broker.calls(),self.broker.calls('CANCEL'),self.broker.calls('MODIFY'))
        for price in (231,260,261,262):status=self.cycle(price)
        self.assertTrue(status['attentionRequired']);self.assertNotEqual(self.manager.get(id)['state'],'CLOSED')
        # Known gap: the app changes nothing, so its stop is still for both lots
        # although only one is held, and it no longer trails.
        self.assertEqual((self.held(),self.waiting_stops(),(self.broker.calls(),self.broker.calls('CANCEL'),self.broker.calls('MODIFY'))),(65,[130],calls))
        with self.assertRaisesRegex(ValueError,'CLOSED_OUTSIDE_APP_UNCLEAR'):self.runtime.request_exit(id)
        self.assertTrue(self.orders.buy_in_use())
        # If the owner then sells the other lot too, the app confirms it,
        # cancels its own stop and unlocks without selling anything.
        self.broker._write({'id':'OUT-2','orderTag':'','clientId':'OWNER','symbol':self.symbol,'side':-1,'qty':65,'type':1,
            'productType':'INTRADAY','status':2,'limitPrice':262,'filledQty':65,'remainingQuantity':0,'tradedPrice':262},'OUTSIDE')
        for _ in range(5):status=self.cycle(262)
        self.assertEqual((self.manager.get(id)['state'],self.held(),self.waiting_stops(),self.sale_quantities().count(130),self.orders.buy_in_use()),
                         ('CLOSED',0,[],0,False))

    def test_part_filled_stop_cannot_move_up_but_the_app_still_sells_on_its_trail(self):
        id=self.open_two();self.fill_part_of_stop()
        for price in (231,245,260,261,262):status=self.cycle(price)
        self.assertEqual(([r['stopPrice'] for r in self.stops() if r['status']==6],bool(status['attentionRequired']),self.held()),([220.0],True,65))
        for _ in range(3):self.cycle(240)
        self.assertEqual((self.held(),self.manager.get(id)['state'],self.sale_quantities()),(0,'CLOSED',[65]))


if __name__=='__main__':unittest.main()
