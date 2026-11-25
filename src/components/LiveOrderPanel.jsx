import { useEffect, useRef, useState } from 'react';
import './TradingSetup.css';

export default function LiveOrderPanel({ tradeAmount }) {
  const [status, setStatus] = useState(null);
  const [plan, setPlan] = useState(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [now, setNow] = useState(Date.now);
  const pending = useRef(null);
  const running = useRef(false);
  const enabled = status?.realMoneyEnabled === true;
  const money = value => Number.isFinite(Number(value)) && value != null ? new Intl.NumberFormat('en-IN', { style: 'currency', currency: 'INR', minimumFractionDigits: 0, maximumFractionDigits: 2 }).format(Number(value)) : '—';
  const expiresIn = plan ? Math.max(0, Math.ceil(plan.expiresAt - now / 1000)) : 0;

  useEffect(() => {
    if (!plan) return undefined;
    setNow(Date.now());
    const timer = window.setInterval(() => setNow(Date.now()), 1000);
    return () => window.clearInterval(timer);
  }, [plan]);

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
      throw new Error(['submit', 'exit'].includes(action)
        ? 'The trade status is unclear. Check your FYERS orders before trying again.'
        : 'The trading server could not be reached. Check your connection and try again.');
    }
    if (!response.ok) {
      const messages = {
        FYERS_SESSION_REQUIRED: 'Connect FYERS on this page, then check the connection again.',
        FYERS_ACCOUNT_NOT_VERIFIED: 'Your FYERS login could not be checked. Reconnect FYERS and try again.',
        ACCOUNT_DOES_NOT_MATCH_AWS: 'This FYERS login does not match the trading account saved on your server.'
      };
      const fallback = action === 'prepare'
        ? 'A trade plan could not be prepared. No buy request was sent. Check the connection and try again when Mentor has a current setup.'
        : action === 'settings' ? 'The setting change could not be confirmed. Refresh the connection to check your current settings.'
        : action === 'stop' ? 'New entries could not be confirmed as paused. Refresh the connection before continuing.'
        : action === 'submit' || action === 'exit'
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
  async function prepare(strategy) {
    setPlan(null);
    await api('settings', { settings: { tradeAmount: Number(tradeAmount) } });
    if (!pending.current || pending.current.strategy !== strategy || Date.now() - pending.current.at > 15000) {
      pending.current = { strategy, id: crypto.randomUUID(), at: Date.now() };
    }
    const result = await api('prepare', { intentId: pending.current.id, strategy });
    setPlan(result.plan); await refresh();
  }
  async function submit() { await api('submit', { intentId: plan.intentId }); setPlan(null); await refresh(); }

  return <section className="settings-card live-setup-card" aria-label="Real-money trading setup">
    <header className="live-setup-header">
      <div><span className="live-setup-eyebrow">REAL-MONEY TRADING</span><h2>Your trading connection</h2></div>
      <span className={`live-setup-badge ${enabled ? 'is-on' : 'is-off'}`}>{status ? enabled ? 'Buying is ON' : 'Buying is OFF' : 'Connection not checked'}</span>
    </header>
    <p className="live-setup-lead">{!status ? 'Your connection is checked automatically when you open this page or return to the app.' : enabled ? 'Real-money buying is enabled. Review the price and quantity before submitting a trade.' : 'Your server is connected. Real-money buying is switched off. You can still review a trade plan.'}</p>

    <div className="live-setup-status-grid" aria-live="polite">
      <Status label="Trading connection" value={status ? 'Connected' : 'Not checked'} />
      <Status label="Real-money buying" value={status ? enabled ? 'ON' : 'OFF' : 'Not checked'} />
      <Status label="Real stop and exit test" value={status ? status.actualBrokerAcceptanceVerified ? 'Verified' : 'Not yet verified' : 'Not checked'} />
    </div>
    {status && !status.actualBrokerAcceptanceVerified && <p className="live-setup-note">The connection is working. A real broker trade is still needed to verify the stop and automatic exit.</p>}
    {status?.attentionRequired && <p className="live-setup-error" role="alert">A trade needs attention. Check your orders and positions in FYERS before continuing.</p>}

    <div className="live-setup-step">
      <div className="live-setup-step-heading"><span>1</span><div><h3>Check your connection</h3><p>Checked automatically when you return. You can also refresh it here. This does not buy anything.</p></div></div>
      <button className="live-setup-button" type="button" disabled={busy} onClick={() => run(refresh)}>{busy ? 'Please wait…' : 'Refresh connection'}</button>
    </div>

    <div className="live-setup-step">
      <div className="live-setup-step-heading"><span>2</span><div><h3>Review a trade</h3><p>Mentor selects the strike and calculates the lots. Reviewing a plan does not place an order.</p></div></div>
      <div className="live-setup-budget"><span>Amount per trade</span><strong>{money(tradeAmount)}</strong><small>Uses the amount entered below. Brokerage and other charges are extra.</small></div>
      <div className="live-setup-actions">
        <button className="live-setup-button" type="button" disabled={busy || !status || Boolean(status.attentionRequired)} onClick={() => run(() => prepare('CORE'))}>Review 13-point trade</button>
        <button className="live-setup-button" type="button" disabled={busy || !status || Boolean(status.attentionRequired)} onClick={() => run(() => prepare('SCALP'))}>Review Scalp trade</button>
      </div>
      {!status && <p className="live-setup-help">Waiting for the connection check. If it fails, use Refresh connection to try again.</p>}
    </div>

    {error && <div className="live-setup-error" role="alert"><strong>This step could not finish</strong><p>{error}</p></div>}

    {plan && <div className="live-setup-plan" role="region" aria-label="Trade plan review">
      <div className="live-setup-plan-heading"><div><span className="live-setup-eyebrow">TRADE PLAN · NOT PURCHASED</span><h3>{plan.payload.symbol}</h3></div><span>{expiresIn ? `Valid for ${expiresIn}s` : 'Plan expired'}</span></div>
      <div className="live-setup-plan-grid">
        <Status label="Buy option price · limit" value={money(plan.buyPrice)} />
        <Status label="Lots / quantity" value={`${plan.lots} lots / ${plan.payload.qty}`} />
        <Status label="Premium cost" value={money(plan.premiumCost)} />
        <Status label="Initial stop price" value={money(plan.initialStop)} />
      </div>
      <p>{!expiresIn ? 'This plan has expired. Review the trade again for current prices.' : !enabled ? 'You can review this plan, but buying remains switched off.' : 'Submitting this buy sends a real-money order to FYERS. The price and setup are checked again.'}</p>
      <button className="live-setup-button live-setup-buy" type="button" disabled={busy || !enabled || !expiresIn} onClick={() => run(submit)}>Submit this real buy</button>
    </div>}

    {status?.positions?.length > 0 && <div className="live-setup-step"><h3>Trades and plans on your server</h3>{status.positions.map(position => <div className="live-setup-position" key={position.id}><div><strong>{position.strategy === 'CORE' ? '13-point' : 'Scalp'} · {position.symbol}</strong><p>{position.state === 'PREPARED' ? 'Plan only — no purchase confirmed.' : position.state === 'MANAGING' ? 'Position is being managed by your server.' : 'Check the latest order status in FYERS.'}</p></div>{position.state !== 'PREPARED' && <button className="live-setup-button live-setup-exit" type="button" disabled={busy || !enabled} onClick={() => run(async () => { await api('exit', { entryId: position.id }); await refresh(); })}>Exit this real position</button>}</div>)}</div>}

    {status && <details className="live-setup-details"><summary>Automatic real-money entries</summary><p>These switches control real trades. The paper-trading switches below are separate.</p>{!enabled && <p>Unavailable while real-money buying is switched off.</p>}
      <AutoToggle title="13-point automatic buying" checked={Boolean(status.settings?.mentorAutoOpen)} disabled={busy || !enabled} onChange={checked => run(async () => { await api('settings', { settings: { mentorAutoOpen: checked } }); await refresh(); })} />
      <AutoToggle title="Scalp automatic buying" checked={Boolean(status.settings?.scalpAutoOpen)} disabled={busy || !enabled} onChange={checked => run(async () => { await api('settings', { settings: { scalpAutoOpen: checked } }); await refresh(); })} />
      {enabled && <button className="live-setup-button live-setup-exit" type="button" disabled={busy} onClick={() => run(async () => { await api('stop', {}); await refresh(); })}>Pause new real entries</button>}
    </details>}
  </section>;
}

function Status({ label, value }) { return <div className="live-setup-stat"><span>{label}</span><strong>{value}</strong></div>; }
function AutoToggle({ title, checked, disabled, onChange }) { return <label className="live-setup-toggle"><span>{title}</span><input type="checkbox" checked={checked} disabled={disabled} onChange={event => onChange(event.target.checked)} /></label>; }
