// The app and its server share one address, so requests carry the sign-in cookie.
// Nothing secret is kept in browser storage.
const OLD_SESSION_KEY = 'index-options-mentor-fyers-session-v1';

let installed = false;

export function installApiBridge() {
  if (installed || typeof window === 'undefined' || typeof window.fetch !== 'function') return;
  installed = true;
  clearFyersSession();
  consumeLoginMarker();
  const nativeFetch = window.fetch.bind(window);
  let closing = false;

  window.fetch = async (input, init) => {
    const response = await nativeFetch(input, init);
    const url = typeof input === 'string' ? input : input?.url || '';
    if (response.status === 401 && url.startsWith('/api/') && !closing) {
      let code = '';
      try { code = (await response.clone().json())?.error; } catch {}
      // The day's sign-in ended: return to the sign-in screen once.
      if (code === 'APP_SIGN_IN_REQUIRED') { closing = true; window.location.reload(); }
    }
    return response;
  };
}

export function getFyersLoginUrl() {
  return new URL('/api/fyers/login', window.location.origin).toString();
}

// Removes the saved session that earlier versions kept in browser storage.
export function clearFyersSession() {
  try { localStorage.removeItem(OLD_SESSION_KEY); } catch {}
}

function consumeLoginMarker() {
  const search = new URLSearchParams(window.location.search || '');
  if (search.get('fyers') !== 'connected') return;
  search.delete('fyers');
  const clean = search.toString();
  window.history.replaceState({}, document.title, `${window.location.pathname}${clean ? '?' + clean : ''}${window.location.hash || ''}`);
}
