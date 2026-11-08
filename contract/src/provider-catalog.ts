import type { ProviderCatalog } from "../generated/index.js";

// Built-in model providers (task W9). Every price here was read from the provider's own pricing page on `checkedAt`
// (never written from memory); `price: null` means that page could not be read and the person enters the price.
// Prices change: refresh by re-reading each `pricingUrl` and updating `checkedAt`. The schema is
// contract/schemas/provider-catalog.json; a test validates this data against it.

/** USD per million tokens → micros per million tokens. */
const usd = (input: number, output: number, cached?: number) => ({
  inputMicrosPerMillion: Math.round(input * 1_000_000),
  outputMicrosPerMillion: Math.round(output * 1_000_000),
  ...(cached !== undefined ? { cachedInputMicrosPerMillion: Math.round(cached * 1_000_000) } : {}),
});

export const providerCatalog: ProviderCatalog = {
  checkedAt: "2026-11-08",
  providers: [
    {
      id: "openai",
      name: "OpenAI",
      baseUrl: "https://api.openai.com/v1",
      keyNeeded: true,
      docsUrl: "https://developers.openai.com/api/docs/models",
      pricingUrl: "https://developers.openai.com/api/docs/pricing",
      note: "Prices are for prompts up to 272K tokens; longer prompts cost more.",
      models: [
        {
          id: "gpt-6-astra",
          name: "GPT-6 Astra",
          contextTokens: 1_050_000,
          tools: true,
          jsonSchemaOutput: true,
          price: usd(10, 50, 1),
        },
        {
          id: "gpt-6.1-sol",
          name: "GPT-6.1 Sol",
          contextTokens: 1_050_000,
          tools: true,
          jsonSchemaOutput: true,
          price: usd(2, 10, 0.1),
        },
        {
          id: "gpt-6.1-terra",
          name: "GPT-6.1 Terra",
          contextTokens: 1_050_000,
          tools: true,
          jsonSchemaOutput: true,
          price: usd(1, 5, 0.05),
        },
        {
          id: "gpt-6-luna",
          name: "GPT-6 Luna",
          contextTokens: 1_050_000,
          tools: true,
          jsonSchemaOutput: true,
          price: usd(0.1, 0.5, 0.01),
        },
      ],
    },
    {
      id: "anthropic",
      name: "Anthropic",
      baseUrl: "https://api.anthropic.com/v1/",
      keyNeeded: true,
      docsUrl: "https://platform.claude.com/docs/en/api/openai-sdk",
      pricingUrl: "https://platform.claude.com/docs/en/about-claude/pricing",
      note: "Through Anthropic's OpenAI-compatible layer, which has no prompt caching; a native connection comes later.",
      models: [
        {
          id: "claude-opus-5-5",
          name: "Claude Opus 5.5",
          contextTokens: 1_000_000,
          tools: true,
          jsonSchemaOutput: true,
          price: usd(4, 20, 0.2),
        },
        {
          id: "claude-sonnet-5-5",
          name: "Claude Sonnet 5.5",
          contextTokens: 1_000_000,
          tools: true,
          jsonSchemaOutput: true,
          price: usd(2, 10, 0.1),
        },
        {
          id: "claude-haiku-5-5",
          name: "Claude Haiku 5.5",
          contextTokens: 100_000,
          tools: true,
          jsonSchemaOutput: true,
          price: usd(0.1, 0.5, 0.01),
          note: "Priced for prompts up to 100K tokens, so VibeCab keeps prompts within that.",
        },
        {
          id: "claude-fable-5-1",
          name: "Claude Fable 5.1",
          contextTokens: 1_000_000,
          tools: true,
          jsonSchemaOutput: true,
          price: usd(10, 50, 0.25),
        },
      ],
    },
    {
      id: "gemini",
      name: "Google Gemini",
      baseUrl: "https://generativelanguage.googleapis.com/v1beta/openai/",
      keyNeeded: true,
      docsUrl: "https://aistudio.google.com/docs/openai",
      pricingUrl: "https://aistudio.google.com/docs/pricing",
      models: [
        {
          id: "gemini-4-argon",
          name: "Gemini 4 Argon",
          contextTokens: 1_048_576,
          tools: true,
          jsonSchemaOutput: true,
          price: usd(2, 10, 0.1),
          note: "Rises to $4 in / $20 out on December 1, 2026.",
        },
        {
          id: "gemini-3.8-flash",
          name: "Gemini 3.8 Flash",
          contextTokens: 1_048_576,
          tools: true,
          jsonSchemaOutput: true,
          price: usd(0.75, 3.75, 0.075),
          note: "Rises to $1.50 in / $7.50 out on January 1, 2027.",
        },
        {
          id: "gemini-3.5-flash-lite",
          name: "Gemini 3.5 Flash-Lite",
          contextTokens: 1_048_576,
          tools: true,
          jsonSchemaOutput: true,
          price: usd(0.3, 2.5, 0.03),
        },
      ],
    },
    {
      id: "openrouter",
      name: "OpenRouter",
      baseUrl: "https://openrouter.ai/api/v1",
      keyNeeded: true,
      docsUrl: "https://openrouter.ai/docs",
      pricingUrl: "https://openrouter.ai/models",
      note: "Hundreds of models from many providers; the list and prices come live from OpenRouter.",
      liveModels: { url: "https://openrouter.ai/api/v1/models", format: "openrouter" },
      models: [],
    },
    {
      id: "cloudflare-workers-ai",
      name: "Cloudflare Workers AI",
      baseUrl: "https://api.cloudflare.com/client/v4/accounts/{account}/ai/v1",
      placeholders: [{ key: "account", label: "Cloudflare account ID" }],
      keyNeeded: true,
      docsUrl: "https://developers.cloudflare.com/workers-ai/configuration/open-ai-compatibility/",
      pricingUrl: "https://developers.cloudflare.com/workers-ai/platform/pricing/",
      note: "The key is a Cloudflare API token. Context sizes are not published on the pricing page, so VibeCab assumes 32K.",
      models: [
        {
          id: "@cf/openai/gpt-oss-120b",
          name: "GPT OSS 120B",
          contextTokens: 32_768,
          tools: true,
          jsonSchemaOutput: false,
          price: usd(0.35, 0.75),
        },
        {
          id: "@cf/openai/gpt-oss-20b",
          name: "GPT OSS 20B",
          contextTokens: 32_768,
          tools: true,
          jsonSchemaOutput: false,
          price: usd(0.2, 0.3),
        },
        {
          id: "@cf/meta/llama-3.3-70b-instruct-fp8-fast",
          name: "Llama 3.3 70B (fast)",
          contextTokens: 32_768,
          tools: true,
          jsonSchemaOutput: false,
          price: usd(0.293, 2.253),
        },
        {
          id: "@cf/meta/llama-3.1-8b-instruct",
          name: "Llama 3.1 8B",
          contextTokens: 32_768,
          tools: false,
          jsonSchemaOutput: false,
          price: usd(0.282, 0.827),
        },
      ],
    },
    {
      id: "cloudflare-ai-gateway",
      name: "Cloudflare AI Gateway",
      baseUrl: "https://gateway.ai.cloudflare.com/v1/{account}/{gateway}/compat",
      placeholders: [
        { key: "account", label: "Cloudflare account ID" },
        { key: "gateway", label: "Gateway ID (default if you have none)" },
      ],
      keyNeeded: true,
      docsUrl: "https://developers.cloudflare.com/ai-gateway/usage/chat-completion/",
      note:
        "Routes to another provider through your gateway: name the model as provider/model (for example " +
        "openai/gpt-6-luna) and enter that provider's price. Cloudflare now suggests Workers AI's address for a single model.",
      models: [],
    },
    {
      id: "deepseek",
      name: "DeepSeek",
      baseUrl: "https://api.deepseek.com",
      keyNeeded: true,
      docsUrl: "https://api-docs.deepseek.com/",
      pricingUrl: "https://api-docs.deepseek.com/quick_start/pricing/",
      note: "Peak-hour prices, so budgets never come up short; off-peak calls cost half.",
      models: [
        {
          id: "deepseek-flash",
          name: "DeepSeek V4.1 Flash",
          contextTokens: 1_000_000,
          tools: true,
          jsonSchemaOutput: false,
          price: usd(0.3, 1.2, 0.006),
        },
        {
          id: "deepseek-v4-pro",
          name: "DeepSeek V4 Pro",
          contextTokens: 1_000_000,
          tools: true,
          jsonSchemaOutput: false,
          price: usd(1.32, 3.96, 0.044),
        },
      ],
    },
    {
      id: "xai",
      name: "xAI",
      baseUrl: "https://api.x.ai/v1",
      keyNeeded: true,
      docsUrl: "https://docs.x.ai/docs/models",
      pricingUrl: "https://docs.x.ai/docs/models",
      note: "Prices are for prompts under 200K tokens; longer prompts cost twice as much.",
      models: [
        {
          id: "grok-4.7",
          name: "Grok 4.7",
          contextTokens: 500_000,
          tools: true,
          jsonSchemaOutput: true,
          price: usd(2, 6, 0.5),
        },
        {
          id: "grok-4.3",
          name: "Grok 4.3",
          contextTokens: 1_000_000,
          tools: true,
          jsonSchemaOutput: true,
          price: usd(1.25, 2.5, 0.2),
        },
      ],
    },
    {
      id: "mistral",
      name: "Mistral",
      baseUrl: "https://api.mistral.ai/v1",
      keyNeeded: true,
      docsUrl: "https://docs.mistral.ai/getting-started/models/models_overview/",
      pricingUrl: "https://docs.mistral.ai/inference/pricing",
      note: "Uses Mistral's -latest names, which follow the current Large and Small models.",
      models: [
        {
          id: "mistral-large-latest",
          name: "Mistral Large 4",
          contextTokens: 1_000_000,
          tools: true,
          jsonSchemaOutput: true,
          price: usd(0.7, 2.1, 0.07),
        },
        {
          id: "mistral-small-latest",
          name: "Mistral Small 4",
          contextTokens: 256_000,
          tools: true,
          jsonSchemaOutput: true,
          price: usd(0.15, 0.6, 0.015),
        },
      ],
    },
    {
      id: "groq",
      name: "Groq",
      baseUrl: "https://api.groq.com/openai/v1",
      keyNeeded: true,
      docsUrl: "https://console.groq.com/docs/models",
      pricingUrl: "https://console.groq.com/docs/models",
      models: [
        {
          id: "openai/gpt-oss-120b",
          name: "GPT OSS 120B",
          contextTokens: 131_072,
          tools: true,
          jsonSchemaOutput: true,
          price: usd(0.15, 0.6, 0.075),
        },
        {
          id: "openai/gpt-oss-20b",
          name: "GPT OSS 20B",
          contextTokens: 131_072,
          tools: true,
          jsonSchemaOutput: true,
          price: usd(0.075, 0.3, 0.037),
        },
      ],
    },
    {
      id: "together",
      name: "Together AI",
      baseUrl: "https://api.together.xyz/v1",
      keyNeeded: true,
      docsUrl: "https://docs.together.ai/docs/serverless-models",
      pricingUrl: "https://www.together.ai/pricing",
      models: [
        {
          id: "moonshotai/Kimi-K3.1-Pro",
          name: "Kimi K3.1 Pro",
          contextTokens: 1_048_576,
          tools: true,
          jsonSchemaOutput: false,
          price: usd(2, 10, 0.2),
        },
        {
          id: "zai-org/GLM-5.3",
          name: "GLM-5.3",
          contextTokens: 1_048_575,
          tools: true,
          jsonSchemaOutput: false,
          price: usd(1.4, 4.4, 0.26),
        },
        {
          id: "deepseek-ai/DeepSeek-V4.1-Flash",
          name: "DeepSeek V4.1 Flash",
          contextTokens: 1_000_000,
          tools: true,
          jsonSchemaOutput: false,
          price: usd(0.3, 1.2, 0.006),
        },
        {
          id: "openai/gpt-oss-120b",
          name: "GPT OSS 120B",
          contextTokens: 131_072,
          tools: true,
          jsonSchemaOutput: false,
          price: usd(0.15, 0.6),
        },
      ],
    },
    {
      id: "fireworks",
      name: "Fireworks AI",
      baseUrl: "https://api.fireworks.ai/inference/v1",
      keyNeeded: true,
      docsUrl: "https://fireworks.ai/models",
      pricingUrl: "https://fireworks.ai/pricing",
      models: [
        {
          id: "accounts/fireworks/models/kimi-k3p1-pro",
          name: "Kimi K3.1 Pro",
          contextTokens: 1_048_576,
          tools: true,
          jsonSchemaOutput: false,
          price: usd(2, 10, 0.2),
        },
        {
          id: "accounts/fireworks/models/glm-5p3",
          name: "GLM-5.3",
          contextTokens: 1_048_576,
          tools: true,
          jsonSchemaOutput: false,
          price: usd(1.4, 4.4, 0.26),
        },
        {
          id: "accounts/fireworks/models/deepseek-v4p1-flash",
          name: "DeepSeek V4.1 Flash",
          contextTokens: 1_048_576,
          tools: true,
          jsonSchemaOutput: false,
          price: usd(0.3, 1.2, 0.006),
        },
        {
          id: "accounts/fireworks/models/glm-5p3-flash",
          name: "GLM-5.3 Flash",
          contextTokens: 1_048_576,
          tools: true,
          jsonSchemaOutput: false,
          price: usd(0.15, 0.5, 0.03),
        },
        {
          id: "accounts/fireworks/models/minimax-m3p1-flash",
          name: "MiniMax M3.1 Flash",
          contextTokens: 1_048_576,
          tools: true,
          jsonSchemaOutput: false,
          price: usd(0.15, 0.6, 0.015),
        },
      ],
    },
    {
      id: "cerebras",
      name: "Cerebras",
      baseUrl: "https://api.cerebras.ai/v1",
      keyNeeded: true,
      docsUrl: "https://inference-docs.cerebras.ai/models/overview",
      pricingUrl: "https://www.cerebras.ai/pricing",
      note: "Cerebras's price table could not be read; enter the prices from your Cerebras account.",
      models: [
        {
          id: "gpt-oss-120b",
          name: "GPT OSS 120B",
          contextTokens: 131_000,
          tools: true,
          jsonSchemaOutput: false,
          price: null,
        },
        {
          id: "qwen-3.8-27b",
          name: "Qwen 3.8 27B",
          contextTokens: 128_000,
          tools: true,
          jsonSchemaOutput: false,
          price: null,
        },
      ],
    },
    {
      id: "moonshot",
      name: "Moonshot (Kimi)",
      baseUrl: "https://api.moonshot.ai/v1",
      keyNeeded: true,
      docsUrl: "https://platform.kimi.ai/docs/models.md",
      pricingUrl: "https://platform.kimi.ai/docs/pricing/chat",
      note: "Kimi's price table could not be read; enter the prices from your Kimi account.",
      models: [
        {
          id: "kimi-k3.1-pro",
          name: "Kimi K3.1 Pro",
          contextTokens: 1_048_576,
          tools: true,
          jsonSchemaOutput: false,
          price: null,
        },
        { id: "kimi-k3", name: "Kimi K3", contextTokens: 1_048_576, tools: true, jsonSchemaOutput: false, price: null },
      ],
    },
    {
      id: "qwen",
      name: "Qwen (Alibaba Model Studio)",
      baseUrl: "https://{workspace}.ap-southeast-1.maas.aliyuncs.com/compatible-mode/v1",
      placeholders: [{ key: "workspace", label: "Model Studio workspace ID" }],
      keyNeeded: true,
      docsUrl: "https://www.alibabacloud.com/help/en/model-studio/compatibility-of-openai-with-dashscope",
      pricingUrl: "https://www.alibabacloud.com/help/en/model-studio/models",
      note: "Singapore region. Model Studio's prices could not be read; enter them from your account.",
      models: [
        {
          id: "qwen3.8-max",
          name: "Qwen 3.8 Max",
          contextTokens: 1_000_000,
          tools: true,
          jsonSchemaOutput: true,
          price: null,
        },
        {
          id: "qwen3.7-plus",
          name: "Qwen 3.7 Plus",
          contextTokens: 1_000_000,
          tools: true,
          jsonSchemaOutput: true,
          price: null,
        },
        {
          id: "qwen3.8-flash",
          name: "Qwen 3.8 Flash",
          contextTokens: 1_000_000,
          tools: true,
          jsonSchemaOutput: true,
          price: null,
        },
      ],
    },
    {
      id: "zai",
      name: "Z.ai (GLM)",
      baseUrl: "https://api.z.ai/api/paas/v4",
      keyNeeded: true,
      docsUrl: "https://docs.z.ai/guides/overview/quick-start",
      pricingUrl: "https://docs.z.ai/guides/overview/pricing",
      models: [
        {
          id: "glm-5.3",
          name: "GLM-5.3",
          contextTokens: 1_000_000,
          tools: true,
          jsonSchemaOutput: false,
          price: usd(1.4, 4.4, 0.26),
        },
        {
          id: "glm-5.3-flash",
          name: "GLM-5.3 Flash",
          contextTokens: 128_000,
          tools: true,
          jsonSchemaOutput: false,
          price: usd(0.15, 0.5, 0.03),
          note: "Context size not published; VibeCab assumes 128K.",
        },
      ],
    },
    {
      id: "ollama",
      name: "Ollama (on this computer)",
      baseUrl: "http://localhost:11434/v1",
      keyNeeded: false,
      local: true,
      docsUrl: "https://ollama.com",
      note: "Runs models on this computer, free. The list shows the models you have pulled.",
      liveModels: { url: "http://localhost:11434/v1/models", format: "openai" },
      models: [],
    },
    {
      id: "lm-studio",
      name: "LM Studio (on this computer)",
      baseUrl: "http://localhost:1234/v1",
      keyNeeded: false,
      local: true,
      docsUrl: "https://lmstudio.ai",
      note: "Runs models on this computer, free. Start its local server first.",
      liveModels: { url: "http://localhost:1234/v1/models", format: "openai" },
      models: [],
    },
  ],
};

