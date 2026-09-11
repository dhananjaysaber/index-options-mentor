const TRADES_SHEET = 'Trades';
const JOURNEY_SHEET = 'TradeJourney';

const TRADE_HEADERS = [
  'trade_id','mode','status','session_date','opened_at','closed_at','held_minutes','side','symbol','strike','expiry',
  'lot_size','lots','quantity','approval_state','entry_score','current_score','exit_score','planned_rr','available_rr_entry',
  'option_entry','option_current','option_exit','option_pnl','underlying_entry','underlying_current','underlying_exit','structural_stop','planned_target',
  'current_r','r_achieved','best_r','worst_r','best_option_price','worst_option_price','exit_reason_code','exit_reason','exit_mentor_state',
  'p01_regime_pct','p02_trend_pct','p03_vwap_pct','p04_risk_room_pct','p05_liquidity_pct','p06_orb_pct','p07_close_5m_pct',
  'p08_retest_pct','p09_pdh_pdl_pct','p10_volume_pct','p11_momentum_pct','p12_htf_15m_pct','p13_time_of_day_pct',
  'vix_entry','pcr_entry','atr5_entry','entry_snapshot_json','last_snapshot_json','exit_snapshot_json','trade_json','source','notes','updated_at'
];

const JOURNEY_HEADERS = [
  'event_id','trade_id','event_time','event_type','status','side','symbol','underlying_price','option_price','r_multiple','best_r','worst_r',
  'mentor_state','reason_code','score','current_bias','regime_pct','trend_pct','vwap_pct','payload_json','source','synced_at'
];

function setupJournalSheets() {
  const ss = SpreadsheetApp.getActiveSpreadsheet();
  PropertiesService.getScriptProperties().setProperty('SPREADSHEET_ID', ss.getId());
  ensureSheet_(ss, TRADES_SHEET, TRADE_HEADERS);
  ensureSheet_(ss, JOURNEY_SHEET, JOURNEY_HEADERS);
  return `Journal ready: ${ss.getName()}`;
}

function generateJournalSecret() {
  const secret = `${Utilities.getUuid().replace(/-/g, '')}${Utilities.getUuid().replace(/-/g, '')}`;
  PropertiesService.getScriptProperties().setProperty('JOURNAL_SHARED_SECRET', secret);
  console.log(`JOURNAL_SHARED_SECRET=${secret}`);
  return secret;
}

function doPost(e) {
  try {
    const payload = JSON.parse((e && e.postData && e.postData.contents) || '{}');
    const expected = PropertiesService.getScriptProperties().getProperty('JOURNAL_SHARED_SECRET');
    if (!expected || payload.secret !== expected) return json_({ ok: false, error: 'Unauthorised journal request.' });

    if (payload.action === 'health') return health_();
    if (payload.action === 'list_trades') return json_({ ok: true, trades: listTrades_(payload.limit || 500) });
    if (payload.action === 'journal_event') return saveJournalEvent_(payload.event);
    return json_({ ok: false, error: 'Unknown journal action.' });
  } catch (error) {
    return json_({ ok: false, error: error && error.message ? error.message : 'Journal error.' });
  }
}

function health_() {
  const ss = getSpreadsheet_();
  const trades = ss.getSheetByName(TRADES_SHEET);
  const journey = ss.getSheetByName(JOURNEY_SHEET);
  return json_({
    ok: true,
    spreadsheet: ss.getName(),
    trades: Math.max(0, (trades ? trades.getLastRow() : 1) - 1),
    events: Math.max(0, (journey ? journey.getLastRow() : 1) - 1)
  });
}

function saveJournalEvent_(event) {
  if (!event || !event.id || !event.type || !event.trade || !event.trade.id) {
    return json_({ ok: false, error: 'Journal event is incomplete.' });
  }

  const lock = LockService.getScriptLock();
  lock.waitLock(10000);
  try {
    const ss = getSpreadsheet_();
    const trades = ensureSheet_(ss, TRADES_SHEET, TRADE_HEADERS);
    const journey = ensureSheet_(ss, JOURNEY_SHEET, JOURNEY_HEADERS);
    upsertTrade_(trades, event);
    appendJourney_(journey, event);
    return json_({ ok: true, tradeId: event.trade.id, eventId: event.id });
  } finally {
    lock.releaseLock();
  }
}

