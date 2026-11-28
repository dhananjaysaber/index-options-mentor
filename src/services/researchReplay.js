import { countedTrades } from '../engine/researchHours.js';
import { researchRecorder } from './researchAnalysis.js';
const IST_DATE_FORMATTER = new Intl.DateTimeFormat('en-GB', {
  timeZone: 'Asia/Kolkata',
  year: 'numeric',
  month: '2-digit',
  day: '2-digit'
});
const IST_TIME_FORMATTER = new Intl.DateTimeFormat('en-GB', {
  timeZone: 'Asia/Kolkata',
  hour: '2-digit',
  minute: '2-digit',
  hour12: false
});
const IST_WEEKDAY_FORMATTER = new Intl.DateTimeFormat('en-US', {
  timeZone: 'Asia/Kolkata',
  weekday: 'short'
});

export const REPLAY_MODELS = [
  {
    id: 'actual',
    label: 'Recorded outcome',
    short: 'Actual',
    integrity: 'Recorded',
    copy: 'The R result and holding time already stored in the Trade Journal.'
  },
  {
    id: 'legacy',
    label: 'Legacy target manager',
    short: 'Legacy',
    integrity: 'Path-exact',
    copy: 'Uses the original structural stop and planned target. If both are touched inside the same candle, the replay records the stop first rather than assuming the favourable sequence.'
  },
  {
    id: 'runner',
    label: 'Current runner · path proxy',
    short: 'Runner',
    integrity: 'Proxy',
    copy: 'Keeps the structural stop, recognises +1R as a milestone and tests the current give-back thresholds. Historical live-bias/score deterioration is not reconstructed, so this is deliberately labelled a path proxy.'
  },
  {
    id: 'shadow',
    label: 'Shadow structural manager',
    short: 'Shadow',
    integrity: 'Path-exact',
    copy: 'Uses the recorded structural stop and structural target, then closes at the session end if neither is reached.'
  },
  {
    id: 'scalp',
    label: 'Scalp 1R · 12-minute manager',
    short: 'Scalp',
    integrity: 'Path-exact',
    copy: 'Uses the recorded scalp stop, a +1R target and the 12-minute maximum hold. It is applied only to recorded scalp entries.'
  }
];

export const STRUCTURE_PROBES = [
  {
    id: 'core',
    label: '13-point structure probe',
    short: 'Core probe',
    copy: 'Opening-range breakout followed by a held retest and aligned short-term NIFTY structure. This is market-structure evidence only; option liquidity, Greeks, PCR and exact 13-point qualification are not reconstructed.'
  },
  {
    id: 'shadow',
    label: 'Broader shadow-style probe',
    short: 'Shadow probe',
    copy: 'Tracks the first aligned opening-range breakout without requiring the later retest. It deliberately studies a broader NIFTY opportunity set and is not presented as the exact Shadow Research engine.'
  },
  {
    id: 'scalp',
    label: 'Scalp structure probe',
    short: 'Scalp probe',
    copy: 'Uses completed 5-minute direction plus a completed 3-minute impulse/trigger sequence, a tight ATR-scaled stop and a 12-minute 1R exit plan.'
  }
];

export function buildReplayLab(history = [], fiveMinute = [], threeMinute = []) {
  const five = normaliseCandles(fiveMinute);
  const three = normaliseCandles(threeMinute);
  const journal = buildJournalCounterfactual(history, five, three);
  const structural = buildStructuralReplay(five, three);

  return {
    journal,
    structural,
    coverage: {
      fiveMinuteCandles: five.length,
      threeMinuteCandles: three.length,
      sessions: groupSessions(five).length,
      from: five.length ? dateKeyIST(five[0].time * 1000) : '',
      to: five.length ? dateKeyIST(five.at(-1).time * 1000) : ''
    }
  };
}

