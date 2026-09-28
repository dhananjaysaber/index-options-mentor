const state = {
  killSwitchActive: true,
  marketData: {
    connected: false,
    lastTickAt: null
  },
  broker: {
    authenticated: false,
    orderSocketConnected: false,
    sessionDate: null
  },
  positions: {
    openCount: 0
  },
  pnl: {
    sessionDate: null,
    realizedRs: 0,
    unrealizedRs: 0
  }
};

export function tradingRuntimeSnapshot() {
  return structuredClone(state);
}

// These mutators are intentionally server-internal. Do not expose them as
// unauthenticated public HTTP controls.
export function setKillSwitch(active) {
  state.killSwitchActive = Boolean(active);
}

export function updateMarketDataState(patch = {}) {
  Object.assign(state.marketData, pick(patch, ['connected', 'lastTickAt']));
}

export function updateBrokerState(patch = {}) {
  Object.assign(state.broker, pick(patch, ['authenticated', 'orderSocketConnected', 'sessionDate']));
}

export function updatePositionState(patch = {}) {
  Object.assign(state.positions, pick(patch, ['openCount']));
}

export function updatePnlState(patch = {}) {
  Object.assign(state.pnl, pick(patch, ['sessionDate', 'realizedRs', 'unrealizedRs']));
}

function pick(source, keys) {
  return Object.fromEntries(keys.filter(key => Object.hasOwn(source, key)).map(key => [key, source[key]]));
}
