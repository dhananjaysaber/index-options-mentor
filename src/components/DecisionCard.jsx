export default function DecisionCard({ evaluation, scenario }) {
  return (
    <section className={`decision-card ${evaluation.tone}`}>
      <div>
        <div className="eyebrow">LIVE DECISION</div>
        <h1>{evaluation.headline}</h1>
        <p className="decision-copy">
          {evaluation.state === 'NO_TRADE'
            ? 'A non-negotiable condition has failed. The system blocks the setup regardless of the remaining score.'
            : evaluation.state === 'RETESTING'
              ? 'Direction is forming, but the setup has not earned an entry yet.'
              : evaluation.state === 'QUALIFIED'
                ? 'The rule set is satisfied. This is a confluence score, not a probability or guarantee.'
                : 'Mandatory gates are intact, but the confirmation stack is not strong enough yet.'}
        </p>
      </div>

      <div className="score-ring">
        <span>{evaluation.score}</span>
        <small>/100</small>
      </div>

      <div className="decision-stats">
        <div>
          <span>Underlying</span>
          <strong>{scenario.underlying.toLocaleString('en-IN', { maximumFractionDigits: 2 })}</strong>
        </div>
        <div>
          <span>Bias</span>
          <strong>{scenario.side || 'None'}</strong>
        </div>
        <div>
          <span>Suggested R:R</span>
          <strong>1 : {evaluation.rr.toFixed(1)}</strong>
        </div>
      </div>

      <div className="reason-box">
        <strong>Why</strong>
        {evaluation.reasons.map((reason, index) => <p key={index}>{reason}</p>)}
      </div>
    </section>
  );
}
