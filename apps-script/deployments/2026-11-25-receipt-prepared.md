# Prepared complete identifier receipt — NOT deployed to Google

The refreshed AWS result confirms the export queue is now empty, the SQLite backup is verified, and account/simulation checks still pass. Its remaining journal failure is `SHEETS_HISTORY_CANNOT_BE_FULLY_VERIFIED`. The old verifier used a capped closed-trade history list and compared its length with an overall trade-row count; that cannot prove uniqueness across all rows.

Prepared change:

- Add authenticated, read-only `journal_receipt` to the existing Apps Script. It validates identifiers, locks a coherent snapshot, checks expected column headers, scans all trade/journey identifier rows up to an explicit safety bound, and returns counts for the exact requested trade and event, including all final-exit events for that trade. It never creates, deletes or edits a row.
- Permit only signed, validated receipt requests through the Netlify maintenance route. Wrong credentials, extra fields and invalid IDs remain rejected.
- Verify before and after sending the same already-saved close twice: one total trade row, one closed trade row, one exact exit event, one matching trade/event pair and one final exit event for the trade. Different exit IDs are not ignored. Truncated or malformed receipts fail closed.
- Keep export success separate from replay-verification failure in metadata so an empty successfully drained queue is not labelled a failed export merely because proof is incomplete.

Local validation: eight Python journal/replay tests, six Apps Script setup/receipt tests and six gateway/SQLite HTTP tests pass. Tests include open rows, more than 1,000 historical rows, duplicate trade IDs, different exit IDs, incomplete receipts and credential rejection. They use disposable data only.

Publishing the Google change was blocked before observation/editing by the cloud browser's automatic-approval usage limit. It is NOT deployed. Do not run the new checker against the old Google deployment or claim the live receipt/replay check passed. The active Google web app remains Version 3 (the previously completed setup-export compatibility change). No trading permissions, credentials, positions or real orders were changed.

The existing signed production gateway update and the Google script must both be published before running the new checker. Keep this release staged until that external publication is possible. PR28/PR30 and actual live trading remain unmerged/disabled.
