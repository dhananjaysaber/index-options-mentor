import { useEffect, useState } from 'react';

const DISMISS_KEY = 'index-options-mentor-install-dismissed';

function isStandalone() {
  return window.matchMedia?.('(display-mode: standalone)').matches || window.navigator.standalone === true;
}

function isIOS() {
  return /iphone|ipad|ipod/i.test(window.navigator.userAgent);
}

export default function PWAInstallPrompt() {
  const [standalone, setStandalone] = useState(() => isStandalone());
  const [deferredPrompt, setDeferredPrompt] = useState(null);
  const [dismissed, setDismissed] = useState(() => localStorage.getItem(DISMISS_KEY) === '1');

  useEffect(() => {
    const onBeforeInstallPrompt = event => {
      event.preventDefault();
      setDeferredPrompt(event);
    };
    const onInstalled = () => {
      setStandalone(true);
      setDeferredPrompt(null);
      localStorage.removeItem(DISMISS_KEY);
    };
    const media = window.matchMedia?.('(display-mode: standalone)');
    const onDisplayChange = () => setStandalone(isStandalone());

    window.addEventListener('beforeinstallprompt', onBeforeInstallPrompt);
    window.addEventListener('appinstalled', onInstalled);
    media?.addEventListener?.('change', onDisplayChange);

    return () => {
      window.removeEventListener('beforeinstallprompt', onBeforeInstallPrompt);
      window.removeEventListener('appinstalled', onInstalled);
      media?.removeEventListener?.('change', onDisplayChange);
    };
  }, []);

  if (standalone || dismissed) return null;
  if (!deferredPrompt && !isIOS()) return null;

  async function install() {
    if (!deferredPrompt) return;
    await deferredPrompt.prompt();
    await deferredPrompt.userChoice.catch(() => null);
    setDeferredPrompt(null);
  }

  function dismiss() {
    localStorage.setItem(DISMISS_KEY, '1');
    setDismissed(true);
  }

  return (
    <aside className="pwa-install-card" aria-label="Install Index Options Mentor">
      <div className="pwa-install-copy">
        <strong>Install Options Mentor</strong>
        <span>
          {isIOS()
            ? 'On iPhone or iPad: use Share, choose Add to Home Screen, then keep Open as Web App enabled.'
            : 'Install the Mentor for a full-screen mobile app experience.'}
        </span>
      </div>
      <div className="pwa-install-actions">
        {deferredPrompt && <button type="button" className="pwa-install-primary" onClick={install}>Install app</button>}
        <button type="button" className="pwa-install-secondary" onClick={dismiss}>Not now</button>
      </div>
    </aside>
  );
}
