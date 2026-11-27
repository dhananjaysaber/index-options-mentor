"""Authenticated loopback order host and continuous shared-feed management.

Installation creates a disabled configuration. No order starts at import/boot.
"""
import contextlib
from datetime import datetime,timezone
import hashlib
import hmac
import json
import os
from pathlib import Path
import re
import signal
import sqlite3
import threading
import time
import uuid
from http.server import BaseHTTPRequestHandler,ThreadingHTTPServer
import urllib.request
from account_connect import secure_json,verify_owner,NoRedirect
from trading_login import TradingLogin
from bridge import signature
from orders import Orders,encoded
from planner import EntryPlanner
from execution import Execution
from manager import Manager
from feed import Feed
from market import Market
from runtime import Runtime
from fyers_rest import FyersRest
from fyers_broker import FyersBroker

CONFIG=Path('/etc/index-options-order-host.json')
ACCOUNT=Path('/etc/index-options-live-account.json')
TRADING_APP=Path('/etc/index-options-trading-app.json')
# How often a waiting service tries the saved sign-in again.
LOGIN_RETRY_SECONDS=60
DATA=Path('/var/lib/index-options-mentor/order-host')

class StartupError(Exception):
    def __init__(self,stage,error):
        reason=str(error)
        self.stage=stage
        self.reason=reason if re.fullmatch(r'[A-Z_]{3,100}',reason) else type(error).__name__

def startup(stage,task):
    try:return task()
    except Exception as error:raise StartupError(stage,error) from None

class JournalBridge:
    def __init__(self,secret):self.secret=secret
    def request(self,payload):
        path='/journal/bridge';body=encoded(payload).encode();stamp=str(int(time.time()*1000));nonce=uuid.uuid4().hex
        sig=hmac.new(self.secret.encode(),'\n'.join([stamp,nonce,'POST',path,hashlib.sha256(body).hexdigest()]).encode(),hashlib.sha256).hexdigest()
        req=urllib.request.Request('http://127.0.0.1:9076'+path,body,headers={'content-type':'application/json','x-iom-time':stamp,'x-iom-nonce':nonce,'x-iom-signature':sig})
        opener=urllib.request.build_opener(urllib.request.ProxyHandler({}),NoRedirect())
        with opener.open(req,timeout=8) as response:
            result=json.loads(response.read(100001))
        if result.get('ok') is not True:raise ValueError('JOURNAL_NOT_ACKNOWLEDGED')
        return result
    def event(self,event):return self.request({'action':'journal_event','event':event})
    def health(self):return self.request({'action':'health'})


class WaitingForLogin:
    """Stands in while the saved trading sign-in does not work. It can only sign in."""
    def __init__(self,folder,buying_after_login=False):
        self.buying_after_login=buying_after_login is True
        self.file=Path(folder)/'waiting.sqlite3'
        ledger=Path(folder)/'orders.sqlite3'
        self.ledger=ledger if ledger.exists() else None
    @contextlib.contextmanager
    def transaction(self):
        db=sqlite3.connect(self.file,timeout=5)
        try:
            with db:yield db
        finally:db.close()
    @property
    def orders(self):return self
    def _enabled(self):return False
    def _may_hold_a_trade(self):
        if not self.ledger:return False
        db=sqlite3.connect('file:'+str(self.ledger)+'?mode=ro',uri=True,timeout=5)
        try:
            tables={row[0] for row in db.execute("SELECT name FROM sqlite_master WHERE type='table'")}
            # An order that was sent but not yet seen as bought counts too.
            checks=(('live_managed_positions',"state!='CLOSED'"),('live_requests',"state NOT IN ('PREPARED','CLOSED','NO_FILL','EXPIRED')"))
            return any(table in tables and db.execute('SELECT 1 FROM '+table+' WHERE '+rule).fetchone() for table,rule in checks)
        except sqlite3.Error:return True
        finally:db.close()
    def status(self):
        held=self._may_hold_a_trade()
        return {'ok':True,'mode':'OWNED_EXECUTION_HOST','actualLiveExecutionHostReleased':True,'realMoneyEnabled':False,
            'exitsAllowed':False,'settings':{},'positions':[],'needsChecking':[],'partSales':[],
            'waitingForTradingLogin':True,'mayHoldTrade':bool(held),'buyingAfterLogin':self.buying_after_login,
            'attentionRequired':'TRADING_LOGIN_NEEDED_WHILE_HOLDING' if held else None,'actualBrokerAcceptanceVerified':False}