export function buildJournalCounterfactual(history = [], fiveMinute = [], threeMinute = []) {
  const five = normaliseCandles(fiveMinute);
  const three = normaliseCandles(threeMinute);
  // Research records are left out: two recorders can save the same trade.
  const rows = countedTrades(dedupeTrades(history)).filter(trade => !researchRecorder(trade));
  const cases = [];
  const fiveSessions = new Map(groupSessions(five).map(session => [session.date, session.rows]));
  const threeSessions = new Map(groupSessions(three).map(session => [session.date, session.rows]));

  for (const trade of rows) {
    const side = normaliseSide(trade?.side);
    const entry = finite(trade?.underlyingEntry);
    const stop = finite(trade?.underlyingStop);
    const openMs = new Date(trade?.openedAt || 0).getTime();
    if (!side || entry == null || stop == null || !Number.isFinite(openMs) || openMs <= 0) continue;

    const risk = Math.abs(entry - stop);
    if (!(risk > 0)) continue;

    const scalp = isScalpTrade(trade);
    const resolution = scalp ? 3 : 5;
    const sessionRows = (scalp ? threeSessions : fiveSessions).get(dateKeyIST(openMs)) || [];
    const path = futureSessionPath(sessionRows, openMs, resolution);
    if (!path.length) continue;

    const rr = Math.max(1, finite(trade?.rr) ?? 1);
    const recordedTarget = finite(trade?.underlyingTarget);
    const legacyTarget = recordedTarget ?? targetFromR(side, entry, risk, rr);
    const shadowTarget = recordedTarget;
    const actualR = finite(trade?.rAchieved);
    const actualHold = finite(trade?.heldMinutes);

    const caseRow = {
      id: trade?.id || [trade?.symbol, trade?.openedAt].join('|'),
      symbol: trade?.symbol || 'NIFTY research',
      side,
      openedAt: trade?.openedAt,
      cohort: tradeCohort(trade),
      scalp,
      entry,
      stop,
      target: recordedTarget,
      risk,
      models: {
        actual: actualR == null ? null : {
          id: 'actual',
          r: actualR,
          heldMinutes: actualHold ?? 0,
          exitReason: String(trade?.exitReasonCode || 'RECORDED'),
          exitPrice: finite(trade?.underlyingExit),
          exitAt: trade?.closedAt || '',
          bestR: finite(trade?.bestR),
          worstR: finite(trade?.worstR)
        },
        legacy: scalp ? null : simulateStopTarget({
          path,
          side,
          entry,
          stop,
          target: legacyTarget,
          risk,
          sessionLabel: 'LEGACY_SESSION',
          openedAtMs: openMs
        }),
        runner: scalp ? null : simulateRunnerProxy({
          path,
          side,
          entry,
          stop,
          risk,
          openedAtMs: openMs
        }),
        shadow: scalp ? null : simulateStopTarget({
          path,
          side,
          entry,
          stop,
          target: shadowTarget,
          risk,
          sessionLabel: 'SHADOW_SESSION',
          openedAtMs: openMs
        }),
        scalp: scalp ? simulateScalpManager({
          path,
          side,
          entry,
          stop,
          risk,
          openedAtMs: openMs,
          maxHoldMinutes: Math.max(1, finite(trade?.scalpMaxHoldMinutes) ?? 12)
        }) : null
      }
    };

    cases.push(caseRow);
  }

  const coreCases = cases.filter(row => !row.scalp);
  const scalpCases = cases.filter(row => row.scalp);

  const summaries = {
    actualCore: summariseReplay(coreCases.map(row => row.models.actual).filter(Boolean)),
    legacy: summariseReplay(coreCases.map(row => row.models.legacy).filter(Boolean)),
    runner: summariseReplay(coreCases.map(row => row.models.runner).filter(Boolean)),
    shadow: summariseReplay(coreCases.map(row => row.models.shadow).filter(Boolean)),
    actualScalp: summariseReplay(scalpCases.map(row => row.models.actual).filter(Boolean)),
    scalp: summariseReplay(scalpCases.map(row => row.models.scalp).filter(Boolean))
  };

  return {
    cases,
    coreCases: coreCases.length,
    scalpCases: scalpCases.length,
    summaries,
    legacyVsRunner: compareModels(coreCases, 'legacy', 'runner'),
    actualVsLegacy: compareModels(coreCases, 'actual', 'legacy'),
    actualVsRunner: compareModels(coreCases, 'actual', 'runner'),
    scalpActualVsPlan: compareModels(scalpCases, 'actual', 'scalp')
  };
}

