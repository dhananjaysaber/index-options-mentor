import json
import os
from pathlib import Path
import subprocess
import sys
import tempfile
import time
import unittest
import uuid
ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT/'aws/live'))
from feed import Feed, INDEX
from feed_patch import patch, MARKER
from account_connect import callback_code, CALLBACK, request, proof_for, verify_owner, ConnectError
from diagnostic import SimulatedBroker, journal_class
from execution import Execution
from orders import Orders
from planner import EntryPlanner
from manager import Manager


class FeedTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory(); self.root = Path(self.temp.name)
        self.now = time.time(); self.symbol = 'NSE:NIFTYTEST25450PE'
        self.feed = Feed(self.root, clock=lambda:self.now)
        self.feed.subscriptions([self.symbol])
    def tearDown(self): self.temp.cleanup()
    def publish(self, price=230, option_age=0, index_age=0, connected=True, bid=True):
        raw = {'version':1, 'connected':connected, 'publishedAt':self.now*1000, 'quotes':[
            {'symbol':self.symbol, 'price':price, 'at':(self.now-option_age)*1000, **({'bid':price,'ask':price} if bid else {})},
            {'symbol':INDEX, 'price':25000, 'at':(self.now-index_age)*1000}]}
        p=self.root/'quotes.json'; p.write_text(json.dumps(raw)); p.chmod(0o600)
    def test_index_cannot_refresh_old_option_and_reverse(self):
        for option_age,index_age in [(4,0),(0,4)]:
            self.publish(option_age=option_age,index_age=index_age)
            with self.assertRaisesRegex(ValueError,'FRESH_OPTION_AND_INDEX'): self.feed.pair(self.symbol)
    def test_disconnect_and_invalid_book_block_execution(self):
        self.publish(connected=False)
        with self.assertRaisesRegex(ValueError,'DISCONNECTED'):self.feed.pair(self.symbol)
        self.publish(bid=False)
        with self.assertRaisesRegex(ValueError,'BID_ASK'):self.feed.quote(self.symbol)
    def test_permissions_and_links_rejected(self):
        self.publish(); (self.root/'quotes.json').chmod(0o644)
        with self.assertRaisesRegex(ValueError,'UNSAFE_FEED'):self.feed.pair(self.symbol)
        (self.root/'quotes.json').rename(self.root/'target.json');(self.root/'quotes.json').symlink_to('target.json')
        with self.assertRaisesRegex(ValueError,'UNSAFE_FEED'):self.feed.pair(self.symbol)
    def node_publish(self, price, at):
        script = '''
          import {createLiveFeedPublisher} from MODULE;
          const p=createLiveFeedPublisher({root:ROOT});
          p.status(true);
          p.accept('NSE:NIFTY50-INDEX',{price:25000,timestamp:AT});
          p.accept(SYMBOL,{price:PRICE,timestamp:AT},{bid_price:PRICE,ask_price:PRICE});
          if(!p.flush()) throw Error('PUBLISH_FAILED');
        '''.replace('MODULE',json.dumps((ROOT/'aws/live/liveFeedPublisher.mjs').as_uri())).replace('ROOT',json.dumps(str(self.root))).replace('AT',json.dumps(at)).replace('SYMBOL',json.dumps(self.symbol)).replace('PRICE',json.dumps(price))
        subprocess.run(['node','--input-type=module','-e',script],check=True,capture_output=True)
    def test_node_feed_to_shared_exit_to_single_final_journal_row_after_restart_and_replay(self):
        from datetime import datetime,timezone
        file = str(self.root/'isolated.sqlite3')
        quote={'symbol':self.symbol,'ask':230,'bid':230,'at':self.now}
        broker=SimulatedBroker(file,'OWNER',quote);orders=Orders(file,broker,'OWNER',1800,True)
        contract={'symbol':self.symbol,'active':True,'lot_size':65,'max_quantity':1800,'tick_size':.05,'checked_at':self.now,'expires_at':self.now+86400}
        # Production uses Feed.quote; the test exercises exactly that reader.
        execution=Execution(orders,EntryPlanner(lambda _:contract,self.feed.quote,lambda:True,30000,clock=lambda:self.now))
        journal=journal_class()(file); manager=Manager(execution,journal);entry=str(uuid.uuid4())
        for i, price in enumerate([230,260,240]):
            self.now=time.time();self.feed.subscriptions([self.symbol])
            at=datetime.fromtimestamp(self.now,timezone.utc).isoformat();quote.update(ask=price,bid=price,at=self.now)
            self.node_publish(price,at)
            if i==0:
                execution.prepare(entry,self.symbol,30000,'SCALP');execution.submit(entry);orders.reconcile(entry)
                manager.track(entry,{'symbol':self.symbol,'side':'PE','strategyFamily':'SCALP','underlyingEntry':25000,'underlyingStop':25100,'underlyingTarget':24900,'rr':1,'score':90},220)
            else:
                result=manager.pulse(entry,self.feed.pair(self.symbol),{})
                if i==1:
                    self.assertEqual(result['state'],'MANAGING');manager=Manager(execution,journal)
                else:self.assertEqual(result['state'],'CLOSED')
        before=broker.calls()
        for _ in range(2):self.assertEqual(manager.pulse(entry,self.feed.pair(self.symbol),{})['state'],'CLOSED')
        self.assertEqual(broker.calls(),before);self.assertEqual(journal.health()['trades'],1);self.assertEqual(journal.health()['events'],1)


