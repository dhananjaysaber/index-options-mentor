import { lazy, Suspense, useEffect, useMemo, useRef, useState } from 'react';
import TraderDecisionBanner from './components/TraderDecisionBanner.jsx';
import MentorWorkflow from './components/MentorWorkflow.jsx';
import QuickChecklist from './components/QuickChecklist.jsx';
import TraderMarketPanel from './components/TraderMarketPanel.jsx';
import LivePositionPanel from './components/LivePositionPanel.jsx';
import ParameterGrid from './components/ParameterGrid.jsx';
import History from './components/History.jsx';
import PositionAlertBanner from './components/PositionAlertBanner.jsx';
import MentorFooter from './components/MentorFooter.jsx';
import SettingsPanel from './components/SettingsPanel.jsx';
import ScalpMentorDashboard from './components/ScalpMentorDashboard.jsx';
import ScalpFooter from './components/ScalpFooter.jsx';
import CoreResearchPanel from './components/CoreResearchPanel.jsx';
import CoreQuickActions from './components/CoreQuickActions.jsx';
import MobileMentorDashboardV41 from './components/MobileMentorDashboardV41.jsx';
import { derivePositionMentor, deriveScalpPositionMentor } from './engine/positionMentor.js';
import { buildSimulatedTicket, classifyManualResearchSetup, classifyResearchSetup, tierEnabled } from './engine/researchStrategy.js';
import { syncJournalHistory } from './services/tradeJournal.js';
import { clearFyersSession, getFyersLoginUrl } from './services/apiBridge.js';
import SnapshotIssueBanner from './components/SnapshotIssueBanner.jsx';

const ResearchAnalysis = lazy(() => import('./components/ResearchAnalysis.jsx'));

const HISTORY_KEY = 'index-options-mentor-history-v05';
const LEGACY_POSITION_KEY = 'index-options-mentor-open-position-v07';
const CORE_POSITION_KEY = 'index-options-mentor-core-position-v41';
const SCALP_POSITION_KEY = 'index-options-mentor-scalp-position-v41';
const ALERTS_KEY = 'index-options-mentor-alerts-enabled-v07';
const THEME_KEY = 'index-options-mentor-theme-v1';
const SETTINGS_KEY = 'index-options-mentor-settings-v2';
const AUTO_SETUP_KEY = 'index-options-mentor-auto-setups-v1';
const STRATEGY_MODE_KEY = 'index-options-mentor-strategy-mode-v1';

const DEFAULT_SETTINGS = {
  capital: 50000,
  riskPct: 1,
  defaultLots: 1,
  lotCap: 5,
  mentorAutoOpen: true,
  mentorAutoClose: true,
  scalpAutoOpen: true,
  scalpAutoClose: true,
  liveHandoffEnabled: false,
  controlledResearch: true,
  experimentalResearch: true
};

