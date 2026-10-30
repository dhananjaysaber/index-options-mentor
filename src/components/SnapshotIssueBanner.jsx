export default function SnapshotIssueBanner({ message, authRequired = false, onReconnect, onRetry }) {
  if (!message) return null;
  return (
    <div className={`alert-bar mentor-snapshot-issue ${authRequired ? 'auth-required' : 'data-temporary'}`} role="alert">
      <div className="mentor-snapshot-issue-copy">
        <strong>{authRequired ? 'FYERS session needs reconnection' : 'Mentor data temporarily unavailable'}</strong>
        <span>{message}</span>
        {!authRequired && <small>Keeping the last completed snapshot and open simulated positions. New entries are paused until a fresh snapshot succeeds.</small>}
      </div>
      <button type="button" onClick={authRequired ? onReconnect : onRetry}>
        {authRequired ? 'Reconnect FYERS' : 'Retry Mentor'}
      </button>
    </div>
  );
}
