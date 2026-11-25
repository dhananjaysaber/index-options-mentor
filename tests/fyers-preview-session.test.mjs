import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';
import fyers from '../netlify/functions/fyers.mjs';
const P28='https://deploy-preview-28--optionsmentor.netlify.app',P30='https://deploy-preview-30--optionsmentor.netlify.app';
process.env.FYERS_APP_ID='PAPERTEST-100';process.env.FYERS_APP_SECRET='only-test-secret';process.env.FYERS_SESSION_SECRET='only-test-session-secret';process.env.FYERS_REDIRECT_URI=P28+'/api/fyers/callback';
test('FYERS callback returns encrypted session to the exact other owned preview',async()=>{
  const login=await fyers(new Request(P30+'/api/fyers/login'));
  const state=new URL(login.headers.get('location')).searchParams.get('state');
  const saved=global.fetch;global.fetch=async()=>Response.json({s:'ok',access_token:'FAKE-TEST-ACCESS'});
  try{
    const callback=await fyers(new Request(P28+'/api/fyers/callback?auth_code=fake-code&state='+encodeURIComponent(state)));
    const destination=new URL(callback.headers.get('location'));
    assert.equal(destination.origin,P30);assert.ok(destination.hash.startsWith('#fyers_session='));
    assert.ok(!destination.toString().includes('FAKE-TEST-ACCESS'));assert.ok(callback.headers.get('set-cookie').includes('HttpOnly'));
  }finally{global.fetch=saved;}
});
test('production sessions are not transferred to previews or arbitrary destinations',async()=>{
  const saved=global.fetch;global.fetch=async()=>Response.json({s:'ok',access_token:'FAKE-TEST-ACCESS'});
  try{
    for(const [origin,target] of [['https://optionsmentor.netlify.app',P30],[P30,'https://evil.example'],[P30,'https://deploy-preview-31--optionsmentor.netlify.app']]){
      const login=await fyers(new Request(origin+'/api/fyers/login?returnTo='+encodeURIComponent(target)));
      const state=new URL(login.headers.get('location')).searchParams.get('state');
      const callback=await fyers(new Request(origin+'/api/fyers/callback?auth_code=fake&state='+encodeURIComponent(state)));
      const destination=new URL(callback.headers.get('location'));
      assert.equal(destination.origin,origin);assert.equal(destination.hash,'');
    }
  }finally{global.fetch=saved;}
});
test('same-origin API requests use the encrypted handoff session; other sites receive none',async()=>{
  const calls=[],storage=new Map(),origin=P30;
  const window={location:{hostname:new URL(origin).hostname,origin,pathname:'/',search:'',hash:'#fyers_session=encrypted-test-session'},history:{replaceState(){}},fetch:async(input,init)=>{calls.push({input,init});return new Response('{}');}};
  const source=fs.readFileSync(new URL('../src/services/apiBridge.js',import.meta.url),'utf8').replace(/import\.meta\.env/g,'({})').replace(/^export /gm,'');
  const context={window,document:{title:'Mentor'},URL,URLSearchParams,Headers,localStorage:{getItem:k=>storage.get(k),setItem:(k,v)=>storage.set(k,v),removeItem:k=>storage.delete(k)},console};
  vm.runInNewContext(source+'\ninstallApiBridge();',context);
  await window.fetch('/api/fyers/status');assert.equal(calls.at(-1).init.headers.get('Authorization'),'Bearer encrypted-test-session');
  await window.fetch('https://untrusted.example/');assert.equal(calls.at(-1).init.headers,undefined);
});
test('a normal cookie login clears stale bearer storage and consumes its marker once',async()=>{
  const origin=P28,storage=new Map([['index-options-mentor-fyers-session-v1','old-encrypted-session']]),calls=[];
  const window={location:{hostname:new URL(origin).hostname,origin,pathname:'/',search:'?fyers=connected&keep=1',hash:''},history:{replaceState(_a,_b,url){const next=new URL(url,origin);window.location.search=next.search;window.location.hash=next.hash;}},fetch:async(input,init)=>{calls.push({input,init});return new Response('{}');}};
  const source=fs.readFileSync(new URL('../src/services/apiBridge.js',import.meta.url),'utf8').replace(/import\.meta\.env/g,'({})').replace(/^export /gm,'');
  vm.runInNewContext(source+'\ninstallApiBridge();',{window,document:{title:'Mentor'},URL,URLSearchParams,Headers,localStorage:{getItem:k=>storage.get(k),setItem:(k,v)=>storage.set(k,v),removeItem:k=>storage.delete(k)}});
  await window.fetch('/api/fyers/status');assert.equal(calls.at(-1).init.headers.get('Authorization'),null);
  assert.equal(window.location.search,'?keep=1');assert.equal(storage.size,0);
});
