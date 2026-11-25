// Authenticated diagnostics only. Real-order routes cannot be enabled with env flags.
import crypto from 'node:crypto';
const SESSION_COOKIE='iom_fyers_session';
const GITHUB='https://dhananjaysaber.github.io';
const profiles=new Map();
const reply=(status,data,origin='')=>Response.json(data,{status,headers:{'cache-control':'no-store',...(origin===GITHUB?{'access-control-allow-origin':origin,'access-control-allow-methods':'GET,POST,OPTIONS','access-control-allow-headers':'Authorization,Content-Type,X-IOM-Action',vary:'Origin'}:{})}});
function token(request){
  const secret=process.env.FYERS_SESSION_SECRET;
  if(!secret)return '';
  const bearer=request.headers.get('authorization')?.match(/^Bearer\s+(.+)$/i)?.[1];
  const cookie=(request.headers.get('cookie')||'').split(';').map(x=>x.trim()).find(x=>x.startsWith(SESSION_COOKIE+'='))?.slice(SESSION_COOKIE.length+1);
  try{
    const value=bearer||decodeURIComponent(cookie||'');if(!value||value.length>8192)return '';
    const raw=Buffer.from(value,'base64url');if(raw.length<29)return '';
    const decipher=crypto.createDecipheriv('aes-256-gcm',crypto.createHash('sha256').update(secret).digest(),raw.subarray(0,12));
    decipher.setAuthTag(raw.subarray(12,28));return Buffer.concat([decipher.update(raw.subarray(28)),decipher.final()]).toString();
  }catch{return '';}
}
function signed(secret,time,nonce,owner,path,body){
  return crypto.createHmac('sha256',secret).update(['v1',time,nonce,owner,'POST',path,crypto.createHash('sha256').update(body).digest('hex')].join('\n')).digest('hex');
}
async function proof(access,secret){
  const app=process.env.FYERS_APP_ID;if(!app)throw Error('PROFILE_UNAVAILABLE');
  const key=crypto.createHash('sha256').update(app+':'+access).digest('hex');
  const cached=profiles.get(key);if(cached?.until>Date.now())return cached.owner;
  const response=await fetch('https://api-t1.fyers.in/api/v3/profile',{headers:{Authorization:app+':'+access,Accept:'application/json','User-Agent':'Mozilla/5.0 (compatible; IndexOptionsMentor/1.0)'},redirect:'error',cache:'no-store',signal:AbortSignal.timeout(6000)});
  if(!response.ok)throw Error('PROFILE_UNAVAILABLE');
  const value=await response.json();const id=value?.s==='ok'&&typeof value?.data?.fy_id==='string'?value.data.fy_id.trim():'';
  if(!id||id.length>128)throw Error('PROFILE_UNVERIFIED');
  const owner=crypto.createHmac('sha256',secret).update('FYERS_OWNER_V1:'+id).digest('hex');
  if(profiles.size>=64)profiles.clear();profiles.set(key,{owner,until:Date.now()+60000});return owner;
}
export default async function execution(request){
  const url=new URL(request.url),origin=request.headers.get('origin')||'';
  if(request.method==='OPTIONS')return origin===GITHUB?reply(200,{},origin):reply(403,{error:'ORIGIN_NOT_ALLOWED'});
  if(origin&&origin!==url.origin&&origin!==GITHUB)return reply(403,{error:'ORIGIN_NOT_ALLOWED'});
  const action=url.pathname.split('/').filter(Boolean).at(-1);
  const maintenance=action==='maintenance';
  if(!['status','check','maintenance'].includes(action))return reply(404,{error:'REAL_ORDER_ROUTE_DISABLED'},origin);
  if((action==='status'&&request.method!=='GET')||(action!=='status'&&request.method!=='POST'))return reply(405,{error:'METHOD_NOT_ALLOWED'},origin);
  const secret=process.env.AWS_PAPER_SYNC_SECRET||'',base=String(process.env.AWS_PAPER_SYNC_BASE||'').replace(/\/$/,'');
  if(secret.length<32||!/^https:\/\/[a-z0-9.-]+$/i.test(base))return reply(503,{error:'EXECUTION_CONNECTION_NOT_CONFIGURED'},origin);
  let body=action==='status'?'{}':await request.text();if(Buffer.byteLength(body)>1024)return reply(413,{error:'BODY_TOO_LARGE'},origin);
  let payload;try{payload=JSON.parse(body);}catch{return reply(400,{error:'INVALID_JSON'},origin);}
  if(!payload||typeof payload!=='object'||Array.isArray(payload)||(action==='status'?Object.keys(payload).length!==0:Object.keys(payload).length!==1||!/^[a-f0-9-]{36}$/i.test(payload.checkId||'')))return reply(400,{error:'INVALID_EXECUTION_CHECK'},origin);
  let owner,time=String(Math.floor(Date.now()/1000)),nonce=crypto.randomBytes(16).toString('hex');
  if(maintenance){
    if(origin)return reply(403,{error:'SERVER_AUTHENTICATION_REQUIRED'});
    owner=request.headers.get('x-iom-owner')||'';time=request.headers.get('x-iom-time')||'';nonce=request.headers.get('x-iom-nonce')||'';
    const supplied=request.headers.get('x-iom-signature')||'';
    const expected=signed(secret,time,nonce,owner,'/api/execution/maintenance',body);
    if(!/^[a-f0-9]{64}$/.test(owner)||!/^\d{10}$/.test(time)||Math.abs(Date.now()/1000-Number(time))>30||!/^[a-f0-9]{32}$/.test(nonce)||!/^[a-f0-9]{64}$/.test(supplied)||supplied.length!==expected.length||!crypto.timingSafeEqual(Buffer.from(supplied),Buffer.from(expected)))return reply(403,{error:'SERVER_AUTHENTICATION_FAILED'});
  }else{
    const access=token(request);if(!access)return reply(401,{error:'FYERS_SESSION_REQUIRED'},origin);
    if(action==='check'&&request.headers.get('x-iom-action')!=='execution-check')return reply(403,{error:'EXPLICIT_CHECK_REQUIRED'},origin);
    try{owner=await proof(access,secret);}catch{return reply(503,{error:'FYERS_ACCOUNT_NOT_VERIFIED'},origin);}
  }
  const path='/monitor/live/'+(action==='status'?'status':'check');
  try{
    const response=await fetch(base+path,{method:'POST',headers:{'content-type':'application/json','x-iom-time':time,'x-iom-nonce':nonce,'x-iom-owner':owner,'x-iom-signature':signed(secret,time,nonce,owner,path,body)},body,signal:AbortSignal.timeout(20000),redirect:'error',cache:'no-store'});
    const data=await response.json();
    if(!response.ok)return reply(response.status===403?403:503,{error:response.status===403?'FYERS_ACCOUNT_NOT_EXECUTION_OWNER':'AWS_EXECUTION_CHECK_UNAVAILABLE',realMoneyEnabled:false},origin);
    if(data.realMoneyEnabled!==false||!['DIAGNOSTICS_ONLY','SIMULATED_EXECUTION_CHECK'].includes(data.mode))return reply(503,{error:'UNSAFE_EXECUTION_STATUS'},origin);
    return reply(200,data,origin);
  }catch{return reply(503,{error:'AWS_EXECUTION_CHECK_UNAVAILABLE',realMoneyEnabled:false},origin);}
}
