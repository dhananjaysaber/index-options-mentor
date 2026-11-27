import importlib.util,tempfile,unittest
from pathlib import Path
spec=importlib.util.spec_from_file_location('feed_restart',Path(__file__).resolve().parents[1]/'public/iom-feed-restart.py')
tool=importlib.util.module_from_spec(spec);spec.loader.exec_module(tool)

class FeedRestartTests(unittest.TestCase):
    def setUp(self):
        self.temp=tempfile.TemporaryDirectory();tool.UNIT_DIR=Path(self.temp.name)
        self.calls=[];self.state='inactive';self.load='loaded';self.exec='/usr/bin/node /opt/x/fyersMarketDaemon.mjs';self.applies=True;self.fail_start=False
        def run(args):
            self.calls.append(args)
            if args[1]=='start' and self.fail_start:raise OSError('no')
            if args[1]!='show':return ''
            new=self.applies and tool.drop_in().exists()
            return {'LoadState':self.load,'ExecStart':self.exec,'ActiveState':self.state,
                'Restart':'always' if new else 'on-failure','RestartUSec':'1min' if new else '100ms'}[args[3].split('=')[1]]
        tool.run=run
    def tearDown(self):self.temp.cleanup()
    def changed(self):return [c for c in self.calls if c[1]!='show']
    def test_installs_reports_stopped_feed_honestly_and_can_repeat(self):
        for _ in range(2):
            result=tool.install(wait=lambda s:None)
            self.assertFalse(result['feedRunningNow']);self.assertEqual(result['signedInToFyers'],'NOT_CHECKED')
        self.assertIn('Restart=always',tool.drop_in().read_text())
        self.state='active';self.assertTrue(tool.install(wait=lambda s:None)['feedRunningNow'])
    def test_only_the_price_feed_is_started_and_nothing_is_stopped(self):
        tool.install(wait=lambda s:None)
        self.assertEqual(self.changed(),[['systemctl','daemon-reload'],['systemctl','start',tool.SERVICE]])
    def test_unexpected_service_or_foreign_file_changes_nothing(self):
        for name,value in [('load','not-found'),('exec','/usr/bin/node other.mjs')]:
            old=getattr(self,name);setattr(self,name,value)
            with self.assertRaises(RuntimeError):tool.install(wait=lambda s:None)
            setattr(self,name,old)
        tool.drop_in().parent.mkdir(parents=True);tool.drop_in().write_text('[Service]\nRestart=no\n')
        with self.assertRaises(RuntimeError):tool.install(wait=lambda s:None)
        self.assertEqual(tool.drop_in().read_text(),'[Service]\nRestart=no\n');self.assertEqual(self.changed(),[])
    def test_failure_removes_the_new_file(self):
        for attribute,value,error in [('applies',False,RuntimeError),('fail_start',True,OSError)]:
            old=getattr(self,attribute);setattr(self,attribute,value)
            with self.assertRaises(error):tool.install(wait=lambda s:None)
            self.assertFalse(tool.drop_in().exists());self.assertEqual(self.changed()[-1],['systemctl','daemon-reload'])
            setattr(self,attribute,old)
    def test_undo_removes_only_our_file(self):
        tool.install(wait=lambda s:None);result=tool.undo()
        self.assertTrue(result['removed']);self.assertEqual(result['restartSettingNow'],'on-failure');self.assertFalse(tool.drop_in().exists())

if __name__=='__main__':unittest.main()
