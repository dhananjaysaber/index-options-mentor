import concurrent.futures
import sys
import tempfile
import unittest
import uuid
from pathlib import Path
sys.path.insert(0, str(Path(__file__).resolve().parents[1] / 'aws/live'))
from orders import Orders

class Broker:
    def __init__(self):
        self.calls=0
        self.owner='TESTOWNER'
        self.timeout=False
        self.matches=[]
    def account_id(self): return self.owner
    def place_order(self, body):
        self.calls+=1
        self.body=body
        if self.timeout: raise TimeoutError()
        return {'s':'ok','id':'test-order'}
    def orders_by_tag(self, tag): return self.matches

class Tests(unittest.TestCase):
    def setUp(self):
        self.temp=tempfile.TemporaryDirectory()
        self.file=str(Path(self.temp.name)/'orders.sqlite3')
        self.broker=Broker()
        self.orders=Orders(self.file,self.broker,'TESTOWNER',max_quantity=65,enabled=True)
        self.id=str(uuid.uuid4())
        self.payload={'symbol':'NSE:NIFTY26NOV25450PE','side':1,'qty':65,'type':1,
                      'limitPrice':50,'productType':'INTRADAY','validity':'DAY','offlineOrder':False}
    def tearDown(self): self.temp.cleanup()
    def test_disabled_by_default(self):
        with self.assertRaises(ValueError): Orders(self.file,self.broker,'TESTOWNER').submit(self.id,self.payload)
        self.assertEqual(self.broker.calls,0)
    def test_concurrent_double_click_submits_once(self):
        with concurrent.futures.ThreadPoolExecutor(max_workers=8) as pool:
            list(pool.map(lambda _:self.orders.submit(self.id,self.payload),range(20)))
        self.assertEqual(self.broker.calls,1)
    def test_timeout_and_restart_never_resend(self):
        self.broker.timeout=True
        self.assertEqual(self.orders.submit(self.id,self.payload)['state'],'UNKNOWN')
        restarted=Orders(self.file,self.broker,'TESTOWNER',max_quantity=65,enabled=True)
        restarted.submit(self.id,self.payload)
        restarted.reconcile(self.id)
        self.assertEqual(self.broker.calls,1)
    def test_changed_payload_rejected(self):
        self.orders.submit(self.id,self.payload)
        with self.assertRaises(ValueError): self.orders.submit(self.id,{**self.payload,'qty':1})
    def test_wrong_account_and_persistent_stop(self):
        self.broker.owner='DIFFERENT'
        self.assertEqual(self.orders.submit(self.id,self.payload)['state'],'BLOCKED')
        self.assertEqual(self.broker.calls,0)
        self.orders.stop()
        restarted=Orders(self.file,self.broker,'TESTOWNER',max_quantity=65,enabled=True)
        with self.assertRaises(ValueError): restarted.submit(str(uuid.uuid4()),self.payload)
    def test_acknowledgement_is_not_a_fill(self):
        result=self.orders.submit(self.id,self.payload)
        self.assertEqual(result['state'],'ACKNOWLEDGED')
        self.assertEqual(result['filled_qty'],0)
    def test_partial_fill_then_full_and_stale_update(self):
        result=self.orders.submit(self.id,self.payload)
        order={'id':'test-order','orderTag':'1:'+result['tag'],'symbol':self.payload['symbol'],
               'side':1,'qty':65,'status':6,'filledQty':30,'remainingQuantity':35,'tradedPrice':50}
        self.broker.matches=[order]
        self.assertEqual(self.orders.reconcile(self.id)['state'],'PARTIALLY_FILLED')
        self.broker.matches=[{**order,'status':2,'filledQty':65,'remainingQuantity':0}]
        self.assertEqual(self.orders.reconcile(self.id)['state'],'FILLED')
        self.broker.matches=[order]
        self.assertEqual(self.orders.reconcile(self.id)['filled_qty'],65)
    def test_rejected_and_cancelled_partial_orders_keep_filled_quantity(self):
        result=self.orders.submit(self.id,self.payload)
        self.broker.matches=[{'id':'test-order','orderTag':'1:'+result['tag'],**self.payload,
            'status':1,'filledQty':10,'remainingQuantity':55,'tradedPrice':50}]
        row=self.orders.reconcile(self.id)
        self.assertEqual(row['state'],'CANCELLED')
        self.assertEqual(row['filled_qty'],10)
    def test_other_broker_order_cannot_be_adopted(self):
        result=self.orders.submit(self.id,self.payload)
        self.broker.matches=[{'id':'another-order','orderTag':'1:'+result['tag'],**self.payload,
            'status':2,'filledQty':65,'remainingQuantity':0,'tradedPrice':50}]
        with self.assertRaises(ValueError):self.orders.reconcile(self.id)

if __name__=='__main__':unittest.main()