def server(runtime,secret,owner_proof,port=0,login=None):
    with runtime.orders.transaction() as db:db.execute('CREATE TABLE IF NOT EXISTS live_host_nonces(id TEXT PRIMARY KEY,expires REAL NOT NULL)')
    actions={'status':set(),'settings':{'settings'},'preview':{'tradeAmount'},'buy':{'intentId','strategy','symbol','quantity','maxPrice','tradeAmount'},'prepare':{'intentId','strategy'},'submit':{'intentId'},'exit':{'entryId'},'stop':set(),'login-start':set(),'login-finish':{'state','code'}}
    waiting=isinstance(runtime,WaitingForLogin)
    class Handler(BaseHTTPRequestHandler):
        def log_message(self,*args):pass
        def reply(self,status,value):
            body=encoded(value).encode();self.send_response(status);self.send_header('Content-Type','application/json');self.send_header('Cache-Control','no-store');self.send_header('Content-Length',str(len(body)));self.end_headers();self.wfile.write(body)
        def do_POST(self):
            try:
                action=self.path.removeprefix('/monitor/orders/')
                if self.path!='/monitor/orders/'+action or action not in actions:return self.reply(404,{'error':'NOT_FOUND'})
                length=self.headers.get('Content-Length','')
                if not length.isdigit() or not 0<int(length)<=8192:return self.reply(413,{'error':'BODY_SIZE'})
                self.connection.settimeout(5);body=self.rfile.read(int(length))
                stamp=self.headers.get('x-iom-time','');nonce=self.headers.get('x-iom-nonce','');owner=self.headers.get('x-iom-owner','');supplied=self.headers.get('x-iom-signature','')
                if (len(body)!=int(length) or not re.fullmatch(r'\d{10}',stamp) or abs(time.time()-int(stamp))>30 or not re.fullmatch(r'[a-f0-9]{32}',nonce) or owner!=owner_proof or not hmac.compare_digest(supplied,signature(secret,stamp,nonce,owner,self.path,body))):return self.reply(403,{'error':'ACCOUNT_NOT_AUTHENTICATED'})
                with runtime.orders.transaction() as db:
                    db.execute('DELETE FROM live_host_nonces WHERE expires<?',(time.time(),))
                    try:db.execute('INSERT INTO live_host_nonces VALUES (?,?)',(nonce,time.time()+60))
                    except sqlite3.IntegrityError:return self.reply(409,{'error':'REPLAYED_REQUEST'})
                payload=json.loads(body)
                if not isinstance(payload,dict) or set(payload)!=actions[action]:raise ValueError('INVALID_FIELDS')
                if action in ('login-start','login-finish'):
                    if login is None:raise ValueError('TRADING_APP_NOT_SAVED_ON_SERVER')
                    result=login.start() if action=='login-start' else login.finish(payload['state'],payload['code'])
                elif action=='status':result={**runtime.status(),**({'tradingLogin':login.summary()} if login else {})}
                elif waiting:raise ValueError('TRADING_LOGIN_NEEDED')
                elif action=='settings':result={'settings':runtime.set_settings(payload['settings'])}
                elif action=='preview':result={'preview':runtime.preview(payload['tradeAmount'])}
                elif action=='buy':result={'order':runtime.buy(payload['intentId'],payload['strategy'],payload['symbol'],payload['quantity'],payload['maxPrice'],payload['tradeAmount'])}
                elif action=='prepare':result={'plan':runtime.prepare(payload['intentId'],payload['strategy'])}
                elif action=='submit':result={'order':runtime.submit(payload['intentId'])}
                elif action=='exit':result={'order':runtime.request_exit(payload['entryId'])}
                else:
                    runtime.orders.stop();result={'newEntries':'STOPPED'}
                self.reply(200,{'ok':True,**result,'realMoneyEnabled':runtime._enabled(),'mode':'OWNED_EXECUTION_HOST'})
            except (ValueError,TypeError,KeyError,AttributeError) as error:
                # Only a fixed reason code may leave; never free text.
                reason=str(error) if isinstance(error,ValueError) and re.fullmatch(r'[A-Z_]{3,60}',str(error)) else None
                self.reply(409,{'error':'ORDER_ACTION_REJECTED_CHECK_STATUS',**({'reason':reason} if reason else {}),'realMoneyEnabled':runtime._enabled()})
            except Exception:self.reply(503,{'error':'ORDER_SERVICE_UNAVAILABLE_RECONCILE','realMoneyEnabled':runtime._enabled()})
    value=ThreadingHTTPServer(('127.0.0.1',port),Handler);value.daemon_threads=True;return value


