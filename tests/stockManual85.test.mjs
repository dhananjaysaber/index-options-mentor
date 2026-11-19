import test from 'node:test';
import assert from 'node:assert/strict';
import { prepareManualStockPaperTicket } from '../server/stockManual85.mjs';
const now = Date.parse('2026-11-18T08:30:00Z');
const expiration = Math.floor(Date.parse('2026-11-26T10:00:00Z')/1000);
const option = 'NSE:EXIDEIND26NOV130CE';
const master = {
  [option]: { minLotSize: 100, optType: 'CE', tradeStatus: 1, expiryDate: expiration }
};
function candles(direction, frequency) {
  if (frequency === '1W') {
    const origin = Date.parse('2026-09-21T03:45:00Z') / 1000;
    return Array.from({length: 8},(_,i)=>{
      const close = 90 + direction*i*3;
      return [origin+i*7*86400, close-1,close+2,close-2,close,1200+i*150];
    });
  }
  const origin = Date.parse('2026-10-25T03:45:00Z')/1000;
  return Array.from({length: 14},(_,i)=>{
    const close = 100+direction*i*2;
    return [origin+i*86400,close-1,close+2,close-2,close,900+i*150];
  });
}
function fakeBroker({aligned=true,live=true,missingDepth=false}={}) {
  const called = [];
  const get = async (path, params)=>{
    called.push(path);
    if(path==='/history')return {candles:candles(aligned?1:0,params.resolution)};
    if(path==='/options-chain-v3'){
      if(!live)throw new Error('No option quotes should be requested for low-score WATCH');
      return {data:{expiryData:[{expiry:expiration}],optionsChain:[
        {option_type:'CE',symbol:option,strike_price:130,greeks:{delta:0.5}}
      ]}};
    }
    if(path==='/quotes')return {d:params.symbols.split(',').map(symbol=>({
      n:symbol,s:'ok',v:{lp:symbol===option?11.5:130,bid:11.2,ask:11.6,chp:1.5}
    }))};
    if(path==='/depth')return {d:{[option]:{bids:[{price:11.2,volume:500}],
      asks:missingDepth?[]:[{price:11.6,volume:500}]}}};
    throw new Error('Unexpected request '+path);
  };
  return {get,called};
}

test('85+ verified weekly/daily aligned WATCH can prepare a manual paper ticket', async()=>{
  const {get,called}=fakeBroker();
  const result=await prepareManualStockPaperTicket(get,'manual85-qualified',
    {stock:'EXIDEIND',side:'CE',score:3},now,{master});
  assert.ok(!result.error,result.error);
  assert.equal(result.status,'MANUAL_RESEARCH');
  assert.equal(result.manualOverride,true);
  assert.equal(result.strictEligible,false);
  assert.ok(result.score>=85);
  assert.equal(result.weekBias,'BULLISH');
  assert.equal(result.dayBias,'BULLISH');
  assert.equal(result.symbol,option);
  assert.equal(result.lotSize,100);
  assert.ok(result.stop<result.spot && result.target>result.spot);
  assert.ok(result.validUntil>Date.now());
  assert.ok(called.includes('/options-chain-v3'));
  assert.ok(called.includes('/depth'));
});

test('low score or unaligned weekly daily never prepares an option paper entry',async()=>{
  const {get,called}=fakeBroker({aligned:false,live:false});
  const result=await prepareManualStockPaperTicket(get,'manual85-notqualified',
    {stock:'EXIDEIND',side:'CE',score:95},now,{master});
  assert.match(result.error,/score of at least 85/i);
  assert.ok(!called.includes('/options-chain-v3'));
  assert.ok(!called.includes('/depth'));
});

test('invalid FYERS option depth must not create a manual ticket',async()=>{
  const {get}=fakeBroker({missingDepth:true});
  const result=await prepareManualStockPaperTicket(get,'manual85-bad-depth',
    {stock:'EXIDEIND',side:'CE'},now,{master});
  assert.match(result.error,/bid\/ask prices|depth/i);
});

test('no manual Stock ticket outside market hours or for unsupported stock',async()=>{
  const forbidden=async()=>{throw Error('Should make zero broker requests');};
  const after=await prepareManualStockPaperTicket(forbidden,'manual85-closed',
    {stock:'EXIDEIND',side:'CE'},Date.parse('2026-11-18T12:30:00Z'),{master});
  assert.equal(after.status,409);
  const invalid=await prepareManualStockPaperTicket(forbidden,'manual85-unknown',
    {stock:'FAKESTOCK',side:'CE'},now,{master});
  assert.equal(invalid.status,400);
});


import { createStockWatchGrant, verifyStockWatchGrant } from '../server/stockWatchGrant.mjs';
import { explainStockPaperEligibility } from '../src/engine/stockRanking.js';

