import test from 'node:test';
import assert from 'node:assert/strict';
import { prepareStockPaperTicket } from '../server/stockPaperTicket.mjs';
import { calculateStockPaperExit } from '../src/services/stockPaperAutomation.js';

const now = Date.parse('2026-11-18T08:30:00Z'); // 14:00 IST
const expiry = Math.floor(Date.parse('2026-11-26T10:00:00Z') / 1000);
const option = 'NSE:EXIDEIND26NOV390CE';
const master = {[option]: {optType:'CE', tradeStatus:1, minLotSize:100}};

function paperPosition(overrides = {}) {
  return {
    id:'stock-paper-test', strategyFamily:'STOCK_SCALP', side:'CE',
    openedAt:new Date(now).toISOString(), underlyingEntry:389,
    underlyingStop:386.083, underlyingTarget:397.751, entry:12,
    quantity:100, bestR:0, maxHoldMinutes:12, ...overrides
  };
}

test('Stock automatic paper stop, target, trailing and time exits', () => {
  assert.equal(calculateStockPaperExit(paperPosition(), 385.5, now + 60000).reasonCode, 'STOCK_STOP');
  assert.equal(calculateStockPaperExit(paperPosition(), 399, now + 60000).reasonCode, 'STOCK_TARGET');
  assert.equal(calculateStockPaperExit(paperPosition({bestR:1.5}), 390.2, now + 90000).reasonCode, 'STOCK_TRAILING_STOP');
  assert.equal(calculateStockPaperExit(paperPosition(), 389, now + 13 * 60000).reasonCode, 'STOCK_TIME_LIMIT');
  assert.equal(calculateStockPaperExit(paperPosition(), 389.5, now + 60000).reasonCode, null);
});

test('PE stop, target and trailing invert the underlying direction', () => {
  const position = paperPosition({ side:'PE', underlyingStop:392, underlyingTarget:380 });
  assert.equal(calculateStockPaperExit(position, 393, now + 60000).reasonCode, 'STOCK_STOP');
  assert.equal(calculateStockPaperExit(position, 379, now + 60000).reasonCode, 'STOCK_TARGET');
  assert.equal(calculateStockPaperExit({...position,bestR:1.2}, 388.9, now + 60000).reasonCode, 'STOCK_TRAILING_STOP');
});

test('Stock automatic position cannot close with no valid underlying quote', () => {
  assert.equal(calculateStockPaperExit(paperPosition(), null, now + 20 * 60000), null);
  assert.equal(calculateStockPaperExit(paperPosition(), 0, now + 20 * 60000), null);
});

test('Manual Stock research validates real FYERS option contract, depth, lot and delta', async () => {
  let chains = 0, depthReads = 0;
  const get = async (path, params) => {
    if (path === '/options-chain-v3') {
      chains++;
      assert.equal(params.symbol,'NSE:EXIDEIND-EQ');
      return {data:{expiryData:[{expiry}],optionsChain:[
        {option_type:'CE',symbol:option,strike_price:390,greeks:{delta:.55}}
      ]}};
    }
    if (path === '/quotes') {
      return {d:params.symbols.split(',').map(symbol=>({
        n:symbol,s:'ok',v:{lp:symbol === option ? 12 : 389,
          bid:symbol === option ? 11.75 : 0,ask:symbol === option ? 12.25 : 0}
      }))};
    }
    if (path === '/depth') {
      depthReads++;
      return {d:{[option]:{bids:[{price:11.75,volume:500}],ask:[{price:12.25,volume:500}]}}};
    }
    throw Error('Unexpected broker endpoint: '+path);
  };
  const ticket=await prepareStockPaperTicket(get,{stock:'EXIDEIND',side:'CE'},now,{master});
  assert.equal(ticket.strictEligible,false,'Manual research cannot masquerade as auto-qualified');
  assert.equal(ticket.symbol,option);
  assert.equal(ticket.lotSize,100);
  assert.ok(ticket.stop < ticket.spot && ticket.target > ticket.spot);
  assert.ok(ticket.validUntil > Date.now());
  assert.equal(chains,1);
  assert.equal(depthReads,1);
});

test('Manual research never invents an option from a missing exchange master', async () => {
  const get = async (path, params) => {
    if (path === '/options-chain-v3') return {data:{expiryData:[{expiry}],optionsChain:[
      {option_type:'CE',symbol:option,strike_price:390,greeks:{delta:.55}}
    ]}};
    if (path === '/quotes') return {d:params.symbols.split(',').map(symbol=>({
      n:symbol,s:'ok',v:{lp:389}
    }))};
    throw Error('Depth must not be requested for unverified option');
  };
  const ticket = await prepareStockPaperTicket(get,{stock:'EXIDEIND',side:'CE'},now,{master:{}});
  assert.match(ticket.error,/verified lot size/i);
});

test('Stock paper contract request is disabled outside NSE hours', async () => {
  const result = await prepareStockPaperTicket(async()=>{throw Error('Unexpected live broker request');},
    {stock:'EXIDEIND',side:'CE'},Date.parse('2026-11-18T12:30:00Z'),{master});
  assert.equal(result.status,409);
});
