// Builds every recorded case. The recorded answers live in baseline.json.
import { signals } from '../../aws/live/entrySignals.mjs';
import { evaluateExit } from '../../aws/live/exitSignals.mjs';
import { classifyResearchSetup, classifyManualResearchSetup, tierEnabled } from '../../src/engine/researchStrategy.js';
import { evaluateScalpSetup } from '../../src/engine/scalpStrategy.js';
import { deriveScalpPositionMentor, derivePositionMentor } from '../../src/engine/positionMentor.js';
import { updateLivePosition } from '../../src/engine/managedPosition.js';
import { calculateTradeAmountSizing } from '../../src/engine/tradeAmount.js';
import { LIVE_PARAMETERS } from '../../server/mentorBase.js';
import { sampleDay, SYMBOL } from './market.mjs';
import { frozen, stable } from './harness.mjs';

// Seeds picked from a scan of 20,000 so that each distinct outcome appears.
export const SEEDS = [1, 2, 4, 7, 8, 15, 18, 35, 48, 49, 50, 61, 131, 187, 310, 685,
  1745, 3802, 7949, 8703, 11623, 12556, 14737];
export const NOW = Date.parse('2026-11-25T11:00:00+05:30');
const SETTINGS = { tradeAmount: 30000, controlledResearch: true, experimentalResearch: true, capital: 50000, riskPct: 2 };

async function entryCases() {
  const out = {};
  for (const seed of SEEDS) {
    const day = sampleDay(seed);
    out[`day-${seed}`] = await frozen(day.nowMs, async () => {
      const result = await signals({ ...day, masterAt: day.nowMs, settings: SETTINGS });
      const s = result.snapshot;
      for (const ticket of Object.values(result.tickets)) {
        // Not recorded on purpose: today both strategies receive Core's premium
        // stop here (a known fault, P0-10). It is a broker-stop wiring field,
        // not a strategy rule, and the planned fix will change it.
        if (ticket) delete ticket.hardOptionStop;
      }
      const core = classifyResearchSetup(s);
      return stable({
        snapshot: s, core, coreManual: classifyManualResearchSetup(s),
        scalp: evaluateScalpSetup(s, day.threeMinute, s?.market?.spot, day.nowMs),
        tickets: result.tickets
      });
    });
  }
  return out;
}

function tierCases() {
  // Every pass/fail mix of the 5 must-pass checks, with 0 to 8 green confirmations.
  const must = LIVE_PARAMETERS.filter(p => p.mandatory);
  const other = LIVE_PARAMETERS.filter(p => !p.mandatory);
  const base = { live: true, market: { phase: 'LIVE', sessionDate: '2026-11-25' },
    option: { symbol: SYMBOL.CE, lotSize: 65, ltp: 150 },
    structure: { underlyingStop: 24960, riskPoints: 40, closeConfirmed: true },
    setup: { retestStatus: 'HELD' }, decision: { side: 'CE', score: 80, rr: 1, canSuggestTrade: true } };
  const run = snapshot => {
    const c = classifyResearchSetup(snapshot);
    return [c.tier, tierEnabled(c, {}), tierEnabled(c, { controlledResearch: false, experimentalResearch: true })];
  };
  const params = (mask, greens) => [
    ...must.map((p, i) => ({ ...p, gatePassed: Boolean(mask & (1 << i)) })),
    ...other.map((p, i) => ({ ...p, status: i < greens ? 'green' : 'yellow' }))
  ];
  const grid = {};
  for (let mask = 0; mask < 32; mask += 1)
    for (let greens = 0; greens <= other.length; greens += 1)
      grid[`${mask.toString(2).padStart(5, '0')}-${greens}`] = run({ ...base, parameters: params(mask, greens) });
  const full = { ...base, parameters: params(31, 8) };
  const edges = {
    allGood: full,
    score79: { ...full, decision: { ...base.decision, score: 79.99 } },
    rrBelow1: { ...full, decision: { ...base.decision, rr: 0.99 } },
    notApproved: { ...full, decision: { ...base.decision, canSuggestTrade: false } },
    closeNotConfirmed: { ...full, structure: { ...base.structure, closeConfirmed: false } },
    retestPending: { ...full, setup: { retestStatus: 'PENDING' } },
    retestFailed: { ...full, structure: { ...base.structure, retestFailed: true } },
    notLive: { ...full, live: false },
    noStop: { ...full, structure: { closeConfirmed: true } },
    noOption: { ...full, option: null }
  };
  return stable({ grid, edges: Object.fromEntries(Object.entries(edges).map(([k, v]) => [k, run(v)])) });
}

