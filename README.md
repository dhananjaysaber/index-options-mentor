# Index Options Mentor v0.7 — Exit Alerts & Strategy Deterioration

This build keeps the v0.6 live-entry state machine and adds a separate open-position mentor.

## New in v0.7

- `Refresh` renamed to **Refresh now**. Automatic refresh still runs every 15 seconds; the button is only a forced refresh.
- Open-option + NIFTY quote refresh remains every 5 seconds.
- **Enable alerts** control requests browser-notification permission and primes sound alerts.
- Full-width red **ACTION REQUIRED** banner appears for exit conditions.
- Exit alert produces a sound and browser notification when alerts are enabled.
- Position mentor now separates:
  - **HOLD — STRUCTURE INTACT**: normal noise / pullback, no panic exit.
  - **CAUTION**: evidence is weakening but not enough for an early exit.
  - **EXIT RECOMMENDED**: strategy deterioration before the hard stop.
  - **EXIT TRADE**: original structural stop has been invalidated.
  - **PROTECT PROFIT / TARGET ZONE / TARGET REACHED** for favourable positions.
- Position panel now shows **entry score, current score and score change**.

## Strategy-deterioration rule

The mentor does **not** exit merely because the 13-point score falls. Entry-only items such as ORB and retest can become less relevant after entry. An early exit requires directional deterioration such as an opposite live bias together with strong trend/VWAP evidence, multiple core directional gate failures, or multiple red core readings while the trade is under pressure.

The original hard structural stop remains non-negotiable.

## Alerts

Click **Enable alerts** once. The browser may ask permission for notifications.

- Visual exit alerts always work while the dashboard is open.
- Sound alerts require browser audio permission / a user interaction.
- Browser notifications work when permission is granted and the browser supports the Notification API.
- This local version does **not** provide background push if the browser/app is fully closed.

## Run

Copy your existing v0.6 `.env` file into this folder, then:

```bash
npm install
npm run dev
```

Open `http://127.0.0.1:5173` and reconnect FYERS after restarting the local server.

## v0.8 Netlify deployment

For the hosted build, use `NETLIFY-DEPLOY.md`. The FYERS API is served by `netlify/functions/fyers.mjs`, and the login token is kept in an encrypted HttpOnly cookie instead of server memory.
