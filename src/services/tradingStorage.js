// Critical paper-trade records are committed independently of the small
// localStorage cache. No broker orders are placed by this module.
import { sendJournalWrite } from './journalTransport.js';
export const TRADE_KEYS = {
  history: 'index-options-mentor-history-v05',
  core: 'index-options-mentor-core-position-v41',
  scalp: 'index-options-mentor-scalp-position-v41',
  legacy: 'index-options-mentor-open-position-v07'
};
const DB = 'index-options-mentor-trading-state-v1';
const RECEIPT = 'index-options-mentor-last-exit-receipt-v1';
const memory = new Map();
const closedIds = new Set();
const closingIds = new Set();
const pendingCloses = new Map();
const closeRequests = new Map();
let database;
let ready;
let tail = Promise.resolve();
let cacheBlocked = false;
let durableAvailable = false;
let legacyEvents = [];
let historyArchived = false;
const changed = () => {
  try { window.dispatchEvent(new CustomEvent('mentor:storage-status')); } catch {}
};
const isPosition = key => [TRADE_KEYS.core, TRADE_KEYS.scalp, TRADE_KEYS.legacy].includes(key);
function localRead(key, fallback) { try { const raw = localStorage.getItem(key); return raw ? JSON.parse(raw) : fallback; } catch { return fallback; } }
function localWrite(key, value) {
  try {
    if (value === null && isPosition(key)) localStorage.removeItem(key);
    else localStorage.setItem(key, typeof value==='string'?value:JSON.stringify(value));
    return true;
  } catch { cacheBlocked = true; changed(); return false; }
}
function compact(trade) {
  const { entrySnapshot, exitSnapshot, entryMarket, entryStructure, entryDecision, entryOption,
    parameterSnapshot, scalpEntryEvaluation, scalpExitEvaluation, ...record } = trade;
  return record;
}
function mergedHistory(...lists) {
  const rows = new Map();
  for (const list of lists) for (const trade of list || []) if (trade?.id && trade.closedAt) rows.set(trade.id, { ...rows.get(trade.id), ...trade });
  return [...rows.values()].sort((a,b) => Date.parse(b.closedAt)-Date.parse(a.closedAt));
}
function open() {
  if (database !== undefined) return Promise.resolve(database);
  return new Promise(resolve => {
    try {
      if (!globalThis.indexedDB) { database = null; resolve(null); return; }
      const request = indexedDB.open(DB, 1);
      request.onupgradeneeded = () => {
        for (const [store,keyPath] of [['state','key'],['trades','id'],['events','id']]) {
          if (!request.result.objectStoreNames.contains(store)) request.result.createObjectStore(store,{keyPath});
        }
      };
      request.onsuccess = () => { database=request.result; database.onversionchange=()=>{database.close();database=undefined;}; durableAvailable=true;resolve(database); };
      request.onerror = () => { database=null;resolve(null); };
      request.onblocked = () => { database=null;resolve(null); };
    } catch { database=null;resolve(null); }
  });
}
async function transaction(stores, action) {
  const db=await open();
  if (!db) return false;
  return new Promise(resolve => {
    try {
      const tx=db.transaction(stores,'readwrite');
      action(name=>tx.objectStore(name));
      tx.oncomplete=()=>{if(!durableAvailable){durableAvailable=true;changed();}resolve(true);};
      tx.onerror=tx.onabort=()=>{durableAvailable=false;changed();resolve(false);};
    } catch { resolve(false); }
  });
}
async function all(store) {
  const db=await open();if(!db)return [];
  return new Promise(resolve=>{
    try { const request=db.transaction(store,'readonly').objectStore(store).getAll(); request.onsuccess=()=>resolve(request.result||[]);request.onerror=()=>resolve([]); }
    catch { resolve([]); }
  });
}
async function oldJournalEvents() {
  if (!globalThis.indexedDB) return [];
  return new Promise(resolve=>{
    try {
      const request=indexedDB.open('index-options-mentor-journal-v1');
      request.onupgradeneeded=()=>request.transaction.abort(); // Never create/change the old journal database.
      request.onerror=request.onblocked=()=>resolve([]);
      request.onsuccess=()=>{
        const db=request.result;
        if (!db.objectStoreNames.contains('outbox')) {db.close();resolve([]);return;}
        const read=db.transaction('outbox','readonly').objectStore('outbox').getAll();
        read.onsuccess=()=>{const rows=read.result||[];db.close();resolve(rows);};
        read.onerror=()=>{db.close();resolve([]);};
      };
    } catch { resolve([]); }
  });
}
export function readTradingJson(key, fallback) {
  const value=memory.has(key)?memory.get(key):localRead(key,fallback);
  if (isPosition(key) && value?.id && closedIds.has(value.id)) return null;
  return value;
}
export function writeTradingJson(key,value) {
  if (isPosition(key) && value?.id && (closingIds.has(value.id)||closedIds.has(value.id))) return false;
  memory.set(key,value);
  if(key===TRADE_KEYS.history)for(const trade of value||[])if(trade?.id&&trade.closedAt)closedIds.add(trade.id);
  // History's large snapshots belong in IndexedDB. Compact only after its
  // complete records have been committed; never discard unarchived history.
  const cached=key===TRADE_KEYS.history?false:localWrite(key,value);
  tail=tail.catch(()=>{}).then(async()=>{
    const saved=await transaction(key===TRADE_KEYS.history?['state','trades']:['state'],get=>{
      get('state').put({key,value,updatedAt:Date.now()});
      if(key===TRADE_KEYS.history)for(const trade of value||[])if(trade?.id&&trade.closedAt)get('trades').put(trade);
    });
    if(key===TRADE_KEYS.history){
      if(saved){historyArchived=true;localWrite(key,(value||[]).slice(0,80).map(compact));}
      else localWrite(key,value);
    }
    return saved||cached;
  });
  return cached;
}
export function initializeTradingStorage() {
  if (ready) return ready;
  ready=(async()=>{
    const [states,trades,oldEvents]=await Promise.all([all('state'),all('trades'),oldJournalEvents()]);
    const fallbackEvents=localRead('index-options-mentor-journal-outbox-v1',[]);
    oldEvents.push(...(Array.isArray(fallbackEvents)?fallbackEvents:[]));
    legacyEvents=oldEvents;
    const localHistory=localRead(TRADE_KEYS.history,[]);
    const fromQueue=oldEvents.filter(e=>e.type==='TRADE_CLOSED').map(e=>e.trade);
    const receipt=localRead(RECEIPT,null);
    const history=mergedHistory(localHistory,trades,fromQueue,receipt?[receipt]:[]);
    for(const trade of history)closedIds.add(trade.id);
    for(const row of states){
      const local=localRead(row.key,undefined);
      memory.set(row.key,local===undefined?row.value:local);
      if(isPosition(row.key)){
        // A committed close wins over an older surviving localStorage pointer.
        // IndexedDB is the committed position, including null tombstones.
        // localStorage may still contain an older position after a quota error.
        memory.set(row.key,row.value);
        if(closedIds.has(row.value?.id))memory.set(row.key,null);
      }
    }
    for(const key of [TRADE_KEYS.core,TRADE_KEYS.scalp,TRADE_KEYS.legacy]){
      if(!memory.has(key))memory.set(key,localRead(key,null));
      if(closedIds.has(memory.get(key)?.id))memory.set(key,null);
    }
    const legacy=memory.get(TRADE_KEYS.legacy);
    if(legacy?.id){
      const key=legacy.strategyFamily==='SCALP'?TRADE_KEYS.scalp:TRADE_KEYS.core;
      const managed=states.some(row=>row.key===key)||localRead(key,undefined)!==undefined;
      if(managed)memory.set(TRADE_KEYS.legacy,memory.get(key)||null);
      else if(!closedIds.has(legacy.id))memory.set(key,legacy);
    }
    memory.set(TRADE_KEYS.history,history);
    const saved=await transaction(['state','trades','events'],get=>{
      for(const trade of history)get('trades').put(trade);
      for(const [key,value] of memory)get('state').put({key,value,updatedAt:Date.now()});
      for(const event of oldEvents)if(event?.id&&event?.trade?.id)get('events').put(event);
    });
    if(saved){historyArchived=true;localWrite(TRADE_KEYS.history,history.slice(0,80).map(compact));}
    changed();return {durableAvailable,cacheBlocked};
  })();
  return ready;
}
export async function commitPaperOpen(key,position) {
  await initializeTradingStorage();
  await tail.catch(()=>{});
  const event={id:`open:${position.id}`,type:'TRADE_OPENED',queuedAt:position.openedAt,source:'mentor',trade:position};
  const saved=await transaction(['state','events'],get=>{
    get('state').put({key,value:position,updatedAt:Date.now()});get('events').put(event);
  });
  const local=localWrite(key,position);
  if(!saved&&!local)throw Error('This paper position was not opened because the device could not save it. Existing positions are unchanged.');
  memory.set(key,position);changed();
  try{window.dispatchEvent(new CustomEvent('mentor:durable-trade'));}catch{}
}
export function commitPaperClose(key,closed) {
  if(closeRequests.has(closed.id))return closeRequests.get(closed.id);
  const request=commitClose(key,closed).finally(()=>closeRequests.delete(closed.id));
  closeRequests.set(closed.id,request);
  return request;
}
async function commitClose(key,closed) {
  await initializeTradingStorage();
  if(closedIds.has(closed.id))return readTradingJson(TRADE_KEYS.history,[]).find(t=>t.id===closed.id)||closed;
  if(pendingCloses.has(closed.id))closed=pendingCloses.get(closed.id);
  else pendingCloses.set(closed.id,closed);
  closingIds.add(closed.id);
  try {
    await initializeTradingStorage();await tail.catch(()=>{});
    const event={id:`close:${closed.id}`,type:'TRADE_CLOSED',queuedAt:closed.closedAt,source:'mentor',trade:closed};
    const legacy=readTradingJson(TRADE_KEYS.legacy,null);
    const indexedSaved=await transaction(['state','trades','events'],get=>{
      get('trades').put(closed);get('events').put(event);
      get('state').put({key,value:null,closedId:closed.id,updatedAt:Date.now()});
      if(legacy?.id===closed.id)get('state').put({key:TRADE_KEYS.legacy,value:null,closedId:closed.id,updatedAt:Date.now()});
    });
    let saved=indexedSaved;
    const history=mergedHistory(readTradingJson(TRADE_KEYS.history,[]),[closed]);
    if(!saved){
      // If IndexedDB itself is unavailable, retain the entire local history.
      // Never trim unarchived records merely to make an exit look successful.
      saved=localWrite(TRADE_KEYS.history,history);
      if(!saved){
        try {
          const response=await sendJournalWrite({action:'journal_event',event});
          const result=await response.json();saved=response.ok&&result?.ok===true;
        } catch { saved=false; }
      }
      if(!saved)throw Error('The exit could not be saved on this device or the journal. The paper position remains open; keep the app open and retry SELL.');
    }
    pendingCloses.delete(closed.id);
    closedIds.add(closed.id);memory.set(key,null);
    if(legacy?.id===closed.id)memory.set(TRADE_KEYS.legacy,null);
    memory.set(TRADE_KEYS.history,history);
    localWrite(key,null);if(legacy?.id===closed.id)localWrite(TRADE_KEYS.legacy,null);
    localWrite(RECEIPT,compact(closed));
    // Full records are already durable in IndexedDB or the server/receipt.
    // Keep the existing history untouched if compacting still cannot be written.
    if(indexedSaved||historyArchived)localWrite(TRADE_KEYS.history,history.slice(0,80).map(compact));
    changed();try{window.dispatchEvent(new CustomEvent('mentor:durable-trade'));}catch{}
    return closed;
  } finally {closingIds.delete(closed.id);}
}
export async function durableJournalEvents(){await initializeTradingStorage();return all('events');}
export async function acknowledgeDurableEvent(id){await transaction(['events'],get=>get('events').delete(id));}
export function tradingStorageStatus(){return {durableAvailable,cacheBlocked};}
export async function exportTradingRecovery(){
  await initializeTradingStorage();
  const events=[...legacyEvents,...await durableJournalEvents()];
  return {exportedAt:new Date().toISOString(),positions:[TRADE_KEYS.core,TRADE_KEYS.scalp,TRADE_KEYS.legacy].map(key=>({key,position:readTradingJson(key,null)})),history:readTradingJson(TRADE_KEYS.history,[]),pendingEvents:events};
}

