import { useEffect, useState } from 'react';

export default function useLiveQuote() {
  const [quote, setQuote] = useState(() => currentQuote());

  useEffect(() => {
    const handler = event => setQuote(event?.detail || currentQuote());
    window.addEventListener('mentor:live-quote', handler);
    return () => window.removeEventListener('mentor:live-quote', handler);
  }, []);

  return quote;
}

function currentQuote() {
  if (typeof window === 'undefined') return null;
  return window.__indexOptionsLiveQuote || null;
}
