"""Loopback-only signed bridge; no listener starts on import.

A future authenticated Netlify proxy must supply the verified account ID and
server-only HMAC key. Nothing in this file reads browser cookies or enables live.
"""
import hashlib
import hmac
import json
import re
import sqlite3
import time
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from orders import encoded

PATHS={'/live/prepare','/live/submit','/live/exit','/live/reconcile','/live/stop'}


def signature(secret, stamp, nonce, owner, path, body):
    message='\n'.join(['v1',stamp,nonce,owner,'POST',path,hashlib.sha256(body).hexdigest()])
    return hmac.new(secret.encode(),message.encode(),hashlib.sha256).hexdigest()


def make_server(execution, journal, secret, port=0, clock=time.time):
    if not isinstance(secret,str) or len(secret)<32: raise ValueError('BRIDGE_KEY_TOO_SHORT')
    with execution.orders.transaction() as db:
        db.execute('CREATE TABLE IF NOT EXISTS live_nonces (id TEXT PRIMARY KEY, expires REAL NOT NULL)')

    class Handler(BaseHTTPRequestHandler):
        def log_message(self,*_): pass
        def reply(self,status,payload):
            data=encoded(payload).encode(); self.send_response(status)
            self.send_header('Content-Type','application/json'); self.send_header('Content-Length',str(len(data)))
            self.send_header('Cache-Control','no-store'); self.end_headers(); self.wfile.write(data)
        def do_POST(self):
            try:
                if self.path not in PATHS: return self.reply(404,{'error':'NOT_FOUND'})
                length=self.headers.get('Content-Length','')
                if not length.isdigit() or not 0<int(length)<=8192:
                    return self.reply(400,{'error':'INVALID_BODY_SIZE'})
                self.connection.settimeout(5)
                body=self.rfile.read(int(length))
                if len(body)!=int(length): return self.reply(400,{'error':'INCOMPLETE_BODY'})
                stamp=self.headers.get('X-IOM-Time',''); nonce=self.headers.get('X-IOM-Nonce','')
                owner=self.headers.get('X-IOM-Owner',''); supplied=self.headers.get('X-IOM-Signature','')
                now=clock()
                if (not re.fullmatch(r'\d{10}',stamp) or abs(now-int(stamp))>30 or
                        not re.fullmatch(r'[a-f0-9]{32}',nonce) or owner!=execution.orders.account_id or
                        not hmac.compare_digest(supplied,signature(secret,stamp,nonce,owner,self.path,body))):
                    return self.reply(401,{'error':'UNAUTHENTICATED'})
                with execution.orders.transaction() as db:
                    db.execute('DELETE FROM live_nonces WHERE expires < ?',(now,))
                    try: db.execute('INSERT INTO live_nonces VALUES (?,?)',(nonce,now+60))
                    except sqlite3.IntegrityError: return self.reply(409,{'error':'REPLAYED_REQUEST'})
                payload=json.loads(body)
                if not isinstance(payload,dict): raise ValueError('INVALID_REQUEST')
                required={
                    '/live/prepare':{'intentId','symbol','amount','strategy'},'/live/submit':{'intentId'},
                    '/live/exit':{'intentId','entryId','price','quantity'},'/live/reconcile':set(),'/live/stop':set()
                }[self.path]
                if set(payload)!=required: raise ValueError('INVALID_REQUEST_FIELDS')
                if self.path=='/live/prepare': result=execution.prepare(payload['intentId'],payload['symbol'],payload['amount'],payload['strategy'])
                elif self.path=='/live/submit': result=execution.submit(payload['intentId'])
                elif self.path=='/live/exit': result=execution.exit(payload['intentId'],payload['entryId'],payload['price'],payload['quantity'])
                elif self.path=='/live/reconcile': result=execution.recover(journal)
                else:
                    execution.orders.stop(); result={'newEntries':'STOPPED'}
                self.reply(200,{'ok':True,'result':result})
            except (ValueError,TypeError,KeyError,AttributeError):
                # Detailed failures remain local; do not leak SDK payloads or SQL.
                self.reply(409,{'error':'REQUEST_REJECTED'})
            except Exception:
                self.reply(503,{'error':'SERVICE_UNAVAILABLE_RECONCILE_BEFORE_RETRY'})

    server=ThreadingHTTPServer(('127.0.0.1',port),Handler)
    server.daemon_threads=True
    return server
