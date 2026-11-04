# 0003: Forward testing on paper, no backtests of the AI strategy

Date: 2026-10-30 · Status: accepted

## Context

A backtest asks the model to decide on past dates, but the model's training data already contains what happened
next. Any backtest result would be contaminated.

## Decision

The AI strategy is only evaluated forward, on a paper account. Live trading needs a go-live gate fixed before the
paper period starts: at least three months of paper trading, a return above a buy-and-hold VT benchmark after fees
and estimated Danish tax, a max drawdown no more than 5 points worse than the benchmark's, and no unexplained bugs
in the last 30 days. Going live also needs `TRADING_MODE=live` plus a `/golive` confirmation in Telegram.

## Consequences

- Results take months. Accepted: it is the only honest measurement.
- The gate cannot be adjusted after seeing results.
- Rule-based strategies could be backtested, but they run forward next to the AI instead (ADR 0008), so every
  strategy is compared on the same period and data.
