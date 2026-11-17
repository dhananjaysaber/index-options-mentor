// Shared browser-side FYERS request coordinator. Preserves the same API and
// research logic while preventing duplicate reads and retry storms on 429.
// Across tabs, the cooldown is stored on this origin; no token is stored here.
const COOLDOWN_KEY = 'iom-fyers-data-cooldown-v1';
const INDIA_OFFSET_MS = 330 * 60000;
const protectedRoutes = new Set([
  '/api/fyers/quote',
  '/api/fyers/history',
  '/api/fyers/option-chain',
  '/api/fyers/research-history',
  '/api/fyers/mentor-snapshot'
]);
const pending = new Map();
const recentlyCompleted = new Map();

function cooldownState() {
  try {
    const value = JSON.parse(localStorage.getItem(COOLDOWN_KEY) || 'null');
    if (value?.until > Date.now()) return value;
    if (value) localStorage.removeItem(COOLDOWN_KEY);
  } catch {}
  return null;
}

export function nextMarketOpenIST(now = Date.now()) {
  // Work in shifted UTC to avoid device time zone / DST ambiguity.
  const ist = new Date(now + INDIA_OFFSET_MS);
  let candidate = Date.UTC(ist.getUTCFullYear(), ist.getUTCMonth(), ist.getUTCDate(), 9, 15) - INDIA_OFFSET_MS;
  if (candidate <= now) candidate += 86400000;
  while ([0, 6].includes(new Date(candidate + INDIA_OFFSET_MS).getUTCDay())) candidate += 86400000;
  return candidate;
}

export function readFyersCooldown() { return cooldownState(); }

function saveCooldown(kind, message) {
  const now = Date.now();
  const until = kind === 'daily' ? nextMarketOpenIST(now) : now + 180000;
  const old = cooldownState();
  if (old && old.until > until) return;
  try { localStorage.setItem(COOLDOWN_KEY, JSON.stringify({ kind, until, message })); } catch {}
  window.dispatchEvent(new CustomEvent('mentor:fyers-rate-limit', { detail: { kind, until, message } }));
}

function refusedResponse(state) {
  const daily = state.kind === 'daily';
  return new Response(JSON.stringify({
    code: 'FYERS_RATE_LIMIT',
    limitScope: daily ? 'daily' : 'temporary',
    error: daily
      ? 'FYERS Standard daily allowance exhausted. Requests are paused until the next market session; a manual retry cannot restore today\'s quota.'
      : 'FYERS is rate limiting requests. Automatic requests are paused briefly to protect the allowance.',
    authRequired: false
  }), { status: 429, headers: { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' } });
}

export function installFyersRequestGuard() {
  if (typeof window === 'undefined' || window.__iomFyersRequestGuard) return;
  window.__iomFyersRequestGuard = true;
  const nativeFetch = window.fetch.bind(window);

  window.fetch = async (input, init = {}) => {
    let url;
    try {
      const raw = typeof input === 'string' ? input : input?.url || '';
      url = new URL(raw, window.location.origin);
    } catch {
      return nativeFetch(input, init);
    }
    const isProtected = url.origin === window.location.origin
      && protectedRoutes.has(url.pathname)
      && (!init.method || String(init.method).toUpperCase() === 'GET');
    if (!isProtected) return nativeFetch(input, init);

    const blocked = cooldownState();
    if (blocked) return refusedResponse(blocked);

    const key = url.toString();
    const now = Date.now();
    const cached = recentlyCompleted.get(key);
    if (cached && cached.until > now) return cached.response.clone();
    if (pending.has(key)) return (await pending.get(key)).clone();

    const request = (async () => {
      const response = await nativeFetch(input, init);
      if (response.status === 429) {
        let payload = {};
        try { payload = await response.clone().json(); } catch {}
        const msg = String([payload?.detail, payload?.error].filter(Boolean).join(' '));
        const daily = payload?.limitScope === 'daily'
          || /5[,.]?000\s*requests\s*\/\s*day|daily (?:api )?(?:request )?limit|requests\/day/i.test(msg);
        saveCooldown(daily ? 'daily' : 'temporary', msg);
      } else if (response.ok) {
        const cacheMs = url.pathname === '/api/fyers/history' ? 20000
          : url.pathname === '/api/fyers/mentor-snapshot' ? 5000
          : url.pathname === '/api/fyers/research-history' ? 60000
          : url.pathname === '/api/fyers/quote' ? 1000 : 10000;
        recentlyCompleted.set(key, { until: Date.now() + cacheMs, response: response.clone() });
        if (recentlyCompleted.size > 25) {
          for (const [item, value] of recentlyCompleted) {
            if (value.until <= Date.now()) recentlyCompleted.delete(item);
          }
          if (recentlyCompleted.size > 25) recentlyCompleted.delete(recentlyCompleted.keys().next().value);
        }
      }
      return response;
    })();

    pending.set(key, request);
    try { return (await request).clone(); }
    finally { if (pending.get(key) === request) pending.delete(key); }
  };
}
