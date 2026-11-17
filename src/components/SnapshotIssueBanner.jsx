export default function SnapshotIssueBanner({ message, authRequired = false, onReconnect, onRetry }) {
  if (!message) return null;
  const dailyLimit = /daily allowance exhausted|5[,.]?000 requests\/day|daily (?:api )?(?:request )?limit/i.test(message);
  return (
    <div className={`alert-bar mentor-snapshot-issue ${authRequired ? 'auth-required' : 'data-temporary'}`} role="alert">
      <div className="mentor-snapshot-issue-copy">
        <strong>{authRequired ? 'FYERS session needs reconnection' : 'Mentor data temporarily unavailable'}</strong>
        <span>{message}</span>
        {!authRequired && <small>{dailyLimit
          ? 'The FYERS daily quota is exhausted. Automatic requests are paused until the next market session; a manual retry cannot reset this quota. Existing simulated positions are preserved.'
          : 'Keeping the last completed snapshot and open simulated positions. New entries are paused until a fresh snapshot succeeds.'}</small>}
      </div>
      <button type="button" disabled={dailyLimit} onClick={authRequired ? onReconnect : onRetry}>
        {authRequired ? 'Reconnect FYERS' : dailyLimit ? 'Daily limit reached' : 'Retry Mentor'}
      </button>
    </div>
  );
}
