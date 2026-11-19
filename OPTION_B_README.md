# Index Options Mentor — Option B (complete replacement files)

This UI-only change is designed for the **Index Options Mentor production PWA**. It does not change Index/Scalp strategies, FYERS Prime timing or paper trading logic.

## What to replace

Copy the included files to the same paths in your Index Options Mentor project:

1. `src/components/MobileMentorDashboardV41.jsx` — show the main chart immediately beneath the compact 13-Point decision card; active positions keep their exit controls above the chart.
2. `src/components/TraderMarketPanel.jsx` — show a single VWAP / ORH / ORL / PDH / PDL / 5m ATR context grid beneath the chart.
3. `src/components/NiftyStrategyChart.jsx` — dynamically fit the candlestick SVG to the phone viewport; preserve 5m/3m switching, live candle feed and structural overlays; optional summary and rule note props.
4. `src/components/CoreResearchPanel.jsx` — remove the verbose “Candidate monitoring is not a trade” paragraph and duplicate NIFTY price card while retaining gates and risk levels.
5. `src/index-compact-v53.css` and `src/index-compact-v54.css` — compact 13-Point and Scalp styling; 430px chart, premium candle colours, fewer oversized cards; no redundant top strategy toggle on either layout.
6. `src/main.jsx` — complete file included with the new CSS imported after `iphone-shell-v52.css`.
7. `public/sw.js` — complete service worker with cache name bumped to `v54-compact-chart-nav` for installed PWA refresh.

No new environment variables, backend changes, FYERS order functions, quote timers or strategy changes.

## Important notes

- **Normal** and **Scalp** remain accessible via bottom Home / Scalp navigation on mobile.
- Desktop users select 13-Point and Scalp from dedicated sidebar links; the redundant top selector is fully removed.
- Normal automatic and manual paper trading, Scalp auto/manual paper trading and trade journalling are unchanged.
- The chart's taller mobile display is purely presentation; the 3-minute timeframe remains a visual option and does not turn the 13-Point entry system into a 3-minute strategy.
- The chart's level lines remain; duplicate numerical level tiles are removed **from the 13-Point chart only**.
- Existing entry safety checks, open-position alerts and manual exit actions remain intact.

## Verify

```sh
npm install
npm test
VITE_FYERS_TIER=prime npm run build
```

A mobile Chromium smoke test can run using `node scripts/verify-iphone-shell.mjs` with Playwright installed.

See [GitHub PR #23](https://github.com/dhananjaysaber/index-options-mentor/pull/23) for the reviewed changes and mobile browser test results.
