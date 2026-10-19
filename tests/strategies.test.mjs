import test from 'node:test';
import assert from 'node:assert/strict';
import { buildManualResearchTicket, buildSimulatedTicket, classifyManualResearchSetup, classifyResearchSetup } from '../src/engine/researchStrategy.js';
import { evaluateScalpSetup, buildScalpTicket } from '../src/engine/scalpStrategy.js';

const FIXTURE_TIME = Date.parse('2026-10-19T05:00:00Z'); // 10:30 IST

function coreSnapshot(at = Date.now()) {
  const mandatory = ['chop', 'trend', 'vwap', 'risk', 'liquidity'].map(id => ({ id, mandatory: true, gatePassed: true, status: 'green', value: .95 }));
  const confirmations = ['orb', 'close', 'retest', 'pd', 'volume', 'momentum', 'htf', 'time'].map(id => ({ id, mandatory: false, gatePassed: true, status: 'green', value: .95 }));
  return {
    ok: true, live: true, generatedAt: new Date(at).toISOString(),
    market: { phase: 'LIVE', spot: 25000, sessionDate: '2026-10-19' },
    decision: { side: 'CE', score: 94, rr: 1.5, canSuggestTrade: true, state: 'QUALIFIED', headline: 'Ready', reasons: [] },
    option: { symbol: 'NSE:NIFTY-CE', optionType: 'CE', ltp: 95, lotSize: 65, estimatedPremiumStop: 88 },
    structure: { underlyingStop: 24990, riskPoints: 10, closeConfirmed: true },
    setup: { setupId: 'setup-one', retestStatus: 'HELD' },
    parameters: [...mandatory, ...confirmations]
  };
}
const settings = { capital: 50000, riskPct: 1, defaultLots: 1, lotCap: 5 };

test('13-point full setup qualifies with all 13 verified parameters', () => {
  const result = classifyResearchSetup(coreSnapshot());
  assert.equal(result.tier, 'FULL');
  assert.equal(result.mandatoryPassCount, 5);
  assert.equal(result.confirmationPassCount, 8);
});

test('13-point auto and manual entries reject stale snapshots', () => {
  const stale = coreSnapshot(Date.now() - 91000);
  assert.equal(classifyResearchSetup(stale).eligible, false);
  assert.equal(classifyManualResearchSetup(stale).eligible, false);
  assert.equal(buildSimulatedTicket(stale, settings), null);
  assert.equal(buildManualResearchTicket(stale, settings), null);
});

test('13-point manual ticket rejects failed hard risk gate and mismatched contracts', () => {
  const failed = coreSnapshot();
  failed.parameters.find(row => row.id === 'risk').gatePassed = false;
  assert.equal(classifyManualResearchSetup(failed).eligible, false);
  assert.equal(buildManualResearchTicket(failed, settings), null);
  const wrong = coreSnapshot();
  wrong.option.optionType = 'PE';
  assert.equal(classifyResearchSetup(wrong).eligible, false);
  assert.equal(classifyManualResearchSetup(wrong).eligible, false);
});

test('13-point execution rejects a price already through the stop', () => {
  const snap = coreSnapshot();
  const saved = globalThis.window;
  try {
    globalThis.window = { __indexOptionsLiveQuote: { at: new Date().toISOString(), nifty: 24985, optionSymbol: snap.option.symbol, optionPrice: 100 } };
    assert.equal(buildSimulatedTicket(snap, settings), null);
  } finally {
    globalThis.window = saved;
  }
});

test('13-point ticket ignores an expired live quote', () => {
  const snap = coreSnapshot();
  const saved = globalThis.window;
  try {
    globalThis.window = { __indexOptionsLiveQuote: { at: new Date(Date.now() - 30000).toISOString(), nifty: 24000, optionSymbol: snap.option.symbol, optionPrice: 2 } };
    const ticket = buildSimulatedTicket(snap, settings);
    assert.ok(ticket);
    assert.equal(ticket.underlyingEntry, 25000);
    assert.equal(ticket.entry, 95);
  } finally {
    globalThis.window = saved;
  }
});

