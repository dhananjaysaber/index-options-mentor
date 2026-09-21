import fs from 'node:fs';
import path from 'node:path';

export class RuntimeState {
  constructor(dataDir) {
    this.file = path.join(dataDir, 'runtime-state.json');
    fs.mkdirSync(dataDir, { recursive: true });
    this.state = this.#load();
    this.#rollTradingDay();
  }

  snapshot() {
    this.#rollTradingDay();
    return structuredClone(this.state);
  }

  setKillSwitch(enabled) {
    this.state.killSwitch = Boolean(enabled);
    this.#save();
    return this.snapshot();
  }

  setBrokerState(patch) {
    this.state.broker = { ...this.state.broker, ...patch, updatedAt: new Date().toISOString() };
    this.#save();
  }

  setMarketState(patch) {
    this.state.market = { ...this.state.market, ...patch, updatedAt: new Date().toISOString() };
    this.#save();
  }

  registerIdempotency(key, result) {
    if (!key) return;
    this.state.idempotency[key] = {
      at: new Date().toISOString(),
      result
    };
    const keys = Object.keys(this.state.idempotency);
    if (keys.length > 500) {
      keys.sort((a, b) => String(this.state.idempotency[a]?.at).localeCompare(String(this.state.idempotency[b]?.at)))
        .slice(0, keys.length - 500)
        .forEach(old => delete this.state.idempotency[old]);
    }
    this.#save();
  }

  getIdempotency(key) {
    return key ? this.state.idempotency[key]?.result || null : null;
  }

  openPosition(position) {
    this.state.openPosition = position;
    this.#save();
  }

  closePosition({ realizedPnl = 0 } = {}) {
    this.#rollTradingDay();
    this.state.daily.realizedPnl += Number(realizedPnl) || 0;
    this.state.openPosition = null;
    this.#save();
  }

  #load() {
    try {
      const parsed = JSON.parse(fs.readFileSync(this.file, 'utf8'));
      return this.#normalise(parsed);
    } catch {
      return this.#normalise({});
    }
  }

  #normalise(value) {
    return {
      killSwitch: Boolean(value.killSwitch),
      openPosition: value.openPosition || null,
      idempotency: value.idempotency && typeof value.idempotency === 'object' ? value.idempotency : {},
      daily: {
        date: value.daily?.date || '',
        realizedPnl: Number(value.daily?.realizedPnl) || 0
      },
      broker: {
        connected: Boolean(value.broker?.connected),
        updatedAt: value.broker?.updatedAt || ''
      },
      market: {
        connected: Boolean(value.market?.connected),
        lastTickAt: value.market?.lastTickAt || '',
        updatedAt: value.market?.updatedAt || ''
      }
    };
  }

  #rollTradingDay() {
    const today = new Intl.DateTimeFormat('en-CA', {
      timeZone: 'Asia/Kolkata',
      year: 'numeric',
      month: '2-digit',
      day: '2-digit'
    }).format(new Date());
    if (this.state.daily.date === today) return;
    this.state.daily = { date: today, realizedPnl: 0 };
    this.#save();
  }

  #save() {
    const temp = this.file + '.tmp';
    fs.writeFileSync(temp, JSON.stringify(this.state, null, 2), { encoding: 'utf8', mode: 0o600 });
    fs.renameSync(temp, this.file);
  }
}
