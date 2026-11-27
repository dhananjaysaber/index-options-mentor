// One tap sends one buy request. No second screen and no second tap.
// The server enforces "one order" too; this stops repeats before they leave the phone.
export const AFTER_TAP_PAUSE_MS = 3000;

const NOTHING_SENT_503 = new Set(['ORDER_CONNECTION_NOT_CONFIGURED', 'FYERS_ACCOUNT_NOT_VERIFIED', 'APP_SIGN_IN_NOT_CONFIGURED', 'APP_SIGN_IN_CHECK_UNAVAILABLE']);
const UNCLEAR = { kind: 'unclear', message: 'The order status is unclear. Check your FYERS orders before buying again.' };

export const REASONS = {
  PRICE_MOVED_REFRESH_PLAN: 'The price went up after you saw it.',
  TRADE_CHANGED_LOOK_AGAIN: 'The option or quantity changed after you saw it.',
  MENTOR_PLAN_CHANGED_REFRESH: 'The setup changed after you saw it.',
  MENTOR_ENTRY_NOT_READY: 'There is no current setup.',
  STRATEGY_POSITION_ALREADY_ACTIVE: 'This strategy already has a trade open.',
  DUPLICATE_TAP: 'This was a second tap. Only the first one counted. Check the status below.',
  RECONCILIATION_ATTENTION_REQUIRED: 'An open trade needs checking first.',
  REAL_MONEY_DISABLED: 'Real-money buying is off.',
  NEW_ORDERS_STOPPED: 'New buys are paused.',
  LIVE_EXECUTION_DISABLED_OR_LIMIT_UNSET: 'Real-money buying is off, or the quantity is above the limit.',
  FYERS_ENTRIES_DISABLED: 'Real-money buying is off.',
  FUNDS_RESERVED_FOR_UNRESOLVED_ORDERS: 'Your funds are held for an order that is not settled yet.',
  CONTRACT_CHANGED_REFRESH_PLAN: 'The option details changed.',
  ENTRY_SESSION_CLOSED: 'The market is closed for new buys.',
  STRUCTURAL_STOP_ALREADY_HIT: 'The NIFTY stop level has already been crossed.',
  INITIAL_STOP_ALREADY_HIT: 'The option is already at its stop price.',
  VALID_INITIAL_BROKER_STOP_REQUIRED: 'A valid stop price could not be set.',
  INSUFFICIENT_AVAILABLE_FUNDS: 'Your FYERS funds are not enough.',
  AMOUNT_CANNOT_BUY_ONE_LOT: 'The amount per trade cannot buy one lot.',
  LOT_LIMIT_IN_USE: '2-lot limit: a real buy is already open or not settled yet.',
  LOT_LIMIT_EXCEEDED: '2-lot limit: this order was larger than 2 lots.',
  AMOUNT_LIMIT_EXCEEDED: 'The amount per trade is above your server limit.',
  STALE_OR_INVALID_OPTION_QUOTE: 'A fresh option price was not available.',
  FRESH_BID_ASK_REQUIRED: 'A fresh option price was not available.',
  FRESH_OPTION_AND_INDEX_REQUIRED: 'Fresh prices were not available.',
  PRICE_NOT_AVAILABLE: 'A fresh price is not available.',
  STRATEGY_STALE: 'The strategy reading is out of date.',
  STRATEGY_NOT_LOADED: 'The strategy reading is not ready.',
  BROKER_CHECK_FAILED_NO_ORDER: 'A check with FYERS failed.',
  FYERS_SESSION_REQUIRED: 'Connect FYERS first.',
  FYERS_ACCOUNT_NOT_VERIFIED: 'Your FYERS login could not be checked.',
  ACCOUNT_DOES_NOT_MATCH_AWS: 'This FYERS login is not the trading account saved on your server.',
  APP_SIGN_IN_REQUIRED: 'Sign in to the app again.'
};
export const plainReason = code => REASONS[code] || 'A server safety check did not pass.';

function describe(order = {}) {
  if (order.duplicate && order.state === 'NOT_SENT') return { kind: 'refused', message: 'No order was sent for that tap.' };
  const text = {
    MANAGING: ['done', 'Bought. Your stop is confirmed.'],
    PROTECTING: ['warning', 'Bought, but the stop is NOT confirmed. Check FYERS now.'],
    NO_FILL: ['refused', 'The order was not filled. Nothing was bought. Check FYERS if unsure.'],
    CLOSED: ['done', 'This trade has already closed. Check the details in FYERS.'],
    EXITING: ['warning', 'A sale is in progress for this trade. Check FYERS.'],
    UNCLEAR: ['unclear', UNCLEAR.message]
  }[order.state] || ['waiting', 'Order waiting. It is not confirmed as bought yet.'];
  return { kind: text[0], message: text[1] };
}

async function sendBuy(fetcher, body) {
  let response, data;
  try {
    response = await fetcher('/api/orders/buy', { method: 'POST', headers: { 'content-type': 'application/json', 'x-iom-action': 'live-orders' }, body: JSON.stringify(body) });
    data = await response.json();
  } catch { return UNCLEAR; }
  if (response.ok) return data?.order ? describe(data.order) : UNCLEAR;
  const refused = code => ({ kind: 'refused', message: 'Buy refused: ' + plainReason(code) + ' No order was sent for this tap.' });
  // A reason code comes only from a server check that ran before any order left.
  if (response.status === 409) return data?.reason === 'DUPLICATE_TAP' ? { kind: 'refused', message: plainReason('DUPLICATE_TAP') } : data?.reason ? refused(data.reason) : UNCLEAR;
  if ([400, 401, 403, 404, 405, 413].includes(response.status) || NOTHING_SENT_503.has(data?.error)) return refused(data?.error);
  return UNCLEAR;
}

export function createOneTapBuy({ fetcher, uuid = () => crypto.randomUUID(), now = Date.now }) {
  const sending = new Set(), quietUntil = {}, unanswered = {};
  return async function tap(strategy, shown, tradeAmount, onSend = () => {}) {
    // Set before anything asynchronous, so a double tap cannot slip through.
    if (sending.has(strategy) || now() < (quietUntil[strategy] || 0)) return { kind: 'ignored' };
    sending.add(strategy);
    try {
      onSend();
      const key = [shown.symbol, shown.quantity].join('|');
      // After a lost reply, the same identity makes the server report instead of buying twice.
      if (unanswered[strategy]?.key !== key) unanswered[strategy] = { key, id: uuid() };
      const result = await sendBuy(fetcher, { intentId: unanswered[strategy].id, strategy, symbol: shown.symbol, quantity: shown.quantity, maxPrice: shown.buyPrice, tradeAmount });
      if (result.kind !== 'unclear') delete unanswered[strategy];
      return result;
    } finally {
      sending.delete(strategy);
      quietUntil[strategy] = now() + AFTER_TAP_PAUSE_MS;
    }
  };
}