export default function AppV3() {
  const [view, setView] = useState('dashboard');
  const [mode, setMode] = useState('simple');
  const [strategyMode, setStrategyMode] = useState(() => readString(STRATEGY_MODE_KEY, 'core') === 'scalp' ? 'scalp' : 'core');
  const [scalpStatus, setScalpStatus] = useState(null);
  const [mobileMenuOpen, setMobileMenuOpen] = useState(false);
  const [brokerStatus, setBrokerStatus] = useState({ configured: false, authenticated: false });
  const [snapshot, setSnapshot] = useState(null);
  const [loading, setLoading] = useState(true);
  const [refreshing, setRefreshing] = useState(false);
  const [liveError, setLiveError] = useState('');
  const [authRequired, setAuthRequired] = useState(false);
  const snapshotRequestRef = useRef(false);
  const [clockTick, setClockTick] = useState(0);
  const [theme, setTheme] = useState(() => readString(THEME_KEY, 'light') === 'dark' ? 'dark' : 'light');
  const [settings, setSettings] = useState(() => ({ ...DEFAULT_SETTINGS, ...readJson(SETTINGS_KEY, {}) }));
  const [corePosition, setCorePosition] = useState(() => initialPosition('core'));
  const [scalpPosition, setScalpPosition] = useState(() => initialPosition('scalp'));
  const [history, setHistory] = useState(() => readJson(HISTORY_KEY, []));
  const [alertsEnabled, setAlertsEnabled] = useState(() => readString(ALERTS_KEY, '0') === '1');
  const [notificationPermission, setNotificationPermission] = useState(() => typeof Notification !== 'undefined' ? Notification.permission : 'unsupported');
  const audioRef = useRef(null);
  const autoExitRef = useRef({ core: '', scalp: '', trail: '', time: '' });

  const activePosition = strategyMode === 'scalp' ? scalpPosition : corePosition;
  const positionCount = Number(Boolean(corePosition)) + Number(Boolean(scalpPosition));

  useEffect(() => {
    document.documentElement.dataset.theme = theme;
    localStorage.setItem(THEME_KEY, theme);
    const meta = document.querySelector('meta[name="theme-color"]');
    if (meta) meta.setAttribute('content', theme === 'dark' ? '#0b1220' : '#ffffff');
  }, [theme]);

  useEffect(() => { localStorage.setItem(SETTINGS_KEY, JSON.stringify(settings)); }, [settings]);
  useEffect(() => { localStorage.setItem(HISTORY_KEY, JSON.stringify(history)); }, [history]);
  useEffect(() => { persistPosition(CORE_POSITION_KEY, corePosition); }, [corePosition]);
  useEffect(() => { persistPosition(SCALP_POSITION_KEY, scalpPosition); }, [scalpPosition]);
  useEffect(() => {
    const journalPosition = activePosition || corePosition || scalpPosition;
    persistPosition(LEGACY_POSITION_KEY, journalPosition);
  }, [activePosition?.id, corePosition?.id, scalpPosition?.id, strategyMode]);
  useEffect(() => { localStorage.setItem(ALERTS_KEY, alertsEnabled ? '1' : '0'); }, [alertsEnabled]);
  useEffect(() => { localStorage.setItem(STRATEGY_MODE_KEY, strategyMode); }, [strategyMode]);

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
      if (data?.authRequired) {
        setAuthRequired(true);
        setLiveError('The saved FYERS session has expired or was rejected. Reconnect FYERS.');
      }
      return data;
    } catch {
      return { configured: false, authenticated: false };
    }
  }

  async function refreshSnapshot(options = {}) {
    // The 15-second timer must not stack expensive FYERS snapshot requests.
    if (snapshotRequestRef.current) return null;
    snapshotRequestRef.current = true;
    const manual = options?.manual === true;
    if (manual) setRefreshing(true);
    try {
      const response = await fetch('/api/fyers/mentor-snapshot', { cache: 'no-store' });
      if (!response.ok) {
        const data = await response.json().catch(() => ({}));
        const failure = new Error(data.error || 'Live Mentor data is temporarily unavailable.');
        // A server-side calculation/market-data error is NOT proof of an
        // expired FYERS session. Reconnect only for a recognised auth failure.
        failure.authRequired = response.status === 401
          || data.authRequired === true || data.code === 'FYERS_AUTH_REQUIRED'
          || isFyersTokenError(data.detail);
        throw failure;
      }
      const data = await response.json();
      if (!data || data.ok === false) throw new Error('FYERS returned an incomplete Mentor snapshot.');
      setSnapshot(data);
      setLiveError('');
      setAuthRequired(false);
      return data;
    } catch (error) {
      setAuthRequired(error?.authRequired === true);
      if (error?.authRequired === true) setBrokerStatus(current => ({ ...current, authenticated: false }));
      setLiveError(error?.message || 'Unable to refresh Mentor data. The app will retry automatically.');
      // Preserve the last completed snapshot and any open simulated position.
      return null;
    } finally {
      snapshotRequestRef.current = false;
      setLoading(false);
      if (manual) setRefreshing(false);
    }
  }

  useEffect(() => {
    const handleAuthExpiry = () => {
      setAuthRequired(true);
      setBrokerStatus(current => ({ ...current, authenticated: false }));
      setLiveError('FYERS has rejected the saved session. Reconnect FYERS to resume live data.');
    };
    window.addEventListener('mentor:fyers-auth-required', handleAuthExpiry);
    return () => window.removeEventListener('mentor:fyers-auth-required', handleAuthExpiry);
  }, []);

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
    if (!scalpPosition) return undefined;
    const timer = window.setInterval(() => setClockTick(value => value + 1), 1000);
    return () => window.clearInterval(timer);
  }, [scalpPosition?.id]);

  useEffect(() => {
    // Subscribe to the existing 2-second shared quote loop. Both strategy
    // positions receive their own option LTP from the same FYERS request.
    // No second high-frequency loop is started when a position opens.
    const updatePositions = event => {
      const quote = event?.detail || window.__indexOptionsLiveQuote;
      if (!quote) return;
      const nifty = Number(quote.nifty);
      const prices = quote.optionPrices || {};
      const optionPrice = symbol => {
        const value = prices[symbol] ?? (quote.optionSymbol === symbol ? quote.optionPrice : null);
        return value == null ? NaN : Number(value);
      };
      setCorePosition(current => current
        ? updateLivePosition(current, optionPrice(current.symbol), nifty, null)
        : current);
      setScalpPosition(current => current
        ? updateLivePosition(current, optionPrice(current.symbol), nifty, null)
        : current);
    };
    window.addEventListener('mentor:live-quote', updatePositions);
    if (window.__indexOptionsLiveQuote) updatePositions();
    return () => window.removeEventListener('mentor:live-quote', updatePositions);
  }, []);

  const setupClassification = useMemo(() => classifyResearchSetup(snapshot), [snapshot]);
  const manualClassification = useMemo(() => classifyManualResearchSetup(snapshot), [snapshot]);
  const coreManualReady = Boolean(!corePosition && manualClassification?.eligible && setupClassification?.hardSafetyPassed);

  useEffect(() => {
    if (!corePosition || !snapshot?.generatedAt) return;
    const currentClass = classifyResearchSetup(snapshot);
    setCorePosition(current => current ? {
      ...current,
      currentScore: snapshot.decision?.score,
      currentMandatoryPassCount: currentClass.mandatoryPassCount,
      currentConfirmationPassCount: currentClass.confirmationPassCount,
      currentMentorState: snapshot.decision?.state,
      currentMentorSuggestion: snapshot.decision?.headline,
      currentMentorReasons: snapshot.decision?.reasons || [],
      lastMentorAt: snapshot.generatedAt
    } : current);
  }, [snapshot?.generatedAt, corePosition?.id]);

  const coreMentor = useMemo(() => {
    if (!corePosition) return null;
    const underlying = Number(corePosition.underlyingCurrent ?? snapshot?.market?.spot);
    return Number.isFinite(underlying) ? derivePositionMentor(corePosition, snapshot, underlying) : null;
  }, [corePosition, snapshot]);

  const scalpMentor = useMemo(() => {
    if (!scalpPosition) return null;
    const underlying = Number(scalpPosition.underlyingCurrent ?? snapshot?.market?.spot);
    return Number.isFinite(underlying) ? deriveScalpPositionMentor(scalpPosition, snapshot, underlying) : null;
  }, [scalpPosition, snapshot, clockTick]);

  useEffect(() => {
    if (strategyMode !== 'core' || liveError || !settings.mentorAutoOpen || corePosition || !setupClassification.eligible || !tierEnabled(setupClassification, settings)) return;
    const ledger = readJson(AUTO_SETUP_KEY, {});
    const key = setupClassification.setupId;
    if (!key || ledger[key]) return;
    const ticket = buildSimulatedTicket(snapshot, settings, 'MENTOR');
    if (!ticket) return;
    ledger[key] = { openedAt: ticket.openedAt, tier: ticket.strategyTier };
    pruneLedger(ledger);
    localStorage.setItem(AUTO_SETUP_KEY, JSON.stringify(ledger));
    takeTrade({ ...ticket, researchQualificationTier: setupClassification.tier, researchQualificationLabel: setupClassification.label, researchTagAtEntry: `${setupClassification.label} · auto entry` });
  }, [snapshot?.generatedAt, strategyMode, liveError, corePosition?.id, settings.mentorAutoOpen, settings.controlledResearch, settings.experimentalResearch, settings.defaultLots, settings.lotCap]);

  useEffect(() => {
    if (!corePosition || !coreMentor || settings.mentorAutoClose === false || coreMentor.alertLevel !== 'exit') {
      autoExitRef.current.core = '';
      return;
    }
    const signature = `${corePosition.id}:${coreMentor.reasonCode}`;
    if (autoExitRef.current.core === signature) return;
    autoExitRef.current.core = signature;
    exitStrategy('core', {
      mentorState: coreMentor.title,
      reasonCode: coreMentor.reasonCode,
      reason: coreMentor.reason,
      rMultiple: coreMentor.rMultiple,
      closedBy: 'MENTOR'
    });
  }, [corePosition?.id, coreMentor?.alertLevel, coreMentor?.reasonCode, settings.mentorAutoClose]);

  useEffect(() => {
    if (!scalpPosition || !scalpMentor || settings.scalpAutoClose === false || scalpMentor.alertLevel !== 'exit') {
      autoExitRef.current.scalp = '';
      return;
    }
    const signature = `${scalpPosition.id}:${scalpMentor.reasonCode}`;
    if (autoExitRef.current.scalp === signature) return;
    autoExitRef.current.scalp = signature;
    exitStrategy('scalp', {
      mentorState: scalpMentor.title,
      reasonCode: scalpMentor.reasonCode,
      reason: scalpMentor.reason,
      rMultiple: scalpMentor.rMultiple,
      closedBy: 'MENTOR'
    });
  }, [scalpPosition?.id, scalpMentor?.alertLevel, scalpMentor?.reasonCode, settings.scalpAutoClose]);

  useEffect(() => {
    if (!scalpPosition || settings.scalpAutoClose === false || !scalpPosition.scalpTrailingActive) {
      autoExitRef.current.trail = '';
      return;
    }
    const floor = Number(scalpPosition.scalpTrailingFloorR);
    const currentR = Number(scalpPosition.currentR);
    if (!Number.isFinite(floor) || !Number.isFinite(currentR) || currentR > floor) return;
    const signature = `${scalpPosition.id}:${floor.toFixed(2)}`;
    if (autoExitRef.current.trail === signature) return;
    autoExitRef.current.trail = signature;
    exitStrategy('scalp', {
      mentorState: 'SCALP TRAILING STOP',
      reasonCode: 'SCALP_TRAILING_STOP',
      reason: `Automatic trailing protection was triggered at ${formatR(currentR)} after the trade reached ${formatR(scalpPosition.bestR)}. The protected floor was ${formatR(floor)}.`,
      rMultiple: currentR,
      closedBy: 'MENTOR'
    });
  }, [scalpPosition?.id, scalpPosition?.currentR, scalpPosition?.scalpTrailingFloorR, scalpPosition?.scalpTrailingActive, settings.scalpAutoClose]);

  useEffect(() => {
    if (!scalpPosition || settings.scalpAutoClose === false) return undefined;
    const opened = new Date(scalpPosition.openedAt || 0).getTime();
    if (!Number.isFinite(opened)) return undefined;
    const limitMs = Math.max(1, Number(scalpPosition.scalpMaxHoldMinutes) || 12) * 60000;
    const deadline = opened + limitMs;
    const delay = Math.max(0, deadline - Date.now());
    const signature = `${scalpPosition.id}:${deadline}`;
    const timer = window.setTimeout(() => {
      if (autoExitRef.current.time === signature) return;
      autoExitRef.current.time = signature;
      exitStrategy('scalp', {
        mentorState: 'SCALP TIME EXIT',
        reasonCode: 'SCALP_TIME_EXIT',
        reason: `The scalp reached its hard ${Math.max(1, Number(scalpPosition.scalpMaxHoldMinutes) || 12)}-minute holding limit.`,
        closedBy: 'MENTOR'
      });
    }, delay);
    return () => window.clearTimeout(timer);
  }, [scalpPosition?.id, scalpPosition?.openedAt, scalpPosition?.scalpMaxHoldMinutes, settings.scalpAutoClose]);

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
    // Old 5m/3m structure may remain visible when the calculation endpoint
    // fails. It must not open NEW positions until a fresh snapshot succeeds.
    if (!ticket?.quantity || liveError) return;
    const initiatedBy = ticket.initiatedBy || 'USER';
    const enriched = {
      ...ticket,
      initiatedBy,
      openedByMentor: ticket.openedByMentor === true || initiatedBy === 'MENTOR'
    };
    if (ticket.strategyFamily === 'SCALP') {
      setScalpPosition(current => current ? current : enriched);
    } else {
      setCorePosition(current => current ? current : enriched);
    }
  }

  function exitStrategy(strategy, meta = {}) {
    const setter = strategy === 'scalp' ? setScalpPosition : setCorePosition;
    setter(current => {
      if (!current) return current;
      const closed = closeTrade(current, meta, snapshot, scalpStatus, settings);
      setHistory(previous => [closed, ...previous.filter(row => row.id !== closed.id)].slice(0, 1000));
      if (alertsEnabled && meta.closedBy === 'MENTOR') {
        playExitTone(audioRef);
        sendBrowserExitNotification(current, meta);
      }
      return null;
    });
  }

  function navigate(next) {
    setView(next);
    setMobileMenuOpen(false);
  }

  function reconnectFyers() {
    clearFyersSession();
    setBrokerStatus(current => ({ ...current, authenticated: false }));
    setSnapshot(null);
    setLiveError('');
    setAuthRequired(false);
    setMobileMenuOpen(false);
    window.location.assign(getFyersLoginUrl());
  }

  const reconnectRequired = authRequired;
  const marketDataReady = Boolean(snapshot?.generatedAt && !liveError);

  return (
    <div className="app-shell mentor-v2-shell research-v41-shell">
      <header className="topbar mentor-v2-topbar">
        <button className="brand-group brand-button" onClick={() => navigate('dashboard')} type="button">
          <div className="brand-mark">IO</div>
          <div><div className="brand-kicker">DATA-DRIVEN TRADING MENTOR</div><div className="brand-title">Index Options Mentor</div></div>
        </button>
        <div className="mentor-v2-desktop-actions">
          <span className={`connection-pill ${reconnectRequired ? 'reconnect-required' : brokerStatus.authenticated ? 'connected' : ''}`}>FYERS {reconnectRequired ? 'Reconnect' : brokerStatus.authenticated ? 'Connected' : brokerStatus.configured ? 'Ready' : 'Offline'}</span>
          {reconnectRequired && <button className="secondary-btn fyers-reconnect-btn" onClick={reconnectFyers}>Reconnect FYERS</button>}
          <button className="secondary-btn theme-toggle" onClick={() => setTheme(current => current === 'dark' ? 'light' : 'dark')} title="Toggle theme">{theme === 'dark' ? <SunIcon /> : <MoonIcon />}</button>
          <button className={`secondary-btn ${alertsEnabled ? 'active' : ''}`} onClick={toggleAlerts}>{alertsEnabled ? 'Alerts on' : 'Enable alerts'}</button>
          {brokerStatus.authenticated && <button className={`secondary-btn refresh-btn ${refreshing ? 'refreshing' : ''}`} onClick={() => refreshSnapshot({ manual: true })} disabled={refreshing}>{refreshing ? 'Checking…' : 'Refresh now'}</button>}
        </div>
        <div className="mentor-v2-mobile-status"><span className={reconnectRequired ? 'reconnect' : liveError ? 'mentor-data-warning' : brokerStatus.authenticated ? 'online' : ''} /></div>
        <button className="mentor-v2-menu-button" onClick={() => setMobileMenuOpen(true)} aria-label="Open menu"><MenuIcon /></button>
      </header>

      <DesktopNav view={view} navigate={navigate} settings={settings} setup={setupClassification} positionCount={positionCount} corePosition={corePosition} scalpPosition={scalpPosition} />

      {mobileMenuOpen && <MobileDrawer view={view} navigate={navigate} positionCount={positionCount} activePosition={activePosition || corePosition || scalpPosition} onClose={() => setMobileMenuOpen(false)} brokerStatus={brokerStatus} mode={mode} setMode={setMode} settings={settings} theme={theme} setTheme={setTheme} alertsEnabled={alertsEnabled} toggleAlerts={toggleAlerts} refreshing={refreshing} refreshSnapshot={refreshSnapshot} liveError={liveError} authRequired={authRequired} onReconnect={reconnectFyers} />}

      <main className="mentor-v2-content">
        {view === 'dashboard' && (
          <>
            <StrategyModeBar strategyMode={strategyMode} setStrategyMode={setStrategyMode} corePosition={corePosition} scalpPosition={scalpPosition} />

            {strategyMode === 'scalp' ? (
              <ScalpMentorDashboard
                snapshot={snapshot}
                loading={loading}
                liveError={liveError}
                authRequired={authRequired}
                onRetry={() => refreshSnapshot({ manual: true })}
                marketDataReady={marketDataReady}
                position={scalpPosition}
                positionMentor={scalpMentor}
                alertsEnabled={alertsEnabled}
                history={history}
                settings={{ ...settings, liveHandoffEnabled: false }}
                onReconnect={reconnectFyers}
                onTakeTrade={takeTrade}
                onExit={meta => exitStrategy('scalp', meta)}
                onStatusChange={setScalpStatus}
              />
            ) : (
              <>
                <section className="trader-toolbar mentor-v2-toolbar">
                  <div className="segmented"><button className={mode === 'simple' ? 'active' : ''} onClick={() => setMode('simple')}>Simple</button><button className={mode === 'advanced' ? 'active' : ''} onClick={() => setMode('advanced')}>Advanced</button></div>
                  <div className="toolbar-live"><span>DATA</span><strong>{brokerStatus.authenticated ? 'FYERS LIVE' : 'OFFLINE'}</strong></div>
                  <ToolbarStat label="Capital" value={`₹${Number(settings.capital).toLocaleString('en-IN')}`} />
                  <ToolbarStat label="Risk" value={`${settings.riskPct}%`} />
                  <ToolbarStat label="Sim lots" value={settings.defaultLots} />
                  <div className={`automation-pill ${settings.mentorAutoOpen ? 'on' : ''}`}><span>MENTOR AUTO</span><strong>{settings.mentorAutoOpen ? 'OPEN + MANAGE' : 'MANUAL'}</strong></div>
                </section>

                <MobileMentorDashboardV41
                  mode={mode}
                  snapshot={snapshot}
                  loading={loading}
                  liveError={liveError}
                  authRequired={authRequired}
                  onRetry={() => refreshSnapshot({ manual: true })}
                  position={corePosition}
                  positionMentor={coreMentor}
                  alertsEnabled={alertsEnabled}
                  history={history}
                  settings={settings}
                  onReconnect={reconnectFyers}
                  onExit={meta => exitStrategy('core', meta)}
                />

                {liveError && <SnapshotIssueBanner message={liveError} authRequired={authRequired} onReconnect={reconnectFyers} onRetry={() => refreshSnapshot({ manual: true })} />}
                {corePosition && <div className="position-lock-bar">13-POINT POSITION ACTIVE · OPENED BY {corePosition.initiatedBy || 'USER'} · {corePosition.strategyTierLabel || corePosition.strategyTier || 'RESEARCH'}</div>}
                <PositionAlertBanner position={corePosition} mentor={coreMentor} alertsEnabled={alertsEnabled} onExit={meta => exitStrategy('core', { ...meta, closedBy: 'USER' })} />
                <TraderDecisionBanner snapshot={snapshot} loading={loading} />
                <ResearchStatus classification={setupClassification} position={corePosition} settings={settings} manualReady={coreManualReady} />
                <MentorWorkflow snapshot={snapshot} />
                {mode === 'advanced' && <QuickChecklist rows={snapshot?.parameters || []} directionReady={Boolean(snapshot?.decision?.side)} />}

                <section className={`trader-workspace ${mode === 'simple' ? 'simple-workspace' : 'advanced-workspace'} mentor-v2-workspace compact-v41-workspace`}>
                  <div className={`workspace-left ${mode === 'advanced' ? 'advanced-left' : ''}`}>
                    {mode === 'advanced' && snapshot && <ParameterGrid rows={snapshot.parameters} directionReady={Boolean(snapshot?.decision?.side)} />}
                    <TraderMarketPanel snapshot={snapshot} />
                  </div>
                  {corePosition
                    ? <LivePositionPanel position={corePosition} onExit={meta => exitStrategy('core', meta)} history={history} snapshot={snapshot} sticky />
                    : <CoreResearchPanel snapshot={snapshot} settings={settings} />}
                </section>

                <CoreQuickActions snapshot={snapshot} marketDataReady={marketDataReady} settings={settings} position={corePosition} onTakeTrade={takeTrade} onExit={meta => exitStrategy('core', meta)} />
              </>
            )}
          </>
        )}

        {view === 'position' && (
          <div className="mentor-page position-page-v22 dual-position-page">
            <div className="mentor-page-head position-page-head-v22">
              <div>
                <div className="eyebrow">RESEARCH POSITIONS</div>
                <h1>{positionCount ? `${positionCount} open simulated position${positionCount === 1 ? '' : 's'}` : 'No simulated positions'}</h1>
                <p>13-point and Scalp research are tracked independently. Either strategy can stay open while you view or test the other.</p>
              </div>
              <span className={positionCount ? 'position-page-status open' : 'position-page-status'}>{positionCount ? `${positionCount} OPEN` : 'NO OPEN POSITION'}</span>
            </div>
            <div className="dual-position-grid">
              <section><div className="dual-position-label"><span>13-POINT</span><strong>{corePosition ? 'OPEN' : 'NO POSITION'}</strong></div><LivePositionPanel position={corePosition} onExit={meta => exitStrategy('core', meta)} history={history} snapshot={snapshot} sticky={false} /></section>
              <section><div className="dual-position-label"><span>SCALP</span><strong>{scalpPosition ? 'OPEN' : 'NO POSITION'}</strong></div><LivePositionPanel position={scalpPosition} onExit={meta => exitStrategy('scalp', meta)} history={history} snapshot={snapshot} sticky={false} /></section>
            </div>
          </div>
        )}

        {view === 'history' && <div className="mentor-page"><div className="mentor-page-head"><div><div className="eyebrow">PERMANENT LEARNING LOOP</div><h1>Trade journal</h1><p>13-point and Scalp trades remain independently tagged so Auto, Manual, qualification, management and exits can be compared later.</p></div><span>{history.length} completed</span></div><History history={history} /></div>}
        {view === 'analysis' && <Suspense fallback={<AnalysisPageLoading />}><ResearchAnalysis history={history} brokerStatus={brokerStatus} /></Suspense>}
        {view === 'settings' && <div className="mentor-page"><SettingsPanel settings={settings} onSave={setSettings} /></div>}
      </main>

      {view === 'dashboard' && (strategyMode === 'scalp'
        ? <ScalpFooter snapshot={snapshot} brokerStatus={brokerStatus} refreshing={refreshing} evaluation={scalpStatus} positionMentor={scalpMentor} />
        : <MentorFooter snapshot={snapshot} brokerStatus={brokerStatus} refreshing={refreshing} positionMentor={coreMentor} />)}
    </div>
  );
}

