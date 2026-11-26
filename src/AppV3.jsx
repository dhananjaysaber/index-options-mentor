import { FyersCoreTrade, FyersScalpTrade, FyersDetail, FyersTicket, FyersPositions, FyersJournal, FyersSettings } from './components/FyersReferenceViews.jsx';
import { updateLivePosition } from './engine/managedPosition.js';
import { readTradingJson, writeTradingJson, commitPaperOpen, commitPaperClose } from './services/tradingStorage.js';
import TradeStorageNotice, { TradeRecoveryPanel } from './components/TradeStorageNotice.jsx';
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
import useLiveQuote from './hooks/useLiveQuote.js';
import { useScalpResearch } from './hooks/useScalpResearch.js';
import { buildScalpTicket } from './engine/scalpStrategy.js';
import { computeScalpOptionTrail, isScalpOptionTrailBreached } from './engine/scalpOptionTrail.js';
import { computeCoreOptionTrail, isCoreOptionTrailBreached } from './engine/coreOptionTrail.js';
import { computeCoreTargetIndexTrail, isCoreTargetIndexTrailBreached } from './engine/coreTargetIndexTrail.js';
import CoreResearchPanel from './components/CoreResearchPanel.jsx';
import CoreQuickActions from './components/CoreQuickActions.jsx';
import MobileMentorDashboardV41 from './components/MobileMentorDashboardV41.jsx';
import { derivePositionMentor, deriveScalpPositionMentor } from './engine/positionMentor.js';
import { buildSimulatedTicket, classifyManualResearchSetup, classifyResearchSetup, tierEnabled } from './engine/researchStrategy.js';
import { syncJournalHistory } from './services/tradeJournal.js';
import { clearFyersSession, getFyersLoginUrl } from './services/apiBridge.js';
import { queuePaperOpen, queuePaperClose, acknowledgeAwsPaperExit, findVerifiedAwsPaperExit } from './services/paperSync.js';
import { clearFyersCooldown } from './services/fyersRequestGuard.js';
import SnapshotIssueBanner from './components/SnapshotIssueBanner.jsx';
import PremiumMarketTicker, { UiIcon } from './components/PremiumMarketTicker.jsx';
import { FYERS_REFRESH, isNseMarketHours } from './services/fyersRefreshPolicy.js';
import { assessMarketFreshness } from './services/marketFreshness.js';
import { listenForTabResume } from './services/tabResume.js';

const ResearchAnalysis = lazy(() => import('./components/ResearchAnalysis.jsx'));

const HISTORY_KEY = 'index-options-mentor-history-v05';
const LEGACY_POSITION_KEY = 'index-options-mentor-open-position-v07';
const CORE_POSITION_KEY = 'index-options-mentor-core-position-v41';
const SCALP_POSITION_KEY = 'index-options-mentor-scalp-position-v41';
const ALERTS_KEY = 'index-options-mentor-alerts-enabled-v07';
const THEME_KEY = 'index-options-mentor-theme-v1';
const SETTINGS_KEY = 'index-options-mentor-settings-v2';
const AUTO_SETUP_KEY = 'index-options-mentor-auto-setups-v1';
const SCALP_LEDGER_KEY = 'index-options-mentor-scalp-ledger-v1';
const STRATEGY_MODE_KEY = 'index-options-mentor-strategy-mode-v1';