function upsertTrade_(sheet, event) {
  const trade = event.trade || {};
  const snapshot = event.type === 'TRADE_CLOSED' ? trade.exitSnapshot : null;
  const entrySnapshot = trade.entrySnapshot || {};
  const entryParams = trade.parameterSnapshot || entrySnapshot.parameters || [];
  const currentParams = snapshot && snapshot.parameters ? snapshot.parameters : [];

  const patch = {
    trade_id: trade.id,
    mode: trade.mode || 'SIMULATION',
    status: event.type === 'TRADE_CLOSED' ? 'CLOSED' : 'OPEN',
    session_date: trade.entryMarket && trade.entryMarket.sessionDate ? trade.entryMarket.sessionDate : datePart_(trade.openedAt),
    opened_at: trade.openedAt || '',
    closed_at: trade.closedAt || '',
    held_minutes: number_(trade.heldMinutes),
    side: trade.side || '',
    symbol: trade.symbol || '',
    strike: number_(trade.strike),
    expiry: trade.expiry || '',
    lot_size: number_(trade.lotSize),
    lots: number_(trade.lots),
    quantity: number_(trade.quantity),
    approval_state: trade.approvalState || (trade.entryDecision && trade.entryDecision.state) || '',
    entry_score: number_(trade.score),
    current_score: number_(snapshot && snapshot.decision ? snapshot.decision.score : trade.entryDecision && trade.entryDecision.score),
    exit_score: event.type === 'TRADE_CLOSED' ? number_(snapshot && snapshot.decision ? snapshot.decision.score : '') : undefined,
    planned_rr: number_(trade.rr),
    available_rr_entry: number_(trade.entryDecision && trade.entryDecision.availableRR),
    option_entry: number_(trade.entry),
    option_current: number_(trade.currentPrice),
    option_exit: number_(trade.exit),
    option_pnl: number_(trade.pnl),
    underlying_entry: number_(trade.underlyingEntry),
    underlying_current: number_(trade.underlyingCurrent),
    underlying_exit: number_(trade.underlyingExit),
    structural_stop: number_(trade.underlyingStop),
    planned_target: number_(trade.underlyingTarget),
    current_r: number_(trade.currentR),
    r_achieved: number_(trade.rAchieved),
    best_r: number_(trade.bestR),
    worst_r: number_(trade.worstR),
    best_option_price: number_(trade.bestOptionPrice),
    worst_option_price: number_(trade.worstOptionPrice),
    exit_reason_code: trade.exitReasonCode || '',
    exit_reason: trade.exitReason || '',
    exit_mentor_state: trade.exitMentorState || '',
    p01_regime_pct: pct_(paramValue_(entryParams, 'chop')),
    p02_trend_pct: pct_(paramValue_(entryParams, 'trend')),
    p03_vwap_pct: pct_(paramValue_(entryParams, 'vwap')),
    p04_risk_room_pct: pct_(paramValue_(entryParams, 'risk')),
    p05_liquidity_pct: pct_(paramValue_(entryParams, 'liquidity')),
    p06_orb_pct: pct_(paramValue_(entryParams, 'orb')),
    p07_close_5m_pct: pct_(paramValue_(entryParams, 'close')),
    p08_retest_pct: pct_(paramValue_(entryParams, 'retest')),
    p09_pdh_pdl_pct: pct_(paramValue_(entryParams, 'pd')),
    p10_volume_pct: pct_(paramValue_(entryParams, 'volume')),
    p11_momentum_pct: pct_(paramValue_(entryParams, 'momentum')),
    p12_htf_15m_pct: pct_(paramValue_(entryParams, 'htf')),
    p13_time_of_day_pct: pct_(paramValue_(entryParams, 'time')),
    vix_entry: number_(trade.entryMarket && trade.entryMarket.vix),
    pcr_entry: number_(trade.entryMarket && trade.entryMarket.putCallOiRatio),
    atr5_entry: number_(trade.entryMarket && trade.entryMarket.atr5),
    entry_snapshot_json: event.type === 'TRADE_OPENED' ? safeJson_(entrySnapshot) : undefined,
    last_snapshot_json: safeJson_({ parameters: currentParams, market: snapshot && snapshot.market, decision: snapshot && snapshot.decision }),
    exit_snapshot_json: event.type === 'TRADE_CLOSED' ? safeJson_(snapshot || {}) : undefined,
    trade_json: safeJson_(trade),
    source: event.source || 'mentor',
    notes: trade.notes || '',
    updated_at: event.queuedAt || new Date().toISOString()
  };

  const row = findTradeRow_(sheet, trade.id);
  const existing = row > 1 ? objectFromRow_(TRADE_HEADERS, sheet.getRange(row, 1, 1, TRADE_HEADERS.length).getValues()[0]) : {};
  const merged = TRADE_HEADERS.map(header => hasValue_(patch[header]) ? patch[header] : (existing[header] !== undefined ? existing[header] : ''));

  if (row > 1) sheet.getRange(row, 1, 1, TRADE_HEADERS.length).setValues([merged]);
  else sheet.appendRow(merged);
}

