# 0001 — Ports and adapters in a single service

Date: 2026-10-30 · Status: accepted

## Context

The bot depends on a broker, market data, news, fundamentals, an LLM, a messenger and storage. The broker will
change (Alpaca for paper, Saxo later), vendors' free plans change, and the logic that decides about real money has
to be tested without any of them.

## Decision

One Node process with three layers: pure `core`, interfaces in `ports`, vendor code in `adapters`. Use cases in
`app` receive every dependency injected; `compose.ts` is the only place that wires real adapters. Every port has an
in-memory fake in `adapters/fake`, used by tests and by `npm run dry-run`.

## Consequences

- A new broker or vendor is one adapter; core and use cases do not change.
- The full daily pipeline is tested end to end in milliseconds, including crashes, retries and halts.
- More files and interfaces than a script would need. Accepted: the code handles money.
- One process keeps deployment simple. Use cases are plain functions, so they could move to workers later.
