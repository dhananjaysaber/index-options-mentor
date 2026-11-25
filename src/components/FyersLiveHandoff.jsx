import { useState } from 'react';

const FYERS_WEB_URL = 'https://fyers.in/web';

export default function FyersLiveHandoff({
  enabled = true,
  strategyLabel = 'Mentor',
  ready = false,
  reason = '',
  plan = null,
  riskStatus = 'review'
}) {
  const [copied, setCopied] = useState(false);
  if (!enabled || !plan) return null;

  const lines = [
    'Index Options Mentor — FYERS handoff',
    `Strategy: ${strategyLabel}`,
    `Direction: BUY ${plan.side || '—'}`,
    `Symbol: ${plan.symbol || '—'}`,
    `Lots: ${plan.lots ?? '—'}`,
    `Quantity: ${plan.quantity ?? '—'}`,
    `Option reference: ${money(plan.optionPrice)}`,
    `NIFTY reference: ${number(plan.niftyEntry)}`,
    `NIFTY invalidation: ${number(plan.stop)}`,
    `NIFTY target: ${number(plan.target)}`,
    `Planned R:R: ${ratio(plan.rr)}`,
    `Mentor state: ${plan.mentorState || '—'}`,
    'No broker order has been sent. Review and place the order yourself in FYERS.'
  ];

  async function copyPlan() {
    try {
      await navigator.clipboard.writeText(lines.join('\n'));
      setCopied(true);
      window.setTimeout(() => setCopied(false), 1800);
    } catch {
      setCopied(false);
    }
  }

  function openFyers() {
    window.open(FYERS_WEB_URL, '_blank', 'noopener,noreferrer');
  }

  return (
    <section className={`fyers-live-handoff ${ready ? 'ready' : 'blocked'}`}>
      <div className="fyers-handoff-head">
        <div>
          <span>TRADE DETAILS · MANUAL COPY</span>
          <strong>{ready ? 'Order plan ready for your review' : 'Live order plan not ready'}</strong>
        </div>
        <em>TEXT ONLY · NO ORDER SENT</em>
      </div>

      <div className="fyers-handoff-grid">
        <HandoffMetric label="Action" value={`BUY ${plan.side || '—'}`} />
        <HandoffMetric label="Contract" value={compactContract(plan)} />
        <HandoffMetric label="Lots / Qty" value={`${plan.lots ?? '—'} / ${plan.quantity ?? '—'}`} />
        <HandoffMetric label="Option ref." value={money(plan.optionPrice)} />
        <HandoffMetric label="NIFTY stop" value={number(plan.stop)} />
        <HandoffMetric label="NIFTY target" value={number(plan.target)} />
      </div>

      <div className={`fyers-handoff-risk ${riskStatus}`}>
        <span>{riskStatus === 'pass' ? 'RISK CHECK PASSED' : riskStatus === 'fail' ? 'RISK CHECK BLOCKED' : 'RISK CHECK — REVIEW'}</span>
        <strong>{reason || 'Review the Mentor plan before opening FYERS.'}</strong>
      </div>

      <div className="fyers-handoff-actions">
        <button type="button" className="fyers-handoff-copy" onClick={copyPlan}>
          {copied ? 'COPIED AS TEXT' : 'COPY TRADE DETAILS'}
        </button>
        <button type="button" className="fyers-handoff-open" onClick={openFyers}>
          OPEN FYERS
        </button>
      </div>

      <small className="fyers-handoff-disclaimer">
        This handoff does not submit, modify or cancel a real broker order. FYERS opens separately so you can review quantity, order type, price and charges before placing anything.
      </small>
    </section>
  );
}

function HandoffMetric({ label, value }) {
  return <div><span>{label}</span><strong>{value}</strong></div>;
}

function compactContract(plan) {
  if (plan?.strike && plan?.side) return `${plan.strike} ${plan.side}`;
  return plan?.symbol || '—';
}

function money(value) {
  const n = Number(value);
  return Number.isFinite(n) && n > 0 ? `₹${n.toLocaleString('en-IN', { maximumFractionDigits: 2 })}` : '—';
}

function number(value) {
  const n = Number(value);
  return Number.isFinite(n) && n > 0 ? n.toLocaleString('en-IN', { maximumFractionDigits: 2 }) : '—';
}

function ratio(value) {
  const n = Number(value);
  return Number.isFinite(n) && n > 0 ? `1 : ${n.toFixed(2)}` : '—';
}