def refresh_pause(took):
    # Aim to start a new reading every 5 seconds; each is valid for 12.
    return max(1,5-took)


def build(config,account,secret):
    if config.get('version')!=1 or type(config.get('realMoneyEnabled')) is not bool:raise ValueError('INVALID_HOST_CONFIG')
    enabled=config['realMoneyEnabled']
    # Activation is a separate operator action, never an installer/env/browser toggle.
    approved=config.get('operatorApprovedAppId')==account['appId']
    if enabled and not approved:raise ValueError('SEPARATE_OPERATOR_APPROVAL_REQUIRED')
    # Owner decision 27 Nov 2026: realMoneyEnabled false blocks new buys but keeps
    # stops and sales working for held trades. That needs the operator approval to
    # remain in the file; without it (as installed) nothing at all can be sent.
    client=FyersRest(account['appId'],account['accessToken'],send_enabled=approved)
    profile=startup('TRADING_ACCOUNT_READ',client.get_profile)
    owner=startup('TRADING_ACCOUNT_OWNER',lambda:verify_owner(profile,account['ownerProof'],secret))
    broker=FyersBroker(client,send_enabled=approved,entries_enabled=enabled);feed=Feed('/var/lib/index-options-mentor/live-feed')
    market=Market(client,lambda:runtime.settings())
    # A real contract master is required even when the host is disabled.
    startup('CONTRACT_MASTER',market.refresh_master)
    maximum=max(int(row.get('qtyFreeze',0)) for row in market.master.values() if str(row.get('qtyFreeze','')).isdigit())
    orders=Orders(DATA/'orders.sqlite3',broker,owner,max_quantity=maximum,enabled=enabled)
    orders.exits_enabled=approved
    planner=EntryPlanner(market.contract,feed.quote,market.session_open,max_amount=config['maxTradeAmount'],fee_reserve=config['feeReserve'])
    execution=Execution(orders,planner);journal=JournalBridge(secret)
    runtime=Runtime(execution,Manager(execution,journal),feed,market,max_amount=config['maxTradeAmount'])
    startup('JOURNAL_CONNECTION',journal.health) # No fake event is written.
    return runtime


def backup():
    source=DATA/'orders.sqlite3';root=DATA/'backups';root.mkdir(mode=0o700,exist_ok=True)
    file=root/('orders-'+datetime.now(timezone.utc).strftime('%Y-%m-%d')+'.sqlite3')
    temp=file.with_suffix('.tmp')
    with sqlite3.connect(source) as db,sqlite3.connect(temp) as copy:
        db.backup(copy)
        if copy.execute('PRAGMA integrity_check').fetchone()[0]!='ok':raise ValueError('LEDGER_BACKUP_FAILED')
    os.chmod(temp,0o600);os.replace(temp,file)
    for p in root.glob('orders-*.sqlite3'):
        if time.time()-p.stat().st_mtime>30*86400:p.unlink()
    return {'ok':True,'ledgerBackup':file.name,'sha256':hashlib.sha256(file.read_bytes()).hexdigest()}


