import test from 'node:test';
import assert from 'node:assert/strict';
import { filterJournal, tradeSource, tradeTag, TAG_FILTERS } from '../src/services/journalFilters.js';

const rows = [
  { id: 'a', initiatedBy: 'RESEARCH_ENGINE' , entryMandatoryPassCount: 4 },
  { id: 'b', initiatedBy: 'SHADOW_RESEARCH', shadowResearch: true, strategyTier: 'SHADOW_3_OF_5' },
  { id: 'c', initiatedBy: 'MENTOR', strategyTier: 'FULL' },
  { id: 'd', initiatedBy: 'USER', strategyTier: 'MANUAL', strategyTierLabel: 'Manual research', manualResearch: true },
  { id: 'e', initiatedBy: 'USER', strategyTier: 'SCALP', strategyTierLabel: 'Scalp research · Manual', entryMethod: 'MANUAL' },
  { id: 'f' }
];
const ids = filter => filterJournal(rows, filter).map(row => row.id).join('');

test('research-engine records count as Shadow, as on the Analysis page', () => {
  assert.equal(tradeSource(rows[0]), 'shadow');
  assert.equal(ids({ strategy: 'core', source: 'shadow' }), 'ab');
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
  assert.equal(total(['auto', 'shadow', 'manual', 'legacy'].map(source => filterJournal(rows, { source }).length)), rows.length);
  assert.equal(total(TAG_FILTERS.slice(1).map(([tag]) => filterJournal(rows, { tag }).length)), rows.length);
});

test('filtering never edits saved records', () => {
  const before = JSON.stringify(rows);
  filterJournal(rows, { source: 'shadow', tag: '4of5' });
  assert.equal(JSON.stringify(rows), before);
});
