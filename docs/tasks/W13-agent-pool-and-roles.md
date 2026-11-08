# Task W13 — Agent pool and roles

Prerequisite: W8–W12, and the "no default model required" fix. Read: `W8`–`W12`; `engine/src/tmr/*`; `contract/schemas/provider-model.json`, `settings.json`.

## Goal

Agents are a **pool**: each has a name, what it runs on (a provider model, Claude Code or Codex) and optional instructions. A separate **Roles** page assigns them: one agent to **VibeCab** (Covibe sessions, later chat) and a **panel** of agents to **TMR** (debate, review, vote). The same agent can serve both.

## 1. Contract (schemas first)

- `provider-model` gains optional `name` (display name) and `instructions` (≤ 4000 chars). A pool agent is a model entry; its alias is its id. Keys stay per provider: a new agent on a provider that already has a key reuses that key reference.
- `settings` gains `roles`: `{ vibecab?: agentId, tmr?: { panel: [{ agentId, label? }], process?: "independent-review", spendMicros?: integer } }`; `sys.SetSettings` patches it.
- `session-settings.agent` becomes any agent id ("vibecab" still means "the VibeCab role's agent").
- `tmr.Submit`: `participants`, `processSpec` and `limits` become optional; when left out they come from `roles.tmr` (the only process the engine has today is independent review).

## 2. Engine

- Which agent works for a session: the session's own choice, else `roles.vibecab`, else the default model, else any agent that is on. Used for replies, Update planning and writing, and digests.
- An agent's instructions are added to every request made with it (VibeCab and TMR alike).
- Calls and budgets are attributed to the agent id (the pool alias), so W10 limits and W11 stats are per pool agent.

## 3. App

- **Settings → Agents**: the pool — each agent's name, what it runs on, price or "subscription", instructions; add, edit, remove. Your AI assistants (MCP clients that act as you) stay a separate group.
- **Settings → Roles**: VibeCab — one agent (only agents that can call tools), with how it replies, what it may do, its tools; TMR — a panel of 2–7 agents with role labels, the process, and a spending cap per run, with a warning when panel members share a model and have no instructions.
- A session's Agent panel picks any eligible pool agent; the default is the VibeCab role's.

## 4. Tests (write first)

Resolution order; instructions reach the request; TMR run from the role's panel; attribution by agent id; the pool and roles pages; the session's choice.
