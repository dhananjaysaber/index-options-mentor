import { recordStockPaperEvent } from './tradeJournal.js';

export const STOCK_POSITION_KEY = 'index-options-mentor-stock-paper-position-v1';
export const STOCK_POSITION_EVENT = 'mentor:stock-paper-position';
export const STOCK_CLOSED_EVENT = 'mentor:stock-paper-closed';
let installed = false;
let closing = false;

export function readStockPaperPosition() {
  try {
    const value = localStorage.getItem(STOCK_POSITION_KEY);
    const result = value ? JSON.parse(value) : null;
    return result?.id && result.strategyFamily === 'STOCK_SCALP' && !result.closedAt ? result : null;
  } catch { return null; }
}
export function stockSettings() {
  try { return JSON.parse(localStorage.getItem('index-options-mentor-settings-v2') || '{}'); }
  catch { return {}; }
}
function publish(position) {
  if (typeof window !== 'undefined') window.dispatchEvent(new CustomEvent(STOCK_POSITION_EVENT, { detail: { position } }));
}
function positive(value) {
  const num = Number(value);
  return Number.isFinite(num) && num > 0 ? num : null;
}
const round = value => Math.round(Number(value) * 100) / 100;

export function calculateStockPaperExit(position, spot, now = Date.now()) {
  if (!position || !positive(spot) || !Number.isFinite(Number(position.underlyingStop)) ||
      !Number.isFinite(Number(position.underlyingTarget))) return null;
  const ce = position.side === 'CE', pe = position.side === 'PE';
  if (!ce && !pe) return null;
  const entry = Number(position.underlyingEntry), stop = Number(position.underlyingStop),
    target = Number(position.underlyingTarget);
  const distance = Math.abs(entry - stop);
  if (!(distance > 0) || !(ce ? stop < entry && target > entry : stop > entry && target < entry)) return null;
  const currentR = (Number(spot) - entry) * (ce ? 1 : -1) / distance;
  const bestR = Math.max(Number(position.bestR) || 0, currentR);
  // Never close based on speculative projections. Exits need an actual bid.
  if (ce ? spot <= stop : spot >= stop) return { reasonCode: 'STOCK_STOP', currentR, bestR };
  if (ce ? spot >= target : spot <= target) return { reasonCode: 'STOCK_TARGET', currentR, bestR };
  if (bestR >= 1 && currentR <= Math.max(.20, bestR - .65)) {
    return { reasonCode: 'STOCK_TRAILING_STOP', currentR, bestR };
  }
  const start = Date.parse(position.openedAt || '');
  const hold = Math.min(240, Math.max(1, Number(position.maxHoldMinutes) || 12));
  if (Number.isFinite(start) && now >= start + hold * 60000) {
    return { reasonCode: 'STOCK_TIME_LIMIT', currentR, bestR };
  }
  return { reasonCode: null, currentR, bestR };
}

function buildClosedTrade(position, quote, reasonCode, by = 'MENTOR') {
  const bid = positive(quote?.bid), spot = positive(quote?.spot);
  if (!bid || !spot) throw Error('A fresh valid stock and option bid are required for a paper exit');
  const currentR = (spot - position.underlyingEntry) * (position.side === 'CE' ? 1 : -1)
    / Math.max(.01, Math.abs(position.underlyingEntry - position.underlyingStop));
  const qty = Number(position.quantity);
  return {
    ...position, closedAt: new Date().toISOString(), closedBy: by,
    exitMethod: by === 'MENTOR' ? 'AUTO' : 'MANUAL',
    exitReasonCode: reasonCode,
    exitReason: {
      STOCK_STOP: 'Simulated underlying stop reached',
      STOCK_TARGET: 'Simulated underlying target reached',
      STOCK_TRAILING_STOP: 'Simulated underlying trailing profit protection triggered',
      STOCK_TIME_LIMIT: 'Simulated Stock maximum holding time reached',
      MANUAL_EXIT: 'Closed using fresh FYERS bid in Stock paper panel'
    }[reasonCode] || 'Stock paper position closed',
    exit: bid, currentPrice: bid, underlyingExit: spot, underlyingCurrent: spot,
    pnl: round((bid - Number(position.entry)) * qty),
    heldMinutes: Math.max(0, Math.round((Date.now() - Date.parse(position.openedAt)) / 60000)),
    rAchieved: round(currentR), bestR: Math.max(Number(position.bestR) || 0, currentR),
    quoteReceivedAt: quote.at
  };
}

export function finishStockPaperTrade(position, quote, reasonCode = 'MANUAL_EXIT', by = 'USER') {
  const current = readStockPaperPosition();
  if (!current || current.id !== position?.id) return null;
  const closed = buildClosedTrade(current, quote, reasonCode, by);
  localStorage.removeItem(STOCK_POSITION_KEY);
  publish(null);
  window.dispatchEvent(new CustomEvent(STOCK_CLOSED_EVENT, { detail: { trade: closed } }));
  void Promise.resolve(recordStockPaperEvent(closed, 'TRADE_CLOSED', 'close:' + closed.id)).catch(() => {});
  return closed;
}

