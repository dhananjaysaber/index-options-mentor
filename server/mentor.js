export {
  LIVE_PARAMETERS,
  dateKeyIST,
  dateDaysAgoIST,
  marketPhase,
  cleanCandles,
  resolveSetupStage
} from './mentorBase.js';

import { buildMentorSnapshot as buildAdaptiveMentorSnapshot } from './mentorAdaptive.js';

export async function buildMentorSnapshot(input) {
  const snapshot = await buildAdaptiveMentorSnapshot(input);
  if (!snapshot?.decision) return snapshot;

  return {
    ...snapshot,
    decision: {
      ...snapshot.decision,
      // mentorAdaptive historically returned option.lotSize here because the final
      // && operand was numeric. Normalise it to an actual boolean so the research
      // auto-open classifier can recognise FULL approvals reliably.
      canSuggestTrade: Boolean(snapshot.decision.canSuggestTrade)
    }
  };
}
