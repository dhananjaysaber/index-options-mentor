import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { scalpScreenStop } from '../src/engine/scalpPremiumEstimate.js';
import { scalpPremiumStop } from '../aws/live/entrySignals.mjs';

test('Scalp screen stop matches the server formula for real orders', () => {
  let compared = 0;
  for (const price of [5, 60.35, 187.25, 216.85, 400]) for (const risk of [0, 3, 12.4, 20, 55, 300])
    for (const delta of [0, -0.45, 0.3, 0.5, 1, 1.2]) for (const gamma of [0, 0.0004, 0.001, 0.05]) {
      const server = scalpPremiumStop({ entry: price, underlyingEntry: 25000, underlyingStop: 25000 - risk }, { delta, gamma });
      const screen = scalpScreenStop({ price, niftySpot: 25000, niftyStop: 25000 - risk, option: { delta, gamma } });
      assert.equal(screen, Number.isNaN(server) ? null : server);
      if (screen != null) compared += 1;
    }
  assert.ok(compared > 50);
  assert.equal(scalpScreenStop({ price: 187.25, niftySpot: 25000, niftyStop: null, option: { delta: 0.5 } }), null);
});

test('Scalp screen no longer shows 13-Point numbers and labels practice buttons', () => {
  const view = readFileSync(new URL('../src/components/FyersReferenceViews.jsx', import.meta.url), 'utf8');
  const scalp = view.slice(view.indexOf('export function FyersScalpTrade'), view.indexOf('export function FyersDetail'));
  assert.doesNotMatch(scalp, /estimatedPremium(Stop|Target)/);
  assert.match(scalp, /NIFTY target 1R/);
  assert.match(scalp, /PRACTICE BUY/);
  assert.match(scalp, /PRACTICE SELL/);
});
