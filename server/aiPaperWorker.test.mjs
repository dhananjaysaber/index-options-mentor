import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { AiPaperStore } from './aiPaperStore.mjs';
import { AiPaperWorker } from './aiPaperWorker.mjs';
import { startAiPaperService } from './aiPaperService.mjs';
import { once } from 'node:events';
import { createPaperPosition, updatePrices, applyAssessment } from '../src/ai-paper/engine.js';

process.env.TRADING_MODE='paper';
process.env.LIVE_ORDER_EXECUTION_ENABLED='false';
process.env.FYERS_SESSION_SECRET='test-only-32chars-do-not-use-live-23ab';
process.env.FYERS_APP_ID='TEST-100';
process.env.AI_WORKER_ENABLED='true';

test('Encrypted FYERS token and durable paper positions survive a store restart',()=>{
 const dir=mkdtempSync(join(tmpdir(),'mentor-ai-paper-'));
 try{
  const file=join(dir,'paper.sqlite');
  let db=new AiPaperStore(file);
  db.setBrokerToken('fictional-test-broker-token');
  const p={id:'paper-test-1',openedAt:'2026-10-19T06:00:00.000Z',symbol:'NSE:NIFTY26OCT24000CE',
   side:'CE',entry:100,currentPrice:100,quantity:65,optionStop:95,initialPremiumStop:95,highWater:100,underlyingStop:23960,underlyingEntry:24000};
  db.save([p],[],[{type:'PAPER_ENTRY',entryKey:'2026-10-19:CE:NSE:NIFTY26OCT24000CE:1'}]);
  assert.equal(db.getOpen().length,1);
  assert.equal(db.getBrokerToken(),'fictional-test-broker-token');
  assert.equal(db.getDecisions().length,1);
  db.close();

  db=new AiPaperStore(file);
  assert.equal(db.getOpen()[0].id,p.id);
  assert.equal(db.getBrokerToken(),'fictional-test-broker-token');
  assert.equal(db.hasRecentSetup('2026-10-19:CE:NSE:NIFTY26OCT24000CE:1',0),true);
  const prices=updatePrices(db.getOpen(),{[p.symbol]:94},24000);
  assert.equal(prices.closed.length,1);
  assert.equal(prices.closed[0].exitReason,'Option premium protective stop');
  db.save(prices.positions,prices.closed,[{type:'PAPER_EXIT',positionId:p.id}]);
  assert.equal(db.getOpen().length,0);
  assert.equal(db.getClosed().length,1);
  db.close();
 }finally{rmSync(dir,{recursive:true,force:true})}
});

test('Existing paper strategy validates stops, risk and independent entries',()=>{
 const snapshot={live:true,market:{phase:'LIVE',spot:24000,sessionDate:'2026-10-19'},
   option:{symbol:'NSE:NIFTY26OCT24000CE',optionType:'CE',ltp:100,lotSize:65}};
 const assessment={action:'ENTER',side:'CE',optionPremiumStop:95,underlyingStop:23950,reason:'test setup'};
 const first=createPaperPosition({snapshot,assessment,capital:50000,riskPct:1});
 assert.ok(first.position?.id);
 const second=createPaperPosition({snapshot:{...snapshot,option:{...snapshot.option,symbol:'NSE:NIFTY26OCT24100CE'}},assessment,capital:50000,riskPct:1,open:[first.position]});
 assert.ok(second.position?.id,'Different contracts can coexist');
 const risky=createPaperPosition({snapshot,assessment:{...assessment,optionPremiumStop:80},capital:50000,riskPct:1});
 assert.ok(risky.error,'A trade exceeding virtual risk budget must be rejected');
 const widened=applyAssessment([first.position],{positionActions:[{id:first.position.id,action:'TRAIL',optionPremiumStop:90}]});
 assert.equal(widened.positions[0].optionStop,95,'A stop must not widen');
 const tightened=applyAssessment([first.position],{positionActions:[{id:first.position.id,action:'TRAIL',optionPremiumStop:97}]});
 assert.equal(tightened.positions[0].optionStop,97);
});

test('Paper worker reports pause state, never places live orders',()=>{
 const store=new AiPaperStore(':memory:');
 const worker=new AiPaperWorker({store,clock:()=>new Date('2026-10-19T07:00:00.000Z')});
 try{
  assert.equal(worker.safetyLocked,true);
  assert.equal(worker.enabled,false);
  worker.setEnabled(true);
  assert.equal(worker.enabled,true);
  assert.equal(worker.report().paperOnly,true);
  assert.equal(worker.report().managed,true);
  worker.setEnabled(false);
  assert.equal(worker.enabled,false);
 }finally{worker.stop();store.close()}
});

test('Standalone server requires signed login before it exposes paper positions',async()=>{
 process.env.MENTOR_AI_ACCESS_KEY='unit-test-only-remember-password';
 const store=new AiPaperStore(':memory:');
 const worker=new AiPaperWorker({store,clock:()=>new Date('2026-10-19T03:00:00.000Z')});
 const hosted=startAiPaperService({port:0,worker});
 await once(hosted.server,'listening');
 const origin='http://127.0.0.1:'+hosted.server.address().port;
 try{
  const health=await fetch(origin+'/health');
  assert.equal(health.status,200);
  assert.equal((await health.json()).paperOnly,true);
  const unauthorised=await fetch(origin+'/api/ai-paper/state');
  assert.equal(unauthorised.status,401);
  const invalidLogin=await fetch(origin+'/.netlify/functions/ai-session',{method:'POST',
    headers:{'content-type':'application/json'},body:JSON.stringify({action:'login',password:'wrong'})});
  assert.equal(invalidLogin.status,401);
  const login=await fetch(origin+'/.netlify/functions/ai-session',{method:'POST',
    headers:{'content-type':'application/json'},body:JSON.stringify({action:'login',password:process.env.MENTOR_AI_ACCESS_KEY,remember:true})});
  assert.equal(login.status,200);
  const token=(await login.json()).token;
  assert.ok(token);
  const withAuth={authorization:'Bearer '+token};
  const state=await fetch(origin+'/api/ai-paper/state',{headers:withAuth});
  assert.equal(state.status,200);
  assert.equal((await state.json()).managed,true);
  const pause=await fetch(origin+'/api/ai-paper/control',{method:'POST',headers:{...withAuth,'content-type':'application/json'},body:JSON.stringify({enabled:false})});
  assert.equal(pause.status,200);
  assert.equal((await pause.json()).enabled,false);
 }finally{await new Promise(resolve=>hosted.server.close(resolve));hosted.worker.stop();store.close()}
});
