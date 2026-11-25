import importlib.util
import json
from datetime import datetime, timezone
from pathlib import Path
import sys
import tempfile
import unittest
from unittest.mock import patch
import io

ROOT=Path(__file__).resolve().parents[1]
sys.path.insert(0,str(ROOT/'aws/readiness'))
import release_check as check
spec=importlib.util.spec_from_file_location('release_journal',ROOT/'aws/journal/store.py')
module=importlib.util.module_from_spec(spec);spec.loader.exec_module(module)


class FakeSheet:
    def __init__(self): self.rows={};self.deliveries=[]
    def __call__(self,payload):
        action=payload['action']
        if action=='health': return {'ok':True,'trades':len(self.rows)}
        if action=='list_trades': return {'ok':True,'trades':list(self.rows.values())}
        if action=='journal_event':
            trade=payload['event']['trade'];self.rows[trade['id']]=dict(trade)
            self.deliveries.append(payload['event']['id'])
            return {'ok':True}
        raise AssertionError(action)


class ReleaseCheckTests(unittest.TestCase):
    def setUp(self):
        self.temp=tempfile.TemporaryDirectory();self.root=Path(self.temp.name)
        self.journal=module.Journal(self.root/'journal.sqlite3')
        self.trade={'id':'existing-paper-close','mode':'SIMULATION','entry':100,'exit':110,
            'quantity':65,'pnl':650,'closedAt':datetime.now(timezone.utc).isoformat(),'executionMode':'PAPER_ONLY',
            'brokerOrderPlaced':False}
        self.journal.event({'id':'close:existing-paper-close','type':'TRADE_CLOSED',
            'trade':self.trade,'queuedAt':self.trade['closedAt']})
        self.sheet=FakeSheet()
    def tearDown(self): self.temp.cleanup()

    def test_existing_close_exports_and_replays_once_without_new_production_events(self):
        result=check.audit_journal(self.journal,self.root,self.sheet,pause=lambda _:None)
        self.assertTrue(result['passed'])
        self.assertEqual(result['matchingSheetRowsAfterReplay'],1)
        self.assertEqual(result['exportedExistingRecords'],1)
        self.assertTrue(result['backupVerified'])
        self.assertTrue(result['productionTradeCountUnchanged'])
        self.assertTrue(result['productionEventCountUnchanged'])
        self.assertEqual(self.sheet.deliveries,['sqlite:existing-paper-close:1']*3)
        self.assertEqual(self.journal.health()['events'],1)
        self.assertEqual(self.journal.health()['trades'],1)
        self.assertEqual(self.journal.health()['maintenance']['last_export_error'],'')

    def test_export_failure_keeps_rows_queued_and_backup_verified(self):
        def failed(payload): raise check.ExportFailure('EXPORT_GATEWAY_HTTP_401')
        result=check.audit_journal(self.journal,self.root,failed,pause=lambda _:None)
        self.assertFalse(result['passed'])
        self.assertTrue(result['backupVerified'])
        self.assertEqual(result['exportBlocker'],'EXPORT_GATEWAY_HTTP_401')
        self.assertEqual(result['pendingExportRecords'],1)
        self.assertEqual(self.journal.health()['events'],1)

    def test_truncated_sheet_history_never_proves_uniqueness(self):
        self.sheet.rows['existing-paper-close']=self.trade
        original=self.sheet
        def truncated(payload):
            if payload['action']=='health': return {'ok':True,'trades':1001}
            return original(payload)
        result=check.audit_journal(self.journal,self.root,truncated,pause=lambda _:None)
        self.assertFalse(result['passed'])
        self.assertFalse(result['replayVerified'])
        self.assertEqual(result['pendingExportRecords'],1)

    def test_duplicate_sheet_rows_fail_replay_check_without_deleting_data(self):
        original=self.sheet
        def duplicate(payload):
            if payload['action']=='health':return {'ok':True,'trades':2}
            if payload['action']=='list_trades':return {'ok':True,'trades':[self.trade,self.trade]}
            return original(payload)
        result=check.audit_journal(self.journal,self.root,duplicate,pause=lambda _:None)
        self.assertFalse(result['passed'])
        self.assertEqual(result['exportBlocker'],'SHEETS_EXISTING_TRADE_NOT_UNIQUE')
        self.assertEqual(self.journal.health()['trades'],1)

    def test_deployed_simulation_requires_explicit_no_real_orders_claims(self):
        valid = {'mode':'SIMULATED_EXECUTION_CHECK','realMoneyEnabled':False,
            'productionJournalTouched':False,'brokerNetworkRequests':0,
            'checks':[{'strategy':strategy,'passed':True,'journalRows':1,
                'journalEvents':1,'replayCreatedOrders':0} for strategy in ('CORE','SCALP')]}
        class Opener:
            def __init__(self,result):self.result=result
            def open(self,request,timeout):
                self.request=request
                return io.BytesIO(json.dumps(self.result).encode())
        def configuration(path,uid):
            return {'owner':'0'*64} if str(path).endswith('paper-owner.json') else {'secret':'test-secret-'*4}
        with patch('pwd.getpwnam'), patch.object(check.account,'secure_json',side_effect=configuration):
            opener=Opener(valid)
            with patch.object(check.urllib.request,'build_opener',return_value=opener):
                self.assertTrue(check.check_simulation()['passed'])
            self.assertEqual(opener.request.full_url,'https://deploy-preview-28--optionsmentor.netlify.app/api/execution/maintenance')
            self.assertEqual(opener.request.get_method(),'POST')
            self.assertEqual(set(json.loads(opener.request.data)),{'checkId'})
            for changed in ({'realMoneyEnabled':True},{'productionJournalTouched':True},
                            {'brokerNetworkRequests':1},{'mode':'LIVE'}):
                with patch.object(check.urllib.request,'build_opener',return_value=Opener({**valid,**changed})):
                    with self.assertRaises(check.ExportFailure):check.check_simulation()

    def test_packaged_source_hashes_match(self):
        import base64,zlib,re,hashlib
        source=(ROOT/'public/iom-release-check.py').read_text()
        import ast
        tree=ast.parse(source)
        assignment=next(n for n in tree.body if isinstance(n,ast.Assign) and any(isinstance(t,ast.Name) and t.id=='raw' for t in n.targets))
        encoded=assignment.value.args[0].args[0].value
        raw=zlib.decompress(base64.b64decode(encoded))
        package=json.loads(raw)
        for name,content in package.items():
            self.assertEqual(content,(ROOT/'aws/readiness'/name).read_text())

if __name__=='__main__':unittest.main()
