import test from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import orders from '../netlify/functions/orders.mjs';
import {signExecutionRequest} from '../netlify/functions/execution.mjs';
const secret='only-test-key-'.repeat(4),owner='a'.repeat(64);
process.env.AWS_PAPER_SYNC_SECRET=secret;process.env.AWS_PAPER_SYNC_BASE='https://api.example.test';
test('unauthenticated, foreign-origin and raw broker routes are rejected before AWS', async()=>{
  const saved=global.fetch;global.fetch=()=>{throw Error('NETWORK_MUST_NOT_RUN');};
  try{
    for(const [url,init,status] of [
      ['https://preview.test/api/orders/status',{},401],
      ['https://preview.test/api/orders/submit',{method:'POST',headers:{origin:'https://evil.test'},body:'{}'},403],
      ['https://preview.test/api/orders/place-order',{method:'POST',body:'{}'},404],
      ['https://preview.test/api/orders/prepare',{method:'POST',body:JSON.stringify({intentId:'x',strategy:'CORE',qty:999})},400]
    ])assert.equal((await orders(new Request(url,init))).status,status);
  }finally{global.fetch=saved;}
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
