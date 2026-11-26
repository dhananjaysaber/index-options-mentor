// Browser tab/window restoration events frequently fire together. Deduplicate
// the signal; callers retain their own fresh-data and order-safety requirements.
export function listenForTabResume({ window, document, onResume, now = Date.now, minGapMs = 500 }) {
  let lastAt = -Infinity;
  const resume = () => {
    if (document.visibilityState !== 'visible') return;
    const at = now();
    if (at - lastAt < minGapMs) return;
    lastAt = at;
    onResume();
  };
  document.addEventListener('visibilitychange', resume);
  window.addEventListener('focus', resume);
  window.addEventListener('pageshow', resume);
  return () => {
    document.removeEventListener('visibilitychange', resume);
    window.removeEventListener('focus', resume);
    window.removeEventListener('pageshow', resume);
  };
}
