import test from 'node:test';
import assert from 'node:assert/strict';
import { summarisePositionToday } from '../src/services/positionToday.js';

const NOW = new Date('2026-10-19T14:30:00Z'); // 20:00 in India
const rows = [
  { closedAt: '2026-10-19T04:30:00Z', strategyTier: 'FULL', pnl: 3000 },
  { closedAt: '2026-10-19T05:30:00Z', strategyFamily: 'SCALP', pnl: -1500 },
  { closedAt: '2026-10-19T10:00:00Z', strategyTierLabel: 'Scalp research · Manual', pnl: 400 },
  { closedAt: '2026-10-19T11:00:00Z', strategyTier: 'EXPERIMENTAL', pnl: -600 },
  { closedAt: '2026-10-18T17:30:00Z', strategyTier: 'FULL', pnl: 20000 },
  { closedAt: '2026-10-19T19:30:00Z', strategyFamily: 'SCALP', pnl: -999 },
  { openedAt: '2026-10-19T10:00:00Z', strategyFamily: 'SCALP', pnl: 500 },
  { closedAt: 'not-a-timestamp', pnl: 100 }
];

test('daily totals are calculated once and divided by strategy', () => {
  const s = summarisePositionToday(rows, NOW);
  assert.equal(s.total, 4);
  assert.equal(s.wins, 2);
  assert.equal(s.losses, 2);
  assert.equal(s.pnl, 1300);
  assert.deepEqual(s.core, { total: 2, wins: 1, losses: 1, pnl: 2400 });
  assert.deepEqual(s.scalp, { total: 2, wins: 1, losses: 1, pnl: -1100 });
});

test('today refers to India local day, not UTC calendar date', () => {
  const s = summarisePositionToday([{ closedAt: '2026-10-19T20:00:00Z', strategyFamily: 'SCALP', pnl: 123 }], new Date('2026-10-20T02:00:00Z'));
  assert.equal(s.total, 1);
  assert.equal(s.scalp.pnl, 123);
});

test('empty and invalid history produces zero totals', () => {
  const s = summarisePositionToday(null, NOW);
  assert.equal(s.total, 0);
  assert.equal(s.pnl, 0);
  assert.equal(s.core.total, 0);
  assert.equal(s.scalp.total, 0);
});
