const offset = 330 * 60;
const daySeconds = 86400;
const open = 9 * 3600 + 15 * 60;
const close = 15 * 3600 + 30 * 60;

export function stockSetup(five, three, now) {
  const seconds = Math.floor(now / 1000);
  const day = Math.floor((seconds + offset) / daySeconds);
  const current = seconds + offset - day * daySeconds;
  if (current < open + 900 || current >= close) return null;
  const rows = (input, interval) => [...new Map(input.filter(row =>
    Array.isArray(row) && row.length >= 5 && row.slice(0, 5).every(Number.isFinite) &&
    row[0] + interval <= seconds
  ).map(row => [row[0], row])).values()].sort((a, b) => a[0] - b[0]);
  const session = (row, date) => {
    const local = row[0] + offset - date * daySeconds;
    return local >= open && local < close;
  };
  const history = rows(five, 300);
  const today = history.filter(row => session(row, day));
  const opening = today.filter(row => row[0] + offset - day * daySeconds < open + 900);
  if (opening.length !== 3) return null;

  const previous = history.filter(row => row[0] + offset < day * daySeconds);
  const priorDay = previous.length ? Math.floor((previous.at(-1)[0] + offset) / daySeconds) : null;
  const prior = priorDay === null ? [] : previous.filter(row => session(row, priorDay));
  const triggers = rows(three, 180).filter(row => session(row, day));
  const confirm = triggers.at(-1);
  if (!confirm || seconds - (confirm[0] + 180) >= 180) return null;

  const signals = [
    ['CE', 'Breakout and retest', Math.max(...opening.map(row => row[2]))],
    ['PE', 'Breakdown and retest', Math.min(...opening.map(row => row[3]))]
  ];
  if (prior.length) {
    signals.push(['CE', 'Failed breakdown and reclaim', Math.min(...prior.map(row => row[3]))]);
    signals.push(['PE', 'Failed breakout and rejection', Math.max(...prior.map(row => row[2]))]);
  }
  for (const [side, setup, level] of signals) {
    const above = side === 'CE';
    const holds = price => above ? price > level : price < level;
    const tolerance = level * 0.001;
    const context = today.slice(3).filter(row => row[0] + 300 <= confirm[0]);
    const contextIndex = context.findLastIndex((row, i) => holds(row[4]) &&
      (setup.startsWith('Failed')
        ? (above ? row[3] < level - tolerance : row[2] > level + tolerance)
        : !holds((context[i - 1] ?? opening.at(-1))[4])));
    if (contextIndex < 0) continue;
    const contextBar = context[contextIndex];
    if (confirm[0] - contextBar[0] > 1800) continue;
    const retests = triggers.filter(row => row[0] >= contextBar[0] + 300 && row[0] < confirm[0]);
    if (!retests.length || retests.some(row => !holds(row[4]))) continue;
    const retest = retests.findLast(row => above ? row[3] <= level + tolerance : row[2] >= level - tolerance);
    if (!retest || !holds(confirm[4]) || !(above ? confirm[4] > retest[2] : confirm[4] < retest[3])) continue;
    const stop = above ? Math.min(level, retest[3], setup.startsWith('Failed') ? contextBar[3] : level)
      : Math.max(level, retest[2], setup.startsWith('Failed') ? contextBar[2] : level);
    const distance = Math.abs(confirm[4] - stop);
    if (distance < tolerance || distance > level * 0.012) continue;
    return { side, setup, level, entry: confirm[4], stop, distance, confirmedAt: confirm[0] + 180 };
  }
  return null;
}
