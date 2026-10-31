# 0006 — Missed jobs are alerted, never replayed

Date: 2026-10-30 · Status: accepted

## Context

If the server is down at the open, a naive scheduler catches up when it returns and places orders hours later on
prices that no longer hold.

## Decision

Every job has a due time and a window (15 minutes for the open, longer for reports and the liquid list). A job
starts at most once per date, recorded in SQLite so restarts do not repeat it. A job that cannot start inside its
window is recorded as missed and sent as an alert. It is never run late.

## Consequences

- Downtime costs a day of trading, never a trade on stale data.
- Deploys avoid the minutes around the open and the post-close jobs.
- A failed run also blocks a same-day retry; rerunning means removing that run record deliberately.
