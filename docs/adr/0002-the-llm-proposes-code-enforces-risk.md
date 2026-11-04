# 0002: The LLM proposes, code enforces risk

Date: 2026-10-30 · Status: accepted

## Context

Claude is good at weighing news and price action, but its output is not guaranteed to be well-formed or within
limits, and news headlines in the prompt are untrusted text that could try to steer it.

## Decision

- The model returns structured decisions (action, target weight, confidence, stop, target, horizon, reasoning),
  validated with zod. Invalid output means no trades that day and an alert.
- Sizing to whole shares and every risk rule are pure functions in `core/risk`, run at proposal time and again
  right before execution against the live account. Each returns accept, trim or reject with a reason.
- News is wrapped and labelled as data in the prompt; the risk checks bound what any injected instruction could do.
- Every prompt, response, model id, token count and cost is stored for audit and replay.

## Consequences

- The worst a bad answer can do is bounded by config, not by the model's judgment.
- Limits are testable without calling a model.
- The rules are informational in the prompt too, so the model rarely proposes trades that get trimmed.