function appendJourney_(sheet, event) {
  if (findEventRow_(sheet, event.id) > 1) return;

  const trade = event.trade || {};
  const snapshot = trade.exitSnapshot || {};
  const params = snapshot.parameters || [];
  const row = {
    event_id: event.id,
    trade_id: trade.id,
    event_time: event.queuedAt || new Date().toISOString(),
    event_type: event.type,
    status: event.type === 'TRADE_CLOSED' ? 'CLOSED' : 'OPEN',
    side: trade.side || '',
    symbol: trade.symbol || '',
    underlying_price: number_(trade.underlyingCurrent != null ? trade.underlyingCurrent : trade.underlyingExit),
    option_price: number_(trade.currentPrice != null ? trade.currentPrice : trade.exit),
    r_multiple: number_(trade.currentR != null ? trade.currentR : trade.rAchieved),
    best_r: number_(trade.bestR),
    worst_r: number_(trade.worstR),
    mentor_state: trade.exitMentorState || '',
    reason_code: trade.exitReasonCode || '',
    score: number_(snapshot.decision && snapshot.decision.score),
    current_bias: snapshot.decision && snapshot.decision.side ? snapshot.decision.side : '',
    regime_pct: pct_(paramValue_(params, 'chop')),
    trend_pct: pct_(paramValue_(params, 'trend')),
    vwap_pct: pct_(paramValue_(params, 'vwap')),
    payload_json: safeJson_(trade),
    source: event.source || 'mentor',
    synced_at: new Date().toISOString()
  };
  sheet.appendRow(JOURNEY_HEADERS.map(header => row[header] !== undefined && row[header] !== null ? row[header] : ''));
}

