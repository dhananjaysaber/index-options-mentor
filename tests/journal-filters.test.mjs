import test from 'node:test';
import assert from 'node:assert/strict';
import { filterJournal, groupForTotals, matchingCopy, tradeLabel, tradeSource, tradeTag, TAG_FILTERS } from '../src/services/journalFilters.js';

const rows = [
  { id: 'a', initiatedBy: 'RESEARCH_ENGINE' , entryMandatoryPassCount: 4 },
  { id: 'b', initiatedBy: 'SHADOW_RESEARCH', shadowResearch: true, strategyTier: 'SHADOW_3_OF_5' },
  { id: 'c', initiatedBy: 'MENTOR', strategyTier: 'FULL' },
  { id: 'd', initiatedBy: 'USER', strategyTier: 'MANUAL', strategyTierLabel: 'Manual research', manualResearch: true },
  { id: 'e', initiatedBy: 'USER', strategyTier: 'SCALP', strategyTierLabel: 'Scalp research · Manual', entryMethod: 'MANUAL' },
  { id: 'f' }
];
const ids = filter => filterJournal(rows, filter).map(row => row.id).join('');

test('research records are named after the recorder that saved them', () => {
  assert.equal(tradeSource(rows[0]), 'researchB');
  assert.equal(tradeSource(rows[1]), 'researchA');
  assert.equal(ids({ strategy: 'core', source: 'researchA' }), 'b');
  assert.equal(ids({ strategy: 'core', source: 'researchB' }), 'a');
});

test('source and strategy filters work together', () => {
  assert.equal(ids({ source: 'auto' }), 'c');
  assert.equal(ids({ source: 'manual' }), 'de');
  assert.equal(ids({ strategy: 'scalp', source: 'manual' }), 'e');
  assert.equal(ids({ source: 'legacy' }), 'f');
});

test('strategy tag filters', () => {
  assert.deepEqual(rows.map(tradeTag), ['4of5', '3of5', '5of5', 'manual', 'scalp', 'legacy']);
  assert.equal(ids({ strategy: 'core', tag: '4of5' }), 'a');
});

test('every record is in exactly one source and one tag, so counts add up', () => {
  const total = values => values.reduce((sum, n) => sum + n, 0);
  assert.equal(total(['auto', 'researchA', 'researchB', 'researchOther', 'manual', 'legacy'].map(source => filterJournal(rows, { source }).length)), rows.length);
  assert.equal(total(TAG_FILTERS.slice(1).map(([tag]) => filterJournal(rows, { tag }).length)), rows.length);
});

test('filtering never edits saved records', () => {
  const before = JSON.stringify(rows);
  filterJournal(rows, { source: 'researchB', tag: '4of5' });
  assert.equal(JSON.stringify(rows), before);
});

import { buildCohortAnalysis, analyseExpiryProxy } from '../src/services/researchAnalysis.js';

// The same 4/5 trade as saved by both recorders, plus one practice trade of the owner's.
const pair = { side: 'CE', symbol: 'NSE:NIFTY26D0125800CE', entry: 246.5, quantity: 65, openedAt: '2026-11-26T09:44:41.000Z', closedAt: '2026-11-26T09:50:00.000Z' };
const a = { ...pair, id: 'x', initiatedBy: 'SHADOW_RESEARCH', shadowResearch: true, strategyTier: 'SHADOW_4_OF_5', strategyTierLabel: 'Shadow research 4/5', pnl: -100 };
const b = { ...pair, id: 'shadow:y', initiatedBy: 'RESEARCH_ENGINE', mode: 'SHADOW_RESEARCH', strategyTier: 'SHADOW_4_OF_5', strategyTierLabel: '4/5 shadow research', openedAt: '2026-11-26T09:44:41.400Z', pnl: -110 };
const own = { ...pair, id: 'z', initiatedBy: 'USER', strategyTier: 'MANUAL', manualResearch: true, pnl: 500 };
const real = { ...own, id: 'r', mode: 'LIVE', executionMode: 'REAL', pnl: 40 };

test('each recorder has one clear label and points to its likely copy', () => {
  assert.equal(tradeLabel(a), '4/5 · Research A');
  assert.equal(tradeLabel(b), '4/5 · Research B');
  assert.equal(tradeLabel({ strategyTier: 'SCALP', strategyTierLabel: 'Scalp research · Manual' }), 'Scalp practice · Manual');
  assert.equal(matchingCopy(a, [a, b, own]), b);
  assert.equal(matchingCopy(b, [a, b, own]), a);
  assert.equal(matchingCopy(own, [a, b, own]), null);
  assert.equal(matchingCopy(a, [a, { ...b, openedAt: '2026-11-26T09:50:41.000Z' }]), null);
});

test('totals never add the two recorders, your trades or real money together', () => {
  const totals = groupForTotals([a, b, own, real]).map(group => [group.id, group.rows.reduce((n, row) => n + row.pnl, 0)]);
  assert.deepEqual(totals, [['real', 40], ['practice', 500], ['researchA', -100], ['researchB', -110]]);
  const cohorts = Object.fromEntries(buildCohortAnalysis([a, b, own, real]).map(row => [row.id, row.stats.pnl]));
  assert.equal(cohorts.research_a, -100);
  assert.equal(cohorts.research_b, -110);
  assert.equal(cohorts.core_manual, 500);
  assert.equal(cohorts.real, 40);
});

test('the weekday comparison leaves out research and real money', () => {
  const result = analyseExpiryProxy([a, b, own, real]);
  assert.equal(result.tuesday.pnl + result.other.pnl, 500);
});
