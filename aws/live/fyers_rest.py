"""Fixed FYERS REST transport. No SDK installation, redirects, retries or token logs.

The caller must separately authorise broker writes; construction is read-only.
"""
import json
import re
import threading
import time
import urllib.error
import urllib.parse
import urllib.request
from account_connect import APP, NoRedirect

API='https://api-t1.fyers.in/api/v3'
DATA='https://api-t1.fyers.in/data'


class FyersRest:
    def __init__(self, app, token, *, send_enabled=False, opener=None):
        if not APP.fullmatch(app) or not re.fullmatch(r'[A-Za-z0-9_.-]{20,16384}',token):raise ValueError('INVALID_TRADING_CREDENTIALS')
        self._auth=app+':'+token;self.send_enabled=send_enabled is True
        self._opener=opener or urllib.request.build_opener(urllib.request.ProxyHandler({}),NoRedirect())
        self._lock=threading.RLock();self._cache={};self._last_write=0
    def _request(self, method, path, data=None, params=None):
        reads={'/profile','/funds','/orders','/positions'}
        market={'/history','/quotes','/options-chain-v3','/marketStatus'}
        if method=='GET':
            if path not in reads|market:raise ValueError('BROKER_ROUTE_NOT_ALLOWED')
        elif method not in ('POST','PATCH','DELETE') or path!='/orders/sync' or self.send_enabled is not True:
            raise ValueError('FYERS_SEND_DISABLED')
        root=DATA if path in market else API
        url=root+path+('?' + urllib.parse.urlencode(params) if params else '')
        raw=None if data is None else json.dumps(data,allow_nan=False).encode()
        request=urllib.request.Request(url,raw,method=method,headers={'Authorization':self._auth,'Accept':'application/json','Content-Type':'application/json','version':'3','User-Agent':'IOM-owned-execution/1'})
        try:
            with self._opener.open(request,timeout=8) as response:
                raw=response.read(2_000_001)
                if len(raw)>2_000_000:raise ValueError('BROKER_RESPONSE_TOO_LARGE')
                value=json.loads(raw)
        except (OSError,ValueError,urllib.error.URLError):raise ValueError('BROKER_REQUEST_UNAVAILABLE_RECONCILE') from None
        if not isinstance(value,dict) or value.get('s')!='ok':raise ValueError('BROKER_REQUEST_REJECTED_RECONCILE')
        # Some official sync responses use id_fyers. Never accept conflicting IDs.
        if method!='GET':
            if value.get('id') and value.get('id_fyers') and value['id']!=value['id_fyers']:raise ValueError('AMBIGUOUS_BROKER_ID')
            if not value.get('id') and isinstance(value.get('id_fyers'),str):value={**value,'id':value['id_fyers']}
        return value
    def _read(self,path,ttl=0):
        with self._lock:
            prior=self._cache.get(path)
            if prior and time.monotonic()-prior[0]<ttl:return prior[1]
            value=self._request('GET',path);self._cache[path]=(time.monotonic(),value);return value
    def get_profile(self):return self._read('/profile',15)
    def funds(self):return self._read('/funds',0)
    def orderbook(self):return self._read('/orders',.5)
    def positions(self):return self._read('/positions',.5)
    def market_status(self):return self._read('/marketStatus',5)
    def market(self,path,params):return self._request('GET',path,params=params)
    def _write(self,method,data):
        with self._lock:
            if self.send_enabled is not True:raise ValueError('FYERS_SEND_DISABLED')
            # Limit writes to four per second across entries, stops and exits.
            delay=.25-(time.monotonic()-self._last_write)
            if delay>0:time.sleep(delay)
            self._last_write=time.monotonic();self._cache.clear()
            return self._request(method,'/orders/sync',data)
    def place_order(self,*,data):return self._write('POST',data)
    def cancel_order(self,*,data):return self._write('DELETE',data)
    def modify_order(self,*,data):return self._write('PATCH',data)
