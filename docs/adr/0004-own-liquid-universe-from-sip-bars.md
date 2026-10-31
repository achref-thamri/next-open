# 0004 — Own liquid universe from SIP bars, not a movers screener

Date: 2026-10-30 · Status: accepted

## Context

An API check before building showed that Alpaca's free movers screener returns mostly penny stocks, warrants and
leveraged ETFs: of 100 tickers, 38 were priced at $5 or more and very few passed a $2B market cap. The free IEX feed
shows only about 2% of real volume (AAPL: 0.83M vs 36M shares on one day), which breaks any liquidity filter.

## Decision

- The bot builds its own weekly list: all tradable US assets, 20-day SIP daily bars in multi-symbol batches,
  filtered by price (≥ $5) and average dollar volume (≥ $20M), then by market cap (≥ $2B) and the ETF/fund flag
  from FMP profiles.
- All volume figures use the SIP feed. SIP refuses the last 15 minutes, so post-close jobs start 20–30 minutes
  after the close.
- ETFs and funds are excluded: Denmark taxes them yearly on unrealised gains, which would complicate tax tracking.
- FMP profiles are cached for 30 days and fetched within a daily request budget, so the first list fills over
  several days. The list is marked incomplete until then and the evening job waits for a complete one.

## Consequences

- Candidates are liquid large caps, which suits once-a-day limit orders.
- The first week after a fresh install has no trading. Later weeks only look up new or stale tickers.
- FMP's free plan has turned out to refuse its batch market-cap endpoint (HTTP 402). Cached caps are used instead
  and renew with the 30-day profile refresh.
