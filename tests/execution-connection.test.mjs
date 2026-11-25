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
test('deployed handler protocol reaches real HTTP host, shared engines, journal and replay cache',()=>env(async()=>{
  const directory=await mkdtemp(join(tmpdir(),'iom-connection-'));
  const source=`import sys\nsys.path.insert(0,'aws/live')\nfrom diagnostic_host import Checks,make_diagnostic_server\nc=Checks(sys.argv[1],sys.argv[2],sys.argv[3])\ns=make_diagnostic_server(c)\nprint(s.server_port,flush=True)\ns.serve_forever()\n`;
  const child=spawn('python3',['-c',source,join(directory,'checks.sqlite3'),proof,SECRET],{cwd:process.cwd(),stdio:['ignore','pipe','pipe']});
  let stderr='';child.stderr.on('data',x=>stderr+=x);
  const port=await new Promise((resolve,reject)=>{let output='';const timer=setTimeout(()=>reject(Error('Host startup timeout: '+stderr)),5000);child.stdout.on('data',chunk=>{output+=chunk;if(output.includes('\n')){clearTimeout(timer);resolve(Number(output.trim()));}});child.once('exit',code=>{clearTimeout(timer);reject(Error('Host exited '+code+': '+stderr));});});
  const original=globalThis.fetch;globalThis.fetch=async(url,init)=>url.includes('/profile')?response({s:'ok',data:{fy_id:OWNER}}):original('http://127.0.0.1:'+port+new URL(url).pathname,init);
  try{
    const body={checkId:crypto.randomUUID()};
    const first=await execution(request('check',{body}));assert.equal(first.status,200,stderr);const data=await first.json();
    assert.equal(data.brokerNetworkRequests,0);assert.equal(data.productionJournalTouched,false);assert.equal(data.realMoneyEnabled,false);
    assert.equal(data.checks.length,2);assert.ok(data.checks.every(x=>x.passed&&x.journalRows===1&&x.replayCreatedOrders===0));
    const replay=await execution(request('check',{body}));assert.deepEqual(await replay.json(),data);
    const status=await execution(request('status'));assert.equal((await status.json()).connection,'CONNECTED');
    const stamp=String(Math.floor(Date.now()/1000)),nonce=crypto.randomBytes(16).toString('hex'),raw=JSON.stringify({checkId:crypto.randomUUID()}),path='/api/execution/maintenance';
    const sign=crypto.createHmac('sha256',SECRET).update(['v1',stamp,nonce,proof,'POST',path,crypto.createHash('sha256').update(raw).digest('hex')].join('\n')).digest('hex');
    const serverRequest=()=>new Request(BASE+path,{method:'POST',headers:{'x-iom-time':stamp,'x-iom-nonce':nonce,'x-iom-owner':proof,'x-iom-signature':sign},body:raw});
    assert.equal((await execution(serverRequest())).status,200);
    assert.equal((await execution(serverRequest())).status,403);
  }finally{globalThis.fetch=original;child.kill('SIGTERM');await once(child,'exit');await rm(directory,{recursive:true,force:true});}
}));
