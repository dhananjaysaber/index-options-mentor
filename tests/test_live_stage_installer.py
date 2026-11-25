"""Exercise the privileged installer workflow inside a disposable fake /opt tree."""
import importlib.util
import os
import pwd
import shutil
import subprocess
import sys
import tempfile
import unittest
from contextlib import ExitStack
from pathlib import Path
from unittest.mock import patch

ROOT=Path(__file__).resolve().parents[1]

class InstallerTests(unittest.TestCase):
    def setUp(self):
        self.temp=tempfile.TemporaryDirectory(); self.base=Path(self.temp.name)/'server'
        self.base.mkdir(); (self.base/'journal').mkdir(); (self.base/'app').mkdir()
        shutil.copyfile(ROOT/'aws/journal/store.py',self.base/'journal/store.py')
        self.database=self.base/'journal/journal.sqlite3'; self.database.write_bytes(b'untouched production sentinel')
        self.app=self.base/'app/server.mjs'; self.app.write_text('unchanged')
        spec=importlib.util.spec_from_file_location('stage_install_test',ROOT/'public/iom-live-stage.py')
        self.module=importlib.util.module_from_spec(spec);spec.loader.exec_module(self.module)
        self.module.BASE=self.base;self.module.JOURNAL=self.base/'journal/store.py'
        self.real_run=subprocess.run
    def tearDown(self): self.temp.cleanup()
    def run_installer(self,fail=False):
        def simulated_mentor(command,**kwargs):
            self.assertEqual(command[:4],['sudo','-u','mentor','--'])
            if fail: raise subprocess.CalledProcessError(1,command)
            # The real tests run, but without sudo or any real production access.
            return self.real_run(command[command.index(sys.executable):],**kwargs)
        with ExitStack() as stack:
            stack.enter_context(patch.object(sys,'argv',['iom-live-stage.py']))
            stack.enter_context(patch.object(self.module.os,'geteuid',return_value=0))
            stack.enter_context(patch.object(self.module.os,'chown'))
            stack.enter_context(patch.object(self.module.pwd,'getpwnam',return_value=pwd.getpwuid(os.getuid())))
            stack.enter_context(patch.object(self.module,'active',return_value={'app':'active','journal':'active'}))
            stack.enter_context(patch.object(self.module.subprocess,'run',side_effect=simulated_mentor))
            self.module.main()
    def assert_production_untouched(self):
        self.assertEqual(self.database.read_bytes(),b'untouched production sentinel')
        self.assertEqual(self.app.read_text(),'unchanged')
    def test_install_and_repeat_are_disabled_and_leave_current_services_data_untouched(self):
        self.run_installer(); current=self.base/'live/current'; target=current.resolve()
        self.assertTrue(current.is_symlink());self.assertTrue((target/'aws/live/orders.py').is_file())
        import json
        status=json.loads((target/'installed.json').read_text())
        self.assertFalse(status['tradingEnabled']);self.assertFalse(status['serviceInstalled'])
        self.run_installer();self.assertEqual(current.resolve(),target)
        self.assert_production_untouched()
    def test_failed_tests_never_select_a_release(self):
        with self.assertRaises(subprocess.CalledProcessError): self.run_installer(fail=True)
        self.assertFalse((self.base/'live/current').exists())
        self.assert_production_untouched()
    def test_symlinked_release_directory_is_rejected(self):
        live=self.base/'live';live.mkdir();(live/'releases').symlink_to(self.base/'app',target_is_directory=True)
        with self.assertRaisesRegex(RuntimeError,'symlink'):self.run_installer()
        self.assert_production_untouched()

if __name__=='__main__':unittest.main()
