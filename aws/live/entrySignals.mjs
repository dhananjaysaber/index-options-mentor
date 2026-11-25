// The same production Mentor and Core/Scalp ticket builders used by the app.
import { setTrustedSymbolMaster } from '../../server/mentorBase.js';
import { buildMentorSnapshot } from '../../server/mentor.js';
import { classifyResearchSetup, buildSimulatedTicket, buildManualResearchTicket, tierEnabled } from '../../src/engine/researchStrategy.js';
import { evaluateScalpSetup, buildScalpTicket } from '../../src/engine/scalpStrategy.js';

export async function signals(input) {
  const nowMs=Number(input.nowMs);
  if (!Number.isFinite(nowMs)) throw Error('INVALID_SIGNAL_TIME');
  if(input.symbolLots) setTrustedSymbolMaster(input.symbolLots,input.masterAt);
  const snapshot=await buildMentorSnapshot({...input.market,now:new Date(nowMs)});
  const settings={...input.settings,tradeAmount:input.settings.tradeAmount};
  if(!Number.isFinite(settings.tradeAmount)||settings.tradeAmount<=0)throw Error('AMOUNT_REQUIRED');
  const auto=classifyResearchSetup(snapshot);
  const scalp=evaluateScalpSetup(snapshot,input.threeMinute||[],snapshot?.market?.spot,nowMs);
  const tickets={
    CORE_MANUAL:buildManualResearchTicket(snapshot,settings),
    CORE_AUTO:tierEnabled(auto,settings)?buildSimulatedTicket(snapshot,settings,'MENTOR'):null,
    SCALP_MANUAL:buildScalpTicket(snapshot,scalp,settings,'USER'),
    SCALP_AUTO:buildScalpTicket(snapshot,scalp,settings,'MENTOR')
  };
  for(const [key,ticket] of Object.entries(tickets))if(ticket){
    ticket.strategyFamily=key.startsWith('CORE')?'CORE':'SCALP';
    ticket.mode='LIVE';ticket.executionMode='REAL';
    ticket.hardOptionStop=Number(snapshot?.option?.estimatedPremiumStop);
    // Quantity/entry price in this signal are indicative; the server planner
    // always recomputes whole lots using the fresh shared-socket ask.
  }
  return {snapshot,tickets,generatedAt:new Date(nowMs).toISOString()};
}
if(process.argv[1]&&import.meta.url===new URL(process.argv[1],'file:').href){
  let input='';for await(const chunk of process.stdin){input+=chunk;if(input.length>2000000)throw Error('INPUT_TOO_LARGE');}
  process.stdout.write(JSON.stringify(await signals(JSON.parse(input))));
}
