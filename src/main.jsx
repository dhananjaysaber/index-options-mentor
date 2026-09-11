import React from 'react';
import { createRoot } from 'react-dom/client';
import App from './App.jsx';
import PWAInstallPrompt from './PWAInstallPrompt.jsx';
import { prepareJournalHistory, startTradeJournalBridge } from './services/tradeJournal.js';
import './styles.css';
import './pwa.css';
import './mobile-fixes.css';
import './dark-theme-fixes.css';
import './trader-polish.css';

if ('serviceWorker' in navigator) {
  window.addEventListener('load', () => {
    navigator.serviceWorker.register('/sw.js').catch(error => {
      console.warn('PWA service worker registration failed:', error);
    });
  });
}

async function boot() {
  // Give the permanent journal a short chance to restore cross-device history
  // before App reads localStorage. If Sheets is slow/unavailable, trading UI
  // still starts from the browser cache and journal sync retries in background.
  await prepareJournalHistory({ maxWaitMs: 1800 });

  createRoot(document.getElementById('root')).render(
    <React.StrictMode>
      <App />
      <PWAInstallPrompt />
    </React.StrictMode>
  );

  startTradeJournalBridge();
}

boot();
