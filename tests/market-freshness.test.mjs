import test from 'node:test';
import assert from 'node:assert/strict';
import { assessMarketFreshness } from '../src/services/marketFreshness.js';
const now = Date.parse('2026-11-26T08:45:00.000Z');
const snapshot = age => ({ generatedAt: new Date(now-age).toISOString() });
const quote = (age, nifty=25785) => ({ at: new Date(now-age).toISOString(), nifty });
const check = (overrides={}) => assessMarketFreshness({
  snapshot:snapshot(300), quote:quote(300), authenticated:true, now, ...overrides
});
test('entries require both independently fresh feeds', () => {
  assert.equal(check().ready, true);
  assert.equal(check({snapshot:snapshot(12001)}).ready, false);
  assert.equal(check({quote:quote(5001)}).ready, false);
  assert.equal(check({snapshot:snapshot(12000),quote:quote(5000)}).ready, true);
});
test('HTTP success and cached chart never replace a missing fresh quote', () => {
  const result=check({quote:null});
  assert.equal(result.ready,false);
  assert.equal(result.label,'WAITING FOR FRESH NIFTY QUOTE');
  assert.equal(check({quote:quote(100,0)}).ready,false);
});
test('fresh index tick cannot authorise stale Mentor analysis', () => {
  const result=check({snapshot:snapshot(20000)});
  assert.equal(result.ready,false);
  assert.equal(result.label,'REFRESHING MENTOR ANALYSIS');
});
test('authentication failure, fetch errors and future-dated quotes fail closed', () => {
  assert.equal(check({authenticated:false}).ready,false);
  assert.equal(check({error:'network failure'}).ready,false);
  assert.equal(check({quote:quote(-6000)}).ready,false);
});
test('diagnosis distinguishes both missing from both fresh', () => {
  assert.equal(check({snapshot:null,quote:null}).label,'REFRESHING LIVE MARKET DATA');
  assert.equal(check().label,'LIVE MARKET DATA VERIFIED');
});
