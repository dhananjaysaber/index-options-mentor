// Failure/restart tests use disposable IndexedDB instances and synthetic paper trades.
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import { createRequire } from 'node:module';
const { IDBFactory } = createRequire(import.meta.url)('fake-indexeddb');
const source=await fs.readFile(new URL('../src/services/tradingStorage.js',import.meta.url),'utf8');
let sequence=0, database, values, failLocal=false, failServer=false;
async function load({restart=false,noDb=false}={}){
  if(!restart){database=new IDBFactory();values=new Map();}
  globalThis.indexedDB=noDb?undefined:database;
  globalThis.window=new EventTarget();
  globalThis.localStorage={getItem:k=>values.get(k)??null,removeItem:k=>values.delete(k),setItem:(k,v)=>{if(failLocal)throw new DOMException('The quota has been exceeded.','QuotaExceededError');values.set(k,v);}};
  globalThis.fetch=async()=>({ok:!failServer,json:async()=>({ok:!failServer})});
  const code=source.replace("import { sendJournalWrite } from './journalTransport.js';",'const sendJournalWrite=()=>globalThis.fetch();');
  return import('data:text/javascript;base64,'+Buffer.from(code+'\n// instance '+(++sequence)).toString('base64'));
}
function trade(id){return {id,symbol:'NSE:NIFTY26NOV25600PE',strategyFamily:'SCALP',mode:'SIMULATION',entry:97.35,quantity:650,openedAt:'2026-11-25T05:29:18Z',entrySnapshot:{preserved:'full details'}};}
function close(t,exit=101.5){return {...t,exit,pnl:(exit-t.entry)*t.quantity,closedAt:'2026-11-25T05:32:00Z',exitReason:'SCALP_OPTION_PROFIT_TRAIL'};}

let s=await load();
values.set(s.TRADE_KEYS.scalp,JSON.stringify(trade('stale-local-pointer')));
const history=Array.from({length:150},(_,i)=>close(trade('old-'+i)));
values.set(s.TRADE_KEYS.history,JSON.stringify(history));
await s.initializeTradingStorage();
assert.equal(s.readTradingJson(s.TRADE_KEYS.history,[]).length,150);
assert.equal(JSON.parse(values.get(s.TRADE_KEYS.history)).length,80);
assert.deepEqual((await s.exportTradingRecovery()).history[0].entrySnapshot,{preserved:'full details'});
failLocal=true;failServer=true;
await s.commitPaperOpen(s.TRADE_KEYS.scalp,trade('new-open'));
assert.equal(s.readTradingJson(s.TRADE_KEYS.scalp,null).id,'new-open');
s=await load({restart:true});await s.initializeTradingStorage();
assert.equal(s.readTradingJson(s.TRADE_KEYS.scalp,null).id,'new-open','reload must not restore stale local pointer');
const first=close(trade('new-open'));
const results=await Promise.all([s.commitPaperClose(s.TRADE_KEYS.scalp,first),s.commitPaperClose(s.TRADE_KEYS.scalp,close(trade('new-open'),118.8))]);
assert.equal(results[0].exit,101.5);assert.equal(results[1].exit,101.5,'replay cannot change original exit price');
assert.equal((await s.durableJournalEvents()).filter(e=>e.id==='close:new-open').length,1);
s=await load({restart:true});await s.initializeTradingStorage();
assert.equal(s.readTradingJson(s.TRADE_KEYS.scalp,null),null);
assert.equal(s.readTradingJson(s.TRADE_KEYS.history,[]).filter(t=>t.id==='new-open').length,1);
assert.equal((await s.exportTradingRecovery()).history.length,151);
assert.ok((await s.durableJournalEvents()).some(e=>e.id==='close:new-open'));
console.log('PASS full phone cache + offline journal: open survives restart; SELL saves once; closed position stays closed; full history retained');

failLocal=false;failServer=false;s=await load();
await new Promise((resolve,reject)=>{const r=database.open('index-options-mentor-journal-v1',1);r.onupgradeneeded=()=>r.result.createObjectStore('outbox',{keyPath:'id'});r.onsuccess=()=>{const db=r.result,tx=db.transaction('outbox','readwrite');tx.objectStore('outbox').put({id:'close:queued-old',type:'TRADE_CLOSED',trade:close(trade('queued-old'))});tx.objectStore('outbox').put({id:'open:unconfirmed',type:'TRADE_OPENED',trade:trade('unconfirmed')});tx.oncomplete=()=>{db.close();resolve();};tx.onerror=reject;};});
await s.initializeTradingStorage();
assert.equal(s.readTradingJson(s.TRADE_KEYS.history,[]).length,1);
assert.equal(s.readTradingJson(s.TRADE_KEYS.history,[])[0].id,'queued-old');
assert.equal((await s.exportTradingRecovery()).pendingEvents.filter(e=>e.type==='TRADE_OPENED').length>=1,true);
assert.equal(s.readTradingJson(s.TRADE_KEYS.scalp,null),null,'pending old opens must not be invented as exits/reopened');
console.log('PASS old pending journal recovery preserves recorded close and leaves unconfirmed open unchanged');

failLocal=false;s=await load({noDb:true});await s.initializeTradingStorage();
await s.commitPaperOpen(s.TRADE_KEYS.scalp,trade('fallback'));
failLocal=true;failServer=true;
await assert.rejects(s.commitPaperClose(s.TRADE_KEYS.scalp,close(trade('fallback'))),/remains open/);
assert.equal(s.readTradingJson(s.TRADE_KEYS.scalp,null).id,'fallback');
assert.equal(s.readTradingJson(s.TRADE_KEYS.history,[]).length,0);
failServer=false;
const result=await s.commitPaperClose(s.TRADE_KEYS.scalp,close(trade('fallback'),118.8));
assert.equal(result.exit,101.5,'retry preserves original observed exit');
assert.equal(s.readTradingJson(s.TRADE_KEYS.scalp,null),null);
console.log('PASS unavailable device storage: failed journal keeps position; confirmed retry completes original exit');

