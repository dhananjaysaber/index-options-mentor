export default function TraderDecisionBanner({ snapshot, loading }) {
  if (!snapshot) {
    return (
      <section className="decision-banner neutral">
        <div>
          <div className="eyebrow">MENTOR DECISION</div>
          <h1>{loading ? 'Loading live market data…' : 'Live mentor unavailable'}</h1>
        </div>
      </section>
    );
  }

  const { decision, market, parameters = [] } = snapshot;
  const isClosed = market.phase === 'CLOSED';
  const displayStage = isClosed ? decision.reviewState : decision.state;
  const label = stageLabel(displayStage);
  const mandatory = parameters.filter(row => row.mandatory);
  const mandatoryPassed = mandatory.filter(row => row.gatePassed).length;
  const confirmations = parameters.filter(row => !row.mandatory);
  const confirmationsGreen = confirmations.filter(row => row.status === 'green').length;

  return (
    <section className={`decision-banner ${decision.tone} ${isClosed ? 'closed' : ''}`}>
      <div className="decision-banner-main">
        <div className="eyebrow">{isClosed ? 'SESSION REVIEW' : 'MENTOR DECISION'}</div>
        <h1>{decision.headline}</h1>
        <p>
          {isClosed
            ? `Latest completed session only. Review outcome: ${label}.`
            : decision.state === 'OPENING_RANGE'
              ? 'The first three 5-minute candles are still forming the opening range. Trading remains locked.'
              : decision.state === 'BREAKOUT_DETECTED'
                ? 'Price has crossed the trigger, but the mentor still requires a completed 5-minute close.'
                : decision.state === 'RETESTING'
                  ? 'The breakout close is confirmed. Entry remains blocked until the retest holds or fails.'
                  : ['QUALIFIED', 'STRONG_SETUP'].includes(decision.state)
                    ? 'The setup has passed the current rules. Use the execution plan on the right.'
                    : decision.state.startsWith('NO_TRADE') || decision.state === 'RETEST_FAILED'
                      ? 'The current setup is blocked. Protect capital and wait for a fresh sequence.'
                      : 'The evidence is still developing. No need to anticipate the trade.'}
        </p>
      </div>

      <div className="decision-banner-metrics">
        <div className="hero-metric">
          <span>NIFTY</span>
          <strong>{market.spot.toLocaleString('en-IN', { maximumFractionDigits: 2 })}</strong>
          <small className={market.changePct >= 0 ? 'up' : 'down'}>
            {market.changePct >= 0 ? '+' : ''}{market.changePct.toFixed(2)}%
          </small>
        </div>
        <div className="hero-metric bias">
          <span>BIAS</span>
          <strong>{decision.side || 'NONE'}</strong>
          <small>{label}</small>
        </div>
        <div className={`hero-gate ${mandatoryPassed === mandatory.length ? 'pass' : 'fail'}`}>
          <span>MANDATORY</span>
          <strong>{mandatoryPassed}/{mandatory.length || 5}</strong>
          <small>{mandatoryPassed === mandatory.length ? 'ALL PASSED' : 'GATE FAILED'}</small>
        </div>
        <div className="hero-confirm">
          <span>CONFIRM</span>
          <strong>{confirmationsGreen}/{confirmations.length || 8}</strong>
          <small>GREEN</small>
        </div>
        <div className="hero-score">
          <span>{decision.score}</span>
          <small>CONFLUENCE</small>
        </div>
      </div>
    </section>
  );
}

function stageLabel(state = '') {
  const map = {
    PREMARKET: 'Pre-market',
    OPENING_RANGE: 'Opening range',
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
  return map[state] || state.replaceAll('_', ' ');
}