function listTrades_(limit) {
  const sheet = getSpreadsheet_().getSheetByName(TRADES_SHEET);
  if (!sheet || sheet.getLastRow() < 2) return [];

  const rows = sheet.getRange(2, 1, sheet.getLastRow() - 1, TRADE_HEADERS.length).getValues();
  return rows
    .map(values => objectFromRow_(TRADE_HEADERS, values))
    .filter(row => row.trade_id && String(row.status).toUpperCase() === 'CLOSED' && row.closed_at)
    .sort((a, b) => new Date(b.closed_at).getTime() - new Date(a.closed_at).getTime())
    .slice(0, Math.max(1, Math.min(1000, Number(limit) || 500)))
    .map(row => ({
      id: row.trade_id,
      openedAt: iso_(row.opened_at),
      closedAt: iso_(row.closed_at),
      heldMinutes: number_(row.held_minutes),
      side: row.side,
      symbol: row.symbol,
      strike: number_(row.strike),
      expiry: row.expiry,
      lotSize: number_(row.lot_size),
      lots: number_(row.lots),
      quantity: number_(row.quantity),
      approvalState: row.approval_state,
      score: number_(row.entry_score),
      rr: number_(row.planned_rr),
      entry: number_(row.option_entry),
      exit: number_(row.option_exit),
      currentPrice: number_(row.option_exit),
      underlyingEntry: number_(row.underlying_entry),
      underlyingExit: number_(row.underlying_exit),
      underlyingCurrent: number_(row.underlying_exit),
      underlyingStop: number_(row.structural_stop),
      underlyingTarget: number_(row.planned_target),
      pnl: number_(row.option_pnl),
      rAchieved: number_(row.r_achieved),
      bestR: number_(row.best_r),
      worstR: number_(row.worst_r),
      bestOptionPrice: number_(row.best_option_price),
      worstOptionPrice: number_(row.worst_option_price),
      exitReasonCode: row.exit_reason_code,
      exitReason: row.exit_reason,
      exitMentorState: row.exit_mentor_state
    }));
}

function ensureSheet_(ss, name, headers) {
  let sheet = ss.getSheetByName(name);
  if (!sheet) sheet = ss.insertSheet(name);
  const current = sheet.getRange(1, 1, 1, headers.length).getValues()[0];
  const matches = headers.every((header, index) => current[index] === header);
  if (!matches) sheet.getRange(1, 1, 1, headers.length).setValues([headers]);
  sheet.setFrozenRows(1);
  sheet.getRange(1, 1, 1, headers.length)
    .setFontWeight('bold')
    .setBackground('#102239')
    .setFontColor('#ffffff')
    .setWrap(true);
  return sheet;
}

function getSpreadsheet_() {
  const id = PropertiesService.getScriptProperties().getProperty('SPREADSHEET_ID');
  if (!id) throw new Error('Run setupJournalSheets() once from the bound spreadsheet.');
  return SpreadsheetApp.openById(id);
}

function findTradeRow_(sheet, tradeId) {
  if (sheet.getLastRow() < 2) return -1;
  const match = sheet.getRange(2, 1, sheet.getLastRow() - 1, 1).createTextFinder(String(tradeId)).matchEntireCell(true).findNext();
  return match ? match.getRow() : -1;
}

function findEventRow_(sheet, eventId) {
  if (sheet.getLastRow() < 2) return -1;
  const match = sheet.getRange(2, 1, sheet.getLastRow() - 1, 1).createTextFinder(String(eventId)).matchEntireCell(true).findNext();
  return match ? match.getRow() : -1;
}

function objectFromRow_(headers, values) {
  const obj = {};
  headers.forEach((header, index) => obj[header] = values[index]);
  return obj;
}

function paramValue_(rows, id) {
  const row = Array.isArray(rows) ? rows.find(item => item && item.id === id) : null;
  return row ? row.value : '';
}

function pct_(value) {
  const n = Number(value);
  return Number.isFinite(n) ? Math.round(n * 10000) / 100 : '';
}

function number_(value) {
  if (value === '' || value === null || value === undefined) return '';
  const n = Number(value);
  return Number.isFinite(n) ? n : '';
}

function hasValue_(value) {
  return value !== undefined && value !== null && value !== '';
}

function safeJson_(value) {
  if (!value || (typeof value === 'object' && Object.keys(value).length === 0)) return '';
  const text = JSON.stringify(value);
  return text.length > 48000 ? `${text.slice(0, 47950)}…` : text;
}

function datePart_(value) {
  if (!value) return '';
  const d = new Date(value);
  return isNaN(d.getTime()) ? '' : Utilities.formatDate(d, 'Asia/Kolkata', 'yyyy-MM-dd');
}

function iso_(value) {
  if (!value) return '';
  if (value instanceof Date) return value.toISOString();
  return String(value);
}

function json_(payload) {
  return ContentService.createTextOutput(JSON.stringify(payload)).setMimeType(ContentService.MimeType.JSON);
}
