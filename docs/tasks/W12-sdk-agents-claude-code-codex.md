# Task W12 — Claude Code and Codex as agents, through their SDKs

Prerequisite: W8, W10. Read: design §10 (agent turns), §12 (MCP); `adapters/mcp-server`; the Claude Agent SDK and Codex SDK docs.

## Goal

Claude Code and Codex can work in a session like the built-in agent — reading the Draft, replying in threads, proposing changes — using the sign-in each already has on this computer.

## 1. Sign-in

VibeCab is for personal use (Wei, 2026-11-08): each SDK runs with this computer's existing Claude Code / Codex sign-in, including a subscription. VibeCab never sees or stores those credentials. If this ever ships to other people, this decision must be revisited (the Agent SDK's terms for third-party products).

## 2. How a turn runs

- An SDK agent is a new kind of agent turn: the engine starts the SDK (`@anthropic-ai/claude-agent-sdk` / `@openai/codex-sdk`) with a prompt built from the session's context manifest, and gives it VibeCab's own MCP tools (read the Draft, reply, propose) through a session-scoped token — the same MCP server outside assistants use, so invariant 9 and 10 hold (it acts as the agent, never as the human; no admin operations).
- Its replies and proposals go through the normal feedback commands; Updates still commit only at the end (invariant 11, with a zero reservation for subscription agents).
- Turns are cancellable; output is streamed into the thread's "replying" state.

## 3. Settings → Agents

A card each for Claude Code and Codex: found on this computer or not (with how to install), signed in or not, enabled per session, its model choice where the SDK offers one, and its usage (tokens; cost "subscription").

## 4. Choosing the agent

Per session: which agent replies (VibeCab agent, Claude Code or Codex), in the session's Agent panel.

## 5. Tests (write first)

- With a fake SDK (no real calls): a turn reads through MCP, replies in the right thread, proposes a change that needs Agree; cancel stops it; the token it used is revoked after the turn.
- The agent can never call admin operations, act as the human, or widen a grant.