function ResearchStatus({ classification, position, settings, manualReady }) {
  if (position) {
    return <section className={`research-status active tier-${String(position.researchQualificationTier || position.strategyTier || '').toLowerCase()}`}><div><span>13-POINT POSITION</span><strong>{position.researchQualificationLabel || position.strategyTierLabel || position.strategyTier}</strong></div><div><span>Entry</span><strong>{position.entryMethod || (position.initiatedBy === 'MENTOR' ? 'AUTO' : 'MANUAL')}</strong></div><div><span>Entry gates</span><strong>{position.entryMandatoryPassCount ?? '—'}/5 · {position.entryConfirmationPassCount ?? '—'}/8</strong></div><div><span>Opened</span><strong>{formatTime(position.openedAt)}</strong></div></section>;
  }
  const label = classification?.eligible ? classification.label : manualReady ? 'Manual research ready' : 'No qualified setup';
  const tier = classification?.tier ? `tier-${classification.tier.toLowerCase()}` : manualReady ? 'tier-manual' : '';
  return (
    <section className={`research-status qualification-v41 ${classification?.eligible || manualReady ? 'ready' : ''} ${tier}`}>
      <div><span>QUALIFICATION</span><strong>{label}</strong></div>
      <div><span>Score</span><strong>{Number.isFinite(Number(classification?.score)) ? `${classification.score}/100` : '—'}</strong></div>
      <div><span>Mandatory</span><strong>{classification?.mandatoryPassCount ?? 0}/5</strong></div>
      <div><span>Confirmations</span><strong>{classification?.confirmationPassCount ?? 0}/8</strong></div>
      <div><span>Hard safety</span><strong>{classification?.hardSafetyPassed ? 'PASS' : 'WAIT'}</strong></div>
      <div><span>Automation</span><strong>{classification?.eligible && settings.mentorAutoOpen ? 'AUTO READY' : manualReady ? 'BUY READY' : 'WATCHING'}</strong></div>
    </section>
  );
}

