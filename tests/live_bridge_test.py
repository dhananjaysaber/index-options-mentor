import importlib.util
import json
import sqlite3
import sys
import tempfile
import threading
import time
import unittest
import urllib.error
import urllib.request
import uuid
from pathlib import Path

ROOT=Path(__file__).resolve().parents[1]
sys.path.insert(0,str(ROOT/'aws/live'))
from bridge import make_server,signature
from orders import Orders
from planner import EntryPlanner
from execution import Execution
from live_execution_test import FakeBroker,SYMBOL,uid
from lift_lot_limit import lift


class BridgeTests(unittest.TestCase):
    def setUp(self):
        lift(self)
        self.temp=tempfile.TemporaryDirectory(); self.file=str(Path(self.temp.name)/'journal.sqlite3')
        spec=importlib.util.spec_from_file_location('bridge_test_journal',ROOT/'aws/journal/store.py')
        module=importlib.util.module_from_spec(spec); spec.loader.exec_module(module)
        self.journal=module.Journal(self.file)
        self.broker=FakeBroker(); self.now=time.time(); self.key='test-only-secret-'+'x'*32
        contract={'symbol':SYMBOL,'active':True,'lot_size':65,'max_quantity':1800,
                  'tick_size':.05,'checked_at':self.now,'expires_at':self.now+86400}
        quote={'symbol':SYMBOL,'ask':230,'at':self.now}
        planner=EntryPlanner(lambda _:contract,lambda _:quote,lambda:True,max_amount=30000,clock=lambda:self.now)
        self.orders=Orders(self.file,self.broker,'OWNER',1800,True)
        self.execution=Execution(self.orders,planner)
        self.server=make_server(self.execution,self.journal,self.key)
        self.thread=threading.Thread(target=self.server.serve_forever,daemon=True); self.thread.start()
    def tearDown(self):
        self.server.shutdown(); self.server.server_close(); self.thread.join(); self.temp.cleanup()
    def request(self,path,payload,nonce=None,owner='OWNER',key=None,stamp=None):
        body=json.dumps(payload,separators=(',',':')).encode()
        stamp=str(int(time.time())) if stamp is None else str(stamp); nonce=nonce or uuid.uuid4().hex
        headers={'Content-Type':'application/json','X-IOM-Time':stamp,'X-IOM-Nonce':nonce,'X-IOM-Owner':owner,
                 'X-IOM-Signature':signature(key or self.key,stamp,nonce,owner,path,body)}
        req=urllib.request.Request('http://127.0.0.1:'+str(self.server.server_port)+path,data=body,headers=headers)
        try:
            with urllib.request.urlopen(req,timeout=5) as response: return response.status,json.load(response)
        except urllib.error.HTTPError as response: return response.code,json.load(response)
    def test_unsigned_wrong_owner_stale_and_replayed_requests_blocked(self):
        for kw in [{'key':'wrong'},{'owner':'OTHER'},{'stamp':int(time.time())-31}]:
            self.assertEqual(self.request('/live/prepare',{'intentId':uid(),'symbol':SYMBOL,'amount':30000,'strategy':'SCALP'},**kw)[0],401)
        nonce=uuid.uuid4().hex
        self.assertEqual(self.request('/live/reconcile',{},nonce=nonce)[0],200)
        self.assertEqual(self.request('/live/reconcile',{},nonce=nonce)[0],409)
        self.assertEqual(self.broker.calls,0)
    def test_http_entry_exit_replay_and_restart_one_journal_row(self):
        entry=uid()
        status,plan=self.request('/live/prepare',{'intentId':entry,'symbol':SYMBOL,'amount':30000,'strategy':'SCALP'})
        self.assertEqual(status,200); self.assertEqual(plan['result']['payload']['qty'],130)
        self.assertEqual(self.request('/live/submit',{'intentId':entry})[0],200)
        self.broker.fill(self.orders.get(entry)['broker_id'])
        self.assertEqual(self.request('/live/reconcile',{})[0],200)
        out=uid(); exit_payload={'intentId':out,'entryId':entry,'price':240,'quantity':130}
        self.assertEqual(self.request('/live/exit',exit_payload)[0],200)
        self.broker.fill(self.orders.get(out)['broker_id'],price=240)
        self.assertEqual(self.request('/live/reconcile',{})[0],200)
        self.assertEqual(self.request('/live/exit',exit_payload)[0],200)
        self.assertEqual(self.request('/live/reconcile',{})[0],200)
        restarted=Execution(Orders(self.file,self.broker,'OWNER',1800,True),self.execution.planner)
        restarted.recover(self.journal)
        self.assertEqual(self.broker.calls,2)
        self.assertEqual((self.journal.health()['trades'],self.journal.health()['events']),(1,1))
        trade=self.journal.list_trades()['trades'][0]
        self.assertEqual(trade['grossPnl'],1300)
        self.assertEqual((trade['strategyFamily'],trade['side'],trade['lots']),('SCALP','PE',2))
    def test_daily_journal_backup_includes_live_ledger_and_replay_receipts(self):
        entry=uid(); self.execution.prepare(entry,SYMBOL,30000); row=self.execution.submit(entry)
        self.broker.fill(row['broker_id']); self.orders.reconcile(entry)
        out=self.execution.exit(uid(),entry,240,130)
        self.broker.fill(out['broker_id'],price=240); self.execution.recover(self.journal)
        backup=self.journal.backup(Path(self.temp.name)/'backups')
        with sqlite3.connect(backup['file']) as db:
            self.assertEqual(db.execute('PRAGMA integrity_check').fetchone()[0],'ok')
            self.assertEqual(db.execute('SELECT count(*) FROM trades').fetchone()[0],1)
            self.assertEqual(db.execute('SELECT count(*) FROM live_intents').fetchone()[0],2)
            self.assertEqual(db.execute('SELECT count(*) FROM live_journal_outbox WHERE delivered=1').fetchone()[0],1)
            self.assertGreater(db.execute('SELECT count(*) FROM live_audit').fetchone()[0],0)

    def test_disabled_coordinator_never_transmits_through_http(self):
        self.orders.enabled=False; i=uid()
        self.assertEqual(self.request('/live/prepare',{'intentId':i,'symbol':SYMBOL,'amount':30000,'strategy':'SCALP'})[0],200)
        self.assertEqual(self.request('/live/submit',{'intentId':i})[0],409)
        self.assertEqual(self.broker.calls,0)
    def test_raw_broker_payload_injection_rejected(self):
        self.assertEqual(self.request('/live/prepare',{'intentId':uid(),'symbol':SYMBOL,'amount':30000,'strategy':'SCALP','qty':999})[0],409)
        self.assertEqual(self.broker.calls,0)

if __name__=='__main__':unittest.main()
