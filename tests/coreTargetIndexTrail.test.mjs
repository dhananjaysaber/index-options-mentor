import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import {
  computeCoreTargetIndexTrail,
  isFreshCoreIndexTargetQuotes,
  isCoreTargetIndexTrailBreached
} from '../src/engine/coreTargetIndexTrail.js';

// The actual 20 Nov 2026 13-Point CE plan displayed by the PWA.
const entry = 25550.90;
const hardStop = 25473.78;
const target = 25628.72;
const risk = entry - hardStop;
const targetR = (target - entry) / risk;
const candidate = bestR => computeCoreTargetIndexTrail({
  side: 'CE', underlyingEntry: entry, underlyingStop: hardStop,
  underlyingTarget: target, bestR
});

test('the original target is NOT a forced exit or instantly armed stop', () => {
  const atTarget = candidate(targetR);
  assert.equal(atTarget.active, false);
  assert.equal(atTarget.floorNifty, null);
  assert.equal(candidate(targetR + .249).active, false);
  assert.ok(Math.abs(atTarget.armAtNifty - (target + .25 * risk)) < 0.001);
});

test('after +0.25R beyond target the stop starts exactly at target', () => {
  const armed = candidate(targetR + .25);
  assert.equal(armed.active, true);
  assert.ok(Math.abs(armed.floorNifty - target) < .001);
  assert.ok(armed.floorNifty > hardStop);
});

test('20 Nov observed NIFTY high trails about 0.50R below peak; 3:05 value still holds', () => {
  const highR = (25808.80 - entry) / risk;
  const trail = candidate(highR);
  assert.equal(trail.active, true);
  assert.ok(trail.floorNifty > target);
  assert.ok(Math.abs(trail.floorNifty - (25808.8 - .5 * risk)) < .001);
  const now = Date.parse('2026-11-20T09:35:00.000Z');
  const position = {
    strategyFamily: 'CORE', side: 'CE', quantity: 650, currentPrice: 300,
    underlyingCurrent: 25797.90, coreTargetIndexTrailActive: true,
    coreTargetIndexTrailStop: trail.floorNifty,
    lastUnderlyingQuoteAt: new Date(now - 1000).toISOString(),
    lastOptionQuoteAt: new Date(now - 1000).toISOString()
  };
  assert.equal(isCoreTargetIndexTrailBreached(position, now), false,
    'The strong real runner would still be held above the new NIFTY stop');
  assert.equal(isCoreTargetIndexTrailBreached({...position, underlyingCurrent: 25760}, now), true);
});

test('the trailing stop never moves backwards after a pullback', () => {
  const high = candidate((25808.8 - entry) / risk);
  const afterPullback = computeCoreTargetIndexTrail({
    side: 'CE', underlyingEntry: entry, underlyingStop: hardStop,
    underlyingTarget: target, bestR: targetR + .15,
    previousFloorNifty: high.floorNifty
  });
  assert.equal(afterPullback.floorNifty, high.floorNifty);
});

test('puts use a falling NIFTY target and a stop above price', () => {
  const put = {
    side: 'PE', underlyingEntry: 25600, underlyingStop: 25670,
    underlyingTarget: 25530
  };
  const atTarget = computeCoreTargetIndexTrail({...put, bestR: 1.0});
  assert.equal(atTarget.active, false);
  const armed = computeCoreTargetIndexTrail({...put, bestR: 1.25});
  assert.equal(armed.floorNifty, 25530);
  const lower = computeCoreTargetIndexTrail({...put, bestR: 2.5, previousFloorNifty: 25530});
  assert.ok(Math.abs(lower.floorNifty - 25460) < 0.001);
  const now = Date.parse('2026-11-20T06:00:00Z');
  const data = {
    strategyFamily: 'CORE', side: 'PE',
    coreTargetIndexTrailActive: true, coreTargetIndexTrailStop: lower.floorNifty,
    currentPrice: 120, quantity: 65,
    underlyingCurrent: 25440,
    lastUnderlyingQuoteAt: new Date(now - 1200).toISOString(),
    lastOptionQuoteAt: new Date(now - 1200).toISOString()
  };
  assert.equal(isCoreTargetIndexTrailBreached(data, now), false);
  assert.equal(isCoreTargetIndexTrailBreached({...data, underlyingCurrent: 25470}, now), true);
});

test('no auto-sell on stale NIFTY, stale option, invalid option or invalid target', () => {
  const now = Date.parse('2026-11-20T06:00:00Z');
  const common = {
    strategyFamily: 'CORE', side: 'CE',
    coreTargetIndexTrailActive: true,
    coreTargetIndexTrailStop: target,
    underlyingCurrent: target - 20, currentPrice: 200, quantity: 650,
    lastUnderlyingQuoteAt: new Date(now - 1000).toISOString(),
    lastOptionQuoteAt: new Date(now - 1000).toISOString()
  };
  assert.ok(isFreshCoreIndexTargetQuotes(common, now));
  assert.ok(isCoreTargetIndexTrailBreached(common, now));
  assert.equal(isCoreTargetIndexTrailBreached({...common, lastOptionQuoteAt: null}, now), false);
  assert.equal(isCoreTargetIndexTrailBreached({...common, lastUnderlyingQuoteAt: new Date(now - 15000).toISOString()}, now), false);
  assert.equal(isCoreTargetIndexTrailBreached({...common, currentPrice: 0}, now), false);
  assert.equal(isCoreTargetIndexTrailBreached({...common, strategyFamily: 'SCALP'}, now), false);
  assert.equal(computeCoreTargetIndexTrail({
    side: 'CE', underlyingEntry: entry, underlyingStop: hardStop,
    underlyingTarget: entry - 10, bestR: 5
  }).active, false);
});

test('integration preserves option-profit trail, stop, Scalp and journal', () => {
  const app = readFileSync(new URL('../src/AppV3.jsx', import.meta.url), 'utf8');
  const panel = readFileSync(new URL('../src/components/LivePositionPanel.jsx', import.meta.url), 'utf8');
  const history = readFileSync(new URL('../src/components/History.jsx', import.meta.url), 'utf8');
  assert.match(app, /computeCoreTargetIndexTrail/);
  assert.match(app, /isCoreTargetIndexTrailBreached\(corePosition\)/);
  assert.match(app, /CORE_TARGET_INDEX_TRAIL/);
  assert.match(app, /isCoreOptionTrailBreached\(corePosition\)/);
  assert.match(app, /SCALP_OPTION_PROFIT_TRAIL/);
  assert.match(app, /lastUnderlyingQuoteAt:/);
  assert.match(panel, /TARGET-BASED NIFTY TRAIL/);
  assert.match(history, /CORE_TARGET_INDEX_TRAIL/);
});
