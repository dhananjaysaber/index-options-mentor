"""Daily trading-account sign-in that the app can complete.

Owner decision 27 Nov 2026: a "Connect trading account" button, available only
after the app sign-in. The trading app's Secret ID is saved once on this server
and never reaches the website or the browser. The website only passes on the
one-time code FYERS returns. Nothing here can send, change or cancel an order.
"""
import hashlib
import hmac
import json
import os
from pathlib import Path
import re
import secrets
import tempfile
import threading
import time
from urllib.parse import urlencode
from account_connect import APP, BASE, ConnectError, request as fyers_request, verify_owner

# Must match the redirect address saved for the FYERS trading app.
APP_CALLBACK = 'https://optionsmentor.netlify.app/trading-login'
VALID_SECONDS = 300
TOKEN = re.compile(r'[A-Za-z0-9_.-]{20,16384}')
CODE = re.compile(r'[A-Za-z0-9_.-]{10,6000}')
IST_OFFSET = 19800


def write_private(path, record):
    """Replace the file in one step, readable by this service only."""
    path = Path(path)
    if path.is_symlink(): raise ValueError('TRADING_LOGIN_NOT_SAVED')
    fd, temp = tempfile.mkstemp(prefix='.iom-login-', dir=path.parent)
    try:
        os.fchmod(fd, 0o600)
        with os.fdopen(fd, 'w') as handle:
            json.dump(record, handle, allow_nan=False); handle.flush(); os.fsync(handle.fileno())
        os.replace(temp, path)
    finally:
        if os.path.exists(temp): os.unlink(temp)


def read_private(path):
    path = Path(path)
    if path.is_symlink(): return None
    try: value = json.loads(path.read_text())
    except (OSError, ValueError): return None
    return value if isinstance(value, dict) else None


def effective_account(base, path):
    """The newest sign-in: the app's own, if it belongs to the same app and owner."""
    saved = read_private(path)
    if (saved and saved.get('appId') == base.get('appId') and saved.get('ownerProof') == base.get('ownerProof')
            and isinstance(saved.get('accessToken'), str) and TOKEN.fullmatch(saved['accessToken'])
            and isinstance(saved.get('verifiedAt'), (int, float))
            and saved['verifiedAt'] > float(base.get('verifiedAt') or 0)):
        return {**base, 'accessToken': saved['accessToken'], 'verifiedAt': saved['verifiedAt']}
    return base


class TradingLogin:
    def __init__(self, base, secret, folder, load_app, *, requester=fyers_request, clock=time.time):
        self.base, self.secret, self.load_app = base, secret, load_app
        self.token_file = Path(folder)/'trading-login.json'
        self.pending_file = Path(folder)/'trading-login-pending.json'
        self.requester, self.clock = requester, clock
        self.lock = threading.Lock()

    def account(self):
        return effective_account(self.base, self.token_file)

    def _app(self):
        try: app = self.load_app()
        except Exception: app = None
        if (not isinstance(app, dict) or app.get('appId') != self.base['appId'] or not APP.fullmatch(app['appId'])
                or not isinstance(app.get('appSecret'), str) or not 8 <= len(app['appSecret']) <= 256):
            raise ValueError('TRADING_APP_NOT_SAVED_ON_SERVER')
        return app

    def summary(self):
        try: self._app(); ready = True
        except ValueError: ready = False
        verified = float(self.account().get('verifiedAt') or 0)
        day = lambda t: int(t + IST_OFFSET) // 86400
        return {'ready': ready, 'signedInToday': day(verified) == day(self.clock())}

    def start(self):
        app = self._app()
        with self.lock:
            state = secrets.token_hex(32)
            write_private(self.pending_file, {'stateHash': hashlib.sha256(state.encode()).hexdigest(), 'at': self.clock()})
        return {'loginUrl': BASE+'generate-authcode?'+urlencode({
            'client_id': app['appId'], 'redirect_uri': APP_CALLBACK, 'response_type': 'code', 'state': state})}

    def finish(self, state, code):
        if not isinstance(state, str) or not isinstance(code, str) or not re.fullmatch(r'[a-f0-9]{64}', state) or not CODE.fullmatch(code):
            raise ValueError('TRADING_LOGIN_INVALID')
        app = self._app()
        with self.lock:
            pending = read_private(self.pending_file)
            if not pending or not hmac.compare_digest(str(pending.get('stateHash')), hashlib.sha256(state.encode()).hexdigest()):
                raise ValueError('TRADING_LOGIN_NOT_STARTED_HERE')
            # One use only, whatever happens next.
            self.pending_file.unlink()
            if not 0 <= self.clock()-float(pending.get('at', 0)) <= VALID_SECONDS:
                raise ValueError('TRADING_LOGIN_EXPIRED')
            try:
                result = self.requester('validate-authcode', payload={'grant_type': 'authorization_code',
                    'appIdHash': hashlib.sha256((app['appId']+':'+app['appSecret']).encode()).hexdigest(), 'code': code})
                token = result.get('access_token')
                if not isinstance(token, str) or not TOKEN.fullmatch(token): raise ConnectError('NO_TOKEN')
                profile = self.requester('profile', app=app['appId'], token=token)
            except ConnectError: raise ValueError('FYERS_DID_NOT_ACCEPT_SIGN_IN') from None
            try: verify_owner(profile, self.base['ownerProof'], self.secret)
            except ConnectError: raise ValueError('TRADING_LOGIN_WRONG_ACCOUNT') from None
            try:
                for route in ('funds', 'orders', 'positions'): self.requester(route, app=app['appId'], token=token)
            except ConnectError: raise ValueError('FYERS_DID_NOT_ACCEPT_SIGN_IN') from None
            write_private(self.token_file, {'version': 1, 'appId': app['appId'], 'accessToken': token,
                                            'ownerProof': self.base['ownerProof'], 'verifiedAt': self.clock()})
        return {'connected': True}
