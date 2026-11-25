"""Loopback diagnostic host. There are deliberately no real-order routes."""
import hashlib
import hmac
import json
import os
import re
import sqlite3
import threading
import time
import uuid
from http.server import BaseHTTPRequestHandler,ThreadingHTTPServer
from pathlib import Path
from bridge import signature
from diagnostic import run_check
from orders import encoded

class Checks:
    def __init__(self,file,owner,secret,journal_source=None):
        if not re.fullmatch(r'[a-f0-9]{64}',owner) or len(secret)<32: raise ValueError('EXECUTION_CHECK_NOT_CONFIGURED')
        self.file,self.owner,self.secret,self.journal_source=str(file),owner,secret,journal_source
        self.lock=threading.Lock()
        with sqlite3.connect(self.file) as db:
            db.execute('CREATE TABLE IF NOT EXISTS check_nonces (id TEXT PRIMARY KEY,expires REAL NOT NULL)')
            db.execute('CREATE TABLE IF NOT EXISTS check_results (id TEXT PRIMARY KEY,state TEXT NOT NULL,result TEXT,at REAL NOT NULL)')
    def authenticate(self,headers,path,body):
        stamp=headers.get('X-IOM-Time',''); nonce=headers.get('X-IOM-Nonce','');owner=headers.get('X-IOM-Owner','')
        given=headers.get('X-IOM-Signature','');now=time.time()
        if (not re.fullmatch(r'\d{10}',stamp) or abs(now-int(stamp))>30 or not re.fullmatch(r'[a-f0-9]{32}',nonce) or
                owner!=self.owner or not hmac.compare_digest(given,signature(self.secret,stamp,nonce,owner,path,body))):
            raise PermissionError('UNAUTHENTICATED')
        with sqlite3.connect(self.file) as db:
            db.execute('DELETE FROM check_nonces WHERE expires < ?',(now,))
            try: db.execute('INSERT INTO check_nonces VALUES (?,?)',(nonce,now+60))
            except sqlite3.IntegrityError as error: raise PermissionError('REPLAYED_REQUEST') from error
    def status(self):
        with sqlite3.connect(self.file) as db: row=db.execute("SELECT result FROM check_results WHERE state='DONE' ORDER BY at DESC LIMIT 1").fetchone()
        return {'ok':True,'connection':'CONNECTED','mode':'DIAGNOSTICS_ONLY','realMoneyEnabled':False,
                'lastCheck':json.loads(row[0]) if row else None}
    def check(self,check_id):
        if not isinstance(check_id,str) or str(uuid.UUID(check_id))!=check_id: raise ValueError('INVALID_CHECK_ID')
        with self.lock:
            with sqlite3.connect(self.file) as db:
                row=db.execute('SELECT state,result FROM check_results WHERE id=?',(check_id,)).fetchone()
                if row:
                    if row[0]=='DONE': return json.loads(row[1])
                    raise ValueError('CHECK_ALREADY_RUNNING_OR_INTERRUPTED_USE_NEW_CHECK_ID')
                db.execute('INSERT INTO check_results VALUES (?,?,?,?)',(check_id,'RUNNING',None,time.time()))
            result=run_check(self.owner,self.journal_source)
            result['checkedAt']=time.time()
            with sqlite3.connect(self.file) as db:
                db.execute("UPDATE check_results SET state='DONE',result=? WHERE id=?",(encoded(result),check_id))
            return result


def make_diagnostic_server(checks,port=0):
    class Handler(BaseHTTPRequestHandler):
        def log_message(self,*_): pass
        def reply(self,status,data):
            body=encoded(data).encode();self.send_response(status)
            self.send_header('Content-Type','application/json');self.send_header('Content-Length',str(len(body)))
            self.send_header('Cache-Control','no-store');self.end_headers();self.wfile.write(body)
        def do_POST(self):
            try:
                if self.path not in ('/monitor/live/status','/monitor/live/check'): return self.reply(404,{'error':'ROUTE_DISABLED'})
                length=self.headers.get('Content-Length','')
                if not length.isdigit() or not 0<int(length)<=1024: raise ValueError('INVALID_BODY')
                self.connection.settimeout(5);body=self.rfile.read(int(length))
                if len(body)!=int(length): raise ValueError('INVALID_BODY')
                checks.authenticate(self.headers,self.path,body)
                payload=json.loads(body)
                if self.path.endswith('/status'):
                    if payload!={}: raise ValueError('INVALID_STATUS')
                    return self.reply(200,checks.status())
                if not isinstance(payload,dict) or set(payload)!={'checkId'}: raise ValueError('INVALID_CHECK')
                self.reply(200,checks.check(payload['checkId']))
            except PermissionError: self.reply(403,{'error':'EXECUTION_CHECK_AUTHENTICATION_FAILED'})
            except (ValueError,TypeError,KeyError): self.reply(409,{'error':'EXECUTION_CHECK_REJECTED'})
            except Exception: self.reply(503,{'error':'EXECUTION_CHECK_FAILED','realMoneyEnabled':False})
    server=ThreadingHTTPServer(('127.0.0.1',port),Handler);server.daemon_threads=True
    return server


def main():
    config=json.loads(Path(os.environ.get('IOM_EXECUTION_CHECK_CONFIG','/etc/index-options-execution-check.json')).read_text())
    if config.get('realMoneyEnabled') is not False: raise ValueError('REAL_MONEY_RELEASE_LOCKED')
    root=Path(config.get('dataRoot','/var/lib/index-options-mentor/execution-check'))
    root.mkdir(mode=0o700,parents=True,exist_ok=True)
    checks=Checks(root/'checks.sqlite3',config['ownerProof'],config['secret'],config['journalSource'])
    make_diagnostic_server(checks,port=9077).serve_forever()

if __name__=='__main__': main()
