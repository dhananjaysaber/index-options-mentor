import React from 'react';
import { createRoot } from 'react-dom/client';
import App from './App.jsx';
import PWAInstallPrompt from './PWAInstallPrompt.jsx';
import './styles.css';
import './pwa.css';
import './mobile-fixes.css';

if ('serviceWorker' in navigator) {
  window.addEventListener('load', () => {
    navigator.serviceWorker.register('/sw.js').catch(error => {
      console.warn('PWA service worker registration failed:', error);
    });
  });
}

createRoot(document.getElementById('root')).render(
  <React.StrictMode>
    <App />
    <PWAInstallPrompt />
  </React.StrictMode>
);