function scalpEntryCases() {
  const nowFor = hm => Date.parse(`2026-11-25T${hm}:00+05:30`);
  const make = ({ side = 'CE', hm = '11:00', spotShift = 2, body = 0.8, vwapOk = true, trend = 0.7,
    liquidity = true, live = true, range = 12 } = {}) => {
    const nowMs = nowFor(hm), d = side === 'CE' ? 1 : -1;
    const bucket = Math.floor(nowMs / 180000) * 180;
    const candle = (t, close) => {
      const open = close - d * range * body;
      const low = Math.min(open, close) - range * (1 - body) / 2;
      return [t, open, low + range, low, close, 900];
    };
    const latest = candle(bucket - 180, 25000);
    const trigger = d === 1 ? latest[2] : latest[3];
    const spot = trigger + d * spotShift;
    const e = evaluateScalpSetup({ live, market: { phase: 'LIVE', sessionDate: '2026-11-25', spot,
      vwap: spot - d * (vwapOk ? 20 : -20), atr5: 30 }, decision: { side },
      option: { symbol: SYMBOL[side], lotSize: 65, ltp: 150 },
      parameters: [{ id: 'trend', value: trend }, { id: 'liquidity', gatePassed: liquidity }] },
      [candle(bucket - 360, 24995), latest], spot, nowMs);
    return { eligible: e.eligible, manual: e.manualEligible, score: e.score, stop: e.stop,
      target: e.target, risk: e.riskPoints, reason: e.reason };
  };
  const variants = { good: {}, time0929: { hm: '09:29' }, time0930: { hm: '09:30' }, time1515: { hm: '15:15' },
    time1516: { hm: '15:16' }, chased: { spotShift: 11, range: 6 }, notTriggered: { spotShift: -1 },
    weakBody: { body: 0.34 }, bodyAtFloor: { body: 0.36 }, wrongVwap: { vwapOk: false },
    weakTrend: { trend: 0.49 }, trendAtFloor: { trend: 0.5 }, illiquid: { liquidity: false },
    notLive: { live: false }, stopTooTight: { range: 1, spotShift: 0.1 }, stopTooWide: { range: 60 } };
  const out = {};
  for (const side of ['CE', 'PE'])
    for (const [name, v] of Object.entries(variants)) out[`${side}-${name}`] = make({ side, ...v });
  return stable(out);
}

// ---------- Exits, stops and trails ----------
export function openPosition(family, side) {
  const d = side === 'CE' ? 1 : -1;
  return { strategyFamily: family, side, symbol: SYMBOL[side], entry: 100, quantity: 65,
    currentPrice: 100, underlyingEntry: 25000, underlyingStop: 25000 - d * 100,
    underlyingTarget: 25000 + d * 100, score: 85, rr: family === 'SCALP' ? 1 : 1.5,
    scalpMaxHoldMinutes: 12, openedAt: new Date(NOW).toISOString(), bestR: 0, worstR: 0 };
}
export function snapshotFor(side, kind, generatedMs) {
  const opposite = side === 'CE' ? 'PE' : 'CE';
  const row = (id, bad) => ({ id, mandatory: true, gatePassed: !bad, status: bad ? 'red' : 'green' });
  const make = (bias, score, bad = {}) => ({ generatedAt: new Date(generatedMs).toISOString(),
    decision: { side: bias, score }, market: {},
    parameters: [row('chop', bad.chop), row('trend', bad.trend), row('vwap', bad.vwap)] });
  const base = {
    healthy: () => make(side, 85),
    flipStrong: () => make(opposite, 82),
    flipScoreDrop: () => make(opposite, 60, { trend: true }),
    gatesFailing: () => make(side, 70, { chop: true, trend: true }),
    oneGateWeak: () => make(side, 80, { chop: true }),
    wrongVwap: () => ({ ...make(side, 80), market: { vwap: side === 'CE' ? 25500 : 24500 } })
  };
  return kind === 'none' ? null : base[kind]();
}
// A tick is [seconds after entry, NIFTY move in R (+ is favourable), option price, snapshot kind].
export async function play(family, side, ticks) {
  let position = openPosition(family, side);
  const steps = [];
  for (const [sec, r, option, kind = 'healthy'] of ticks) {
    const nowMs = NOW + sec * 1000;
    const nifty = 25000 + (side === 'CE' ? 1 : -1) * r * 100;
    const res = await frozen(nowMs, async () => evaluateExit(position,
      { at: new Date(nowMs).toISOString(), optionSymbol: position.symbol, optionPrice: option, nifty },
      snapshotFor(side, kind, nowMs), nowMs));
    if (!res.accepted) { steps.push({ rejected: res.reason }); continue; }
    position = res.position;
    steps.push({ exit: res.exitReason, bestR: position.bestR,
      coreFloor: position.coreOptionTrailingFloorPnl, coreTargetStop: position.coreTargetIndexTrailStop,
      scalpFloorR: position.scalpTrailingFloorR, scalpOptionFloor: position.optionTrailingFloorPnl });
    if (res.exitReason) break;
  }
  return stable(steps);
}

