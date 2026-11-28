// Journal-screen filtering only. It reads saved records and never changes them.
// "Source" uses the same grouping as the Analysis page, so both pages agree.
import { classifyTradeCohort, isRealTrade, researchRecorder } from './researchAnalysis.js';

export const STRATEGY_FILTERS = [['all', 'All'], ['core', '13-point'], ['scalp', 'Scalp']];
export const SOURCE_FILTERS = [['all', 'Any source'], ['auto', 'Auto'], ['researchA', 'Research A'], ['researchB', 'Research B'], ['researchOther', 'Research ?'], ['manual', 'Manual'], ['legacy', 'Legacy']];
export const TAG_FILTERS = [['all', 'Any tag'], ['5of5', '5/5'], ['4of5', '4/5'], ['3of5', '3/5'], ['manual', 'Manual'], ['scalp', 'Scalp'], ['legacy', 'Legacy'], ['other', 'Other']];

const COHORT_SOURCE = { shadow: 'shadow', core_auto: 'auto', scalp_auto: 'auto', core_manual: 'manual', scalp_manual: 'manual', legacy: 'legacy' };

export function tradeSource(trade) {
  const recorder = researchRecorder(trade);
  if (recorder) return recorder === 'OTHER' ? 'researchOther' : `research${recorder}`;
  const source = COHORT_SOURCE[classifyTradeCohort(trade)];
  return source === 'shadow' ? 'researchOther' : source;
}

const SOURCE_NAMES = { auto: 'Auto', researchA: 'Research A', researchB: 'Research B', researchOther: 'Research · recorder not saved', manual: 'Manual', legacy: 'Legacy' };
export const sourceName = trade => SOURCE_NAMES[tradeSource(trade)] || 'Other';
export const moneyType = trade => (isRealTrade(trade) ? 'Real money' : 'Practice');

// One wording for the pill, so the two recorders cannot be mistaken for two scores.
export function tradeLabel(trade) {
  if (!tradeSource(trade).startsWith('research')) {
    // Saved wording calls ordinary practice trades "research"; only A and B use that word on screen.
    const saved = trade?.strategyTierLabel || trade?.strategyTier || 'Legacy trade';
    return saved.replace(/\bresearch\b/i, isRealTrade(trade) ? '' : 'practice').replace(/\s{2,}/g, ' ').trim();
  }
  const tag = tradeTag(trade);
  return [/^[345]of5$/.test(tag) ? tag.replace('of', '/') : '', sourceName(trade)].filter(Boolean).join(' · ');
}

// The other recorder's record of what looks like the same trade: same option,
// buy price and side, opened within a minute. This is a match, not proof.
export function matchingCopy(trade, rows) {
  const mine = researchRecorder(trade);
  if (mine !== 'A' && mine !== 'B') return null;
  return rows.find(row => {
    const theirs = researchRecorder(row);
    return (theirs === 'A' || theirs === 'B') && theirs !== mine &&
      row.symbol === trade.symbol && row.side === trade.side &&
      Math.abs(Number(row.entry) - Number(trade.entry)) < 0.005 &&
      Math.abs(new Date(row.openedAt).getTime() - new Date(trade.openedAt).getTime()) <= 60000;
  }) || null;
}

// Totals are kept per group and never added across groups.
const TOTAL_GROUPS = [['real', 'Real money'], ['practice', 'Other practice trades · not Research A or B'], ['researchA', 'Research A · practice'], ['researchB', 'Research B · practice'], ['researchOther', 'Research, recorder not saved · practice']];
export function totalGroup(trade) {
  if (isRealTrade(trade)) return 'real';
  const source = tradeSource(trade);
  return source.startsWith('research') ? source : 'practice';
}
export function groupForTotals(rows) {
  const groups = TOTAL_GROUPS.map(([id, label]) => ({ id, label, rows: rows.filter(row => totalGroup(row) === id) })).filter(group => group.rows.length);
  return groups.length ? groups : [{ id: 'practice', label: TOTAL_GROUPS[1][1], rows: [] }];
}

export function isScalpRecord(trade) {
  return trade?.strategyFamily === 'SCALP' || trade?.strategyTier === 'SCALP' || /scalp/i.test(String(trade?.strategyTierLabel || ''));
}

// The strategy tag is the pill shown above the option name.
export function tradeTag(trade) {
  if (isScalpRecord(trade)) return 'scalp';
  const tier = String(trade?.strategyTier || trade?.shadowCohort || '').toUpperCase();
  const label = String(trade?.strategyTierLabel || '');
  if (tier === 'MANUAL' || /manual/i.test(label)) return 'manual';
  const named = label.match(/\b([345])\/5\b/) || tier.match(/^SHADOW_([345])_OF_5$/);
  if (named) return `${named[1]}of5`;
  if (tier === 'FULL') return '5of5';
  if (tier === 'CONTROLLED') return '4of5';
  if (tier === 'EXPERIMENTAL') return '3of5';
  const source = tradeSource(trade);
  if (source === 'legacy') return 'legacy';
  const passed = Number(trade?.entryMandatoryPassCount);
  if (source.startsWith('research') && [3, 4, 5].includes(passed)) return `${passed}of5`;
  return 'other';
}

export function filterJournal(rows, { strategy = 'all', source = 'all', tag = 'all' } = {}) {
  return rows.filter(row =>
    (strategy === 'all' || (strategy === 'scalp') === isScalpRecord(row)) &&
    (source === 'all' || tradeSource(row) === source) &&
    (tag === 'all' || tradeTag(row) === tag));
}
