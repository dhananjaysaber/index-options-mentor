import hashlib
import hmac
import importlib.util
import io
import json
import os
from pathlib import Path
import tempfile
import unittest
from unittest.mock import patch
import urllib.error

ROOT = Path(__file__).resolve().parents[1]
spec = importlib.util.spec_from_file_location('readiness', ROOT/'aws/readiness/fyers_readiness.py')
r = importlib.util.module_from_spec(spec)
spec.loader.exec_module(r)
SECRET = 'test-only-bridge-secret-' + 'x'*32
OWNER = 'TEST-ACCOUNT'
PIN = hmac.new(SECRET.encode(), ('FYERS_OWNER_V1:'+OWNER).encode(), hashlib.sha256).hexdigest()
TOKEN = 'test-only-access-token-' + 'z'*24


class FakeOpener:
    def __init__(self, data):
        self.data = data
        self.requests = []

    def open(self, request, timeout):
        self.requests.append(request)
        if isinstance(self.data, Exception):
            raise self.data
        return io.BytesIO(json.dumps(self.data).encode())


class FakeBroker:
    def __init__(self, owner=OWNER):
        self.owner = owner
        self.calls = []

    def get(self, route):
        self.calls.append(route)
        return {
            'profile': {'data': {'fy_id': self.owner, 'name': 'PRIVATE NAME'}},
            'funds': {'fund_limit': [{'id': 10, 'equityAmount': 90000}]},
            'orders': {'orderBook': [{'id': 'private-order-id'}]},
            'positions': {'netPositions': [{'symbol': 'private-symbol', 'netQty': 65}]},
        }[route]


