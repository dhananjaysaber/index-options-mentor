import { DatabaseSync } from 'node:sqlite';
import { mkdirSync } from 'node:fs';
import { dirname } from 'node:path';
import crypto from 'node:crypto';

function encryptionKey() {
  const secret = process.env.FYERS_SESSION_SECRET || '';
  if (secret.length < 24) throw new Error('FYERS_SESSION_SECRET must be at least 24 characters.');
  return crypto.createHash('sha256').update('mentor-ai-autonomous-paper-token:' + secret).digest();
}

function seal(text) {
  const iv = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv('aes-256-gcm', encryptionKey(), iv);
  const body = Buffer.concat([cipher.update(String(text), 'utf8'), cipher.final()]);
  return Buffer.concat([iv, cipher.getAuthTag(), body]).toString('base64url');
}

function open(payload) {
  if (!payload) return '';
  try {
    const bytes = Buffer.from(payload, 'base64url');
    const decipher = crypto.createDecipheriv('aes-256-gcm', encryptionKey(), bytes.subarray(0, 12));
    decipher.setAuthTag(bytes.subarray(12, 28));
    return Buffer.concat([decipher.update(bytes.subarray(28)), decipher.final()]).toString('utf8');
  } catch { return ''; }
}

export class AiPaperStore {
  constructor(file) {
    if (!file || file === ':memory:' ? false : true) mkdirSync(dirname(file), { recursive: true });
    this.db = new DatabaseSync(file || './var/mentor-ai-paper.sqlite');
    this.db.exec(`
      PRAGMA journal_mode=WAL;
      PRAGMA busy_timeout=5000;
      CREATE TABLE IF NOT EXISTS settings (key TEXT PRIMARY KEY, value TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS positions (id TEXT PRIMARY KEY, payload TEXT NOT NULL, opened_at TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS completed (id TEXT PRIMARY KEY, payload TEXT NOT NULL, closed_at TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS decisions (id TEXT PRIMARY KEY, at TEXT NOT NULL, type TEXT NOT NULL, payload TEXT NOT NULL);
      CREATE INDEX IF NOT EXISTS idx_decisions_at ON decisions(at DESC);
      CREATE INDEX IF NOT EXISTS idx_completed_at ON completed(closed_at DESC);
    `);
    this.putSetting('schema_version','1');
  }
  close() { this.db.close(); }
  getSetting(key, fallback=null) {
    const value = this.db.prepare('SELECT value FROM settings WHERE key=?').get(key);
    if (!value) return fallback;
    try { return JSON.parse(value.value); } catch { return fallback; }
  }
  putSetting(key, value) {
    this.db.prepare('INSERT INTO settings(key,value) VALUES(?,?) ON CONFLICT(key) DO UPDATE SET value=excluded.value').run(key,JSON.stringify(value));
  }
  setBrokerToken(token) {
    if (!token || typeof token !== 'string' || token.length > 12000) throw new Error('Invalid FYERS access token.');
    this.putSetting('fyers_access_token_encrypted',seal(token));
    this.putSetting('fyers_connected_at',new Date().toISOString());
  }
  getBrokerToken() { return open(this.getSetting('fyers_access_token_encrypted','')); }
  clearBrokerToken() { this.putSetting('fyers_access_token_encrypted',''); }
  getOpen() { return this.db.prepare('SELECT payload FROM positions ORDER BY opened_at').all().map(row=>JSON.parse(row.payload)); }
  getClosed(limit=500) { return this.db.prepare('SELECT payload FROM completed ORDER BY closed_at DESC LIMIT ?').all(Math.min(2000,Math.max(1,limit))).map(row=>JSON.parse(row.payload)); }
  getDecisions(limit=200) { return this.db.prepare('SELECT payload FROM decisions ORDER BY at DESC LIMIT ?').all(Math.min(5000,Math.max(1,limit))).map(row=>JSON.parse(row.payload)); }
  hasRecentSetup(key, sinceMs) {
    const rows=this.db.prepare('SELECT payload FROM decisions WHERE type=? AND at>=? ORDER BY at DESC LIMIT 50').all('PAPER_ENTRY',new Date(sinceMs).toISOString());
    return rows.some(row=>{try{return JSON.parse(row.payload)?.entryKey===key}catch{return false}});
  }
  event(type, data={}) {
    const row = {id:crypto.randomUUID(),at:new Date().toISOString(),type,...data};
    this.db.prepare('INSERT INTO decisions(id,at,type,payload) VALUES(?,?,?,?)').run(row.id,row.at,row.type,JSON.stringify(row));
    return row;
  }
  save(openPositions, completed=[], events=[]) {
    this.db.exec('BEGIN IMMEDIATE');
    try {
      // One consistent, restart-safe snapshot of active positions.
      this.db.exec('DELETE FROM positions');
      const insert=this.db.prepare('INSERT INTO positions(id,payload,opened_at) VALUES(?,?,?)');
      for(const p of openPositions)insert.run(p.id,JSON.stringify(p),p.openedAt);
      const close=this.db.prepare('INSERT OR IGNORE INTO completed(id,payload,closed_at) VALUES(?,?,?)');
      for(const p of completed)close.run(p.id,JSON.stringify(p),p.closedAt);
      const append=this.db.prepare('INSERT INTO decisions(id,at,type,payload) VALUES(?,?,?,?)');
      for(const event of events){const e={id:crypto.randomUUID(),at:new Date().toISOString(),...event};append.run(e.id,e.at,e.type,JSON.stringify(e));}
      this.db.exec('COMMIT');
    } catch(error){this.db.exec('ROLLBACK');throw error}
  }
}
