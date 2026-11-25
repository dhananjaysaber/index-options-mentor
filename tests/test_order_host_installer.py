"""Install and rollback against disposable /opt,/etc and /var trees only."""
from contextlib import ExitStack
import importlib.util
import json
import os
from pathlib import Path
import pwd
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
    def install(self,fail=False):
        def secure(path):
            path=str(path)
            if path.endswith('live-account.json'):return {'appId':'TRADINGAPP-200','accessToken':'x'*40,'ownerProof':'a'*64}
            if path.endswith('paper-owner.json'):return {'proof':'a'*64}
            if path.endswith('index-options-journal.json'):return {'secret':'s'*40}
            return json.loads(Path(path).read_text())
        def run(cmd,**kwargs):
            self.calls.append(cmd)
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
    def test_enabled_existing_host_is_not_overwritten(self):
        self.mod.HOST_CONFIG.write_text(json.dumps({'realMoneyEnabled':True}))
        with self.assertRaisesRegex(RuntimeError,'enabled order host'):self.install()
        self.assertTrue(json.loads(self.mod.HOST_CONFIG.read_text())['realMoneyEnabled']);self.assertEqual(self.site.read_text(),self.source)

if __name__=='__main__':unittest.main()