export function buildStructuralReplay(fiveMinute = [], threeMinute = []) {
  const five = normaliseCandles(fiveMinute);
  const three = normaliseCandles(threeMinute);
  const core = buildCoreProbeTrades(five, { requireRetest: true, label: 'CORE_STRUCTURE_PROBE' });
  const shadow = buildCoreProbeTrades(five, { requireRetest: false, label: 'SHADOW_STRUCTURE_PROBE' });
  const scalp = buildScalpProbeTrades(five, three);

  return {
    probes: {
      core: { rows: core, stats: summariseReplay(core) },
      shadow: { rows: shadow, stats: summariseReplay(shadow) },
      scalp: { rows: scalp, stats: summariseReplay(scalp) }
    },
    tuesday: {
      core: splitTuesday(core),
      shadow: splitTuesday(shadow),
      scalp: splitTuesday(scalp)
    }
  };
}

export function summariseReplay(rows = []) {
  const trades = rows.filter(row => row && Number.isFinite(Number(row.r)));
  const rValues = trades.map(row => Number(row.r));
  const holds = trades.map(row => Number(row.heldMinutes)).filter(Number.isFinite);
  const wins = rValues.filter(value => value > 0);
  const losses = rValues.filter(value => value < 0);
  const exits = countBy(trades, row => normaliseExitBucket(row.exitReason));

  let equity = 0;
  let peak = 0;
  let maxDrawdownR = 0;
  for (const row of trades) {
    equity += Number(row.r);
    peak = Math.max(peak, equity);
    maxDrawdownR = Math.max(maxDrawdownR, peak - equity);
  }

  return {
    total: trades.length,
    wins: wins.length,
    losses: losses.length,
    flat: Math.max(0, trades.length - wins.length - losses.length),
    winRate: trades.length ? wins.length / trades.length * 100 : 0,
    totalR: sum(rValues),
    avgR: average(rValues),
    medianR: median(rValues),
    avgHold: average(holds),
    bestR: rValues.length ? Math.max(...rValues) : 0,
    worstR: rValues.length ? Math.min(...rValues) : 0,
    maxDrawdownR,
    exits
  };
}

function compareModels(cases, leftKey, rightKey) {
  let matched = 0;
  let leftBetter = 0;
  let rightBetter = 0;
  let equal = 0;
  let difference = 0;

  for (const row of cases) {
    const left = row?.models?.[leftKey];
    const right = row?.models?.[rightKey];
    if (!left || !right || !Number.isFinite(Number(left.r)) || !Number.isFinite(Number(right.r))) continue;
    matched += 1;
    const delta = Number(left.r) - Number(right.r);
    difference += delta;
    if (Math.abs(delta) < 0.05) equal += 1;
    else if (delta > 0) leftBetter += 1;
    else rightBetter += 1;
  }

  return {
    matched,
    leftKey,
    rightKey,
    leftBetter,
    rightBetter,
    equal,
    avgDifferenceR: matched ? difference / matched : 0
  };
}

