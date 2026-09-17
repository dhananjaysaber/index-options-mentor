import { useEffect, useMemo, useState } from 'react';
import { buildManualResearchTicket, calculateSimulationSizing, classifyManualResearchSetup } from '../engine/researchStrategy.js';

export default function ManualResearchPanel({ snapshot, settings, onTakeTrade }) {
  const [lots, setLots] = useState(() => Number(settings?.defaultLots) || 1);
  const [capital, setCapital] = useState(() => Number(settings?.capital) || 50000);
  const manual = useMemo(() => classifyManualResearchSetup(snapshot), [snapshot]);

  useEffect(() => {
    setLots(Number(settings?.defaultLots) || 1);
    setCapital(Number(settings?.capital) || 50000);
  }, [settings?.defaultLots, settings?.capital]);

  const cleanLots = Math.max(1, Math.min(Number(settings?.lotCap) || 20, Math.round(Number(lots) || 1)));
  const cleanCapital = Math.max(10000, Number(capital) || Number(settings?.capital) || 50000);
  const sizing = snapshot?.option
    ? calculateSimulationSizing(snapshot, { ...settings, defaultLots: cleanLots, capital: cleanCapital })
    : null;

  function openManualResearch() {
    const ticket = buildManualResearchTicket(snapshot, settings, { lots: cleanLots, capital: cleanCapital });
    if (ticket) onTakeTrade(ticket);
  }

  return (
    <details className={`manual-research-card ${manual.eligible ? 'ready' : 'waiting'}`}>
      <summary className="manual-research-summary">
        <span>
          <small>MANUAL RESEARCH</small>
          <strong>Open your own experimental simulation</strong>
        </span>
        <span className="manual-research-summary-actions">
          <em>{manual.eligible ? 'READY' : 'WAIT'}</em>
          <i className="manual-research-toggle" aria-hidden="true" />
        </span>
      </summary>

      <div className="manual-research-body">
        <p className="manual-research-copy">
          Use this when you deliberately want to test a setup even though the automatic Mentor cohort has not approved it. The complete 13-point snapshot, entry time, option, price, gates and later exit are still journalled for analysis. You can close it manually at any time; if Mentor auto-close is enabled, the existing exit engine can also protect or close the research position.
        </p>

        <div className="manual-research-scoreline">
          <div><span>Mandatory</span><strong>{manual.mandatoryPassCount}/5</strong></div>
          <div><span>Confirmations</span><strong>{manual.confirmationPassCount}/8</strong></div>
          <div><span>Confluence</span><strong>{Number.isFinite(manual.score) ? Math.round(manual.score) : '—'}</strong></div>
          <div><span>Auto tier</span><strong>{manual.automaticTier || 'NOT APPROVED'}</strong></div>
        </div>

        <div className="manual-research-inputs">
          <label>
            <span>Research lots</span>
            <input
              type="number"
              inputMode="numeric"
              min="1"
              max={Math.max(1, Number(settings?.lotCap) || 20)}
              value={lots}
              onChange={event => setLots(event.target.value)}
            />
            <small>Default {settings?.defaultLots || 1} · maximum {settings?.lotCap || 20}</small>
          </label>
          <label>
            <span>Reference capital</span>
            <input
              type="number"
              inputMode="numeric"
              min="10000"
              step="5000"
              value={capital}
              onChange={event => setCapital(event.target.value)}
            />
            <small>Default ₹{Number(settings?.capital || 0).toLocaleString('en-IN')}</small>
          </label>
        </div>

        {sizing && (
          <div className={`manual-research-risk ${sizing.riskBudgetEligible ? 'eligible' : 'outside-budget'}`}>
            <span>Estimated simulated risk</span>
            <strong>₹{formatMoney(sizing.requiredRiskAmount)} · {formatNumber(sizing.requiredRiskPct)}%</strong>
            <small>{sizing.riskBudgetEligible ? 'Within the selected reference capital/risk budget.' : 'Outside the selected risk budget — allowed only because this is manual research, never a live-order approval.'}</small>
          </div>
        )}

        <div className="manual-research-status">
          <span>{manual.eligible ? 'READY FOR MANUAL RESEARCH' : 'WAITING'}</span>
          <strong>{manual.reason}</strong>
        </div>

        <button type="button" className="manual-research-open" disabled={!manual.eligible} onClick={openManualResearch}>
          OPEN MANUAL RESEARCH POSITION
        </button>
      </div>
    </details>
  );
}

function formatMoney(value) {
  const n = Number(value);
  return Number.isFinite(n) ? n.toLocaleString('en-IN', { maximumFractionDigits: 0 }) : '—';
}

function formatNumber(value) {
  const n = Number(value);
  return Number.isFinite(n) ? n.toFixed(2) : '—';
}
