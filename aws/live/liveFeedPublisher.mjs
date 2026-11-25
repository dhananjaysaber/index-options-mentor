// Reuses the existing FYERS DataSocket. This module never opens sockets or orders.
import fs from 'node:fs';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
const INDEX = 'NSE:NIFTY50-INDEX';
const OPTION = /^NSE:NIFTY[A-Z0-9]+(?:CE|PE)$/;
const DEFAULT_ROOT = '/var/lib/index-options-mentor/live-feed';

export function readLiveSubscriptions(root = DEFAULT_ROOT, nowMs = Date.now()) {
  try {
    const file = path.join(root, 'subscriptions.json');
    const info = fs.lstatSync(file);
    if (!info.isFile() || info.isSymbolicLink() || info.size > 8192 || (info.mode & 0o027)) return [];
    const data = JSON.parse(fs.readFileSync(file, 'utf8'));
    if (data.version !== 1 || !Number.isFinite(data.at) || nowMs - data.at < -1000 || nowMs - data.at > 15000 ||
        !Array.isArray(data.symbols) || data.symbols.length > 20 || data.symbols.some(s => typeof s !== 'string' || !OPTION.test(s))) return [];
    return [...new Set(data.symbols)];
  } catch { return []; }
}

export function mergeLiveSubscriptions(changes, subscribed, live) {
  const wanted = new Set(live);
  return {
    subscribe: [...new Set([...changes.subscribe, ...live.filter(s => !subscribed.has(s))])],
    unsubscribe: changes.unsubscribe.filter(s => !wanted.has(s))
  };
}

export function createLiveFeedPublisher({ root = DEFAULT_ROOT, now = Date.now, report = () => {} } = {}) {
  let connected = false;
  let quotes = new Map();
  let sequence = 0;
  let dirty = false;
  let errors = 0;
  function accept(symbol, quote, raw) {
    const at = Date.parse(quote?.timestamp || '');
    const age = now() - at;
    if (!(symbol === INDEX || OPTION.test(symbol)) || !Number.isFinite(at) || age < -1000 || age > 3000 ||
        !Number.isFinite(quote?.price) || quote.price <= 0) return false;
    const previous = quotes.get(symbol);
    if (previous && at < previous.at) return false;
    const row = { symbol, price: quote.price, at };
    if (symbol !== INDEX) {
      // Bid/ask are kept only from the same validated packet as its exchange time.
      if (Number.isFinite(raw?.bid_price) && raw.bid_price > 0 && Number.isFinite(raw?.ask_price) && raw.ask_price >= raw.bid_price) {
        row.bid = raw.bid_price; row.ask = raw.ask_price;
      }
    }
    quotes.set(symbol, row); dirty = true;
    return true;
  }
  function status(value) {
    connected = value === true;
    if (!connected) quotes.clear();
    dirty = true;
    flush();
  }
  function flush() {
    if (!dirty) return false;
    let temp = null;
    try {
      const info = fs.lstatSync(root);
      if (!info.isDirectory() || info.isSymbolicLink() || (info.mode & 0o027)) throw Error('UNSAFE_FEED_DIRECTORY');
      const at = now();
      quotes = new Map([...quotes].filter(([,q]) => at - q.at <= 3000));
      const allowed = new Set([INDEX, ...readLiveSubscriptions(root, at)]);
      const data = {version:1, connected, publishedAt:at, sequence:++sequence,
        quotes:[...quotes.values()].filter(q => allowed.has(q.symbol))};
      temp = path.join(root, `quotes.${process.pid}.${randomUUID()}.tmp`);
      const fd = fs.openSync(temp, 'wx', 0o600);
      try { fs.writeFileSync(fd, JSON.stringify(data)); } finally { fs.closeSync(fd); }
      fs.renameSync(temp, path.join(root, 'quotes.json'));
      dirty = false;
      return true;
    } catch {
      errors++;
      if (errors <= 3 || errors % 100 === 0) report('LIVE_FEED_PUBLISH_UNAVAILABLE');
      return false;
    } finally {
      if (temp) { try { fs.unlinkSync(temp); } catch {} }
    }
  }
  return {accept, status, flush};
}
