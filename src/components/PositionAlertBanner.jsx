import { fmt, formatR } from '../engine/positionMentor.js';

export default function PositionAlertBanner({ position, mentor, onExit, alertsEnabled }) {
  if (!position || !mentor || mentor.alertLevel !== 'exit') return null;

  return (
    <section className="position-exit-alert" role="alert" aria-live="assertive">
      <div className="exit-alert-pulse">!</div>
      <div className="exit-alert-copy">
        <span>ACTION REQUIRED</span>
        <strong>{mentor.title}</strong>
        <p>{mentor.reason}</p>
      </div>
      <div className="exit-alert-metrics">
        <div><span>NIFTY</span><strong>{fmt(position.underlyingCurrent)}</strong></div>
        <div><span>R NOW</span><strong>{formatR(mentor.rMultiple)}</strong></div>
        <div><span>SCORE</span><strong>{mentor.currentScore}</strong></div>
        <div><span>ALERTS</span><strong>{alertsEnabled ? 'ON' : 'VISUAL ONLY'}</strong></div>
      </div>
      <button
        className="exit-alert-button"
        onClick={() => onExit({
          mentorState: mentor.title,
          reasonCode: mentor.reasonCode,
          reason: mentor.reason,
          rMultiple: mentor.rMultiple
        })}
      >
        EXIT PRACTICE TRADE
      </button>
    </section>
  );
}
