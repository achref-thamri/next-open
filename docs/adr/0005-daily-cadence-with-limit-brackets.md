# 0005: Once a day, limit bracket orders at the open

Date: 2026-10-30 · Status: accepted

## Context

Next Open is not competing on speed, an LLM call is slow and costs money, and the owner approves trades by phone in
live mode. Overnight news can gap a stock far from the price the decision was based on.

## Decision

- Analyse after the close, execute at the next open. One Claude call per evening.
- Buys are limit orders at most 1% above the previous close, with the model's stop-loss and take-profit attached as
  a bracket. Sells are limits at most 1% below. A buy that gaps away is reported unfilled, not chased.
- Alpaca's bracket legs inherit the parent's time in force, so a day bracket would drop its stop at the close.
  Entries are placed `gtc` and the end-of-day job cancels unfilled entries, which keeps stops alive on filled ones.
- Whole shares only, because brackets do not support fractional quantities.
- `client_order_id` is derived from the proposal id, so a retry or restart cannot submit twice.

## Consequences

- Predictable cost (about $0.03 per call) and a human-friendly approval window.
- Some good trades are missed on gaps. Accepted: chasing gaps is how fast traders buy tops.

## Changes

- 2026-11-14: the stop-loss and take-profit are measured from the previous close, not from the limit price. A buy
  usually fills below its limit, so a stop measured from the limit sat closer than the model asked for. On
  13 Nov CSCO filled at $100.47 with a 7% stop that was really 4.6%, and it was sold two hours later. The fill
  price isn't known when the bracket is placed, so the previous close is the closest stand-in. Both legs still stay
  at least a cent away from the limit, which Alpaca requires.
