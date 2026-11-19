import test from 'node:test';
import assert from 'node:assert/strict';
import React from 'react';
import { renderToString } from 'react-dom/server';
import { createServer } from 'vite';

// A Vite-transformed React render catches runtime errors that npm build alone
// cannot detect (the Stock release previously built but loaded a white screen).
test('production Index app renders both Normal and Scalp shells without runtime crash', async () => {
  const originalStorage = globalThis.localStorage;
  const items = new Map();
  globalThis.localStorage = {
    getItem: key => items.has(key) ? items.get(key) : null,
    setItem: (key, value) => items.set(key, String(value)),
    removeItem: key => items.delete(key)
  };
  let vite;
  try {
    vite = await createServer({
      configFile: new URL('../vite.config.js', import.meta.url).pathname,
      server: { middlewareMode: true },
      appType: 'custom',
      logLevel: 'error'
    });
    const { default: AppV3 } = await vite.ssrLoadModule('/src/AppV3.jsx');
    for (const strategy of ['core', 'scalp']) {
      items.set('index-options-mentor-strategy-mode-v1', strategy);
      const html = renderToString(React.createElement(AppV3));
      assert.match(html, /Index Options Mentor/, strategy + ' should mount');
      assert.match(html, /Normal/, strategy + ' Normal tab should exist');
      assert.match(html, /Scalp/, strategy + ' Scalp tab should exist');
      assert.doesNotMatch(html, /Stock Options Mentor|stock-scanner/, 'Stock UI must be absent');
    }
  } finally {
    if (vite) await vite.close();
    globalThis.localStorage = originalStorage;
  }
});