const DEFAULT_SETTINGS = {
  capital: 50000,
  riskPct: 1,
  tradeAmount: 30000,
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
  const [mode, setMode] = useState('advanced');
  const [strategyMode, setStrategyMode] = useState(() => readString(STRATEGY_MODE_KEY, 'core') === 'scalp' ? 'scalp' : 'core');
  const [marketClock, setMarketClock] = useState(Date.now);
  const liveQuote = useLiveQuote();
  const [mobileMenuOpen, setMobileMenuOpen] = useState(false);
  const [brokerStatus, setBrokerStatus] = useState({ configured: false, authenticated: false });
  const [snapshot, setSnapshot] = useState(null);
  const [loading, setLoading] = useState(true);
  const [refreshing, setRefreshing] = useState(false);
  const [liveError, setLiveError] = useState('');
  const [authRequired, setAuthRequired] = useState(false);
  const snapshotRequestRef = useRef(false);
  const resumeSnapshotPendingRef = useRef(false);
  const [lastReturnAt, setLastReturnAt] = useState(0);
  const [clockTick, setClockTick] = useState(0);
  const [theme, setTheme] = useState(() => {
    // Introduce the approved dark premium interface once, then honour the
    // user's normal Light/Dark preference for subsequent launches.
    const premiumActivated = readString('iom-premium-theme-v1', '0') === '1';
    return premiumActivated
      ? (readString(THEME_KEY, 'dark') === 'light' ? 'light' : 'dark')
      : 'dark';
  });
  const [settings, setSettings] = useState(() => ({ ...DEFAULT_SETTINGS, ...readJson(SETTINGS_KEY, {}) }));
  const [corePosition, setCorePosition] = useState(() => initialPosition('core'));
  const [scalpPosition, setScalpPosition] = useState(() => initialPosition('scalp'));
  const [history, setHistory] = useState(() => readJson(HISTORY_KEY, []));
  const [alertsEnabled, setAlertsEnabled] = useState(() => readString(ALERTS_KEY, '0') === '1');
  const [notificationPermission, setNotificationPermission] = useState(() => typeof Notification !== 'undefined' ? Notification.permission : 'unsupported');
  const audioRef = useRef(null);
  const autoExitRef = useRef({ core: '', scalp: '', trail: '', option: '', coreOption: '', coreTarget: '', time: '' });
  const closingTradeIdsRef = useRef(new Set());
  const openingStrategiesRef = useRef(new Set());
  const positionRefs = useRef({ core: null, scalp: null });
  positionRefs.current = { core: corePosition, scalp: scalpPosition };


  const [operationError, setOperationError] = useState('');

  // Both independent freshness gates remain mandatory; no stale-entry override.
  const freshness = assessMarketFreshness({
    snapshot, quote: liveQuote, authenticated: brokerStatus.authenticated,
    error: liveError, now: marketClock
  });
  const marketDataReady = freshness.ready;
  const scalpResearch = useScalpResearch({
    snapshot, liveQuote, brokerAuthenticated: brokerStatus.authenticated,
    marketDataReady, clock: marketClock
  });
  const scalpStatus = scalpResearch.evaluation;
  // Process only a verified AWS paper-exit receipt for this exact local trade.
  // Never treat a missing AWS position as proof of exit.
  useEffect(() => {
    const onPaperSyncStatus = event => {
      const closed = event?.detail?.recentlyClosed;
      if (!Array.isArray(closed)) return;
      for (const strategy of ['core', 'scalp']) {
        const current = positionRefs.current[strategy];
        if (!current?.id) continue;
        const receipt = findVerifiedAwsPaperExit(closed, strategy, current.id);
        if (!receipt) continue;
        exitStrategy(strategy, {
          closedBy: 'AWS_MONITOR',
          reasonCode: receipt.exitReason || 'AWS_PAPER_EXIT',
          reason: 'AWS paper monitor exit at observed option quote.',
          awsReceipt: receipt
        });
      }
    };
    window.addEventListener('mentor:paper-sync-status', onPaperSyncStatus);
    return () => window.removeEventListener('mentor:paper-sync-status', onPaperSyncStatus);
  }, [snapshot, scalpStatus, settings, alertsEnabled]);

  const activePosition = strategyMode === 'scalp' ? scalpPosition : corePosition;
  const positionCount = Number(Boolean(corePosition)) + Number(Boolean(scalpPosition));

  // iOS standalone PWAs can restore the prior scroll offset on launch.
  // Reset the main document when opening or changing a view/strategy so
  // the fixed status-bar-safe header never starts over a half-hidden card.
  useEffect(() => {
    window.scrollTo(0, 0);
    const frame = window.requestAnimationFrame(() => window.scrollTo(0, 0));
    return () => window.cancelAnimationFrame(frame);
  }, [view, strategyMode]);

  useEffect(() => {
    document.documentElement.dataset.theme = theme;
    writeTradingJson(THEME_KEY, theme);
    writeTradingJson('iom-premium-theme-v1', '1');
    const meta = document.querySelector('meta[name="theme-color"]');
    if (meta) meta.setAttribute('content', theme === 'dark' ? '#0b1220' : '#ffffff');
  }, [theme]);

  useEffect(() => { writeTradingJson(SETTINGS_KEY, settings); }, [settings]);
  useEffect(() => {
    const timer = window.setInterval(() => {
      if (document.visibilityState === 'visible') setMarketClock(Date.now());
    }, 2000);
    // Focus covers switching to another browser window; visibilitychange covers
    // background tabs; pageshow covers browser back-forward cache restoration.
    // All three are deduplicated and use the existing single-flight REST calls.
    const removeResume = listenForTabResume({
      window, document,
      onResume: () => {
        const at = Date.now();
        setMarketClock(at); // immediately invalidate old data before any entry
        if (brokerStatus.authenticated && isNseMarketHours(at)) {
          setLastReturnAt(at);
          window.dispatchEvent(new Event('mentor:refresh-live-quote'));
          void refreshSnapshot({ resume: true });
        }
      }
    });
    return () => { window.clearInterval(timer); removeResume(); };
  }, [brokerStatus.authenticated]);
  useEffect(() => { writeTradingJson(HISTORY_KEY, history); }, [history]);
  useEffect(() => { persistPosition(CORE_POSITION_KEY, corePosition); }, [corePosition]);
  useEffect(() => { persistPosition(SCALP_POSITION_KEY, scalpPosition); }, [scalpPosition]);
  useEffect(() => { if (corePosition?.id) queuePaperOpen('core', corePosition); }, [corePosition?.id]);
  useEffect(() => { if (scalpPosition?.id) queuePaperOpen('scalp', scalpPosition); }, [scalpPosition?.id]);
  useEffect(() => {
    const journalPosition = activePosition || corePosition || scalpPosition;
    persistPosition(LEGACY_POSITION_KEY, journalPosition);
  }, [activePosition?.id, corePosition?.id, scalpPosition?.id, strategyMode]);
  useEffect(() => { writeTradingJson(ALERTS_KEY, alertsEnabled ? '1' : '0'); }, [alertsEnabled]);
  useEffect(() => { writeTradingJson(STRATEGY_MODE_KEY, strategyMode); }, [strategyMode]);

  useEffect(() => {
    let cancelled = false;
    const applyHistory = event => {
      const rows = event?.detail?.history;
      if (!cancelled && Array.isArray(rows)) {
        setHistory(previous => mergeCompletedHistory(previous, rows));
        const closedIds=new Set(rows.filter(t=>t?.closedAt).map(t=>t.id));
        setCorePosition(current=>closedIds.has(current?.id)?null:current);
        setScalpPosition(current=>closedIds.has(current?.id)?null:current);
      }
    };
    window.addEventListener('mentor:journal-history', applyHistory);
    syncJournalHistory().then(rows => {
      if (!cancelled && Array.isArray(rows)) {
        setHistory(previous => mergeCompletedHistory(previous, rows));
        const closedIds=new Set(rows.filter(t=>t?.closedAt).map(t=>t.id));
        setCorePosition(current=>closedIds.has(current?.id)?null:current);
        setScalpPosition(current=>closedIds.has(current?.id)?null:current);
      }
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
    // Never overlap FYERS snapshot requests; a focus event during an existing
    // request queues exactly one follow-up instead of losing the resume refresh.
    if (snapshotRequestRef.current) {
      if (options?.resume === true) resumeSnapshotPendingRef.current = true;
      return null;
    }
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
      if (resumeSnapshotPendingRef.current) {
        resumeSnapshotPendingRef.current = false;
        if (document.visibilityState === 'visible' && isNseMarketHours()) void refreshSnapshot();
      }
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
    const timer = window.setInterval(() => {
      if (document.visibilityState === 'visible' && isNseMarketHours()) void refreshSnapshot();
    }, FYERS_REFRESH.mentorMs);
    return () => window.clearInterval(timer);
  }, [brokerStatus.authenticated]);

  useEffect(() => {
    if (!scalpPosition) return undefined;
    const timer = window.setInterval(() => setClockTick(value => value + 1), 1000);
    return () => window.clearInterval(timer);
  }, [scalpPosition?.id]);

  useEffect(() => {
    // Subscribe to the existing 1-second shared Prime quote loop. Both strategy
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
        ? updateLivePosition(current, optionPrice(current.symbol), nifty, null, quote.at)
        : current);
      setScalpPosition(current => current
        ? updateLivePosition(current, optionPrice(current.symbol), nifty, null, quote.at)
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
    if (!marketDataReady || document.visibilityState !== 'visible' || !isNseMarketHours() ||
      !settings.mentorAutoOpen || corePosition || !setupClassification.eligible ||
      !tierEnabled(setupClassification, settings)) return;
    const ledger = readJson(AUTO_SETUP_KEY, {});
    const key = setupClassification.setupId;
    if (!key || ledger[key]) return;
    const ticket = buildSimulatedTicket(snapshot, settings, 'MENTOR');
    if (!ticket) return;
    ledger[key] = { openedAt: ticket.openedAt, tier: ticket.strategyTier };
    pruneLedger(ledger);
    writeTradingJson(AUTO_SETUP_KEY, ledger);
    takeTrade({ ...ticket, researchQualificationTier: setupClassification.tier, researchQualificationLabel: setupClassification.label, researchTagAtEntry: `${setupClassification.label} · auto entry` });
  }, [snapshot?.generatedAt, marketDataReady, corePosition?.id, settings.mentorAutoOpen, settings.controlledResearch, settings.experimentalResearch, settings.tradeAmount, settings.defaultLots, settings.lotCap]);

  // Both Index strategies monitor and simulate entries independently of which
  // view is selected. The Scalp dashboard is now presentation-only; no extra
  // FYERS quote loop or duplicate auto-entry effect is created.
  useEffect(() => {
    if (!marketDataReady || document.visibilityState !== 'visible' || !isNseMarketHours() ||
        !settings.scalpAutoOpen || scalpPosition || !scalpStatus?.eligible ||
        !scalpStatus.setupId) return;
    const ledger = readJson(SCALP_LEDGER_KEY, {});
    if (ledger[scalpStatus.setupId]) return;
    const ticket = buildScalpTicket(snapshot, scalpStatus, settings, 'MENTOR');
    if (!ticket) return;
    ledger[scalpStatus.setupId] = {
      openedAt: ticket.openedAt, side: ticket.side, score: ticket.score
    };
    pruneLedger(ledger);
    writeTradingJson(SCALP_LEDGER_KEY, ledger);
    takeTrade(ticket);
  }, [snapshot?.generatedAt, scalpStatus?.setupId, scalpStatus?.eligible,
      marketDataReady, scalpPosition?.id, settings.scalpAutoOpen,
      settings.tradeAmount, settings.defaultLots, settings.lotCap]);

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

  // Target becomes the first protected NIFTY stop only AFTER price has moved
  // +0.25R beyond it. Then the stop climbs 0.50R behind the best NIFTY move.
  // The option contract must also have a fresh quote to simulate its true LTP
  // exit; neither NIFTY level nor past option peak is a guaranteed fill.
  useEffect(() => {
    if (!corePosition || settings.mentorAutoClose === false ||
        !brokerStatus.authenticated || document.visibilityState !== 'visible' || !isNseMarketHours()) {
      autoExitRef.current.coreTarget = '';
      return;
    }
    if (!isCoreTargetIndexTrailBreached(corePosition)) return;
    const floor = Number(corePosition.coreTargetIndexTrailStop);
    const nifty = Number(corePosition.underlyingCurrent);
    const target = Number(corePosition.underlyingTarget);
    const signature = `${corePosition.id}:${floor.toFixed(2)}`;
    if (autoExitRef.current.coreTarget === signature) return;
    autoExitRef.current.coreTarget = signature;
    exitStrategy('core', {
      mentorState: '13-POINT TARGET RUNNER EXIT',
      reasonCode: 'CORE_TARGET_INDEX_TRAIL',
      reason: `Fresh NIFTY ${nifty.toFixed(2)} crossed the rising 13-Point target-based stop at ${floor.toFixed(2)} (original target ${target.toFixed(2)}). Simulated close uses the latest observed option premium, NOT this NIFTY stop level.`,
      closedBy: 'MENTOR'
    });
  }, [
    corePosition?.id, corePosition?.coreTargetIndexTrailActive,
    corePosition?.coreTargetIndexTrailStop, corePosition?.underlyingCurrent,
    corePosition?.lastUnderlyingQuoteAt, corePosition?.lastOptionQuoteAt,
    settings.mentorAutoClose, brokerStatus.authenticated
  ]);

  // Paper option-P&L protection is independent of NIFTY-index R trailing.
  // Trigger only against fresh contract quotes, never stale/cached LTP.
  // The 13-Point runner uses its own *option-premium* profit trail.
  // Keep its structural stop and strategy-deterioration exits unchanged.
  // This is a simulated exit at the current observed option LTP, not a broker order.
  useEffect(() => {
    if (!corePosition || settings.mentorAutoClose === false ||
        !brokerStatus.authenticated || document.visibilityState !== 'visible' || !isNseMarketHours()) {
      autoExitRef.current.coreOption = '';
      return;
    }
    if (!isCoreOptionTrailBreached(corePosition)) return;
    const floor = Number(corePosition.coreOptionTrailingFloorPnl);
    const pnl = Number(corePosition.currentUnrealizedPnl);
    const peak = Number(corePosition.peakUnrealizedPnl);
    const signature = `${corePosition.id}:${floor.toFixed(2)}`;
    if (autoExitRef.current.coreOption === signature) return;
    autoExitRef.current.coreOption = signature;
    exitStrategy('core', {
      mentorState: '13-POINT RUNNER PROFIT TRAIL',
      reasonCode: 'CORE_OPTION_PROFIT_TRAIL',
      reason: `Option P&L ${formatCurrencyPnl(pnl)} fell through the 13-Point runner floor ${formatCurrencyPnl(floor)} after peaking at ${formatCurrencyPnl(peak)}. Simulated exit at the current observed option LTP (not a guaranteed floor fill).`,
      closedBy: 'MENTOR'
    });
  }, [
    corePosition?.id, corePosition?.coreOptionTrailingActive,
    corePosition?.coreOptionTrailingFloorPnl, corePosition?.currentUnrealizedPnl,
    corePosition?.lastOptionQuoteAt, settings.mentorAutoClose, brokerStatus.authenticated
  ]);

  useEffect(() => {
    if (!scalpPosition || settings.scalpAutoClose === false ||
        document.visibilityState !== 'visible' || !isNseMarketHours()) {
      autoExitRef.current.option = '';
      return;
    }
    if (!isScalpOptionTrailBreached(scalpPosition)) return;
    const floor = Number(scalpPosition.optionTrailingFloorPnl);
    const pnl = Number(scalpPosition.currentUnrealizedPnl);
    const peak = Number(scalpPosition.peakUnrealizedPnl);
    const signature = `${scalpPosition.id}:${floor.toFixed(2)}`;
    if (autoExitRef.current.option === signature) return;
    autoExitRef.current.option = signature;
    exitStrategy('scalp', {
      mentorState: 'SCALP OPTION PROFIT TRAIL',
      reasonCode: 'SCALP_OPTION_PROFIT_TRAIL',
      reason: `Observed gross option P&L ${formatCurrencyPnl(pnl)} crossed the paper trailing floor ${formatCurrencyPnl(floor)} after peaking at ${formatCurrencyPnl(peak)}. Simulated exit uses the current observed option quote, not the historical floor price.`,
      closedBy: 'MENTOR'
    });
  }, [
    scalpPosition?.id, scalpPosition?.optionTrailingActive,
    scalpPosition?.optionTrailingFloorPnl, scalpPosition?.currentUnrealizedPnl,
    scalpPosition?.lastOptionQuoteAt, settings.scalpAutoClose
  ]);

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

  async function takeTrade(ticket) {
    // Old 5m/3m structure may remain visible when the calculation endpoint
    // fails. It must not open NEW positions until a fresh snapshot succeeds.
    if (!ticket?.quantity || !marketDataReady) return;
    const initiatedBy = ticket.initiatedBy || 'USER';
    const enriched = {
      ...ticket,
      initiatedBy,
      openedByMentor: ticket.openedByMentor === true || initiatedBy === 'MENTOR'
    };
    const strategy=ticket.strategyFamily==='SCALP'?'scalp':'core';
    if(positionRefs.current[strategy]||openingStrategiesRef.current.has(strategy))return;
    openingStrategiesRef.current.add(strategy);
    try {
      await commitPaperOpen(strategy==='scalp'?SCALP_POSITION_KEY:CORE_POSITION_KEY,enriched);
      positionRefs.current[strategy]=enriched;
      if(strategy==='scalp')setScalpPosition(current => current ? current : enriched);
      else setCorePosition(current => current ? current : enriched);
      setOperationError('');
    } catch(error) {setOperationError(error?.message||'The paper position could not be saved and was not opened.');}
    finally {openingStrategiesRef.current.delete(strategy);}
  }

  async function exitStrategy(strategy, meta = {}) {
    // NEVER call setHistory from inside a setPosition functional updater:
    // React can invoke those updaters during rendering, crashing the PWA.
    // The synchronous ref also prevents double taps / competing auto exits.
    const current = positionRefs.current[strategy === 'scalp' ? 'scalp' : 'core'];
    if (!current?.id || closingTradeIdsRef.current.has(current.id)) return;
    closingTradeIdsRef.current.add(current.id);
    try {
      let closed = closeTrade(current, meta, snapshot, scalpStatus, settings);
      if (!Number.isFinite(closed.pnl) || !Number.isFinite(closed.exit)) {
        throw new Error('Cannot record this simulated exit: option price is invalid.');
      }
      const usesAwsMonitor = window.location.origin === 'https://deploy-preview-28--optionsmentor.netlify.app';
      if (usesAwsMonitor && meta.closedBy !== 'AWS_MONITOR') {
        const receipt = await reconcilePreviewExit(strategy, current.id, meta.closedBy === 'MENTOR');
        if (receipt) {
          meta = {
            closedBy: 'AWS_MONITOR',
            reasonCode: receipt.exitReason || 'AWS_PAPER_EXIT',
            reason: 'AWS paper monitor exit at observed option quote.',
            awsReceipt: receipt
          };
          closed = closeTrade(current, meta, snapshot, scalpStatus, settings);
        }
      }
      closed = await commitPaperClose(strategy === 'scalp' ? SCALP_POSITION_KEY : CORE_POSITION_KEY, closed);
      setHistory(previous => [closed, ...previous.filter(row => row?.id !== closed.id)].slice(0, 1000));
      if (usesAwsMonitor || meta.closedBy === 'AWS_MONITOR') {
        acknowledgeAwsPaperExit(strategy, closed.id);
      } else {
        queuePaperClose(strategy, closed.id, meta.closedBy === 'MENTOR');
      }
      positionRefs.current[strategy === 'scalp' ? 'scalp' : 'core'] = null;
      if (strategy === 'scalp') setScalpPosition(existing => existing?.id === closed.id ? null : existing);
      else setCorePosition(existing => existing?.id === closed.id ? null : existing);
      setOperationError('');
      if (alertsEnabled && meta.closedBy === 'MENTOR') {
        // Notification failures must never undo or misreport a completed SELL.
        try {
          playExitTone(audioRef);
          sendBrowserExitNotification(current, meta);
        } catch (notificationError) {
          console.warn('Exit recorded; optional alert failed', notificationError);
        }
      }
    } catch (error) {
      closingTradeIdsRef.current.delete(current.id);
      autoExitRef.current={core:'',scalp:'',trail:'',option:'',coreOption:'',coreTarget:'',time:''};
      setOperationError(error?.message || 'Exit could not be recorded. Position remains open; retry SELL.');
      console.error('Simulated SELL/exit failed:', error);
    }
  }

  function navigate(next) {
    setView(next);
    setMobileMenuOpen(false);
    // Returning to either strategy requires an immediate recheck of BOTH streams.
    if (next === 'dashboard' && brokerStatus.authenticated && document.visibilityState === 'visible') {
      setMarketClock(Date.now());
      window.dispatchEvent(new Event('mentor:refresh-live-quote'));
      if (isNseMarketHours()) void refreshSnapshot({ resume: true });
    }
  }

  function retryFyersAfterUpgrade() {
    // FYERS upgrades Prime API limits immediately after payment, but a
    // Standard daily-limit response may still be locally remembered.
    // Only a deliberate user click clears this safeguard.
    clearFyersCooldown();
    void refreshSnapshot({ manual: true });
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
  return (
    <div className="app-shell mentor-v2-shell research-v41-shell premium-fintech-shell premium-design-shell">
      <header className="topbar mentor-v2-topbar">
        <button className="brand-group brand-button" onClick={() => navigate('dashboard')} type="button">
          <div className="brand-mark">IO</div>
          <div><div className="brand-kicker">INDEX-ONLY · FYERS PRIME</div><div className="brand-title">Index Options Mentor</div></div>
        </button>
        <PremiumMarketTicker snapshot={snapshot} liveQuote={liveQuote} marketDataReady={marketDataReady} />
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

      <div className="fyers-ref-mobile-header" role="banner" aria-label="Mobile trading header">
        <PremiumMarketTicker snapshot={snapshot} liveQuote={liveQuote} marketDataReady={marketDataReady} />
        <span className={`fyers-ref-mobile-broker ${brokerStatus.authenticated ? 'connected' : 'disconnected'}`} aria-label={brokerStatus.authenticated ? 'FYERS connected' : 'FYERS reconnect required'} />
        <button type="button" className="fyers-ref-mobile-menu" aria-label="Open menu" aria-expanded={mobileMenuOpen} onClick={() => setMobileMenuOpen(true)}>
          <MenuIcon />
        </button>
      </div>

      <DesktopNav view={view} navigate={navigate} strategyMode={strategyMode} setStrategyMode={setStrategyMode} settings={settings} setup={setupClassification} positionCount={positionCount} corePosition={corePosition} scalpPosition={scalpPosition} />

      {mobileMenuOpen && <MobileDrawer view={view} navigate={navigate} positionCount={positionCount} activePosition={activePosition || corePosition || scalpPosition} onClose={() => setMobileMenuOpen(false)} brokerStatus={brokerStatus} mode={mode} setMode={setMode} settings={settings} theme={theme} setTheme={setTheme} alertsEnabled={alertsEnabled} toggleAlerts={toggleAlerts} refreshing={refreshing} refreshSnapshot={refreshSnapshot} liveError={liveError} authRequired={authRequired} onReconnect={reconnectFyers} />}

      <TradeStorageNotice />
        {operationError && <div className="alert-bar" role="alert">{operationError}</div>}
      <main className="mentor-v2-content fyers-reference-main">
        {view === 'dashboard' && (
          <>
            {liveError && <SnapshotIssueBanner message={liveError} authRequired={authRequired} onReconnect={reconnectFyers} onRetry={retryFyersAfterUpgrade} />}
            {!marketDataReady && <div className="fyers-ref-data-warning" role="status" aria-label="NIFTY data connection status">
              <strong>{authRequired ? 'FYERS RECONNECT REQUIRED' : brokerStatus.authenticated
                ? (!liveError && lastReturnAt && marketClock - lastReturnAt < 8000
                  ? 'RESUMING LIVE DATA' : freshness.label)
                : 'FYERS CONNECTION REQUIRED'}</strong>
              <span>{brokerStatus.authenticated
                ? (!liveError && lastReturnAt && marketClock - lastReturnAt < 8000
                  ? 'Restoring fresh NIFTY quotes and Mentor analysis after returning to this tab. New entries stay paused until both are verified.'
                  : freshness.message)
                : 'Connect FYERS to load actual market prices and research.'}</span>
              <button type="button" disabled={!brokerStatus.authenticated || refreshing} onClick={() => refreshSnapshot({ manual:true })}>{refreshing ? 'Checking…' : 'Retry data'}</button>
            </div>}
            {strategyMode === 'scalp' ? (
              <FyersScalpTrade snapshot={snapshot} evaluation={scalpStatus} position={scalpPosition}
                corePosition={corePosition} positionMentor={scalpMentor} marketDataReady={marketDataReady}
                settings={settings} liveQuote={liveQuote} history={history}
                alertsEnabled={alertsEnabled} onTakeTrade={takeTrade} onExit={exitStrategy} onNavigate={navigate} />
            ) : (
              <FyersCoreTrade snapshot={snapshot} liveQuote={liveQuote} settings={settings} mode={mode}
                marketDataReady={marketDataReady}
                corePosition={corePosition} scalpPosition={scalpPosition} coreMentor={coreMentor}
                history={history} onTakeTrade={takeTrade} onExit={exitStrategy}
                onNavigate={navigate} alertsEnabled={alertsEnabled}/>
            )}
          </>
        )}
        {view === 'detail' && <FyersDetail snapshot={snapshot} onBack={() => navigate('dashboard')}/>}
        {view === 'ticket' && <FyersTicket snapshot={snapshot} settings={settings} liveQuote={liveQuote} onBack={() => navigate('dashboard')}/>}
        {view === 'position' && <FyersPositions defaultSlot={strategyMode} corePosition={corePosition} scalpPosition={scalpPosition}
          history={history} snapshot={snapshot} coreMentor={coreMentor} scalpMentor={scalpMentor}
          alertsEnabled={alertsEnabled} onExit={exitStrategy}/>}
        {view === 'history' && <><FyersJournal history={history} onNavigate={navigate}/><TradeRecoveryPanel/></>}
        {view === 'analysis' && <div className="fyers-ref-page fyers-ref-analysis">
          <Suspense fallback={<AnalysisPageLoading />}><ResearchAnalysis history={history} brokerStatus={brokerStatus}/></Suspense>
        </div>}
        {view === 'settings' && <FyersSettings settings={settings} onSave={setSettings} brokerStatus={brokerStatus} mode={mode}/>}
      </main>

      <nav className="premium-mobile-bottom-nav" aria-label="Primary trading navigation">
        <button type="button" className={view === 'dashboard' && strategyMode === 'core' ? 'active' : ''}
          aria-current={view === 'dashboard' && strategyMode === 'core' ? 'page' : undefined}
          onClick={() => { setStrategyMode('core'); navigate('dashboard'); }}>
          <span className="premium-nav-icon" aria-hidden="true"><UiIcon name="trade" /></span><span>Trade</span>
        </button>
        <button type="button" className={view === 'dashboard' && strategyMode === 'scalp' ? 'active' : ''}
          aria-current={view === 'dashboard' && strategyMode === 'scalp' ? 'page' : undefined}
          onClick={() => { setStrategyMode('scalp'); navigate('dashboard'); }}>
          <span className="premium-nav-icon" aria-hidden="true"><UiIcon name="scalp" /></span><span>Scalp</span>
        </button>
        <button type="button" className={view === 'position' ? 'active' : ''}
          aria-current={view === 'position' ? 'page' : undefined} onClick={() => navigate('position')}>
          <span className="premium-nav-icon" aria-hidden="true"><UiIcon name="positions" /></span><span>Positions{positionCount ? ` · ${positionCount}` : ''}</span>
        </button>
        <button type="button" className={view === 'history' ? 'active' : ''}
          aria-current={view === 'history' ? 'page' : undefined} onClick={() => navigate('history')}>
          <span className="premium-nav-icon" aria-hidden="true"><UiIcon name="journal" /></span><span>Journal</span>
        </button>
        <button type="button" className={view === 'settings' ? 'active' : ''}
          aria-current={view === 'settings' ? 'page' : undefined} onClick={() => navigate('settings')}>
          <span className="premium-nav-icon" aria-hidden="true"><UiIcon name="settings" /></span><span>Settings</span>
        </button>
      </nav>

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

function DesktopNav({ view, navigate, strategyMode, setStrategyMode, settings, setup, positionCount, corePosition, scalpPosition }) {
  return (
    <aside className="mentor-sidebar-v2" aria-label="Desktop navigation">
      <div className="premium-rail-brand" aria-label="Index Options Mentor">IO</div>
      <div className="sidebar-section-label">WORKSPACE</div>
      <NavButton active={view === 'dashboard' && strategyMode === 'core'} onClick={() => { setStrategyMode('core'); navigate('dashboard'); }} icon="⌁" label="13-Point" />
      <NavButton active={view === 'dashboard' && strategyMode === 'scalp'} onClick={() => { setStrategyMode('scalp'); navigate('dashboard'); }} icon="ϟ" label="Scalp" />
      <button type="button" className={`sidebar-nav-button ${view === 'position' ? 'active' : ''}`} onClick={() => navigate('position')}><span><UiIcon name="positions" /></span><strong>Positions {positionCount ? `(${positionCount})` : ''}</strong></button>
      <NavButton active={view === 'history'} onClick={() => navigate('history')} icon="↺" label="Trade journal" />
      <NavButton active={view === 'analysis'} onClick={() => navigate('analysis')} icon="◫" label="Analysis" />
      <NavButton active={view === 'settings'} onClick={() => navigate('settings')} icon="⚙" label="Settings" />
      <div className="sidebar-divider" />
      <div className="sidebar-section-label">AUTOMATION</div>
      <div className={`sidebar-auto-card ${settings.mentorAutoOpen ? 'active' : ''}`}><span>13-point auto research</span><strong>{settings.mentorAutoOpen ? 'ON' : 'OFF'}</strong><small>{corePosition ? 'Managing open 13-point' : setup?.eligible ? `${setup.label} ready` : 'Watching setups'}</small></div>
      <div className={`sidebar-auto-card ${settings.scalpAutoOpen !== false ? 'active' : ''}`}><span>Scalp auto research</span><strong>{settings.scalpAutoOpen !== false ? 'ON' : 'OFF'}</strong><small>{scalpPosition ? 'Managing open scalp' : 'Independent slot'}</small></div>
      <div className="sidebar-mini-grid"><div><span>Capital</span><strong>₹{Number(settings.capital).toLocaleString('en-IN')}</strong></div><div><span>Per trade</span><strong>₹{Number(settings.tradeAmount).toLocaleString('en-IN')}</strong></div></div>
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
        <div className="drawer-section"><span className="drawer-label">DISPLAY MODE</span><div className="segmented drawer-segmented" role="group" aria-label="Select Basic or Advanced view"><button type="button" className={mode === 'simple' ? 'active' : ''} aria-pressed={mode === 'simple'} onClick={() => { setMode('simple'); onClose(); }}>Basic</button><button type="button" className={mode === 'advanced' ? 'active' : ''} aria-pressed={mode === 'advanced'} onClick={() => { setMode('advanced'); onClose(); }}>Advanced</button></div></div>
        <div className="drawer-stats"><div><span>Capital</span><strong>₹{Number(settings.capital).toLocaleString('en-IN')}</strong></div><div><span>Risk</span><strong>{settings.riskPct}%</strong></div><div><span>Per trade</span><strong>₹{Number(settings.tradeAmount).toLocaleString('en-IN')}</strong></div></div>
        <div className="drawer-actions"><button onClick={() => setTheme(current => current === 'dark' ? 'light' : 'dark')}>{theme === 'dark' ? <SunIcon /> : <MoonIcon />}<span>{theme === 'dark' ? 'Light mode' : 'Dark mode'}</span></button><button onClick={toggleAlerts}><span className="drawer-action-dot" /><span>{alertsEnabled ? 'Alerts on' : 'Enable alerts'}</span></button><button disabled={refreshing} onClick={() => refreshSnapshot({ manual: true })}><RefreshIcon /><span>{refreshing ? 'Checking…' : 'Refresh market'}</span></button>{brokerStatus.configured && <button className={`drawer-reconnect-btn ${authRequired ? 'required' : ''}`} onClick={onReconnect}><ReconnectIcon /><span>{authRequired ? 'Reconnect FYERS now' : 'Reconnect FYERS'}</span></button>}</div>
        <button className="drawer-settings-cta" onClick={() => navigate('settings')}>Account & automation settings</button>
      </aside>
    </div>
  );
}

function NavButton({ active, onClick, icon, label }) {
  return <button type="button" className={`sidebar-nav-button ${active ? 'active' : ''}`} onClick={onClick}><span><UiIcon name={label === 'Scalp' ? 'scalp' : label === 'Trade journal' ? 'journal' : label === 'Analysis' ? 'analysis' : label === 'Settings' ? 'settings' : 'trade'} /></span><strong>{label}</strong></button>;
}

// Keep browser-completed exits when an older Google Sheets sync returns later.
// Completed IDs are immutable: a remote sync must never erase the latest local exit.
function mergeCompletedHistory(local, remote) {
  const seen = new Set();
  const result = [];
  for (const trade of [...(Array.isArray(local) ? local : []), ...(Array.isArray(remote) ? remote : [])]) {
    if (!trade?.closedAt) continue;
    const key = String(trade.id || `${trade.symbol}:${trade.openedAt}:${trade.closedAt}`);
    if (seen.has(key)) continue;
    seen.add(key);
    result.push(trade);
  }
  return result.sort((a, b) => Date.parse(b.closedAt || 0) - Date.parse(a.closedAt || 0)).slice(0, 1000);
}

async function reconcilePreviewExit(strategy, id, closedByMentor) {
  const response = await fetch('/api/monitor/reconcile', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      strategy,
      id,
      reason: closedByMentor ? 'PWA_AUTO_EXIT' : 'USER_EXIT'
    }),
    cache: 'no-store',
    signal: AbortSignal.timeout(10000)
  });
  const data = await response.json().catch(() => ({}));
  if (response.ok && data.result === 'PAPER_POSITION_RECONCILED') return null;

  if (response.ok && data.result === 'ALREADY_CLOSED') {
    const status = await fetch('/api/monitor/status', {
      cache: 'no-store',
      signal: AbortSignal.timeout(10000)
    });
    if (status.ok) {
      const monitor = await status.json();
      const receipt = findVerifiedAwsPaperExit(monitor.paperSync?.recentlyClosed, strategy, id);
      if (receipt) return receipt;
    }
  }

  throw new Error('AWS could not confirm this paper exit. The journal was left unchanged.');
}

function closeTrade(current, meta, snapshot, scalpStatus, settings) {
  const aws = meta?.closedBy === 'AWS_MONITOR' &&
    meta.awsReceipt?.id === current.id &&
    meta.awsReceipt?.exitPriceSource === 'OBSERVED_OPTION_QUOTE'
      ? meta.awsReceipt : null;
  const underlyingExit = aws && Number.isFinite(aws.underlyingExit)
    ? aws.underlyingExit
    : finite(current.underlyingCurrent) ?? finite(snapshot?.market?.spot) ?? finite(current.underlyingEntry) ?? 0;
  const optionExit = aws && Number.isFinite(aws.exitPrice) && aws.exitPrice > 0
    ? aws.exitPrice : finite(current.currentPrice) ?? finite(current.entry) ?? 0;
  const entry = finite(current.entry) ?? optionExit;
  const quantity = Math.max(0, Number(current.quantity) || 0);
  const pnl = (optionExit - entry) * quantity;
  const riskPoints = Math.max(0.01, Math.abs(Number(current.underlyingEntry) - Number(current.underlyingStop)));
  const movePoints = current.side === 'CE' ? underlyingExit - Number(current.underlyingEntry) : Number(current.underlyingEntry) - underlyingExit;
  const rAchieved = movePoints / riskPoints;
  const closedAt = aws?.closedAt || new Date().toISOString();
  const heldMs = Math.max(0, Date.now() - new Date(current.openedAt).getTime());
  const heldMinutes = Math.max(0, Math.round(heldMs / 60000));
  const currentPnl = aws ? pnl : finite(current.currentUnrealizedPnl) ?? pnl;
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
    exitMethod: ['MENTOR', 'AWS_MONITOR'].includes(meta.closedBy) ? 'AUTO' : 'MANUAL',
    exitReasonCode: meta.reasonCode || inferExitReason(current, underlyingExit),
    exitReason: meta.reason || 'Manual simulated exit.',
    ...(aws ? { executionMode: 'PAPER_ONLY', brokerOrderPlaced: false, exitPriceSource: 'OBSERVED_OPTION_QUOTE', awsPaperExit: true } : {}),
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
    scalpOptionProfitTrailExit: meta.reasonCode === 'SCALP_OPTION_PROFIT_TRAIL',
    scalpOptionTrailFloorPnlAtExit: current.optionTrailingFloorPnl ?? null,
    scalpOptionTrailPeakPnlAtExit: current.peakUnrealizedPnl ?? null,
    scalpTimeLimitExit: meta.reasonCode === 'SCALP_TIME_EXIT',
    coreOptionProfitTrailExit: meta.reasonCode === 'CORE_OPTION_PROFIT_TRAIL',
    coreOptionTrailFloorPnlAtExit: current.coreOptionTrailingFloorPnl ?? null,
    coreOptionTrailPeakPnlAtExit: current.peakUnrealizedPnl ?? null,
    coreOptionTrailKeepRatioAtExit: current.coreOptionTrailKeepRatio ?? null,
    coreTargetIndexTrailExit: meta.reasonCode === 'CORE_TARGET_INDEX_TRAIL',
    coreTargetIndexTrailStopAtExit: current.coreTargetIndexTrailStop ?? null,
    coreTargetIndexTrailBestRAtExit: current.bestR ?? null,
    coreTargetIndexTrailActivatedAt: current.coreTargetIndexTrailActivatedAt || null,
    lastUnderlyingQuoteAtExit: current.lastUnderlyingQuoteAt || null,
    lastOptionQuoteAtExit: current.lastOptionQuoteAt || null,
    optionExitQuoteAgeMs: Number.isFinite(Date.parse(current.lastOptionQuoteAt || ''))
      ? Date.now() - Date.parse(current.lastOptionQuoteAt) : null,
    scalpTrailPolicy: current.scalpTrailPolicy || null,
    exitSnapshot: snapshot ? { market: { ...snapshot.market }, decision: { ...snapshot.decision }, parameters: snapshot.parameters, structure: { ...snapshot.structure }, setup: { ...snapshot.setup } } : null
  };
}


function formatCurrencyPnl(value) {
  const amount = Number(value);
  if (!Number.isFinite(amount)) return 'unavailable';
  return `${amount >= 0 ? '+' : '-'}₹${Math.abs(amount).toLocaleString('en-IN', { maximumFractionDigits: 0 })}`;
}


function findQuoteNode(nodes, symbol) {
  return nodes.find(node => node?.n === symbol || node?.v?.symbol === symbol);
}

function inferExitReason(position, underlyingExit) {
  const stopHit = position.side === 'CE' ? underlyingExit <= position.underlyingStop : underlyingExit >= position.underlyingStop;
  return stopHit ? 'STRUCTURE_INVALIDATED' : 'MANUAL_EXIT';
}

function initialPosition(kind) {
  // Startup migrates the legacy pointer only when no managed record exists.
  // A committed null position must never fall back to an older open pointer.
  return readJson(kind === 'scalp' ? SCALP_POSITION_KEY : CORE_POSITION_KEY, null);
}

function persistPosition(key, position) { writeTradingJson(key, position); }

function finite(value) {
  const n = Number(value);
  return Number.isFinite(n) ? n : null;
}

function pruneLedger(ledger) {
  const keys = Object.keys(ledger);
  if (keys.length <= 120) return;
  keys.sort((a, b) => String(ledger[a]?.openedAt || '').localeCompare(String(ledger[b]?.openedAt || ''))).slice(0, keys.length - 120).forEach(key => delete ledger[key]);
}

function readJson(key, fallback) { return readTradingJson(key, fallback); }
function readString(key, fallback) { const value=readTradingJson(key,undefined); if(value!==undefined)return String(value); try{return localStorage.getItem(key)||fallback;}catch{return fallback;} }
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


