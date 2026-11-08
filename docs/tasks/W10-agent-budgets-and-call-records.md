# Task W10 — Per-agent limits, and calls recorded with tokens and who made them

Prerequisite: W8. Read: design §11 (gateway, budgets, ledger); `contract/schemas/budget-account.json`, `call-log.json`; `engine/src/gateway/ledger.ts`.

## Goal

Each agent can have its own daily limit beside the overall one, and every model call records enough to answer "who spent what, on what" (needed by W11).

## 1. Contract (schemas first)

- `budget-account.kind` gains `"agent"` with `key` = the agent's id (the built-in agent is `vibecab`; W12 adds `claude-code` and `codex`).
- `call-log` gains `agentId`, `sessionId?`, `purpose` (`reply` | `update` | `plan` | `review` | `digest`), `inputTokens`, `outputTokens`, `cachedInputTokens?` (as reported; `usageQuality` already says how sure).
- Agents paid by their own subscription (W12) record tokens but reserve and settle **zero** — they never count against VibeCab limits.

## 2. Engine

- A call reserves against the daily, agent, session, grant, run and turn accounts it falls under; the smallest remaining wins (as today, plus `agent`).
- The ledger fills the new fields from the gateway response.

## 3. App

Spending tab: overall daily limit, then one row per agent with its own daily limit (empty = only the overall limit applies) and today's use.

## 4. Tests (write first)

- Invariant 11 still holds: no model call without a reservation, now including the agent account.
- An agent limit blocks that agent's calls only; a subscription agent never reserves money; token fields are recorded from scripted provider usage.
