import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';

export class AuditLog {
  constructor(dataDir) {
    this.file = path.join(dataDir, 'audit.jsonl');
    this.seq = 0;
    this.lastHash = 'GENESIS';
    fs.mkdirSync(dataDir, { recursive: true });
    this.#restoreTail();
  }

  append(type, payload = {}) {
    const event = {
      seq: ++this.seq,
      at: new Date().toISOString(),
      type,
      payload,
      prevHash: this.lastHash
    };
    const canonical = JSON.stringify(event);
    const hash = crypto.createHash('sha256').update(canonical).digest('hex');
    const row = { ...event, hash };
    fs.appendFileSync(this.file, JSON.stringify(row) + '\n', { encoding: 'utf8', mode: 0o600 });
    this.lastHash = hash;
    return row;
  }

  read(limit = 200) {
    if (!fs.existsSync(this.file)) return [];
    const rows = fs.readFileSync(this.file, 'utf8').split('\n').filter(Boolean);
    return rows.slice(-Math.max(1, Math.min(1000, Number(limit) || 200))).map(line => {
      try { return JSON.parse(line); } catch { return null; }
    }).filter(Boolean);
  }

  #restoreTail() {
    const rows = this.read(1);
    if (!rows.length) return;
    const tail = rows[0];
    this.seq = Number(tail.seq) || 0;
    this.lastHash = tail.hash || 'GENESIS';
  }
}