const signedWatch = {
  stock: 'EXIDEIND', status: 'WATCH', side: 'CE', score: 93,
  weekBias: 'BULLISH', dayBias: 'BULLISH',
  reason: 'Weekly and daily bullish', spot: 130
};
const watchKey = 'test-secret-only';
const watchScope = 'fyers-session-hash-test';

test('signed 93/100 WATCH proof is valid for this FYERS session and three minutes only', () => {
  const grant = createStockWatchGrant(signedWatch, watchScope, watchKey, now);
  assert.ok(grant);
  const verified = verifyStockWatchGrant(grant, watchScope, watchKey, now + 25000);
  assert.equal(verified.score, 93);
  assert.equal(verified.stock, 'EXIDEIND');
  assert.equal(verified.side, 'CE');
  assert.equal(verifyStockWatchGrant(grant, 'another-account', watchKey, now + 500), null);
  assert.equal(verifyStockWatchGrant(grant, watchScope, 'wrong-secret', now + 500), null);
  assert.equal(verifyStockWatchGrant(grant, watchScope, watchKey, now + 181000), null);
  const [body, sig] = grant.split('.');
  const forged = Buffer.from(JSON.stringify({ ...signedWatch, version: 1,
    scope: watchScope, score: 100, issuedAt: now, expiresAt: now + 180000 })).toString('base64url');
  assert.equal(verifyStockWatchGrant(forged + '.' + sig, watchScope, watchKey, now), null,
    'User must not be able to raise the score or change the contract direction');
});

test('mixed, under-85 and inconsistent-direction watches cannot receive signed grants', () => {
  assert.equal(createStockWatchGrant({ ...signedWatch, score: 84 }, watchScope, watchKey, now), null);
  assert.equal(createStockWatchGrant({ ...signedWatch, side: 'PE' }, watchScope, watchKey, now), null,
    'PE with bullish weekly/daily structure must not pass');
  assert.equal(createStockWatchGrant({ ...signedWatch, dayBias: 'BEARISH' }, watchScope, watchKey, now), null);
});

test('signed WATCH allows contract verification without downloading weekly/daily history AGAIN', async () => {
  const { get, called } = fakeBroker();
  const proof = createStockWatchGrant(signedWatch, watchScope, watchKey, now);
  const checked = verifyStockWatchGrant(proof, watchScope, watchKey, now + 1000);
  const ticket = await prepareManualStockPaperTicket(get, watchScope,
    { stock: 'EXIDEIND', side: 'CE' }, now, {
      validatedWatch: checked, requireGrant: true, master
    });
  assert.ok(!ticket.error, ticket.error);
  assert.equal(ticket.score, 93);
  assert.equal(ticket.manualOverride, true);
  assert.equal(ticket.strictEligible, false);
  assert.equal(called.filter(path => path === '/history').length, 0,
    'Manual button should not refetch 1D/1W candles');
  assert.equal(called.filter(path => path === '/options-chain-v3').length, 1);
  assert.ok(ticket.validUntil >= Date.now() + 110000,
    'Give time for informed paper ticket review; still reprice at paper entry');
});

test('missing or expired signed grant fails fast without any FYERS calls', async () => {
  let calls = 0;
  const get = async () => { calls++; throw Error('Should not call broker'); };
  const denied = await prepareManualStockPaperTicket(get,watchScope,
    { stock: 'EXIDEIND', side: 'CE' }, now,
    { requireGrant: true, validatedWatch: null });
  assert.equal(denied.status, 409);
  assert.match(denied.error, /expired/i);
  assert.equal(calls, 0);
});

test('Stock paper risk explanations show exact reasons before allowing a manual entry', () => {
  const candidate = {
    stock: 'EXIDEIND', side: 'CE', validUntil: Date.now() + 120000,
    spot: 130, stop: 129, target: 140, lotSize: 100, delta: 0.5,
    bid: 11, ask: 11.1, bidSize: 400, askSize: 400
  };
  const settings = { defaultLots: 1, capital: 50000, riskPct: 1, lotCap: 5 };
  assert.equal(explainStockPaperEligibility(candidate,settings).eligible, true);
  const budgetFail = explainStockPaperEligibility(candidate,
    { ...settings, riskPct: 0.1 });
  assert.equal(budgetFail.eligible,false);
  assert.ok(budgetFail.reasons.some(x => /risk budget/i.test(x)));
  const depthFail = explainStockPaperEligibility({ ...candidate, askSize: 0 },settings);
  assert.ok(depthFail.reasons.some(x => /depth/i.test(x)));
  const expired = explainStockPaperEligibility({ ...candidate, validUntil: Date.now() - 5 },settings);
  assert.ok(expired.reasons.some(x => /expired/i.test(x)));
});
