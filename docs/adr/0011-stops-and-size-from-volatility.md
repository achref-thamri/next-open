# 0011: Stops and position size from volatility

Date: 2026-11-18

## Context

The model picked stop-loss distances by feel (7 to 10% on every buy so far) and every position got the size the
model asked for, up to the 20% cap. That makes a jumpy stock and a steady one carry the same size but very different
risk, and a stop inside a stock's normal daily range gets hit by noise. The prompt also said "doing nothing is a
valid decision", and in the first week the account held about 90% cash against a benchmark that is always fully
invested.

## Decision

- A buy's stop-loss is widened to at least 2.5 times the stock's typical daily move over 20 days, capped at 25%.
  The decisions table keeps the model's value; proposals and orders use the widened one.
- New risk rule `riskPerTrade` (`maxRiskPerTradePct`, default 2%): a position's value times its stop distance may
  not exceed 2% of equity. It runs after the position cap, so a 20% position needs a stop of 10% or less.
- The prompt asks for 70 to 90% invested over several positions, cash only for a reason it can name, stops at 2.5
  to 4 typical daily moves, and wide take-profits since later decisions sell winners.
- The patient AI gets the same stop floor. The momentum rule's 15% stop now sizes its positions to about 13%
  instead of 18%.

## Consequences

- Every position loses about the same at its stop, at most 2% of equity, so five stopped-out positions cost at most
  about 10% of the account.
- Volatile stocks get smaller positions and the account may hold a bit more cash than the model asked for.
- The go-live clock keeps running (see ADR 0010).
