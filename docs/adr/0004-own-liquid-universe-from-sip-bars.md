# 0004: Own liquid universe from SIP bars, not a movers screener

Date: 2026-10-30 · Status: accepted

## Context

An API check before building showed that Alpaca's free movers screener returns mostly penny stocks, warrants and
leveraged ETFs: of 100 tickers, 38 were priced at $5 or more and very few passed a $2B market cap. The free IEX feed
shows only about 2% of real volume (AAPL: 0.83M vs 36M shares on one day), which breaks any liquidity filter.

## Decision

- Next Open builds its own weekly list: all tradable US assets, 20-day SIP daily bars in multi-symbol batches,
  filtered by price (≥ $5) and average dollar volume (≥ $20M), then by market cap (≥ $2B) and the ETF/fund flag
  from FMP profiles.
- All volume figures use the SIP feed. SIP refuses the last 15 minutes, so post-close jobs start 20–30 minutes
  after the close.
- ETFs and funds are excluded: Denmark taxes them yearly on unrealised gains, which would complicate tax tracking.
- FMP profiles are cached for 30 days and fetched within a daily request budget, so the first list fills over
  several days. The list is marked incomplete until then and the evening job waits for a complete one.

- 2026-11-09: the evening job no longer waits for a complete list. Profiles are fetched most traded first and the
  evening job uses whatever the list holds so far. The first paper week had no trades at all because the list was
  still filling, and the shadow portfolios never opened either.

## Consequences

- Candidates are liquid large caps, which suits once-a-day limit orders.
- The first days after a fresh install trade from a short list of the most traded stocks, which grows each day.
  Later weeks only look up new or stale tickers.
- FMP's free plan refuses its batch market-cap endpoint (HTTP 402), so market caps come only from the profiles and
  renew with the 30-day profile refresh. The batch call was removed on 10 November 2026: it cost one request of the
  daily budget per run and never returned anything.
