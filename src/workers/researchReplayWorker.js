import { buildMarketEvidence } from '../services/researchAnalysis.js';
import { buildReplayLab } from '../services/researchReplay.js';

self.onmessage = event => {
  const payload = event?.data || {};
  try {
    if (payload.type === 'evidence') {
      const raw = buildMarketEvidence(payload.fiveMinute || [], []);
      self.postMessage({
        type: 'evidence',
        requestId: payload.requestId,
        evidence: compactEvidence(raw)
      });
      return;
    }

    if (payload.type === 'replay') {
      const fiveMinute = payload.fiveMinute || [];
      const threeMinute = payload.threeMinute || [];
      const raw = buildReplayLab(
        payload.history || [],
        fiveMinute,
        threeMinute
      );
      const evidenceRaw = buildMarketEvidence(fiveMinute, threeMinute);
      self.postMessage({
        type: 'replay',
        requestId: payload.requestId,
        replay: compactReplay(raw),
        evidence: compactEvidence(evidenceRaw)
      });
    }
  } catch (error) {
    self.postMessage({
      type: 'error',
      requestId: payload.requestId,
      message: error?.message || 'Replay calculation failed.'
    });
  }
};

function compactEvidence(raw) {
  if (!raw) return null;
  return {
    coverage: raw.coverage,
    range: raw.range,
    regime: raw.regime,
    scheduledExpiryProxy: raw.scheduledExpiryProxy
  };
}

function compactReplay(raw) {
  if (!raw) return null;
  const probes = raw?.structural?.probes || {};
  return {
    coverage: raw.coverage,
    journal: {
      coreCases: raw.journal?.coreCases || 0,
      scalpCases: raw.journal?.scalpCases || 0,
      summaries: raw.journal?.summaries || {},
      legacyVsRunner: raw.journal?.legacyVsRunner || emptyComparison(),
      actualVsLegacy: raw.journal?.actualVsLegacy || emptyComparison(),
      actualVsRunner: raw.journal?.actualVsRunner || emptyComparison(),
      scalpActualVsPlan: raw.journal?.scalpActualVsPlan || emptyComparison(),
      cases: Array.isArray(raw.journal?.cases) ? raw.journal.cases.slice(-12) : []
    },
    structural: {
      probes: {
        core: { stats: probes?.core?.stats || null },
        shadow: { stats: probes?.shadow?.stats || null },
        scalp: { stats: probes?.scalp?.stats || null }
      },
      tuesday: raw?.structural?.tuesday || {}
    }
  };
}

function emptyComparison() {
  return {
    matched: 0,
    leftBetter: 0,
    rightBetter: 0,
    equal: 0,
    avgDifferenceR: 0
  };
}
