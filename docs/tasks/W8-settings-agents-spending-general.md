# Task W8 — Settings: Agents · Spending · General

Prerequisite: W6 (Settings tabs, #9). Read: `W6-settings-first-run-review.md`; `apps/web/src/settings/*`.

## Goal

Settings answers three questions, one tab each: **which agents work on my things, and what may each do** (Agents), **what can it cost** (Spending), **where is my stuff and how does it look** (General). Today's nine tabs regroup without losing anything.

## 1. Agents

One card per actor, in this order:

- **VibeCab agent** — the built-in agent that replies to comments and writes Updates.
  - Model: provider, model, key (today's Model tab; W9 adds the catalog).
  - How it replies: wait before replying, tool uses per reply (from the Agent tab).
  - What it may do: grants, still scoped per session or Draft (today's Permissions tab).
  - Tools: the MCP tool servers it connects to, and which tools it may use (today's Tools tab — VibeCab as MCP **client**).
- **Each connected assistant** (VibeCab as MCP **server**): its name, what it may do (read only or collaborate), when it was connected, **Revoke**.
- **Connect an assistant** (today's Assistant tab: shows the MCP config once) and **Sign in on another browser** (from About).
- W12 adds cards for Claude Code and Codex.

## 2. Spending

- Daily limit and today's use (today's Spending tab).
- The most one reply may cost (moved here from the Agent tab), so all money is in one place.
- W10 adds per-agent limits; W11 adds usage stats.

## 3. General

Data folder, backups, Trash retention (Data), theme (Appearance), version (About).

## 4. Addresses

`#/settings/agents`, `#/settings/spending`, `#/settings/general`. Old addresses keep working: model, agent, permissions, tools, assistant → agents (scrolled to that card); data, appearance, about → general.

## 5. Tests (write first)

- Integration: each old address lands on the right tab and card; the three tabs show one at a time; saving model, reply settings, a grant, a tool server, and an assistant token still works from its card.
- e2e: the journey's Settings step goes through Agents; axe on all three tabs.

## 6. Out of scope

Provider catalog (W9), per-agent limits (W10), stats (W11), SDK agents (W12).
