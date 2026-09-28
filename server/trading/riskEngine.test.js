import test from 'node:test';
import assert from 'node:assert/strict';
import { evaluateTradeIntent } from './riskEngine.js';

function baseConfig(overrides = {}) {
  return {
    mode: 'PAPER',
    tradingBridgeEnabled: true,
    liveTradingEnabled: false,
    capitalRs: 500000,
    maxRiskPerTradeRs: 5000,
    maxLots: 2,
    dailyLossLimitRs: 10000,
    maxQuoteAgeMs: 3000,
    onePositionAtATime: true,
    allowedOrderSymbolPrefixes: ['NSE:NIFTY'],
    ...overrides
  };
}

function baseRuntime(overrides = {}) {
  return {
    killSwitchActive: false,
    marketData: { connected: true, lastTickAt: '2026-09-21T10:00:00.000Z' },
    broker: { authenticated: true, orderSocketConnected: true, sessionDate: '2026-09-21' },
    positions: { openCount: 0 },
    pnl: { sessionDate: '2026-09-21', realizedRs: 0, unrealizedRs: 0 },
    ...overrides
  };
}

function entryIntent(overrides = {}) {
  return {
    intentId: 'intent-test-1',
    action: 'ENTRY',
    side: 'BUY',
    symbol: 'NSE:NIFTY26SEP25000CE',
    lots: 1,
    estimatedRiskRs: 2500,
    ...overrides
  };
}

const now = new Date('2026-09-21T10:00:01.000Z');

test('PAPER entry can pass only when independent safeguards pass', () => {
  const result = evaluateTradeIntent({
    intent: entryIntent(),
    config: baseConfig(),
    runtime: baseRuntime(),
    now
  });
  assert.equal(result.ok, true);
  assert.deepEqual(result.rejects, []);
});

test('kill switch blocks new entries', () => {
  const result = evaluateTradeIntent({
    intent: entryIntent(),
    config: baseConfig(),
    runtime: baseRuntime({ killSwitchActive: true }),
    now
  });
  assert.equal(result.ok, false);
  assert.ok(result.rejects.some(item => item.code === 'KILL_SWITCH_ACTIVE'));
});

test('risk-reducing EXIT is not blocked by the kill switch', () => {
  const result = evaluateTradeIntent({
    intent: { intentId: 'exit-1', action: 'EXIT' },
    config: baseConfig(),
    runtime: baseRuntime({ killSwitchActive: true }),
    now
  });
  assert.equal(result.rejects.some(item => item.code === 'KILL_SWITCH_ACTIVE'), false);
});

test('stale market data blocks a new PAPER entry', () => {
  const result = evaluateTradeIntent({
    intent: entryIntent(),
    config: baseConfig(),
    runtime: baseRuntime({
      marketData: { connected: true, lastTickAt: '2026-09-21T09:59:50.000Z' }
    }),
    now
  });
  assert.equal(result.ok, false);
  assert.ok(result.rejects.some(item => item.code === 'STALE_MARKET_DATA'));
});

test('one-position-at-a-time protection blocks a second entry', () => {
  const result = evaluateTradeIntent({
    intent: entryIntent(),
    config: baseConfig(),
    runtime: baseRuntime({ positions: { openCount: 1 } }),
    now
  });
  assert.equal(result.ok, false);
  assert.ok(result.rejects.some(item => item.code === 'POSITION_ALREADY_OPEN'));
});

test('duplicate intent is explicitly rejected', () => {
  const result = evaluateTradeIntent({
    intent: entryIntent(),
    config: baseConfig(),
    runtime: baseRuntime(),
    seenIntent: true,
    now
  });
  assert.equal(result.ok, false);
  assert.ok(result.rejects.some(item => item.code === 'DUPLICATE_INTENT'));
});

test('LIVE is impossible in phase 1 even if enabled in environment config', () => {
  const result = evaluateTradeIntent({
    intent: entryIntent(),
    config: baseConfig({ mode: 'LIVE', liveTradingEnabled: true }),
    runtime: baseRuntime(),
    now
  });
  assert.equal(result.ok, false);
  assert.ok(result.rejects.some(item => item.code === 'LIVE_ADAPTER_NOT_IMPLEMENTED'));
});
