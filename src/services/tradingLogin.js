// The daily "Connect trading account" sign-in. The server does the checking; this
// only opens FYERS and passes its one-time code back. No secret is ever here.
export const RETURN_PATH = '/trading-login';
const FYERS_LOGIN = 'https://api-t1.fyers.in/api/v3/generate-authcode?';
const MESSAGES = {
  TRADING_APP_NOT_SAVED_ON_SERVER: 'The one-time server setup for this button has not been done yet.',
  TRADING_LOGIN_NOT_STARTED_HERE: 'This sign-in was not started here, or was already used. Tap Connect trading account again.',
  TRADING_LOGIN_EXPIRED: 'The sign-in took longer than 5 minutes. Tap Connect trading account again.',
  TRADING_LOGIN_WRONG_ACCOUNT: 'This is not the FYERS account saved on your server. Nothing was saved.',
  FYERS_DID_NOT_ACCEPT_SIGN_IN: 'FYERS did not accept the sign-in. Nothing was saved. Try again.',
  FYERS_SESSION_REQUIRED: 'Connect FYERS in the app first, then tap Connect trading account again.',
  ACCOUNT_DOES_NOT_MATCH_AWS: 'This FYERS login does not match the account saved on your server.',
  APP_SIGN_IN_REQUIRED: 'Sign in to the app again.'
};
const UNCLEAR = 'The trading sign-in could not be confirmed. Check the trading connection before trying again.';

async function call(fetcher, action, body) {
  let response, data;
  try {
    response = await fetcher('/api/orders/' + action, { method: 'POST', credentials: 'same-origin',
      headers: { 'content-type': 'application/json', 'x-iom-action': 'live-orders' }, body: JSON.stringify(body) });
    data = await response.json();
  } catch { throw new Error(UNCLEAR); }
  if (!response.ok) throw new Error(MESSAGES[data?.reason] || MESSAGES[data?.error] || UNCLEAR);
  return data;
}

/** The FYERS page to open. Anything that is not FYERS is refused. */
export async function startTradingLogin(fetcher) {
  const data = await call(fetcher, 'login-start', {});
  if (typeof data?.loginUrl !== 'string' || !data.loginUrl.startsWith(FYERS_LOGIN)) throw new Error(UNCLEAR);
  return data.loginUrl;
}

export function returnedValues(search) {
  const query = new URLSearchParams(search || '');
  const state = query.get('state') || '', code = query.get('auth_code') || '';
  return /^[a-f0-9]{64}$/.test(state) && /^[A-Za-z0-9_.-]{10,6000}$/.test(code) ? { state, code } : null;
}

export async function finishTradingLogin(fetcher, values) {
  if (!values) throw new Error('FYERS did not return a sign-in. Open the app and tap Connect trading account again.');
  const data = await call(fetcher, 'login-finish', values);
  if (data?.connected !== true) throw new Error(UNCLEAR);
  return data;
}
