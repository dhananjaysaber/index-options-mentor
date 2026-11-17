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
  const dailyLimit = rateLimited && /5[,.]?000\s*requests\s*\/\s*day|500[,.]?000\s*requests\s*\/\s*day|daily (?:api )?(?:request )?limit|requests\/day/i.test(detail);
  const status = authRequired ? 401 : rateLimited ? 429
    : Number(httpStatus) >= 400 && Number(httpStatus) < 600 ? Number(httpStatus) : 502;

  return {
    status,
    code: authRequired ? 'FYERS_AUTH_REQUIRED'
      : rateLimited ? 'FYERS_RATE_LIMIT' : 'FYERS_UPSTREAM_ERROR',
    authRequired,
    limitScope: dailyLimit ? 'daily' : rateLimited ? 'temporary' : null,
    error: authRequired
      ? 'FYERS session expired or was rejected. Reconnect FYERS to resume live data.'
      : rateLimited
        ? dailyLimit
          ? 'FYERS daily allowance exhausted. Data requests will pause until the next market session.'
          : 'FYERS rate limit reached. Data requests will back off before retrying.'
        : `FYERS ${operation} data is temporarily unavailable.`,
    detail
  };
}
