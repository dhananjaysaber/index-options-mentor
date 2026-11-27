// Signed out, only the sign-in screen exists. Google and the server are faked.
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { chromium } from 'playwright';
const base='http://127.0.0.1:4173/index-options-mentor-pwa/';
const server=spawn(process.execPath,['node_modules/vite/bin/vite.js','preview','--host','127.0.0.1','--port','4173'],{stdio:'ignore',env:{...process.env,GITHUB_ACTIONS:'true'}});
let browser;
try{
  let ready=false;
  for(let i=0;i<70;i++){try{if((await fetch(base)).ok){ready=true;break;}}catch{}await new Promise(resolve=>setTimeout(resolve,200));}
  assert.ok(ready,'Preview unavailable');
  browser=await chromium.launch({headless:true});
  const page=await browser.newPage({viewport:{width:390,height:844},serviceWorkers:'block'});
  const errors=[],asked=[],logins=[];let signedIn=false,allowed=false,offline=false;
  page.on('pageerror',error=>errors.push(error.message));
  await page.route('https://accounts.google.com/gsi/client',route=>route.fulfill({contentType:'text/javascript',body:`window.google={accounts:{id:{initialize:o=>{window.__google=o},renderButton:el=>{const b=document.createElement('button');b.textContent='Sign in with Google (fake)';b.onclick=()=>window.__google.callback({credential:'fake-proof'});el.appendChild(b)}}}};`}));
  await page.route('**/api/**',route=>{
    const path=new URL(route.request().url()).pathname;asked.push(path);
    const send=(status,data)=>route.fulfill({status,contentType:'application/json',body:JSON.stringify(data)});
    if(path==='/api/auth/session')return offline?route.abort():signedIn?send(200,{signedIn:true,expiresAt:Math.floor(Date.now()/1000)+3600}):send(401,{error:'APP_SIGN_IN_REQUIRED'});
    if(path==='/api/auth/config')return send(200,{configured:true,clientId:'fake.apps.googleusercontent.com',nonce:'fake-nonce'});
    if(path==='/api/auth/login'){logins.push(route.request().postDataJSON());if(!allowed)return send(403,{error:'ACCOUNT_NOT_ALLOWED'});signedIn=true;return send(200,{signedIn:true});}
    return send(401,{error:'Offline UI test'});
  });
  const locked=async()=>{
    assert.equal(await page.locator('.mentor-sidebar-v2, .fyers-ref-decision, .live-setup-card, nav').count(),0,'No app screen behind sign-in');
    assert.deepEqual(asked.filter(path=>!path.startsWith('/api/auth/')),[],'No app data is requested while signed out');
  };
  await page.goto(base+'?view=settings',{waitUntil:'domcontentloaded'});
  await page.getByRole('button',{name:'Sign in with Google (fake)'}).waitFor();
  await page.waitForTimeout(1500);await locked();
  assert.ok(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth+2));
  if(process.env.SCREENSHOTS)await page.screenshot({path:process.env.SCREENSHOTS+'/sign-in-phone.png'});
  await page.getByRole('button',{name:'Sign in with Google (fake)'}).click();
  await page.getByText('This Google account is not allowed. Use your personal account.').waitFor();await locked();
  offline=true;await page.reload();
  await page.getByRole('button',{name:'Try again'}).waitFor();await locked();
  offline=false;allowed=true;await page.reload();
  await page.getByRole('button',{name:'Sign in with Google (fake)'}).click();
  await page.locator('.mentor-sidebar-v2, .fyers-ref-decision, nav').first().waitFor({state:'attached',timeout:15000});
  assert.deepEqual(logins.at(-1),{credential:'fake-proof'});
  assert.deepEqual(errors,[]);
  console.log('PASS sign-in screen: nothing loads signed out, wrong account and lost connection stay locked, approved sign-in opens the app');
}finally{if(browser)await browser.close();server.kill('SIGTERM');}
