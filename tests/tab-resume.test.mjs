import test from 'node:test';
import assert from 'node:assert/strict';
import { listenForTabResume } from '../src/services/tabResume.js';

test('background tabs do not refresh; return by tab, window or page does', () => {
  const win = new EventTarget();
  const doc = new EventTarget();
  doc.visibilityState = 'hidden';
  let now = 1000, calls = 0;
  const stop = listenForTabResume({
    window:win, document:doc, now:()=>now, onResume:()=>{calls++;}
  });
  doc.dispatchEvent(new Event('visibilitychange'));
  win.dispatchEvent(new Event('focus'));
  assert.equal(calls,0,'hidden tabs cannot declare a successful live refresh');
  doc.visibilityState = 'visible';
  doc.dispatchEvent(new Event('visibilitychange'));
  win.dispatchEvent(new Event('focus'));
  win.dispatchEvent(new Event('pageshow'));
  assert.equal(calls,1,'near-simultaneous restore events must not make 3 FYERS calls');
  now += 600;
  win.dispatchEvent(new Event('focus'));
  assert.equal(calls,2,'window focus can refresh an already visible tab');
  stop();
  now += 600;
  win.dispatchEvent(new Event('focus'));
  assert.equal(calls,2,'unmounted components must remove listeners');
});

test('a browser-page restoration triggers an independent refresh', () => {
  const win = new EventTarget();
  const doc = new EventTarget();
  doc.visibilityState = 'visible';
  let calls=0;
  const stop=listenForTabResume({
    window:win, document:doc, onResume:()=>{calls++;}
  });
  win.dispatchEvent(new Event('pageshow'));
  assert.equal(calls,1);
  stop();
});
