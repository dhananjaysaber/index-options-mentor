// What the app shows before it loads. The server makes the real decision on every
// private request; this only keeps the screens closed when it would refuse.
export const MAIN_ADDRESS = 'https://optionsmentor.netlify.app';
// localhost is allowed to ask only so screen tests can use a fake server.
const MAY_ASK = new Set(['optionsmentor.netlify.app', 'localhost', '127.0.0.1']);

export async function checkSignIn(fetcher, hostname) {
  if (!MAY_ASK.has(hostname)) return { state: 'wrong-address' };
  try {
    const response = await fetcher('/api/auth/session', { cache: 'no-store', credentials: 'same-origin' });
    const data = await response.json();
    if (response.ok && data?.signedIn === true && data.expiresAt * 1000 > Date.now()) return { state: 'signed-in', expiresAt: data.expiresAt };
    if (response.status === 401) return { state: 'signed-out' };
    if (data?.error === 'APP_SIGN_IN_NOT_CONFIGURED') return { state: 'not-configured' };
    if (data?.error === 'MAIN_ADDRESS_ONLY') return { state: 'wrong-address' };
  } catch {}
  return { state: 'unavailable' };
}

/** Close the open app when the day's sign-in ends or was ended on another device. */
export function watchSignIn(expiresAt, { fetcher, hostname, reload, page = document, timers = window }) {
  timers.setTimeout(reload, Math.max(1000, expiresAt * 1000 - Date.now() + 1000));
  page.addEventListener('visibilitychange', async () => {
    if (page.visibilityState !== 'visible') return;
    if (Date.now() >= expiresAt * 1000) return reload();
    // A brief loss of signal does not throw away the screen; the server still refuses.
    if ((await checkSignIn(fetcher, hostname)).state === 'signed-out') reload();
  });
}

export async function signOut(fetcher, allDevices) {
  const response = await fetcher('/api/auth/' + (allDevices ? 'logout-all' : 'logout'), { method: 'POST', credentials: 'same-origin' });
  if (!response.ok) throw new Error(allDevices ? 'SIGN_OUT_ALL_NOT_CONFIRMED' : 'SIGN_OUT_NOT_CONFIRMED');
}
