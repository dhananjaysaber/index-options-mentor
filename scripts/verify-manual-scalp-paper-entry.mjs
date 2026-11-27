// Isolated UI regression for a *manual* Scalp BUY while strict auto research
// is WAITING. Every /api/* request is intercepted: no FYERS/account writes.
import { fakeSignedIn } from './lib/fake-signed-in.mjs';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { chromium } from 'playwright';

const base='http://127.0.0.1:4173/index-options-mentor-pwa/';
const fixed='2026-11-26T04:30:00.000Z'; // 10:00 IST, trading session
const mockSymbol='NSE:NIFTY26D0125800CE';
const bucket=Math.floor(Date.parse(fixed)/1000/180)*180;
const candles=[
 [bucket-900,25838,25848,25833,25842,1000],
 [bucket-720,25843,25851,25839,25845,1000],
 [bucket-540,25847,25853,25841,25846,1000],
 [bucket-360,25845,25852,25837,25843,1000],
 [bucket-180,25844,25852,25835,25843,1000]
];
const snapshot={
 ok:true,live:true,generatedAt:fixed,
 market:{phase:'LIVE',sessionDate:'2026-11-26',spot:25845,
   vwap:25840,orh:25880,orl:25768,pdh:25951,pdl:25619,
   atr5:59,vix:17,putCallOiRatio:0.89,changePct:0.09},
 decision:{state:'NO_TRADE_MANDATORY',headline:'Wait for a strong scalp setup',
   tone:'neutral',side:'CE',score:50,rr:1,canSuggestTrade:false,
   reasons:['Trend and impulse not confirmed']},
 option:{symbol:mockSymbol,optionType:'CE',strike:25800,expiry:'2026-12-01',
   ltp:284.75,lotSize:65,estimatedPremiumStop:221.99,
   estimatedPremiumTarget:304.75},
 setup:{},structure:{underlyingStop:25832,underlyingTarget:25858,riskPoints:13},
 parameters:['chop','trend','vwap','risk','liquidity','orb','close','retest',
   'pd','volume','momentum','htf','time'].map(id=>({
   id,label:id,value:id==='trend'?0.30:0.70,
   mandatory:['chop','trend','vwap','risk','liquidity'].includes(id),
   status:id==='liquidity'?'green':'red',gatePassed:id==='liquidity'
 }))
};
const server=spawn(process.execPath,
 ['node_modules/vite/bin/vite.js','preview','--host','127.0.0.1','--port','4173'],
 {env:{...process.env,GITHUB_ACTIONS:'true'},stdio:'ignore'});
