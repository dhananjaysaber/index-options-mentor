function fmt(value) {
  return value == null || !Number.isFinite(Number(value))
    ? '—'
    : Number(value).toLocaleString('en-IN', { maximumFractionDigits: 2 });
}

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

function plainGate(row) {
  const map = {
    chop: 'the market is too choppy',
    trend: 'the trend is not strong enough',
    vwap: 'price is not holding clearly on the correct side of VWAP',
    risk: 'there is not enough clean room for the stop and target',
    liquidity: 'the candidate option is not liquid enough'
  };
  return map[row?.id] || `${row?.label || 'a mandatory rule'} is not ready`;
}

function joinPlain(parts) {
  if (!parts.length) return '';
  if (parts.length === 1) return parts[0];
  if (parts.length === 2) return `${parts[0]} and ${parts[1]}`;
  return `${parts.slice(0, -1).join(', ')}, and ${parts.at(-1)}`;
}

function mentorMessage(snapshot, brokerStatus, refreshing, positionMentor) {
  if (!brokerStatus?.authenticated) {
    return 'Connect FYERS and I will start reading the live NIFTY market. I will not suggest a trade until the required checks are available.';
  }

  if (refreshing) {
    return 'I am checking the latest NIFTY quote, completed 5-minute candles and option data now. The screen will update when the fresh snapshot is ready.';
  }

  if (!snapshot) return 'I am getting the live market ready. No action is needed while the first snapshot loads.';

  const { market = {}, decision = {}, structure = {}, parameters = [] } = snapshot;
  const state = decision.state;
  const side = decision.side;

  if (positionMentor) {
    return `${positionMentor.title}. ${positionMentor.copy}`;
  }

  if (market.phase === 'CLOSED') {
    return 'The market is closed. I am showing the latest completed session for review only, and I will not approve a new trade.';
  }

  if (market.phase === 'PREMARKET') {
    return 'The regular market has not opened yet. I am waiting for live session data before judging direction.';
  }

  if (market.phase === 'OPENING_RANGE') {
    return 'The opening range is still forming. I need the first three completed 5-minute candles before I can use ORH and ORL properly.';
  }

  if (market.phase === 'DATA_PENDING') {
    return 'Live candles are temporarily delayed. I have locked trading rather than mixing old candles with the current price.';
  }

  if (!side) {
    const regime = parameters.find(row => row.id === 'chop');
    const regimeNote = regime && Number(regime.value) < 0.58
      ? ' The market is also choppy, so waiting is the safer decision.'
      : '';
    return `NIFTY is around ${fmt(market.spot)}. I do not have a clear call or put direction yet, so I am not choosing an option. I am waiting for trend and VWAP to agree.${regimeNote}`;
  }

  if (structure.retestFailed || state === 'RETEST_FAILED') {
    return `The latest ${side} breakout failed its retest. I have cancelled that setup. I will wait for a fresh breakout, a completed 5-minute close and a new retest.`;
  }

  const failedMandatory = parameters.filter(row => row.mandatory && row.gatePassed === false);
  if (state === 'NO_TRADE_MANDATORY' || failedMandatory.length) {
    const blockers = joinPlain(failedMandatory.map(plainGate));
    return `I can see a ${side} bias, but I am blocking the trade because ${blockers || 'a mandatory rule is not ready'}. I will wait instead of forcing an entry.`;
  }

  if (state === 'BIAS_FORMING') {
    const trigger = side === 'CE' ? market.orh : market.orl;
    return `I see a ${side} bias, but there is no confirmed breakout yet. I am watching ${side === 'CE' ? 'ORH' : 'ORL'} near ${fmt(trigger)} and will not chase price.`;
  }

  if (state === 'BREAKOUT_DETECTED') {
    return `Price has crossed the ${side === 'CE' ? 'ORH' : 'ORL'} area. I am waiting for a completed 5-minute candle to confirm the break before doing anything.`;
  }

  if (state === 'RETESTING') {
    return `The ${side} breakout has a completed close. Now I am watching the trigger near ${fmt(structure.trigger)} to see whether the retest genuinely holds.`;
  }

  if (state === 'NO_TRADE_RR') {
    return `The ${side} setup has structure, but the reward is too small for the risk. I am waiting for a better entry or more room.`;
  }

  if (state === 'RETEST_HELD_WAIT' || state === 'RETEST_HELD_WATCH') {
    return `The ${side} retest held, but the evidence is not strong enough for approval yet. I am keeping the trade locked until the remaining confirmations improve.`;
  }

  if (state === 'QUALIFIED' || state === 'STRONG_SETUP') {
    return `The ${side} setup has passed the current rules. Check the option, lot size, invalidation and target in the trade box before mirroring any broker trade.`;
  }

  return 'I am reading the market and waiting for the next confirmed step. No need to anticipate the trade.';
}

function footerTone(snapshot, refreshing, positionMentor) {
  if (refreshing) return 'checking';
  if (positionMentor?.alertLevel === 'exit') return 'danger';
  if (positionMentor?.tone === 'go') return 'good';
  const state = snapshot?.decision?.state;
  if (['QUALIFIED', 'STRONG_SETUP'].includes(state)) return 'good';
  if (state?.startsWith('NO_TRADE') || state === 'RETEST_FAILED') return 'danger';
  return 'live';
}

export default function MentorFooter({ snapshot, brokerStatus, refreshing, positionMentor }) {
  const tone = footerTone(snapshot, refreshing, positionMentor);
  const label = !brokerStatus?.authenticated ? 'MENTOR OFFLINE' : refreshing ? 'MENTOR CHECKING' : 'MENTOR SAYS';
  const message = mentorMessage(snapshot, brokerStatus, refreshing, positionMentor);
  const lastRefresh = checkedTime(snapshot?.generatedAt);

  return (
    <footer className={`mentor-footer ${tone}`} aria-live="polite">
      <div className="mentor-footer-status" aria-hidden="true">
        <span className={`mentor-live-dot ${tone}`} />
      </div>
      <div className="mentor-footer-copy">
        <div className="mentor-footer-heading">
          <strong>{label}</strong>
          <span className="mentor-footer-last-refresh">LAST REFRESHED {refreshing ? 'UPDATING…' : lastRefresh}</span>
        </div>
        <span>{message}</span>
      </div>
      <div className="mentor-footer-meta">
        <span>{brokerStatus?.authenticated ? 'AUTO 15s' : 'WAITING'}</span>
        <strong>{refreshing ? 'Refreshing latest snapshot…' : 'Live snapshot ready'}</strong>
      </div>
    </footer>
  );
}
