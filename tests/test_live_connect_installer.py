"""Privileged mutations exercised in a disposable fake host, never real systemd."""
import importlib.util
import json
import os
from pathlib import Path
import pwd
import shutil
import sys
import tempfile
import unittest
from contextlib import ExitStack
from unittest.mock import patch
ROOT=Path(__file__).resolve().parents[1]
sys.path.insert(0,str(ROOT/'aws/live'));sys.path.insert(0,str(ROOT/'tests'))
import live_feed_test

class LiveConnectInstallerTests(unittest.TestCase):
    def setUp(self):
        self.temp=tempfile.TemporaryDirectory();self.root=Path(self.temp.name)
        self.base=self.root/'opt';(self.base/'app').mkdir(parents=True);(self.base/'journal').mkdir()
        self.daemon=self.base/'app/fyersMarketDaemon.mjs';self.original=live_feed_test.PatchTests().source();self.daemon.write_text(self.original)
        (self.base/'journal/store.py').write_text('production journal sentinel')
        spec=importlib.util.spec_from_file_location('live_connect_install_test',ROOT/'public/iom-live-connect.py')
        self.module=importlib.util.module_from_spec(spec);spec.loader.exec_module(self.module)
        self.module.BASE=self.base;self.module.FEED=self.root/'feed';self.calls=[]
    def tearDown(self):self.temp.cleanup()
    def install(self,*,position=False,fail_restart=False):
        def secure(path):
            if str(path).endswith('paper-state.json'):return {'scalp':{'status':'OPEN'}} if position else {}
            return {'connected':True,'publishedAt':self.module.time.time()*1000}
        def run(args,**kwargs):
            self.calls.append(args)
            if args[:2]==['systemctl','restart'] and fail_restart and kwargs.get('check'):raise RuntimeError('simulated restart failure')
        with ExitStack() as stack:
            stack.enter_context(patch.object(sys,'argv',['iom-live-connect.py']))
            stack.enter_context(patch.object(self.module,'run_tests'))
            stack.enter_context(patch.object(self.module,'active',return_value='active'))
            stack.enter_context(patch.object(self.module,'daemon_service',return_value='index-options-test-feed.service'))
            stack.enter_context(patch.object(self.module.os,'geteuid',return_value=0))
            stack.enter_context(patch.object(self.module.os,'chown'))
            stack.enter_context(patch.object(self.module.os,'fchown'))
            stack.enter_context(patch.object(self.module.pwd,'getpwnam',return_value=pwd.getpwuid(os.getuid())))
            stack.enter_context(patch.object(self.module.subprocess,'run',side_effect=run))
            stack.enter_context(patch('account_connect.secure_json',side_effect=secure))
            self.module.main()
    def test_open_paper_position_prevents_any_feed_edit_or_restart(self):
        with self.assertRaisesRegex(RuntimeError,'paper position'):self.install(position=True)
        self.assertEqual(self.daemon.read_text(),self.original)
        self.assertFalse(any(c[0]=='systemctl' for c in self.calls))
    def test_installs_shared_publisher_only_and_never_starts_second_socket_or_orders(self):
        self.install()
        self.assertIn('IOM_SEPARATE_LIVE_FEED_V1',self.daemon.read_text())
        self.assertEqual(self.daemon.read_text().count('paperDispatcher.accept('),2)
        self.assertEqual([c for c in self.calls if c[0]=='systemctl'],[['systemctl','restart','index-options-test-feed.service']])
        self.assertEqual((self.base/'journal/store.py').read_text(),'production journal sentinel')
        self.assertFalse((self.base/'app/fyers-token.json').exists())
    def test_restart_failure_restores_exact_original_source_and_publisher(self):
        publisher=self.base/'app/liveFeedPublisher.mjs';publisher.write_text('old publisher')
        with self.assertRaisesRegex(RuntimeError,'rolled back'):self.install(fail_restart=True)
        self.assertEqual(self.daemon.read_text(),self.original);self.assertEqual(publisher.read_text(),'old publisher')
    def test_unknown_daemon_layout_changes_no_app_file(self):
        self.daemon.write_text('unsupported source');self.original='unsupported source'
        with self.assertRaises(ValueError):self.install()
        self.assertEqual(self.daemon.read_text(),'unsupported source')
        self.assertFalse((self.base/'app/liveFeedPublisher.mjs').exists())

if __name__=='__main__':unittest.main()