function simulateStopTarget({ path, side, entry, stop, target, risk, sessionLabel, openedAtMs = null }) {
  let bestR = 0;
  let worstR = 0;
  const opened = openedAtMs || path[0]?.timeMs || 0;

  for (const candle of path) {
    const favourable = favourableExtremeR(side, entry, risk, candle);
    const adverse = adverseExtremeR(side, entry, risk, candle);
    bestR = Math.max(bestR, favourable);
    worstR = Math.min(worstR, adverse);

    const stopHit = side === 'CE' ? candle.low <= stop : candle.high >= stop;
    const targetHit = target != null && (side === 'CE' ? candle.high >= target : candle.low <= target);

    if (stopHit && targetHit) {
      return replayResult(-1, candle, opened, 'STOP_AND_TARGET_SAME_CANDLE_CONSERVATIVE_STOP', stop, bestR, worstR);
    }
    if (stopHit) {
      return replayResult(-1, candle, opened, 'STRUCTURE_STOP', stop, bestR, worstR);
    }
    if (targetHit) {
      const targetR = directionalR(side, entry, risk, target);
      return replayResult(targetR, candle, opened, 'TARGET', target, bestR, worstR);
    }
  }

  const last = path.at(-1);
  const r = directionalR(side, entry, risk, last.close);
  return replayResult(r, last, opened, sessionLabel || 'SESSION_CLOSE', last.close, bestR, worstR);
}

function simulateRunnerProxy({ path, side, entry, stop, risk, openedAtMs = null }) {
  let bestR = 0;
  let worstR = 0;
  const opened = openedAtMs || path[0]?.timeMs || 0;

  for (const candle of path) {
    const favourable = favourableExtremeR(side, entry, risk, candle);
    const adverse = adverseExtremeR(side, entry, risk, candle);
    bestR = Math.max(bestR, favourable);
    worstR = Math.min(worstR, adverse);

    const stopHit = side === 'CE' ? candle.low <= stop : candle.high >= stop;
    if (stopHit) {
      return replayResult(-1, candle, opened, 'STRUCTURE_STOP', stop, bestR, worstR);
    }

    const closeR = directionalR(side, entry, risk, candle.close);
    const givebackR = Math.max(0, bestR - closeR);
    if (bestR >= 1.1 && closeR <= 0.8 && givebackR >= 0.3) {
      return replayResult(closeR, candle, opened, 'RUNNER_GIVEBACK_PATH_PROXY', candle.close, bestR, worstR);
    }
  }

  const last = path.at(-1);
  const r = directionalR(side, entry, risk, last.close);
  return replayResult(r, last, opened, 'RUNNER_SESSION_CLOSE', last.close, bestR, worstR);
}

function simulateScalpManager({ path, side, entry, stop, risk, openedAtMs, maxHoldMinutes }) {
  let bestR = 0;
  let worstR = 0;
  const target = targetFromR(side, entry, risk, 1);
  const deadline = openedAtMs + maxHoldMinutes * 60000;
  const opened = openedAtMs || path[0]?.timeMs || 0;

  for (const candle of path) {
    const favourable = favourableExtremeR(side, entry, risk, candle);
    const adverse = adverseExtremeR(side, entry, risk, candle);
    bestR = Math.max(bestR, favourable);
    worstR = Math.min(worstR, adverse);

    const stopHit = side === 'CE' ? candle.low <= stop : candle.high >= stop;
    const targetHit = side === 'CE' ? candle.high >= target : candle.low <= target;

    if (stopHit && targetHit) {
      return replayResult(-1, candle, opened, 'SCALP_STOP_AND_TARGET_SAME_CANDLE_CONSERVATIVE_STOP', stop, bestR, worstR);
    }
    if (stopHit) {
      return replayResult(-1, candle, opened, 'SCALP_STOP', stop, bestR, worstR);
    }
    if (targetHit) {
      return replayResult(1, candle, opened, 'SCALP_TARGET', target, bestR, worstR);
    }
    if (candle.timeMs >= deadline) {
      const r = directionalR(side, entry, risk, candle.close);
      return replayResult(r, candle, opened, 'SCALP_TIME_EXIT', candle.close, bestR, worstR);
    }
  }

  const last = path.at(-1);
  const r = directionalR(side, entry, risk, last.close);
  return replayResult(r, last, opened, 'SCALP_SESSION_CLOSE', last.close, bestR, worstR);
}