function scalpSetup(nowMs = FIXTURE_TIME) {
  const currentBucket = Math.floor(Math.floor(nowMs / 1000) / 180) * 180;
  const candles = [
    [currentBucket - 360, 100, 107, 99, 105, 10000],
    [currentBucket - 180, 103, 108, 101, 107, 14000]
  ];
  const snapshot = {
    ok: true, live: true, generatedAt: new Date(nowMs).toISOString(),
    market: { phase: 'LIVE', spot: 109, vwap: 105, atr5: 12, sessionDate: '2026-10-19' },
    decision: { side: 'CE' },
    option: { symbol: 'NSE:NIFTY-CE', optionType: 'CE', ltp: 80, lotSize: 65 },
    parameters: [{ id: 'trend', value: .85 }, { id: 'liquidity', gatePassed: true }]
  };
  return { nowMs, snapshot, candles };
}

test('scalp qualifies from two unique completed candles and valid risk', () => {
  const { nowMs, snapshot, candles } = scalpSetup();
  const result = evaluateScalpSetup(snapshot, [candles[1], candles[0], candles[1]], 109, nowMs);
  assert.equal(result.eligible, true);
  assert.equal(result.score, 100);
  assert.equal(result.side, 'CE');
});

test('scalp blocks stale data, mismatched contract, and out-of-session entries', () => {
  const { nowMs, snapshot, candles } = scalpSetup();
  snapshot.generatedAt = new Date(nowMs - 91000).toISOString();
  assert.equal(evaluateScalpSetup(snapshot, candles, 109, nowMs).eligible, false);
  snapshot.generatedAt = new Date(nowMs).toISOString();
  snapshot.option.optionType = 'PE';
  assert.equal(evaluateScalpSetup(snapshot, candles, 109, nowMs).manualEligible, false);
  const late = scalpSetup(Date.parse('2026-10-19T10:00:00Z')); // 15:30 IST
  assert.equal(evaluateScalpSetup(late.snapshot, late.candles, 109, late.nowMs).eligible, false);
});

test('scalp ticket rechecks its gates and refuses an expired live price', () => {
  const { nowMs, snapshot, candles } = scalpSetup();
  const signal = evaluateScalpSetup(snapshot, candles, 109, nowMs);
  const originalNow = Date.now;
  const saved = globalThis.window;
  try {
    Date.now = () => nowMs;
    globalThis.window = { __indexOptionsLiveQuote: { at: new Date(nowMs - 25000).toISOString(), nifty: 90, optionSymbol: snapshot.option.symbol, optionPrice: 1 } };
    const ticket = buildScalpTicket(snapshot, signal, settings, 'MENTOR');
    assert.ok(ticket);
    assert.equal(ticket.underlyingEntry, 109);
    assert.equal(ticket.entry, 80);
    globalThis.window.__indexOptionsLiveQuote.at = new Date(nowMs).toISOString();
    globalThis.window.__indexOptionsLiveQuote.nifty = 118; // beyond entry extension/risk limits
    assert.equal(buildScalpTicket(snapshot, signal, settings, 'MENTOR'), null);
  } finally {
    Date.now = originalNow;
    globalThis.window = saved;
  }
});

test('13-point controlled and experimental tiers keep their intended quality-only relaxation', () => {
  const controlled = coreSnapshot();
  controlled.parameters.find(row => row.id === 'chop').gatePassed = false;
  controlled.decision.canSuggestTrade = false;
  assert.equal(classifyResearchSetup(controlled).tier, 'CONTROLLED');
  const experimental = coreSnapshot();
  experimental.parameters.find(row => row.id === 'chop').gatePassed = false;
  experimental.parameters.find(row => row.id === 'trend').gatePassed = false;
  experimental.decision.canSuggestTrade = false;
  assert.equal(classifyResearchSetup(experimental).tier, 'EXPERIMENTAL');
});

test('13-point refuses incomplete checks rather than counting them as passed', () => {
  const missing = coreSnapshot();
  missing.parameters = missing.parameters.filter(row => row.id !== 'orb');
  assert.equal(classifyResearchSetup(missing).eligible, false);
  assert.equal(classifyManualResearchSetup(missing).eligible, false);
  const unverified = coreSnapshot();
  delete unverified.parameters.find(row => row.id === 'trend').gatePassed;
  unverified.decision.canSuggestTrade = false;
  const result = classifyResearchSetup(unverified);
  assert.equal(result.mandatoryPassCount, 4);
  assert.equal(result.tier, 'CONTROLLED');
});
