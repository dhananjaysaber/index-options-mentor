# Approved mobile and desktop design integration

Based on Jay's supplied `Index_Options_Mentor_Design_Mobile_and_Desktop.zip`, dated 25 November 2026, on top of live-execution commit `69a06f5534ad7ca51cd37e3ee46d19c2e6a26e1b`.

The archive is a static design handoff with sample prices, positions, scores and trades. Those samples are not imported into application state, the journal or a production API. Existing React components continue to read the existing props and use the existing handlers.

## Presentation

- Dark background #0B0E13, cards #121823, borders #1F2733, text #E8ECF3, secondary #9AA3B2, green #2ECC8F, red #FF5C6C, blue #5B8CFF and amber #F5B84B.
- Compact desktop navigation rail, real-data market header, chart/review columns and compact checklist.
- Five mobile destinations (Trade, Scalp, Positions, Journal, Settings), safe-area padding and action controls above navigation.
- Compact chart-first mobile strategy pages and responsive open-position, journal, analysis and Settings presentation.
- Desktop journal row presentation retains expandable full details and existing analysis actions.
- Paper positions are explicitly labelled PAPER; a text-only copy remains a text-only copy. Broker OFF/unknown status and prepared-but-unpurchased plans remain distinct.
- Light mode remains available using a corresponding accessible palette. No third-party font request is required.

`src/premium-design-v60.css` is the last presentation layer and replaces the obsolete desktop-v6 import. `PremiumMarketTicker.jsx` is presentational; it does not fetch, write or authenticate.

## Scope

No engine, storage service, authentication service, Netlify function, AWS code, host configuration or real-money switch is changed. Existing sizing, freshness checks, qualification, manual/automatic entry, SELL and journal flows remain in their existing handlers. The mock-up's proposed source filters/P&L categories are not presented as available calculations without an existing trustworthy data mapping.

## Verification

The browser workflow runs the existing SELL, trailing, storage-failure, Settings and desktop checks plus `scripts/verify-premium-design.mjs`. The new check intercepts all API traffic and tests 320/390/430/768/1024/1440/1920 widths, navigation, journal expansion, disabled broker actions and action-dock geometry. Its screenshots are isolated test fixtures, not account screenshots. No test reaches a real broker or production journal.

This UI branch is based on PR #30 and targets that feature branch. It does not enable live trading or publish the real-money feature to main.