function StrategyModeBar({ strategyMode, setStrategyMode, corePosition, scalpPosition }) {
  const scalp = strategyMode === 'scalp';
  return (
    <section className="strategy-mode-bar" aria-label="Strategy mode">
      <div className="strategy-mode-copy">
        <span>STRATEGY MODE</span>
        <strong>{scalp ? 'Scalp research · 5m context / 3m execution' : '13-point Mentor · structured 5m strategy'}</strong>
        <small>{corePosition ? '13-point open' : '13-point clear'} · {scalpPosition ? 'Scalp open' : 'Scalp clear'}</small>
      </div>
      <button type="button" className={`scalp-mode-switch ${scalp ? 'active' : ''}`} onClick={() => setStrategyMode(scalp ? 'core' : 'scalp')} aria-pressed={scalp}>
        <span>SCALP</span><i aria-hidden="true" />
      </button>
    </section>
  );
}

function DesktopNav({ view, navigate, settings, setup, positionCount, corePosition, scalpPosition }) {
  return (
    <aside className="mentor-sidebar-v2">
      <div className="sidebar-section-label">WORKSPACE</div>
      <NavButton active={view === 'dashboard'} onClick={() => navigate('dashboard')} icon="⌁" label="Mentor" />
      <button type="button" className={`sidebar-nav-button ${view === 'position' ? 'active' : ''}`} onClick={() => navigate('position')}><span>↗</span><strong>Positions {positionCount ? `(${positionCount})` : ''}</strong></button>
      <NavButton active={view === 'history'} onClick={() => navigate('history')} icon="↺" label="Trade journal" />
      <NavButton active={view === 'analysis'} onClick={() => navigate('analysis')} icon="◫" label="Analysis" />
      <NavButton active={view === 'settings'} onClick={() => navigate('settings')} icon="⚙" label="Settings" />
      <div className="sidebar-divider" />
      <div className="sidebar-section-label">AUTOMATION</div>
      <div className={`sidebar-auto-card ${settings.mentorAutoOpen ? 'active' : ''}`}><span>13-point auto research</span><strong>{settings.mentorAutoOpen ? 'ON' : 'OFF'}</strong><small>{corePosition ? 'Managing open 13-point' : setup?.eligible ? `${setup.label} ready` : 'Watching setups'}</small></div>
      <div className={`sidebar-auto-card ${settings.scalpAutoOpen !== false ? 'active' : ''}`}><span>Scalp auto research</span><strong>{settings.scalpAutoOpen !== false ? 'ON' : 'OFF'}</strong><small>{scalpPosition ? 'Managing open scalp' : 'Independent slot'}</small></div>
      <div className="sidebar-mini-grid"><div><span>Capital</span><strong>₹{Number(settings.capital).toLocaleString('en-IN')}</strong></div><div><span>Lots</span><strong>{settings.defaultLots}</strong></div></div>
      <button className="sidebar-settings-link" onClick={() => navigate('settings')}>Adjust research settings</button>
    </aside>
  );
}

