import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { rankStockCandidates } from '../engine/stockRanking.js';
import {
  readStockPaperPosition, createStockPaperTrade, finishStockPaperTrade, STOCK_POSITION_EVENT
} from '../services/stockPaperAutomation.js';

const AUTO_SIGNATURE_KEY = 'index-options-mentor-stock-last-auto-setup-v1';
const formatMoney = value => Number.isFinite(Number(value))
  ? new Intl.NumberFormat('en-IN', {style:'currency', currency:'INR', maximumFractionDigits: 2}).format(value) : '—';
const clamp = (lots, cap) => Math.max(1, Math.min(Math.max(1, Number(cap) || 5), Math.floor(Number(lots) || 1)));

export default function StockPaperPosition({ cards, manualTicket, settings, active = false, onCloseTrade }) {
  const [position, setPosition] = useState(readStockPaperPosition);
  const [manualLots, setManualLots] = useState(() => clamp(settings?.defaultLots, settings?.lotCap));
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState('');
  const [live, setLive] = useState(null);
  const locked = useRef(false);
  const controller = useRef(null);
  const lastAttempt = useRef({signature: '', at: 0});

  useEffect(() => {
    const update = () => setPosition(readStockPaperPosition());
    const quote = event => {
      const q = event?.detail;
      if (q?.symbol === readStockPaperPosition()?.symbol) setLive(q);
    };
    window.addEventListener(STOCK_POSITION_EVENT, update);
    window.addEventListener('storage', update);
    window.addEventListener('mentor:stock-paper-quote', quote);
    return () => {
      controller.current?.abort();
      window.removeEventListener(STOCK_POSITION_EVENT, update);
      window.removeEventListener('storage', update);
      window.removeEventListener('mentor:stock-paper-quote', quote);
    };
  }, []);

  const manualCard = useMemo(() => manualTicket ? rankStockCandidates(
    [manualTicket], { ...settings, defaultLots: manualLots }, Date.now()
  )[0] || null : null, [manualTicket, manualLots, settings]);

  const getQuote = useCallback(async (stock, symbol, signal) => {
    const underlying = 'NSE:' + stock + '-EQ';
    const started = Date.now();
    const response = await fetch('/api/fyers/quote?symbol=' +
      encodeURIComponent([underlying, symbol].join(',')), {
      cache: 'no-store',
      signal: AbortSignal.any([signal, AbortSignal.timeout(10000)])
    });
    const data = await response.json().catch(() => ({}));
    if (!response.ok) throw Error(data.error || 'FYERS quotes unavailable for Stock paper trade');
    if (Date.now() - started > 8000) throw Error('The quote took too long; please retry.');
    const get = id => data?.d?.find(row => row?.n === id && row?.s === 'ok')?.v;
    const equity = get(underlying), option = get(symbol);
    const spot = Number(equity?.lp), ask = Number(option?.ask), bid = Number(option?.bid);
    if (!(spot > 0 && ask > 0 && bid > 0 && ask >= bid)) {
      throw Error('FYERS has no current underlying price and positive option bid/ask.');
    }
    return {spot, ask, bid, at: new Date().toISOString()};
  }, []);

  const open = useCallback(async (card, initiatedBy = 'USER') => {
    if (!card || locked.current || readStockPaperPosition() ||
        card.validUntil <= Date.now()) return false;
    locked.current = true;
    setBusy(true);
    if (initiatedBy === 'USER') setMessage('');
    const request = new AbortController();
    controller.current = request;
    try {
      const quote = await getQuote(card.stock, card.symbol, request.signal);
      // The paper entry always rechecks the risk budget at the current ask.
      const trade = createStockPaperTrade(card, quote, settings, initiatedBy);
      if (initiatedBy === 'MENTOR') {
        try { localStorage.setItem(AUTO_SIGNATURE_KEY, trade.setupId); } catch {}
      }
      setPosition(trade);
      setMessage((initiatedBy === 'MENTOR' ? 'Mentor auto-opened' : 'Manually opened') +
        ' a simulated Stock option position. No FYERS order was submitted.');
      return true;
    } catch (error) {
      if (!request.signal.aborted) setMessage(error?.message || 'Cannot open the Stock paper position');
      return false;
    } finally {
      locked.current = false;
      controller.current = null;
      setBusy(false);
    }
  }, [getQuote, settings]);

  // Automatic entries are reserved for strictly confirmed 5m/3m setups.
  // WATCH/MANUAL_RESEARCH cards are NEVER automatically entered.
  const primary = cards.find(card => card.strictEligible !== false && card.status === 'CONFIRMED') || null;
  const signature = primary ? [primary.stock, primary.side, primary.confirmedAt, primary.symbol].join(':') : '';
  useEffect(() => {
    if (!active || settings?.stockAutoOpen === false || position || !primary ||
      !signature || primary.validUntil <= Date.now()) return;
    try {
      if (localStorage.getItem(AUTO_SIGNATURE_KEY) === signature) return;
    } catch {}
    if (lastAttempt.current.signature === signature && Date.now() - lastAttempt.current.at < 12000) return;
    lastAttempt.current = {signature, at: Date.now()};
    void open(primary, 'MENTOR');
  }, [active, settings?.stockAutoOpen, position?.id, signature, open]);

  async function close() {
    const current = readStockPaperPosition();
    if (locked.current || !current) return;
    locked.current = true;
    setBusy(true);
    setMessage('');
    const request = new AbortController();
    controller.current = request;
    try {
      const quote = await getQuote(current.stock, current.symbol, request.signal);
      const closed = finishStockPaperTrade(current, quote, 'MANUAL_EXIT', 'USER');
      if (!closed) throw Error('This Stock position was already closed in another tab.');
      setPosition(null);
      setLive(null);
      setMessage('Stock paper position closed at current FYERS bid. Recorded in Stock journal.');
    } catch (error) {
      if (!request.signal.aborted) setMessage(error?.message || 'Paper close failed');
    } finally {
      locked.current = false;
      controller.current = null;
      setBusy(false);
    }
  }

  const mark = live?.symbol === position?.symbol && Date.now() - Date.parse(live.at) < 4000
    ? Number(live.bid) : null;
  const indicativePnl = position && mark > 0 ? (mark - Number(position.entry)) * Number(position.quantity) : null;

  return <div className="stock-paper-controls" id="stock-paper-control">
    <div className="stock-paper-automation">
      <span><strong>Auto research & entry</strong><small>{settings?.stockAutoOpen === false ? 'OFF' : 'ON · Strict 5m/3m only'}</small></span>
      <span><strong>Auto manage & close</strong><small>{settings?.stockAutoClose === false ? 'OFF' : 'ON · Stop, target, trailing, time'}</small></span>
      <span><strong>Manual research</strong><small>Available from verified weekly/daily WATCH</small></span>
    </div>
    {message && <div className="stock-alert" role="status">{message}</div>}
    {position && <section className="stock-position-active panel">
      <div className="stock-position-topline"><span>SIMULATED STOCK POSITION</span><strong>{position.entryMethod} ENTRY</strong></div>
      <h3>{position.stock} · {position.side} · {position.strike} strike</h3>
      <p>{position.symbol} · {position.lots} lot(s) · {position.quantity} units</p>
      <div className="stock-position-stats">
        <span>Entry ask<strong>{formatMoney(position.entry)}</strong></span>
        <span>{indicativePnl == null ? 'Exit bid · waiting' : 'Indicative P&L'}<strong>{indicativePnl == null ? '—' : formatMoney(indicativePnl)}</strong></span>
        <span>Underlying stop<strong>{formatMoney(position.underlyingStop)}</strong></span>
        <span>Underlying target<strong>{formatMoney(position.underlyingTarget)}</strong></span>
      </div>
      <button type="button" disabled={busy} className="stock-paper-close" onClick={close}>
        {busy ? 'Checking fresh FYERS bid…' : 'Close paper position at FYERS bid'}
      </button>
      <p className="stock-paper-note">Auto exits use shared live quotes while the app is visible and connected. They are simulated — not exchange-side stop orders, and are not guaranteed if the app is closed or quotes stop arriving.</p>
    </section>}
    {!position && manualTicket && <section className="stock-manual-ticket panel">
      <div className="stock-position-topline"><span>MANUAL RESEARCH OVERRIDE</span><strong>{manualTicket.side}</strong></div>
      <h3>{manualTicket.stock} · {manualTicket.strike} · {manualTicket.expiry}</h3>
      <p>{manualTicket.warning}</p>
      <div className="stock-position-stats">
        <span>Option bid<strong>{formatMoney(manualTicket.bid)}</strong></span>
        <span>Option ask<strong>{formatMoney(manualTicket.ask)}</strong></span>
        <span>Stop (stock)<strong>{formatMoney(manualTicket.stop)}</strong></span>
        <span>Target (stock)<strong>{formatMoney(manualTicket.target)}</strong></span>
      </div>
      <label className="stock-lot-label">Paper lots
        <input type="number" min="1" max={Math.max(1, Number(settings?.lotCap) || 5)}
          value={manualLots} onChange={event=>setManualLots(clamp(event.target.value,settings?.lotCap))}/>
      </label>
      {manualCard
        ? <p>Estimated paper risk {formatMoney(manualCard.risk)} · reward {formatMoney(manualCard.reward)} · {manualCard.quantity} units.</p>
        : <p className="stock-alert">This contract currently fails the capital, risk, liquidity or reward check. Try fewer lots or a new scan.</p>}
      <button type="button" className="stock-paper-open" disabled={!active || busy || !manualCard}
        onClick={()=>open(manualCard,'USER')}>{busy ? 'Checking option price…' : 'Open MANUAL paper trade'}</button>
    </section>}
    {!position && cards.length > 0 && <div className="history-list">
      {cards.map(card=><section className="panel" key={card.symbol}>
        <div className="stock-position-topline"><span>CONFIRMED 5m/3m · PAPER ONLY</span><strong>{card.side}</strong></div>
        <h3>{card.stock} · {card.strike} · {card.expiry}</h3>
        <p>{card.setup} · {card.lots} lot(s) · {card.quantity} units</p>
        <p>Bid {formatMoney(card.bid)} / Ask {formatMoney(card.ask)} · Stop {formatMoney(card.stop)} · Target {formatMoney(card.target)}</p>
        <p>Risk {formatMoney(card.risk)} · reward {formatMoney(card.reward)} · {card.ratio.toFixed(2)}R</p>
        <button type="button" className="stock-paper-open" disabled={!active || busy || card.validUntil <= Date.now()}
          onClick={()=>open(card,'USER')}>Open paper position manually</button>
      </section>)}
    </div>}
  </div>;
}
