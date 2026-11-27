# Strategy behaviour record

`tests/strategy-golden.test.mjs` fails if the 13-Point or Scalp rules give a
different answer from `baseline.json` for the same sample prices. It runs with
`npm test`. The prices are invented; no broker or network is used.

Covered: entry checks and tickets, the automatic tiers, Scalp entry gates and
time window, exits as judged by the server (`aws/live/exitSignals.mjs`), profit
protection, trailing rules and amount-based sizing.

Not covered: the browser's paper-trade flow, broker order handling, and
`hardOptionStop` (a known wiring fault, removed from the record on purpose).

It records what the code does today. It does not show that the rules are
profitable or right.

Re-record only after the owner approves a strategy change:
`node tests/golden/record.mjs`
