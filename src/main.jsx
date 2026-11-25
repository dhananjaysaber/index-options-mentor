import { initializeTradingStorage } from './services/tradingStorage.js';
import React from 'react';
import { createRoot } from 'react-dom/client';
import AppV3 from './AppV3.jsx';
import AppErrorBoundary from './components/AppErrorBoundary.jsx';
import PWAInstallPrompt from './PWAInstallPrompt.jsx';
import FyersConnectButton from './FyersConnectButton.jsx';
import ManualRefreshUX from './components/ManualRefreshUX.jsx';
import FooterClearanceSync from './components/FooterClearanceSync.jsx';
import { startTradeJournalBridge } from './services/tradeJournal.js';
import { installSetupDecisionObserver } from './services/setupDecisionJournal.js';
import { installShadowResearchEngine } from './services/shadowResearch.js';
import { installApiBridge } from './services/apiBridge.js';
import { installFyersRequestGuard } from './services/fyersRequestGuard.js';
import { installLiveQuoteFeed } from './services/liveQuoteFeed.js';
import './styles.css';
import './pwa.css';
import './mobile-fixes.css';
import './dark-theme-fixes.css';
import './trader-polish.css';
import './mobile-menu-runner.css';
import './mentor-shell-v2.css';
import './premium-responsive-v3.css';
import './premium-responsive-v4.css';
import './premium-responsive-v5.css';
import './premium-desktop-v6.css';
import './session-ui-fixes.css';
import './cockpit-alignment-fix.css';
import './mobile-dashboard-v21.css';
import './settings-position-v22.css';
import './manual-research-v23.css';
import './position-live-v24.css';
import './nifty-chart-v26.css';
import './live-market-v29.css';
import './mobile-density-v30.css';
import './mentor-ux-v31.css';
import './reconnect-v32.css';
import './scalp-v33.css';
import './live-handoff-v39.css';
import './research-analysis-v40.css';
import './research-cockpit-v41.css';
import './footer-clearance-v42.css';
import './premium-trading-v51.css';
import './iphone-shell-v52.css';
import './view-mode-menu-v55.css';
import './scalp-profit-protection-v56.css';
import './target-index-trail-v58.css';

// On GitHub Pages the visible PWA is static, while all /api/* traffic is
// transparently routed to the existing secure backend. No FYERS secret is
// bundled into the public GitHub Pages build.
// Do not reopen a standalone PWA halfway down a strategy card.
// Browser-restored scroll positions caused the approved header to appear clipped.
if ('scrollRestoration' in window.history) window.history.scrollRestoration = 'manual';
async function startMentor(){
await initializeTradingStorage();
installApiBridge();
installFyersRequestGuard();

// A single shared quote loop keeps NIFTY and the current candidate/open option
// near-live across the visible Mentor UI without each component polling FYERS.
installLiveQuoteFeed();

if ('serviceWorker' in navigator) {
  const registerWorker=() => {
    navigator.serviceWorker.register(`${import.meta.env.BASE_URL}sw.js`).catch(error => {
      console.warn('PWA service worker registration failed:', error);
    });
  };
  if(document.readyState==='complete')registerWorker();
  else window.addEventListener('load',registerWorker,{once:true});
}

// Observe completed mentor snapshots and journal important setup decisions in
// the background. This wrapper never delays the FYERS response used by the UI.
installSetupDecisionObserver();

// Run the separate background research engine. It can open several simulated
// shadow positions from 3/5, 4/5 and 5/5 cohorts without weakening the visible
// Mentor recommendation. Shadow positions use strategy-based exits and closed
// results flow into the same permanent learning journal.
installShadowResearchEngine();

createRoot(document.getElementById('root')).render(
  <React.StrictMode>
    <AppErrorBoundary><AppV3 /></AppErrorBoundary>
    <FooterClearanceSync />
    <ManualRefreshUX />
    <FyersConnectButton />
    <PWAInstallPrompt />
  </React.StrictMode>
);

// Permanent trade journal writes and retries stay outside the live trading path.
startTradeJournalBridge();
}
void startMentor();

