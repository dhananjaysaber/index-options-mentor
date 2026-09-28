import express from 'express';
import { tradingConfig, publicTradingConfig } from './config.js';
import { tradingRuntimeSnapshot } from './runtimeState.js';
import { evaluateTradeIntent } from './riskEngine.js';
import { appendAuditEvent } from './auditLog.js';

export const tradingRouter = express.Router();

tradingRouter.get('/status', (_req, res) => {
  const config = tradingConfig();
  const runtime = tradingRuntimeSnapshot();

  res.json({
    ok: true,
    phase: 1,
    execution: publicTradingConfig(config),
    runtime: {
      killSwitchActive: runtime.killSwitchActive,
      marketDataConnected: runtime.marketData.connected,
      lastMarketTickAt: runtime.marketData.lastTickAt,
      brokerAuthenticated: runtime.broker.authenticated,
      orderStreamConnected: runtime.broker.orderSocketConnected,
      brokerSessionDate: runtime.broker.sessionDate,
      openPositionCount: runtime.positions.openCount,
      pnlSessionDate: runtime.pnl.sessionDate
    }
  });
});

tradingRouter.post('/preflight', async (req, res) => {
  const config = tradingConfig();
  const runtime = tradingRuntimeSnapshot();
  const intent = req.body?.intent || null;

  const result = evaluateTradeIntent({
    intent,
    config,
    runtime,
    // Durable idempotency arrives before PAPER execution is enabled.
    seenIntent: false
  });

  try {
    await appendAuditEvent(result.ok ? 'RISK_ACCEPTED' : 'RISK_REJECTED', {
      intent,
      result
    }, {
      actor: 'mentor-preflight',
      correlationId: intent?.intentId || null
    });
  } catch (error) {
    return res.status(503).json({
      ok: false,
      code: 'AUDIT_UNAVAILABLE',
      message: 'Risk decision was not accepted because the audit log is unavailable.'
    });
  }

  res.status(result.ok ? 200 : 422).json(result);
});
