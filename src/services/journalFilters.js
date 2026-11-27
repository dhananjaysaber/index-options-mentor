// Journal-screen filtering only. It reads saved records and never changes them.
// "Source" uses the same grouping as the Analysis page, so both pages agree.
import { classifyTradeCohort } from './researchAnalysis.js';

export const STRATEGY_FILTERS = [['all', 'All'], ['core', '13-point'], ['scalp', 'Scalp']];
export const SOURCE_FILTERS = [['all', 'Any source'], ['auto', 'Auto'], ['shadow', 'Shadow'], ['manual', 'Manual'], ['legacy', 'Legacy']];
export const TAG_FILTERS = [['all', 'Any tag'], ['5of5', '5/5'], ['4of5', '4/5'], ['3of5', '3/5'], ['manual', 'Manual'], ['scalp', 'Scalp'], ['legacy', 'Legacy'], ['other', 'Other']];

const COHORT_SOURCE = { shadow: 'shadow', core_auto: 'auto', scalp_auto: 'auto', core_manual: 'manual', scalp_manual: 'manual', legacy: 'legacy' };

export function tradeSource(trade) {
  return COHORT_SOURCE[classifyTradeCohort(trade)];
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
  if (source === 'shadow' && [3, 4, 5].includes(passed)) return `${passed}of5`;
  return 'other';
}

export function filterJournal(rows, { strategy = 'all', source = 'all', tag = 'all' } = {}) {
  return rows.filter(row =>
    (strategy === 'all' || (strategy === 'scalp') === isScalpRecord(row)) &&
    (source === 'all' || tradeSource(row) === source) &&
    (tag === 'all' || tradeTag(row) === tag));
}
