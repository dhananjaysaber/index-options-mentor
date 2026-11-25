// Isolated UI fixtures. Every API request is intercepted; no real account or writes.
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdir } from 'node:fs/promises';
import { chromium } from 'playwright';
const base='http://127.0.0.1:4173/index-options-mentor-pwa/';
const server=spawn(process.execPath,['node_modules/vite/bin/vite.js','preview','--host','127.0.0.1','--port','4173'],{stdio:'ignore',env:{...process.env,GITHUB_ACTIONS:'true'}});
let browser;
try {
  await mkdir('test-artifacts/premium-design',{recursive:true});
  let ready=false;
  for(let i=0;i<70;i++){try{if((await fetch(base)).ok){ready=true;break;}}catch{}await new Promise(r=>setTimeout(r,200));}
  assert.ok(ready,'Preview starts');
  browser=await chromium.launch({headless:true});
  const page=await browser.newPage({viewport:{width:1440,height:1000},serviceWorkers:'block'});
  const errors=[],writes=[];
  page.on('pageerror',e=>errors.push(e.message));
  await page.addInitScript(()=>{
    localStorage.setItem('index-options-mentor-settings-v2',JSON.stringify({mentorAutoOpen:false,scalpAutoOpen:false,mentorAutoClose:false,scalpAutoClose:false}));
    localStorage.setItem('index-options-mentor-history-v05',JSON.stringify([{id:'isolated-design-history',symbol:'NSE:NIFTY26D0126000CE',side:'CE',entry:230,exit:240,quantity:130,lots:2,pnl:1300,rAchieved:.5,strategyFamily:'CORE',strategyTier:'FULL',initiatedBy:'USER',openedAt:'2026-11-25T04:00:00Z',closedAt:'2026-11-25T04:05:00Z'}]));
  });
  await page.route('**/api/**',route=>{
    const path=new URL(route.request().url()).pathname;
    if(route.request().method()==='POST')writes.push(path);
    let data={ok:true,trades:[],candles:[]};
    if(path.includes('/orders/')) data={ok:true,realMoneyEnabled:false,actualBrokerAcceptanceVerified:false,positions:[],attentionRequired:false,settings:{mentorAutoOpen:false,scalpAutoOpen:false,tradeAmount:30000}};
    else if(path.endsWith('/status'))data={configured:true,authenticated:true};
    else if(path.endsWith('/mentor-snapshot'))data={ok:true,live:true,generatedAt:new Date().toISOString(),market:{phase:'LIVE',sessionDate:'2026-11-25',spot:25550,vwap:25540,orh:25580,orl:25520,pdh:25600,pdl:25400,atr5:25,vix:13.8,putCallOiRatio:1.12,changePct:.46},decision:{state:'NO_TRADE_MANDATORY',headline:'Wait for a confirmed setup',tone:'neutral',side:'CE',score:72,rr:1,canSuggestTrade:false,reasons:['Isolated UI fixture']},option:{symbol:'NSE:NIFTY26D0126000CE',optionType:'CE',strike:26000,ltp:230,lotSize:65},setup:{},structure:{underlyingStop:25520,underlyingTarget:25580,riskPoints:30},parameters:['chop','trend','vwap','risk','liquidity','orb','close','retest','pd','volume','momentum','htf','time'].map((id,i)=>({id,label:id,mandatory:i<5,value:.72,status:'red',gatePassed:false}))};
    else if(path.endsWith('/history'))data={candles:Array.from({length:24},(_,i)=>[Math.floor(Date.now()/1000)-((24-i)*300),25520+i,25530+i,25515+i,25525+i,1000])};
    else if(path.endsWith('/quote'))data={d:[{n:'NSE:NIFTY50-INDEX',v:{lp:25550}},{n:'NSE:NIFTY26D0126000CE',v:{lp:230}}]};
    return route.fulfill({status:200,contentType:'application/json',body:JSON.stringify(data)});
  });
  await page.goto(base,{waitUntil:'domcontentloaded'});
  await page.locator('.core-compact-plan:visible').waitFor();
  for(const width of [1440,1920,1024,768,430,390,320]){
    await page.setViewportSize({width,height:1000});
    const mobile=width<=900;
    const nav=mobile?page.locator('.premium-mobile-bottom-nav'):page.locator('.mentor-sidebar-v2');
    const go=async name=>nav.getByRole('button',{name:new RegExp(name,'i')}).first().click();
    for(const [view,label] of [['Trade','core'],['Scalp','scalp'],['Positions','positions'],['Journal','journal'],['Settings','settings']]){
      await go(view==='Trade'&&!mobile?'13-Point':view);
      if(label==='settings')await page.getByText('Buying is OFF',{exact:true}).waitFor();
      await page.screenshot({path:`test-artifacts/premium-design/${width}-${label}.png`,fullPage:true});
      assert.ok(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth+2),`${width} ${label}: no horizontal page overflow`);
      const bounds=await nav.boundingBox();
      assert.ok(bounds&&bounds.x>=0&&bounds.x+bounds.width<=width+1,'Navigation stays in viewport');
      if(mobile){
        assert.equal(await nav.getByRole('button').count(),5,'Five working mobile destinations');
        const boxes=await nav.getByRole('button').evaluateAll(nodes=>nodes.map(n=>{const r=n.getBoundingClientRect();return {width:r.width,height:r.height};}));
        assert.ok(boxes.every(b=>b.width>=44&&b.height>=44),'Navigation tap targets');
      }
      if(label==='scalp'){
        const dock=await page.locator('.scalp-quick-actions').boundingBox();
        assert.ok(dock&&dock.x>=0&&dock.x+dock.width<=width+1,'Scalp controls remain accessible');
        if(mobile){console.log('Dock geometry',JSON.stringify({width,dock,nav:bounds}));assert.ok(dock.y+dock.height<=bounds.y+1,'Action dock is above bottom navigation');}
      }
      if(label==='core'){const workflow=page.locator('.mentor-workflow:visible').first();if(await workflow.count())assert.ok((await workflow.boundingBox()).height<120,'Live path stays compact');}
      if(label==='journal'){
        const row=page.locator('.history-card-v2').first();
        await row.locator('summary').click();
        await row.getByRole('button',{name:'Analyse trade',exact:true}).click();
        await row.getByRole('button',{name:'Hide analysis',exact:true}).waitFor();
        await row.locator('summary').click();
      }
    }
    if(!mobile){
      await go('Analysis');
      await page.locator('.research-analysis-page').waitFor();
      assert.ok(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth+2),'Analysis stays responsive');
      await page.screenshot({path:`test-artifacts/premium-design/${width}-analysis.png`,fullPage:true});
    }
  }
  assert.ok(!writes.some(p=>/\/orders\/(submit|exit|settings|stop)$/.test(p)),'Layout navigation cannot send broker actions');
  assert.deepEqual(errors,[],'No rendering errors');
  console.log('PASS approved UI at 320/390/430/768/1024/1440/1920; five mobile tabs, journal details, live OFF states and accessible docks; no broker writes');
} finally {if(browser)await browser.close();server.kill('SIGTERM');}