def wait_for_login(login,secret,account,stopped=None,buying_after_login=False):
    """Serve sign-in only. Returns once a sign-in that works is available."""
    http=server(WaitingForLogin(DATA,buying_after_login),secret,account['ownerProof'],9078,login=login)
    stopped=stopped or threading.Event();first=login.account()['accessToken']
    def watch():
        tried=time.monotonic()
        while not stopped.wait(.5):
            current=login.account()
            retry=time.monotonic()-tried>=LOGIN_RETRY_SECONDS
            if current['accessToken']==first and not retry:continue
            tried=time.monotonic()
            try:FyersRest(current['appId'],current['accessToken']).get_profile()
            except Exception:continue
            break
        # Let a sign-in reply reach the app before closing.
        time.sleep(1);http.shutdown()
    threading.Thread(target=watch,daemon=True).start()
    def shutdown(*args):stopped.set()
    if threading.current_thread() is threading.main_thread():
        signal.signal(signal.SIGTERM,shutdown);signal.signal(signal.SIGINT,shutdown)
    http.serve_forever();http.server_close()
    return not stopped.is_set()


def main():
    import sys
    if sys.argv[1:]==['backup']:print(encoded(backup()));return
    preflight=sys.argv[1:]==['preflight']
    if sys.argv[1:] and not preflight:raise ValueError('INVALID_HOST_COMMAND')
    config={'version':1,'realMoneyEnabled':False,'maxTradeAmount':30000,'feeReserve':100} if preflight else startup('HOST_CONFIGURATION',lambda:secure_json(CONFIG))
    account=startup('ACCOUNT_CONFIGURATION',lambda:secure_json(ACCOUNT))
    secret=startup('JOURNAL_CONFIGURATION',lambda:secure_json('/etc/index-options-journal.json'))['secret']
    login=TradingLogin(account,secret,DATA,lambda:secure_json(TRADING_APP))
    if not preflight:account=login.account()
    try:runtime=build(config,account,secret)
    except StartupError as error:
        if preflight or error.stage!='TRADING_ACCOUNT_READ' or not login.summary()['ready']:raise
        print(encoded({'ok':False,'stage':'WAITING_FOR_TRADING_SIGN_IN','reason':error.reason,'ordersSent':0}),file=sys.stderr,flush=True)
        # A non-zero exit makes systemd start again with the working sign-in.
        sys.exit(1 if wait_for_login(login,secret,account,buying_after_login=config.get('realMoneyEnabled') is True) else 0)
    if preflight:
        print(encoded({'ok':True,'stage':'DISABLED_HOST_PREFLIGHT','niftyContracts':len(runtime.market.master),'readOnlyAccountPassed':True,'journalReadPassed':True,'ordersSent':0,'realMoneyEnabled':False}));return
    http=startup('LOCAL_HTTP_LISTENER',lambda:server(runtime,secret,account['ownerProof'],9078,login=login))
    stopped=threading.Event();initial=hashlib.sha256(ACCOUNT.read_bytes()).digest();token=login.account()['accessToken']
    changed_at=[None]
    def market_worker():
        while not stopped.is_set():
            began=time.monotonic()
            try:runtime.market.refresh()
            except Exception:runtime.market.last_error='TRUSTED_STRATEGY_UNAVAILABLE'
            stopped.wait(refresh_pause(time.monotonic()-began))
    def execution_worker():
        while not stopped.is_set():
            try:
                if login.account()['accessToken']!=token and changed_at[0] is None:changed_at[0]=time.monotonic()
                # A short pause lets the sign-in reply reach the app first.
                if hashlib.sha256(ACCOUNT.read_bytes()).digest()!=initial or (changed_at[0] is not None and time.monotonic()-changed_at[0]>=2):
                    # Systemd reloads renewed credentials and the durable owned ledger.
                    os._exit(1)
                runtime.cycle()
            except Exception:runtime.last_error='EXECUTION_SERVICE_REQUIRES_ATTENTION'
            stopped.wait(.5)
    threading.Thread(target=market_worker,daemon=True).start();threading.Thread(target=execution_worker,daemon=True).start()
    def shutdown(*args):stopped.set();threading.Thread(target=http.shutdown,daemon=True).start()
    signal.signal(signal.SIGTERM,shutdown);signal.signal(signal.SIGINT,shutdown)
    http.serve_forever();http.server_close()

if __name__=='__main__':
    try:main()
    except Exception as error:
        # Only a fixed stage and a bounded constant reason may leave this process.
        import sys
        result={'ok':False,'stage':error.stage if isinstance(error,StartupError) else 'ORDER_HOST_STARTUP','reason':error.reason if isinstance(error,StartupError) else type(error).__name__,'ordersSent':0}
        print(encoded(result),file=sys.stderr);sys.exit(1)
