"""The app's trading sign-in. Artificial FYERS only; no network."""
import hashlib
import json
import os
import sys
import tempfile
import threading
import time
import unittest
import urllib.error
import urllib.request
import uuid
from pathlib import Path
from urllib.parse import parse_qs, urlsplit
from unittest.mock import patch
sys.path.insert(0, str(Path(__file__).resolve().parents[1]/'aws/live'))
import order_host
from account_connect import ConnectError, proof_for
from bridge import signature
from trading_login import APP_CALLBACK, TradingLogin, effective_account

SECRET = 'only-test-key-'*4
APP = 'TESTTRADE-200'
APP_SECRET = 'only-test-app-secret'
OLD, NEW = 'old_token_'+'x'*30, 'new_token_'+'y'*30
OWNER = proof_for('TESTOWNER', SECRET)
CODE = 'one-time-code.'+'z'*40


class Case(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory(); self.folder = Path(self.temp.name)
        self.now = 1_800_000_000.0; self.calls = []; self.owner = 'TESTOWNER'; self.fail = None
        self.base = {'version': 1, 'appId': APP, 'accessToken': OLD, 'ownerProof': OWNER, 'verifiedAt': self.now-3*86400}
        self.app = {'appId': APP, 'appSecret': APP_SECRET}
        self.login = TradingLogin(self.base, SECRET, self.folder, lambda: self.app, requester=self.fyers, clock=lambda: self.now)
    def tearDown(self): self.temp.cleanup()
    def fyers(self, route, *, app=None, token=None, payload=None):
        self.calls.append((route, token, payload))
        if route == self.fail: raise ConnectError('private text from FYERS')
        if route == 'validate-authcode': return {'s': 'ok', 'access_token': NEW}
        return {'s': 'ok', 'data': {'fy_id': self.owner}}
    def state(self):
        return parse_qs(urlsplit(self.login.start()['loginUrl']).query)['state'][0]
    def refused(self, reason, state, code=CODE):
        with self.assertRaisesRegex(ValueError, '^'+reason+'$'): self.login.finish(state, code)
        self.assertEqual(self.login.account()['accessToken'], OLD)
        self.assertFalse((self.folder/'trading-login.json').exists())


class LoginTests(Case):
    def test_link_goes_to_fyers_with_the_app_address_and_no_secret(self):
        url = self.login.start()['loginUrl']; query = parse_qs(urlsplit(url).query)
        self.assertTrue(url.startswith('https://api-t1.fyers.in/api/v3/generate-authcode?'))
        self.assertEqual((query['client_id'], query['redirect_uri']), ([APP], [APP_CALLBACK]))
        self.assertNotIn(APP_SECRET, url); self.assertEqual(self.calls, [])
    def test_good_sign_in_is_saved_privately_and_used(self):
        self.assertEqual(self.login.finish(self.state(), CODE), {'connected': True})
        file = self.folder/'trading-login.json'
        self.assertEqual((self.login.account()['accessToken'], file.stat().st_mode & 0o777), (NEW, 0o600))
        self.assertNotIn(APP_SECRET, file.read_text()); self.assertNotIn(CODE, file.read_text())
        self.assertEqual(self.calls[0][2]['appIdHash'], hashlib.sha256((APP+':'+APP_SECRET).encode()).hexdigest())
        self.assertEqual([c[0] for c in self.calls], ['validate-authcode', 'profile', 'funds', 'orders', 'positions'])
        self.assertEqual(self.login.summary(), {'ready': True, 'signedInToday': True})
        self.now += 86400; self.assertFalse(self.login.summary()['signedInToday'])
    def test_a_sign_in_can_be_used_once(self):
        state = self.state(); self.login.finish(state, CODE); before = len(self.calls)
        with self.assertRaisesRegex(ValueError, 'NOT_STARTED_HERE'): self.login.finish(state, CODE)
        self.assertEqual(len(self.calls), before)
    def test_a_sign_in_not_started_here_never_reaches_fyers(self):
        self.refused('TRADING_LOGIN_NOT_STARTED_HERE', 'b'*64); self.state(); self.refused('TRADING_LOGIN_NOT_STARTED_HERE', 'b'*64)
        self.assertEqual(self.calls, [])
    def test_expired_after_five_minutes(self):
        state = self.state(); self.now += 301; self.refused('TRADING_LOGIN_EXPIRED', state); self.assertEqual(self.calls, [])
    def test_another_account_is_never_saved(self):
        self.owner = 'SOMEONE-ELSE'; self.refused('TRADING_LOGIN_WRONG_ACCOUNT', self.state())
    def test_nothing_is_saved_unless_every_read_works(self):
        for route in ('validate-authcode', 'profile', 'funds', 'orders', 'positions'):
            self.fail = route; self.refused('FYERS_DID_NOT_ACCEPT_SIGN_IN', self.state())
    def test_needs_the_secret_saved_for_the_same_app(self):
        for app in (None, {'appId': 'OTHERAPP-200', 'appSecret': APP_SECRET}, {'appId': APP}):
            self.app = app
            with self.assertRaisesRegex(ValueError, 'TRADING_APP_NOT_SAVED_ON_SERVER'): self.login.start()
            self.assertFalse(self.login.summary()['ready'])
    def test_bad_shapes_are_refused(self):
        state = self.state()
        for bad in ((state, 'short'), (state, 'has space in the code'), ('xyz', CODE), (None, CODE), (state, 'a'*6001)):
            with self.assertRaisesRegex(ValueError, 'TRADING_LOGIN_INVALID'): self.login.finish(*bad)
    def test_only_a_newer_sign_in_for_the_same_app_and_owner_is_used(self):
        file = self.folder/'trading-login.json'
        good = {'appId': APP, 'ownerProof': OWNER, 'accessToken': NEW, 'verifiedAt': self.now}
        for change in ({'appId': 'OTHERAPP-200'}, {'ownerProof': 'f'*64}, {'verifiedAt': self.base['verifiedAt']-1}, {'accessToken': 'bad token'}):
            file.write_text(json.dumps({**good, **change})); self.assertEqual(effective_account(self.base, file)['accessToken'], OLD)
        file.write_text('{broken'); self.assertEqual(effective_account(self.base, file)['accessToken'], OLD)
        file.write_text(json.dumps(good)); self.assertEqual(effective_account(self.base, file)['accessToken'], NEW)


class SaveAppTests(unittest.TestCase):
    def run_save(self, typed):
        import account_connect as tool
        saved = []; answers = iter(typed)
        with patch.object(tool.os, 'geteuid', lambda: 0), patch.object(tool.Path, 'exists', lambda self: True), \
             patch.object(tool.pwd, 'getpwnam', lambda name: type('U', (), {'pw_gid': 1})()), \
             patch.object(tool, 'secure_json', lambda path: {'appId': APP}), \
             patch.object(tool.getpass, 'getpass', lambda prompt: next(answers)), \
             patch.object(tool, 'save_account', lambda *a: saved.append(a)), patch('builtins.print') as shown:
            tool.save_app()
        self.assertNotIn(APP_SECRET, str(shown.call_args_list))
        return saved
    def test_saves_the_secret_once_for_the_same_app_without_showing_it(self):
        saved = self.run_save([APP, APP_SECRET])
        self.assertEqual(saved, [('/etc/index-options-trading-app.json', {'version': 1, 'appId': APP, 'appSecret': APP_SECRET}, 1)])
    def test_refuses_another_app_or_a_bad_secret(self):
        for typed in (['OTHERAPP-200', APP_SECRET], [APP, 'bad secret value'], [APP, 'x']):
            with self.assertRaises(ConnectError): self.run_save(typed)


class WaitingServiceTests(Case):
    """The service no longer crash-loops: it waits, and can only sign in."""
    def call(self, port, action, payload):
        path = '/monitor/orders/'+action; body = json.dumps(payload).encode(); stamp = str(int(time.time())); nonce = uuid.uuid4().hex
        request = urllib.request.Request('http://127.0.0.1:%d%s' % (port, path), body, headers={'content-type': 'application/json',
            'x-iom-time': stamp, 'x-iom-nonce': nonce, 'x-iom-owner': OWNER, 'x-iom-signature': signature(SECRET, stamp, nonce, OWNER, path, body)})
        try:
            with urllib.request.build_opener(urllib.request.ProxyHandler({})).open(request, timeout=5) as response: return response.status, json.load(response)
        except urllib.error.HTTPError as error: return error.code, json.load(error)
    def serve(self):
        value = order_host.server(order_host.WaitingForLogin(self.folder), SECRET, OWNER, 0, login=self.login)
        threading.Thread(target=value.serve_forever, daemon=True).start()
        self.addCleanup(value.server_close); self.addCleanup(value.shutdown)
        return value.server_address[1]
    def test_status_says_it_is_waiting_and_that_nothing_can_be_sent(self):
        code, data = self.call(self.serve(), 'status', {})
        self.assertEqual((code, data['waitingForTradingLogin'], data['realMoneyEnabled'], data['exitsAllowed'], data['mayHoldTrade'], data['mode']),
                         (200, True, False, False, False, 'OWNED_EXECUTION_HOST'))
    def test_every_trading_action_is_refused_while_waiting(self):
        port = self.serve()
        for action, payload in (('stop', {}), ('exit', {'entryId': 'x'}), ('settings', {'settings': {}}), ('submit', {'intentId': 'x'}),
                                ('prepare', {'intentId': 'x', 'strategy': 'CORE'}), ('preview', {'tradeAmount': 1}),
                                ('buy', {'intentId': 'x', 'strategy': 'CORE', 'symbol': 'x', 'quantity': 1, 'maxPrice': 1, 'tradeAmount': 1})):
            code, data = self.call(port, action, payload)
            self.assertEqual((code, data.get('reason'), data['realMoneyEnabled']), (409, 'TRADING_LOGIN_NEEDED', False), action)
    def test_warns_when_a_trade_may_be_held(self):
        import sqlite3
        with sqlite3.connect(self.folder/'orders.sqlite3') as db:
            db.execute('CREATE TABLE live_managed_positions (id TEXT, state TEXT)'); db.execute("INSERT INTO live_managed_positions VALUES ('a','MANAGING')")
        data = self.call(self.serve(), 'status', {})[1]
        self.assertEqual((data['mayHoldTrade'], data['attentionRequired']), (True, 'TRADING_LOGIN_NEEDED_WHILE_HOLDING'))
    def test_a_sent_order_counts_as_possibly_held_but_a_plan_does_not(self):
        import sqlite3
        with sqlite3.connect(self.folder/'orders.sqlite3') as db:
            db.execute('CREATE TABLE live_requests (id TEXT, state TEXT)'); db.execute("INSERT INTO live_requests VALUES ('a','PREPARED')")
        waiting = order_host.WaitingForLogin(self.folder)
        self.assertFalse(waiting.status()['mayHoldTrade'])
        with sqlite3.connect(self.folder/'orders.sqlite3') as db: db.execute("UPDATE live_requests SET state='SUBMIT_REQUESTED'")
        self.assertTrue(waiting.status()['mayHoldTrade'])
    def test_says_if_buying_would_be_on_after_sign_in(self):
        for on in (True, False):
            self.assertIs(order_host.WaitingForLogin(self.folder, on).status()['buyingAfterLogin'], on)
    def test_signing_in_through_the_server_and_a_refusal_reason(self):
        port = self.serve()
        code, data = self.call(port, 'login-start', {}); self.assertEqual(code, 200)
        state = parse_qs(urlsplit(data['loginUrl']).query)['state'][0]
        self.assertEqual(self.call(port, 'login-finish', {'state': 'b'*64, 'code': CODE})[1]['reason'], 'TRADING_LOGIN_NOT_STARTED_HERE')
        code, data = self.call(port, 'login-finish', {'state': state, 'code': CODE})
        self.assertEqual((code, data['connected']), (200, True))
        self.assertNotIn(NEW, json.dumps(data)); self.assertNotIn(APP_SECRET, json.dumps(data))
    def test_waiting_ends_after_a_working_sign_in(self):
        checked = []
        class Fake:
            def __init__(self, app, token): self.token = token
            def get_profile(self):
                checked.append(self.token)
                if self.token != NEW: raise ValueError('BROKER_REQUEST_UNAVAILABLE_RECONCILE')
        result = []
        real = order_host.server
        ports = []
        def on_free_port(runtime, secret, proof, port, login=None):
            value = real(runtime, secret, proof, 0, login=login); ports.append(value.server_address[1]); return value
        with patch.object(order_host, 'FyersRest', Fake), patch.object(order_host, 'DATA', self.folder), patch.object(order_host, 'server', on_free_port):
            thread = threading.Thread(target=lambda: result.append(order_host.wait_for_login(self.login, SECRET, self.base)), daemon=True)
            thread.start()
            for _ in range(50):
                if ports: break
                time.sleep(.05)
            time.sleep(.8); self.assertEqual(result, [])
            self.login.finish(self.state(), CODE); thread.join(8)
        self.assertEqual((result, checked[-1]), ([True], NEW))


if __name__ == '__main__': unittest.main()
