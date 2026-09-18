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
import MentorFooter from './components/MentorFooter.jsx';
import SettingsPanel from './components/SettingsPanel.jsx';
import MobileMentorDashboard from './components/MobileMentorDashboard.jsx';
import { derivePositionMentor } from './engine/positionMentor.js';
import { buildSimulatedTicket, classifyResearchSetup, tierEnabled } from './engine/researchStrategy.js';
import { syncJournalHistory } from './services/tradeJournal.js';
import { clearFyersSession, getFyersLoginUrl } from './services/apiBridge.js';

const HISTORY_KEY = 'index-options-mentor-history-v05';
const POSITION_KEY = 'index-options-mentor-open-position-v07';
const ALERTS_KEY = 'index-options-mentor-alerts-enabled-v07';
const THEME_KEY = 'index-options-mentor-theme-v1';
const SETTINGS_KEY = 'index-options-mentor-settings-v2';
const AUTO_SETUP_KEY = 'index-options-mentor-auto-setups-v1';

const DEFAULT_SETTINGS = {
  capital: 50000,
  riskPct: 1,
  defaultLots: 1,
  lotCap: 5,
  mentorAutoOpen: true,
  mentorAutoClose: true,
  controlledResearch: true,
  experimentalResearch: true
};

export default function AppV2() {
  const [view, setView] = useState('dashboard');
  const [mode, setMode] = useState('simple');
  const [mobileMenuOpen, setMobileMenuOpen] = useState(false);
  const [brokerStatus, setBrokerStatus] = useState({ configured: false, authenticated: false });
  const [snapshot, setSnapshot] = useState(null);
  const [loading, setLoading] = useState(true);
  const [refreshing, setRefreshing] = useState(false);
  const [liveError, setLiveError] = useState('');
  const [theme, setTheme] = useState(() => readString(THEME_KEY, 'light') === 'dark' ? 'dark' : 'light');
  const [settings, setSettings] = useState(() => ({ ...DEFAULT_SETTINGS, ...readJson(SETTINGS_KEY, {}) }));
  const [position, setPosition] = useState(() => readJson(POSITION_KEY, null));
  const [history, setHistory] = useState(() => readJson(HISTORY_KEY, []));
  const [alertsEnabled, setAlertsEnabled] = useState(() => readString(ALERTS_KEY, '0') === '1');
  const [notificationPermission, setNotificationPermission] = useState(() => typeof Notification !== 'undefined' ? Notification.permission : 'unsupported');
  const audioRef = useRef(null);
  const lastExitAlertRef = useRef('');
  const autoExitRef = useRef('');

  useEffect(() => {
    document.documentElement.dataset.theme = theme;
    localStorage.setItem(THEME_KEY, theme);
    const meta = document.querySelector('meta[name="theme-color"]');
    if (meta) meta.setAttribute('content', theme === 'dark' ? '#0b1220' : '#ffffff');
  }, [theme]);

  useEffect(() => { localStorage.setItem(SETTINGS_KEY, JSON.stringify(settings)); }, [settings]);
  useEffect(() => { localStorage.setItem(HISTORY_KEY, JSON.stringify(history)); }, [history]);
  useEffect(() => {
    if (position) localStorage.setItem(POSITION_KEY, JSON.stringify(position));
    else localStorage.removeItem(POSITION_KEY);
  }, [position]);
  useEffect(() => { localStorage.setItem(ALERTS_KEY, alertsEnabled ? '1' : '0'); }, [alertsEnabled]);

  useEffect(() => {
    let cancelled = false;
    const applyHistory = event => {
      const rows = event?.detail?.history;
      if (!cancelled && Array.isArray(rows)) setHistory(rows);
    };
    window.addEventListener('mentor:journal-history', applyHistory);
    syncJournalHistory().then(rows => {
      if (!cancelled && Array.isArray(rows)) setHistory(rows);
    }).catch(() => {});
    return () => {
      cancelled = true;
      window.removeEventListener('mentor:journal-history', applyHistory);
    };
  }, []);

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

  async function refreshSnapshot(options = {}) {
    const manual = options.manual === true;
    if (manual) setRefreshing(true);
    try {
      const response = await fetch('/api/fyers/mentor-snapshot', { cache: 'no-store' });
      if (!response.ok) {
        const data = await response.json().catch(() => ({}));
        throw new Error(data.error || 'Live mentor data is unavailable.');
      }
      const data = await response.json();
      setSnapshot(data);
      setLiveError('');
      return data;
    } catch (error) {
      setLiveError(error.message || 'Live mentor data is unavailable.');
      return null;
    } finally {
      setLoading(false);
      if (manual) setRefreshing(false);
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

  useEffect(() => {
    if (!brokerStatus.authenticated) return undefined;
    const timer = window.setInterval(refreshSnapshot, 15000);
    return () => window.clearInterval(timer);
  }, [brokerStatus.authenticated]);

  useEffect(() => {
    if (!position || !brokerStatus.authenticated) return undefined;
    const updatePosition = async () => {
      try {
        const symbols = `${position.symbol},NSE:NIFTY50-INDEX`;
        const response = await fetch(`/api/fyers/quote?symbol=${encodeURIComponent(symbols)}`, { cache: 'no-store' });
        const data = await response.json();
        const nodes = Array.isArray(data?.d) ? data.d : [];
        const optionNode = nodes.find(node => node?.n === position.symbol || node?.v?.symbol === position.symbol);
        const niftyNode = nodes.find(node => node?.n === 'NSE:NIFTY50-INDEX' || node?.v?.symbol === 'NSE:NIFTY50-INDEX');
        const liveOption = Number(optionNode?.v?.lp);
        const liveNifty = Number(niftyNode?.v?.lp);
        setPosition(current => updateLivePosition(current, liveOption, liveNifty, snapshot?.market?.spot));
      } catch {}
    };
    updatePosition();
    const timer = window.setInterval(updatePosition, 5000);
    return () => window.clearInterval(timer);
  }, [position?.id, brokerStatus.authenticated, snapshot?.market?.spot]);

  const setupClassification = useMemo(() => classifyResearchSetup(snapshot), [snapshot]);

  useEffect(() => {
    if (!position || !snapshot?.generatedAt) return;
    const currentClass = classifyResearchSetup(snapshot);
    setPosition(current => current ? {
      ...current,
      currentScore: snapshot.decision?.score,
      currentMandatoryPassCount: currentClass.mandatoryPassCount,
      currentConfirmationPassCount: currentClass.confirmationPassCount,
      currentMentorState: snapshot.decision?.state,
      currentMentorSuggestion: snapshot.decision?.headline,
      currentMentorReasons: snapshot.decision?.reasons || [],
      lastMentorAt: snapshot.generatedAt
    } : current);
  }, [snapshot?.generatedAt, position?.id]);

  const positionMentor = useMemo(() => {
    if (!position) return null;
    const currentUnderlying = Number(position.underlyingCurrent ?? snapshot?.market?.spot);
    if (!Number.isFinite(currentUnderlying)) return null;
    return derivePositionMentor(position, snapshot, currentUnderlying);
  }, [position, snapshot]);

  useEffect(() => {
    if (!settings.mentorAutoOpen || position || !setupClassification.eligible || !tierEnabled(setupClassification, settings)) return;
    const ledger = readJson(AUTO_SETUP_KEY, {});
    const key = setupClassification.setupId;
    if (!key || ledger[key]) return;
    const ticket = buildSimulatedTicket(snapshot, settings, 'MENTOR');
    if (!ticket) return;
    ledger[key] = { openedAt: ticket.openedAt, tier: ticket.strategyTier };
    pruneLedger(ledger);
    localStorage.setItem(AUTO_SETUP_KEY, JSON.stringify(ledger));
    setPosition(ticket);
  }, [snapshot?.generatedAt, position?.id, settings.mentorAutoOpen, settings.controlledResearch, settings.experimentalResearch, settings.defaultLots, settings.lotCap]);

  useEffect(() => {
    if (!position || !positionMentor || !settings.mentorAutoClose || positionMentor.alertLevel !== 'exit') {
      autoExitRef.current = '';
      return;
    }
    const signature = `${position.id}:${positionMentor.reasonCode}`;
    if (autoExitRef.current === signature) return;
    autoExitRef.current = signature;
    exitTrade({
      mentorState: positionMentor.title,
      reasonCode: positionMentor.reasonCode,
      reason: positionMentor.reason,
      rMultiple: positionMentor.rMultiple,
      closedBy: 'MENTOR'
    });
  }, [position?.id, positionMentor?.alertLevel, positionMentor?.reasonCode, settings.mentorAutoClose]);

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
    if (position || !ticket?.quantity) return;
    setPosition({ ...ticket, initiatedBy: ticket.initiatedBy || 'USER', openedByMentor: false });
  }

  function exitTrade(meta = {}) {
    setPosition(current => {
      if (!current) return current;
      const underlyingExit = Number(current.underlyingCurrent ?? snapshot?.market?.spot);
      const optionExit = Number(current.currentPrice);
      const pnl = (optionExit - current.entry) * current.quantity;
      const riskPoints = Math.max(0.01, Math.abs(current.underlyingEntry - current.underlyingStop));
      const movePoints = current.side === 'CE' ? underlyingExit - current.underlyingEntry : current.underlyingEntry - underlyingExit;
      const rAchieved = movePoints / riskPoints;
      const closedAt = new Date().toISOString();
      const heldMinutes = Math.max(0, Math.round((Date.now() - new Date(current.openedAt).getTime()) / 60000));
      const closed = {
        ...current,
        exit: optionExit,
        underlyingExit,
        pnl,
        rAchieved,
        heldMinutes,
        closedAt,
        closedBy: meta.closedBy || 'USER',
        exitReasonCode: meta.reasonCode || inferExitReason(current, underlyingExit),
        exitReason: meta.reason || 'Manual simulated exit.',
        exitMentorState: meta.mentorState || 'MANUAL EXIT',
        mentorSuggestionAtExit: snapshot?.decision?.headline || '',
        exitMandatoryPassCount: classifyResearchSetup(snapshot).mandatoryPassCount,
        exitConfirmationPassCount: classifyResearchSetup(snapshot).confirmationPassCount,
        exitSnapshot: snapshot ? { market: { ...snapshot.market }, decision: { ...snapshot.decision }, parameters: snapshot.parameters, structure: { ...snapshot.structure }, setup: { ...snapshot.setup } } : null
      };
      setHistory(previous => [closed, ...previous.filter(row => row.id !== closed.id)].slice(0, 1000));
      return null;
    });
  }

  function navigate(next) {
    setView(next);
    setMobileMenuOpen(false);
  }

  function showMobilePosition() {
    navigate('position');
  }

  function reconnectFyers() {
    clearFyersSession();
    setBrokerStatus(current => ({ ...current, authenticated: false }));
    setSnapshot(null);
    setLiveError('');
    setMobileMenuOpen(false);
    window.location.assign(getFyersLoginUrl());
  }

  const reconnectRequired = brokerStatus.authenticated && Boolean(liveError);

  const positionCard = position
    ? <LivePositionPanel position={position} onExit={exitTrade} history={history} snapshot={snapshot} sticky />
    : <LiveTradeTicket snapshot={snapshot} settings={settings} onTakeTrade={takeTrade} blocked={false} />;

  return (
    <div className="app-shell mentor-v2-shell">
      <header className="topbar mentor-v2-topbar">
        <button className="brand-group brand-button" onClick={() => navigate('dashboard')} type="button">
          <div className="brand-mark">IO</div>
          <div><div className="brand-kicker">DATA-DRIVEN TRADING MENTOR</div><div className="brand-title">Index Options Mentor</div></div>
        </button>
        <div className="mentor-v2-desktop-actions">
          <span className={`connection-pill ${reconnectRequired ? 'reconnect-required' : brokerStatus.authenticated ? 'connected' : ''}`}>FYERS {reconnectRequired ? 'Reconnect' : brokerStatus.authenticated ? 'Connected' : brokerStatus.configured ? 'Ready' : 'Offline'}</span>{reconnectRequired && <button className="secondary-btn fyers-reconnect-btn" onClick={reconnectFyers}>Reconnect FYERS</button>}
          <button className="secondary-btn theme-toggle" onClick={() => setTheme(current => current === 'dark' ? 'light' : 'dark')} title="Toggle theme">{theme === 'dark' ? <SunIcon /> : <MoonIcon />}</button>
          <button className={`secondary-btn ${alertsEnabled ? 'active' : ''}`} onClick={toggleAlerts}>{alertsEnabled ? 'Alerts on' : 'Enable alerts'}</button>
          {brokerStatus.authenticated && <button className={`secondary-btn refresh-btn ${refreshing ? 'refreshing' : ''}`} onClick={() => refreshSnapshot({ manual: true })} disabled={refreshing}>{refreshing ? 'Checking…' : 'Refresh now'}</button>}
        </div>
        <div className="mentor-v2-mobile-status"><span className={reconnectRequired ? 'reconnect' : brokerStatus.authenticated ? 'online' : ''} /></div>
        <button className="mentor-v2-menu-button" onClick={() => setMobileMenuOpen(true)} aria-label="Open menu"><MenuIcon /></button>
      </header>

      <DesktopNav view={view} navigate={navigate} settings={settings} setup={setupClassification} position={position} />

      {mobileMenuOpen && <MobileDrawer view={view} navigate={navigate} onPosition={showMobilePosition} position={position} onClose={() => setMobileMenuOpen(false)} brokerStatus={brokerStatus} mode={mode} setMode={setMode} settings={settings} theme={theme} setTheme={setTheme} alertsEnabled={alertsEnabled} toggleAlerts={toggleAlerts} refreshing={refreshing} refreshSnapshot={refreshSnapshot} liveError={liveError} onReconnect={reconnectFyers} />}

      <main className="mentor-v2-content">
        {view === 'dashboard' && (
          <>
            <section className="trader-toolbar mentor-v2-toolbar">
              <div className="segmented"><button className={mode === 'simple' ? 'active' : ''} onClick={() => setMode('simple')}>Simple</button><button className={mode === 'advanced' ? 'active' : ''} onClick={() => setMode('advanced')}>Advanced</button></div>
              <div className="toolbar-live"><span>DATA</span><strong>{brokerStatus.authenticated ? 'FYERS LIVE' : 'OFFLINE'}</strong></div>
              <ToolbarStat label="Capital" value={`₹${Number(settings.capital).toLocaleString('en-IN')}`} />
              <ToolbarStat label="Risk" value={`${settings.riskPct}%`} />
              <ToolbarStat label="Sim lots" value={settings.defaultLots} />
              <div className={`automation-pill ${settings.mentorAutoOpen ? 'on' : ''}`}><span>MENTOR AUTO</span><strong>{settings.mentorAutoOpen ? 'OPEN + MANAGE' : 'MANUAL'}</strong></div>
            </section>

            <MobileMentorDashboard
              mode={mode}
              snapshot={snapshot}
              loading={loading}
              liveError={liveError}
              position={position}
              positionMentor={positionMentor}
              alertsEnabled={alertsEnabled}
              history={history}
              settings={settings}
              onReconnect={reconnectFyers}
              onTakeTrade={takeTrade}
              onExit={exitTrade}
            />

            {liveError && <div className="alert-bar reconnect-alert"><span>{liveError} The saved FYERS session may have expired.</span><button type="button" onClick={reconnectFyers}>Reconnect FYERS</button></div>}
            {position && <div className="position-lock-bar">SIMULATED POSITION ACTIVE · OPENED BY {position.initiatedBy || 'USER'} · {position.strategyTierLabel || position.strategyTier || 'RESEARCH'}</div>}
            <PositionAlertBanner position={position} mentor={positionMentor} alertsEnabled={alertsEnabled} onExit={meta => exitTrade({ ...meta, closedBy: 'USER' })} />
            <TraderDecisionBanner snapshot={snapshot} loading={loading} />
            <ResearchStatus classification={setupClassification} position={position} settings={settings} />
            <MentorWorkflow snapshot={snapshot} />
            <QuickChecklist rows={snapshot?.parameters || []} directionReady={Boolean(snapshot?.decision?.side)} />

            {mode === 'simple' ? (
              <section className="trader-workspace simple-workspace mentor-v2-workspace">
                <div className="workspace-left"><TraderMarketPanel snapshot={snapshot} />{!position && <LivePositionPanel position={null} history={history} snapshot={snapshot} onExit={exitTrade} />}</div>
                {positionCard}
              </section>
            ) : (
              <section className="trader-workspace advanced-workspace mentor-v2-workspace">
                <div className="workspace-left advanced-left">{snapshot && <ParameterGrid rows={snapshot.parameters} directionReady={Boolean(snapshot?.decision?.side)} />}{!position && <LivePositionPanel position={null} history={history} snapshot={snapshot} onExit={exitTrade} />}</div>
                {positionCard}
              </section>
            )}
          </>
        )}

        {view === 'position' && (
          <div className="mentor-page position-page-v22">
            <div className="mentor-page-head position-page-head-v22">
              <div>
                <div className="eyebrow">POSITION</div>
                <h1>{position ? 'Open simulated position' : 'No simulated position'}</h1>
                <p>{position ? 'This page shows only the active position, live Mentor guidance and exit controls.' : 'There is no open simulated position. When you or the Mentor opens one, it will appear here automatically.'}</p>
              </div>
              <span className={position ? 'position-page-status open' : 'position-page-status'}>{position ? 'OPEN' : 'NO OPEN POSITION'}</span>
            </div>
            <LivePositionPanel position={position} onExit={exitTrade} history={history} snapshot={snapshot} sticky={false} />
          </div>
        )}

        {view === 'history' && <div className="mentor-page"><div className="mentor-page-head"><div><div className="eyebrow">PERMANENT LEARNING LOOP</div><h1>Trade journal</h1><p>Mentor-opened and user-opened simulations share the same journal so entry quality, management and exits can be compared later.</p></div><span>{history.length} completed</span></div><History history={history} /></div>}
        {view === 'settings' && <div className="mentor-page"><SettingsPanel settings={settings} onSave={setSettings} /></div>}
      </main>

      {view === 'dashboard' && <MentorFooter snapshot={snapshot} brokerStatus={brokerStatus} refreshing={refreshing} positionMentor={positionMentor} />}
    </div>
  );
}

function DesktopNav({ view, navigate, settings, setup, position }) {
  return (
    <aside className="mentor-sidebar-v2">
      <div className="sidebar-section-label">WORKSPACE</div>
      <NavButton active={view === 'dashboard'} onClick={() => navigate('dashboard')} icon="⌁" label="Mentor" />
      <NavButton active={view === 'history'} onClick={() => navigate('history')} icon="↺" label="Trade journal" />
      <NavButton active={view === 'settings'} onClick={() => navigate('settings')} icon="⚙" label="Settings" />
      <div className="sidebar-divider" />
      <div className="sidebar-section-label">AUTOMATION</div>
      <div className={`sidebar-auto-card ${settings.mentorAutoOpen ? 'active' : ''}`}><span>Auto research</span><strong>{settings.mentorAutoOpen ? 'ON' : 'OFF'}</strong><small>{position ? `Managing ${position.strategyTier || 'position'}` : setup?.eligible ? `${setup.label} ready` : 'Watching setups'}</small></div>
      <div className="sidebar-mini-grid"><div><span>Capital</span><strong>₹{Number(settings.capital).toLocaleString('en-IN')}</strong></div><div><span>Lots</span><strong>{settings.defaultLots}</strong></div></div>
      <button className="sidebar-settings-link" onClick={() => navigate('settings')}>Adjust research settings</button>
    </aside>
  );
}

function NavButton({ active, onClick, icon, label }) {
  return <button type="button" className={`sidebar-nav-button ${active ? 'active' : ''}`} onClick={onClick}><span>{icon}</span><strong>{label}</strong></button>;
}

function MobileDrawer({ view, navigate, onPosition, position, onClose, brokerStatus, mode, setMode, settings, theme, setTheme, alertsEnabled, toggleAlerts, refreshing, refreshSnapshot, liveError, onReconnect }) {
  return (
    <div className="mentor-drawer-backdrop" onMouseDown={event => event.target === event.currentTarget && onClose()}>
      <aside className="mentor-mobile-drawer">
        <div className="drawer-head"><div><span>OPTIONS MENTOR</span><strong>Control centre</strong></div><button onClick={onClose} aria-label="Close menu"><CloseIcon /></button></div>
        <div className={`drawer-connection ${liveError ? 'reconnect-required' : brokerStatus.authenticated ? 'connected' : ''}`}><span /><strong>FYERS {liveError ? 'Reconnect required' : brokerStatus.authenticated ? 'Connected' : brokerStatus.configured ? 'Ready' : 'Offline'}</strong></div>
        <div className="drawer-nav"><NavButton active={view === 'dashboard'} onClick={() => navigate('dashboard')} icon="⌁" label="Mentor" /><button type="button" className={`sidebar-nav-button drawer-position-link ${view === 'position' ? 'active' : ''} ${position ? 'has-position' : ''}`} onClick={onPosition}><span>↗</span><span className="drawer-position-copy"><strong>Position</strong><small>{position ? `${position.side || ''} ${position.strike || ''} · OPEN` : 'No simulated position'}</small></span></button><NavButton active={view === 'history'} onClick={() => navigate('history')} icon="↺" label="Trade journal" /><NavButton active={view === 'settings'} onClick={() => navigate('settings')} icon="⚙" label="Settings" /></div>
        <div className="drawer-section"><span className="drawer-label">VIEW</span><div className="segmented drawer-segmented"><button className={mode === 'simple' ? 'active' : ''} onClick={() => setMode('simple')}>Simple</button><button className={mode === 'advanced' ? 'active' : ''} onClick={() => setMode('advanced')}>Advanced</button></div></div>
        <div className="drawer-stats"><div><span>Capital</span><strong>₹{Number(settings.capital).toLocaleString('en-IN')}</strong></div><div><span>Risk</span><strong>{settings.riskPct}%</strong></div><div><span>Sim lots</span><strong>{settings.defaultLots}</strong></div></div>
        <div className="drawer-actions"><button onClick={() => setTheme(current => current === 'dark' ? 'light' : 'dark')}>{theme === 'dark' ? <SunIcon /> : <MoonIcon />}<span>{theme === 'dark' ? 'Light mode' : 'Dark mode'}</span></button><button onClick={toggleAlerts}><span className="drawer-action-dot" /> <span>{alertsEnabled ? 'Alerts on' : 'Enable alerts'}</span></button><button disabled={refreshing} onClick={() => refreshSnapshot({ manual: true })}><RefreshIcon /><span>{refreshing ? 'Checking…' : 'Refresh market'}</span></button>{brokerStatus.configured && <button className={`drawer-reconnect-btn ${liveError ? 'required' : ''}`} onClick={onReconnect}><ReconnectIcon /><span>{liveError ? 'Reconnect FYERS now' : 'Reconnect FYERS'}</span></button>}</div>
        <button className="drawer-settings-cta" onClick={() => navigate('settings')}>Account & automation settings</button>
      </aside>
    </div>
  );
}

function ResearchStatus({ classification, position, settings }) {
  if (position) return <section className={`research-status active tier-${String(position.strategyTier || '').toLowerCase()}`}><div><span>OPEN RESEARCH POSITION</span><strong>{position.strategyTierLabel || position.strategyTier}</strong></div><div><span>Initiated by</span><strong>{position.initiatedBy || 'USER'}</strong></div><div><span>Entry gates</span><strong>{position.entryMandatoryPassCount ?? '—'}/5 · {position.entryConfirmationPassCount ?? '—'}/8</strong></div><div><span>Opened</span><strong>{formatTime(position.openedAt)}</strong></div></section>;
  if (!classification?.eligible) return <section className="research-status"><div><span>AUTOMATED RESEARCH</span><strong>Watching</strong></div><div className="research-status-reason">{classification?.reason || 'Waiting for a completed setup.'}</div></section>;
  return <section className={`research-status ready tier-${classification.tier.toLowerCase()}`}><div><span>SETUP COHORT</span><strong>{classification.label}</strong></div><div><span>Mandatory</span><strong>{classification.mandatoryPassCount}/5</strong></div><div><span>Confirmations</span><strong>{classification.confirmationPassCount}/8</strong></div><div><span>Automation</span><strong>{settings.mentorAutoOpen ? 'Will open' : 'Manual'}</strong></div></section>;
}

function ToolbarStat({ label, value }) { return <div className="toolbar-stat-v2"><span>{label}</span><strong>{value}</strong></div>; }
function MenuIcon() { return <svg viewBox="0 0 24 24" width="22" height="22" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round"><path d="M5 7h14M5 12h14M5 17h14" /></svg>; }
function CloseIcon() { return <svg viewBox="0 0 24 24" width="22" height="22" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round"><path d="M6 6l12 12M18 6L6 18" /></svg>; }
function MoonIcon() { return <svg viewBox="0 0 24 24" width="17" height="17" fill="none" stroke="currentColor" strokeWidth="1.9" strokeLinecap="round" strokeLinejoin="round"><path d="M20.2 15.1A8.4 8.4 0 0 1 8.9 3.8 8.6 8.6 0 1 0 20.2 15.1Z" /></svg>; }
function SunIcon() { return <svg viewBox="0 0 24 24" width="17" height="17" fill="none" stroke="currentColor" strokeWidth="1.9" strokeLinecap="round"><circle cx="12" cy="12" r="3.7" /><path d="M12 2.3v2M12 19.7v2M4.1 4.1l1.4 1.4M18.5 18.5l1.4 1.4M2.3 12h2M19.7 12h2M4.1 19.9l1.4-1.4M18.5 5.5l1.4-1.4" /></svg>; }
function RefreshIcon() { return <svg viewBox="0 0 24 24" width="17" height="17" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round"><path d="M20 6v5h-5M4 18v-5h5" /><path d="M18.2 9A7 7 0 0 0 6 6.6L4 9M5.8 15A7 7 0 0 0 18 17.4l2-2.4" /></svg>; }
function ReconnectIcon() { return <svg viewBox="0 0 24 24" width="17" height="17" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><path d="M20 11a8 8 0 1 0-2.34 5.66" /><path d="M20 4v7h-7" /></svg>; }

function updateLivePosition(current, liveOption, liveNifty, fallbackSpot) {
  if (!current) return current;
  const currentPrice = Number.isFinite(liveOption) ? liveOption : Number(current.currentPrice);
  const underlyingCurrent = Number.isFinite(liveNifty) ? liveNifty : Number(fallbackSpot ?? current.underlyingCurrent);
  const riskPoints = Math.max(0.01, Math.abs(Number(current.underlyingEntry) - Number(current.underlyingStop)));
  const movePoints = current.side === 'CE' ? underlyingCurrent - Number(current.underlyingEntry) : Number(current.underlyingEntry) - underlyingCurrent;
  const currentR = Number.isFinite(movePoints) ? movePoints / riskPoints : Number(current.currentR || 0);
  return {
    ...current,
    currentPrice,
    underlyingCurrent,
    currentR,
    bestR: Math.max(Number.isFinite(Number(current.bestR)) ? Number(current.bestR) : 0, currentR),
    worstR: Math.min(Number.isFinite(Number(current.worstR)) ? Number(current.worstR) : 0, currentR),
    bestOptionPrice: Math.max(Number.isFinite(Number(current.bestOptionPrice)) ? Number(current.bestOptionPrice) : Number(current.entry), currentPrice),
    worstOptionPrice: Math.min(Number.isFinite(Number(current.worstOptionPrice)) ? Number(current.worstOptionPrice) : Number(current.entry), currentPrice),
    oneRReached: Boolean(current.oneRReached || currentR >= 1 || Number(current.bestR) >= 1)
  };
}

function inferExitReason(position, underlyingExit) {
  const stopHit = position.side === 'CE' ? underlyingExit <= position.underlyingStop : underlyingExit >= position.underlyingStop;
  return stopHit ? 'STRUCTURE_INVALIDATED' : 'MANUAL_EXIT';
}

function pruneLedger(ledger) {
  const keys = Object.keys(ledger);
  if (keys.length <= 120) return;
  keys.sort((a, b) => String(ledger[a]?.openedAt || '').localeCompare(String(ledger[b]?.openedAt || ''))).slice(0, keys.length - 120).forEach(key => delete ledger[key]);
}
function readJson(key, fallback) { try { const value = localStorage.getItem(key); return value ? JSON.parse(value) : fallback; } catch { return fallback; } }
function readString(key, fallback) { try { return localStorage.getItem(key) || fallback; } catch { return fallback; } }
function formatTime(value) { if (!value) return '—'; const date = new Date(value); return Number.isNaN(date.getTime()) ? '—' : date.toLocaleTimeString('en-IN', { hour: '2-digit', minute: '2-digit', second: '2-digit' }); }

function primeAlertAudio(audioRef) {
  try {
    if (!audioRef.current) { const AudioContext = window.AudioContext || window.webkitAudioContext; if (!AudioContext) return; audioRef.current = new AudioContext(); }
    if (audioRef.current.state === 'suspended') audioRef.current.resume();
  } catch {}
}
function playExitTone(audioRef) {
  try {
    primeAlertAudio(audioRef); const ctx = audioRef.current; if (!ctx) return; const now = ctx.currentTime;
    [{ at: 0, freq: 880, duration: 0.18 }, { at: 0.24, freq: 880, duration: 0.18 }, { at: 0.48, freq: 660, duration: 0.32 }].forEach(note => { const oscillator = ctx.createOscillator(); const gain = ctx.createGain(); oscillator.type = 'sine'; oscillator.frequency.setValueAtTime(note.freq, now + note.at); gain.gain.setValueAtTime(0.0001, now + note.at); gain.gain.exponentialRampToValueAtTime(0.18, now + note.at + 0.015); gain.gain.exponentialRampToValueAtTime(0.0001, now + note.at + note.duration); oscillator.connect(gain); gain.connect(ctx.destination); oscillator.start(now + note.at); oscillator.stop(now + note.at + note.duration + 0.02); });
  } catch {}
}
function sendBrowserExitNotification(position, mentor) {
  try {
    if (typeof Notification === 'undefined' || Notification.permission !== 'granted') return;
    const notification = new Notification(`Options Mentor — ${mentor.title}`, { body: `${mentor.reason} NIFTY ${Number(position.underlyingCurrent).toLocaleString('en-IN', { maximumFractionDigits: 2 })}.`, tag: `mentor-exit-${position.id}-${mentor.reasonCode}`, requireInteraction: true });
    notification.onclick = () => { window.focus(); notification.close(); };
  } catch {}
}
