import { useEffect, useRef, useState } from 'react';
import './TradingSetup.css';
import { createOneTapBuy, plainReason } from '../services/oneTapBuy.js';
import { startTradingLogin } from '../services/tradingLogin.js';

const STRATEGIES = [['CORE', '13-point'], ['SCALP', 'Scalp']];
// The figures beside a Buy button are never more than a few seconds old.
const FRESH_MS = 6000;

export default function LiveOrderPanel({ tradeAmount }) {
  const [status, setStatus] = useState(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [preview, setPreview] = useState(null);
  const [outcomes, setOutcomes] = useState({});
  const [buying, setBuying] = useState({});
  const [now, setNow] = useState(Date.now);
  const running = useRef(false);
  const tapBuy = useRef(null);
  if (!tapBuy.current) tapBuy.current = createOneTapBuy({ fetcher: (url, init) => fetch(url, init) });
  const amount = Number(tradeAmount);
  const enabled = status?.realMoneyEnabled === true;
  const exitsAllowed = enabled || status?.exitsAllowed === true;
  const heldWhileOff = !enabled && exitsAllowed && Boolean(status?.positions?.some(position => position.state !== 'PREPARED'));
  const money = value => Number.isFinite(Number(value)) && value != null ? new Intl.NumberFormat('en-IN', { style: 'currency', currency: 'INR', minimumFractionDigits: 0, maximumFractionDigits: 2 }).format(Number(value)) : '—';

  useEffect(() => {
    const timer = window.setInterval(() => setNow(Date.now()), 1000);
    return () => window.clearInterval(timer);
  }, []);

  // Keeps the option, quantity and cost beside each Buy button current. It saves
  // and sends nothing, and never uses the lock that Exit needs.
  useEffect(() => {
    let live = true, timer, asking = false;
    async function look() {
      window.clearTimeout(timer);
      if (!asking && document.visibilityState === 'visible' && amount > 0) {
        asking = true;
        const askedAt = Date.now();
        try {
          const data = await api('preview', { tradeAmount: amount });
          if (live) setPreview({ amount, askedAt, trades: data.preview.trades });
        } catch { if (live) setPreview(null); }
        if (enabled) await quietRefresh();
        asking = false;
      }
      if (live) timer = window.setTimeout(look, enabled ? 3000 : 15000);
    }
    if (status !== null) void look();
    return () => { live = false; window.clearTimeout(timer); };
  }, [amount, enabled, status !== null]);

  // Read-only status checks run on entry and when returning to the app.
  // Never restore a cached ON/OFF flag or automatically repeat an order action.
  useEffect(() => {
    const check = () => {
      if (document.visibilityState === 'visible') void run(refresh);
    };
    const timer = window.setTimeout(check, 0);
    window.addEventListener('focus', check);
    document.addEventListener('visibilitychange', check);
    return () => {
      window.clearTimeout(timer);
      window.removeEventListener('focus', check);
      document.removeEventListener('visibilitychange', check);
    };
  }, []);

  async function api(action, payload) {
    let response, data;
    try {
      response = await fetch('/api/orders/' + action, action === 'status' ? {} : {
        method: 'POST', headers: { 'content-type': 'application/json', 'x-iom-action': 'live-orders' }, body: JSON.stringify(payload)
      });
      data = await response.json();
    } catch {
      throw new Error(action === 'exit'
        ? 'The trade status is unclear. Check your FYERS orders before trying again.'
        : 'The trading server could not be reached. Check your connection and try again.');
    }
    if (!response.ok) {
      const messages = {
        FYERS_SESSION_REQUIRED: 'Connect FYERS on this page, then check the connection again.',
        FYERS_ACCOUNT_NOT_VERIFIED: 'Your FYERS login could not be checked. Reconnect FYERS and try again.',
        TRADING_LOGIN_NEEDED: 'Connect your trading account first.',
        ACCOUNT_DOES_NOT_MATCH_AWS: 'This FYERS login does not match the trading account saved on your server.'
      };
      const fallback = action === 'settings' ? 'The setting change could not be confirmed. Refresh the connection to check your current settings.'
        : action === 'stop' ? 'New entries could not be confirmed as paused. Refresh the connection before continuing.'
        : action === 'exit'
          ? 'The trade status is unclear. Check your FYERS orders before trying again.'
          : 'The trading connection could not be checked. Try again shortly.';
      throw new Error(messages[data.error] || fallback);
    }
    return data;
  }

  async function run(action) {
    if (running.current) return;
    running.current = true; setBusy(true); setError('');
    try { await action(); }
    catch (failure) { setError(failure.message || 'This step could not finish. Please try again.'); }
    finally { running.current = false; setBusy(false); }
  }
  async function refresh() { setStatus(null); setStatus(await api('status')); }
  async function quietRefresh() { try { setStatus(await api('status')); } catch {} }
  async function buy(strategy, shown) {
    // One tap: no confirmation and no Submit step. An ignored repeat changes nothing.
    const result = await tapBuy.current(strategy, shown, preview.amount, () => {
      setBuying(value => ({ ...value, [strategy]: true }));
      setOutcomes(value => ({ ...value, [strategy]: { kind: 'sending', message: 'Order waiting. Sending to your server…' } }));
    });
    if (result.kind === 'ignored') return;
    setBuying(value => ({ ...value, [strategy]: false }));
    setOutcomes(value => ({ ...value, [strategy]: result }));
    await quietRefresh();
  }

  return <section className="settings-card live-setup-card" aria-label="Real-money trading setup">
    <header className="live-setup-header">
      <div><span className="live-setup-eyebrow">REAL-MONEY TRADING</span><h2>Your trading connection</h2></div>
      <span className={`live-setup-badge ${enabled ? 'is-on' : 'is-off'}`}>{status ? status.waitingForTradingLogin ? 'Waiting for sign-in' : enabled ? 'Buying is ON' : 'Buying is OFF' : 'Connection not checked'}</span>
    </header>
    <p className="live-setup-lead">{!status ? 'Your connection is checked automatically when you open this page or return to the app.' : status.waitingForTradingLogin ? 'Your server is waiting for the trading account sign-in. It cannot send any order until you connect.' : enabled ? 'Real-money buying is enabled. One tap on Buy sends a real order. There is no second screen.' : 'Your server is connected. Real-money buying is switched off, so the Buy buttons are disabled.'}</p>

    <div className="live-setup-status-grid" aria-live="polite">
      <Status label="Trading connection" value={status ? status.waitingForTradingLogin ? 'Sign-in needed' : 'Connected' : 'Not checked'} />
      <Status label="Real-money buying" value={status ? status.waitingForTradingLogin ? 'Paused' : enabled ? 'ON' : 'OFF' : 'Not checked'} />
      <Status label="Real stop and exit test" value={status ? status.actualBrokerAcceptanceVerified ? 'Verified' : 'Not yet verified' : 'Not checked'} />
    </div>
    {status?.waitingForTradingLogin && <p className="live-setup-note" role="status">{status.buyingAfterLogin ? 'Warning: real-money buying is switched ON on your server. After you connect, Buy and any automatic buying you left on can send real orders.' : 'Real-money buying is switched off on your server. Connecting does not turn it on.'}</p>}
    {status && !status.waitingForTradingLogin && !status.actualBrokerAcceptanceVerified && <p className="live-setup-note">The connection is working. A real broker trade is still needed to verify the stop and automatic exit.</p>}
    {status?.attentionRequired && !status.mayHoldTrade && <p className="live-setup-error" role="alert">A trade needs attention. Check your positions and any open stop or sell orders in FYERS before continuing.</p>}

    {status?.partSales?.map(sale => <p className="live-setup-error" role="alert" key={sale.id}>{partSaleWarning(sale)}</p>)}

    {heldWhileOff && <p className="live-setup-note" role="status">Buying is off. Stops and sales for trades your server already holds still send real orders to FYERS.</p>}

    {status?.mayHoldTrade && <p className="live-setup-error" role="alert">Your server may be holding a trade and cannot manage it until you connect. Check your positions and open stop or sell orders in FYERS now.</p>}

    <div className="live-setup-step">
      <h3>Trading account sign-in</h3>
      <p>{!status?.tradingLogin ? 'Sign in with FYERS for your trading app. Do this each trading day.' : !status.tradingLogin.ready ? 'The one-time server setup for this button has not been done yet.' : status.tradingLogin.signedInToday && !status.waitingForTradingLogin ? 'Signed in today.' : 'Not signed in today. Tap the button and sign in with FYERS.'}</p>
      <button className="live-setup-button" type="button" disabled={busy || status?.tradingLogin?.ready === false} onClick={() => run(async () => { window.location.assign(await startTradingLogin((url, init) => fetch(url, init))); })}>Connect trading account</button>
    </div>

    <div className="live-setup-step">
      <div className="live-setup-step-heading"><span>1</span><div><h3>Check your connection</h3><p>Checked automatically when you return. You can also refresh it here. This does not buy anything.</p></div></div>
      <button className="live-setup-button" type="button" disabled={busy} onClick={() => run(refresh)}>{busy ? 'Please wait…' : 'Refresh connection'}</button>
    </div>

    <div className="live-setup-step">
      <div className="live-setup-step-heading"><span>2</span><div><h3>Buy with one tap</h3><p>One tap sends a real-money order. It will not pay more than the price shown. Safety checks can still refuse it.</p></div></div>
      <div className="live-setup-budget"><span>Amount per trade</span><strong>{money(tradeAmount)}</strong><small>Uses the amount entered below. Brokerage and other charges are extra.</small></div>
      <div className="live-setup-buy-list">
        {STRATEGIES.map(([strategy, name]) => {
          const current = preview && preview.amount === amount && now - preview.askedAt <= FRESH_MS ? preview.trades[strategy] : null;
          const shown = current?.available ? current : null;
          const outcome = outcomes[strategy];
          return <div className="live-setup-plan" role="region" aria-label={`${name} real-money buy`} key={strategy}>
            <span className="live-setup-real">REAL MONEY · {name}</span>
            {shown ? <>
              <h3>{shown.symbol}</h3>
              <div className="live-setup-plan-grid">
                <Status label="Quantity" value={`${shown.quantity} (${shown.lots} ${shown.lots === 1 ? 'lot' : 'lots'})`} />
                <Status label="Estimated cost" value={`${money(shown.premiumCost)} + charges`} />
                <Status label="Buy price · at most" value={money(shown.buyPrice)} />
                <Status label="Initial stop price" value={money(shown.initialStop)} />
              </div>
            </> : <p>{current ? plainReason(current.reason) : enabled ? 'Waiting for a current price.' : 'No current price to show.'}</p>}
            <button className="live-setup-button live-setup-buy" type="button" disabled={!shown || !enabled || Boolean(status?.attentionRequired) || Boolean(buying[strategy])} onClick={() => buy(strategy, shown)}>{buying[strategy] ? 'Order waiting…' : `Buy ${name} · real money`}</button>
            {outcome && <p className={`live-setup-outcome is-${outcome.kind}`} role={['warning', 'unclear'].includes(outcome.kind) ? 'alert' : 'status'}>{outcome.message}</p>}
          </div>;
        })}
      </div>
      {!status && <p className="live-setup-help">Waiting for the connection check. If it fails, use Refresh connection to try again.</p>}
    </div>

    {error && <div className="live-setup-error" role="alert"><strong>This step could not finish</strong><p>{error}</p></div>}

    {status?.needsChecking?.length > 0 && <div className="live-setup-step"><h3>Needs checking</h3>{status.needsChecking.map(trade => <div className="live-setup-position" key={trade.id}><div><strong>{trade.symbol} · quantity {trade.quantity}</strong><p>All or part of this trade was sold outside the app. Total profit or loss was not recorded. Check this trade in FYERS.</p></div></div>)}</div>}

    {status?.positions?.length > 0 && <div className="live-setup-step"><h3>Trades and plans on your server</h3>{status.positions.map(position => <div className="live-setup-position" key={position.id}><div><strong>{position.strategy === 'CORE' ? '13-point' : 'Scalp'} · {position.symbol}</strong><p>{status.partSales?.some(sale => sale.id === position.id && !sale.managing) ? 'Locked after a part sale. Your server is not managing this trade. Check FYERS.' : position.state === 'PREPARED' ? 'Plan only — no purchase confirmed.' : position.state === 'MANAGING' ? 'Position is being managed by your server.' : position.state === 'SUBMIT_REQUESTED' ? 'Order waiting — not confirmed as bought.' : 'Check the latest order status in FYERS.'}</p></div>{position.state !== 'PREPARED' && <button className="live-setup-button live-setup-exit" type="button" disabled={busy || !exitsAllowed || status.partSales?.some(sale => sale.id === position.id && !sale.managing)} onClick={() => run(async () => { await api('exit', { entryId: position.id }); await refresh(); })}>Exit this real position</button>}</div>)}</div>}

    {status && <details className="live-setup-details"><summary>Automatic real-money entries</summary><p>These switches control real trades. The paper-trading switches below are separate.</p>{!enabled && <p>Unavailable while real-money buying is switched off.</p>}
      <AutoToggle title="13-point automatic buying" checked={Boolean(status.settings?.mentorAutoOpen)} disabled={busy || !enabled} onChange={checked => run(async () => { await api('settings', { settings: { mentorAutoOpen: checked } }); await refresh(); })} />
      <AutoToggle title="Scalp automatic buying" checked={Boolean(status.settings?.scalpAutoOpen)} disabled={busy || !enabled} onChange={checked => run(async () => { await api('settings', { settings: { scalpAutoOpen: checked } }); await refresh(); })} />
      {enabled && <button className="live-setup-button live-setup-exit" type="button" disabled={busy} onClick={() => run(async () => { await api('stop', {}); await refresh(); })}>Pause new real entries</button>}
    </details>}
  </section>;
}

function partSaleWarning(sale) {
  const locked = 'The app is not managing this trade yet: the stop will not trail, and the app will not sell it at the end of the day. Check FYERS now.';
  if (sale.managing) return `Part of ${sale.symbol} was sold outside the app. The app reduced its stop and is managing the remaining quantity ${sale.held} again, including trailing and end-of-day selling. Check FYERS.`;
  return sale.stopReduced
    ? `Part of ${sale.symbol} was sold outside the app. FYERS showed quantity ${sale.held} left, and the app reduced its stop to ${sale.held} at the same stop price. ${locked}`
    : `Part of ${sale.symbol} was sold outside the app and quantity ${sale.held} was left. The app has NOT confirmed a smaller stop: it may still be for quantity ${sale.stopQuantity}. ${locked}`;
}
function Status({ label, value }) { return <div className="live-setup-stat"><span>{label}</span><strong>{value}</strong></div>; }
function AutoToggle({ title, checked, disabled, onChange }) { return <label className="live-setup-toggle"><span>{title}</span><input type="checkbox" checked={checked} disabled={disabled} onChange={event => onChange(event.target.checked)} /></label>; }
