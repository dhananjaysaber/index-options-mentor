import { mkdir, appendFile } from 'node:fs/promises';
import path from 'node:path';
import crypto from 'node:crypto';
import { tradingConfig } from './config.js';

const SECRET_KEY = /(token|secret|authorization|cookie|password|pin|credential)/i;

export async function appendAuditEvent(type, payload = {}, meta = {}) {
  const config = tradingConfig();
  const directory = path.resolve(config.dataDir);
  await mkdir(directory, { recursive: true });

  const event = {
    eventId: meta.eventId || crypto.randomUUID(),
    at: new Date().toISOString(),
    type: String(type || 'UNKNOWN'),
    mode: config.mode,
    actor: meta.actor || 'server',
    correlationId: meta.correlationId || null,
    payload: redact(payload)
  };

  const file = path.join(directory, 'audit.jsonl');
  await appendFile(file, JSON.stringify(event) + '\n', { encoding: 'utf8', mode: 0o600 });
  return event;
}

function redact(value, seen = new WeakSet()) {
  if (value == null || typeof value !== 'object') return value;
  if (seen.has(value)) return '[Circular]';
  seen.add(value);

  if (Array.isArray(value)) return value.map(item => redact(item, seen));

  const out = {};
  for (const [key, item] of Object.entries(value)) {
    out[key] = SECRET_KEY.test(key) ? '[REDACTED]' : redact(item, seen);
  }
  return out;
}
