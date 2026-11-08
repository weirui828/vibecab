# Tasks

Implement in order. Each task assumes every earlier task is merged with `pnpm gen && pnpm typecheck && pnpm lint && pnpm test && pnpm format:check` green. Design: `docs/design/core-engine-local.md` (section numbers below refer to it).

| # | Task | Design | Depends on |
|---|---|---|---|
| 01 | Contract, kernel, `doc` content, in-process + HTTP adapters | §3–§5, §11, §19, §20.1 | — |
| 02 | Sessions, comments, agreement, feedback states, conflict detection (deterministic) | §6, §9.3 (inbox) | 01 |
| 03 | Model gateway, providers, budget ledger, key store | §10 | 01 |
| 04 | Agent runtime: reply turns, tools, context manifests, reply triggers, grants | §9, §10.1, §6.2 | 02, 03 |
| 05 | Updates: planning, verbatim suggestions, write-set enforcement, conflict judge, direct editing | §7, §8, §6.3 | 04 |
| 05b | Module structure, attribution fix, missing tests for 04–05 (from review) | §7, §9 | 05 |
| 06 | Continuity and outputs: resume view, digest, Output Sets, labels, export, backup, trash, purge | §9.3, §14 | 05b |
| 06b | Module registry: domain code out of the kernel; split large files (from review) | §3, §18 | 06 |
| 07 | Access tokens and CLI adapter | §19.5, §20.3 | 06b |
| 08 | MCP server adapter | §19.5, §20.2 | 07 |
| 09 | MCP client: tool connections and policies | §20.4 | 04, 07 |
| 09b | MCP client: real-adapter and injection tests, stdio credential env (from review) | §20.4 | 09 |
| 10 | TMR engine (standalone) + `tmr` CLI | §12 | 03, 07 |
| 10b | TMR: run-state races, budget bound, report source, missing tests (from review) | §12 | 10 |
| 11 | TMR integration with covibe | §13, §14 (purge cascade) | 05, 06, 10b |
| 12 | Subscription agents: Claude Agent SDK main agent, Codex for TMR (draft, spike first) | §9, §10, §12 | 03, 04, 05, 10b, 11 |

## macOS app tasks

Run after task 09 (and 09b if possible). A0 can run alongside tasks 10–11. Decisions: `docs/decisions.md` → "macOS app (2026-10-29)".

| # | Task | Depends on |
|---|---|---|
| A0 | App groundwork: shared engine host, MCP stdio relay, `vc.Artifacts`, renames, live events, fake-provider mode, `AGENTS.md` app rules | 09 |
| A1 | Electron shell, engine lifecycle, ContractBridge, Tundra theme, first run | A0 |
| A1b | Host and app shell: broken MCP relay, missing tests (from review) | A1 |
| A1c | Provider keys owned by the engine, fuses at packaging, real event audit | A1b |
| A2 | Home and session view: Document renderer, anchored comments, threads, "since you were here" | A1c |
| A3 | Agreement, conflicts, agent replies and Updates, diff view | A2 |
| A4 | History, Snapshots, export, trash, backup/restore, settings, MCP setup | A3 |
| A5 | Packaging (arm64, bundled Node 26), app icon, menu bar, login item | A4 |

Rules for every task (in addition to `AGENTS.md`):

- Schemas first: every new operation, event and payload is a JSON Schema in `contract/schemas/` before code. Each operation gets `OperationMeta` (`effect`, `irreversible`, `channels`).
- Every new operation is added to the shared contract test suite and must pass through every adapter that exists at that point.
- Model-dependent behaviour is tested only with the scripted fake provider from task 03. No network in tests.
- New outbox job kinds declare whether they are locally idempotent (re-run after lost lease) or may have been billed (`uncertain` after lost lease).
- End each task with: what was built, test summary, new entries in `docs/decisions.md`, open items in `docs/questions.md`. Then stop.

## Web app tasks

A browser app that replaces the Electron renderer as the main way to use VibeCab. Same engine, same contract, same app rules (`AGENTS.md` §9); new visual design on `@wei/design-system`, theme `tundra`. Plan and visual direction: `W0-web-app-plan.md`.

| # | Task | Depends on |
|---|---|---|
| W1 | Web host, browser bridge, app shell, Home | A4 |
| W2 | Session view: Document, Drafts in a session, catching up | W1 |
| W3 | Comments and margin threads | W2 |
| W4 | Agreement, agent replies, conflicts, Updates and diffs | W3 |
| W5 | History, Snapshots, export, Trash, Ideas and Projects | W4 |
| W6 | Settings, first run, accessibility and visual review (`W6-settings-first-run-review.md`); `apps/ui` decision in W7 | W5 |
| W7 | Proposal: what to do with the Electron app (`W7-electron-proposal.md`) — Wei to decide | W6 |
| W8 | Settings: Agents · Spending · General | W6 |
| W9 | Built-in model providers, model lists and prices | W8 |
| W10 | Per-agent limits, and calls recorded with tokens and who made them | W8 |
| W11 | Usage stats | W10 |
| W12 | Claude Code and Codex as agents, through their SDKs | W8, W10 |
