# 0008: Virtual portfolios to compare strategies

Date: 2026-10-30

## Context

Beating a benchmark on paper shows the account made money, not that the AI was the reason. A simple rule might do as
well for less cost and complexity.

## Decision

Next to the real paper account, virtual portfolios start with the same capital and see the same evening data:

- `claude_patient`: a second prompt favouring few trades and long holds (one extra call, about $0.03 a day).
- `momentum`: a rule-based weekly rebalance with no AI.
- VT buy-and-hold as the benchmark.

`core/simulation.ts` fills their orders from the next day's daily bars (open vs limit, stop before target within a
day, gaps), and they go through the same risk checks. Daily and weekly reports compare all of them after fees and
estimated tax.

## Consequences

- The paper period answers both "does it make money" and "does the AI add anything".
- 15 November 2026: two exit-rule portfolios copy the real account's buys and sells instead of making their own
  call, so they cost nothing and differ only in how they exit. `claude_close_stop` checks the stop-loss against the
  close and sells there, after CSCO was stopped out two hours after buying on 13 November. `claude_time_exit` keeps
  the usual brackets and sells anything held more than 28 days. They copy what the model decided, approved or not, and
  they start on their own first evening, so the reports label them with that date.
- Simulated fills from daily bars are approximate; the real account is the reference for execution quality.