/** A catalog address with its placeholders filled; unfilled ones stay as {key}, which the form refuses. */
export function fillBaseUrl(template: string, values: Record<string, string>): string {
  return template.replace(/\{([a-zA-Z]+)\}/g, (whole, key: string) => values[key]?.trim() || whole);
}

/** A model a provider's live list offers: OpenRouter's (with prices) or a local server's. */
export interface LiveModel {
  id: string;
  name: string;
  contextTokens?: number;
  /** USD micros per million tokens, when the list says. */
  price?: { inputMicrosPerMillion: number; outputMicrosPerMillion: number };
}

/** Reads a provider's model list (untrusted JSON from the network) into live models, skipping what does not fit. */
export function readLiveModels(format: "openrouter" | "openai", body: unknown): LiveModel[] {
  const data = typeof body === "object" && body !== null && "data" in body ? (body as { data: unknown }).data : [];
  if (!Array.isArray(data)) return [];
  const out: LiveModel[] = [];
  for (const raw of data as unknown[]) {
    if (typeof raw !== "object" || raw === null) continue;
    const item = raw as Record<string, unknown>;
    if (typeof item.id !== "string" || !item.id) continue;
    const model: LiveModel = { id: item.id, name: typeof item.name === "string" && item.name ? item.name : item.id };
    if (format === "openrouter") {
      if (typeof item.context_length === "number" && item.context_length > 0) model.contextTokens = item.context_length;
      const pricing = item.pricing as Record<string, unknown> | undefined;
      // OpenRouter gives USD per token as strings.
      const perToken = (v: unknown) => (typeof v === "string" && v.trim() !== "" ? Number(v) : NaN);
      const input = perToken(pricing?.prompt),
        output = perToken(pricing?.completion);
      if (Number.isFinite(input) && Number.isFinite(output) && input >= 0 && output >= 0)
        model.price = {
          inputMicrosPerMillion: Math.round(input * 1_000_000 * 1_000_000),
          outputMicrosPerMillion: Math.round(output * 1_000_000 * 1_000_000),
        };
    }
    out.push(model);
  }
  return out;
}
