const MODES = new Set(['SIMULATION', 'PAPER', 'LIVE']);

function boolEnv(name, fallback = false) {
  const raw = process.env[name];
  if (raw == null || raw === '') return fallback;
  return String(raw).toLowerCase() === 'true';
}

function numberEnv(name, fallback = 0) {
  const value = Number(process.env[name]);
  return Number.isFinite(value) && value >= 0 ? value : fallback;
}

function modeEnv() {
  const requested = String(process.env.EXECUTION_MODE || 'SIMULATION').toUpperCase();
  return MODES.has(requested) ? requested : 'SIMULATION';
}

export function tradingConfig() {
  const mode = modeEnv();
  return Object.freeze({
    mode,
    tradingBridgeEnabled: boolEnv('TRADING_BRIDGE_ENABLED', false),
    liveTradingEnabled: boolEnv('LIVE_TRADING_ENABLED', false),
    capitalRs: numberEnv('TRADING_CAPITAL_RS', 0),
    maxRiskPerTradeRs: numberEnv('MAX_RISK_PER_TRADE_RS', 0),
    maxLots: Math.floor(numberEnv('MAX_LOTS', 0)),
    dailyLossLimitRs: numberEnv('DAILY_LOSS_LIMIT_RS', 0),
    maxQuoteAgeMs: Math.max(500, numberEnv('MAX_QUOTE_AGE_MS', 3000)),
    onePositionAtATime: boolEnv('ONE_POSITION_AT_A_TIME', true),
    allowedOrderSymbolPrefixes: String(process.env.ALLOWED_ORDER_SYMBOL_PREFIXES || 'NSE:NIFTY')
      .split(',')
      .map(value => value.trim())
      .filter(Boolean),
    dataDir: process.env.TRADING_DATA_DIR || '.runtime/trading'
  });
}

export function publicTradingConfig(config = tradingConfig()) {
  return {
    mode: config.mode,
    tradingBridgeEnabled: config.tradingBridgeEnabled,
    liveTradingEnabled: config.liveTradingEnabled,
    liveOrderPlacementImplemented: false,
    riskConfigured: Boolean(
      config.capitalRs > 0 &&
      config.maxRiskPerTradeRs > 0 &&
      config.maxLots > 0 &&
      config.dailyLossLimitRs > 0
    ),
    safeguards: {
      onePositionAtATime: config.onePositionAtATime,
      maxQuoteAgeMs: config.maxQuoteAgeMs,
      allowedOrderSymbolPrefixes: config.allowedOrderSymbolPrefixes
    }
  };
}
