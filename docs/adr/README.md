# Architecture decision records

Short records of decisions that shape the code: the context, what was decided, and what it costs.

| #                                                   | Decision                                                  |
| --------------------------------------------------- | --------------------------------------------------------- |
| [0001](0001-ports-and-adapters.md)                  | Ports and adapters in a single service                    |
| [0002](0002-the-llm-proposes-code-enforces-risk.md) | The LLM proposes, code enforces risk                      |
| [0003](0003-forward-testing-only.md)                | Forward testing on paper, no backtests of the AI strategy |
| [0004](0004-own-liquid-universe-from-sip-bars.md)   | Own liquid universe from SIP bars, not a movers screener  |
| [0005](0005-daily-cadence-with-limit-brackets.md)   | Once a day, limit bracket orders at the open              |
| [0006](0006-missed-jobs-are-never-replayed.md)      | Missed jobs are alerted, never replayed                   |
| [0007](0007-sqlite-and-typed-fetch-clients.md)      | SQLite and typed fetch clients instead of vendor SDKs     |
| [0008](0008-virtual-portfolios-for-comparison.md)   | Virtual portfolios to compare strategies                  |
| [0009](0009-sized-for-a-small-account.md)           | Sized for a small account                                 |
