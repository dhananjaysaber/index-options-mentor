# Complete identifier receipt — Google Version 4 published

The refreshed AWS result confirms the export queue is now empty, the SQLite backup is verified, and account/simulation checks still pass. Its remaining journal failure is `SHEETS_HISTORY_CANNOT_BE_FULLY_VERIFIED`. The old verifier used a capped closed-trade history list and compared its length with an overall trade-row count; that cannot prove uniqueness across all rows.

Prepared change:

- Add authenticated, read-only `journal_receipt` to the existing Apps Script. It validates identifiers, locks a coherent snapshot, checks expected column headers, scans all trade/journey identifier rows up to an explicit safety bound, and returns counts for the exact requested trade and event, including all final-exit events for that trade. It never creates, deletes or edits a row.
- Permit only signed, validated receipt requests through the Netlify maintenance route. Wrong credentials, extra fields and invalid IDs remain rejected.
- Verify before and after sending the same already-saved close twice: one total trade row, one closed trade row, one exact exit event, one matching trade/event pair and one final exit event for the trade. Different exit IDs are not ignored. Truncated or malformed receipts fail closed.
- Keep export success separate from replay-verification failure in metadata so an empty successfully drained queue is not labelled a failed export merely because proof is incomplete.

Local validation: eight Python journal/replay tests, six Apps Script setup/receipt tests and six gateway/SQLite HTTP tests pass. Tests include open rows, more than 1,000 historical rows, duplicate trade IDs, different exit IDs, incomplete receipts and credential rejection. They use disposable data only.

Initial publication was blocked by a browser automatic-approval usage limit. After the user reported that usage had reset, browser access succeeded. The additive receipt handler and authenticated dispatch branch were saved and verified in the existing editor without replacing trade/setup code. The existing web app was updated to Version 4 at 09:46 IST on 25 November 2026. The Google UI confirmed deployment success. The deployment URL, execution identity, access settings and credentials were unchanged. No trading permissions, positions or real orders were changed.

The signed Netlify gateway must also be published before running the new AWS checker. Google publication and passing isolated tests alone do not prove deployed replay. A fresh signed AWS run must still establish the final row/event counts. PR28/PR30 and actual live trading remain unmerged/disabled.
