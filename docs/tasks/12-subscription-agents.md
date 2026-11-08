# Task 12 — Subscription agents: Claude Agent SDK as the main agent, Codex for TMR

Prerequisites: tasks 03, 04, 05, 10b and 11. Read: design §9 (agent runtime), §10 (model gateway, ledger), §12 (TMR); `AGENTS.md` §5; task 03 for the provider interface.

**Status:** draft for Wei's review. Not yet in the build order.

## Goal

VibeCab's main agent (reply and Update turns) can run on Wei's own **Claude subscription** through the Claude Agent SDK, instead of an API key. TMR participants can run on **other vendors**: GPT through the Codex app-server on Wei's ChatGPT plan, and DeepSeek and Gemini through API keys on the existing OpenAI-compatible provider.

The engine keeps every guarantee it has today. VibeCab's agent runtime still runs the tool loop, write sets are still enforced, and every call is still recorded in the manifest and the ledger.

**Personal use only.** Both vendors allow a person's own subscription in their own local tool. Neither allows a product to offer subscription login to other people. This build is local and single-person, so it qualifies. A hosted build must use API keys or a registered app (record this in `docs/decisions.md`).

## 0. Spike first (stop and report before step 1)

The whole task depends on one question per SDK: can it act as a **model** for one step, rather than as an agent that runs its own loop?

- **Claude Agent SDK** (`@anthropic-ai/claude-agent-sdk`): with every built-in tool disabled and VibeCab's tools declared, does one `query` step return the model's tool calls to the caller *without executing them*, so VibeCab's runtime runs them? If the SDK only runs tools through its own MCP handlers, record which of the options below works:
  - (a) Declare VibeCab's tools as SDK MCP tools whose handlers end the step and hand the call back to the engine.
  - (b) Let the SDK run the loop, with VibeCab's tools as the only tools (design mode 2, see §6).
- **Codex app-server**: the same question over its JSON-RPC interface, with Codex's own shell and file tools turned off.
- For each: which auth it picks up (Claude Code login or `CLAUDE_CODE_OAUTH_TOKEN`; a ChatGPT-plan token for Codex), what usage it reports, how it signals quota exhaustion, and whether structured JSON output is supported.

Write the findings into `docs/questions.md` and stop for Wei's decision.

## 1. Contract

- `provider-model.json`: `provider` becomes an enum: `"openai-compatible" | "claude-agent-sdk" | "codex-app-server"`.
- New field `billing`: `{ kind: "api", pricing }` (today's behaviour) or `{ kind: "subscription", account: string }`. `pricing` moves under `billing.kind = "api"`. `baseUrl` and `keyRef` are required only for `openai-compatible`.
- Migration: existing settings with top-level `pricing` are read as `billing: { kind: "api", pricing }`.
- New optional `fallbackModelRef` on a model: the alias to use when this one reports quota exhaustion.
- New settings key `agents: { mainModelRef: string }`. Reply and Update turns use it. TMR participants keep naming their own `modelRef`.

## 2. Providers (`engine/src/gateway/providers/`)

- `claude-agent-sdk.ts` and `codex-app-server.ts` implement the existing `ModelProvider` interface. No SDK types leak outside these files (task 03 rule).
- The SDK packages are injected through `Dependencies` by the host, as `KeyStore` is. The engine never spawns a CLI directly, and tests inject a scripted fake.
- **No built-in vendor tools ever.** File edit, shell, web, and any other vendor tool must be disabled. The only tools offered are those in `ModelRequest.tools`. A provider that cannot guarantee this must refuse the request with `unsupported`.
- Map SDK events to `ModelEvent`: text, tool calls, JSON output, usage with `quality`, finish reason. A quota or rate-limit signal maps to `rate_limited` with `retryable: false` and a new `quota_exhausted` flag on the event.
- Credentials: the SDK reads the vendor's own login from the user's machine. VibeCab never reads, copies or stores that login. The environment passed to the SDK subprocess is built explicitly; parent-process tokens are not inherited (see claude-mem's `EnvManager` for the leak this prevents).

## 3. Ledger: subscription billing

- A call on a `subscription` model reserves **0 micros** but still counts toward the turn's token limit and tool-call limit.
- The ledger keeps a per-account subscription usage record: calls, reported tokens, last quota error time. This is reported in budgets queries alongside money.
- TMR's budget bound (task 10b) still applies to money. Subscription participants count toward a new per-run call limit instead.

## 4. Fallback

- If a call fails with `quota_exhausted` and the model has `fallbackModelRef`, the gateway retries once on the fallback before any output has been emitted, with a fresh reservation priced for the fallback.
- If output was already emitted, there is no retry. The turn fails with the normal error.
- The manifest records both the original model and the fallback used.

## 5. TMR participants

- Any configured alias may be a participant.
- `vc.RequestReview` / `ConvertSuggestedReview` warn (not fail) when a participant uses the same subscription account as `agents.mainModelRef`: a long run could use up the quota the main agent needs.
- Recommended default set (settings template, not hard-coded): Codex (ChatGPT plan), DeepSeek (API), Gemini (API).

## 6. Out of scope

- **Mode 2** (the SDK runs the whole loop with VibeCab's tools exposed through the MCP server). Revisit after the spike if mode 1 turns out impossible or too limited.
- Gemini or Antigravity CLI login (consumer Google login no longer serves Gemini CLI, per third-party reports; unverified).
- Any hosted or multi-user use of subscription credentials.
- UI beyond a model picker in Settings and the fallback indicator in the turn view (app task to follow).

## 7. Tests (write first)

- With scripted fake SDKs: event mapping for text, tool calls, JSON output, usage and errors; built-in tools are never offered; a request whose tools cannot be restricted is refused.
- The Update write-set tests from task 05 rerun with the main agent on the fake Claude SDK provider: untouched elements stay byte-identical.
- Subscription calls reserve 0 micros, still respect token and tool-call limits, and are recorded in the subscription usage record.
- Quota exhaustion before output → one retry on the fallback, both models in the manifest. After output → no retry.
- TMR: a run mixing subscription and API participants respects the money bound and the call limit; the shared-account warning appears.
- The subprocess environment contains no inherited `ANTHROPIC_API_KEY`, `CLAUDE_CODE_OAUTH_TOKEN` or OpenAI token unless configured. Credentials never appear in logs, manifests or events.
- No network in tests (task rules).

## 8. Open questions for Wei

1. Mode 1 or mode 2 for the main agent, after the spike?
2. Fallback for the main agent: an Anthropic API key, or a different vendor?
3. Should Claude be allowed in TMR at all, or only as the main agent?
