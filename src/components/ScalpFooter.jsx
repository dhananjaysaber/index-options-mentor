import { useEffect, useRef } from 'react';

function checkedTime(value) {
  if (!value) return 'waiting';
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return 'waiting';
  return new Intl.DateTimeFormat('en-IN', {
    timeZone: 'Asia/Kolkata',
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
    hour12: false
  }).format(date);
}

export default function ScalpFooter({ snapshot, brokerStatus, refreshing, evaluation, positionMentor }) {
  const footerRef = useRef(null);
  let label = 'SCALP MENTOR';
  let message = 'Waiting for 3-minute scalp structure.';
  let tone = 'live';

  if (!brokerStatus?.authenticated) {
    label = 'SCALP OFFLINE';
    message = 'Connect FYERS to start scalp research.';
  } else if (refreshing) {
    label = 'SCALP CHECKING';
    message = 'Refreshing NIFTY context and the option candidate.';
  } else if (positionMentor) {
    label = 'SCALP POSITION';
    message = `${positionMentor.title}. ${positionMentor.copy}`;
    tone = positionMentor.alertLevel === 'exit' ? 'danger' : positionMentor.tone === 'go' ? 'good' : 'live';
  } else if (evaluation?.eligible) {
    tone = 'good';
    message = `${evaluation.side} scalp research is ready. Trigger ${format(evaluation.trigger)}, stop ${format(evaluation.stop)}, target ${format(evaluation.target)}.`;
  } else if (evaluation?.reason) {
    message = evaluation.reason;
  }

  useEffect(() => {
    const element = footerRef.current;
    if (!element || typeof ResizeObserver === 'undefined') return undefined;
    const publishHeight = () => {
      const height = Math.ceil(element.getBoundingClientRect().height);
      document.documentElement.style.setProperty('--scalp-footer-height', `${height}px`);
    };
    publishHeight();
    const observer = new ResizeObserver(publishHeight);
    observer.observe(element);
    window.addEventListener('resize', publishHeight);
    return () => {
      observer.disconnect();
      window.removeEventListener('resize', publishHeight);
      document.documentElement.style.removeProperty('--scalp-footer-height');
    };
  }, []);

  return (
    <footer ref={footerRef} className={`mentor-footer scalp-footer ${tone}`} aria-live="polite">
      <div className="mentor-footer-status" aria-hidden="true"><span className={`mentor-live-dot ${tone}`} /></div>
      <div className="mentor-footer-copy">
        <div className="mentor-footer-heading">
          <strong>{label}</strong>
          <span className="mentor-footer-last-refresh">LAST REFRESHED {refreshing ? 'UPDATING…' : checkedTime(snapshot?.generatedAt)}</span>
        </div>
        <span>{message}</span>
      </div>
    </footer>
  );
}

function format(value) {
  const n = Number(value);
  return Number.isFinite(n) && n > 0 ? n.toLocaleString('en-IN', { maximumFractionDigits: 2 }) : '—';
}
