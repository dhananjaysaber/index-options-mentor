import React from 'react';
import { createRoot } from 'react-dom/client';
import App from './App.jsx';
import PWAInstallPrompt from './PWAInstallPrompt.jsx';
import { startTradeJournalBridge } from './services/tradeJournal.js';
import { installSetupDecisionObserver } from './services/setupDecisionJournal.js';
import './styles.css';
import './pwa.css';
import './mobile-fixes.css';
import './dark-theme-fixes.css';
import './trader-polish.css';
import './mobile-menu-runner.css';

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
    <App />
    <PWAInstallPrompt />
  </React.StrictMode>
);

// Permanent trade journal writes and retries stay outside the live trading path.
startTradeJournalBridge();
