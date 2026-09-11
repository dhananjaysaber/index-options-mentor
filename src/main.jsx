import React from 'react';
import { createRoot } from 'react-dom/client';
import AppV2 from './AppV2.jsx';
import PWAInstallPrompt from './PWAInstallPrompt.jsx';
import { startTradeJournalBridge } from './services/tradeJournal.js';
import { installSetupDecisionObserver } from './services/setupDecisionJournal.js';
import './styles.css';
import './pwa.css';
import './mobile-fixes.css';
import './dark-theme-fixes.css';
import './trader-polish.css';
import './mobile-menu-runner.css';
import './mentor-shell-v2.css';
import './premium-responsive-v3.css';
import './premium-responsive-v4.css';

if ('serviceWorker' in navigator) {
  window.addEventListener('load', () => {
    navigator.serviceWorker.register('/sw.js').catch(error => {
      console.warn('PWA service worker registration failed:', error);
    });
  });
}

// Observe completed mentor snapshots and journal important setup decisions in
// the background. This wrapper never delays the FYERS response used by the UI.
installSetupDecisionObserver();

createRoot(document.getElementById('root')).render(
  <React.StrictMode>
    <AppV2 />
    <PWAInstallPrompt />
  </React.StrictMode>
);

// Permanent trade journal writes and retries stay outside the live trading path.
startTradeJournalBridge();
