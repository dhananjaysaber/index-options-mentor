import { useEffect, useState } from 'react';
import { createPortal } from 'react-dom';
import { getFyersLoginUrl } from './services/apiBridge.js';

export default function FyersConnectButton() {
  const [status, setStatus] = useState(null);
  const [desktopTarget, setDesktopTarget] = useState(null);
  const [mobileTarget, setMobileTarget] = useState(null);

  useEffect(() => {
    let cancelled = false;

    fetch('/api/fyers/status', { cache: 'no-store' })
      .then(response => response.json())
      .then(data => {
        if (!cancelled) setStatus(data);
      })
      .catch(() => {
        if (!cancelled) setStatus(null);
      });

    return () => {
      cancelled = true;
    };
  }, []);

  useEffect(() => {
    const syncTargets = () => {
      setDesktopTarget(document.querySelector('.mentor-v2-desktop-actions'));
      setMobileTarget(document.querySelector('.mentor-mobile-drawer .drawer-actions'));
    };

    syncTargets();
    const observer = new MutationObserver(syncTargets);
    observer.observe(document.body, { childList: true, subtree: true });

    return () => observer.disconnect();
  }, []);

  if (!status?.configured || status.authenticated) return null;
  const loginUrl = getFyersLoginUrl();

  return (
    <>
      {desktopTarget && createPortal(
        <a className="secondary-btn fyers-connect-cta" href={loginUrl}>Connect FYERS</a>,
        desktopTarget
      )}
      {mobileTarget && createPortal(
        <a className="drawer-fyers-connect" href={loginUrl}>Connect FYERS</a>,
        mobileTarget
      )}
    </>
  );
}
