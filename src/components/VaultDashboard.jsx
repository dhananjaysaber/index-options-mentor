import MentorWorkflow from './MentorWorkflow.jsx';
import QuickChecklist from './QuickChecklist.jsx';
import TraderMarketPanel from './TraderMarketPanel.jsx';
import ParameterGrid from './ParameterGrid.jsx';
import LivePositionPanel from './LivePositionPanel.jsx';

function fmt(value, digits = 2) {
  return value == null || !Number.isFinite(Number(value))
    ? '—'
    : Number(value).toLocaleString('en-IN', { maximumFractionDigits: digits });
}

function stageLabel(state = '') {
  const map = {
    PREMARKET: 'Pre-market',
    OPENING_RANGE: 'Opening range',
    DATA_PENDING: 'Live data pending',
    NO_TRADE_DIRECTION: 'No trade · direction unclear',
    NO_TRADE_MANDATORY: 'No trade · mandatory gate failed',
    BIAS_FORMING: 'Bias forming',
    BREAKOUT_DETECTED: 'Breakout detected',
    RETESTING: 'Retest pending',
    RETEST_FAILED: 'Retest failed',
    NO_TRADE_RR: 'No trade · insufficient room',
    RETEST_HELD_WAIT: 'Retest held · wait',
    RETEST_HELD_WATCH: 'Retest held · caution',
    QUALIFIED: 'Qualified',
    STRONG_SETUP: 'Strong setup'
  };
  return map[state] || String(state || '').replaceAll('_', ' ');
}

function mentorCopy(snapshot) {
  if (!snapshot) return '';
  const { market = {}, decision = {}, parameters = [] } = snapshot;
  const failed = parameters.filter(row => row.mandatory && row.gatePassed === false);
  if (market.phase === 'CLOSED') {
    return failed.length
      ? `${failed.map(row => row.label).join(', ')} blocked the latest completed setup. Review only — no new position is allowed while the market is closed.`
      : 'Latest completed session shown for review only. No new position is allowed while the market is closed.';
  }
  if (decision.state === 'RETEST_FAILED') return 'The breakout failed its retest. That sequence is cancelled and the Mentor is waiting for a fresh setup.';
  if (failed.length) return `${failed.map(row => row.label).join(', ')} ${failed.length === 1 ? 'is' : 'are'} blocking approval. The Mentor will keep watching rather than force an entry.`;
  if (decision.state === 'BREAKOUT_DETECTED') return 'The trigger was crossed. A completed 5-minute close is still required before the break is trusted.';
  if (decision.state === 'RETESTING') return 'The breakout close is confirmed. The Mentor is now checking whether the retest actually holds.';
  if (['QUALIFIED', 'STRONG_SETUP'].includes(decision.state)) return 'The strategy has aligned. Execution, sizing and structural invalidation now determine whether the simulation can open.';
  return 'The Mentor is reading the current structure and waiting for the next confirmed step.';
}

