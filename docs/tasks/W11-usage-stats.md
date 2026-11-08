# Task W11 — Usage stats

Prerequisite: W10. Read: `docs/design/core-engine-local.md` on the ledger; the dataviz guidance for charts.

## Goal

A **Usage** section in Settings → Spending that answers at a glance: what did the agents cost, how much did they read and write, and where did it go.

## 1. Query (schema first)

`sys.UsageStats { from, to, groupBy: "day" | "agent" | "model" | "session" | "purpose" }` → totals per group: calls, cost (micros), input / output / cached tokens, errors, median and p95 duration. Computed from the ledger; no new storage.

## 2. Screen

- Range: Today · 7 days · 30 days.
- Four figures: cost, tokens, calls, error rate.
- Cost per day (bars, stacked by agent); tokens by agent and by model (table with small bars); most expensive sessions (links to them); errors and slowest calls.
- Subscription agents (W12) show tokens and calls, cost "subscription".
- Quiet, token-only colors; reads as one with the rest of the app in both themes.

## 3. Tests (write first)

Aggregation over a fixed ledger (property test: totals equal the sum of groups); the screen renders each range; axe in e2e.
