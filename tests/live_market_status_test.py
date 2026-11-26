"""Regression: official FYERS data-host market status and NSE F&O session codes.

All tests use fake HTTP/account responses and never submit broker orders.
"""
import json
import sys
import unittest
from datetime import datetime
from pathlib import Path
from zoneinfo import ZoneInfo

sys.path.insert(0, str(Path(__file__).resolve().parents[1] / 'aws/live'))
from fyers_rest import FyersRest
from market import Market

class Response:
    def __init__(self, payload):
        self.payload = payload
    def __enter__(self):
        return self
    def __exit__(self, *_):
        return False
    def read(self, _limit):
        return json.dumps(self.payload).encode()

class Opener:
    def __init__(self, payload):
        self.payload, self.urls, self.methods = payload, [], []
    def open(self, request, timeout):
        self.urls.append(request.full_url)
        self.methods.append(request.get_method())
        return Response(self.payload)

class Client:
    def __init__(self, rows):
        self.rows, self.calls = rows, 0
    def market_status(self):
        self.calls += 1
        return {'s': 'ok', 'marketStatus': self.rows}

def row(exchange=10, segment=11, market_type='NORMAL', status='OPEN'):
    return {'exchange': exchange, 'segment': segment,
            'market_type': market_type, 'status': status}

class MarketStatusTests(unittest.TestCase):
    def test_transport_uses_official_data_endpoint_not_order_endpoint(self):
        opener = Opener({'s':'ok','marketStatus':[row()]})
        client = FyersRest('TESTAPP-200', 'a'*40, opener=opener, send_enabled=False)
        self.assertEqual(client.market_status()['marketStatus'], [row()])
        self.assertEqual(opener.urls, ['https://api-t1.fyers.in/data/marketStatus'])
        self.assertEqual(opener.methods, ['GET'])

    def open_at(self, rows, hour=12, minute=36):
        clock = datetime(2026, 11, 26, hour, minute,
                         tzinfo=ZoneInfo('Asia/Kolkata')).timestamp()
        client = Client(rows)
        market = Market(client, lambda: {}, clock=lambda: clock)
        return market.session_open(), client.calls

    def test_accepts_only_normal_nse_equity_derivatives_open(self):
        self.assertEqual(self.open_at([row(exchange=10, segment=10), row()]), (True, 1))

    def test_nse_equity_cash_open_does_not_unlock_derivatives(self):
        self.assertEqual(self.open_at([row(exchange=10, segment=10)]), (False, 1))

    def test_non_nse_segment_and_auction_do_not_unlock(self):
        self.assertEqual(self.open_at([row(exchange=12), row(market_type='CALL_AUCTION2')]), (False, 1))

    def test_closed_derivatives_and_legacy_string_codes_fail_closed(self):
        self.assertEqual(self.open_at([row(status='CLOSED')]), (False, 1))
        self.assertEqual(self.open_at([row(exchange='NSE', segment='FO')]), (False, 1))

    def test_outside_entry_hours_skips_broker_request(self):
        self.assertEqual(self.open_at([row()], hour=15, minute=16), (False, 0))
        self.assertEqual(self.open_at([row()], hour=9, minute=14), (False, 0))

if __name__ == '__main__':
    unittest.main()
