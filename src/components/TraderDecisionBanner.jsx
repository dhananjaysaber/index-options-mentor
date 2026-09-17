import useLiveQuote from '../hooks/useLiveQuote.js';

export default function TraderDecisionBanner({ snapshot, loading }) {
  const liveQuote = useLiveQuote();
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
  const liveSpot = Number(liveQuote?.nifty);
  const displaySpot = Number.isFinite(liveSpot) && liveSpot > 0 ? liveSpot : Number(market.spot || 0);
  const isClosed = market.phase === 'CLOSED';
  const displayStage = isClosed ? decision.reviewState : decision.state;
  const label = stageLabel(displayStage);
  const directionReady = Boolean(decision.side);
  const parameterDataReady = parameters.length > 0;
  const openingRangePending = market.phase === 'LIVE' && decision.state === 'OPENING_RANGE' && !parameterDataReady;
  const directionPending = market.phase === 'LIVE' && !directionReady && !openingRangePending;
  const metricsPending = openingRangePending || directionPending;
  const mandatory = parameters.filter(row => row.mandatory);
  const mandatoryPassed = mandatory.filter(row => row.gatePassed === true).length;
  const mandatoryFailed = mandatory.filter(row => row.gatePassed === false).length;
  const confirmations = parameters.filter(row => !row.mandatory);
  const confirmationsGreen = confirmations.filter(row => row.status === 'green').length;

  const mentorCopy = isClosed
    ? `Latest completed session only. Review outcome: ${label}.`
    : decision.state === 'OPENING_RANGE'
      ? 'I am waiting for the first three completed 5-minute candles to define the opening range.'
      : decision.state === 'BREAKOUT_DETECTED'
        ? 'Price crossed the trigger, but I still need a completed 5-minute close before I trust the break.'
        : decision.state === 'RETESTING'
          ? 'The breakout close is confirmed. I am waiting to see whether the retest really holds.'
          : ['QUALIFIED', 'STRONG_SETUP'].includes(decision.state)
            ? 'The current rules have aligned. Check the execution plan before mirroring any broker trade.'
            : decision.state === 'NO_TRADE_DIRECTION'
              ? 'I do not have a clear call or put direction yet. I am waiting for trend and VWAP to agree.'
              : decision.state === 'RETEST_FAILED'
                ? 'The latest breakout failed its retest, so I have cancelled that setup and will wait for a fresh sequence.'
                : decision.state.startsWith('NO_TRADE')
                  ? 'A required rule is blocking this setup. Waiting is the correct action until the market improves.'
                  : 'The evidence is still developing. There is no need to anticipate the trade.';

  return (
    <section className={`decision-banner ${decision.tone} ${isClosed ? 'closed' : ''}`}>
      <div className="decision-banner-main">
        <div className="eyebrow">{isClosed ? 'SESSION REVIEW' : 'MENTOR DECISION'}</div>
        <h1>{decision.headline}</h1>
        <p>{mentorCopy}</p>
      </div>

      <div className="decision-banner-metrics">
        <div className="hero-metric">
          <span>NIFTY</span>
          <strong>{displaySpot.toLocaleString('en-IN', { maximumFractionDigits: 2 })}</strong>
          <small className={market.changePct >= 0 ? 'up' : 'down'}>
            {market.changePct >= 0 ? '+' : ''}{Number(market.changePct || 0).toFixed(2)}%
          </small>
        </div>
        <div className="hero-metric bias">
          <span>BIAS</span>
          <strong>{decision.side || 'NONE'}</strong>
          <small>{label}</small>
        </div>
        <div className={`hero-gate ${metricsPending ? 'pending' : mandatoryFailed ? 'fail' : 'pass'}`}>
          <span>MANDATORY</span>
          <strong>{metricsPending ? 'WAIT' : `${mandatoryPassed}/${mandatory.length || 5}`}</strong>
          <small>{openingRangePending ? 'OPEN RANGE' : directionPending ? 'BIAS FIRST' : mandatoryFailed ? 'GATE FAILED' : 'ALL PASSED'}</small>
        </div>
        <div className={`hero-confirm ${metricsPending ? 'pending' : ''}`}>
          <span>CONFIRM</span>
          <strong>{metricsPending ? '—' : `${confirmationsGreen}/${confirmations.length || 8}`}</strong>
          <small>{openingRangePending ? 'OPEN RANGE' : directionPending ? 'PENDING' : 'GREEN'}</small>
        </div>
        <div className={`hero-score ${metricsPending ? 'pending' : ''}`}>
          <span>{metricsPending || decision.score == null ? '—' : decision.score}</span>
          <small>{openingRangePending ? 'WAIT FOR RANGE' : directionPending ? 'WAIT FOR BIAS' : 'CONFLUENCE'}</small>
        </div>
      </div>
    </section>
  );
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
  return map[state] || state.replaceAll('_', ' ');
}