function MobileDrawer({ view, navigate, positionCount, activePosition, onClose, brokerStatus, mode, setMode, settings, theme, setTheme, alertsEnabled, toggleAlerts, refreshing, refreshSnapshot, liveError, authRequired, onReconnect }) {
  return (
    <div className="mentor-drawer-backdrop" onMouseDown={event => event.target === event.currentTarget && onClose()}>
      <aside className="mentor-mobile-drawer">
        <div className="drawer-head"><div><span>OPTIONS MENTOR</span><strong>Control centre</strong></div><button onClick={onClose} aria-label="Close menu"><CloseIcon /></button></div>
        <div className={`drawer-connection ${authRequired ? 'reconnect-required' : brokerStatus.authenticated ? 'connected' : ''}`}><span /><strong>FYERS {authRequired ? 'Reconnect required' : brokerStatus.authenticated ? 'Connected' : brokerStatus.configured ? 'Ready' : 'Offline'}</strong></div>
        <div className="drawer-nav"><NavButton active={view === 'dashboard'} onClick={() => navigate('dashboard')} icon="⌁" label="Mentor" /><button type="button" className={`sidebar-nav-button drawer-position-link ${view === 'position' ? 'active' : ''} ${positionCount ? 'has-position' : ''}`} onClick={() => navigate('position')}><span>↗</span><span className="drawer-position-copy"><strong>Positions {positionCount ? `(${positionCount})` : ''}</strong><small>{activePosition ? `${activePosition.side || ''} ${activePosition.strike || ''} · OPEN` : 'No simulated position'}</small></span></button><NavButton active={view === 'history'} onClick={() => navigate('history')} icon="↺" label="Trade journal" /><NavButton active={view === 'analysis'} onClick={() => navigate('analysis')} icon="◫" label="Analysis" /><NavButton active={view === 'settings'} onClick={() => navigate('settings')} icon="⚙" label="Settings" /></div>
        <div className="drawer-section"><span className="drawer-label">VIEW</span><div className="segmented drawer-segmented"><button className={mode === 'simple' ? 'active' : ''} onClick={() => setMode('simple')}>Simple</button><button className={mode === 'advanced' ? 'active' : ''} onClick={() => setMode('advanced')}>Advanced</button></div></div>
        <div className="drawer-stats"><div><span>Capital</span><strong>₹{Number(settings.capital).toLocaleString('en-IN')}</strong></div><div><span>Risk</span><strong>{settings.riskPct}%</strong></div><div><span>Sim lots</span><strong>{settings.defaultLots}</strong></div></div>
        <div className="drawer-actions"><button onClick={() => setTheme(current => current === 'dark' ? 'light' : 'dark')}>{theme === 'dark' ? <SunIcon /> : <MoonIcon />}<span>{theme === 'dark' ? 'Light mode' : 'Dark mode'}</span></button><button onClick={toggleAlerts}><span className="drawer-action-dot" /><span>{alertsEnabled ? 'Alerts on' : 'Enable alerts'}</span></button><button disabled={refreshing} onClick={() => refreshSnapshot({ manual: true })}><RefreshIcon /><span>{refreshing ? 'Checking…' : 'Refresh market'}</span></button>{brokerStatus.configured && <button className={`drawer-reconnect-btn ${authRequired ? 'required' : ''}`} onClick={onReconnect}><ReconnectIcon /><span>{authRequired ? 'Reconnect FYERS now' : 'Reconnect FYERS'}</span></button>}</div>
        <button className="drawer-settings-cta" onClick={() => navigate('settings')}>Account & automation settings</button>
      </aside>
    </div>
  );
}