// Readable scenarios. The third value is the exit expected today (null = still holding).
export const NAMED = {
  'core structural stop': ['CORE', [[10, -1, 70]], 'STRUCTURE_INVALIDATED'],
  'core stop works without a strategy snapshot': ['CORE', [[10, -1, 70, 'none']], 'STRUCTURE_INVALIDATED'],
  'core strong opposite trend': ['CORE', [[10, -0.2, 95, 'flipStrong']], 'STRATEGY_DETERIORATION'],
  'core opposite bias and score drop': ['CORE', [[10, 0, 100, 'flipScoreDrop']], 'STRATEGY_DETERIORATION'],
  'core two gates failing': ['CORE', [[10, -0.6, 90, 'gatesFailing']], 'STRATEGY_DETERIORATION'],
  'core profit protection': ['CORE', [[10, 1.2, 104], [20, 0.8, 104, 'oneGateWeak']], 'PROFIT_PROTECTION_EXIT'],
  'core pullback with healthy picture holds': ['CORE', [[10, 1.2, 104], [20, 0.8, 104]], null],
  'core option trail not armed under 5%': ['CORE', [[10, 0.2, 104.9], [20, 0.1, 100.5]], null],
  'core option trail keeps 35%': ['CORE', [[10, 0.3, 110], [20, 0.2, 103.4]], 'CORE_OPTION_PROFIT_TRAIL'],
  'core option trail keeps 50%': ['CORE', [[10, 0.5, 120], [20, 0.4, 110]], 'CORE_OPTION_PROFIT_TRAIL'],
  'core option trail keeps 60%': ['CORE', [[10, 0.6, 140], [20, 0.5, 124]], 'CORE_OPTION_PROFIT_TRAIL'],
  'core option trail keeps 70%': ['CORE', [[10, 0.7, 160], [20, 0.6, 142]], 'CORE_OPTION_PROFIT_TRAIL'],
  'core target does not sell': ['CORE', [[10, 1.0, 150], [20, 1.2, 160]], null],
  'core trails after target': ['CORE', [[10, 1.6, 150], [20, 1.1, 150]], 'CORE_TARGET_INDEX_TRAIL'],
  'scalp structural stop': ['SCALP', [[10, -1, 70]], 'STRUCTURE_INVALIDATED'],
  'scalp sells at 1R target': ['SCALP', [[10, 1.0, 108]], 'SCALP_TARGET'],
  'scalp 12 minute limit': ['SCALP', [[721, 0.1, 100.5]], 'SCALP_TIME_EXIT'],
  'scalp bias flip while not in profit': ['SCALP', [[10, 0, 100, 'flipStrong']], 'SCALP_CONTEXT_EXIT'],
  'scalp wrong side of VWAP': ['SCALP', [[10, -0.15, 99, 'wrongVwap']], 'SCALP_CONTEXT_EXIT'],
  'scalp profit protection': ['SCALP', [[10, 0.65, 101], [20, 0.2, 101]], 'SCALP_PROFIT_PROTECT'],
  'scalp NIFTY trail': ['SCALP', [[10, 0.8, 102], [20, 0.54, 102]], 'SCALP_TRAILING_STOP'],
  'scalp option trail keeps 50%': ['SCALP', [[10, 0.3, 110], [20, 0.35, 105]], 'SCALP_OPTION_PROFIT_TRAIL'],
  // Current behaviour worth knowing: with no fresh strategy snapshot the server
  // does not evaluate Scalp's 1R target or its 12 minute limit.
  'scalp target without a fresh snapshot': ['SCALP', [[10, 1.05, 108, 'none']], null],
  'scalp time limit without a fresh snapshot': ['SCALP', [[900, 0.1, 100.5, 'none']], null]
};

