# Mentor AI Paper Lab — isolated research deployment

This branch is independent from `main`. Do **not** merge it into `main` unless explicitly desired. The original Index Options Mentor PWA remains unchanged.

## Release status
This is a **paper-only research prototype**. It uses Claude Sonnet 5.5 to analyse valid FYERS snapshots and propose simulated entries, exits, trailing stops, and no-trade decisions. It has **no live order execution**. Simulated fills use observed LTP quotes rather than broker fills; P&L **excludes fees, slippage and spreads**. It is not a reliable performance backtest without realistic execution costs.

**LIMITATIONS:** The current prototype polls from the browser. Automatic analysis runs every 60 seconds **only while the app is open, visible, and logged into FYERS**. The open-position journal is stored in this browser's localStorage and can be exported as JSON/CSV, but it is not persistent across devices and is not an unattended 24/7 scheduler. A persistent database and always-on market worker are required for unattended paper trading and cross-device records. Before a restart or reinstall, export the journal.

## Netlify deployment (new site only)
1. Open [Mentor AI Paper Lab](https://app.netlify.com/projects/mentor-ai-paper-lab).
2. Under project configuration / Build & deploy / Continuous deployment, **connect a Git repository**. Select `dhananjaysaber/index-options-mentor`, set production branch **`mentor-ai-paper-lab`**, not `main`. The app's `index.html` on this branch points to `src/ai-paper/main.jsx`.
3. Build command: `npm run build`; publish directory: `dist`; functions: `netlify/functions` (provided by this branch's `netlify.toml`).
4. Under **Project configuration → Environment variables**, create:
   - `ANTHROPIC_API_KEY`: your Claude API key (secret; functions scope).
   - `MENTOR_AI_ACCESS_KEY`: your chosen long unique access password (secret; functions scope). Enter the same password in the app to permit Claude calls. Do NOT paste your Claude API key in the browser.
   - `FYERS_APP_ID`: ID for the **separate** AI market-data application.
   - `FYERS_APP_SECRET`: secret for that FYERS app.
   - `FYERS_SESSION_SECRET`: unique random secret for encrypted FYERS authentication session cookies.
   - `FYERS_REDIRECT_URI`: `https://mentor-ai-paper-lab.netlify.app/api/fyers/callback` (set the same callback in the separate FYERS app settings).
   - `TRADING_MODE`: `paper` (already set).
   - `LIVE_ORDER_EXECUTION_ENABLED`: `false` (already set).
5. Deploy from the `mentor-ai-paper-lab` branch. Confirm FYERS Connect works and the second account authorization is valid. Run a Claude analysis only during a live NIFTY session.
6. Never commit secrets or use `VITE_` for any secret. Run real-money trades exclusively through a separately designed and independently tested service, **not** this prototype.

The AI endpoint is `/.netlify/functions/ai-analyze`. It refuses orders and refuses analyses unless both paper-only environment locks exist. It requires a private `MENTOR_AI_ACCESS_KEY` and a fresh live snapshot.

## Architecture
- `src/ai-paper/main.jsx` independent React dashboard
- `src/ai-paper/engine.js` browser paper trade risk simulation
- `src/ai-paper/styles.css` standalone responsive UI
- `netlify/functions/ai-analyze.mjs` server-side Claude integration
- `netlify/functions/fyers.mjs` reused FYERS quote, snapshot and authentication routes

### Future upgrades needed before comparing performance
- Persistent backend positions/journal with idempotent events, crash recovery and immutable decisions.
- Market worker independent of browser visibility (FYERS authentication constraints and timeouts handled).
- Verified news and economic calendar feeds, with dated citations and an event freshness policy.
- Price realism: bid/ask, fill latency, transaction charges, liquidity, spreads and partial fills.
- Test harness: replay, forward paper trading, benchmarks against existing 13-point and scalp cohorts, and model/version attribution.
- Authenticated access to the backend and alerting on data interruptions.
