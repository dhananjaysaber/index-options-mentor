import crypto from 'node:crypto';
import { createServer } from 'node:http';
import { fileURLToPath } from 'node:url';
import { resolve } from 'node:path';
import { AiPaperWorker } from './aiPaperWorker.mjs';
import { AiPaperStore } from './aiPaperStore.mjs';
import { constantEqual, issueAiSession, verifyAiSession } from './aiSessionAuth.mjs';

const WEB_ORIGIN='https://dhananjaysaber.github.io';
const WEB_PATH='/mentor-ai-paper-lab-pwa/';
const AUTH_BASE='https://api-t1.fyers.in/api/v3';
const failures=new Map();

function headers(req){
 const result={'Content-Type':'application/json; charset=utf-8','Cache-Control':'no-store, private','X-Content-Type-Options':'nosniff','Referrer-Policy':'no-referrer'};
 if(req.headers.origin===WEB_ORIGIN){
  result['Access-Control-Allow-Origin']=WEB_ORIGIN;
  result['Access-Control-Allow-Headers']='Content-Type, Authorization';
  result['Access-Control-Allow-Methods']='GET, POST, OPTIONS';
  result.Vary='Origin';
 }
 return result;
}
function respond(res,req,body,status=200){
 res.writeHead(status,headers(req));res.end(JSON.stringify(body));
}
function redirect(res,url){
 res.writeHead(302,{'Location':url,'Cache-Control':'no-store','Referrer-Policy':'no-referrer'});res.end();
}
async function readJson(req){
 let body='';
 for await(const chunk of req){
  body+=chunk.toString('utf8');
  if(body.length>15000)throw Error('Request too large');
 }
 return JSON.parse(body||'{}');
}
function isAuthenticated(req){
 const bearer=(req.headers.authorization||'').replace(/^Bearer\s+/i,'');
 return verifyAiSession(bearer).valid;
}
function safeReturnTo(value){
 try {const url=new URL(value);if(url.origin===WEB_ORIGIN&&url.pathname.startsWith(WEB_PATH))return url.toString()}catch{}
 return WEB_ORIGIN+WEB_PATH;
}
function mac(payload){
 return crypto.createHmac('sha256',process.env.FYERS_SESSION_SECRET||'').update(payload).digest('base64url');
}
function signState(data){
 const encoded=Buffer.from(JSON.stringify(data)).toString('base64url');
 return encoded+'.'+mac(encoded);
}
function verifyState(data){
 try{
  const [encoded,sig]=String(data).split('.');
  const expected=mac(encoded);
  if(sig?.length!==expected.length||!crypto.timingSafeEqual(Buffer.from(sig),Buffer.from(expected)))return null;
  const row=JSON.parse(Buffer.from(encoded,'base64url').toString('utf8'));
  if(!Number.isSafeInteger(row.at)||Date.now()-row.at>600000||row.at>Date.now()+60000)return null;
  return row;
 }catch{return null}
}
function oauthSettings(){
 const appId=process.env.FYERS_APP_ID, appSecret=process.env.FYERS_APP_SECRET,redirectUri=process.env.FYERS_REDIRECT_URI;
 if(!appId||!appSecret||!redirectUri||!process.env.FYERS_SESSION_SECRET)throw Error('FYERS OAuth credentials and public redirect URI must be configured.');
 if(!/^https:\/\//.test(redirectUri))throw Error('FYERS_REDIRECT_URI must be HTTPS.');
 return {appId,appSecret,redirectUri};
}
async function fyersExchange(code){
 const {appId,appSecret}=oauthSettings();
 const appIdHash=crypto.createHash('sha256').update(appId+':'+appSecret).digest('hex');
 const response=await fetch(AUTH_BASE+'/validate-authcode',{method:'POST',headers:{'Content-Type':'application/json'},
  body:JSON.stringify({grant_type:'authorization_code',appIdHash,code}),signal:AbortSignal.timeout(15000)});
 const data=await response.json();
 if(!response.ok||data?.s!=='ok'||!data.access_token)throw Error('FYERS rejected authentication.');
 return data.access_token;
}
function rateLimited(key){
 const row=failures.get(key);
 if(!row)return false;
 if(Date.now()-row.at>15*60*1000){failures.delete(key);return false}
 return row.attempts>=8;
}
function registerFailure(key){
 const old=failures.get(key);
 failures.set(key,{attempts:(old&&Date.now()-old.at<15*60*1000?old.attempts:0)+1,at:Date.now()});
}
function cleanFailures(key){failures.delete(key)}
function sanitizeError(err){return String(err?.message||'Operation failed').slice(0,250)}
export function startAiPaperService({port=Number(process.env.AI_PAPER_PORT)||8787,worker}={}){
 if(process.env.TRADING_MODE!=='paper'||process.env.LIVE_ORDER_EXECUTION_ENABLED!=='false')
  throw Error('Paper only: set TRADING_MODE=paper and LIVE_ORDER_EXECUTION_ENABLED=false.');
 const model=worker||new AiPaperWorker({store:new AiPaperStore(process.env.AI_PAPER_DB_PATH||'./var/mentor-ai-paper.sqlite')});
 const server=createServer(async(req,res)=>{
  const url=new URL(req.url||'/', 'http://localhost');
  if(req.method==='OPTIONS'){
   res.writeHead(204,headers(req));res.end();return;
  }
  const path=url.pathname;
  try{
   if(req.method==='GET'&&path==='/health'){
    respond(res,req,{ok:true,paperOnly:true,worker:'mentor-ai-paper',runtime:'standalone'});return;
   }
   if(req.method==='GET'&&path==='/api/fyers/callback'){
    const state=verifyState(url.searchParams.get('state'));
    const nonce=model.store.getSetting('oauth_nonce',null);
    if(!state||!nonce||state.nonce!==nonce){respond(res,req,{error:'FYERS login state invalid or expired'},401);return}
    // One-time login state to prevent unauthorised token replacement.
    model.store.putSetting('oauth_nonce',null);
    const code=url.searchParams.get('auth_code');
    if(!code){respond(res,req,{error:'FYERS did not return an authentication code'},400);return}
    const token=await fyersExchange(code);
    model.store.setBrokerToken(token);
    model.store.event('FYERS_CONNECTED',{source:'NON_TRADING_OAUTH'});
    const destination=new URL(safeReturnTo(state.returnTo));
    destination.searchParams.set('fyers','connected');
    redirect(res,destination.toString());return;
   }
   if(req.method==='POST'&&path==='/.netlify/functions/ai-session'){
    const body=await readJson(req);
    const remote=req.socket.remoteAddress||'unknown';
    if(body?.action==='login'){
     if(rateLimited(remote)){respond(res,req,{error:'Too many login attempts; try again later'},429);return}
     if(!constantEqual(body.password,process.env.MENTOR_AI_ACCESS_KEY||'')){
      registerFailure(remote);respond(res,req,{error:'Incorrect AI access password'},401);return;
     }
     cleanFailures(remote);
     const token=issueAiSession(body.remember===true);
     if(!token){respond(res,req,{error:'Secure access not configured'},503);return}
     respond(res,req,{ok:true,...token});return;
    }
    if(body?.action==='verify'){if(!isAuthenticated(req)){respond(res,req,{error:'Session expired'},401);return}respond(res,req,{ok:true});return}
    respond(res,req,{error:'Invalid session action'},400);return;
   }
   if(req.method==='GET'&&path==='/api/fyers/status'){
    respond(res,req,{configured:Boolean(process.env.FYERS_APP_ID&&process.env.FYERS_APP_SECRET&&process.env.FYERS_REDIRECT_URI),
     authenticated:Boolean(model.brokerToken),runtime:'autonomous-paper-worker'});return;
   }
   // Every market-data and trading-control endpoint requires signed owner session.
   if(!isAuthenticated(req)){respond(res,req,{error:'AI owner login required'},401);return}
   if(req.method==='POST'&&path==='/api/fyers/authorize'){
    const {appId,redirectUri}=oauthSettings();
    const nonce=crypto.randomBytes(28).toString('hex');
    model.store.putSetting('oauth_nonce',nonce);
    const state=signState({nonce,at:Date.now(),returnTo:safeReturnTo((await readJson(req))?.returnTo)});
    const destination=new URL(AUTH_BASE+'/generate-authcode');
    destination.searchParams.set('client_id',appId);
    destination.searchParams.set('redirect_uri',redirectUri);
    destination.searchParams.set('response_type','code');
    destination.searchParams.set('state',state);
    respond(res,req,{ok:true,url:destination.toString()});return;
   }
   if(req.method==='GET'&&path==='/api/fyers/quote'){
    const symbols=(url.searchParams.get('symbol')||'').split(',').slice(0,30).map(s=>s.trim()).filter(s=>/^NSE:[A-Z0-9-]{2,50}$/.test(s));
    if(!symbols.length){respond(res,req,{error:'No valid symbols'},400);return}
    const result=await model.fyersGet('/quotes',{symbols:symbols.join(',')});
    respond(res,req,result);return;
   }
   if(req.method==='GET'&&path==='/api/fyers/mentor-snapshot'){
    respond(res,req,await model.snapshot());return;
   }
   if(req.method==='GET'&&path==='/api/ai-paper/state'){
    respond(res,req,model.report());return;
   }
   if(req.method==='POST'&&path==='/api/ai-paper/control'){
    const body=await readJson(req);
    if(body.enabled===true && process.env.AI_WORKER_ENABLED!=='true'){
     respond(res,req,{error:'Server-side paper worker is disabled by AI_WORKER_ENABLED; connect an always-on host first.'},503);return;
    }
    if(typeof body.enabled==='boolean')model.setEnabled(body.enabled);
    const capital=Number(body.capital),riskPct=Number(body.riskPct);
    if(Number.isFinite(capital)&&Number.isFinite(riskPct))model.setConfig({capital,riskPct});
    respond(res,req,model.report());return;
   }
   if(req.method==='POST'&&(path==='/api/ai-paper/analyse'||path==='/.netlify/functions/ai-analyze')){
    const result=await model.analyseOnce({manual:true});
    if(result?.error)respond(res,req,{error:result.error},503);
    else respond(res,req,result);return;
   }
   respond(res,req,{error:'Unknown paper API route'},404);
  }catch(error){console.error('AI paper service:',sanitizeError(error));respond(res,req,{error:sanitizeError(error)},500)}
 });
 server.listen(port,process.env.AI_PAPER_HOST||'127.0.0.1',()=>{console.log('Mentor AI PAPER service listening on port '+port);model.start()});
 const close=()=>{model.stop();server.close(()=>model.store.close())};
 return {server,worker:model,close};
}
if(process.argv[1]&&resolve(process.argv[1])===fileURLToPath(import.meta.url)){
 startAiPaperService();
}
