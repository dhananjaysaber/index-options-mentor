// Screen-only copy of scalpPremiumStop in aws/live/entrySignals.mjs, which stays
// the one used for real orders. tests/scalp-screen-stop.test.mjs keeps them equal.
export function scalpScreenStop({ price, niftySpot, niftyStop, option }) {
  const entry = Number(price), delta = Math.abs(Number(option?.delta)), gamma = Number(option?.gamma) || 0;
  if (!(Number(niftySpot) > 0 && Number(niftyStop) > 0)) return null;
  const risk = Math.abs(Number(niftySpot) - Number(niftyStop));
  if (!(entry > 0 && delta > 0 && delta <= 1 && risk > 0)) return null;
  const loss = delta * risk - 0.5 * gamma * risk * risk;
  if (!(loss > 0 && loss < entry)) return null;
  return Math.round((entry - loss) * 100) / 100;
}