function replayResult(r, candle, openedMs, exitReason, exitPrice, bestR, worstR) {
  return {
    r,
    exitReason,
    exitPrice,
    exitAt: candle?.timeMs ? new Date(candle.timeMs).toISOString() : '',
    heldMinutes: candle?.timeMs && openedMs ? Math.max(0, Math.round((candle.timeMs - openedMs) / 60000)) : 0,
    bestR,
    worstR
  };
}

function buildCoreProbeTrades(five, { requireRetest, label }) {
  const sessions = groupSessions(five);
  const trades = [];

  for (const session of sessions) {
    const rows = session.rows;
    if (rows.length < 8) continue;

    const opening = rows.slice(0, 3);
    const orh = Math.max(...opening.map(row => row.high));
    const orl = Math.min(...opening.map(row => row.low));
    let breakout = null;

    for (let i = 3; i < rows.length - 1; i += 1) {
      const row = rows[i];
      const minute = row.minuteOfDay;
      if (minute < 570 || minute > 885) continue;

      const atr = rollingAtr(rows, i, 14);
      if (!(atr > 0)) continue;

      if (!breakout) {
        if (row.close > orh) breakout = { side: 'CE', index: i, level: orh };
        else if (row.close < orl) breakout = { side: 'PE', index: i, level: orl };
        if (!breakout) continue;

        if (!requireRetest) {
          const candidate = makeCoreProbe(rows, i, breakout.side, atr, label, false);
          if (candidate) {
            trades.push(candidate);
            break;
          }
        }
        continue;
      }

      if (i - breakout.index > 6) {
        breakout = null;
        i -= 1;
        continue;
      }

      const side = breakout.side;
      const tolerance = atr * 0.12;
      const retestHeld = side === 'CE'
        ? row.low <= breakout.level + tolerance && row.close > breakout.level
        : row.high >= breakout.level - tolerance && row.close < breakout.level;
      const failed = side === 'CE' ? row.close < breakout.level - tolerance : row.close > breakout.level + tolerance;

      if (failed) {
        breakout = null;
        continue;
      }

      if (requireRetest && retestHeld) {
        const candidate = makeCoreProbe(rows, i, side, atr, label, true);
        if (candidate) {
          trades.push(candidate);
          break;
        }
      }
    }
  }

  return trades;
}

function makeCoreProbe(rows, index, side, atr, label, retestHeld) {
  const row = rows[index];
  const recent = rows.slice(Math.max(0, index - 5), index + 1);
  if (recent.length < 4) return null;
  const slope = regressionSlope(recent.map(item => item.close));
  if (side === 'CE' ? slope <= 0 : slope >= 0) return null;

  const mean = average(recent.map(item => item.close));
  const locationAligned = side === 'CE' ? row.close >= mean : row.close <= mean;
  if (!locationAligned) return null;

  const entry = row.close;
  const stopRows = rows.slice(Math.max(0, index - 3), index + 1);
  const stop = side === 'CE'
    ? Math.min(...stopRows.map(item => item.low))
    : Math.max(...stopRows.map(item => item.high));
  const risk = Math.abs(entry - stop);
  if (!(risk >= Math.max(2, atr * 0.12) && risk <= atr * 1.4)) return null;

  const entryMs = row.time * 1000 + 5 * 60000;
  const future = rows.slice(index + 1).map(withTimeMs);
  if (!future.length) return null;
  const target = targetFromR(side, entry, risk, 1);
  const result = simulateStopTarget({
    path: future,
    side,
    entry,
    stop,
    target,
    risk,
    sessionLabel: 'PROBE_SESSION_CLOSE',
    openedAtMs: entryMs
  });

  return {
    ...result,
    id: label + ':' + row.time,
    model: label,
    date: row.sessionDate,
    openedAt: new Date(entryMs).toISOString(),
    entryTime: row.time,
    side,
    entry,
    stop,
    target,
    risk,
    retestHeld,
    scheduledTuesday: row.weekday === 2
  };
}

