# 0007 — SQLite and typed fetch clients instead of vendor SDKs

Date: 2026-10-30 · Status: accepted

## Context

One process, one user, a few thousand rows a day. The vendor APIs used are small: a handful of Alpaca and FMP
endpoints.

## Decision

- SQLite through better-sqlite3, with versioned migrations (`PRAGMA user_version`) and nightly online backups.
  Repositories sit behind ports, so Postgres would be a new adapter.
- Alpaca and FMP through small typed `fetch` clients, with every response validated by zod and recorded fixtures
  in tests. The Anthropic SDK is used because structured output and usage reporting come with it.

## Consequences

- No database server to run or secure, and tests use in-memory SQLite.
- Fewer dependencies and full control over retries, rate limits and error messages (API keys never reach logs).
- Endpoints have to be mapped by hand; for the dozen in use that is cheap.
