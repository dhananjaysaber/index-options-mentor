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
    localStorage.setItem('index-options-mentor-history-v05',JSON.stringify([{id:'isolated-design-history',symbol:'NSE:NIFTY26D0126000CE',side:'CE',entry:230,exit:240,quantity:130,lots:2,pnl:228614.75,rAchieved:.5,strategyFamily:'CORE',strategyTier:'FULL',initiatedBy:'USER',openedAt:'2026-11-25T04:00:00Z',closedAt:'2026-11-25T04:05:00Z'}]));
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
  await page.locator('.fyers-ref-decision:visible').waitFor();
  await page.waitForTimeout(1500);
  console.log('Initial chart history check', JSON.stringify(await page.evaluate(() => ({
    linePoints: document.querySelector('.fyers-ref-core .fyers-ref-price-line')?.getAttribute('points')?.split(/\s+/).length || 0,
    chartError: document.querySelector('.fyers-ref-chart .nifty-chart-empty')?.textContent || '',
    chartLabels: document.querySelector('.fyers-ref-chart .nifty-chart-timeframe-tabs')?.textContent || '',
    historyRequests: performance.getEntriesByType('resource').filter(x => x.name.includes('/history')).map(x => x.name).slice(-3)
  }))));

  assert.equal(await page.locator('.fyers-ref-core .nifty-chart-timeframe-tabs button').count(),3,
    'Reference Core chart keeps 3m, 5m and 15m without a 1m tab');
  for(const width of [1440,1920,1024,768,430,390,320]){
    await page.setViewportSize({width,height:1000});
    const mobile=width<=900;
    const nav=mobile?page.locator('.premium-mobile-bottom-nav'):page.locator('.mentor-sidebar-v2');
    const go=async name=>nav.getByRole('button',{name:new RegExp(name,'i')}).first().click();
    if (mobile) {
      const header=page.locator('.fyers-ref-mobile-header');
      await header.waitFor({state:'visible'});
      const headerBounds=await header.boundingBox();
      const menu=header.getByRole('button',{name:'Open menu'});
      assert.ok(headerBounds && headerBounds.x>=0 && headerBounds.x+headerBounds.width<=width+1,
        'Mobile market header stays in the viewport');
      assert.ok(await menu.isVisible(), 'Hamburger is always visible on mobile');
      await menu.click();
      await page.locator('.mentor-mobile-drawer:visible').waitFor();
      await page.getByRole('button',{name:'Close menu'}).click();
    }
    for(const [view,label] of [['Trade','core'],['Scalp','scalp'],['Positions','positions'],['Journal','journal'],['Settings','settings']]){
      await go(view==='Trade'&&!mobile?'13-Point':view);
      if(label==='settings'){await page.getByRole('button',{name:/Advanced connection and full settings/}).click();await page.getByText('Buying is OFF',{exact:true}).waitFor();}
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
        console.log('Scalp line point count', await page.locator('.fyers-ref-scalp .fyers-ref-price-line').getAttribute('points').then(points => points?.split(/\s+/).length || 0));

        assert.equal(await page.locator('.fyers-ref-scalp .nifty-chart-timeframe-tabs button').count(),2,
          'Scalp reference chart keeps 3m and 5m without a 1m tab');
        const dock=await page.locator('.fyers-ref-scalp .fyers-ref-actions').boundingBox();
        assert.ok(dock&&dock.x>=0&&dock.x+dock.width<=width+1,'Scalp controls remain accessible');
        if(mobile){console.log('Dock geometry',JSON.stringify({width,dock,nav:bounds}));assert.ok(dock.y+dock.height<=bounds.y+1,'Action dock is above bottom navigation');}
      }
      if(label==='core' && mobile){
        const chart=await page.locator('.fyers-ref-chart .nifty-chart-canvas').boundingBox();
        assert.ok(chart && chart.x >= 0 && chart.x + chart.width <= width + 1,
          'The full reference NIFTY SVG scales into the mobile chart instead of clipping the line');
      }
      if(label==='core'){
        const workflow=page.locator('.mentor-workflow:visible').first();
        if(await workflow.count()){
          const box=await workflow.boundingBox();
          console.log('Workflow geometry',JSON.stringify({width,box}));
          assert.ok(box.height<165,'Seven-stage live path stays compact');
          const steps=workflow.locator('.workflow-step');
          assert.equal(await steps.count(),7,'All seven workflow stages render');
          if(mobile){
            const cards=await steps.evaluateAll(nodes=>nodes.map(node=>{
              const r=node.getBoundingClientRect();
              return {x:r.x,y:r.y,width:r.width,height:r.height};
            }));
            assert.ok(cards[0].y===cards[3].y && cards[4].y>cards[3].y,'Mobile workflow uses a four-card first row');
            assert.ok(cards[6].width >= cards[5].width*1.6,'Seventh stage spans final two columns');
          }
        }
        if(mobile){
          assert.ok(await page.locator('.decision-banner:visible').count()<=1,'No duplicate mobile decision cards');
          assert.equal(await page.locator('.fyers-ref-verdict:visible').count(),1,'Core verdict stays visible in the trade plan');
          const buy=page.locator('.fyers-ref-core .strategy-quick-buy');
          const sell=page.locator('.fyers-ref-core .strategy-quick-sell');
          for(const action of [buy,sell]){
            const button=await action.boundingBox();
            const text=await action.locator('span').boundingBox();
            assert.ok(button && text && text.x>=button.x && text.x+text.width<=button.x+button.width+1,
              'BUY and SELL labels remain centred inside their buttons');
          }
        }
      }
      if(label==='journal'){
        if(mobile){
          const metrics=page.locator('.fyers-ref-journal .history-summary-card');
          assert.equal(await metrics.count(),6);
          const overflow=await metrics.evaluateAll(nodes=>nodes.some(node=>{
            const strong=node.querySelector('strong');
            return strong && (strong.getBoundingClientRect().right>node.getBoundingClientRect().right+1
              || strong.scrollWidth>strong.clientWidth+1);
          }));
          assert.equal(overflow,false,'Journal P&L and other metrics fit their own cards');
          const tradePnl=await page.locator('.fyers-ref-journal .history-card-v2 .history-pnl strong').first().evaluate(el=>{
            const rect=el.getBoundingClientRect();
            return {height:rect.height,scrollWidth:el.scrollWidth,clientWidth:el.clientWidth};
          });
          assert.ok(tradePnl.height<28 && tradePnl.scrollWidth<=tradePnl.clientWidth+1,
            'Large INR position P&L fits on a single readable line inside the journal card');
        }
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
  // Open-paper target-hit presentation remains actionable on phone and desktop.
  const positionPage=await browser.newPage({viewport:{width:390,height:844},serviceWorkers:'block'});
  positionPage.on('pageerror',e=>errors.push(e.message));
  await positionPage.addInitScript(()=>{
    localStorage.setItem('index-options-mentor-settings-v2',JSON.stringify({mentorAutoOpen:false,scalpAutoOpen:false,mentorAutoClose:false,scalpAutoClose:false}));
    localStorage.setItem('index-options-mentor-scalp-position-v41',JSON.stringify({id:'isolated-target-hit',mode:'SIMULATION',strategyFamily:'SCALP',strategyTier:'SCALP',side:'CE',symbol:'NSE:NIFTY26NOV25400CE',lots:2,quantity:130,entry:230,currentPrice:245,underlyingEntry:25500,underlyingCurrent:25550,underlyingStop:25475,underlyingTarget:25525,rr:1,bestR:2,currentR:2,peakUnrealizedPnl:2000,optionTrailingActive:true,optionTrailingFloorPnl:1000,openedAt:new Date().toISOString(),score:85,scalpMaxHoldMinutes:12}));
  });
  await positionPage.route('**/api/**',r=>r.fulfill({status:401,contentType:'application/json',body:'{"error":"Isolated target-state fixture"}'}));
  await positionPage.goto(base,{waitUntil:'domcontentloaded'});
  for(const width of [390,1440]){
    await positionPage.setViewportSize({width,height:844});
    const nav=width<=900?positionPage.locator('.premium-mobile-bottom-nav'):positionPage.locator('.mentor-sidebar-v2');
    await nav.getByRole('button',{name:/Scalp/}).first().click();
    const panel=positionPage.locator('.fyers-ref-scalp .position-essential-card');
    await panel.waitFor({state:'visible'});
    assert.match(await panel.innerText(),/PAPER/);
    assert.equal(await positionPage.locator('.fyers-ref-scalp-sell').isDisabled(),false,'Existing paper position retains SELL');
    await positionPage.locator('.fyers-ref-scalp .position-exit-alert').waitFor();
    assert.ok(await positionPage.evaluate(()=>document.documentElement.scrollWidth<=innerWidth+2),'Target-hit state has no horizontal overflow');
    await positionPage.screenshot({path:`test-artifacts/premium-design/${width}-target-hit.png`,fullPage:true});
  }
  await positionPage.close();
  assert.ok(!writes.some(p=>/\/orders\/(submit|exit|settings|stop)$/.test(p)),'Layout navigation cannot send broker actions');
  assert.deepEqual(errors,[],'No rendering errors');
  console.log('PASS approved UI at 320/390/430/768/1024/1440/1920; five mobile tabs, journal details, live OFF states and accessible docks; no broker writes');
} finally {if(browser)await browser.close();server.kill('SIGTERM');}
