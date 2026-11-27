// Invented (not real) NIFTY sample days, built from a fixed seed.
export const DAY = '2026-11-25';
export const SYMBOL = { CE: 'NSE:SAMPLE25000CE', PE: 'NSE:SAMPLE25000PE' };
const epoch = hm => Date.parse(`${DAY}T${hm}:00+05:30`) / 1000;

function random(seed) {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6D2B79F5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}
const r2 = n => Math.round(n * 100) / 100;

export function sampleDay(seed) {
  const next = random(seed);
  const dir = next() < 0.5 ? 1 : -1;
  const drift = 2 + next() * 12;
  const noise = 2 + next() * 14;
  const count = 8 + Math.floor(next() * 55);
  const pullAt = 4 + Math.floor(next() * 14);
  const pull = next() * 45;
  const candles = [];
  // Previous session, for previous-day high and low.
  const prevMid = 25000 - dir * (40 + next() * 220);
  for (let i = 0; i < 20; i += 1) {
    const t = Date.parse('2026-11-24T09:15:00+05:30') / 1000 + i * 300;
    candles.push([t, r2(prevMid), r2(prevMid + 30), r2(prevMid - 30), r2(prevMid + (i % 2 ? 8 : -8)), 1000]);
  }
  let price = 25000;
  for (let i = 0; i < count; i += 1) {
    const open = price;
    let step = dir * drift * (i < 3 ? 0.4 : 1) + (next() - 0.5) * noise;
    if (i >= pullAt && i < pullAt + 3) step = -dir * pull / 3;
    const close = open + step;
    const high = Math.max(open, close) + next() * noise * 0.5;
    const low = Math.min(open, close) - next() * noise * 0.5;
    const volume = Math.round(800 + next() * 900 + (i > count - 4 ? next() * 1500 : 0));
    candles.push([epoch('09:15') + i * 300, r2(open), r2(high), r2(low), r2(close), volume]);
    price = close;
  }
  const nowMs = (epoch('09:15') + count * 300 + 30) * 1000;
  const spot = r2(price + (next() - 0.4) * dir * noise);
  const spread = next() < 0.85 ? 0.5 : 6;
  const ltp = r2(120 + next() * 120);
  const chain = ['CE', 'PE'].map(side => ({
    symbol: SYMBOL[side], option_type: side, strike_price: 25000, ltp,
    bid: r2(ltp - spread / 2), ask: r2(ltp + spread / 2),
    volume: spread > 1 ? 200 : 2500000, oi: spread > 1 ? 300 : 1800000,
    greeks: { delta: side === 'CE' ? 0.6 : -0.6, gamma: 0.001, theta: -9, vega: 6, iv: 13 }
  }));
  // Six 3-minute candles before "now", ending with an impulse candle.
  const bucket = Math.floor(nowMs / 1000 / 180) * 180;
  const size = 4 + next() * 22;
  const threeMinute = [];
  for (let i = 6; i >= 1; i -= 1) {
    const close = price - dir * (i - 1) * size * 0.4;
    const open = close - dir * size * (i === 1 ? 0.7 : 0.2);
    threeMinute.push([bucket - i * 180, r2(open), r2(Math.max(open, close) + size * 0.15),
      r2(Math.min(open, close) - size * 0.15), r2(close), 900]);
  }
  return {
    nowMs, threeMinute,
    market: {
      quoteResponse: { d: [{ v: { lp: spot, ch: 12, chp: 0.05 } }] },
      historyResponse: { candles },
      chainResponse: { data: { optionsChain: chain, indiavixData: { ltp: 13, ltpchp: 1 },
        putOi: 900, callOi: 800, expiryData: [{ date: '01-12-2026' }] } }
    },
    symbolLots: { [SYMBOL.CE]: { minLotSize: 65 }, [SYMBOL.PE]: { minLotSize: 65 } }
  };
}
