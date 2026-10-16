import crypto from 'node:crypto';
import { evaluateRisk } from './risk-engine.js';

export class ExecutionGate {
  constructor({ config, state, audit, riskConfigReady }) {
    this.config = config;
    this.state = state;
    this.audit = audit;
    this.riskConfigReady = riskConfigReady;
  }

  preflight(intent) {
    const result = evaluateRisk({
      intent,
      policy: this.config.risk,
      state: this.state.snapshot(),
      mode: this.config.executionMode,
      riskConfigReady: this.riskConfigReady()
    });

    this.audit.append('EXECUTION_PREFLIGHT', {
      strategy: intent?.strategy || '',
      symbol: intent?.symbol || '',
      idempotencyKey: intent?.idempotencyKey || '',
      result
    });

    return result;
  }

  simulate(intent) {
    const key = String(intent?.idempotencyKey || '').trim();
    const existing = this.state.getIdempotency(key);
    if (existing) {
      this.audit.append('SIMULATION_DUPLICATE_BLOCKED', { idempotencyKey: key });
      return { ...existing, duplicate: true };
    }

    const preflight = this.preflight(intent);
    if (!preflight.ok) {
      const rejection = {
        ok: false,
        status: 'REJECTED',
        mode: this.config.executionMode,
        preflight,
        rejectedAt: new Date().toISOString()
      };
      if (key) this.state.registerIdempotency(key, rejection);
      this.audit.append('SIMULATION_REJECTED', {
        idempotencyKey: key,
        rejections: preflight.rejections
      });
      return rejection;
    }

    if (this.config.executionMode === 'LIVE') {
      const rejection = {
        ok: false,
        status: 'REJECTED',
        mode: 'LIVE',
        rejectedAt: new Date().toISOString(),
        preflight,
        rejections: [{
          code: 'LIVE_DISABLED',
          message: 'LIVE execution is intentionally unavailable in phase 1.'
        }]
      };
      if (key) this.state.registerIdempotency(key, rejection);
      this.audit.append('LIVE_DISABLED_REJECTION', { idempotencyKey: key });
      return rejection;
    }

    const result = {
      ok: true,
      status: this.config.executionMode === 'PAPER' ? 'PAPER_RECORDED' : 'SIMULATION_RECORDED',
      mode: this.config.executionMode,
      simulationId: crypto.randomUUID(),
      idempotencyKey: key,
      recordedAt: new Date().toISOString(),
      intent: compactIntent(intent),
      preflight
    };

    this.state.registerIdempotency(key, result);
    this.audit.append('SIMULATED_EXECUTION_RECORDED', result);
    return result;
  }
}

function compactIntent(intent) {
  return {
    strategy: String(intent?.strategy || ''),
    source: String(intent?.source || ''),
    symbol: String(intent?.symbol || ''),
    side: String(intent?.side || ''),
    lots: Number(intent?.lots) || 0,
    quantity: Number(intent?.quantity) || 0,
    estimatedRisk: Number(intent?.estimatedRisk) || 0,
    referencePrice: Number(intent?.referencePrice) || 0,
    underlyingEntry: Number(intent?.underlyingEntry) || 0,
    underlyingStop: Number(intent?.underlyingStop) || 0,
    underlyingTarget: Number(intent?.underlyingTarget) || 0
  };
}
