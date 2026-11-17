# Stock Scanner preview

The feature branch CI checks and builds the preview and uploads an artifact. The production Pages workflow only publishes source main.

For an interactive preview, use a **separate Netlify project** with `feature/stock-scanner` as its production branch. The preview uses Netlify for both the UI and the backend. Leave `VITE_API_BASE` unset so requests stay on that origin.

- Set `VITE_STOCK_SCANNER_ENABLED=true` at build time and `STOCK_SCANNER_ENABLED=true` for functions.
- Configure the preview's FYERS data app, its own session secret, and register the preview origin's `/api/fyers/callback` as its redirect URI. Use a data-only app. Set `FYERS_REDIRECT_URI` to that exact URL.
- Use a **separate test Sheet and Apps Script deployment** with the current journal script and separate `JOURNAL_WEB_APP_URL` and `JOURNAL_SHARED_SECRET`. Never copy the production journal environment into the preview.
- Protect access to the preview site before adding credentials. Test during an NSE session with the live app idle until the preview's FYERS traffic is measured. FYERS quotas can be shared even between deployments. Scanner caching and cooldown are per function instance.
- Stock Scanner runs while its tab is open and visible. It records its recommendations locally and uses the existing trade journal outbox for manually opened and closed simulated positions. Exits use a fresh displayed bid and positions remain in browser storage if you navigate away. Verify closed entries can be restored from the test Sheet.
- Prices and depth are indicative. Paper P&L excludes fees and extra slippage; the ranking uses a flat ₹100 illustrative allowance and a delta estimate. Watchlist and thresholds are initial research settings.
- Compare the two existing index modes on identical market fixtures before merging, and verify the scanner stays disabled with the production environment.
