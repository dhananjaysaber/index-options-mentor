import React from 'react';
import { createRoot } from 'react-dom/client';
import AppV2 from './AppV2.jsx';
import PWAInstallPrompt from './PWAInstallPrompt.jsx';
import FyersConnectButton from './FyersConnectButton.jsx';
import { startTradeJournalBridge } from './services/tradeJournal.js';
import { installSetupDecisionObserver } from './services/setupDecisionJournal.js';
import { installShadowResearchEngine } from './services/shadowResearch.js';
import { installApiBridge } from './services/apiBridge.js';
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

// On GitHub Pages the visible PWA is static, while all /api/* traffic is
// transparently routed to the existing secure Netlify backend. Netlify keeps
// FYERS and journal secrets; no secret is bundled into the GitHub Pages build.
installApiBridge();

if ('serviceWorker' in navigator) {
  window.addEventListener('load', () => {
    navigator.serviceWorker.register(`${import.meta.env.BASE_URL}sw.js`).catch(error => {
      console.warn('PWA service worker registration failed:', error);
    });
  });
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
    <AppV2 />
    <FyersConnectButton />
    <PWAInstallPrompt />
  </React.StrictMode>
);

// Permanent trade journal writes and retries stay outside the live trading path.
startTradeJournalBridge();