function NavButton({ active, onClick, icon, label }) {
  return <button type="button" className={`sidebar-nav-button ${active ? 'active' : ''}`} onClick={onClick}><span>{icon}</span><strong>{label}</strong></button>;
}

function closeTrade(current, meta, snapshot, scalpStatus, settings) {
  const underlyingExit = finite(current.underlyingCurrent) ?? finite(snapshot?.market?.spot) ?? finite(current.underlyingEntry) ?? 0;
  const optionExit = finite(current.currentPrice) ?? finite(current.entry) ?? 0;
  const entry = finite(current.entry) ?? optionExit;
  const quantity = Math.max(0, Number(current.quantity) || 0);
  const pnl = (optionExit - entry) * quantity;
  const riskPoints = Math.max(0.01, Math.abs(Number(current.underlyingEntry) - Number(current.underlyingStop)));
  const movePoints = current.side === 'CE' ? underlyingExit - Number(current.underlyingEntry) : Number(current.underlyingEntry) - underlyingExit;
  const rAchieved = movePoints / riskPoints;
  const closedAt = new Date().toISOString();
  const heldMs = Math.max(0, Date.now() - new Date(current.openedAt).getTime());
  const heldMinutes = Math.max(0, Math.round(heldMs / 60000));
  const currentPnl = finite(current.currentUnrealizedPnl) ?? pnl;
  const peakPnl = finite(current.peakUnrealizedPnl) ?? Math.max(0, currentPnl);
  const maxGivebackPnl = Math.max(0, peakPnl - currentPnl);

  return {
    ...current,
    exit: optionExit,
    underlyingExit,
    pnl,
    rAchieved,
    heldMinutes,
    heldSeconds: Math.round(heldMs / 1000),
    closedAt,
    closedBy: meta.closedBy || 'USER',
    exitMethod: (meta.closedBy || 'USER') === 'MENTOR' ? 'AUTO' : 'MANUAL',
    exitReasonCode: meta.reasonCode || inferExitReason(current, underlyingExit),
    exitReason: meta.reason || 'Manual simulated exit.',
    exitMentorState: meta.mentorState || 'MANUAL EXIT',
    mentorSuggestionAtExit: snapshot?.decision?.headline || '',
    exitMandatoryPassCount: current.strategyFamily === 'SCALP' ? null : classifyResearchSetup(snapshot).mandatoryPassCount,
    exitConfirmationPassCount: current.strategyFamily === 'SCALP' ? null : classifyResearchSetup(snapshot).confirmationPassCount,
    scalpExitEvaluation: current.strategyFamily === 'SCALP' && scalpStatus ? {
      eligible: Boolean(scalpStatus.eligible),
      manualEligible: Boolean(scalpStatus.manualEligible),
      score: scalpStatus.score,
      side: scalpStatus.side,
      spot: scalpStatus.spot,
      vwap: scalpStatus.vwap,
      atr: scalpStatus.atr,
      trigger: scalpStatus.trigger,
      stop: scalpStatus.stop,
      target: scalpStatus.target,
      riskPoints: scalpStatus.riskPoints,
      extension: scalpStatus.extension,
      bodyRatio: scalpStatus.bodyRatio,
      latestCompletedTime: scalpStatus.latestCompletedTime,
      reason: scalpStatus.reason,
      checks: scalpStatus.checks
    } : null,
    scalpScoreAtExit: current.strategyFamily === 'SCALP' ? scalpStatus?.score ?? null : null,
    scalpChecksPassAtExit: current.strategyFamily === 'SCALP' && Array.isArray(scalpStatus?.checks) ? scalpStatus.checks.filter(item => item.pass).length : null,
    autoCloseEnabledAtExit: current.strategyFamily === 'SCALP' ? settings.scalpAutoClose !== false : settings.mentorAutoClose !== false,
    peakUnrealizedPnl: peakPnl,
    finalUnrealizedPnlBeforeClose: currentPnl,
    maxProfitGivebackPnl: maxGivebackPnl,
    scalpTrailingActive: Boolean(current.scalpTrailingActive),
    scalpTrailingActivatedAt: current.scalpTrailingActivatedAt || null,
    scalpTrailingPeakR: current.scalpTrailingPeakR ?? current.bestR ?? null,
    scalpTrailingFloorR: current.scalpTrailingFloorR ?? null,
    scalpTrailingGivebackR: current.scalpTrailingGivebackR ?? null,
    scalpTrailingExit: meta.reasonCode === 'SCALP_TRAILING_STOP',
    scalpTimeLimitExit: meta.reasonCode === 'SCALP_TIME_EXIT',
    scalpTrailPolicy: current.scalpTrailPolicy || null,
    exitSnapshot: snapshot ? { market: { ...snapshot.market }, decision: { ...snapshot.decision }, parameters: snapshot.parameters, structure: { ...snapshot.structure }, setup: { ...snapshot.setup } } : null
  };
}

