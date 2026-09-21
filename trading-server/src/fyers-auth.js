import crypto from 'node:crypto';

const API_BASE = 'https://api-t1.fyers.in/api/v3';

export class FyersAuth {
  constructor({ config, vault, audit, state }) {
    this.config = config;
    this.vault = vault;
    this.audit = audit;
    this.state = state;
  }

  configured() {
    const f = this.config;
    return Boolean(
      f.appId &&
      f.appSecret &&
      f.redirectUri &&
      f.frontendReturnUrl &&
      f.stateSigningSecret &&
      this.vault.configured()
    );
  }

  status() {
    const session = this.vault.load();
    return {
      configured: this.configured(),
      authenticated: Boolean(session?.accessToken),
      sessionCreatedAt: session?.createdAt || '',
      redirectUri: this.config.redirectUri || ''
    };
  }

  createLoginUrl() {
    if (!this.configured()) throw new Error('FYERS authentication is not configured.');
    const url = new URL(`${API_BASE}/generate-authcode`);
    url.searchParams.set('client_id', this.config.appId);
    url.searchParams.set('redirect_uri', this.config.redirectUri);
    url.searchParams.set('response_type', 'code');
    url.searchParams.set('state', this.#makeState());
    this.audit.append('FYERS_LOGIN_STARTED', { redirectUri: this.config.redirectUri });
    return url.toString();
  }

  async completeCallback(authCode, stateValue) {
    if (!this.configured()) throw new Error('FYERS authentication is not configured.');
    this.#verifyState(stateValue);

    const appIdHash = crypto
      .createHash('sha256')
      .update(`${this.config.appId}:${this.config.appSecret}`)
      .digest('hex');

    const response = await fetch(`${API_BASE}/validate-authcode`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        grant_type: 'authorization_code',
        appIdHash,
        code: authCode
      })
    });

    const data = await response.json().catch(() => ({}));
    if (!response.ok || data?.s !== 'ok' || !data?.access_token) {
      this.audit.append('FYERS_LOGIN_REJECTED', {
        status: response.status,
        code: data?.code || null,
        message: data?.message || 'Token exchange failed'
      });
      throw new Error('FYERS login could not be completed.');
    }

    this.vault.save({
      accessToken: data.access_token,
      refreshToken: data.refresh_token || '',
      createdAt: new Date().toISOString()
    });
    this.state.setBrokerState({ connected: true });
    this.audit.append('FYERS_LOGIN_COMPLETED', { hasRefreshToken: Boolean(data.refresh_token) });
    return this.config.frontendReturnUrl;
  }

  logout() {
    this.vault.clear();
    this.state.setBrokerState({ connected: false });
    this.audit.append('FYERS_SESSION_CLEARED');
  }

  accessToken() {
    return this.vault.load()?.accessToken || '';
  }

  #makeState() {
    const payload = Buffer.from(JSON.stringify({
      nonce: crypto.randomBytes(16).toString('hex'),
      exp: Date.now() + 10 * 60 * 1000
    })).toString('base64url');
    const signature = crypto.createHmac('sha256', this.config.stateSigningSecret).update(payload).digest('base64url');
    return `${payload}.${signature}`;
  }

  #verifyState(value) {
    const [payload, signature] = String(value || '').split('.');
    if (!payload || !signature) throw new Error('FYERS OAuth state is missing.');

    const expected = crypto.createHmac('sha256', this.config.stateSigningSecret).update(payload).digest('base64url');
    const a = Buffer.from(signature);
    const b = Buffer.from(expected);
    if (a.length !== b.length || !crypto.timingSafeEqual(a, b)) throw new Error('FYERS OAuth state is invalid.');

    const parsed = JSON.parse(Buffer.from(payload, 'base64url').toString('utf8'));
    if (!Number.isFinite(parsed?.exp) || parsed.exp < Date.now()) throw new Error('FYERS OAuth state has expired.');
  }
}
