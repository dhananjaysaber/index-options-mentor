import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { sendJournalWrite } from '../src/services/journalTransport.js';

const { PAPER_TEST_PREVIEW_URL, PAPER_TEST_SHEET_ID, PAPER_TEST_SHEETS_TOKEN } = process.env;
assert.ok(PAPER_TEST_PREVIEW_URL && PAPER_TEST_SHEET_ID && PAPER_TEST_SHEETS_TOKEN,
  'Set the isolated preview URL, test spreadsheet ID and read-only Sheets token.');

const preview = new URL(PAPER_TEST_PREVIEW_URL);
assert.match(preview.hostname, /^deploy-preview-\d+--[a-z0-9-]+\.netlify\.app$/);
assert.equal(preview.protocol, 'https:');
assert.notEqual(preview.hostname, 'deploy-preview-28--optionsmentor.netlify.app',
  'Use a separate test preview. PR #28 currently uses the active journal.');
assert.notEqual(PAPER_TEST_SHEET_ID, '1OWAtRI4c-yTZaR9zbvp9L18qWFLfEE7hjCWGR0oRU2o',
  'Use a separate test spreadsheet.');

const liveFetch = globalThis.fetch;
const journalUrl = new URL('/api/journal', preview);
const sheetsUrl = `https://sheets.googleapis.com/v4/spreadsheets/${encodeURIComponent(PAPER_TEST_SHEET_ID)}`;

async function readJson(url, options) {
  const response = await liveFetch(url, { ...options, signal: AbortSignal.timeout(15000) });
  assert.ok(response.ok, `Request failed with HTTP ${response.status}`);
  return response.json();
}

const sheetOptions = { headers: { Authorization: `Bearer ${PAPER_TEST_SHEETS_TOKEN}` } };
const metadata = await readJson(`${sheetsUrl}?fields=properties(title)`, sheetOptions);
const health = await readJson(new URL('?health=1', journalUrl));
assert.match(metadata.properties.title, /^IOM Paper Replay Test - /);
assert.equal(health.ok, true);
assert.equal(health.spreadsheet, metadata.properties.title,
  'Preview journal and test spreadsheet must report the same dedicated test title.');

const id = randomUUID();
const closedAt = new Date().toISOString();
const event = {
  id: `close:${id}`,
  type: 'TRADE_CLOSED',
  source: 'paper_replay_test',
  queuedAt: closedAt,
  trade: {
    id, mode: 'SIMULATION', status: 'CLOSED', strategyFamily: 'SCALP',
    openedAt: new Date(Date.parse(closedAt) - 60000).toISOString(),
    closedAt, side: 'PE', symbol: 'NSE:NIFTY26NOV25400PE',
    lots: 1, lotSize: 65, quantity: 65, entry: 45, exit: 39.5, pnl: -357.5,
    closedBy: 'AWS_MONITOR', exitMethod: 'AUTO', exitReasonCode: 'SCALP_INDEX_TRAIL',
    executionMode: 'PAPER_ONLY', brokerOrderPlaced: false,
    exitPriceSource: 'OBSERVED_OPTION_QUOTE', awsPaperExit: true
  }
};

globalThis.fetch = (url, options) => {
  assert.equal(url, '/api/journal');
  return liveFetch(journalUrl, { ...options, signal: AbortSignal.timeout(15000) });
};
try {
  for (let delivery = 0; delivery < 2; delivery++) {
    const response = await sendJournalWrite({ action: 'journal_event', event });
    assert.ok(response.ok, `Delivery ${delivery + 1} failed with HTTP ${response.status}`);
    assert.equal((await response.json()).ok, true);
  }
} finally {
  globalThis.fetch = liveFetch;
}

const { values = [] } = await readJson(`${sheetsUrl}/values/Trades!A:BI`, sheetOptions);
const [columns, ...rows] = values;
assert.ok(columns, 'Trade journal has no headers');
const field = name => {
  const index = columns.indexOf(name);
  assert.ok(index >= 0, `Missing journal column: ${name}`);
  return index;
};
const matches = rows.filter(row => row[field('trade_id')] === id);
assert.equal(matches.length, 1, 'Replay must leave exactly one row for the test trade ID');
const [row] = matches;
assert.equal(row[field('status')], 'CLOSED');
assert.equal(row[field('closed_at')], closedAt);
assert.equal(Number(String(row[field('option_exit')]).replace(/[^0-9.]/g, '')), 39.5);
assert.equal(row[field('exit_reason_code')], 'SCALP_INDEX_TRAIL');
assert.equal(JSON.parse(row[field('trade_json')]).closedBy, 'AWS_MONITOR');
console.log(`PASS: two deliveries, one closed Google Sheets row for ${id}`);
