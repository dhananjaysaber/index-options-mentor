export default function LiveDecisionCard({ snapshot, loading }) {
  if (!snapshot) {
    return (
      <section className="decision-card neutral">
        <div>
          <div className="eyebrow">LIVE DECISION</div>
          <h1>{loading ? 'Loading live market data…' : 'Live mentor unavailable'}</h1>
          <p className="decision-copy">Connect FYERS or switch to Demo mode.</p>
        </div>
      </section>
    );
  }

  const { decision, market } = snapshot;

  return (
    <section className={`decision-card ${decision.tone}`}>
      <div>
        <div className="eyebrow">{market.phase === 'LIVE' ? 'LIVE DECISION' : 'SESSION REVIEW'}</div>
        <h1>{decision.headline}</h1>
        <p className="decision-copy">
          {decision.state === 'MARKET_CLOSED'
            ? 'The score below is for review of the latest completed session. No live trade is being suggested.'
            : decision.state === 'NO_TRADE'
              ? 'One or more non-negotiable conditions are not good enough. The setup is blocked.'
              : decision.state === 'RETESTING'
                ? 'Direction and breakout are present, but the mentor is waiting for the retest to complete.'
                : decision.state === 'QUALIFIED' || decision.state === 'STRONG_SETUP'
                  ? 'The rules support a trade setup. The score measures confluence, not the probability of winning.'
                  : 'The mentor is collecting confirmation. There is no need to force an entry.'}
        </p>
      </div>

      <div className="score-ring">
        <span>{decision.score}</span>
        <small>/100</small>
      </div>

      <div className="decision-stats">
        <div><span>NIFTY</span><strong>{market.spot.toLocaleString('en-IN')}</strong></div>
        <div><span>Bias</span><strong>{decision.side || 'None'}</strong></div>
        <div><span>Suggested R:R</span><strong>{decision.rr >= 1 ? `1 : ${decision.rr.toFixed(1)}` : 'Not viable'}</strong></div>
      </div>

      <div className="reason-box">
        <strong>Reasoning</strong>
        {decision.reasons.map((reason, index) => <p key={index}>{reason}</p>)}
      </div>
    </section>
  );
}
