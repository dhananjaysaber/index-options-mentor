const SESSION_KEY = 'index-options-mentor-fyers-session-v1';

const configuredBase = String(import.meta.env.VITE_API_BASE || '').replace(/\/$/, '');
const githubPagesBase = 'https://dhananjaysaber.github.io';
const defaultBackend = 'https://optionsmentor.netlify.app';

export const API_BASE = configuredBase || (window.location.hostname.endsWith('github.io') ? defaultBackend : '');

let installed = false;
let nativeFetch = null;

export function installApiBridge() {
  if (installed || typeof window === 'undefined' || typeof window.fetch !== 'function') return;
  installed = true;
  consumeFyersSessionFromHash();
  nativeFetch = window.fetch.bind(window);

  window.fetch = (input, init = {}) => {
    const originalUrl = typeof input === 'string' ? input : input?.url || '';
    if (!isApiPath(originalUrl)) return nativeFetch(input, init);

    const apiUrl = API_BASE ? `${API_BASE}${normaliseApiPath(originalUrl)}` : originalUrl;
    const headers = new Headers(init.headers || (typeof input !== 'string' ? input?.headers : undefined) || {});
    const session = readSession();
    if (session && (normaliseApiPath(originalUrl).startsWith('/api/fyers/') || normaliseApiPath(originalUrl).startsWith('/api/monitor/') || normaliseApiPath(originalUrl).startsWith('/api/execution/') || normaliseApiPath(originalUrl).startsWith('/api/orders/'))) {
      headers.set('Authorization', `Bearer ${session}`);
    }

    return nativeFetch(apiUrl, {
      ...init,
      headers,
      ...(API_BASE ? { mode: 'cors', credentials: 'omit' } : {})
    });
  };
}

export function getFyersLoginUrl() {
  const base = API_BASE || window.location.origin;
  const returnTo = getFrontendReturnUrl();
  const url = new URL('/api/fyers/login', base);
  if (base !== window.location.origin) url.searchParams.set('returnTo', returnTo);
  return url.toString();
}

export function clearFyersSession() {
  try { localStorage.removeItem(SESSION_KEY); } catch {}
}

export function hasFyersSession() {
  return Boolean(readSession());
}

function consumeFyersSessionFromHash() {
  const hash = String(window.location.hash || '').replace(/^#/, '');
  const params = new URLSearchParams(hash);
  const search = new URLSearchParams(window.location.search || '');
  const session = params.get('fyers_session');
  const cookieLoginReturn = search.get('fyers') === 'connected';
  if (!session && !cookieLoginReturn) return;
  try {
    if (session) localStorage.setItem(SESSION_KEY, session);
    else localStorage.removeItem(SESSION_KEY);
  } catch {}
  params.delete('fyers_session');
  if (cookieLoginReturn) search.delete('fyers');
  const cleanHash = params.toString();
  const cleanSearch = search.toString();
  const cleanUrl = `${window.location.pathname}${cleanSearch ? '?' + cleanSearch : ''}${cleanHash ? '#' + cleanHash : ''}`;
  window.history.replaceState({}, document.title, cleanUrl);
}


function getFrontendReturnUrl() {
  const basePath = import.meta.env.BASE_URL || '/';
  const origin = window.location.origin === githubPagesBase ? githubPagesBase : window.location.origin;
  return new URL(basePath, origin).toString();
}

function isApiPath(value) {
  if (typeof value !== 'string') return false;
  return value.startsWith('/api/');
}

function normaliseApiPath(value) {
  const url = new URL(value, window.location.origin);
  return `${url.pathname}${url.search}`;
}

function readSession() {
  try { return localStorage.getItem(SESSION_KEY) || ''; } catch { return ''; }
}
