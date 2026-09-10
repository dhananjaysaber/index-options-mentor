import { useEffect, useMemo, useRef, useState } from 'react';
import TraderDecisionBanner from './components/TraderDecisionBanner.jsx';
import MentorWorkflow from './components/MentorWorkflow.jsx';
import QuickChecklist from './components/QuickChecklist.jsx';
import TraderMarketPanel from './components/TraderMarketPanel.jsx';
import LiveTradeTicket from './components/LiveTradeTicket.jsx';
import LivePositionPanel from './components/LivePositionPanel.jsx';
import ParameterGrid from './components/ParameterGrid.jsx';
import History from './components/History.jsx';
import PositionAlertBanner from './components/PositionAlertBanner.jsx';
import { derivePositionMentor } from './engine/positionMentor.js';

const STORAGE_KEY = 'index-options-mentor-history-v05';
const POSITION_KEY = 'index-options-mentor-open-position-v07';
const ALERTS_KEY = 'index-options-mentor-alerts-enabled-v07';

export default function App() {
  const [mode, setMode] = useState('simple');
  const [brokerStatus, setBrokerStatus] = useState({ configured: false, authenticated: false });
  const [snapshot, setSnapshot] = useState(null);
  const [loading, setLoading] = useState(true);
  const [liveError, setLiveError] = useState('');
  const [position, setPosition] = useState(() => {
    try { return JSON.parse(localStorage.getItem(POSITION_KEY) || 'null'); }
    catch { return null; }
  });
  const [settings, setSettings] = useState({ capital: 50000, riskPct: 1, lotCap: 5, maxDailyLosses: 2 });
  const [alertsEnabled, setAlertsEnabled] = useState(() => localStorage.getItem(ALERTS_KEY) === '1');
  const [notificationPermission, setNotificationPermission] = useState(() => (typeof Notification !== 'undefined' ? Notification.permission : 'unsupported'));
  const audioRef = useRef(null);
  const lastExitAlertRef = useRef('');
  const [history, setHistory] = useState(() => {
    try { return JSON.parse(localStorage.getItem(STORAGE_KEY) || '[]'); }
    catch { return []; }
  });

  async function refreshStatus() {
    try {
      const response = await fetch('/api/fyers/status');
      const data = await response.json();
      setBrokerStatus(data);
      return data;
    } catch {
      return { configured: false, authenticated: false };
    }
  }

  async function refreshSnapshot() {
    try {
      const response = await fetch('/api/fyers/mentor-snapshot');
      if (!response.ok) {
        const data = await response.json().catch(() => ({}));
        throw new Error(data.error || 'Live mentor data is unavailable.');
      }
      const data = await response.json();
      setSnapshot(data);
      setLiveError('');
      return data;
    } catch (error) {
      setLiveError(error.message);
      return null;
    } finally {
      setLoading(false);
    }
  }

  useEffect(() => {
    let cancelled = false;
    (async () => {
      const status = await refreshStatus();
      if (!cancelled && status.authenticated) await refreshSnapshot();
      else if (!cancelled) setLoading(false);
    })();
    return () => { cancelled = true; };
  }, []);

  // Full state-machine snapshot: candles + option chain + all 13 parameters.
  useEffect(() => {
    if (!brokerStatus.authenticated) return undefined;
    const timer = setInterval(refreshSnapshot, 15000);
    return () => clearInterval(timer);
  }, [brokerStatus.authenticated]);

  // An open simulated position receives a faster exact option quote.
  useEffect(() => {
    if (!position || !brokerStatus.authenticated) return undefined;
    const updatePosition = async () => {
      try {
        const symbols = `${position.symbol},NSE:NIFTY50-INDEX`;
        const response = await fetch(`/api/fyers/quote?symbol=${encodeURIComponent(symbols)}`);
        const data = await response.json();
        const nodes = Array.isArray(data?.d) ? data.d : [];
        const optionNode = nodes.find(node => node?.n === position.symbol || node?.v?.symbol === position.symbol);
        const niftyNode = nodes.find(node => node?.n === 'NSE:NIFTY50-INDEX' || node?.v?.symbol === 'NSE:NIFTY50-INDEX');
        const liveOption = Number(optionNode?.v?.lp);
        const liveNifty = Number(niftyNode?.v?.lp);
        setPosition(current => current ? {
          ...current,
          currentPrice: Number.isFinite(liveOption) ? liveOption : current.currentPrice,
          underlyingCurrent: Number.isFinite(liveNifty) ? liveNifty : (snapshot?.market?.spot ?? current.underlyingCurrent)
        } : current);
      } catch {}
    };
    updatePosition();
    const timer = setInterval(updatePosition, 5000);
    return () => clearInterval(timer);
  }, [position?.id, brokerStatus.authenticated, snapshot?.market?.spot]);

  useEffect(() => {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(history));
  }, [history]);

  useEffect(() => {
    if (position) localStorage.setItem(POSITION_KEY, JSON.stringify(position));
    else localStorage.removeItem(POSITION_KEY);
  }, [position]);


  useEffect(() => {
    localStorage.setItem(ALERTS_KEY, alertsEnabled ? '1' : '0');
  }, [alertsEnabled]);

  // Browsers require a user gesture before sound can play. If alerts were
  // enabled in an earlier session, the first click/tap silently primes audio.
  useEffect(() => {
    if (!alertsEnabled) return undefined;
    const primeOnce = () => {
      primeAlertAudio(audioRef);
      window.removeEventListener('pointerdown', primeOnce);
      window.removeEventListener('keydown', primeOnce);
    };
    window.addEventListener('pointerdown', primeOnce, { once: true });
    window.addEventListener('keydown', primeOnce, { once: true });
    return () => {
      window.removeEventListener('pointerdown', primeOnce);
      window.removeEventListener('keydown', primeOnce);
    };
  }, [alertsEnabled]);

  const positionMentor = useMemo(() => {
    if (!position) return null;
    const currentUnderlying = Number(position.underlyingCurrent ?? snapshot?.market?.spot);
    if (!Number.isFinite(currentUnderlying)) return null;
    return derivePositionMentor(position, snapshot, currentUnderlying);
  }, [position, snapshot]);

  useEffect(() => {
    if (!position || !positionMentor || positionMentor.alertLevel !== 'exit') {
      lastExitAlertRef.current = '';
      return;
    }
    if (!alertsEnabled) return;

    const signature = `${position.id}:${positionMentor.reasonCode}`;
    if (lastExitAlertRef.current === signature) return;
    lastExitAlertRef.current = signature;

    playExitTone(audioRef);
    sendBrowserExitNotification(position, positionMentor);
  }, [position?.id, positionMentor?.reasonCode, positionMentor?.alertLevel, alertsEnabled]);

  const dailyLosses = useMemo(() => history.filter(trade => {
    const d = new Date(trade.closedAt);
    const now = new Date();
    return d.toDateString() === now.toDateString() && Number(trade.pnl) < 0;
  }).length, [history]);

  const tradingBlocked = dailyLosses >= settings.maxDailyLosses;

  async function toggleAlerts() {
    if (alertsEnabled) {
      setAlertsEnabled(false);
      return;
    }

    primeAlertAudio(audioRef);
    let permission = notificationPermission;
    if (typeof Notification !== 'undefined' && Notification.permission === 'default') {
      try { permission = await Notification.requestPermission(); } catch {}
    } else if (typeof Notification !== 'undefined') {
      permission = Notification.permission;
    }
    setNotificationPermission(permission);
    setAlertsEnabled(true);
  }

  function takeTrade(ticket) {
    if (tradingBlocked || position || !ticket?.quantity) return;
    setPosition(ticket);
  }

  function exitTrade(meta = {}) {
    if (!position) return;

    const underlyingExit = Number(position.underlyingCurrent ?? snapshot?.market?.spot);
    const optionExit = Number(position.currentPrice);
    const pnl = (optionExit - position.entry) * position.quantity;
    const riskPoints = Math.max(0.01, Math.abs(position.underlyingEntry - position.underlyingStop));
    const movePoints = position.side === 'CE'
      ? underlyingExit - position.underlyingEntry
      : position.underlyingEntry - underlyingExit;
    const rAchieved = movePoints / riskPoints;
    const heldMinutes = Math.max(0, Math.round((Date.now() - new Date(position.openedAt).getTime()) / 60000));

    const closed = {
      ...position,
      exit: optionExit,
      underlyingExit,
      pnl,
      rAchieved,
      heldMinutes,
      exitReasonCode: meta.reasonCode || inferExitReason(position, underlyingExit),
      exitReason: meta.reason || 'Manual simulated exit.',
      exitMentorState: meta.mentorState || 'MANUAL EXIT',
      closedAt: new Date().toISOString(),
      exitSnapshot: snapshot ? {
        market: { ...snapshot.market },
        decision: { ...snapshot.decision },
        parameters: snapshot.parameters
      } : null
    };

    setHistory(prev => [closed, ...prev].slice(0, 1000));
    setPosition(null);
  }

  const positionCard = position
    ? <LivePositionPanel position={position} onExit={exitTrade} history={history} snapshot={snapshot} sticky />
    : <LiveTradeTicket snapshot={snapshot} settings={settings} onTakeTrade={takeTrade} blocked={tradingBlocked} />;

  return (
    <div className="app-shell">
      <header className="topbar">
        <div className="brand-group">
          <div className="brand-mark">IO</div>
          <div>
            <div className="brand-kicker">DATA-DRIVEN TRADING MENTOR</div>
            <div className="brand-title">Index Options Mentor</div>
          </div>
        </div>

        <div className="topbar-actions">
          <span className={`connection-pill ${brokerStatus.authenticated ? 'connected' : ''}`}>
            FYERS {brokerStatus.authenticated ? 'Connected' : brokerStatus.configured ? 'Ready' : 'Not configured'}
          </span>
          {brokerStatus.configured && !brokerStatus.authenticated && (
            <a className="secondary-btn" href="/api/fyers/login">Connect FYERS</a>
          )}
          <button
            className={`secondary-btn alert-toggle ${alertsEnabled ? 'active' : ''}`}
            onClick={toggleAlerts}
            title={notificationPermission === 'denied' ? 'Browser notifications are blocked; sound/visual alerts can still work while this page is open.' : 'Enable sound and browser exit alerts.'}
          >
            {alertsEnabled ? (notificationPermission === 'granted' ? 'Alerts on' : 'Sound alerts on') : 'Enable alerts'}
          </button>
          {brokerStatus.authenticated && (
            <button className="secondary-btn" onClick={refreshSnapshot} title="Automatic updates are already active; this forces an immediate snapshot.">Refresh now</button>
          )}
        </div>
      </header>

      <main className="trader-main">
        <section className="trader-toolbar">
          <div className="segmented">
            <button className={mode === 'simple' ? 'active' : ''} onClick={() => setMode('simple')}>Simple</button>
            <button className={mode === 'advanced' ? 'active' : ''} onClick={() => setMode('advanced')}>Advanced</button>
          </div>

          <div className="toolbar-live"><span>DATA</span><strong>{brokerStatus.authenticated ? 'FYERS LIVE' : 'OFFLINE'}</strong></div>

          <label className="toolbar-input"><span>Capital</span><input type="number" value={settings.capital} min="10000" onChange={e => setSettings(s => ({ ...s, capital: Number(e.target.value) }))} /></label>
          <label className="toolbar-input"><span>Risk %</span><input type="number" value={settings.riskPct} min="0.1" max="5" step="0.1" onChange={e => setSettings(s => ({ ...s, riskPct: Number(e.target.value) }))} /></label>
          <label className="toolbar-input"><span>Lot cap</span><input type="number" value={settings.lotCap} min="1" max="20" onChange={e => setSettings(s => ({ ...s, lotCap: Number(e.target.value) }))} /></label>

          <div className={`loss-lock ${tradingBlocked ? 'blocked' : ''}`}><span>DAILY LOSS LOCK</span><strong>{dailyLosses} / {settings.maxDailyLosses}</strong></div>
        </section>

        {liveError && <div className="alert-bar">{liveError} Reconnect FYERS if the daily session has expired.</div>}
        {tradingBlocked && <div className="alert-bar">Daily protection is active. No new simulated trade can be opened today.</div>}
        {position && <div className="position-lock-bar">POSITION MODE ACTIVE — new entries are locked until this simulated position is closed.</div>}

        <PositionAlertBanner
          position={position}
          mentor={positionMentor}
          alertsEnabled={alertsEnabled}
          onExit={exitTrade}
        />

        <TraderDecisionBanner snapshot={snapshot} loading={loading} />
        <MentorWorkflow snapshot={snapshot} />
        <QuickChecklist rows={snapshot?.parameters || []} />

        {mode === 'simple' ? (
          <section className="trader-workspace simple-workspace">
            <div className="workspace-left">
              <TraderMarketPanel snapshot={snapshot} />
              {!position && <LivePositionPanel position={null} onExit={exitTrade} history={history} snapshot={snapshot} />}
              {position && <History history={history} />}
            </div>
            {positionCard}
          </section>
        ) : (
          <section className="trader-workspace advanced-workspace">
            <div className="workspace-left advanced-left">
              {snapshot && <ParameterGrid rows={snapshot.parameters} />}
              <History history={history} />
            </div>
            {positionCard}
          </section>
        )}
      </main>
    </div>
  );
}

