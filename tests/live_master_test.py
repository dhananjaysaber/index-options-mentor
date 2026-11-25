import io,json,sys,unittest
from contextlib import redirect_stdout
from pathlib import Path
ROOT=Path(__file__).resolve().parents[1];sys.path.insert(0,str(ROOT/'aws/live'))
from market import read_nifty_master

class StreamingMasterTests(unittest.TestCase):
    def test_split_keys_numbers_unicode_and_records_match_standard_json(self):
        data={'NSE:OTHER-EQ':{'name':'text with } , { and \\" inside'},'NSE:NIFTYTESTCE':{'minLotSize':65,'qtyFreeze':'1755','name':'₹ index','expiryDate':'1796119800'},'NSE:NIFTYTESTPE':{'minLotSize':65},'NSE:STOCKCE':{'lots':[1,2,3]}}
        raw=json.dumps(data,ensure_ascii=False).encode()
        wanted={k:v for k,v in data.items() if k.startswith('NSE:NIFTY')}
        for size in (1,2,3,7,31,65536):self.assertEqual(read_nifty_master(io.BytesIO(raw),chunk_size=size),wanted)
    def test_realistic_master_larger_than_old_40mb_limit_uses_bounded_reads(self):
        # Generated as chunks; neither test nor parser builds the whole input.
        class LargeMaster:
            def __init__(self):self.index=-1;self.pending=b'';self.total=0;self.largest_read=0
            def read(self,n):
                assert 0<n<=65536
                self.largest_read=max(self.largest_read,n)
                while len(self.pending)<n:
                    self.index+=1
                    if self.index==0:part=b'{"NSE:NIFTYTESTCE":{"minLotSize":65,"qtyFreeze":"1755"}'
                    elif self.index<=45000:part=(',"NSE:STOCK'+str(self.index)+'CE":{"description":"'+'x'*1000+'"}').encode()
                    elif self.index==45001:part=b'}'
                    else:break
                    self.pending+=part
                value,self.pending=self.pending[:n],self.pending[n:];self.total+=len(value);return value
        stream=LargeMaster();result=read_nifty_master(stream)
        self.assertGreater(stream.total,40_000_000);self.assertEqual(list(result),['NSE:NIFTYTESTCE']);self.assertLessEqual(stream.largest_read,65536)
    def test_truncation_trailing_data_duplicate_and_size_limits_fail_closed(self):
        for raw in (b'{"NSE:NIFTYTESTCE":',b'{"NSE:NIFTYTESTCE":{}}garbage',b'{"NSE:NIFTYTESTCE":{},"NSE:NIFTYTESTCE":{}}',b'[]'):
            with self.assertRaises(ValueError):read_nifty_master(io.BytesIO(raw),chunk_size=3)
        with self.assertRaisesRegex(ValueError,'TOO_LARGE'):read_nifty_master(io.BytesIO(b'{"NSE:NIFTYTESTCE":{}}'),max_bytes=10,chunk_size=3)
    def test_missing_option_records_are_not_replaced_with_guesses(self):
        with self.assertRaisesRegex(ValueError,'NO_NIFTY'):read_nifty_master(io.BytesIO(b'{"NSE:STOCKCE":{}}'))

if __name__=='__main__':unittest.main()

class StartupPrivacyTests(unittest.TestCase):
    def test_startup_reason_never_contains_private_broker_payloads(self):
        from order_host import startup,StartupError
        def reject():raise ValueError('private-token-with.dots and account details')
        with self.assertRaises(StartupError) as caught:startup('TRADING_ACCOUNT_READ',reject)
        self.assertEqual(caught.exception.stage,'TRADING_ACCOUNT_READ');self.assertEqual(caught.exception.reason,'ValueError')
    def test_preflight_uses_disabled_configuration_without_opening_a_listener(self):
        from unittest.mock import patch
        from types import SimpleNamespace
        import order_host
        runtime=SimpleNamespace(market=SimpleNamespace(master={'NIFTY':{}}))
        with patch.object(sys,'argv',['order_host.py','preflight']),patch.object(order_host,'secure_json',return_value={'secret':'x'*40}),patch.object(order_host,'build',return_value=runtime) as build,patch.object(order_host,'server') as listener:
            with redirect_stdout(io.StringIO()) as output:order_host.main()
        self.assertFalse(json.loads(output.getvalue())['realMoneyEnabled'])
        self.assertIs(build.call_args[0][0]['realMoneyEnabled'],False);listener.assert_not_called()