function walk(seed) {
  let a = seed;
  const next = () => { a = (Math.imul(a, 1664525) + 1013904223) >>> 0; return a / 4294967296; };
  const kinds = ['healthy', 'healthy', 'healthy', 'healthy', 'healthy', 'healthy', 'healthy', 'healthy',
    'oneGateWeak', 'oneGateWeak', 'flipStrong', 'flipScoreDrop', 'gatesFailing', 'wrongVwap', 'none', 'none'];
  let r = 0, sec = 0;
  return Array.from({ length: 80 }, () => {
    sec += 2 + Math.floor(next() * 18);
    r += (next() - 0.46) * 0.3;
    const option = Math.max(1, 100 + r * 22 + (next() - 0.5) * 5);
    return [sec, Math.round(r * 1000) / 1000, Math.round(option * 20) / 20, kinds[Math.floor(next() * kinds.length)]];
  });
}

async function exitCases() {
  const named = {}, walks = {};
  for (const side of ['CE', 'PE']) {
    for (const [name, [family, ticks]] of Object.entries(NAMED)) named[`${side} ${name}`] = await play(family, side, ticks);
    for (const family of ['CORE', 'SCALP'])
      for (let seed = 1; seed <= 60; seed += 1) {
        const steps = await play(family, side, walk(seed * 7919));
        walks[`${family}-${side}-${seed}`] = { count: steps.length, last: steps.at(-1) };
      }
  }
  return { named, walks };
}

async function guardCases() {
  // Quote safety rules and the advice shown while holding.
  const p = openPosition('CORE', 'CE');
  const at = ms => new Date(ms).toISOString();
  const quote = { at: at(NOW), optionSymbol: p.symbol, optionPrice: 100, nifty: 25000 };
  const reason = (pos, q) => { const r = evaluateExit(pos, q, null, NOW); return r.accepted ? 'ACCEPTED' : r.reason; };
  return frozen(NOW, async () => stable({
    fresh: reason(p, quote),
    age3000: reason(p, { ...quote, at: at(NOW - 3000) }),
    age3001: reason(p, { ...quote, at: at(NOW - 3001) }),
    wrongSymbol: reason(p, { ...quote, optionSymbol: 'NSE:OTHER' }),
    repeated: reason({ ...p, lastOptionQuoteAt: quote.at }, quote),
    advice: [-0.6, -0.1, 0.3, 0.8, 1.05].flatMap(r => ['CORE', 'SCALP'].map(family => {
      const pos = updateLivePosition(openPosition(family, 'CE'), 100, 25000 + r * 100, null, quote.at);
      const derive = family === 'CORE' ? derivePositionMentor : deriveScalpPositionMentor;
      const m = derive(pos, snapshotFor('CE', 'healthy', NOW), 25000 + r * 100);
      return [family, r, m.reasonCode, m.alertLevel];
    })),
    scalpStopCode: deriveScalpPositionMentor(openPosition('SCALP', 'CE'), null, 24900).reasonCode
  }));
}

function sizingCases() {
  const out = [];
  for (const settings of [{ tradeAmount: 30000 }, { tradeAmount: 14949.99 }, { tradeAmount: 14950 },
    { tradeAmount: 0 }, { defaultLots: 1 }, { defaultLots: 3, lotCap: 2 }, {}])
    for (const price of [0, 99.95, 150, 230, 230.05])
      out.push([settings, price, calculateTradeAmountSizing(settings, price, 65)]);
  return stable(out);
}

export async function allCases() {
  return { entries: await entryCases(), tiers: tierCases(), scalpEntry: scalpEntryCases(),
    exits: await exitCases(), guards: await guardCases(), sizing: sizingCases() };
}
