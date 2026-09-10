export const PARAMETERS = [
  { id: 'chop', label: 'Market regime', weight: 12, mandatory: true, detail: 'Reject repeated VWAP crossings, overlapping candles and two-sided whipsaw.' },
  { id: 'trend', label: 'Trend structure', weight: 12, mandatory: true, detail: 'Calls need higher highs / higher lows; puts need lower highs / lower lows.' },
  { id: 'vwap', label: 'VWAP alignment', weight: 10, mandatory: true, detail: 'Directional bias must agree with VWAP rather than fight it.' },
  { id: 'risk', label: 'Defined risk & room', weight: 10, mandatory: true, detail: 'A structural invalidation must exist and price must have enough room before the next barrier.' },
  { id: 'liquidity', label: 'Option liquidity', weight: 6, mandatory: true, detail: 'Spread, volume and tradability of the selected strike must be acceptable.' },

  { id: 'orb', label: 'Opening-range break', weight: 8, mandatory: false, detail: '15-minute ORH/ORL is broken in the intended direction.' },
  { id: 'close', label: '5-minute close', weight: 7, mandatory: false, detail: 'A completed 5-minute candle closes beyond the trigger level.' },
  { id: 'retest', label: 'Retest quality', weight: 10, mandatory: false, detail: 'Breakout level is retested and held/rejected before continuation.' },
  { id: 'pd', label: 'PDH / PDL confluence', weight: 6, mandatory: false, detail: 'Previous-day high/low or nearby support/resistance supports the setup.' },
  { id: 'volume', label: 'Volume expansion', weight: 5, mandatory: false, detail: 'Participation strengthens as the move confirms.' },
  { id: 'momentum', label: 'Momentum quality', weight: 5, mandatory: false, detail: 'Move has sufficient range/velocity rather than drifting.' },
  { id: 'htf', label: 'Higher-timeframe alignment', weight: 5, mandatory: false, detail: '15-minute context agrees with the 5-minute setup.' },
  { id: 'time', label: 'Time-of-day quality', weight: 4, mandatory: false, detail: 'Preferred windows receive more weight; poor midday conditions receive less.' }
];

export const DEMO_SCENARIOS = {
  choppy: {
    name: 'Choppy market',
    side: null,
    underlying: 25184.2,
    option: null,
    values: { chop: .15, trend: .35, vwap: .40, risk: .70, liquidity: .90, orb: .25, close: .30, retest: .20, pd: .50, volume: .35, momentum: .25, htf: .45, time: .90 }
  },
  retest: {
    name: 'Retest pending',
    side: 'CE',
    underlying: 25212.4,
    option: { symbol: 'NIFTY DEMO CE', strike: 25200, ltp: 181.4, lotSize: 65, delta: .58, expiry: 'Next weekly' },
    values: { chop: .88, trend: .82, vwap: .95, risk: .82, liquidity: .92, orb: .92, close: .90, retest: .38, pd: .72, volume: .78, momentum: .74, htf: .80, time: .90 }
  },
  ce: {
    name: 'Qualified CE',
    side: 'CE',
    underlying: 25224.8,
    option: { symbol: 'NIFTY DEMO CE', strike: 25200, ltp: 184.0, lotSize: 65, delta: .61, expiry: 'Next weekly' },
    values: { chop: .94, trend: .94, vwap: .98, risk: .90, liquidity: .95, orb: .94, close: .95, retest: .94, pd: .86, volume: .88, momentum: .91, htf: .90, time: .92 }
  },
  pe: {
    name: 'Qualified PE',
    side: 'PE',
    underlying: 25086.6,
    option: { symbol: 'NIFTY DEMO PE', strike: 25100, ltp: 176.5, lotSize: 65, delta: -.60, expiry: 'Next weekly' },
    values: { chop: .92, trend: .91, vwap: .96, risk: .87, liquidity: .94, orb: .92, close: .91, retest: .90, pd: .84, volume: .86, momentum: .89, htf: .88, time: .90 }
  }
};

const mandatoryPass = {
  chop: .70,
  trend: .65,
  vwap: .70,
  risk: .60,
  liquidity: .60
};

export function evaluateScenario(scenario) {
  const rows = PARAMETERS.map(parameter => {
    const value = scenario.values[parameter.id] ?? 0;
    const weighted = value * parameter.weight;
    const status = value >= .75 ? 'green' : value >= .50 ? 'yellow' : 'red';
    const gatePassed = !parameter.mandatory || value >= mandatoryPass[parameter.id];
    return { ...parameter, value, weighted, status, gatePassed };
  });

  const failedMandatory = rows.filter(row => row.mandatory && !row.gatePassed);
  const score = Math.round(rows.reduce((sum, row) => sum + row.weighted, 0));

  let state = 'WAIT';
  let headline = 'Wait for more confirmation';
  let tone = 'yellow';

  if (failedMandatory.length) {
    state = 'NO_TRADE';
    headline = 'No trade';
    tone = 'red';
  } else if (score >= 90) {
    state = 'QUALIFIED';
    headline = `High-confluence ${scenario.side || ''} setup`;
    tone = 'green';
  } else if (score >= 80) {
    state = 'QUALIFIED';
    headline = `${scenario.side || ''} setup qualified`;
    tone = 'green';
  } else if ((scenario.values.retest ?? 1) < .65 && (scenario.values.orb ?? 0) > .70) {
    state = 'RETESTING';
    headline = 'Retest pending';
    tone = 'yellow';
  }

  const rr =
    score >= 90 ? 2.0 :
    score >= 85 ? 1.5 :
    score >= 80 ? 1.3 :
    1.0;

  const reasons = [];
  if (failedMandatory.length) {
    reasons.push(...failedMandatory.map(row => `${row.label} failed the mandatory gate.`));
  } else {
    const yellow = rows.filter(row => row.status === 'yellow').slice(0, 3);
    if (yellow.length) reasons.push(...yellow.map(row => `${row.label} is not fully confirmed.`));
    const red = rows.filter(row => !row.mandatory && row.status === 'red').slice(0, 2);
    if (red.length) reasons.push(...red.map(row => `${row.label} is currently weak.`));
    if (!reasons.length) reasons.push('Mandatory gates are clear and the confirmation stack is strong.');
  }

  return { rows, score, state, headline, tone, rr, reasons, failedMandatory };
}

export function buildTradeTicket(scenario, evaluation, settings) {
  if (!scenario.option || evaluation.state !== 'QUALIFIED') return null;

  const entry = scenario.option.ltp;
  const premiumRisk = Math.max(4, Math.round(entry * .035 * 10) / 10);
  const stop = Math.round((entry - premiumRisk) * 20) / 20;
  const rr = evaluation.rr;
  const target = Math.round((entry + premiumRisk * rr) * 20) / 20;

  const maxRiskRupees = settings.capital * (settings.riskPct / 100);
  const riskPerLot = premiumRisk * scenario.option.lotSize;
  const riskLots = Math.floor(maxRiskRupees / riskPerLot);
  const lots = Math.max(0, Math.min(settings.lotCap, riskLots));

  return {
    side: scenario.side,
    symbol: scenario.option.symbol,
    strike: scenario.option.strike,
    expiry: scenario.option.expiry,
    delta: scenario.option.delta,
    lotSize: scenario.option.lotSize,
    entry,
    stop,
    target,
    rr,
    riskPerLot: Math.round(riskPerLot),
    maxRiskRupees: Math.round(maxRiskRupees),
    lots,
    quantity: lots * scenario.option.lotSize
  };
}
