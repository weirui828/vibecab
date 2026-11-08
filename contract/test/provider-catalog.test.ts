import { expect, it } from "vitest";
import { Contract } from "../src/index.js";
import { fillBaseUrl, providerCatalog, readLiveModels } from "../src/provider-catalog.js";

it("the built-in provider catalog fits its schema, and every price says where it came from", () => {
  expect(() => new Contract().read("provider-catalog", providerCatalog)).not.toThrow();
  expect(providerCatalog.checkedAt).toMatch(/^\d{4}-\d{2}-\d{2}$/);
  const ids = providerCatalog.providers.map((p) => p.id);
  expect(new Set(ids).size).toBe(ids.length);
  for (const provider of providerCatalog.providers) {
    // A provider with prices names the page they were read from; one without a list has a live list or a note.
    if (provider.models.some((m) => m.price)) expect(provider.pricingUrl).toMatch(/^https:\/\//);
    if (provider.models.length === 0) expect(provider.liveModels ?? provider.note).toBeTruthy();
    // An unread price is said out loud, not left as zero.
    if (provider.models.some((m) => m.price === null)) expect(provider.note).toMatch(/enter/i);
    for (const p of provider.placeholders ?? []) expect(provider.baseUrl).toContain(`{${p.key}}`);
  }
  for (const id of [
    "openai",
    "anthropic",
    "gemini",
    "openrouter",
    "cloudflare-workers-ai",
    "cloudflare-ai-gateway",
    "ollama",
  ])
    expect(ids).toContain(id);
});

it("fills an address's placeholders and leaves unfilled ones visible", () => {
  const template = "https://api.cloudflare.com/client/v4/accounts/{account}/ai/v1";
  expect(fillBaseUrl(template, { account: " abc123 " })).toBe(
    "https://api.cloudflare.com/client/v4/accounts/abc123/ai/v1",
  );
  expect(fillBaseUrl(template, {})).toContain("{account}");
});

it("reads a provider's live model list, turning OpenRouter's per-token prices into micros per million", () => {
  const models = readLiveModels("openrouter", {
    data: [
      {
        id: "acme/swift-1",
        name: "Acme: Swift 1",
        context_length: 200000,
        pricing: { prompt: "0.0000005", completion: "0.0000015" },
      },
      { id: "acme/free", pricing: { prompt: "0", completion: "0" } },
      { id: 7 },
      "junk",
    ],
  });
  expect(models).toEqual([
    {
      id: "acme/swift-1",
      name: "Acme: Swift 1",
      contextTokens: 200000,
      price: { inputMicrosPerMillion: 500_000, outputMicrosPerMillion: 1_500_000 },
    },
    { id: "acme/free", name: "acme/free", price: { inputMicrosPerMillion: 0, outputMicrosPerMillion: 0 } },
  ]);
  expect(readLiveModels("openai", { data: [{ id: "llama-local:8b" }] })).toEqual([
    { id: "llama-local:8b", name: "llama-local:8b" },
  ]);
  expect(readLiveModels("openai", { error: "nope" })).toEqual([]);
});
