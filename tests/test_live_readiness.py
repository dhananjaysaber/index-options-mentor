import hashlib
import hmac
import importlib.util
import io
import json
from pathlib import Path
import unittest

spec = importlib.util.spec_from_file_location('live_readiness', Path(__file__).resolve().parents[1] / 'public/iom-live-readiness.py')
check = importlib.util.module_from_spec(spec)
spec.loader.exec_module(check)

class LiveReadinessTest(unittest.TestCase):
    def test_only_fixed_status_routes_can_be_signed(self):
        secret, owner = 's' * 40, 'a' * 64
        calls = []
        class Opener:
            def open(self, request, timeout):
                calls.append(request)
                path = '/monitor/orders/status'
                headers = {k.lower(): v for k, v in request.header_items()}
                message = '\n'.join(['v1', headers['x-iom-time'], headers['x-iom-nonce'], owner, 'POST', path, hashlib.sha256(b'{}').hexdigest()])
                self_case.assertEqual(headers['x-iom-signature'], hmac.new(secret.encode(), message.encode(), hashlib.sha256).hexdigest())
                self_case.assertEqual(request.data, b'{}')
                return io.BytesIO(b'{"ok":true,"mode":"OWNED_EXECUTION_HOST","realMoneyEnabled":false}')
        self_case = self
        result = check.status_request(check.LOCAL, '/monitor/orders/status', secret, owner, Opener())
        self.assertFalse(result['realMoneyEnabled'])
        for route in ['/monitor/orders/submit', '/monitor/orders/exit', '/monitor/orders/settings']:
            with self.assertRaisesRegex(ValueError, 'STATUS_ROUTE_ONLY'):
                check.status_request(check.LOCAL, route, secret, owner, Opener())
        self.assertEqual(len(calls), 1)

    def test_unrecognised_host_cannot_receive_signature(self):
        with self.assertRaisesRegex(ValueError, 'STATUS_ROUTE_ONLY'):
            check.status_request('https://untrusted.invalid', '/monitor/orders/status', 's'*40, 'a'*64)

    def test_status_output_has_no_position_ids_or_account_material(self):
        result = check.safe_status({'positions': [{'id': 'private-position', 'symbol': 'contract'}], 'settings': {'tradeAmount': 30000}, 'accessToken': 'private-token', 'ownerProof': 'private-owner'})
        self.assertEqual(result['activeOwnedPositions'], 1)
        self.assertEqual(result['amountPerTrade'], 30000)
        self.assertNotIn('private-', json.dumps(result))
        self.assertFalse(result['realMoneyEnabled'])

    def test_bad_status_response_cannot_pass_connection(self):
        class Opener:
            def open(self, *args, **kwargs):
                return io.BytesIO(b'{"ok":true,"mode":"SIMULATION_ONLY"}')
        with self.assertRaisesRegex(ValueError, 'ORDER_HOST_NOT_VERIFIED'):
            check.status_request(check.LOCAL, '/monitor/orders/status', 's'*40, 'a'*64, Opener())
