import test from 'node:test';
import assert from 'node:assert/strict';
import { calculateTradeAmountSizing } from '../src/engine/tradeAmount.js';
import { buildSimulatedTicket, buildManualResearchTicket, calculateSimulationSizing } from '../src/engine/researchStrategy.js';
import { buildScalpTicket } from '../src/engine/scalpStrategy.js';

test('30000 at 230 with 65 units buys two lots for 29900', () => {
  assert.deepEqual(calculateTradeAmountSizing({ tradeAmount: 30000 }, 230, 65), {
    lots: 2, quantity: 130, premiumCost: 29900, tradeAmount: 30000, amountRemaining: 100
  });
});
test('amount sizing ignores saved legacy lot preferences and follows the contract lot size', () => {
  const settings = { tradeAmount: 30000, defaultLots: 20, lotCap: 1 };
  assert.equal(calculateTradeAmountSizing(settings, 230, 65).lots, 2);
  assert.equal(calculateTradeAmountSizing(settings, 230, 75).lots, 1);
});
test('insufficient budget and invalid quotes never force one lot', () => {
  for (const [amount, price, units] of [[100,230,65],[0,230,65],[-1,230,65],[30000,0,65],[30000,NaN,65],[30000,230,0]]) {
    assert.equal(calculateTradeAmountSizing({tradeAmount:amount},price,units).quantity,0);
  }
});
test('price increases reduce size and rounded premium stays within budget', () => {
  assert.equal(calculateTradeAmountSizing({tradeAmount:30000},231,65).lots,1);
  for(let price=0.05;price<500;price+=0.65) {
    const result=calculateTradeAmountSizing({tradeAmount:30000},price,65);
    assert.ok(result.premiumCost<=30000);
  }
});
test('Core risk calculations use the amount-derived quantity', () => {
  const result=calculateSimulationSizing({option:{ltp:230,lotSize:65,estimatedPremiumStop:220}},
    {tradeAmount:30000,capital:50000,riskPct:1});
  assert.equal(result.quantity,130);
  assert.equal(result.requiredRiskAmount,1300);
});
test('older engine callers remain compatible with lot settings', () => {
  assert.equal(calculateTradeAmountSizing({defaultLots:3,lotCap:5},100,65).quantity,195);
});
test('automatic and manual Scalp tickets both follow the amount setting', () => {
  const snapshot={option:{symbol:'NSE:NIFTY26NOV25450PE',ltp:230,lotSize:65},market:{spot:25000},parameters:[]};
  const evaluation={eligible:true,manualEligible:true,side:'PE',stop:25100,checks:[],spot:25000};
  for(const by of ['MENTOR','USER']) {
    const ticket=buildScalpTicket(snapshot,evaluation,{tradeAmount:30000},by,{lots:10});
    assert.equal(ticket.lots,2);
    assert.equal(ticket.quantity,130);
    assert.equal(ticket.premiumCost,29900);
    assert.equal(buildScalpTicket(snapshot,evaluation,{tradeAmount:100},by),null);
  }
});

test('Core automatic and manual tickets recalculate quantity at entry premium', () => {
  const symbol='NSE:NIFTY26NOV25450PE';
  const snapshot={live:true, option:{symbol,ltp:230,lotSize:65,optionType:'PE'},
    market:{spot:25000,phase:'LIVE'}, structure:{underlyingStop:25100,riskPoints:100,closeConfirmed:true},
    setup:{retestStatus:'HELD'},decision:{side:'PE',score:90,rr:1,canSuggestTrade:true,reasons:[]},
    parameters:Array.from({length:13},(_,i)=>({id:['risk','liquidity','chop','trend','vwap'][i] || `c${i}`,mandatory:i<5,gatePassed:true,status:'green'}))};
  const oldWindow=globalThis.window;
  try {
    for(const premium of [230,231,500]) {
      globalThis.window={__indexOptionsLiveQuote:{optionSymbol:symbol,optionPrice:premium,nifty:25000}};
      for(const ticket of [buildSimulatedTicket(snapshot,{tradeAmount:30000}),buildManualResearchTicket(snapshot,{tradeAmount:30000},{lots:10})]) {
        if(premium===500) { assert.equal(ticket,null); continue; }
        assert.equal(ticket.lots,premium===230?2:1);
        assert.equal(ticket.entry,premium);
        assert.ok(ticket.premiumCost<=30000);
      }
    }
  } finally { if(oldWindow===undefined) delete globalThis.window; else globalThis.window=oldWindow; }
});

test('Core BUY affordability follows live premium across the one-lot threshold', () => {
  const option={symbol:'NSE:NIFTY26NOV25450PE',ltp:231,lotSize:65};
  const quote={optionSymbol:option.symbol,optionPrice:230};
  assert.equal(calculateSimulationSizing({option},{tradeAmount:15000},quote).lots,1);
  assert.equal(calculateSimulationSizing({option:{...option,ltp:230}},{tradeAmount:15000},{...quote,optionPrice:231}).lots,0);
  assert.equal(calculateSimulationSizing({option},{tradeAmount:15000},{...quote,optionSymbol:'other'}).lots,0);
});
