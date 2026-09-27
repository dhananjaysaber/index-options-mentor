import { useEffect } from 'react';

const FALLBACK_FOOTER_PX = 58;
const EXTRA_GAP_PX = 4;

export default function FooterClearanceSync() {
  useEffect(() => {
    let observedFooter = null;

    const resizeObserver = new ResizeObserver(() => measure());

    function measure() {
      const footer = document.querySelector('.mentor-footer');
      if (footer !== observedFooter) {
        if (observedFooter) resizeObserver.unobserve(observedFooter);
        observedFooter = footer;
        if (observedFooter) resizeObserver.observe(observedFooter);
      }

      const height = footer?.getBoundingClientRect?.().height;
      const clearance = Number.isFinite(height) && height > 0
        ? Math.ceil(height) + EXTRA_GAP_PX
        : FALLBACK_FOOTER_PX + EXTRA_GAP_PX;

      document.documentElement.style.setProperty('--mentor-footer-clearance', `${clearance}px`);
    }

    const mutationObserver = new MutationObserver(measure);
    mutationObserver.observe(document.body, { childList: true, subtree: true });

    const viewport = window.visualViewport;
    window.addEventListener('resize', measure);
    viewport?.addEventListener('resize', measure);
    viewport?.addEventListener('scroll', measure);

    requestAnimationFrame(measure);

    return () => {
      mutationObserver.disconnect();
      resizeObserver.disconnect();
      window.removeEventListener('resize', measure);
      viewport?.removeEventListener('resize', measure);
      viewport?.removeEventListener('scroll', measure);
      document.documentElement.style.removeProperty('--mentor-footer-clearance');
    };
  }, []);

  return null;
}