export function createStockPaperTrade(card, quote, settings, initiatedBy = 'USER') {
  if (readStockPaperPosition()) throw Error('A Stock paper position is already open.');
  if (!(card?.validUntil > Date.now())) throw Error('The option ticket has expired. Re-scan.');
  const spot = positive(quote?.spot), ask = positive(quote?.ask), bid = positive(quote?.bid);
  const lotSize = Number(card.lotSize);
  const lots = Number(card.lots);
  const quantity = lots * lotSize;
  const capital = Number(settings?.capital), budget = capital * Number(settings?.riskPct) / 100;
  const delta = Math.abs(Number(card.delta));
  const stop = Number(card.stop), target = Number(card.target);
  const valid = (card.side === 'CE' ? stop < spot && target > spot : card.side === 'PE' && stop > spot && target < spot);
  const distance = Math.abs(spot - stop);
  const estimatedRisk = (distance * delta + (ask - bid)) * quantity + 100;
  const estimatedReward = Math.abs(target - spot) * delta * quantity - (ask - bid) * quantity - 100;
  const maxLots = Number(settings?.lotCap);
  if (!valid || !(spot >= card.min && spot <= card.max) || !(ask >= bid && bid > 0) ||
      !Number.isInteger(lots) || lots < 1 || lots > maxLots || !(Number.isSafeInteger(lotSize) && lotSize > 0) ||
      !(delta > 0 && delta <= 1) || !(capital > 0 && budget > 0) || !(quantity > 0) ||
      Math.min(Number(card.askSize), Number(card.bidSize)) < quantity ||
      ask * quantity + 100 > capital || estimatedRisk > budget || estimatedReward < 1.2 * estimatedRisk) {
    throw Error('The current option premium, spread, stop, reward or capital fails Stock paper risk checks.');
  }
  const trade = {
    id: crypto.randomUUID(), mode: 'SIMULATION', strategyFamily: 'STOCK_SCALP',
    strategyTier: 'STOCK_SCALP', strategyTierLabel: 'Stock Options · Paper',
    approvalState: card.strictEligible === false ? 'STOCK_MANUAL_RESEARCH' : 'STOCK_CONFIRMED',
    initiatedBy, entryMethod: initiatedBy === 'MENTOR' ? 'AUTO' : 'MANUAL',
    openedByMentor: initiatedBy === 'MENTOR', autoManaged: settings?.stockAutoClose !== false,
    manualResearch: card.strictEligible === false, openedAt: new Date().toISOString(),
    symbol: card.symbol, side: card.side, stock: card.stock,
    underlyingSymbol: card.underlyingSymbol || 'NSE:' + card.stock + '-EQ',
    strike: card.strike, expiry: card.expiry, lots, lotSize, quantity,
    entry: ask, currentPrice: bid, underlyingEntry: spot, underlyingCurrent: spot,
    underlyingStop: stop, underlyingTarget: target,
    maxHoldMinutes: Math.min(240, Math.max(1, Number(settings?.stockMaxHoldMinutes) || 12)),
    setupId: [card.stock, card.side, card.confirmedAt, card.symbol].join(':'),
    mentorSuggestionAtEntry: card.setup, entryOption: card,
    bestR: 0, currentR: 0, quoteReceivedAt: quote.at,
    entryRiskEstimate: round(estimatedRisk), entryRewardEstimate: round(estimatedReward),
    note: 'Simulated fills at FYERS ask/bid; no actual broker order or guaranteed fill'
  };
  localStorage.setItem(STOCK_POSITION_KEY, JSON.stringify(trade));
  publish(trade);
  void Promise.resolve(recordStockPaperEvent(trade, 'TRADE_OPENED', 'open:' + trade.id)).catch(() => {});
  return trade;
}

export function installStockPaperAutomation() {
  if (typeof window === 'undefined' || installed) return;
  installed = true;
  window.addEventListener('mentor:stock-paper-quote', event => {
    if (closing || document.visibilityState !== 'visible') return;
    const settings = stockSettings();
    if (settings.stockAutoClose === false) return;
    const position = readStockPaperPosition();
    const q = event.detail;
    if (!position || q?.symbol !== position.symbol) return;
    const at = Date.parse(q.at || '');
    if (!Number.isFinite(at) || Date.now() - at > 3500 || !positive(q.spot) || !positive(q.bid)) return;
    const status = calculateStockPaperExit(position, Number(q.spot));
    if (!status) return;
    if (!status.reasonCode) {
      if (status.bestR > Number(position.bestR) + .05) {
        const latest = readStockPaperPosition();
        if (latest?.id === position.id) {
          const updated = { ...latest, bestR: status.bestR, currentR: status.currentR,
            underlyingCurrent: Number(q.spot), currentPrice: Number(q.bid) };
          localStorage.setItem(STOCK_POSITION_KEY, JSON.stringify(updated));
          publish(updated);
        }
      }
      return;
    }
    closing = true;
    try { finishStockPaperTrade(position, q, status.reasonCode, 'MENTOR'); }
    catch (error) { console.warn('Simulated Stock automatic exit could not be recorded', error); }
    finally { closing = false; }
  });
}