function updateLivePosition(current, liveOption, liveNifty, fallbackSpot) {
  if (!current) return current;
  const currentPrice = Number.isFinite(liveOption) && liveOption > 0 ? liveOption : finite(current.currentPrice) ?? finite(current.entry) ?? 0;
  const underlyingCurrent = Number.isFinite(liveNifty) && liveNifty > 0 ? liveNifty : finite(fallbackSpot) ?? finite(current.underlyingCurrent) ?? finite(current.underlyingEntry) ?? 0;
  const riskPoints = Math.max(0.01, Math.abs(Number(current.underlyingEntry) - Number(current.underlyingStop)));
  const movePoints = current.side === 'CE' ? underlyingCurrent - Number(current.underlyingEntry) : Number(current.underlyingEntry) - underlyingCurrent;
  const currentR = Number.isFinite(movePoints) ? movePoints / riskPoints : Number(current.currentR || 0);
  const bestR = Math.max(Number.isFinite(Number(current.bestR)) ? Number(current.bestR) : 0, currentR);
  const worstR = Math.min(Number.isFinite(Number(current.worstR)) ? Number(current.worstR) : 0, currentR);
  const quantity = Math.max(0, Number(current.quantity) || 0);
  const currentUnrealizedPnl = (currentPrice - Number(current.entry || currentPrice)) * quantity;
  const peakUnrealizedPnl = Math.max(Number.isFinite(Number(current.peakUnrealizedPnl)) ? Number(current.peakUnrealizedPnl) : 0, currentUnrealizedPnl);
  const next = {
    ...current,
    currentPrice,
    underlyingCurrent,
    currentR,
    bestR,
    worstR,
    currentUnrealizedPnl,
    peakUnrealizedPnl,
    bestOptionPrice: Math.max(Number.isFinite(Number(current.bestOptionPrice)) ? Number(current.bestOptionPrice) : Number(current.entry), currentPrice),
    worstOptionPrice: Math.min(Number.isFinite(Number(current.worstOptionPrice)) ? Number(current.worstOptionPrice) : Number(current.entry), currentPrice),
    oneRReached: Boolean(current.oneRReached || currentR >= 1 || bestR >= 1)
  };

  if (current.strategyFamily === 'SCALP') {
    const trail = scalpTrail(bestR, current.scalpTrailingFloorR);
    next.scalpTrailingActive = trail.active;
    next.scalpTrailingPeakR = bestR;
    next.scalpTrailingFloorR = trail.floorR;
    next.scalpTrailingGivebackR = Math.max(0, bestR - currentR);
    next.scalpTrailPolicy = 'SIMULATION ONLY, using NIFTY-index R (not an exchange or FYERS stop): +0.50R protects 0R gross; +0.60R protects +0.50R; +0.75R protects +0.55R; +0.90R protects +0.75R; never lower the floor.';
    if (trail.active && !current.scalpTrailingActivatedAt) next.scalpTrailingActivatedAt = new Date().toISOString();
  }
  return next;
}

