import test from 'node:test';
import assert from 'node:assert/strict';
import {signals} from '../aws/live/entrySignals.mjs';
import {setTrustedSymbolMaster} from '../server/mentorBase.js';
test('server strategy reuses shared rules; missing option cannot create an entry',async()=>{
  const start=Date.parse('2026-11-25T09:15:00+05:30')/1000,nowMs=Date.parse('2026-11-25T10:45:00+05:30');
  const candles=Array.from({length:18},(_,i)=>[start+i*300,25000,25005,24995,25000,1000]);
  const saved=global.fetch;global.fetch=()=>{throw Error('NO_NETWORK_ALLOWED_IN_TEST');};
  try{
    const result=await signals({nowMs,masterAt:Date.now(),symbolLots:{},settings:{tradeAmount:30000},threeMinute:[],market:{quoteResponse:{d:[{v:{lp:25000}}]},historyResponse:{candles},chainResponse:{data:{optionsChain:[]}}}});
    assert.ok(result.snapshot);assert.ok(Object.values(result.tickets).every(t=>t===null));
  }finally{global.fetch=saved;}
});
test('stale master cannot be marked fresh or supplied from an array',()=>{
  assert.throws(()=>setTrustedSymbolMaster({},Date.now()-86400001),/STALE/);
  assert.throws(()=>setTrustedSymbolMaster([],Date.now()),/STALE/);
});
