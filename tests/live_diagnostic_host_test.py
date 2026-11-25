import sys,tempfile,time,unittest,uuid
from pathlib import Path
ROOT=Path(__file__).resolve().parents[1];sys.path.insert(0,str(ROOT/'aws/live'))
from diagnostic_host import Checks
from bridge import signature

class HostTests(unittest.TestCase):
    def setUp(self):
        self.temp=tempfile.TemporaryDirectory();self.file=Path(self.temp.name)/'checks.sqlite3'
        self.owner='a'*64;self.secret='b'*64;self.checks=Checks(self.file,self.owner,self.secret)
    def tearDown(self): self.temp.cleanup()
    def headers(self,body,path,owner=None,stamp=None):
        owner=owner or self.owner;stamp=stamp or str(int(time.time()));nonce=uuid.uuid4().hex
        return {'X-IOM-Time':stamp,'X-IOM-Nonce':nonce,'X-IOM-Owner':owner,'X-IOM-Signature':signature(self.secret,stamp,nonce,owner,path,body)}
    def test_owner_timestamp_and_durable_nonce(self):
        body=b'{}';path='/monitor/live/status';headers=self.headers(body,path)
        self.checks.authenticate(headers,path,body)
        restarted=Checks(self.file,self.owner,self.secret)
        with self.assertRaises(PermissionError): restarted.authenticate(headers,path,body)
        with self.assertRaises(PermissionError): restarted.authenticate(self.headers(body,path,owner='c'*64),path,body)
        with self.assertRaises(PermissionError): restarted.authenticate(self.headers(body,path,stamp=str(int(time.time())-31)),path,body)
    def test_check_result_survives_restart_and_duplicate_id_returns_same_result(self):
        id=str(uuid.uuid4());result=self.checks.check(id)
        self.assertEqual(Checks(self.file,self.owner,self.secret).check(id),result)
        self.assertEqual(self.checks.status()['lastCheck'],result)
        self.assertFalse(result['realMoneyEnabled']);self.assertFalse(result['productionJournalTouched'])
    def test_disabled_status_is_explicit_before_any_check(self):
        status=self.checks.status();self.assertEqual(status['mode'],'DIAGNOSTICS_ONLY')
        self.assertFalse(status['realMoneyEnabled']);self.assertIsNone(status['lastCheck'])
    def test_signed_body_cannot_be_changed(self):
        path='/monitor/live/check';body=b'{"checkId":"fake"}';headers=self.headers(body,path)
        with self.assertRaises(PermissionError): self.checks.authenticate(headers,path,b'{}')
if __name__=='__main__':unittest.main()
