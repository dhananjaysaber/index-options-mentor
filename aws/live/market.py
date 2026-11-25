"""Server-only strategy inputs; no client-supplied qualification, symbols or quotes."""
from datetime import datetime,timedelta
from decimal import Decimal
import json
import codecs
from pathlib import Path
import re
import subprocess
import threading
import time
from zoneinfo import ZoneInfo
import urllib.request
from account_connect import NoRedirect

TZ=ZoneInfo('Asia/Kolkata')


def read_nifty_master(stream, *, max_bytes=256*1024*1024, chunk_size=65536, max_record=1024*1024):
    """Stream FYERS' full F&O object and retain only NIFTY option records.

    Memory is bounded by one input chunk, one record and the retained contracts;
    the many stock-option records are discarded immediately after decoding.
    """
    decoder=json.JSONDecoder();utf8=codecs.getincrementaldecoder('utf-8')()
    buffer='';pos=0;total=0;eof=False;result={}
    def more():
        nonlocal buffer,pos,total,eof
        if eof:return False
        buffer=buffer[pos:];pos=0
        if len(buffer)>max_record:raise ValueError('CONTRACT_MASTER_RECORD_TOO_LARGE')
        raw=stream.read(chunk_size);total+=len(raw)
        if total>max_bytes:raise ValueError('CONTRACT_MASTER_TOO_LARGE')
        eof=not raw
        try:buffer+=utf8.decode(raw,final=eof)
        except UnicodeDecodeError:raise ValueError('CONTRACT_MASTER_INVALID_ENCODING') from None
        return bool(raw)
    def space():
        nonlocal pos
        while True:
            while pos<len(buffer) and buffer[pos].isspace():pos+=1
            if pos<len(buffer) or eof:return
            more()
    def token(expected):
        nonlocal pos
        space()
        if pos>=len(buffer) or buffer[pos]!=expected:raise ValueError('CONTRACT_MASTER_INVALID')
        pos+=1
    def value():
        nonlocal pos
        space()
        while True:
            try:
                item,end=decoder.raw_decode(buffer,pos)
                # Numeric values may end at a chunk boundary; read the delimiter
                # before accepting so a split number cannot be parsed partially.
                if end==len(buffer) and not eof:
                    if not more():continue
                    continue
                pos=end
                return item
            except json.JSONDecodeError:
                if eof:raise ValueError('CONTRACT_MASTER_INVALID') from None
                more()
    token('{');first=True
    while True:
        space()
        if pos<len(buffer) and buffer[pos]=='}':pos+=1;break
        if not first:token(',')
        symbol=value()
        if not isinstance(symbol,str):raise ValueError('CONTRACT_MASTER_INVALID')
        token(':');record=value()
        if re.fullmatch(r'NSE:NIFTY[A-Z0-9]+(?:CE|PE)',symbol):
            if not isinstance(record,dict) or symbol in result:raise ValueError('CONTRACT_MASTER_INVALID_NIFTY_RECORD')
            result[symbol]=record
        first=False
    space()
    if pos<len(buffer):raise ValueError('CONTRACT_MASTER_TRAILING_DATA')
    if not result:raise ValueError('NO_NIFTY_CONTRACTS')
    return result

class Market:
    def __init__(self,client,settings,clock=time.time):
        self.client,self.settings,self.clock=client,settings,clock
        self.lock=threading.RLock();self.master={};self.master_at=0;self.history={};self.history_at=0
        self.latest=None;self.last_error='STRATEGY_NOT_LOADED'
    def session_open(self):
        now=datetime.fromtimestamp(self.clock(),TZ)
        if now.weekday()>=5 or not 9*60+15 <= now.hour*60+now.minute <= 15*60+15:return False
        data=self.client.market_status().get('marketStatus',[])
        return any(isinstance(row,dict) and row.get('exchange')=='NSE' and row.get('segment')=='FO' and row.get('status')=='OPEN' for row in data)
    def refresh_master(self):
        if self.clock()-self.master_at<21600 and self.master:return
        opener=urllib.request.build_opener(urllib.request.ProxyHandler({}),NoRedirect())
        with opener.open('https://public.fyers.in/sym_details/NSE_FO_sym_master.json',timeout=12) as response:
            result=read_nifty_master(response)
        self.master,self.master_at=result,self.clock()
    def contract(self,symbol):
        with self.lock:
            if self.clock()-self.master_at>86400:raise ValueError('CONTRACT_MASTER_STALE')
            row=self.master.get(symbol,{})
            # No fallback lot size, tick size, expiry or freeze quantity.
            lot,freeze=row.get('minLotSize'),row.get('qtyFreeze')
            if isinstance(freeze,str) and freeze.isdigit():freeze=int(freeze)
            if type(lot) is not int or type(freeze) is not int:raise ValueError('CONTRACT_LIMITS_UNVERIFIED')
            return {'symbol':symbol,'active':row.get('tradeStatus')==1,'lot_size':lot,'max_quantity':freeze,
                    'tick_size':row.get('tickSize'),'expires_at':row.get('expiryDate'),'checked_at':self.master_at}
    def refresh(self):
        with self.lock:
            now=datetime.fromtimestamp(self.clock(),TZ);today=now.strftime('%Y-%m-%d')
            self.refresh_master()
            if self.clock()-self.history_at>60 or not self.history:
                histories={}
                for resolution in ('5','3'):
                    histories[resolution]=self.client.market('/history',{'symbol':'NSE:NIFTY50-INDEX','resolution':resolution,'date_format':'1','range_from':(now-timedelta(days=8)).strftime('%Y-%m-%d'),'range_to':today,'cont_flag':'1'})
                self.history,self.history_at=histories,self.clock()
            market={'quoteResponse':self.client.market('/quotes',{'symbols':'NSE:NIFTY50-INDEX'}),
                    'historyResponse':self.history['5'],
                    'chainResponse':self.client.market('/options-chain-v3',{'symbol':'NSE:NIFTY50-INDEX','strikecount':12,'greeks':'1'})}
            data={'market':market,'threeMinute':self.history['3'].get('candles',[]),'settings':self.settings(), 'nowMs':self.clock()*1000,'masterAt':self.master_at*1000,'symbolLots':{s:{'minLotSize':r.get('minLotSize')} for s,r in self.master.items()}}
            proc=subprocess.run(['node',str(Path(__file__).with_name('entrySignals.mjs'))],input=json.dumps(data),text=True,capture_output=True,check=True,timeout=20)
            value=json.loads(proc.stdout)
            if not isinstance(value.get('tickets'),dict):raise ValueError('INVALID_STRATEGY_RESULT')
            self.latest=value;self.last_error=None
            return value
    def current(self):
        with self.lock:
            data=self.latest
            if not data:raise ValueError('STRATEGY_NOT_LOADED')
            at=datetime.fromisoformat(data['generatedAt'].replace('Z','+00:00')).timestamp()
            if not -1<=self.clock()-at<=12:raise ValueError('STRATEGY_STALE')
            return data