function VaultHero({ snapshot, loading }) {
  if (!snapshot) {
    return (
      <section className="vault-hero loading">
        <div className="vault-hero-main">
          <span className="vault-kicker">MENTOR DECISION</span>
          <h1>{loading ? 'Loading live market data…' : 'Live mentor unavailable'}</h1>
        </div>
      </section>
    );
  }

  const { market = {}, decision = {}, parameters = [] } = snapshot;
  const state = market.phase === 'CLOSED' ? decision.reviewState : decision.state;
  const mandatory = parameters.filter(row => row.mandatory);
  const mandatoryPassed = mandatory.filter(row => row.gatePassed === true).length;
  const mandatoryFailed = mandatory.filter(row => row.gatePassed === false).length;
  const confirmations = parameters.filter(row => !row.mandatory);
  const confirmationPassed = confirmations.filter(row => row.status === 'green').length;
  const score = Number.isFinite(Number(decision.score)) ? Number(decision.score) : 0;
  const radius = 56;
  const circumference = 2 * Math.PI * radius;
  const offset = circumference - (Math.max(0, Math.min(100, score)) / 100) * circumference;
  const tone = decision.tone || (mandatoryFailed ? 'red' : 'neutral');

  return (
    <section className={`vault-hero tone-${tone}`}>
      <div className="vault-hero-main">
        <span className="vault-kicker">{market.phase === 'CLOSED' ? 'SESSION REVIEW · LATEST COMPLETED' : 'MENTOR DECISION · LIVE'}</span>
        <h1>{decision.headline}</h1>
        <p>{mentorCopy(snapshot)}</p>
        <div className="vault-hero-stats">
          <div><span>NIFTY</span><strong className={Number(market.changePct) >= 0 ? 'positive' : 'negative'}>{fmt(market.spot)} {Number(market.changePct) >= 0 ? '+' : ''}{Number(market.changePct || 0).toFixed(2)}%</strong></div>
          <div><span>BIAS</span><strong>{decision.side || 'NONE'}</strong></div>
          <div><span>MANDATORY</span><strong className={mandatoryFailed ? 'negative' : 'positive'}>{mandatoryPassed}/{mandatory.length || 5}</strong></div>
          <div><span>CONFIRM</span><strong>{confirmationPassed}/{confirmations.length || 8}</strong></div>
        </div>
      </div>
      <div className="vault-gauge-panel">
        <span className="vault-gauge-label">CONFLUENCE SCORE</span>
        <div className="vault-gauge">
          <svg viewBox="0 0 140 140" aria-hidden="true">
            <circle cx="70" cy="70" r={radius} className="vault-gauge-track" />
            <circle cx="70" cy="70" r={radius} className="vault-gauge-arc" strokeDasharray={circumference} strokeDashoffset={offset} transform="rotate(-90 70 70)" />
            <line x1="70" y1="7" x2="70" y2="14" className="vault-gauge-tick" />
            <line x1="70" y1="126" x2="70" y2="133" className="vault-gauge-tick" />
            <line x1="7" y1="70" x2="14" y2="70" className="vault-gauge-tick" />
            <line x1="126" y1="70" x2="133" y2="70" className="vault-gauge-tick" />
          </svg>
          <div className="vault-gauge-number"><strong>{decision.score == null ? '—' : decision.score}</strong><span>OF 100</span></div>
        </div>
        <div className="vault-gauge-foot">{mandatoryPassed}/{mandatory.length || 5} mandatory cleared · {stageLabel(state)}</div>
      </div>
    </section>
  );
}

export default function VaultDashboard({ snapshot, loading, mode, positionCard, position, history, onExit }) {
  return (
    <div className="vault-dashboard">
      <VaultHero snapshot={snapshot} loading={loading} />

      <section className="vault-ticket-slot">
        {positionCard}
      </section>

      <section className="vault-ledger-grid">
        <div className="vault-ledger-card vault-workflow-card">
          <div className="vault-section-head">
            <span>SESSION LEDGER</span>
            <strong>Mentor workflow</strong>
          </div>
          <MentorWorkflow snapshot={snapshot} />
        </div>

        <div className="vault-ledger-card vault-checklist-card">
          <div className="vault-section-head">
            <span>STRATEGY EVIDENCE</span>
            <strong>13-point checklist</strong>
          </div>
          <QuickChecklist rows={snapshot?.parameters || []} directionReady={Boolean(snapshot?.decision?.side)} />
        </div>
      </section>

      {mode === 'advanced' && snapshot && (
        <section className="vault-advanced-card">
          <div className="vault-section-head"><span>ADVANCED</span><strong>Evidence matrix</strong></div>
          <ParameterGrid rows={snapshot.parameters} directionReady={Boolean(snapshot?.decision?.side)} />
        </section>
      )}

      <section className="vault-context-card">
        <TraderMarketPanel snapshot={snapshot} />
      </section>

      {!position && (
        <section className="vault-session-card">
          <LivePositionPanel position={null} history={history} snapshot={snapshot} onExit={onExit} />
        </section>
      )}
    </div>
  );
}
