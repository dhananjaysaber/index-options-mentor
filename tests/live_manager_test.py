import importlib.util
import json
import sys
import tempfile
import time
import unittest
import uuid
from datetime import datetime,timezone
from pathlib import Path
ROOT=Path(__file__).resolve().parents[1];sys.path.insert(0,str(ROOT/'aws/live'))
from orders import Orders
from execution import Execution
from planner import EntryPlanner
from manager import Manager
from diagnostic import SimulatedBroker,journal_class,run_check
from protection import Protection

class ManagerTests(unittest.TestCase):
    def setUp(self):
        self.temp=tempfile.TemporaryDirectory();self.file=str(Path(self.temp.name)/'check.sqlite3');self.now=time.time()
        self.symbol='NSE:NIFTYTEST25450PE';self.quote={'symbol':self.symbol,'ask':230.,'bid':230.,'at':self.now}
        self.contract={'symbol':self.symbol,'active':True,'lot_size':65,'max_quantity':1800,'tick_size':.05,'checked_at':self.now,'expires_at':self.now+86400}
        self.broker=SimulatedBroker(self.file,'OWNER',self.quote);self.orders=Orders(self.file,self.broker,'OWNER',1800,True)
        self.journal=journal_class()(self.file)
        self.planner=EntryPlanner(lambda _:self.contract,lambda _:self.quote,lambda:True,30000,clock=time.time)
        self.execution=Execution(self.orders,self.planner);self.manager=Manager(self.execution,self.journal)
        self.entry=str(uuid.uuid4());self.execution.prepare(self.entry,self.symbol,30000,'SCALP');self.execution.submit(self.entry);self.orders.reconcile(self.entry)
        self.manager.track(self.entry,{'symbol':self.symbol,'side':'PE','strategyFamily':'SCALP','underlyingEntry':25000,'underlyingStop':25100,'underlyingTarget':24900,'rr':1,'score':90},220)
    def tearDown(self):self.temp.cleanup()
    def pulse(self,price,at=None):
        self.quote.update(ask=price,bid=price,at=time.time());stamp=datetime.fromtimestamp(at or self.quote['at'],timezone.utc).isoformat()
        return self.manager.pulse(self.entry,{'optionSymbol':self.symbol,'optionPrice':price,'nifty':25000,'at':stamp},{'generatedAt':stamp,'decision':{'side':'PE','score':90},'parameters':[]})
    def test_real_shared_core_and_scalp_engines_exit_and_replay(self):
        result=run_check('OWNER')
        self.assertFalse(result['realMoneyEnabled']);self.assertEqual(result['brokerNetworkRequests'],0)
        self.assertEqual([r['exitReason'] for r in result['checks']],['CORE_OPTION_PROFIT_TRAIL','SCALP_OPTION_PROFIT_TRAIL'])
        self.assertTrue(all(r['journalRows']==1 and r['replayCreatedOrders']==0 for r in result['checks']))
    def test_stale_quote_does_not_arm_or_exit(self):
        before=self.broker.calls();result=self.pulse(260,time.time()-10)
        self.assertFalse(result['accepted']);self.assertEqual(self.broker.calls(),before)
    def test_broker_stop_fill_wins_without_second_sell(self):
        state=self.manager.get(self.entry);stop=self.orders.get(state['stop_intent'])
        self.broker.fill_stop(stop['broker_id'],219);before=self.broker.calls()
        self.assertEqual(self.pulse(219)['state'],'CLOSED');self.assertEqual(self.broker.calls(),before)
        self.assertEqual(self.journal.health()['trades'],1)
    def test_cancel_ack_without_confirmed_cancel_blocks_sell(self):
        self.pulse(260);before=self.broker.calls();calls=[]
        self.broker.cancel_order=lambda id:(calls.append(id) or {'s':'ok','id':id})
        with self.assertRaisesRegex(ValueError,'CANCELLATION_NOT_CONFIRMED'):self.pulse(240)
        with self.assertRaisesRegex(ValueError,'CANCELLATION_NOT_CONFIRMED'):self.pulse(239)
        self.assertEqual(self.broker.calls(),before);self.assertEqual(len(calls),1)
    def test_modify_timeout_does_not_resend_or_cancel_protection(self):
        calls=[]
        def timeout(*args):calls.append(args);raise TimeoutError()
        self.broker.modify_stop=timeout
        with self.assertRaisesRegex(ValueError,'MODIFICATION_NOT_CONFIRMED'):self.pulse(260)
        with self.assertRaisesRegex(ValueError,'MODIFICATION_NOT_CONFIRMED'):self.pulse(260)
        self.assertEqual(len(calls),1);self.assertEqual(self.broker.calls('CANCEL'),0)
    def test_protection_can_never_loosen(self):
        state=self.manager.get(self.entry)
        with self.assertRaisesRegex(ValueError,'CANNOT_LOOSEN'):self.manager.protection.tighten(state['stop_intent'],210,209.95)
    def test_restart_preserves_floor_and_pending_exit_id(self):
        self.pulse(260);state=self.manager.get(self.entry);floor=json.loads(state['payload'])['optionTrailingFloorPnl']
        self.manager=Manager(self.execution,self.journal)
        self.assertEqual(json.loads(self.manager.get(self.entry)['payload'])['optionTrailingFloorPnl'],floor)
        self.pulse(240);self.assertEqual(self.manager.get(self.entry)['state'],'CLOSED')
        self.assertEqual(self.journal.health()['events'],1)

    def test_stop_fills_during_cancel_no_second_sell(self):
        self.pulse(260)
        def race(order_id):
            self.broker.fill_stop(order_id,240)
            return {'s':'ok','id':order_id}
        self.broker.cancel_order=race;before=self.broker.calls()
        self.assertEqual(self.pulse(240)['state'],'CLOSED');self.assertEqual(self.broker.calls(),before)
        self.assertEqual(self.journal.health()['trades'],1)
    def test_partial_stop_then_cancel_exits_only_remaining_lot(self):
        self.pulse(260);stop=self.orders.get(self.manager.get(self.entry)['stop_intent'])
        row=self.broker.orders_by_tag('1:'+stop['tag'])[0]
        row.update(status=1,filledQty=65,remainingQuantity=65,tradedPrice=245)
        self.broker._write(row,'PARTIAL_STOP')
        self.assertEqual(self.pulse(240)['state'],'CLOSED')
        entry=self.manager.get(self.entry);exit=self.orders.get(entry['exit_intent'])
        self.assertEqual(json.loads(exit['payload'])['qty'],65)
        self.assertEqual(self.journal.health()['events'],1)

if __name__=='__main__':unittest.main()
