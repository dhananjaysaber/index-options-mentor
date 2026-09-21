export function evaluateRisk({ intent, policy, state, mode, riskConfigReady }) {
  const reasons = [];

  if (!riskConfigReady) reasons.push(reject('RISK_CONFIG_INCOMPLETE', 'Server risk limits are not fully configured.'));
  if (policy.envKillSwitch || state.killSwitch) reasons.push(reject('KILL_SWITCH_ACTIVE', 'Emergency kill switch is active.'));

  const symbol = String(intent?.symbol || '').trim();
  const lots = Number(intent?.lots);
  const quantity = Number(intent?.quantity);
  const estimatedRisk = Number(intent?.estimatedRisk);
  const idempotencyKey = String(intent?.idempotencyKey || '').trim();

  if (!symbol) reasons.push(reject('SYMBOL_REQUIRED', 'A broker symbol is required.'));
  if (!Number.isInteger(lots) || lots <= 0) reasons.push(reject('LOTS_INVALID', 'Lots must be a positive integer.'));
  if (!Number.isInteger(quantity) || quantity <= 0) reasons.push(reject('QUANTITY_INVALID', 'Quantity must be a positive integer.'));
  if (!Number.isFinite(estimatedRisk) || estimatedRisk <= 0) reasons.push(reject('RISK_INVALID', 'Estimated currency risk must be positive.'));
  if (!idempotencyKey) reasons.push(reject('IDEMPOTENCY_REQUIRED', 'Every execution request needs an idempotency key.'));

  if (Number.isInteger(lots) && lots > policy.maxLots) {
    reasons.push(reject('MAX_LOTS_EXCEEDED', `Requested ${lots} lots exceeds server maximum of ${policy.maxLots}.`));
  }

  const perTradeLimit = policy.capitalLimit * (policy.maxRiskPerTradePct / 100);
  if (Number.isFinite(estimatedRisk) && estimatedRisk > perTradeLimit) {
    reasons.push(reject('MAX_RISK_EXCEEDED', `Estimated risk exceeds the server limit of ₹${perTradeLimit.toFixed(2)}.`));
  }

  const realizedLoss = Math.max(0, -Number(state.daily?.realizedPnl || 0));
  if (realizedLoss >= policy.dailyLossLimit) {
    reasons.push(reject('DAILY_LOSS_LIMIT', 'Daily loss limit has been reached.'));
  }

  if (policy.onePositionAtATime && state.openPosition) {
    reasons.push(reject('POSITION_ALREADY_OPEN', 'One-position-at-a-time protection is active.'));
  }

  if (mode !== 'SIMULATION') {
    if (!state.broker?.connected) reasons.push(reject('BROKER_DISCONNECTED', 'Broker session is not connected.'));
    if (!state.market?.connected) reasons.push(reject('MARKET_DATA_DISCONNECTED', 'Server market-data stream is not connected.'));

    const tickAge = Date.now() - new Date(state.market?.lastTickAt || 0).getTime();
    if (!Number.isFinite(tickAge) || tickAge > policy.staleDataMs) {
      reasons.push(reject('STALE_MARKET_DATA', `Latest server tick is older than ${policy.staleDataMs} ms.`));
    }
  }

  return {
    ok: reasons.length === 0,
    mode,
    checkedAt: new Date().toISOString(),
    limits: {
      capitalLimit: policy.capitalLimit,
      maxRiskPerTradePct: policy.maxRiskPerTradePct,
      maxRiskPerTrade: perTradeLimit,
      maxLots: policy.maxLots,
      dailyLossLimit: policy.dailyLossLimit,
      onePositionAtATime: policy.onePositionAtATime,
      staleDataMs: policy.staleDataMs
    },
    rejections: reasons
  };
}

function reject(code, message) {
  return { code, message };
}