class ReadinessTests(unittest.TestCase):
    def test_fixed_https_get_without_body(self):
        opener = FakeOpener({'s': 'ok'})
        client = r.ReadOnlyClient('TESTAPP-100', TOKEN, opener)
        for route in sorted(r.READ_ROUTES):
            client.get(route)
        for request in opener.requests:
            self.assertEqual(request.get_method(), 'GET')
            self.assertIsNone(request.data)
            self.assertTrue(request.full_url.startswith(r.HOST+'/'))
            self.assertEqual(request.get_header('Authorization'), 'TESTAPP-100:'+TOKEN)

    def test_mutations_and_route_injection_never_reach_network(self):
        opener = FakeOpener({'s': 'ok'})
        client = r.ReadOnlyClient('TESTAPP-100', TOKEN, opener)
        for route in ('orders/sync', 'logout', '../orders', 'orders?x=1', 'https://other.invalid/profile'):
            with self.assertRaisesRegex(r.CheckFailed, 'READ_ONLY_ROUTE_REQUIRED'):
                client.get(route)
        for method in ('place_order', 'cancel_order', 'modify_order', 'exit_positions'):
            with self.assertRaisesRegex(r.CheckFailed, 'REAL_ORDERS_DISABLED'):
                getattr(client, method)({'id': 'existing-position'})
        self.assertEqual(opener.requests, [])

    def test_default_opener_has_no_proxy_and_rejects_redirects(self):
        client = r.ReadOnlyClient('TESTAPP-100', TOKEN)
        proxies = [h for h in client._opener.handlers if isinstance(h, r.urllib.request.ProxyHandler)]
        self.assertTrue(all(not h.proxies for h in proxies))
        redirect = next(h for h in client._opener.handlers if isinstance(h, r.NoRedirect))
        self.assertIsNone(redirect.redirect_request(None, None, None, None, None, None))

    def test_wrong_owner_stops_before_funds_and_positions(self):
        broker = FakeBroker('OTHER-ACCOUNT')
        with self.assertRaisesRegex(r.CheckFailed, 'DOES_NOT_MATCH_PINNED_OWNER'):
            r.inspect_broker(broker, SECRET, PIN)
        self.assertEqual(broker.calls, ['profile'])

    def test_read_summary_preserves_privacy(self):
        broker = FakeBroker()
        result = r.inspect_broker(broker, SECRET, PIN)
        self.assertTrue(result['readOnlyBrokerAccessPassed'])
        self.assertEqual(result['brokerReads']['positions']['openPositionCount'], 1)
        summary = json.dumps(result)
        for private in (OWNER, 'PRIVATE NAME', '90000', 'private-order-id', 'private-symbol', TOKEN, SECRET):
            self.assertNotIn(private, summary)
        self.assertEqual(broker.calls, ['profile', 'funds', 'orders', 'positions'])

    def test_invalid_funds_do_not_pass_and_other_reads_still_run(self):
        broker = FakeBroker()
        original = broker.get
        def get(route):
            if route == 'funds':
                return {'fund_limit': [{'id': 10, 'equityAmount': True}]}
            return original(route)
        broker.get = get
        result = r.inspect_broker(broker, SECRET, PIN)
        self.assertFalse(result['readOnlyBrokerAccessPassed'])
        self.assertTrue(result['brokerReads']['positions']['passed'])

    def test_expired_and_private_error_payload_are_redacted(self):
        for payload, expected in [
            ({'s': 'error', 'code': -16, 'message': TOKEN}, 'FYERS_LOGIN_INVALID_OR_UNAUTHENTICATED'),
            ({'s': 'error', 'message': TOKEN}, 'FYERS_READ_REJECTED'),
        ]:
            with self.assertRaisesRegex(r.CheckFailed, expected) as error:
                r.ReadOnlyClient('TESTAPP-100', TOKEN, FakeOpener(payload)).get('profile')
            self.assertNotIn(TOKEN, str(error.exception))
        error = urllib.error.HTTPError('https://private.invalid/'+TOKEN, 401, TOKEN, {}, io.BytesIO())
        with self.assertRaisesRegex(r.CheckFailed, 'FYERS_HTTP_401') as caught:
            r.ReadOnlyClient('TESTAPP-100', TOKEN, FakeOpener(error)).get('profile')
        self.assertNotIn(TOKEN, str(caught.exception))

    def test_http_400_auth_code_is_read_without_exposing_payload(self):
        for code, reason in [(-8, 'FYERS_LOGIN_EXPIRED'),
                             (-16, 'FYERS_LOGIN_INVALID_OR_UNAUTHENTICATED'),
                             (-50, 'FYERS_HTTP_400')]:
            payload = json.dumps({'s': 'error', 'code': code, 'message': TOKEN}).encode()
            error = urllib.error.HTTPError(r.HOST+'/profile', 400, 'Bad request', {}, io.BytesIO(payload))
            with self.assertRaisesRegex(r.CheckFailed, reason) as caught:
                r.ReadOnlyClient('TESTAPP-100', TOKEN, FakeOpener(error)).get('profile')
            self.assertEqual(caught.exception.broker_code, code)
            self.assertEqual(caught.exception.http_status, 400)
            self.assertNotIn(TOKEN, str(caught.exception))

    def test_login_hints_do_not_trust_expiry_or_expose_token(self):
        import base64
        middle = base64.urlsafe_b64encode(json.dumps({'exp': 1, 'private': TOKEN}).encode()).decode().rstrip('=')
        with tempfile.TemporaryDirectory() as directory:
            app = Path(directory)
            (app/'fyersAuthRoutes.mjs').write_text("if (url.pathname === '/auth/fyers/login') {}; const secret='"+SECRET+"';")
            result = r.local_login_hints('header.'+middle+'.signature', app)
            self.assertTrue(result['storedTokenExpiryTimePassed'])
            self.assertEqual(result['internalAwsLoginRoute'], '/auth/fyers/login')
            self.assertFalse(result['publicAwsLoginUrlVerified'])
            self.assertNotIn('configuredAwsLoginUrl', result)
            self.assertNotIn(TOKEN, json.dumps(result))
            self.assertNotIn(SECRET, json.dumps(result))
            (app/'fyersAuthRoutes.mjs').write_text("['/fyers/login','/fyers/auth','/fyers/callback']")
            self.assertNotIn('internalAwsLoginRoute', r.local_login_hints('invalid', app))

    def test_ambiguous_token_and_app_mismatch_fail_closed(self):
        for stored in ({'token': TOKEN, 'data': {'access_token': 'other-token'}}, {'refresh_token': TOKEN}):
            with self.assertRaisesRegex(r.CheckFailed, 'MISSING_OR_AMBIGUOUS'):
                r.extract_token(stored)
        self.assertEqual(r.extract_token({'data': {'access_token': TOKEN}}), TOKEN)
        with self.assertRaisesRegex(r.CheckFailed, 'APP_MISMATCH'):
            r.ReadOnlyClient('TESTAPP-100', 'OTHERAPP-100:'+TOKEN)
        with self.assertRaisesRegex(r.CheckFailed, 'FORMAT_UNRECOGNISED'):
            r.ReadOnlyClient('TESTAPP-100', TOKEN+'\nInjected: bad')

    def test_secure_json_rejects_public_files_and_links_without_changes(self):
        with tempfile.TemporaryDirectory() as directory:
            file = Path(directory)/'token.json'
            file.write_text(json.dumps({'access_token': TOKEN}))
            file.chmod(0o600)
            original = file.read_bytes()
            self.assertEqual(r.secure_json(file, os.getuid())['access_token'], TOKEN)
            file.chmod(0o644)
            with self.assertRaisesRegex(r.CheckFailed, 'UNSAFE_CONFIGURATION_PERMISSIONS'):
                r.secure_json(file, os.getuid())
            link = Path(directory)/'link.json'
            link.symlink_to(file)
            with self.assertRaisesRegex(r.CheckFailed, 'UNSAFE_CONFIGURATION_PATH'):
                r.secure_json(link, os.getuid())
            self.assertEqual(file.read_bytes(), original)

    def test_main_reports_read_access_without_asserting_trade_readiness(self):
        states = {name: {'active': True, 'pid': 123} for name in r.SERVICES}
        def config(path, uid):
            path = str(path)
            if path.endswith('fyers-token.json'): return {'accessToken': TOKEN}
            if path.endswith('paper-owner.json'): return {'owner': PIN}
            return {'secret': SECRET}
        output = io.StringIO()
        with patch.object(r.os, 'geteuid', return_value=0), \
             patch.object(r.pwd, 'getpwnam'), \
             patch.object(r, 'service_state', return_value=states), \
             patch.object(r, 'service_app_id', return_value='TESTAPP-100'), \
             patch.object(r, 'secure_json', side_effect=config), \
             patch.object(r, 'ReadOnlyClient', return_value=FakeBroker()), \
             patch('sys.stdout', output):
            self.assertEqual(r.main(), 0)
        result = json.loads(output.getvalue())
        self.assertTrue(result['readOnlyBrokerAccessPassed'])
        self.assertTrue(result['existingServicesUnchanged'])
        self.assertFalse(result['realMoneyEnabled'])
        self.assertFalse(result['tradingPermissionsVerified'])
        self.assertFalse(result['webSocketExitVerified'])
        self.assertFalse(result['brokerStopsVerified'])
        self.assertEqual(result['ordersSent'], 0)
        for private in (TOKEN, SECRET, OWNER, PIN):
            self.assertNotIn(private, output.getvalue())

    def test_generated_public_script_matches_source(self):
        self.assertEqual((ROOT/'public/iom-fyers-readiness.py').read_bytes(),
                         (ROOT/'aws/readiness/fyers_readiness.py').read_bytes())


if __name__ == '__main__':
    unittest.main()
