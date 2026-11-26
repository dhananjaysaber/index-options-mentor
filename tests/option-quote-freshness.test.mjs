import test from 'node:test';
import assert from 'node:assert/strict';
import { freshOptionMark } from '../src/services/optionQuoteFreshness.js';
const now = Date.parse('2026-11-26T09:00:00.000Z');
const A = 'NSE:NIFTY26D0126000PE';
const B = 'NSE:NIFTY26D0126000CE';
function quote(age, extra={}) {
  return { at: new Date(now - age).toISOString(), optionSymbol:A, optionPrice:250,
    optionPrices:{[A]:250,[B]:100}, ...extra };
}
test('fresh matching option LTP is an estimate only', () => {
  assert.deepEqual(freshOptionMark(quote(1000), A, now),
    {price:250,at:now-1000,ageMs:1000,priceType:'LTP'});
  assert.equal(freshOptionMark(quote(1000), B, now)?.price,100);
});
test('stale, missing, zero and unrelated option quotes never produce displayed profit', () => {
  assert.equal(freshOptionMark(quote(5001), A, now),null);
  assert.equal(freshOptionMark(quote(1000), 'NSE:UNKNOWN',now),null);
  assert.equal(freshOptionMark(quote(1000,{optionPrices:{},optionPrice:null}), A,now),null);
  assert.equal(freshOptionMark(quote(1000,{optionPrices:{[A]:0}}), A,now),null);
  assert.equal(freshOptionMark(null, A,now),null);
});
test('future and malformed quote times fail closed', () => {
  assert.equal(freshOptionMark(quote(-5000), A,now),null);
  assert.equal(freshOptionMark({at:'invalid',optionSymbol:A,optionPrice:250}, A,now),null);
});
