// Synthetic, intercepted API responses only. No broker or journal writes escape.
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { chromium } from 'playwright';
const base='http://127.0.0.1:4173/index-options-mentor-pwa/';
const server=spawn(process.execPath,['node_modules/vite/bin/vite.js','preview','--host','127.0.0.1','--port','4173'],{stdio:'ignore',env:{...process.env,GITHUB_ACTIONS:'true'}});
let browser;
try{
  let ready=false;
  for(let i=0;i<70;i++){try{if((await fetch(base)).ok){ready=true;break;}}catch{}await new Promise(r=>setTimeout(r,200));}
  assert.ok(ready,'Preview did not start');
  browser=await chromium.launch({headless:true});
  const page=await browser.newPage({viewport:{width:2048,height:1152},serviceWorkers:'block'});
  const errors=[];page.on('pageerror',error=>errors.push(error.message));
  await page.addInitScript(()=>localStorage.setItem('index-options-mentor-settings-v2',JSON.stringify({mentorAutoOpen:false,scalpAutoOpen:false,mentorAutoClose:false,scalpAutoClose:false})));
  await page.route('**/api/**',route=>{
    const path=new URL(route.request().url()).pathname;
    let data={ok:true,trades:[],candles:[]};
    if(path.endsWith('/status'))data={configured:true,authenticated:true};
    if(path.endsWith('/mentor-snapshot'))data={ok:true,live:true,generatedAt:new Date().toISOString(),market:{phase:'LIVE',sessionDate:'2026-11-25',spot:25550,vwap:25540,orh:25580,orl:25520,pdh:25600,pdl:25400,atr5:25},decision:{state:'WAIT',side:'CE',score:50,rr:1,canSuggestTrade:false,reasons:['Synthetic layout fixture']},option:{symbol:'NSE:NIFTY26D0126000CE',optionType:'CE',strike:26000,ltp:150,lotSize:65},setup:{},structure:{underlyingStop:25520,underlyingTarget:25580,riskPoints:30},parameters:['chop','trend','vwap','risk','liquidity','orb','close','retest','pd','volume','momentum','htf','time'].map((id,i)=>({id,label:id,mandatory:i<5,value:50,status:'red',gatePassed:false}))};
    if(path.endsWith('/quote'))data={d:[{n:'NSE:NIFTY50-INDEX',v:{lp:25550}},{n:'NSE:NIFTY26D0126000CE',v:{lp:150}}]};
    return route.fulfill({status:200,contentType:'application/json',body:JSON.stringify(data)});
  });
  await page.goto(base,{waitUntil:'domcontentloaded'});
  const layout=page.locator('.fyers-ref-trade-grid');
  const plan=page.locator('.fyers-ref-decision');
  const chart=page.locator('.fyers-ref-chart');
  const context=page.locator('.fyers-ref-context');
  await plan.waitFor({state:'visible'});
  for(const width of [2048,1440,1024]){
    await page.setViewportSize({width,height:1152});
    const rail=await page.locator('.mentor-sidebar-v2').boundingBox();
    const outer=await layout.boundingBox(),p=await plan.boundingBox(),ch=await chart.boundingBox(),ctx=await context.boundingBox();
    assert.ok(rail&&outer&&p&&ch&&ctx, 'All desktop design regions render');
    assert.ok(ch.width>=300, 'Live chart remains a readable wide left workspace');
    assert.ok(p.width>=330, '13-point gate card remains readable in right panel');
    assert.ok(p.x>=ch.x+ch.width+10, 'Decision card is to the right of the live chart');
    assert.ok(ctx.y>=p.y+p.height+8, 'Market context follows qualification');
    assert.ok(ch.x>=rail.x+rail.width, 'Chart does not overlap navigation rail');
    const controls=await page.locator('.fyers-ref-core .fyers-ref-actions').boundingBox();
    assert.ok(controls && controls.x>=rail.x+rail.width-1,'Actions do not overlap sidebar');
    assert.ok(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth+2),'No desktop horizontal overflow');
    console.log('Reference desktop geometry',JSON.stringify({width,chart:ch,decision:p,context:ctx}));
  }
  const nav=page.locator('.mentor-sidebar-v2 .sidebar-nav-button').filter({hasText:'Positions'}).first();
  await nav.hover();
  const contrast=await nav.evaluate(button=>{
    const rgb=text=>text.match(/[0-9.]+/g).slice(0,3).map(Number);
    const lum=v=>v.map(x=>{x/=255;return x<=.04045?x/12.92:((x+.055)/1.055)**2.4;}).reduce((sum,n,i)=>sum+n*[.2126,.7152,.0722][i],0);
    const fg=lum(rgb(getComputedStyle(button.querySelector('strong')).color));
    const bg=lum(rgb(getComputedStyle(button).backgroundColor));
    return (Math.max(fg,bg)+.05)/(Math.min(fg,bg)+.05);
  });
  assert.ok(contrast>=4.5,'Hover navigation is readable');
  await page.setViewportSize({width:1440,height:680});
  const canvas=page.locator('.fyers-ref-chart .nifty-chart-canvas').first();
  await canvas.scrollIntoViewIfNeeded();
  const box=await canvas.boundingBox();
  assert.ok(box,'Live chart is visible');
  await page.mouse.move(box.x+box.width/2,box.y+box.height/2);
  const beforeScroll=await page.evaluate(()=>scrollY);
  await page.mouse.wheel(0,260);
  await page.waitForFunction(before=>scrollY>before+25,beforeScroll);
  const chain=await canvas.evaluate(svg=>getComputedStyle(svg.parentElement).overscrollBehaviorY);
  assert.equal(chain,'auto','Chart must not trap wheel scrolling');
  await page.setViewportSize({width:390,height:844});
  await page.locator('.fyers-ref-decision').waitFor({state:'visible'});
  const mb=await plan.boundingBox(), cb=await chart.boundingBox();
  assert.ok(mb.y>=cb.y+cb.height, 'Mobile plan stacks after market chart');
  assert.equal(await page.locator('.fyers-ref-verdict:visible').count(),1,'Only one Core recommendation');
  assert.equal(await page.locator('.premium-mobile-bottom-nav button:visible').count(),5,'Five bottom navigation destinations');
  assert.ok(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth+2),'Mobile has no horizontal overflow');
  assert.deepEqual(errors,[]);
  console.log('PASS: 1440px desktop Fyers reference grid, sidebar hover, chart wheel, mobile stacking and five-tab navigation');
}finally{if(browser)await browser.close();server.kill('SIGTERM');}

