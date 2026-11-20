import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import {
  computeCoreOptionTrail, isFreshCoreOptionQuote, isCoreOptionTrailBreached
} from '../src/engine/coreOptionTrail.js';

const create = peak => computeCoreOptionTrail({
  entryPrice: 169.85, quantity: 650, peakGrossPnl: peak
});

test('13-Point runner arms at 5% observed option gain, even below +1 NIFTY R', () => {
  const investment = 169.85 * 650;
  assert.equal(create(investment * 0.049).active, false);
  assert.equal(create(investment * 0.05).active, true);
  assert.ok(Math.abs(create(9360).floorPnl - 3276) < 0.01);
});

test('runner progressively retains more of larger winners without lowering the floor', () => {
  const early = create(9360);
  assert.equal(early.keepRatio, .35);
  const extended = computeCoreOptionTrail({
    entryPrice: 169.85, quantity: 650,
    peakGrossPnl: 169.85 * 650 * .30,
    previousFloorPnl: early.floorPnl
  });
  assert.ok(extended.keepRatio >= .6);
  const reversal = computeCoreOptionTrail({
    entryPrice: 169.85, quantity: 650,
    peakGrossPnl: 2000, previousFloorPnl: extended.floorPnl
  });
  assert.equal(reversal.floorPnl, extended.floorPnl);
});

test('runner exits only on fresh exact-option quotes, never stale snapshot alone', () => {
  const now = Date.parse('2026-11-20T07:00:00Z');
  const base = {
    strategyFamily: 'CORE', quantity: 650,
    coreOptionTrailingActive: true, coreOptionTrailingFloorPnl: 3276,
    currentUnrealizedPnl: 3000, lastOptionQuoteAt: new Date(now - 1000).toISOString()
  };
  assert.ok(isFreshCoreOptionQuote(base, now));
  assert.ok(isCoreOptionTrailBreached(base, now));
  assert.equal(isCoreOptionTrailBreached({ ...base, currentUnrealizedPnl: 4000 }, now), false);
  assert.equal(isCoreOptionTrailBreached({ ...base, lastOptionQuoteAt: new Date(now - 7000).toISOString() }, now), false);
  assert.equal(isCoreOptionTrailBreached({ ...base, strategyFamily: 'SCALP' }, now), false);
  assert.equal(isCoreOptionTrailBreached({ ...base, quantity: 0 }, now), false);
});

test('integration retains Scalp separate and journal closes outside React position updater', () => {
  const app = readFileSync(new URL('../src/AppV3.jsx', import.meta.url), 'utf8');
  assert.match(app, /computeCoreOptionTrail/);
  assert.match(app, /isCoreOptionTrailBreached\(corePosition\)/);
  assert.match(app, /SCALP_OPTION_PROFIT_TRAIL/);
  assert.match(app, /CORE_OPTION_PROFIT_TRAIL/);
  assert.doesNotMatch(app, /setter\(current => \{\s*if \(!current\) return current;\s*const closed = closeTrade/);
});
