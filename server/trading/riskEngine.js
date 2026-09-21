export function evaluateTradeIntent({ intent, config, runtime, seenIntent = false, now = new Date() }) {
  const rejects = [];
  const action = String(intent?.action || 'ENTRY').toUpperCase();
  const isEntry = action === 'ENTRY';
  const isExit = action === 'EXIT';

  if (!isEntry && !isExit) reject(rejects, 'INVALID_ACTION', 'Trade action must be ENTRY or EXIT.');
  if (!intent?.intentId) reject(rejects, 'MISSING_INTENT_ID', 'Every trade intent requires an idempotency key.');
  if (seenIntent) reject(rejects, 'DUPLICATE_INTENT', 'This trade intent has already been processed.');

  if (!config.tradingBridgeEnabled) {
    reject(rejects, 'TRADING_BRIDGE_DISABLED', 'The trading bridge is disabled on the server.');
  }

  if (config.mode === 'LIVE' && !config.liveTradingEnabled) {
    reject(rejects, 'LIVE_DISABLED', 'LIVE execution is disabled on the server.');
  }

  // Phase 1 has no broker write adapter by design.
  if (config.mode === 'LIVE') {
    reject(rejects, 'LIVE_ADAPTER_NOT_IMPLEMENTED', 'The LIVE broker order adapter is not implemented in this phase.');
  }

  if (isEntry && runtime.killSwitchActive) {
    reject(rejects, 'KILL_SWITCH_ACTIVE', 'Emergency kill switch is active; new risk is blocked.');
  }

  if (config.mode !== 'SIMULATION') {
    if (!runtime.broker.authenticated) {
      reject(rejects, 'BROKER_SESSION_REQUIRED', 'A current FYERS session is required.');
    }
    if (!runtime.marketData.connected) {
      reject(rejects, 'MARKET_DATA_DISCONNECTED', 'FYERS market-data connection is not healthy.');
    }
    if (isEntry && !runtime.broker.orderSocketConnected) {
      reject(rejects, 'ORDER_STREAM_DISCONNECTED', 'FYERS order-update connection is not healthy.');
    }

    const tickAgeMs = ageMs(runtime.marketData.lastTickAt, now);
    if (isEntry && (tickAgeMs == null || tickAgeMs > config.maxQuoteAgeMs)) {
      reject(rejects, 'STALE_MARKET_DATA', 'Latest server-side market data is too old for a new entry.', {
        tickAgeMs,
        maxQuoteAgeMs: config.maxQuoteAgeMs
      });
    }
  }

  if (isEntry) {
    const symbol = String(intent?.symbol || '');
    if (!symbol || !config.allowedOrderSymbolPrefixes.some(prefix => symbol.startsWith(prefix))) {
      reject(rejects, 'SYMBOL_NOT_ALLOWED', 'The requested contract is outside the server order allowlist.');
    }

    if (String(intent?.side || '').toUpperCase() !== 'BUY') {
      reject(rejects, 'ENTRY_SIDE_NOT_ALLOWED', 'Phase 1 permits only BUY option entry intents.');
    }

    const lots = positiveNumber(intent?.lots);
    if (lots == null) {
      reject(rejects, 'INVALID_LOTS', 'Lots must be a positive number.');
    } else if (config.maxLots <= 0) {
      reject(rejects, 'MAX_LOTS_NOT_CONFIGURED', 'Maximum lots must be configured on the server.');
    } else if (lots > config.maxLots) {
      reject(rejects, 'MAX_LOTS_EXCEEDED', 'Requested lots exceed the server maximum.', {
        requestedLots: lots,
        maxLots: config.maxLots
      });
    }

    const estimatedRiskRs = positiveNumber(intent?.estimatedRiskRs);
    if (estimatedRiskRs == null) {
      reject(rejects, 'RISK_ESTIMATE_REQUIRED', 'A server-verifiable risk estimate is required.');
    } else if (config.maxRiskPerTradeRs <= 0) {
      reject(rejects, 'MAX_RISK_NOT_CONFIGURED', 'Maximum risk per trade must be configured on the server.');
    } else if (estimatedRiskRs > config.maxRiskPerTradeRs) {
      reject(rejects, 'MAX_RISK_EXCEEDED', 'Estimated trade risk exceeds the server maximum.', {
        estimatedRiskRs,
        maxRiskPerTradeRs: config.maxRiskPerTradeRs
      });
    }

    if (config.capitalRs <= 0) {
      reject(rejects, 'CAPITAL_NOT_CONFIGURED', 'Trading capital must be configured on the server.');
    }

    if (config.onePositionAtATime && Number(runtime.positions.openCount || 0) > 0) {
      reject(rejects, 'POSITION_ALREADY_OPEN', 'One-position-at-a-time protection is active.');
    }

    const sessionLossRs = Math.max(0, -(Number(runtime.pnl.realizedRs || 0) + Number(runtime.pnl.unrealizedRs || 0)));
    if (config.dailyLossLimitRs <= 0) {
      reject(rejects, 'DAILY_LOSS_LIMIT_NOT_CONFIGURED', 'Daily loss limit must be configured on the server.');
    } else if (sessionLossRs >= config.dailyLossLimitRs) {
      reject(rejects, 'DAILY_LOSS_LIMIT_REACHED', 'Daily loss limit has been reached.', {
        sessionLossRs,
        dailyLossLimitRs: config.dailyLossLimitRs
      });
    }
  }

  return {
    ok: rejects.length === 0,
    action,
    intentId: intent?.intentId || null,
    mode: config.mode,
    rejects
  };
}

function reject(list, code, message, detail = undefined) {
  list.push({ code, message, ...(detail ? { detail } : {}) });
}

function positiveNumber(value) {
  const number = Number(value);
  return Number.isFinite(number) && number > 0 ? number : null;
}

function ageMs(value, now) {
  if (!value) return null;
  const timestamp = new Date(value).getTime();
  if (!Number.isFinite(timestamp)) return null;
  return Math.max(0, now.getTime() - timestamp);
}
