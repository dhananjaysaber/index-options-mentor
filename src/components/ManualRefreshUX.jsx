import { useEffect, useRef, useState } from 'react';

export default function ManualRefreshUX() {
  const [active, setActive] = useState(false);
  const manualPendingRef = useRef(false);
  const timeoutRef = useRef(null);

  useEffect(() => {
    const originalFetch = window.fetch.bind(window);

    const onClickCapture = event => {
      const button = event.target?.closest?.('.drawer-actions button');
      if (!button) return;
      const text = button.textContent || '';
      if (!/Refresh market|Checking/i.test(text)) return;

      manualPendingRef.current = true;
      setActive(true);
      window.clearTimeout(timeoutRef.current);
      timeoutRef.current = window.setTimeout(() => {
        manualPendingRef.current = false;
        setActive(false);
      }, 20000);

      // Let React's own Refresh market handler start the request first, then
      // close the hamburger drawer so the user immediately sees refresh feedback.
      window.setTimeout(() => {
        document.querySelector('.mentor-mobile-drawer .drawer-head button')?.click();
      }, 0);
    };

    document.addEventListener('click', onClickCapture, true);

    window.fetch = async (...args) => {
      const input = args[0];
      const rawUrl = typeof input === 'string' ? input : input?.url || '';
      let isMentorRefresh = false;
      try {
        const url = new URL(rawUrl, window.location.origin);
        isMentorRefresh = url.pathname === '/api/fyers/mentor-snapshot';
      } catch {}

      try {
        return await originalFetch(...args);
      } finally {
        if (isMentorRefresh && manualPendingRef.current) {
          manualPendingRef.current = false;
          window.clearTimeout(timeoutRef.current);
          // Keep the completed state visible for a fraction of a second so the
          // transition does not feel like a flash on fast connections.
          window.setTimeout(() => setActive(false), 250);
        }
      }
    };

    return () => {
      document.removeEventListener('click', onClickCapture, true);
      window.fetch = originalFetch;
      window.clearTimeout(timeoutRef.current);
    };
  }, []);

  if (!active) return null;

  return (
    <div className="manual-refresh-indicator" role="status" aria-live="polite">
      <span className="manual-refresh-spinner" aria-hidden="true" />
      <span>
        <strong>Refreshing market</strong>
        <small>Getting the latest NIFTY, 5-minute structure and option data…</small>
      </span>
    </div>
  );
}
