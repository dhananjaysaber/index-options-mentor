// Translate FYERS' HTTP and application-level errors before any snapshot
// is calculated. FYERS can return an application error in an HTTP 200 body.
const AUTH_CODES = new Set([-8, -15, -16, -17]);
const RATE_CODES = new Set([-360, -429]);

export function classifyFyersFailure(httpStatus, payload = {}, operation = 'market') {
  const code = Number(payload?.code);
  const detail = String(payload?.message || payload?.error || 'FYERS returned an error.').slice(0, 240);
  const authRequired = Number(httpStatus) === 401 || AUTH_CODES.has(code);
  const rateLimited = Number(httpStatus) === 429 || RATE_CODES.has(code)
    || /rate.?limit|too many requests/i.test(detail);
  const status = authRequired ? 401 : rateLimited ? 429
    : Number(httpStatus) >= 400 && Number(httpStatus) < 600 ? Number(httpStatus) : 502;

  return {
    status,
    code: authRequired ? 'FYERS_AUTH_REQUIRED'
      : rateLimited ? 'FYERS_RATE_LIMIT' : 'FYERS_UPSTREAM_ERROR',
    authRequired,
    error: authRequired
      ? 'FYERS session expired or was rejected. Reconnect FYERS to resume live data.'
      : rateLimited
        ? 'FYERS rate limit reached. Live data will retry shortly.'
        : `FYERS ${operation} data is temporarily unavailable.`,
    detail
  };
}
