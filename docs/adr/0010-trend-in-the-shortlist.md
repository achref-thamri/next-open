# 0010: Uptrends in the shortlist, a year of data per stock

Date: 2026-11-18 · Status: accepted

## Context

The shortlist was holdings, then stocks in the news, then the biggest moves times relative volume. That picks the
day's noisiest stocks, where moves often partly reverse, and nothing in it rewards a signal with a long record. The
model also saw only returns up to three months, so it couldn't tell a stock at its yearly high from one far below
it: on 13 Nov it set a take-profit for AMZN well above any price it had closed at in the last year.

In the first week the model bought two stocks and held about 90% cash. Stocks that have risen over the last 6 to 12
months and trade above their 200-day average have tended to keep outperforming (the momentum effect), which suits a
strategy that holds for days to weeks.

## Decision

- The evening job loads a year of daily bars (380 calendar days) instead of 130 days.
- Half of the shortlist slots left after the holdings go to the strongest uptrends: the highest 6-month return among
  stocks above their 200-day average. The rest go to news and unusual moves as before.
- Each candidate in the prompt also carries 6- and 12-month returns, `fromHigh52w`, `vsMa200` and
  `dailyVolatility`, and the prompt says what they mean.

## Consequences

- About three times as many bars per evening (roughly 1,800 tickers × 260 bars), still well inside the job's
  90-minute limit.
- The paper account treats this as a live change: it applies from the next evening and the go-live clock keeps
  running, since every future improvement would otherwise restart it.