class AccountConnectTests(unittest.TestCase):
    def test_callback_state_expiry_duplicate_and_wrong_destination(self):
        url=CALLBACK+'?state=abc&auth_code='+'x'*20
        self.assertEqual(callback_code(url,'abc',100,101),'x'*20)
        for bad in [url.replace('abc','wrong'),url+'&auth_code=duplicate',url.replace('trade.fyers.in','evil.example'),url+'#fragment']:
            with self.assertRaises(ConnectError):callback_code(bad,'abc',100,101)
        with self.assertRaises(ConnectError):callback_code(url,'abc',100,401)
    def test_foreign_account_rejected_before_persistence(self):
        secret='a'*40;expected=proof_for('OWNER',secret)
        self.assertEqual(verify_owner({'data':{'fy_id':'OWNER'}},expected,secret),'OWNER')
        with self.assertRaises(ConnectError):verify_owner({'data':{'fy_id':'OTHER'}},expected,secret)
    def test_login_client_has_no_mutation_route(self):
        class Trap:
            def open(self,*args,**kwargs):raise AssertionError('Network called')
        for route in ('orders/sync','logout','positions','profile'):
            with self.assertRaises(ConnectError):request(route,payload={'qty':65},opener=Trap())


class PatchTests(unittest.TestCase):
    def source(self):
        return """import { createPaperFeedDispatcher } from './paperFeedDispatcher.mjs';
const paperDispatcher = createPaperFeedDispatcher();
function syncOptionSubscriptions() {
 let changes;
    changes = getSubscriptionChanges(
      [...subscribedSymbols]
    );
}
function onMessage(message, routed, result) {
        subscriptionActive = true;
        paperDispatcher.accept(message.symbol, routed.quote);
    paperDispatcher.accept(SYMBOL, result.quote);
}
function handleUnexpectedDisconnect(reason) {
}
function shutdown() {
  stopping = true;
}
"""
    def test_preserves_paper_accepts_and_is_idempotent(self):
        before=self.source(); after=patch(before)
        self.assertEqual(after.count('paperDispatcher.accept('),before.count('paperDispatcher.accept('))
        self.assertEqual(patch(after),after);self.assertIn(MARKER,after)
        with tempfile.NamedTemporaryFile(suffix='.mjs',mode='w') as f:
            f.write(after);f.flush();subprocess.run(['node','--check',f.name],check=True,capture_output=True)
    def test_changed_or_incomplete_source_refused(self):
        with self.assertRaisesRegex(ValueError,'LAYOUT_CHANGED'):patch(self.source().replace('  stopping = true;','  stopping=true;'))
        with self.assertRaisesRegex(ValueError,'INCOMPLETE'):patch(MARKER+'\n'+self.source())

if __name__=='__main__':unittest.main()