function buildScalpProbeTrades(five, three) {
  const fiveSessions = new Map(groupSessions(five).map(session => [session.date, session.rows]));
  const threeSessions = groupSessions(three);
  const trades = [];

  for (const session of threeSessions) {
    const rows3 = session.rows;
    const rows5 = fiveSessions.get(session.date) || [];
    if (rows3.length < 6 || rows5.length < 6) continue;

    let blockedUntilMs = 0;
    let completed5Count = 0;

    for (let i = 2; i < rows3.length - 1; i += 1) {
      const row = rows3[i];
      const rowMs = row.timeMs;
      if (rowMs < blockedUntilMs) continue;

      const minute = minuteOfDayIST(rowMs);
      if (minute < 570 || minute > 885) continue;

      while (completed5Count < rows5.length && rows5[completed5Count].timeMs + 5 * 60000 <= rowMs) {
        completed5Count += 1;
      }
      if (completed5Count < 6) continue;
      const recent5 = rows5.slice(Math.max(0, completed5Count - 6), completed5Count);
      const atr = rollingAtr(rows5, completed5Count - 1, 14);
      if (!(atr > 0)) continue;

      const slope = regressionSlope(recent5.map(item => item.close));
      const mean5 = average(recent5.map(item => item.close));
      const contextClose = recent5.at(-1).close;
      const side = slope > 0 && contextClose > mean5
        ? 'CE'
        : slope < 0 && contextClose < mean5
          ? 'PE'
          : null;
      if (!side) continue;

      const impulse = rows3[i - 1];
      const span = Math.max(0.01, impulse.high - impulse.low);
      const bodyRatio = Math.abs(impulse.close - impulse.open) / span;
      const impulseAligned = side === 'CE' ? impulse.close > impulse.open : impulse.close < impulse.open;
      if (!impulseAligned || bodyRatio < 0.35) continue;

      const trigger = side === 'CE' ? impulse.high : impulse.low;
      const brokeTrigger = side === 'CE' ? row.high > trigger : row.low < trigger;
      if (!brokeTrigger) continue;

      const buffer = atr * 0.05;
      const stop = side === 'CE' ? impulse.low - buffer : impulse.high + buffer;
      const entry = row.close;
      if (side === 'CE' ? entry <= trigger : entry >= trigger) continue;

      const risk = Math.abs(entry - stop);
      const minRisk = Math.max(2, atr * 0.12);
      const maxRisk = Math.max(6, atr * 0.75);
      if (!(risk >= minRisk && risk <= maxRisk)) continue;

      const extension = Math.abs(entry - trigger);
      if (extension > atr * 0.35) continue;

      const entryMs = rowMs + 3 * 60000;
      const future = rows3.slice(i + 1).map(withTimeMs);
      if (!future.length) continue;
      const target = targetFromR(side, entry, risk, 1);
      const result = simulateScalpManager({
        path: future,
        side,
        entry,
        stop,
        risk,
        openedAtMs: entryMs,
        maxHoldMinutes: 12
      });

      trades.push({
        ...result,
        id: 'SCALP_STRUCTURE_PROBE:' + row.time,
        model: 'SCALP_STRUCTURE_PROBE',
        date: session.date,
        openedAt: new Date(entryMs).toISOString(),
        entryTime: row.time,
        side,
        entry,
        stop,
        target,
        risk,
        bodyRatio,
        extension,
        scheduledTuesday: row.weekday === 2
      });

      const exitMs = result.exitAt ? new Date(result.exitAt).getTime() : entryMs + 12 * 60000;
      blockedUntilMs = Math.max(entryMs, exitMs);
    }
  }

  return trades;
}

