import { FYERS_REFRESH, isNseMarketHours } from './fyersRefreshPolicy.js';

const POSITION_KEYS = [
  'index-options-mentor-open-position-v07',
  'index-options-mentor-core-position-v41',
  'index-options-mentor-scalp-position-v41'
];
const POLL_MS = FYERS_REFRESH.quoteMs;

let installed = false;
let previousFetch = null;
let authenticated = false;
let candidateSymbol = '';
let timer = null;
let inFlight = false;
let nextPollAfter = 0;
let throttleDelay = 0;

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
  if (!authenticated || inFlight || document.visibilityState !== 'visible' || !isNseMarketHours() || Date.now() < nextPollAfter) return;
  inFlight = true;
  try {
    // One poll serves the current candidate and both independently open strategies.
    // Avoid a second 2-second FYERS loop when a simulated position opens.
    const openPositions = readOpenPositions();
    // Additional Stock paper symbols share this existing REST poll.
    // They do not participate in NIFTY option selection or Index position state.
    const stockPaper = readStockPaperForQuotes();
    const optionSymbol = openPositions[0]?.symbol || candidateSymbol || '';
    const symbols = [...new Set([
      'NSE:NIFTY50-INDEX',
      candidateSymbol,
      ...openPositions.map(position => position.symbol),
      stockPaper?.symbol,
      stockPaper?.underlyingSymbol
    ].filter(Boolean))].join(',');
    const response = await previousFetch(`/api/fyers/quote?symbol=${encodeURIComponent(symbols)}`, { cache: 'no-store' });
    if (response.status === 401) {
      authenticated = false;
      stopTimer();
      window.dispatchEvent(new CustomEvent('mentor:fyers-auth-required'));
      return;
    }
    if (response.status === 429) {
      // Back off exponentially instead of hammering the FYERS rate limit every 2s.
      throttleDelay = Math.min(60000, throttleDelay ? throttleDelay * 2 : 15000);
      nextPollAfter = Date.now() + throttleDelay;
      return;
    }
    if (!response.ok) return;
    throttleDelay = 0;
    nextPollAfter = 0;

    const data = await response.json();
    const nodes = Array.isArray(data?.d) ? data.d : [];
    const nifty = quotePrice(nodes, 'NSE:NIFTY50-INDEX');
    const optionPrices = {};
    for (const symbol of [...new Set([candidateSymbol, ...openPositions.map(item => item.symbol)].filter(Boolean))]) {
      const price = quotePrice(nodes, symbol);
      if (price != null) optionPrices[symbol] = price;
    }
    const optionPrice = optionSymbol ? optionPrices[optionSymbol] ?? null : null;
    if (nifty == null && !Object.keys(optionPrices).length) return;

    const quote = {
      nifty,
      optionPrice,
      optionSymbol,
      optionPrices,
      at: new Date().toISOString(),
      pollMs: POLL_MS
    };
    window.__indexOptionsLiveQuote = quote;
    window.dispatchEvent(new CustomEvent('mentor:live-quote', { detail: quote }));
    if (stockPaper?.id) {
      const optionNode = nodes.find(row => row?.n === stockPaper.symbol || row?.v?.symbol === stockPaper.symbol)?.v;
      const underlying = quotePrice(nodes, stockPaper.underlyingSymbol);
      const bid = Number(optionNode?.bid ?? optionNode?.bids?.[0]?.price);
      const ask = Number(optionNode?.ask ?? optionNode?.asks?.[0]?.price);
      if (underlying != null && Number.isFinite(bid) && bid > 0) {
        window.dispatchEvent(new CustomEvent('mentor:stock-paper-quote', {
          detail: { id: stockPaper.id, symbol: stockPaper.symbol,
            spot: underlying, bid, ask: Number.isFinite(ask) ? ask : null, at: quote.at }
        }));
      }
    }
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

function readStockPaperForQuotes() {
  try {
    const value = localStorage.getItem('index-options-mentor-stock-paper-position-v1');
    const position = value ? JSON.parse(value) : null;
    return position?.strategyFamily === 'STOCK_SCALP' && position?.symbol && position?.underlyingSymbol
      && !position.closedAt ? position : null;
  } catch { return null; }
}

function readOpenPositions() {
  const result = [];
  const seen = new Set();
  for (const key of POSITION_KEYS) {
    try {
      const value = localStorage.getItem(key);
      const position = value ? JSON.parse(value) : null;
      if (position?.symbol && !seen.has(position.symbol)) {
        result.push(position);
        seen.add(position.symbol);
      }
    } catch {
      // Invalid local position state must not stop the live feed.
    }
  }
  return result;
}
