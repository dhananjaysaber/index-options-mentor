import test from 'node:test';
import assert from 'node:assert/strict';
import {
  queuePaperOpen,
  queuePaperClose,
  acknowledgeAwsPaperExit,
  flushPaperSyncQueue,
  pollPaperMonitor
} from '../src/services/paperSync.js';

const KEY = 'iom-paper-sync-outbox-v1';
const memory = new Map();
const events = [];
globalThis.localStorage = {
  getItem: key => memory.get(key) ?? null,
  setItem: (key, value) => memory.set(key, value),
  removeItem: key => memory.delete(key)
};
globalThis.document = { visibilityState: 'visible' };
globalThis.window = {
  dispatchEvent(event) { events.push(event); }
};
globalThis.CustomEvent = class {
  constructor(type, options) { this.type = type; this.detail = options?.detail; }
};

const make = () => ({
  id: crypto.randomUUID(),
  mode: 'SIMULATION',
  strategyFamily: 'CORE',
  openedAt: new Date().toISOString(),
  side: 'CE', symbol: 'NSE:NIFTY26NOV25650CE',
  entry: 100, underlyingEntry: 25650, underlyingStop: 25550,
  underlyingTarget: 25850, lotSize: 65, lots: 1, quantity: 65
});

test('stale browser positions do not enter AWS sync queue', () => {
  memory.clear();
  const old = make();
  old.openedAt = new Date(Date.now() - 48 * 3600 * 1000).toISOString();
  queuePaperOpen('core', old);
  assert.equal(JSON.parse(memory.get(KEY) || '[]').length, 0);
  assert.ok(events.some(e => e.detail?.status === 'POSITION_TOO_OLD_FOR_AWS_SYNC'));
});

test('queued open then close are both retained if network is offline', async () => {
  memory.clear();
  const position = make();
  globalThis.fetch = async () => { throw Error('offline'); };
  queuePaperOpen('core', position);
  queuePaperClose('core', position.id);
  await flushPaperSyncQueue();
  assert.deepEqual(JSON.parse(memory.get(KEY)).map(x => x.action), ['sync', 'reconcile']);
});

test('acknowledging AWS paper exit clears only matching position jobs', async () => {
  memory.clear();
  globalThis.fetch = async () => { throw Error('offline'); };
  const a = make();
  const b = { ...make(), strategyFamily: 'SCALP' };
  queuePaperOpen('core', a);
  queuePaperClose('core', a.id);
  queuePaperOpen('scalp', b);
  acknowledgeAwsPaperExit('core', a.id);
  await flushPaperSyncQueue();
  assert.equal(JSON.parse(memory.get(KEY)).length, 1);
  assert.equal(JSON.parse(memory.get(KEY))[0].strategy, 'scalp');
});

test('AWS monitor receipt emits read-only event', async () => {
  events.length = 0;
  globalThis.fetch = async () => Response.json({
    bridge: 'AUTHENTICATED',
    paperSync: { recentlyClosed: [{ id: 'paper-id', strategy: 'core', exitPrice: 120 }] }
  });
  await pollPaperMonitor();
  assert.ok(events.some(event =>
    event.type === 'mentor:paper-sync-status' &&
    event.detail.recentlyClosed[0].id === 'paper-id'
  ));
});
