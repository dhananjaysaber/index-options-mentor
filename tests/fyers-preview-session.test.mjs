// Owner decision 27 Nov 2026: one main address. The old hand-off of a FYERS
// session to previews and GitHub Pages is removed.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';
import fyers from '../netlify/functions/fyers.mjs';
import { signedInCookie } from './helpers/appSession.mjs';
const MAIN='https://optionsmentor.netlify.app',P30='https://deploy-preview-30--optionsmentor.netlify.app';
process.env.FYERS_APP_ID='PAPERTEST-100';process.env.FYERS_APP_SECRET='only-test-secret';process.env.FYERS_SESSION_SECRET='only-test-session-secret';process.env.FYERS_REDIRECT_URI=MAIN+'/api/fyers/callback';
const cookie=await signedInCookie();
test('a FYERS session is never placed in a web address or sent anywhere else',async()=>{
  const saved=global.fetch;global.fetch=async()=>Response.json({s:'ok',access_token:'FAKE-TEST-ACCESS'});
  try{
    for(const target of [P30,'https://dhananjaysaber.github.io/index-options-mentor-pwa/','https://evil.example']){
      const login=await fyers(new Request(MAIN+'/api/fyers/login?returnTo='+encodeURIComponent(target),{headers:{cookie}}));
      const state=new URL(login.headers.get('location')).searchParams.get('state');
      const callback=await fyers(new Request(MAIN+'/api/fyers/callback?auth_code=fake&state='+encodeURIComponent(state),{headers:{cookie}}));
      const destination=new URL(callback.headers.get('location'));
      assert.equal(destination.origin,MAIN);assert.equal(destination.hash,'');
      assert.ok(!destination.toString().includes('FAKE-TEST-ACCESS'));assert.ok(callback.headers.get('set-cookie').includes('HttpOnly'));
    }
  }finally{global.fetch=saved;}
});
test('a failed FYERS login writes none of the reply to the logs',async()=>{
  const saved=global.fetch,log=console.error,lines=[];global.fetch=async()=>Response.json({s:'error',message:'PRIVATE-REPLY-TEXT'});console.error=(...a)=>lines.push(a.join(' '));
  try{
    const login=await fyers(new Request(MAIN+'/api/fyers/login',{headers:{cookie}}));
    const state=new URL(login.headers.get('location')).searchParams.get('state');
    await fyers(new Request(MAIN+'/api/fyers/callback?auth_code=fake&state='+encodeURIComponent(state),{headers:{cookie}}));
    assert.ok(lines.length);assert.ok(!lines.join('\n').includes('PRIVATE-REPLY-TEXT'));
  }finally{global.fetch=saved;console.error=log;}
});
test('opening a FYERS login page while signed out goes to the sign-in screen',async()=>{
  const response=await fyers(new Request(MAIN+'/api/fyers/login',{headers:{accept:'text/html'}}));
  assert.equal(response.status,302);assert.equal(response.headers.get('location'),'/');assert.equal(response.headers.get('set-cookie'),null);
});
function bridge({search='',hash='',reply=()=>new Response('{}')}={}){
  const calls=[],storage=new Map([['index-options-mentor-fyers-session-v1','old-encrypted-session']]);let reloads=0;
  const window={location:{origin:MAIN,pathname:'/',search,hash,reload:()=>reloads++},history:{replaceState(_a,_b,url){const next=new URL(url,MAIN);window.location.search=next.search;window.location.hash=next.hash;}},fetch:async(input,init)=>{calls.push({input,init});return reply();}};
  const source=fs.readFileSync(new URL('../src/services/apiBridge.js',import.meta.url),'utf8').replace(/^export /gm,'');
  vm.runInNewContext(source+'\ninstallApiBridge();',{window,document:{title:'Mentor'},URL,URLSearchParams,localStorage:{getItem:k=>storage.get(k),setItem:(k,v)=>storage.set(k,v),removeItem:k=>storage.delete(k)}});
  return {window,calls,storage,reloads:()=>reloads};
}
test('the app deletes the old saved session, accepts none from a link and adds no header',async()=>{
  const world=bridge({search:'?fyers=connected&keep=1',hash:'#fyers_session=planted'});
  await world.window.fetch('/api/fyers/status');
  assert.equal(world.calls[0].init,undefined);assert.equal(world.storage.size,0);assert.equal(world.window.location.search,'?keep=1');
});
test('an ended app sign-in reloads once; a FYERS-only 401 does not',async()=>{
  const ended=bridge({reply:()=>Response.json({error:'APP_SIGN_IN_REQUIRED'},{status:401})});
  const first=await ended.window.fetch('/api/orders/status');await ended.window.fetch('/api/journal');
  assert.equal(ended.reloads(),1);assert.equal((await first.json()).error,'APP_SIGN_IN_REQUIRED');
  const broker=bridge({reply:()=>Response.json({error:'FYERS_SESSION_REQUIRED'},{status:401})});
  await broker.window.fetch('/api/orders/status');assert.equal(broker.reloads(),0);
});
