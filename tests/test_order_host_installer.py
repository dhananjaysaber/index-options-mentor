"""Install and rollback against disposable /opt,/etc and /var trees only."""
from contextlib import ExitStack
import importlib.util
import json
import os
from pathlib import Path
import pwd
import sqlite3
import subprocess
import sys
import tempfile
import unittest
from unittest.mock import patch
ROOT=Path(__file__).resolve().parents[1];sys.path.insert(0,str(ROOT/'aws/live'))
class HostInstallerTests(unittest.TestCase):
    def setUp(self):
        self.temp=tempfile.TemporaryDirectory();self.root=Path(self.temp.name);self.base=self.root/'opt';(self.base/'journal').mkdir(parents=True)
        (self.base/'journal/store.py').write_text('unchanged journal sentinel')
        self.nginx=self.root/'nginx';self.nginx.mkdir();self.site=self.nginx/'api';self.source='server {\n server_name api.optionsmentor.in;\n location / { return 404; }\n}\n';self.site.write_text(self.source)
        self.units=self.root/'units';self.units.mkdir()
        spec=importlib.util.spec_from_file_location('order_host_installer_test',ROOT/'public/iom-order-host.py');self.mod=importlib.util.module_from_spec(spec);spec.loader.exec_module(self.mod)
        self.mod.BASE=self.base;self.mod.DATA=self.root/'data';self.mod.UNIT_DIR=self.units;self.mod.NGINX_DIRS=(str(self.nginx),);self.mod.HOST_CONFIG=self.root/'config.json';self.calls=[]
    def tearDown(self):self.temp.cleanup()
    def install(self,fail=False,fail_preflight=False):
        def secure(path):
            path=str(path)
            if path.endswith('live-account.json'):return {'appId':'TRADINGAPP-200','accessToken':'x'*40,'ownerProof':'a'*64}
            if path.endswith('paper-owner.json'):return {'proof':'a'*64}
            if path.endswith('index-options-journal.json'):return {'secret':'s'*40}
            return json.loads(Path(path).read_text())
        def run(cmd,**kwargs):
            self.calls.append(cmd)
            if fail_preflight and cmd[-1:] == ['preflight']:raise RuntimeError('simulated preflight failure')
            if fail and cmd[:2]==['systemctl','restart'] and kwargs.get('check'):raise RuntimeError('simulated restart failed')
            return subprocess.CompletedProcess(cmd,1 if 'is-enabled' in cmd else 0)
        with ExitStack() as stack:
            for obj,name,value in [(sys,'argv',['iom-order-host.py']),(self.mod.os,'geteuid',lambda:0),(self.mod.os,'chown',lambda *a:None),(self.mod.pwd,'getpwnam',lambda _:pwd.getpwuid(os.getuid())),(self.mod,'states',lambda:{'existing-app':'active'}),(self.mod,'active',lambda _:'inactive'),(self.mod.subprocess,'run',run),(self.mod,'status_request',lambda *a:{'ok':True,'mode':'OWNED_EXECUTION_HOST','realMoneyEnabled':False,'actualLiveExecutionHostReleased':True})]:
                stack.enter_context(patch.object(obj,name,value))
            stack.enter_context(patch('account_connect.secure_json',side_effect=secure));stack.enter_context(patch('account_connect.request',return_value={'s':'ok','data':{'fy_id':'OWNER'}}));stack.enter_context(patch('account_connect.verify_owner',return_value='OWNER'))
            self.mod.main()
    def test_installs_disabled_and_adds_new_route_and_daily_ledger_timer_only(self):
        self.install();config=json.loads(self.mod.HOST_CONFIG.read_text());self.assertFalse(config['realMoneyEnabled'])
        self.assertIn('127.0.0.1:9078',self.site.read_text());self.assertIn('20:25:00 Asia/Kolkata',(self.units/'index-options-order-backup.timer').read_text())
        self.assertTrue((self.units/self.mod.SERVICE).exists());self.assertEqual((self.base/'journal/store.py').read_text(),'unchanged journal sentinel')
        touched=[x for c in self.calls if c and c[0]=='systemctl' for x in c[2:]]
        self.assertNotIn('index-options-mentor.service',touched);self.assertNotIn('index-options-marketdata.service',touched)
    def test_restart_failure_restores_route_and_removes_new_units(self):
        with self.assertRaisesRegex(RuntimeError,'restored'):self.install(fail=True)
        self.assertEqual(self.site.read_text(),self.source);self.assertFalse(self.mod.HOST_CONFIG.exists());self.assertFalse((self.units/self.mod.SERVICE).exists())
    def test_preflight_failure_changes_no_units_or_routes(self):
        with self.assertRaisesRegex(RuntimeError,'preflight'):self.install(fail_preflight=True)
        self.assertEqual(self.site.read_text(),self.source);self.assertFalse(self.mod.HOST_CONFIG.exists())
        self.assertEqual(list(self.units.iterdir()),[])
        self.assertFalse(any(c[:2] in (['systemctl','enable'],['systemctl','restart']) for c in self.calls))
    def test_signed_check_goes_to_the_single_main_address(self):
        self.assertEqual(self.mod.NETLIFY,'https://optionsmentor.netlify.app')
    def ledger(self,sold=0,outside=None):
        self.mod.DATA.mkdir()
        with sqlite3.connect(self.mod.DATA/'orders.sqlite3') as db:
            db.execute('CREATE TABLE live_intents (id TEXT PRIMARY KEY,state TEXT,parent_id TEXT,filled_qty INTEGER)')
            db.execute("INSERT INTO live_intents VALUES ('buy','FILLED',NULL,65)")
            if sold:db.execute("INSERT INTO live_intents VALUES ('sale','FILLED','buy',?)",(sold,))
            db.execute('CREATE TABLE live_external_closes (entry_id TEXT PRIMARY KEY,quantity INTEGER,noticed_at TEXT)')
            if outside:db.execute("INSERT INTO live_external_closes VALUES ('buy',?,'now')",(outside,))
        self.mod.HOST_CONFIG.write_text(json.dumps({'realMoneyEnabled':False,'operatorApprovedAppId':'TRADINGAPP-200'}))
    def test_reinstall_while_a_trade_is_held_keeps_the_operator_approval(self):
        self.ledger();before=self.mod.HOST_CONFIG.read_text()
        with self.assertRaisesRegex(RuntimeError,'require review'):self.install()
        self.assertEqual(self.mod.HOST_CONFIG.read_text(),before);self.assertEqual(self.site.read_text(),self.source);self.assertEqual(self.calls,[c for c in self.calls if c[:1]!=['systemctl']])
    def test_part_sold_trade_still_counts_as_held(self):
        self.ledger(outside=30)
        with self.assertRaisesRegex(RuntimeError,'require review'):self.install()
    def test_trade_confirmed_sold_outside_the_app_does_not_block_reinstall(self):
        self.ledger(outside=65);self.install()
        self.assertNotIn('operatorApprovedAppId',json.loads(self.mod.HOST_CONFIG.read_text()))
    def test_every_local_import_is_inside_each_setup_package(self):
        import ast,base64,posixpath,re,zlib
        for name in ('order-host','execution-connect','live-connect'):
            tree=ast.parse((ROOT/f'public/iom-{name}.py').read_text())
            payload=next(n.value.value for n in tree.body if isinstance(n,ast.Assign) and getattr(n.targets[0],'id','')=='PAYLOAD')
            files=json.loads(zlib.decompress(base64.b64decode(payload)))['files']
            for path,source in files.items():
                self.assertEqual(source,(ROOT/path).read_text() if path!='package.json' else source,f'{name}: {path} is out of date')
                if not path.endswith(('.mjs','.js')):continue
                for found in re.findall(r"(?:\bfrom\s*|\bimport\s*\(?\s*)['\"](\.{1,2}/[^'\"]+)['\"]",source):
                    target=posixpath.normpath(posixpath.join(posixpath.dirname(path),found))
                    self.assertIn(target,files,f'{name}: {path} needs {target}')
    def test_enabled_existing_host_is_not_overwritten(self):
        self.mod.HOST_CONFIG.write_text(json.dumps({'realMoneyEnabled':True}))
        with self.assertRaisesRegex(RuntimeError,'enabled order host'):self.install()
        self.assertTrue(json.loads(self.mod.HOST_CONFIG.read_text())['realMoneyEnabled']);self.assertEqual(self.site.read_text(),self.source)

if __name__=='__main__':unittest.main()
