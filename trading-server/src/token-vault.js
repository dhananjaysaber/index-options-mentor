import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';

export class TokenVault {
  constructor(dataDir, base64Key) {
    this.file = path.join(dataDir, 'fyers-session.enc');
    this.key = decodeKey(base64Key);
    fs.mkdirSync(dataDir, { recursive: true });
  }

  configured() {
    return Boolean(this.key);
  }

  save(session) {
    if (!this.key) throw new Error('TOKEN_ENCRYPTION_KEY is not configured correctly.');
    const iv = crypto.randomBytes(12);
    const cipher = crypto.createCipheriv('aes-256-gcm', this.key, iv);
    const plaintext = Buffer.from(JSON.stringify(session), 'utf8');
    const ciphertext = Buffer.concat([cipher.update(plaintext), cipher.final()]);
    const tag = cipher.getAuthTag();
    const payload = Buffer.concat([iv, tag, ciphertext]).toString('base64url');
    fs.writeFileSync(this.file, payload, { encoding: 'utf8', mode: 0o600 });
  }

  load() {
    if (!this.key || !fs.existsSync(this.file)) return null;
    try {
      const raw = Buffer.from(fs.readFileSync(this.file, 'utf8').trim(), 'base64url');
      if (raw.length < 29) return null;
      const iv = raw.subarray(0, 12);
      const tag = raw.subarray(12, 28);
      const ciphertext = raw.subarray(28);
      const decipher = crypto.createDecipheriv('aes-256-gcm', this.key, iv);
      decipher.setAuthTag(tag);
      return JSON.parse(Buffer.concat([decipher.update(ciphertext), decipher.final()]).toString('utf8'));
    } catch {
      return null;
    }
  }

  clear() {
    try { fs.unlinkSync(this.file); } catch {}
  }
}

function decodeKey(value) {
  if (!value) return null;
  try {
    const key = Buffer.from(value, 'base64');
    return key.length === 32 ? key : null;
  } catch {
    return null;
  }
}
