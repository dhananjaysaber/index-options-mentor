// Deterministic clock, ids and "no network" guard, so the same inputs always
// give the same outputs. Test-only: no app code is changed.
const RealDate = Date;
export async function frozen(nowMs, fn) {
  class FrozenDate extends RealDate {
    constructor(...args) { super(...(args.length ? args : [nowMs])); }
    static now() { return nowMs; }
  }
  const savedFetch = globalThis.fetch;
  const savedUUID = crypto.randomUUID;
  globalThis.Date = FrozenDate;
  globalThis.fetch = () => { throw new Error('NO_NETWORK_ALLOWED_IN_TEST'); };
  crypto.randomUUID = () => '00000000-0000-4000-8000-000000000000';
  try { return await fn(); }
  finally { globalThis.Date = RealDate; globalThis.fetch = savedFetch; crypto.randomUUID = savedUUID; }
}

// Round away last-digit floating point noise; keep NaN/undefined visible.
export function stable(value) {
  if (typeof value === 'number') {
    if (!Number.isFinite(value)) return `#${value}`;
    return Number(value.toFixed(8));
  }
  if (value === undefined) return '#undefined';
  if (Array.isArray(value)) return value.map(stable);
  if (value && typeof value === 'object') {
    return Object.fromEntries(Object.keys(value).sort().map(key => [key, stable(value[key])]));
  }
  return value;
}
