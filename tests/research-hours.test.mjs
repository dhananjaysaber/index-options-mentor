import test from 'node:test';
import assert from 'node:assert/strict';
import { researchEntryOpen, researchCloseTiming, resultExclusion } from '../src/engine/researchHours.js';
import { advanceShadowResearchTrade, buildShadowResearchTrade, closeShadowResearchTrade } from '../src/engine/shadowResearch.js';
import { explainTrade, summariseTrades } from '../src/services/researchAnalysis.js';

// 26 Nov 2026 in India time, written as ISO with the +05:30 offset.
const at = (time, day = '26') => new Date(`2026-11-${day}T${time}+05:30`).toISOString();
const eligible = { eligible: true, cohort: 'SHADOW_4_OF_5', setupId: 's', key: 'k', mandatoryPassCount: 4, confirmationPassCount: 5 };
const market = (time, day = '26', spot = 25800) => ({ generatedAt: at(time, day), market: { spot, sessionDate: `2026-11-${day}`, phase: 'LIVE' }, structure: { underlyingStop: 25780, underlyingTarget: 25860 }, option: { symbol: 'X', lotSize: 65, ltp: 246.5, optionType: 'CE' }, decision: { side: 'CE', score: 76 }, parameters: [] });
const open = () => buildShadowResearchTrade(market('15:14:41'), eligible);

test('no new research trade after 3:15:00', () => {
  assert.equal(researchEntryOpen(at('15:15:00')), true);
  assert.equal(researchEntryOpen(at('15:15:01')), false);
  assert.equal(buildShadowResearchTrade(market('15:15:01'), eligible), null);
  assert.ok(open());
});

test('timed close from 3:18, missed from 3:30 or any later day', () => {
  const opened = at('15:00:00');
  assert.equal(researchCloseTiming(opened, at('15:17:59')), 'open');
  assert.equal(researchCloseTiming(opened, at('15:18:00')), 'close');
  assert.equal(researchCloseTiming(opened, at('15:29:59')), 'close');
  assert.equal(researchCloseTiming(opened, at('15:30:00')), 'missed');
  assert.equal(researchCloseTiming(opened, at('09:20:00', '27')), 'missed');
});

test('a check at 3:18 closes the trade and it counts', () => {
  const snapshot = market('15:18:05');
  const { trade, exit } = advanceShadowResearchTrade(open(), snapshot);
  assert.equal(exit.reasonCode, 'SESSION_END');
  const closed = closeShadowResearchTrade(trade, snapshot, exit, 240);
  assert.equal(closed.exit, 240);
  assert.equal(resultExclusion(closed), '');
});

test('a next-day check is a missed close with no result and no later prices', () => {
  const before = { ...open(), currentPrice: 245, bestR: 0.4, worstR: -0.2 };
  const snapshot = market('13:26:17', '27', 25528);
  const { trade, exit } = advanceShadowResearchTrade(before, snapshot);
  assert.equal(exit.reasonCode, 'MISSED_CLOSE');
  const closed = closeShadowResearchTrade(trade, snapshot, exit, 89.05);
  assert.deepEqual([closed.exit, closed.pnl, closed.rAchieved, closed.worstR, closed.underlyingExit], [245, null, null, -0.2, null]);
  assert.equal(resultExclusion(closed), 'Missed close');
  assert.equal(summariseTrades([closed]).total, 0);
});

test('stop and target rules before 3:18 are unchanged', () => {
  assert.equal(advanceShadowResearchTrade(open(), market('15:16:00', '26', 25770)).exit.reasonCode, 'STRUCTURE_INVALIDATED');
});

test('old overnight research records leave the totals but are not edited', () => {
  const old = { id: 'o', initiatedBy: 'RESEARCH_ENGINE', openedAt: at('15:14:41'), closedAt: at('13:26:17', '27'), pnl: -10234.25, rAchieved: -13.58 };
  const sameDay = { id: 'n', initiatedBy: 'RESEARCH_ENGINE', openedAt: at('11:00:00'), closedAt: at('11:30:00'), pnl: 100, rAchieved: 1 };
  const scalpLike = { id: 'u', initiatedBy: 'USER', strategyTier: 'SCALP', openedAt: at('15:00:00'), closedAt: at('10:00:00', '27'), pnl: -5 };
  const saved = JSON.stringify(old);
  assert.equal(resultExclusion(old), 'Carried overnight');
  assert.equal(resultExclusion(scalpLike), '');
  assert.equal(summariseTrades([old, sameDay, scalpLike]).pnl, 95);
  assert.match(explainTrade(old).reasons[0], /carried overnight/);
  assert.equal(JSON.stringify(old), saved);
});
