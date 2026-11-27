#!/usr/bin/env python3
"""Separate trading-app login; credentials are entered only in the SSH terminal.

Exchanges one user-supplied authorisation code, checks the pinned owner and saves
separate account files. No orders, cancellation, account changes or service restarts.
"""
import argparse
import getpass
import hashlib
import hmac
import json
import os
from pathlib import Path
import pwd
import re
import secrets
import stat
import sys
import tempfile
import time
from urllib.parse import parse_qs, urlencode, urlsplit
import urllib.error
import urllib.request

BASE = 'https://api-t1.fyers.in/api/v3/'
CALLBACK = 'https://trade.fyers.in/api-login/redirect-uri/index.html'
APP = re.compile(r'[A-Za-z0-9]{4,40}-200')
READS = frozenset({'profile', 'funds', 'orders', 'positions'})


class ConnectError(Exception): pass


class NoRedirect(urllib.request.HTTPRedirectHandler):
    def redirect_request(self, *args, **kwargs): return None


def request(route, *, app=None, token=None, payload=None, opener=None):
    if not (route in READS and payload is None or route == 'validate-authcode' and payload is not None):
        raise ConnectError('This login tool cannot send orders.')
    headers = {'Accept':'application/json', 'User-Agent':'IOM-separate-trading-login/1'}
    if token is not None:
        if not isinstance(app, str) or not APP.fullmatch(app) or not re.fullmatch(r'[A-Za-z0-9_.-]{20,16384}', token):
            raise ConnectError('The trading login has an invalid format.')
        headers['Authorization'] = app + ':' + token
    body = None if payload is None else json.dumps(payload, allow_nan=False).encode()
    if body: headers['Content-Type'] = 'application/json'
    opener = opener or urllib.request.build_opener(urllib.request.ProxyHandler({}), NoRedirect())
    try:
        with opener.open(urllib.request.Request(BASE+route, data=body, headers=headers), timeout=10) as response:
            raw = response.read(2_000_001)
            if len(raw) > 2_000_000: raise ConnectError('FYERS returned too much data.')
            data = json.loads(raw)
    except (OSError, ValueError, urllib.error.URLError):
        raise ConnectError('FYERS did not accept the login/read request. No settings were changed.') from None
    if not isinstance(data, dict) or data.get('s') != 'ok':
        raise ConnectError('FYERS rejected this request. No orders were sent.')
    return data


def callback_code(url, state, started, now=None):
    if (time.time() if now is None else now)-started > 300:
        raise ConnectError('The sign-in link expired. Run the login command again.')
    parts, target = urlsplit(url), urlsplit(CALLBACK)
    query = parse_qs(parts.query, keep_blank_values=True)
    if (parts.scheme, parts.netloc, parts.path) != (target.scheme, target.netloc, target.path) or parts.fragment or parts.username:
        raise ConnectError('Paste the complete FYERS callback address from this sign-in.')
    if len(query.get('state', [])) != 1 or not hmac.compare_digest(query['state'][0], state):
        raise ConnectError('This callback belongs to a different sign-in attempt.')
    codes = query.get('auth_code', [])
    if len(codes) != 1 or not re.fullmatch(r'[A-Za-z0-9_.-]{10,16384}', codes[0]):
        raise ConnectError('The callback does not contain a valid sign-in code.')
    return codes[0]


def secure_json(path):
    path = Path(path)
    if any(p.is_symlink() for p in [path, *path.parents]): raise ConnectError('Unsafe configuration path.')
    fd = os.open(path, os.O_RDONLY | os.O_NOFOLLOW | os.O_NONBLOCK)
    with os.fdopen(fd, 'rb') as handle:
        info = os.fstat(handle.fileno())
        if not stat.S_ISREG(info.st_mode) or info.st_uid not in (0, pwd.getpwnam('mentor').pw_uid) or info.st_mode & 0o027 or info.st_size > 100000:
            raise ConnectError('Unsafe configuration permissions.')
        return json.load(handle)


def proof_for(owner, secret):
    return hmac.new(secret.encode(), ('FYERS_OWNER_V1:'+owner).encode(), hashlib.sha256).hexdigest()


def pinned_proof(data):
    def values(item):
        if isinstance(item, str): yield item
        elif isinstance(item, dict):
            for value in item.values(): yield from values(value)
        elif isinstance(item, list):
            for value in item: yield from values(value)
    found = {v for v in values(data) if re.fullmatch(r'[a-f0-9]{64}', v)}
    if len(found) != 1: raise ConnectError('The existing account owner could not be verified.')
    return found.pop()


def verify_owner(profile, expected, secret):
    data = profile.get('data')
    owner = data.get('fy_id') if isinstance(data, dict) else None
    if not isinstance(owner, str) or not owner or not hmac.compare_digest(proof_for(owner, secret), expected):
        raise ConnectError('This FYERS account does not match your existing AWS account. Nothing was saved.')
    return owner