let browser;
try {
 let reachable=false;
 for(let i=0;i<70;i++){
   try{if((await fetch(base)).ok){reachable=true;break;}}catch{}
   await new Promise(resolve=>setTimeout(resolve,200));
 }
 assert.ok(reachable,'Isolated local preview starts');
 browser=await chromium.launch({headless:true});
 const page=await browser.newPage({
   viewport:{width:390,height:844},serviceWorkers:'block'
 });
 await page.clock.install({time:new Date(fixed)});
 const pageErrors=[],apiWrites=[];
 page.on('pageerror',error=>pageErrors.push(error.message));
 await page.addInitScript(()=>{
   localStorage.setItem('index-options-mentor-settings-v2',JSON.stringify({
     tradeAmount:30000,capital:50000,riskPct:1,lotCap:5,
     mentorAutoOpen:false,mentorAutoClose:false,
     scalpAutoOpen:false,scalpAutoClose:false
   }));
   // Market prices belong to an isolated test fixture, never a live FYERS account.
   window.__indexOptionsLiveQuote={
     nifty:25845,optionPrice:284.75,
     optionSymbol:'NSE:NIFTY26D0125800CE',at:new Date().toISOString()
   };
 });
 await page.route('**/api/**',async route=>{
   const request=route.request(),url=new URL(request.url()),path=url.pathname;
   if(request.method()!=='GET')apiWrites.push(path);
   let data={ok:true,trades:[],candles:[]};
   if(path.startsWith('/api/orders/'))data={
     ok:true,realMoneyEnabled:false,actualBrokerAcceptanceVerified:false,
     positions:[],attentionRequired:false,
     settings:{mentorAutoOpen:false,scalpAutoOpen:false,tradeAmount:30000}
   };
   else if(path==='/api/fyers/status')data={configured:true,authenticated:true};
   else if(path==='/api/fyers/mentor-snapshot')data=snapshot;
   else if(path==='/api/fyers/history')data={candles};
   else if(path==='/api/fyers/quote')data={d:[
     {n:'NSE:NIFTY50-INDEX',v:{lp:25845}},
     {n:mockSymbol,v:{lp:284.75}}
   ]};
   await route.fulfill({status:200,contentType:'application/json',body:JSON.stringify(data)});
 });
 await fakeSignedIn(page);
 await page.goto(base,{waitUntil:'domcontentloaded'});
 await page.locator('.premium-mobile-bottom-nav button').nth(1).click();
 const decision=page.locator('.fyers-ref-scalp-decision');
 await decision.waitFor({state:'visible'});
 const buy=page.locator('.fyers-ref-scalp-order-actions .fyers-ref-scalp-buy');
 const sell=page.locator('.fyers-ref-scalp-order-actions .fyers-ref-scalp-sell');
 await page.waitForFunction(()=>{
   const action=document.querySelector('.fyers-ref-scalp-order-actions .fyers-ref-scalp-buy');
   const card=document.querySelector('.fyers-ref-scalp-decision');
   return action&&!action.disabled&&card?.textContent?.includes('4/7');
 },null,{timeout:15000});
 assert.match(await decision.innerText(),/WAITING/);
 assert.match(await decision.innerText(),/4\/7/);
 assert.equal(await buy.innerText(),'BUY CE');
 assert.equal(await sell.isDisabled(),true);
 await buy.click();
 await page.waitForFunction(()=>{
   try{return Boolean(JSON.parse(localStorage.getItem('index-options-mentor-scalp-position-v41')||'null')?.id);}
   catch{return false;}
 },null,{timeout:10000});
 const paper=await page.evaluate(()=>JSON.parse(localStorage.getItem('index-options-mentor-scalp-position-v41')));
 assert.equal(paper.mode,'SIMULATION');
 assert.equal(paper.strategyFamily,'SCALP');
 assert.equal(paper.initiatedBy,'USER');
 assert.equal(paper.entryMethod,'MANUAL');
 assert.equal(paper.side,'CE');
 assert.equal(paper.score,50);
 assert.equal(paper.scalpManualOverride,true);
 assert.equal(paper.scalpAutoEligibleAtEntry,false);
 assert.equal(paper.lots,1);
 assert.equal(paper.quantity,65);
 assert.equal(paper.tradeAmount,30000);
 assert.ok(paper.premiumCost<=30000);
 assert.equal(paper.symbol,mockSymbol);
 assert.equal(await buy.isDisabled(),true,'Duplicate BUY is blocked with open paper position');
 await sell.waitFor({state:'visible'});
 assert.equal(await sell.isDisabled(),false,'SELL is active with paper position');
 await sell.click();
 await page.waitForFunction(id=>{
   const raw=localStorage.getItem('index-options-mentor-scalp-position-v41');
   const position=raw?JSON.parse(raw):null;
   return !position?.id||position.id!==id;
 },paper.id,{timeout:10000});
 await page.locator('.premium-mobile-bottom-nav button').nth(3).click();
 await page.locator('.fyers-ref-journal .history-panel').waitFor({state:'visible'});
 const history=await page.evaluate(()=>JSON.parse(localStorage.getItem('index-options-mentor-history-v05')||'[]'));
 const matches=history.filter(row=>row.id===paper.id);
 assert.equal(matches.length,1,'Exactly one journal closure per manually entered scalp');
 assert.ok(Number.isFinite(matches[0].pnl),'P&L is calculated for paper exit');
 assert.equal(matches[0].mode,'SIMULATION');
 assert.ok(!apiWrites.some(path=>/^\/api\/(orders|execution)\/(?:submit|exit|buy|place)/.test(path)),
   'Manual paper BUY and SELL must never submit an actual broker order');
 assert.deepEqual(pageErrors,[],'No UI runtime errors during manual paper BUY/SELL');
 console.log('PASS isolated manual scalp: strict WAITING 4/7 → BUY CE user paper position (1 lot, 65 qty) → SELL → one journal closure; zero broker orders');
} finally {
 if(browser)await browser.close();
 server.kill('SIGTERM');
}