function inferExitReason(position, underlyingExit) {
  const stopHit = position.side === 'CE'
    ? underlyingExit <= position.underlyingStop
    : underlyingExit >= position.underlyingStop;
  const targetHit = position.side === 'CE'
    ? underlyingExit >= position.underlyingTarget
    : underlyingExit <= position.underlyingTarget;

  if (stopHit) return 'STRUCTURE_INVALIDATED';
  if (targetHit) return 'TARGET_REACHED';
  return 'MANUAL_EXIT';
}


function primeAlertAudio(audioRef) {
  try {
    if (!audioRef.current) {
      const AudioContext = window.AudioContext || window.webkitAudioContext;
      if (!AudioContext) return;
      audioRef.current = new AudioContext();
    }
    if (audioRef.current.state === 'suspended') audioRef.current.resume();
  } catch {}
}

function playExitTone(audioRef) {
  try {
    primeAlertAudio(audioRef);
    const ctx = audioRef.current;
    if (!ctx) return;

    const now = ctx.currentTime;
    const notes = [
      { at: 0, freq: 880, duration: 0.18 },
      { at: 0.24, freq: 880, duration: 0.18 },
      { at: 0.48, freq: 660, duration: 0.32 }
    ];

    for (const note of notes) {
      const oscillator = ctx.createOscillator();
      const gain = ctx.createGain();
      oscillator.type = 'sine';
      oscillator.frequency.setValueAtTime(note.freq, now + note.at);
      gain.gain.setValueAtTime(0.0001, now + note.at);
      gain.gain.exponentialRampToValueAtTime(0.18, now + note.at + 0.015);
      gain.gain.exponentialRampToValueAtTime(0.0001, now + note.at + note.duration);
      oscillator.connect(gain);
      gain.connect(ctx.destination);
      oscillator.start(now + note.at);
      oscillator.stop(now + note.at + note.duration + 0.02);
    }
  } catch {}
}

function sendBrowserExitNotification(position, mentor) {
  try {
    if (typeof Notification === 'undefined' || Notification.permission !== 'granted') return;
    const body = `${mentor.reason} NIFTY ${Number(position.underlyingCurrent).toLocaleString('en-IN', { maximumFractionDigits: 2 })}. Exit the real broker position, then mirror the exit in Mentor.`;
    const notification = new Notification(`Index Options Mentor — ${mentor.title}`, {
      body,
      tag: `mentor-exit-${position.id}-${mentor.reasonCode}`,
      requireInteraction: true
    });
    notification.onclick = () => {
      window.focus();
      notification.close();
    };
  } catch {}
}
