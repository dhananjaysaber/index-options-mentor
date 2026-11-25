import test from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { mkdtemp,rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import execution from '../netlify/functions/execution.mjs';
const BASE='https://deploy-preview-28--optionsmentor.netlify.app';
const SECRET='test-only-bridge-'.repeat(4), SESSION='test-only-session-secret', APP='TESTAPP-100', OWNER='TESTOWNER';
const proof=crypto.createHmac('sha256',SECRET).update('FYERS_OWNER_V1:'+OWNER).digest('hex');
function session(){const iv=crypto.randomBytes(12),cipher=crypto.createCipheriv('aes-256-gcm',crypto.createHash('sha256').update(SESSION).digest(),iv);const data=Buffer.concat([cipher.update('long_fake_token_'+crypto.randomUUID()),cipher.final()]);return Buffer.concat([iv,cipher.getAuthTag(),data]).toString('base64url');}
function request(action,{token=session(),body={checkId:crypto.randomUUID()},origin=BASE}={}){return new Request(BASE+'/api/execution/'+action,{method:action==='status'?'GET':'POST',headers:{origin,'x-iom-action':'execution-check',authorization:'Bearer '+token,'content-type':'application/json'},...(action==='status'?{}:{body:JSON.stringify(body)})});}
async function env(run){const names=['FYERS_SESSION_SECRET','FYERS_APP_ID','AWS_PAPER_SYNC_SECRET','AWS_PAPER_SYNC_BASE'];const old=names.map(k=>process.env[k]);Object.assign(process.env,{FYERS_SESSION_SECRET:SESSION,FYERS_APP_ID:APP,AWS_PAPER_SYNC_SECRET:SECRET,AWS_PAPER_SYNC_BASE:'https://fake-api.example'});try{return await run();}finally{names.forEach((k,i)=>old[i]===undefined?delete process.env[k]:process.env[k]=old[i]);}}
function response(data,status=200){return Response.json(data,{status});}
test('rejects missing authentication, foreign origins and all real order routes',()=>env(async()=>{
  assert.equal((await execution(request('check',{token:''}))).status,401);
  assert.equal((await execution(request('check',{origin:'https://evil.example'}))).status,403);
  assert.equal((await execution(request('submit'))).status,404);
  assert.equal((await execution(request('prepare'))).status,404);
}));
test('never forwards a token to AWS and verifies signed owner',()=>env(async()=>{
  const original=globalThis.fetch,calls=[];
  globalThis.fetch=async(url,init)=>{calls.push(url);if(url.includes('/profile'))return response({s:'ok',data:{fy_id:OWNER}});
    assert.equal(init.headers['x-iom-owner'],proof);assert.equal(init.headers.Authorization,undefined);
    const path=new URL(url).pathname;const expected=crypto.createHmac('sha256',SECRET).update(['v1',init.headers['x-iom-time'],init.headers['x-iom-nonce'],proof,'POST',path,crypto.createHash('sha256').update(init.body).digest('hex')].join('\n')).digest('hex');assert.equal(init.headers['x-iom-signature'],expected);
    return response({ok:true,mode:'DIAGNOSTICS_ONLY',realMoneyEnabled:false});};
  try{assert.equal((await execution(request('status'))).status,200);assert.equal(calls.length,2);}finally{globalThis.fetch=original;}
}));
test('unsafe backend status and wrong AWS owner fail closed',()=>env(async()=>{
  const original=globalThis.fetch;
  globalThis.fetch=async(url)=>url.includes('/profile')?response({s:'ok',data:{fy_id:OWNER}}):response({mode:'LIVE',realMoneyEnabled:true});
  try{assert.equal((await execution(request('status'))).status,503);
    globalThis.fetch=async(url)=>url.includes('/profile')?response({s:'ok',data:{fy_id:OWNER}}):response({error:'NO'},403);
    assert.equal((await execution(request('status'))).status,403);
  }finally{globalThis.fetch=original;}
}));
