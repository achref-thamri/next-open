# 0012: Earnings dates in the prompt

Date: 2026-11-18

## Context

An earnings report is the most common reason a stock jumps 10% or more overnight. A stop-loss doesn't protect
against that: the stock opens past the stop and the stop sells at the gap price. With every position now sized so a
stop costs at most 2% of equity (ADR 0011), a gap through the stop on a report is the main way a single trade can
lose more than that. The model couldn't see report dates, so it could buy a stock the day before one without knowing.

## Decision

- The evening run fetches the earnings calendar for the next 21 days in one request and keeps the earliest date
  per ticker. The data comes from Finnhub's free plan. FMP's free plan was tried first: its calendar returned 8 rows
  for three weeks and its per-stock endpoint refuses everything but a few sample tickers, so the first version sent
  the model no dates at all.
- Each candidate in the prompt gets `daysToEarnings` when a report is due in that window. The prompt asks the model
  not to open or add to a position in the last few days before a report unless the case rests on the report, and
  then to keep it small.
- The patient AI portfolio gets the same dates. If the calendar request fails, the run goes on without them and
  logs a warning.

## Consequences

- One more API key (`FINNHUB_API_KEY`) and one request a day; Finnhub's free plan allows 60 a minute.
- This is guidance to the model, not a hard rule, so the effect shows up in the pick scorecard and the trades rather
  than in the risk checks. If buys still land just before reports, a rule in code is the next step.
- The go-live clock keeps running (see ADR 0010).
