# Task W9 — Built-in model providers, model lists and prices

Prerequisite: W8. Read: `engine/src/gateway/*`, `contract/schemas/provider-model.json`, `apps/web/src/settings/ModelForm.tsx`.

## Goal

Choosing a model is picking a provider and a model from a list, not typing addresses and prices. Every provider in the first batch speaks the OpenAI-compatible API the engine already has, so this is a catalog and a picker, not new provider code.

## 1. First batch

| Provider | Base address | Key | Notes |
|---|---|---|---|
| OpenAI | `https://api.openai.com/v1` | yes | |
| Anthropic | `https://api.anthropic.com/v1/` (OpenAI-compatible layer) | yes | native API in batch 2 |
| Google Gemini | `https://generativelanguage.googleapis.com/v1beta/openai/` | yes | |
| OpenRouter | `https://openrouter.ai/api/v1` | yes | live models **and prices** from its API |
| Cloudflare Workers AI | `https://api.cloudflare.com/client/v4/accounts/{account}/ai/v1` | yes | asks for the account id |
| Cloudflare AI Gateway | `https://gateway.ai.cloudflare.com/v1/{account}/{gateway}/compat` | yes | asks for account and gateway |
| DeepSeek | `https://api.deepseek.com/v1` | yes | |
| xAI | `https://api.x.ai/v1` | yes | |
| Mistral | `https://api.mistral.ai/v1` | yes | |
| Groq | `https://api.groq.com/openai/v1` | yes | |
| Together | `https://api.together.xyz/v1` | yes | |
| Fireworks | `https://api.fireworks.ai/inference/v1` | yes | |
| Cerebras | `https://api.cerebras.ai/v1` | yes | |
| Moonshot (Kimi) | `https://api.moonshot.ai/v1` | yes | |
| Qwen (Alibaba DashScope) | `https://dashscope-intl.aliyuncs.com/compatible-mode/v1` | yes | |
| Zhipu (GLM) | `https://open.bigmodel.cn/api/paas/v4` | yes | |
| Ollama | `http://localhost:11434/v1` | no | local, free |
| LM Studio | `http://localhost:1234/v1` | no | local, free |

Batch 2 (new engine provider code; its own task): native Anthropic Messages (prompt caching), Azure OpenAI, AWS Bedrock, Google Vertex.

## 2. The catalog

- `contract/catalog/providers.json` (schema first): per provider its id, name, base address (with placeholders), key needed, docs and pricing page URLs; per model its id, name, context size, tool use and JSON output support, input / output / cached-input price per million tokens, the source URL and the date checked.
- Prices are checked against each provider's pricing page when the task is done, never written from memory; each carries its `checkedAt`.
- A script refreshes OpenRouter's entries from its models API; other providers are refreshed by hand with a recorded date.

## 3. Live model lists

The picker also asks the provider's `/models` endpoint (where offered) through the web host, so new models appear without a release. Models found live but not in the catalog show "price unknown — enter it".

## 4. Prices are yours to override

A per-model price override in settings wins over the catalog; the ledger records which price was used.

## 5. Tests (write first)

- The catalog validates against its schema; every provider has a pricing source and every price a date.
- The picker fills the model config (address with placeholders filled, capabilities, pricing) for a catalog model; a live-only model asks for its price; an override wins in the budget reservation.
- No test calls a real provider: the live list is served by a fake.