function splitTuesday(rows) {
  const tuesday = rows.filter(row => row?.scheduledTuesday === true);
  const other = rows.filter(row => row?.scheduledTuesday !== true);
  return {
    tuesday: summariseReplay(tuesday),
    other: summariseReplay(other)
  };
}

function futureSessionPath(sessionRows, openMs, resolutionMinutes) {
  const step = resolutionMinutes * 60000;
  const safeStart = Math.ceil(openMs / step) * step;
  return sessionRows.filter(row => row.timeMs >= safeStart);
}

function withTimeMs(row) {
  return row?.timeMs ? row : { ...row, timeMs: Number(row.time) * 1000 };
}

function favourableExtremeR(side, entry, risk, candle) {
  const price = side === 'CE' ? candle.high : candle.low;
  return directionalR(side, entry, risk, price);
}

function adverseExtremeR(side, entry, risk, candle) {
  const price = side === 'CE' ? candle.low : candle.high;
  return directionalR(side, entry, risk, price);
}

function directionalR(side, entry, risk, price) {
  if (!(risk > 0) || !Number.isFinite(Number(price))) return 0;
  return side === 'CE'
    ? (Number(price) - entry) / risk
    : (entry - Number(price)) / risk;
}

function targetFromR(side, entry, risk, r) {
  return side === 'CE' ? entry + risk * r : entry - risk * r;
}

function rollingAtr(rows, index, period = 14) {
  const start = Math.max(1, index - period + 1);
  const values = [];
  for (let i = start; i <= index; i += 1) {
    const current = rows[i];
    const previous = rows[i - 1];
    if (!current || !previous) continue;
    const tr = Math.max(
      current.high - current.low,
      Math.abs(current.high - previous.close),
      Math.abs(current.low - previous.close)
    );
    if (Number.isFinite(tr)) values.push(tr);
  }
  return average(values);
}

function regressionSlope(values) {
  const rows = values.map(Number).filter(Number.isFinite);
  if (rows.length < 2) return 0;
  const n = rows.length;
  const meanX = (n - 1) / 2;
  const meanY = average(rows);
  let numerator = 0;
  let denominator = 0;
  for (let i = 0; i < n; i += 1) {
    const dx = i - meanX;
    numerator += dx * (rows[i] - meanY);
    denominator += dx * dx;
  }
  return denominator ? numerator / denominator : 0;
}

function normaliseCandles(rows) {
  return (Array.isArray(rows) ? rows : []).map(row => {
    let item;
    if (Array.isArray(row)) {
      const [time, open, high, low, close, volume] = row.map(Number);
      if (![time, open, high, low, close].every(Number.isFinite)) return null;
      item = { time, open, high, low, close, volume: Number(volume) || 0 };
    } else {
      if (!row || typeof row !== 'object') return null;
      item = {
        time: Number(row.time),
        open: Number(row.open),
        high: Number(row.high),
        low: Number(row.low),
        close: Number(row.close),
        volume: Number(row.volume) || 0
      };
      if (![item.time, item.open, item.high, item.low, item.close].every(Number.isFinite)) return null;
    }

    const timeMs = item.time * 1000;
    return {
      ...item,
      timeMs,
      sessionDate: dateKeyIST(timeMs),
      minuteOfDay: minuteOfDayIST(timeMs),
      weekday: weekdayIST(timeMs)
    };
  }).filter(Boolean).sort((a, b) => a.time - b.time);
}

function groupSessions(rows) {
  const map = new Map();
  for (const row of rows) {
    const date = row.sessionDate || dateKeyIST(row.timeMs || row.time * 1000);
    if (!date) continue;
    if (!map.has(date)) map.set(date, []);
    map.get(date).push(row);
  }
  return [...map.entries()].map(([date, sessionRows]) => ({ date, rows: sessionRows }));
}

