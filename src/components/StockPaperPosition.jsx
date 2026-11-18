import { useEffect, useRef, useState } from 'react';
import { recordStockPaperEvent } from '../services/tradeJournal.js';
import { rankStockCandidates } from '../engine/stockRanking.js';

const key = 'index-options-mentor-stock-paper-position-v1';
const money = value => new Intl.NumberFormat('en-IN', { style: 'currency', currency: 'INR' }).format(value);

function loadPosition() {
  try { return JSON.parse(localStorage.getItem(key)) || null; }
  catch { return null; }
}

function journal(trade, type, eventId) {
  void Promise.resolve(recordStockPaperEvent(trade, type, eventId)).catch(error =>
    console.warn('Could not queue stock paper journal event', error));
}

export default function StockPaperPosition({ cards, manualTicket, onCloseTrade, settings }) {
  const [position, setPosition] = useState(loadPosition);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [manualLots, setManualLots] = useState(1);
  const manualCard = manualTicket?.score >= 85 && manualTicket.manualOverride && manualTicket.strictEligible === false
    ? rankStockCandidates([manualTicket], { ...settings, defaultLots: manualLots }, Date.now())[0] || null
    : null;
  const request = useRef(null);
  const locked = useRef(false);
  useEffect(() => () => request.current?.abort(), []);
  useEffect(() => {
    if (position) journal(position, 'TRADE_OPENED', `open:${position.id}`);
  }, [position?.id]);

  async function open(card) {
    if (card?.manualOverride && !(card?.score >= 85 && card?.strictEligible === false &&
      card?.weekBias === card?.dayBias && ['BULLISH', 'BEARISH'].includes(card?.weekBias))) {
      setError('Manual Stock research must have a verified aligned weekly/daily score of at least 85.');
      return;
    }
    if (locked.current || loadPosition() || card.validUntil <= Date.now()) {
      setError('The setup has expired or another stock paper position is already open. Scan again.');
      return;
    }
    locked.current = true;
    setBusy(true);
    setError('');
    const controller = new AbortController();
    request.current = controller;
    try {
      // A displayed 20-second-old ask is not a valid scalp paper fill.
      // Revalidate the exact FYERS option + stock quote immediately on click.
      const symbols = encodeURIComponent([`NSE:${card.stock}-EQ`, card.symbol].join(','));
      const requestedAt = Date.now();
      const response = await fetch(`/api/fyers/quote?symbol=${symbols}`, {
        cache: 'no-store', signal: AbortSignal.any([controller.signal, AbortSignal.timeout(10000)])
      });
      const data = await response.json().catch(() => ({}));
      if (!response.ok) throw new Error(data.error || 'Cannot confirm current stock option prices.');
      // FYERS v.tt is not a last-trade timestamp; protect fills using the
      // actual age of this authenticated, no-cache broker response instead.
      if (Date.now() - requestedAt > 8000) throw new Error('Stock option quote request was too slow. Please retry.');
      const get = symbol => data.d?.find(item => item.n === symbol && item.s === 'ok')?.v || null;
      const underlying = get(`NSE:${card.stock}-EQ`);
      const option = get(card.symbol);
      const spot = Number(underlying?.lp);
      const ask = Number(option?.ask);
      const bid = Number(option?.bid);
      if (!(spot > 0 && ask > 0 && bid > 0 && ask >= bid)) throw new Error('A fresh stock price and option ask are required for a paper entry.');
      if (!(spot >= card.min && spot <= card.max)) throw new Error('The stock moved outside the confirmed entry range. Please wait for a new setup.');
      const quantity = Number(card.quantity);
      const capital = Number(settings?.capital);
      const riskBudget = capital * Number(settings?.riskPct) / 100;
      const estimatedRisk = Math.abs(spot - card.stop) * card.delta * quantity + (ask - bid) * quantity + 100;
      const estimatedReward = Math.abs(card.target - spot) * card.delta * quantity - (ask - bid) * quantity - 100;
      if (!(quantity > 0 && capital > 0 && riskBudget > 0 && ask * quantity + 100 <= capital && estimatedRisk <= riskBudget && estimatedReward >= 1.2 * estimatedRisk)) {
        throw new Error('This paper setup no longer meets your capital, spread or risk limits. Re-scan.');
      }
      if (loadPosition()) throw new Error('Another stock paper position was opened in this browser.');
      const trade = {
        id: crypto.randomUUID(), mode: 'SIMULATION', strategyFamily: 'STOCK_SCALP',
        strategyTier: 'STOCK_SCALP', strategyTierLabel: 'Stock scalp · Paper',
        approvalState: card.manualOverride ? 'STOCK_WATCH_85_MANUAL' : 'STOCK_CONFIRMED', initiatedBy: 'USER', entryMethod: 'MANUAL',
        openedByMentor: false, autoManaged: false, manualResearch: true,
        openedAt: new Date().toISOString(), symbol: card.symbol, side: card.side,
        underlyingSymbol: `NSE:${card.stock}-EQ`, strike: card.strike, expiry: card.expiry,
        lots: card.lots, lotSize: card.lotSize, quantity: card.quantity, entry: ask,
        underlyingEntry: spot, underlyingStop: card.stop, underlyingTarget: card.target,
        rr: card.ratio, mentorSuggestionAtEntry: card.setup, entryOption: card,
        manualOverride: Boolean(card.manualOverride), researchScore: card.score ?? card.setupScore ?? null
      };
      localStorage.setItem(key, JSON.stringify(trade));
      setPosition(trade);
      setError('');
    } catch (failure) {
      if (!controller.signal.aborted) setError(failure.message || 'Could not verify the paper entry.');
    } finally {
      locked.current = false;
      setBusy(false);
      request.current = null;
    }
  }

  async function close() {
    if (locked.current || !position) return;
    locked.current = true;
    setBusy(true);
    setError('');
    const controller = new AbortController();
    request.current = controller;
    try {
      const symbols = encodeURIComponent([position.underlyingSymbol, position.symbol].join(','));
      const requestedAt = Date.now();
      const response = await fetch(`/api/fyers/quote?symbol=${symbols}`, {
        cache: 'no-store', signal: AbortSignal.any([controller.signal, AbortSignal.timeout(12000)])
      });
      const data = await response.json();
      if (!response.ok) throw new Error(data.error || 'Cannot refresh the paper exit quote.');
      if (Date.now() - requestedAt > 8000) throw new Error('Stock option exit quote took too long. Please retry.');
      const get = symbol => data.d?.find(row => row.n === symbol && row.s === 'ok')?.v || null;
      const option = get(position.symbol);
      const exit = Number(option?.bid);
      const spot = Number(get(position.underlyingSymbol)?.lp);
      if (!(exit > 0 && spot > 0)) throw new Error('A fresh bid and stock quote are required to close.');
      const closed = {
        ...position, closedAt: new Date().toISOString(), closedBy: 'USER', exitMethod: 'MANUAL',
        exitReasonCode: 'MANUAL_EXIT', exitReason: 'Closed from Stock Scanner using the displayed bid.',
        exit, currentPrice: exit, underlyingExit: spot, underlyingCurrent: spot,
        pnl: (exit - position.entry) * position.quantity,
        heldMinutes: Math.round((Date.now() - Date.parse(position.openedAt)) / 60000),
        rAchieved: (spot - position.underlyingEntry) * (position.side === 'CE' ? 1 : -1) /
          Math.abs(position.underlyingEntry - position.underlyingStop)
      };
      if (loadPosition()?.id !== position.id) throw new Error('This position was changed in another tab.');
      onCloseTrade(closed);
      localStorage.removeItem(key);
      setPosition(null);
    } catch (failure) {
      if (!controller.signal.aborted) setError(failure.message);
    } finally {
      setBusy(false);
      locked.current = false;
    }
  }

  return <>
    {error && <p role="alert">{error}</p>}
    {position && <section className="panel">
      <h2>Open paper position</h2>
      <p>{position.symbol} · {position.lots} lots · entry {money(position.entry)}</p>
      <button type="button" className="secondary-btn" disabled={busy} onClick={close}>{busy ? 'Checking exit quote…' : 'Paper close at bid'}</button>
      <p>Paper fills use the displayed ask and bid. Journal P&amp;L is before fees and extra slippage.</p>
    </section>}
    {!position && manualTicket && <section className="stock-manual-preview panel">
      <h2>Manual paper research · {manualTicket.stock} {manualTicket.side}</h2>
      <p><strong>WATCH {manualTicket.score}/100</strong> · Weekly {manualTicket.weekBias} · Daily {manualTicket.dayBias}</p>
      <p>{manualTicket.reason}</p>
      <p><strong>Verified option:</strong> {manualTicket.symbol} · {manualTicket.expiry} expiry · {manualTicket.lotSize} units/lot</p>
      <p><strong>Bid / Ask:</strong> {money(manualTicket.bid)} / {money(manualTicket.ask)} · Delta {Number(manualTicket.delta).toFixed(2)}</p>
      <p><strong>Underlying:</strong> {money(manualTicket.spot)} · Illustrative stop {money(manualTicket.stop)} · target {money(manualTicket.target)}</p>
      <p className="stock-paper-warning">{manualTicket.warning}</p>
      <label className="stock-lot-label">Paper lots
        <input type="number" min="1" max={Math.max(1, Number(settings?.lotCap) || 1)}
          value={manualLots} onChange={event => setManualLots(Math.max(1, Math.min(Number(settings?.lotCap) || 1, Math.floor(Number(event.target.value) || 1))))} />
      </label>
      {manualCard ? <p><strong>Estimated risk:</strong> {money(manualCard.risk)} · <strong>Estimated reward:</strong> {money(manualCard.reward)} · {manualCard.ratio.toFixed(2)}R · {manualCard.quantity} units</p>
        : <p role="status">This contract/lot selection does not pass the capital, spread, 1.2R reward-to-risk or risk-budget checks.</p>}
      <button type="button" className="secondary-btn" disabled={busy || !manualCard || manualTicket.validUntil <= Date.now()}
        onClick={() => open(manualCard)}>{busy ? 'Checking FYERS premium…' : 'Open manual paper position'}</button>
      <p>Simulated only. No broker order. This 85+ WATCH exception is not a confirmed 5-minute/3-minute entry.</p>
    </section>}
    <div className="history-list">
      {cards.map(card => (
        <section className="panel" key={card.symbol}>
          <h2>{card.stock} · Strong Buy {card.side}</h2>
          <p>{card.setup} · {card.strike} strike · {card.expiry}</p>
          <p>Stock entry range {money(card.min)}–{money(card.max)} · Stop {money(card.stop)} · Target {money(card.target)}</p>
          <p>Option bid {money(card.bid)} / ask {money(card.ask)} · {card.lots} lots ({card.quantity} units)</p>
          <p>Estimated risk {money(card.risk)} · Estimated reward {money(card.reward)} · {card.ratio.toFixed(2)}R</p>
          <button type="button" className="secondary-btn" disabled={Boolean(position) || busy || card.validUntil <= Date.now()} onClick={() => open(card)}>Paper open at ask</button>
        </section>
      ))}
    </div>
  </>;
}
