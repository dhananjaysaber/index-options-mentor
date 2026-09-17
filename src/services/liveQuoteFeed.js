const POSITION_KEY = 'index-options-mentor-open-position-v07';
const POLL_MS = 2000;

let installed = false;
let previousFetch = null;
let authenticated = false;
let candidateSymbol = '';
let timer = null;
let inFlight = false;

export function installLiveQuoteFeed() {
  if (installed || typeof window === 'undefined' || typeof window.fetch !== 'function') return;
  installed = true;
  previousFetch = window.fetch.bind(window);

  window.fetch = async (...args) => {
    const response = await previousFetch(...args);
    observeResponse(args[0], response);
    return response;
  };

  document.addEventListener('visibilitychange', () => {
    if (document.visibilityState === 'visible' && authenticated) void pollLiveQuote();
  });
}

function observeResponse(input, response) {
  try {
    const url = new URL(typeof input === 'string' ? input : input?.url || '', window.location.origin);
    if (url.origin !== window.location.origin || !response?.ok) return;

    if (url.pathname === '/api/fyers/status') {
      response.clone().json().then(data => {
        authenticated = data?.authenticated === true;
        if (authenticated) {
          ensureTimer();
          void pollLiveQuote();
        } else {
          stopTimer();
        }
      }).catch(() => {});
      return;
    }

    if (url.pathname === '/api/fyers/mentor-snapshot') {
      response.clone().json().then(data => {
        const nextSymbol = data?.option?.symbol;
        if (nextSymbol) candidateSymbol = nextSymbol;
      }).catch(() => {});
    }
  } catch {}
}

function ensureTimer() {
  if (timer) return;
  timer = window.setInterval(() => {
    if (document.visibilityState === 'visible') void pollLiveQuote();
  }, POLL_MS);
}

function stopTimer() {
  if (!timer) return;
  window.clearInterval(timer);
  timer = null;
}

async function pollLiveQuote() {
  if (!authenticated || inFlight || document.visibilityState !== 'visible') return;
  inFlight = true;
  try {
    const openPosition = readOpenPosition();
    const optionSymbol = openPosition?.symbol || candidateSymbol || '';
    const symbols = [...new Set(['NSE:NIFTY50-INDEX', optionSymbol].filter(Boolean))].join(',');
    const response = await previousFetch(`/api/fyers/quote?symbol=${encodeURIComponent(symbols)}`, { cache: 'no-store' });
    if (response.status === 401 || response.status === 403) {
      authenticated = false;
      stopTimer();
      return;
    }
    if (!response.ok) return;

    const data = await response.json();
    const nodes = Array.isArray(data?.d) ? data.d : [];
    const nifty = quotePrice(nodes, 'NSE:NIFTY50-INDEX');
    const optionPrice = optionSymbol ? quotePrice(nodes, optionSymbol) : null;
    if (nifty == null && optionPrice == null) return;

    const quote = {
      nifty,
      optionPrice,
      optionSymbol,
      at: new Date().toISOString(),
      pollMs: POLL_MS
    };
    window.__indexOptionsLiveQuote = quote;
    window.dispatchEvent(new CustomEvent('mentor:live-quote', { detail: quote }));
  } catch {
    // Keep the last good quote. A temporary network error must not blank the UI.
  } finally {
    inFlight = false;
  }
}

function quotePrice(nodes, symbol) {
  const node = nodes.find(row => row?.n === symbol || row?.v?.symbol === symbol);
  const value = Number(node?.v?.lp);
  return Number.isFinite(value) && value > 0 ? value : null;
}

function readOpenPosition() {
  try {
    const value = localStorage.getItem(POSITION_KEY);
    return value ? JSON.parse(value) : null;
  } catch {
    return null;
  }
}
