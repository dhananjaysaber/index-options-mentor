import test from 'node:test';
import assert from 'node:assert/strict';
import { updateLivePosition } from '../src/engine/managedPosition.js';
import { isScalpOptionTrailBreached } from '../src/engine/scalpOptionTrail.js';
import { isCoreTargetIndexTrailBreached } from '../src/engine/coreTargetIndexTrail.js';
const start=Date.parse('2026-11-25T05:00:00Z'),at=n=>new Date(start+n).toISOString();
const base={entry:100,quantity:65,side:'PE',underlyingEntry:25000,underlyingStop:25100,underlyingTarget:24900};
test('shared Scalp updater retains its observed profit floor through a pullback',()=>{
  const peak=updateLivePosition({...base,strategyFamily:'SCALP'},105,25000,null,at(0));
  assert.equal(peak.optionTrailingFloorPnl,162.5);
  const pullback=updateLivePosition(peak,101,25000,null,at(1000));
  assert.equal(pullback.optionTrailingFloorPnl,162.5);assert.equal(pullback.peakUnrealizedPnl,325);
  assert.equal(isScalpOptionTrailBreached(pullback,start+1000),true);
});
test('shared Core updater preserves the target runner and fresh quote exit',()=>{
  const peak=updateLivePosition({...base,strategyFamily:'CORE'},110,24800,null,at(0));
  assert.equal(peak.coreTargetIndexTrailStop,24850);
  const pullback=updateLivePosition(peak,109,24870,null,at(1000));
  assert.equal(pullback.coreTargetIndexTrailStop,24850);
  assert.equal(isCoreTargetIndexTrailBreached(pullback,start+1000),true);
});
test('missing option data cannot make a saved option quote fresh',()=>{
  const initial=updateLivePosition({...base,strategyFamily:'SCALP'},105,25000,null,at(0));
  const next=updateLivePosition(initial,NaN,24950,null,at(10000));
  assert.equal(next.lastOptionQuoteAt,at(0));assert.equal(next.lastUnderlyingQuoteAt,at(10000));
  assert.equal(next.currentPrice,105);assert.equal(isScalpOptionTrailBreached(next,start+10000),false);
});
