# 0008: Virtual portfolios to compare strategies

Date: 2026-10-30 · Status: accepted

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
- Simulated fills from daily bars are approximate; the real account is the reference for execution quality.
