import crypto from 'node:crypto';
import {decryptExecutionSession,signExecutionRequest,executionOwnerProof} from './execution.mjs';
const GITHUB='https://dhananjaysaber.github.io';
const reply=(status,data,origin='')=>Response.json(data,{status,headers:{'cache-control':'no-store',...(origin===GITHUB?{'access-control-allow-origin':origin,'access-control-allow-methods':'GET,POST,OPTIONS','access-control-allow-headers':'Authorization,Content-Type,X-IOM-Action',vary:'Origin'}:{})}});
export default async function orders(request){
  const url=new URL(request.url),origin=request.headers.get('origin')||'',action=url.pathname.split('/').filter(Boolean).at(-1);
  if(request.method==='OPTIONS')return origin===GITHUB?reply(200,{},origin):reply(403,{error:'ORIGIN_NOT_ALLOWED'});
  if(origin&&origin!==url.origin&&origin!==GITHUB)return reply(403,{error:'ORIGIN_NOT_ALLOWED'});
  if(!['status','settings','prepare','submit','exit','stop','maintenance-status'].includes(action))return reply(404,{error:'ORDER_ROUTE_NOT_ALLOWED'},origin);
  const maintenance=action==='maintenance-status';
  if(request.method!==(action==='status'?'GET':'POST'))return reply(405,{error:'METHOD_NOT_ALLOWED'},origin);
  const secret=process.env.AWS_PAPER_SYNC_SECRET||'',base=String(process.env.AWS_PAPER_SYNC_BASE||'').replace(/\/$/,'');
  if(secret.length<32||!/^https:\/\/[a-z0-9.-]+$/i.test(base))return reply(503,{error:'ORDER_CONNECTION_NOT_CONFIGURED'},origin);
  const body=action==='status'?'{}':await request.text();if(Buffer.byteLength(body)>4096)return reply(413,{error:'BODY_TOO_LARGE'},origin);
  let data;try{data=JSON.parse(body);}catch{return reply(400,{error:'INVALID_JSON'},origin);}
  const fields={status:[],settings:['settings'],prepare:['intentId','strategy'],submit:['intentId'],exit:['entryId'],stop:[],'maintenance-status':[]}[action];
  if(!data||typeof data!=='object'||Array.isArray(data)||Object.keys(data).sort().join(',')!==fields.sort().join(','))return reply(400,{error:'INVALID_ORDER_ACTION'},origin);
  let owner;
  if(maintenance){
    if(origin)return reply(403,{error:'SERVER_AUTHENTICATION_REQUIRED'});
    const stamp=request.headers.get('x-iom-time')||'',nonce=request.headers.get('x-iom-nonce')||'',principal=request.headers.get('x-iom-owner')||'',given=request.headers.get('x-iom-signature')||'';
    const expected=signExecutionRequest(secret,stamp,nonce,principal,'/api/orders/maintenance-status',body);
    if(!/^\d{10}$/.test(stamp)||Math.abs(Date.now()/1000-Number(stamp))>30||!/^[a-f0-9]{32}$/.test(nonce)||!/^[a-f0-9]{64}$/.test(principal)||!/^[a-f0-9]{64}$/.test(given)||!crypto.timingSafeEqual(Buffer.from(given),Buffer.from(expected)))return reply(403,{error:'SERVER_AUTHENTICATION_FAILED'});
    owner=principal;
  }else{
    const access=decryptExecutionSession(request);if(!access)return reply(401,{error:'FYERS_SESSION_REQUIRED'},origin);
    if(action!=='status'&&request.headers.get('x-iom-action')!=='live-orders')return reply(403,{error:'EXPLICIT_ORDER_ACTION_REQUIRED'},origin);
    try{owner=await executionOwnerProof(access,secret);}catch{return reply(503,{error:'FYERS_ACCOUNT_NOT_VERIFIED'},origin);}
  }
  const path='/monitor/orders/'+(maintenance?'status':action),stamp=String(Math.floor(Date.now()/1000)),nonce=crypto.randomBytes(16).toString('hex');
  try{
    const response=await fetch(base+path,{method:'POST',headers:{'content-type':'application/json','x-iom-time':stamp,'x-iom-nonce':nonce,'x-iom-owner':owner,'x-iom-signature':signExecutionRequest(secret,stamp,nonce,owner,path,body)},body,redirect:'error',signal:AbortSignal.timeout(25000),cache:'no-store'});
    const result=await response.json();
    if(!response.ok)return reply(response.status===403?403:409,{error:response.status===403?'ACCOUNT_DOES_NOT_MATCH_AWS':'ORDER_NOT_ACCEPTED_CHECK_STATUS'},origin);
    if(result.mode!=='OWNED_EXECUTION_HOST'||typeof result.realMoneyEnabled!=='boolean')return reply(503,{error:'UNVERIFIED_ORDER_HOST'},origin);
    return reply(200,result,origin);
  }catch{return reply(503,{error:'ORDER_SERVICE_UNAVAILABLE_CHECK_BROKER_BEFORE_RETRY'},origin);}
}
