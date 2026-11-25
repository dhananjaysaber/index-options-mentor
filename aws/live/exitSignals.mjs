import { updateLivePosition } from '../../src/engine/managedPosition.js';
import { derivePositionMentor, deriveScalpPositionMentor } from '../../src/engine/positionMentor.js';
import { isScalpOptionTrailBreached } from '../../src/engine/scalpOptionTrail.js';
import { isCoreOptionTrailBreached } from '../../src/engine/coreOptionTrail.js';
import { isCoreTargetIndexTrailBreached } from '../../src/engine/coreTargetIndexTrail.js';

export function evaluateExit(position, quote, snapshot, nowMs=Date.now()) {
  const at=Date.parse(quote?.at || '');
  const snapshotAt=Date.parse(snapshot?.generatedAt || '');
  const fresh=Number.isFinite(at) && nowMs-at>=-1000 && nowMs-at<=3000;
  if (!fresh || quote?.optionSymbol!==position?.symbol ||
      !Number.isFinite(quote?.optionPrice) || quote.optionPrice<=0 ||
      !Number.isFinite(quote?.nifty) || quote.nifty<=0)
    return {accepted:false,reason:'STALE_OR_MISMATCHED_QUOTE'};
  const previous=Date.parse(position.lastOptionQuoteAt || '');
  if (Number.isFinite(previous) && at<=previous)
    return {accepted:false,reason:'QUOTE_ALREADY_PROCESSED'};
  const next=updateLivePosition(position,quote.optionPrice,quote.nifty,null,quote.at);
  const isScalp=next.strategyFamily==='SCALP';
  // Structural exits do not need a new strategy snapshot. Deterioration does.
  const stopHit=next.side==='CE' ? quote.nifty<=next.underlyingStop : quote.nifty>=next.underlyingStop;
  let reason=stopHit ? 'STRUCTURE_INVALIDATED' : null;
  if (!reason && Number.isFinite(snapshotAt) && nowMs-snapshotAt>=-1000 && nowMs-snapshotAt<=12000) {
    const mentor=isScalp ? deriveScalpPositionMentor(next,snapshot,quote.nifty) : derivePositionMentor(next,snapshot,quote.nifty);
    if(mentor.alertLevel==='exit') reason=mentor.reasonCode;
  }
  if(!reason && isScalp && next.scalpTrailingActive && next.currentR<=next.scalpTrailingFloorR) reason='SCALP_TRAILING_STOP';
  if(!reason && !isScalp && isCoreTargetIndexTrailBreached(next,nowMs)) reason='CORE_TARGET_INDEX_TRAIL';
  if(!reason && !isScalp && isCoreOptionTrailBreached(next,nowMs)) reason='CORE_OPTION_PROFIT_TRAIL';
  if(!reason && isScalp && isScalpOptionTrailBreached(next,nowMs)) reason='SCALP_OPTION_PROFIT_TRAIL';
  return {accepted:true,position:next,exitReason:reason};
}

if(process.argv[1] && import.meta.url===new URL(process.argv[1],'file:').href) {
  let input='';
  for await(const chunk of process.stdin) { input+=chunk; if(input.length>131072) throw Error('INPUT_TOO_LARGE'); }
  const args=JSON.parse(input);
  process.stdout.write(JSON.stringify(evaluateExit(args.position,args.quote,args.snapshot,args.nowMs)));
}