def save_account(path, record, gid):
    path = Path(path)
    if any(p.is_symlink() for p in [path, *path.parents]): raise ConnectError('Unsafe trading-account path.')
    fd, temp = tempfile.mkstemp(prefix='.iom-trading-account-', dir=path.parent)
    try:
        os.fchmod(fd, 0o640); os.fchown(fd, 0, gid)
        with os.fdopen(fd, 'w') as handle:
            json.dump(record, handle, allow_nan=False); handle.flush(); os.fsync(handle.fileno())
        os.replace(temp, path)
        parent = os.open(path.parent, os.O_RDONLY | os.O_DIRECTORY)
        try: os.fsync(parent)
        finally: os.close(parent)
    finally:
        if os.path.exists(temp): os.unlink(temp)


def connect():
    if os.geteuid() != 0 or not Path('/dev/tty').exists(): raise ConnectError('Run sudo python3 from your SSH terminal.')
    user = pwd.getpwnam('mentor')
    secret = secure_json('/etc/index-options-journal.json').get('secret')
    if not isinstance(secret, str) or len(secret) < 32: raise ConnectError('The existing account verification key is unavailable.')
    expected = pinned_proof(secure_json('/var/lib/index-options-mentor/paper-owner.json'))
    print('Use the NEW Algo Trading App credentials. Your paper app will stay unchanged.')
    app = getpass.getpass('New trading App ID (hidden): ').strip()
    if not APP.fullmatch(app): raise ConnectError('Use the new trading App ID ending -200, not your paper App ID ending -100.')
    app_secret = getpass.getpass('New trading Secret ID (hidden): ').strip()
    if not 8 <= len(app_secret) <= 256 or any(c.isspace() for c in app_secret): raise ConnectError('The Secret ID format is invalid.')
    state, started = secrets.token_hex(32), time.time()
    print('\nOpen this FYERS sign-in link in Chrome:\n'+BASE+'generate-authcode?'+urlencode({
        'client_id':app, 'redirect_uri':CALLBACK, 'response_type':'code', 'state':state}))
    print('\nAfter login, copy the FULL address of the FYERS callback page. Paste it at the hidden prompt below. Do not paste it in chat.')
    code = callback_code(getpass.getpass('Complete callback address (hidden): ').strip(), state, started)
    result = request('validate-authcode', payload={'grant_type':'authorization_code',
        'appIdHash':hashlib.sha256((app+':'+app_secret).encode()).hexdigest(), 'code':code})
    token = result.get('access_token')
    if not isinstance(token, str) or not re.fullmatch(r'[A-Za-z0-9_.-]{20,16384}', token): raise ConnectError('FYERS did not return a valid access token.')
    verify_owner(request('profile', app=app, token=token), expected, secret)
    for route in ('funds', 'orders', 'positions'): request(route, app=app, token=token)
    # Persist after all reads pass; the app secret/auth code need not be stored.
    record = {'version':1, 'appId':app, 'accessToken':token, 'ownerProof':expected,
              'verifiedAt':time.time(), 'realMoneyEnabled':False, 'callback':CALLBACK}
    save_account('/etc/index-options-live-account.json', record, user.pw_gid)
    print(json.dumps({'ok':True, 'separateTradingAppConnected':True, 'accountMatchesAws':True,
                      'readOnlyBrokerAccessPassed':True, 'realMoneyEnabled':False, 'ordersSent':0,
                      'paperCredentialsChanged':False, 'brokerStopsVerified':False}))
    print('Trading-app login saved separately. Real-money orders remain OFF.')


def save_app():
    """Saves the trading App ID and Secret ID once, so the app button can be used."""
    if os.geteuid() != 0 or not Path('/dev/tty').exists(): raise ConnectError('Run sudo python3 from your SSH terminal.')
    user = pwd.getpwnam('mentor')
    account = secure_json('/etc/index-options-live-account.json')
    app = getpass.getpass('Trading App ID (hidden): ').strip()
    if app != account.get('appId'): raise ConnectError('This is not the trading App ID already saved on this server. Nothing was saved.')
    app_secret = getpass.getpass('Trading Secret ID (hidden): ').strip()
    if not 8 <= len(app_secret) <= 256 or any(c.isspace() for c in app_secret): raise ConnectError('The Secret ID format is invalid.')
    save_account('/etc/index-options-trading-app.json', {'version':1, 'appId':app, 'appSecret':app_secret}, user.pw_gid)
    print('Saved on this server only. It is checked the first time you use Connect trading account. No orders were sent.')


if __name__ == '__main__':
    try: save_app() if sys.argv[1:] == ['save-app'] else connect()
    except ConnectError as error:
        print('STOP: '+str(error), file=sys.stderr); sys.exit(1)
    except (OSError, ValueError):
        print('STOP: Trading login could not be completed. No orders were sent; paper credentials were not changed.', file=sys.stderr)
        sys.exit(1)
