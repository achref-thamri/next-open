# 0013: Short-term holding with a time limit

Date: 2026-11-27

## Context

The goal of the account is short-term gains: trades that are in and out within a week or two. The prompt said
"think in days to weeks", asked for wide take-profits because later decisions would sell winners, and nothing
limited how long a position could sit. In practice a position that went nowhere stayed until it hit its stop, and
MDT was held for eight days while it drifted down after its earnings report. Day trading was ruled out: an account
this small gets about three day trades a week under the pattern day trader rule, and the once-a-day design has no
intraday data.

## Decision

- The prompt asks the model to aim to be out of each position within one to two weeks, to prefer stocks with a
  reason to move soon (momentum, a breakout to a new high, fresh news) and to sell once the move is done.
- Take-profits are set at a gain the stock can reach in that time, usually 1.5 to 2 times the stop distance,
  instead of wide.
- A time limit in code: a holding still open `maxStallDays` (10) calendar days after it was bought is sold unless it
  is up at least `minGainToKeepPct` (3%). The decisions table keeps the model's answer; the proposal is a sell with
  the reason stated.
- The patient AI portfolio keeps its weeks-to-months horizon and has no time limit, so it shows what the change
  costs or gains.

## Consequences

- More trades, so more spread paid and more small realised gains and losses for tax.
- Winners can be cut early by the closer take-profit. Compare against the patient portfolio and the time-exit
  portfolio before moving the numbers.
- The go-live clock keeps running (see ADR 0010).