function scalpTrail(bestR, previousFloorR = null) {
  // Paper-trade trail driven by observed NIFTY R. The PWA does not place or
  // modify exchange-side FYERS stop orders; quotes may gap past a floor.
  if (!Number.isFinite(bestR) || bestR < 0.5) return { active: false, floorR: null };
  let proposedFloorR = 0;
  if (bestR >= 0.90) proposedFloorR = Math.max(0.75, bestR - 0.15);
  else if (bestR >= 0.75) proposedFloorR = 0.55;
  else if (bestR >= 0.60) proposedFloorR = 0.50;
  const previous = previousFloorR == null || previousFloorR === '' ? null : Number(previousFloorR);
  const protectedFloorR = Number.isFinite(previous)
    ? Math.max(previous, proposedFloorR)
    : proposedFloorR;
  return { active: true, floorR: Math.min(bestR, protectedFloorR) };
}

function findQuoteNode(nodes, symbol) {
  return nodes.find(node => node?.n === symbol || node?.v?.symbol === symbol);
}

function inferExitReason(position, underlyingExit) {
  const stopHit = position.side === 'CE' ? underlyingExit <= position.underlyingStop : underlyingExit >= position.underlyingStop;
  return stopHit ? 'STRUCTURE_INVALIDATED' : 'MANUAL_EXIT';
}

function initialPosition(kind) {
  const key = kind === 'scalp' ? SCALP_POSITION_KEY : CORE_POSITION_KEY;
  const saved = readJson(key, null);
  if (saved) return saved;
  const legacy = readJson(LEGACY_POSITION_KEY, null);
  if (!legacy) return null;
  const isScalp = legacy.strategyFamily === 'SCALP';
  return kind === 'scalp' ? (isScalp ? legacy : null) : (!isScalp ? legacy : null);
}

function persistPosition(key, position) {
  try {
    if (position) localStorage.setItem(key, JSON.stringify(position));
    else localStorage.removeItem(key);
  } catch {}
}

function finite(value) {
  const n = Number(value);
  return Number.isFinite(n) ? n : null;
}

function pruneLedger(ledger) {
  const keys = Object.keys(ledger);
  if (keys.length <= 120) return;
  keys.sort((a, b) => String(ledger[a]?.openedAt || '').localeCompare(String(ledger[b]?.openedAt || ''))).slice(0, keys.length - 120).forEach(key => delete ledger[key]);
}

function readJson(key, fallback) { try { const value = localStorage.getItem(key); return value ? JSON.parse(value) : fallback; } catch { return fallback; } }
function readString(key, fallback) { try { return localStorage.getItem(key) || fallback; } catch { return fallback; } }
function formatTime(value) { if (!value) return '—'; const date = new Date(value); return Number.isNaN(date.getTime()) ? '—' : date.toLocaleTimeString('en-IN', { hour: '2-digit', minute: '2-digit', second: '2-digit' }); }
function formatR(value) { const n = Number(value); return Number.isFinite(n) ? `${n >= 0 ? '+' : ''}${n.toFixed(2)}R` : '—'; }

function AnalysisPageLoading() {
  return <div className="mentor-page"><div className="analysis-route-loading"><span /><div><strong>Opening Analysis…</strong><small>Mentor trading screens stay lightweight; the Replay Lab loads only when you open it.</small></div></div></div>;
}
function ToolbarStat({ label, value }) { return <div className="toolbar-stat-v2"><span>{label}</span><strong>{value}</strong></div>; }
function MenuIcon() { return <svg viewBox="0 0 24 24" width="22" height="22" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round"><path d="M5 7h14M5 12h14M5 17h14" /></svg>; }
function CloseIcon() { return <svg viewBox="0 0 24 24" width="22" height="22" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round"><path d="M6 6l12 12M18 6L6 18" /></svg>; }
function MoonIcon() { return <svg viewBox="0 0 24 24" width="17" height="17" fill="none" stroke="currentColor" strokeWidth="1.9" strokeLinecap="round" strokeLinejoin="round"><path d="M20.2 15.1A8.4 8.4 0 0 1 8.9 3.8 8.6 8.6 0 1 0 20.2 15.1Z" /></svg>; }
function SunIcon() { return <svg viewBox="0 0 24 24" width="17" height="17" fill="none" stroke="currentColor" strokeWidth="1.9" strokeLinecap="round"><circle cx="12" cy="12" r="3.7" /><path d="M12 2.3v2M12 19.7v2M4.1 4.1l1.4 1.4M18.5 18.5l1.4 1.4M2.3 12h2M19.7 12h2M4.1 19.9l1.4-1.4M18.5 5.5l1.4-1.4" /></svg>; }
function RefreshIcon() { return <svg viewBox="0 0 24 24" width="17" height="17" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round"><path d="M20 6v5h-5M4 18v-5h5" /><path d="M18.2 9A7 7 0 0 0 6 6.6L4 9M5.8 15A7 7 0 0 0 18 17.4l2-2.4" /></svg>; }
function ReconnectIcon() { return <svg viewBox="0 0 24 24" width="17" height="17" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><path d="M20 11a8 8 0 1 0-2.34 5.66" /><path d="M20 4v7h-7" /></svg>; }

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
function sendBrowserExitNotification(position, meta) {
  try {
    if (typeof Notification === 'undefined' || Notification.permission !== 'granted') return;
    const title = meta.mentorState || 'Position exit';
    const body = meta.reason || 'The Mentor closed the simulated position.';
    const notification = new Notification(`Options Mentor — ${title}`, { body, tag: `mentor-exit-${position.id}-${meta.reasonCode || 'exit'}`, requireInteraction: true });
    notification.onclick = () => { window.focus(); notification.close(); };
  } catch {}
}


function isFyersTokenError(detail) {
  const text = typeof detail === 'string' ? detail.trim() : '';
  return /\b(?:invalid access token|access token (?:has )?expired|token is invalid|token has expired|authentication token expired)\b/i.test(text);
}
