import test from 'node:test';
import assert from 'node:assert/strict';
import vm from 'node:vm';
import { readFile } from 'node:fs/promises';
const source = await readFile(new URL('../apps-script/IndexOptionsMentorJournal.gs', import.meta.url), 'utf8');
function fixture() {
  const sheets = new Map();
  function addSheet(name) {
    const rows = [];
    const sheet = {
      rows, getLastRow: () => rows.length,
      appendRow: row => rows.push([...row]), setFrozenRows() {},
      getRange(r, c, h = 1, w = 1) {
        const range = {
          getValues: () => Array.from({ length: h }, (_, i) => Array.from({ length: w }, (_, j) => rows[r - 1 + i]?.[c - 1 + j] ?? '')),
          setValues(values) {
            values.forEach((row, i) => { rows[r - 1 + i] ??= []; row.forEach((value, j) => { rows[r - 1 + i][c - 1 + j] = value; }); });
            return range;
          },
          createTextFinder(target) { return { matchEntireCell: () => ({ findNext: () => {
            const index = rows.findIndex((row, i) => i >= r - 1 && String(row[c - 1]) === target);
            return index < 0 ? null : { getRow: () => index + 1 };
          } }) }; },
          setFontWeight: () => range, setBackground: () => range, setFontColor: () => range, setWrap: () => range
        };
        return range;
      }
    };
    sheets.set(name, sheet); return sheet;
  }
  addSheet('Trades').rows.push(['trade_id', 'status'], ['existing-trade', 'CLOSED']);
  addSheet('TradeJourney').rows.push(['event_id'], ['existing-close']);
  let acquired = 0;
  const context = vm.createContext({
    PropertiesService: { getScriptProperties: () => ({ getProperty: key => key === 'JOURNAL_SHARED_SECRET' ? 'fixture-key' : 'fixture-spreadsheet' }) },
    ContentService: { MimeType: { JSON: 'json' }, createTextOutput: text => ({ setMimeType: () => JSON.parse(text) }) },
    SpreadsheetApp: { openById: id => { assert.equal(id, 'fixture-spreadsheet'); return { getSheetByName: name => sheets.get(name) ?? null, insertSheet: addSheet }; } },
    LockService: { getScriptLock: () => ({ waitLock: () => acquired++, releaseLock: () => acquired-- }) }
  });
  new vm.Script(source).runInContext(context);
  return { sheets, post: payload => context.doPost({ postData: { contents: JSON.stringify(payload) } }), locks: () => acquired };
}
const payload = { action: 'setup_decision', secret: 'fixture-key', setup: {
  id: 'setup-replay', sessionDate: '2026-11-25', side: 'CE', latestScore: 70,
  parameters: [{ id: 'trend', value: .8 }], outcomes: { 5: { nifty: 25000, hypotheticalR: .5 } }
} };
test('setup export replays one setup ID without touching saved trades', () => {
  const { sheets, post, locks } = fixture();
  const savedTrades = JSON.stringify(sheets.get('Trades').rows);
  const savedJourney = JSON.stringify(sheets.get('TradeJourney').rows);
  assert.equal(post(payload).ok, true);
  assert.equal(post({ ...payload, setup: { ...payload.setup, latestScore: 72 } }).ok, true);
  const rows = sheets.get('SetupDecisions').rows;
  assert.equal(rows.length, 2);
  assert.equal(rows[1][rows[0].indexOf('setup_id')], 'setup-replay');
  assert.equal(rows[1][rows[0].indexOf('latest_score')], 72);
  assert.equal(rows[1][rows[0].indexOf('p02_trend_pct')], 80);
  assert.equal(rows[1][rows[0].indexOf('r_5m')], .5);
  assert.equal(JSON.stringify(sheets.get('Trades').rows), savedTrades);
  assert.equal(JSON.stringify(sheets.get('TradeJourney').rows), savedJourney);
  assert.equal(locks(), 0);
});
test('wrong credentials and incomplete decisions cannot create setup rows', () => {
  const { sheets, post } = fixture();
  assert.equal(post({ ...payload, secret: 'wrong' }).ok, false);
  assert.equal(post({ ...payload, setup: { id: 'missing-fields' } }).ok, false);
  assert.equal(sheets.has('SetupDecisions'), false);
});
test('setup updates preserve zero scores and explicit false flags', () => {
  const { sheets, post } = fixture();
  post({ ...payload, setup: { ...payload.setup, approvedAtCapture: true } });
  post({ ...payload, setup: { ...payload.setup, latestScore: 0, approvedAtCapture: false } });
  const rows = sheets.get('SetupDecisions').rows;
  assert.equal(rows.length, 2);
  assert.equal(rows[1][rows[0].indexOf('latest_score')], 0);
  assert.equal(rows[1][rows[0].indexOf('approved_at_capture')], false);
});
