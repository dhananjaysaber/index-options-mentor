import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {createLiveFeedPublisher,readLiveSubscriptions,mergeLiveSubscriptions} from '../aws/live/liveFeedPublisher.mjs';
const S='NSE:NIFTYTEST25450PE';
test('subscriptions exclude stale/foreign symbols and retain requested live options', () => {
  const root=fs.mkdtempSync(path.join(os.tmpdir(),'iom-feed-'));
  try {
    const file=path.join(root,'subscriptions.json');
    const write=data => fs.writeFileSync(file,JSON.stringify(data),{mode:0o600});
    write({version:1,at:100000,symbols:[S]});
    assert.deepEqual(readLiveSubscriptions(root,101000),[S]);
    assert.deepEqual(readLiveSubscriptions(root,116000),[]);
    assert.deepEqual(mergeLiveSubscriptions({subscribe:[],unsubscribe:[S]},new Set([S]),[S]),{subscribe:[],unsubscribe:[]});
    write({version:1,at:100000,symbols:['NSE:RELIANCE-EQ']});
    assert.deepEqual(readLiveSubscriptions(root,101000),[]);
  } finally {fs.rmSync(root,{recursive:true,force:true});}
});
test('publishes only matching fresh packet data; disconnection clears cached prices', () => {
  const root=fs.mkdtempSync(path.join(os.tmpdir(),'iom-feed-'));
  try {
    const now=Date.now(),at=new Date(now).toISOString();
    fs.writeFileSync(path.join(root,'subscriptions.json'),JSON.stringify({version:1,at:now,symbols:[S]}),{mode:0o600});
    const p=createLiveFeedPublisher({root,now:()=>now});p.status(true);
    assert.equal(p.accept(S,{price:230,timestamp:new Date(now-4000).toISOString()},{bid_price:230,ask_price:231}),false);
    assert.equal(p.accept(S,{price:230,timestamp:at},{bid_price:232,ask_price:231}),true);p.flush();
    let result=JSON.parse(fs.readFileSync(path.join(root,'quotes.json')));
    assert.equal(result.quotes[0].bid,undefined);
    assert.equal(p.accept(S,{price:230,timestamp:at},{bid_price:230,ask_price:231}),true);p.flush();
    result=JSON.parse(fs.readFileSync(path.join(root,'quotes.json')));assert.equal(result.quotes[0].ask,231);
    p.status(false);result=JSON.parse(fs.readFileSync(path.join(root,'quotes.json')));
    assert.equal(result.connected,false);assert.deepEqual(result.quotes,[]);
  } finally {fs.rmSync(root,{recursive:true,force:true});}
});
