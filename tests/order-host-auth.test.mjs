import test from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import {signedInCookie} from './helpers/appSession.mjs';
import orders from '../netlify/functions/orders.mjs';
import {signExecutionRequest} from '../netlify/functions/execution.mjs';
const secret='only-test-key-'.repeat(4),owner='a'.repeat(64);
process.env.AWS_PAPER_SYNC_SECRET=secret;process.env.AWS_PAPER_SYNC_BASE='https://api.example.test';
const MAIN='https://optionsmentor.netlify.app';
const cookie=await signedInCookie();
test('unauthenticated, foreign-origin and raw broker routes are rejected before AWS', async()=>{
  const saved=global.fetch;global.fetch=()=>{throw Error('NETWORK_MUST_NOT_RUN');};
  const signedIn={origin:MAIN,cookie};
  try{
    for(const [path,init,status] of [
      ['/status',{},401],
      ['/submit',{method:'POST',headers:{origin:'https://evil.test',cookie},body:'{}'},403],
      ['/place-order',{method:'POST',headers:{origin:MAIN},body:'{}'},401],
      ['/place-order',{method:'POST',headers:signedIn,body:'{}'},404],
      ['/prepare',{method:'POST',headers:signedIn,body:JSON.stringify({intentId:'x',strategy:'CORE',qty:999})},400],
      ['/buy',{method:'POST',headers:signedIn,body:JSON.stringify({intentId:'x',strategy:'CORE',symbol:'x',quantity:1,maxPrice:1,tradeAmount:1,initialStop:1})},400],
      // Signed in to the app but not connected to FYERS.
      ['/status',{headers:signedIn},401]
    ])assert.equal((await orders(new Request(MAIN+'/api/orders'+path,init))).status,status,path);
  }finally{global.fetch=saved;}
});
test('a refusal passes on only a fixed reason code from the order server',async()=>{
  const {executionOwnerProof}=await import('../netlify/functions/execution.mjs');assert.ok(executionOwnerProof);
  const saved=global.fetch,old=[process.env.FYERS_SESSION_SECRET,process.env.FYERS_APP_ID];
  process.env.FYERS_SESSION_SECRET='only-test-session-secret';process.env.FYERS_APP_ID='TESTAPP-100';
  const iv=crypto.randomBytes(12),cipher=crypto.createCipheriv('aes-256-gcm',crypto.createHash('sha256').update('only-test-session-secret').digest(),iv);
  const sealed=Buffer.concat([cipher.update('fake_token_long_enough_for_tests'),cipher.final()]);
  const access=Buffer.concat([iv,cipher.getAuthTag(),sealed]).toString('base64url');
  const buy=()=>orders(new Request(MAIN+'/api/orders/buy',{method:'POST',headers:{origin:MAIN,cookie:cookie+'; iom_fyers_session='+access,'x-iom-action':'live-orders'},body:JSON.stringify({intentId:'x',strategy:'CORE',symbol:'x',quantity:1,maxPrice:1,tradeAmount:1})}));
  try{
    for(const [reason,expected] of [['PRICE_MOVED_REFRESH_PLAN','PRICE_MOVED_REFRESH_PLAN'],['private account text: 12345',undefined],[undefined,undefined]]){
      global.fetch=async url=>url.includes('/profile')?Response.json({s:'ok',data:{fy_id:'TESTOWNER'}}):Response.json({reason,secret:'never'},{status:409});
      const response=await buy();assert.equal(response.status,409);
      const body=await response.json();assert.equal(body.reason,expected);assert.equal(body.secret,undefined);
    }
  }finally{global.fetch=saved;['FYERS_SESSION_SECRET','FYERS_APP_ID'].forEach((k,i)=>old[i]===undefined?delete process.env[k]:process.env[k]=old[i]);}
});
test('signed deployment check reaches only status and never forwards credentials',async()=>{
  const body='{}',stamp=String(Math.floor(Date.now()/1000)),nonce=crypto.randomBytes(16).toString('hex'),path='/api/orders/maintenance-status';
  const saved=global.fetch;let calls=0;
  global.fetch=async(url,init)=>{
    calls++;assert.equal(url,'https://api.example.test/monitor/orders/status');assert.equal(init.headers.Authorization,undefined);
    assert.equal(init.headers['x-iom-owner'],owner);
    assert.equal(init.headers['x-iom-signature'],signExecutionRequest(secret,init.headers['x-iom-time'],init.headers['x-iom-nonce'],owner,'/monitor/orders/status',body));
    return Response.json({ok:true,mode:'OWNED_EXECUTION_HOST',realMoneyEnabled:false,actualLiveExecutionHostReleased:true});
  };
  try{
    const result=await orders(new Request('https://preview.test'+path,{method:'POST',body,headers:{'x-iom-time':stamp,'x-iom-nonce':nonce,'x-iom-owner':owner,'x-iom-signature':signExecutionRequest(secret,stamp,nonce,owner,path,body)}}));
    assert.equal(result.status,200);assert.equal((await result.json()).realMoneyEnabled,false);assert.equal(calls,1);
  }finally{global.fetch=saved;}
});