function dateKeyIST(ms) {
  try {
    const parts = IST_DATE_FORMATTER.formatToParts(new Date(ms));
    const year = parts.find(part => part.type === 'year')?.value;
    const month = parts.find(part => part.type === 'month')?.value;
    const day = parts.find(part => part.type === 'day')?.value;
    return year && month && day ? year + '-' + month + '-' + day : '';
  } catch {
    return '';
  }
}

function minuteOfDayIST(ms) {
  try {
    const parts = IST_TIME_FORMATTER.formatToParts(new Date(ms));
    const hour = Number(parts.find(part => part.type === 'hour')?.value);
    const minute = Number(parts.find(part => part.type === 'minute')?.value);
    return Number.isFinite(hour) && Number.isFinite(minute) ? hour * 60 + minute : -1;
  } catch {
    return -1;
  }
}

function weekdayIST(ms) {
  try {
    const label = IST_WEEKDAY_FORMATTER.format(new Date(ms));
    return ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'].indexOf(label);
  } catch {
    return -1;
  }
}

function dedupeTrades(history) {
  const map = new Map();
  for (const trade of Array.isArray(history) ? history : []) {
    if (!trade) continue;
    const key = trade.id || [trade.symbol, trade.openedAt, trade.closedAt, trade.entry, trade.exit].join('|');
    const previous = map.get(key);
    map.set(key, previous ? { ...previous, ...trade } : trade);
  }
  return [...map.values()].sort((a, b) => new Date(a?.openedAt || 0) - new Date(b?.openedAt || 0));
}

function isScalpTrade(trade) {
  return trade?.strategyFamily === 'SCALP' ||
    trade?.strategyTier === 'SCALP' ||
    /scalp/i.test(String(trade?.strategyTierLabel || ''));
}

function tradeCohort(trade) {
  const tier = String(trade?.strategyTier || '');
  const label = String(trade?.strategyTierLabel || '');
  const initiatedBy = String(trade?.initiatedBy || '').toUpperCase();
  if (trade?.shadowResearch === true || trade?.mode === 'SHADOW_RESEARCH' || tier.startsWith('SHADOW_')) return 'SHADOW';
  if (isScalpTrade(trade)) return initiatedBy === 'MENTOR' || String(trade?.entryMethod).toUpperCase() === 'AUTO' ? 'SCALP_AUTO' : 'SCALP_MANUAL';
  if (!tier && !trade?.strategyFamily && trade?.entryMandatoryPassCount == null) return 'LEGACY';
  return initiatedBy === 'USER' || trade?.manualResearch === true ? 'CORE_MANUAL' : 'CORE_AUTO';
}

function normaliseSide(value) {
  const side = String(value || '').toUpperCase();
  return side === 'CE' || side === 'PE' ? side : null;
}

function normaliseExitBucket(value) {
  const code = String(value || '').toUpperCase();
  if (code.includes('STOP')) return 'stop';
  if (code.includes('TARGET')) return 'target';
  if (code.includes('TIME')) return 'time';
  if (code.includes('GIVEBACK') || code.includes('PROFIT')) return 'protect';
  if (code.includes('SESSION')) return 'session';
  return 'other';
}

function countBy(rows, selector) {
  const out = {};
  for (const row of rows) {
    const key = selector(row);
    out[key] = (out[key] || 0) + 1;
  }
  return out;
}

function finite(value) {
  if (value == null || value === '') return null;
  const number = Number(value);
  return Number.isFinite(number) ? number : null;
}

function sum(values) {
  return values.reduce((total, value) => total + Number(value || 0), 0);
}

function average(values) {
  const rows = values.map(Number).filter(Number.isFinite);
  return rows.length ? sum(rows) / rows.length : 0;
}

function median(values) {
  const rows = values.map(Number).filter(Number.isFinite).sort((a, b) => a - b);
  if (!rows.length) return 0;
  const middle = Math.floor(rows.length / 2);
  return rows.length % 2 ? rows[middle] : (rows[middle - 1] + rows[middle]) / 2;
}
