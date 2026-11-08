import { useEffect, useId, useMemo, useRef, useState } from "react";
import { Button, Field, Input } from "@wei/design-system";
import type { ProviderModel as ContractProviderModel } from "../../../../contract/generated/index.js";
import { fillBaseUrl, providerCatalog } from "../../../../contract/src/provider-catalog.js";
import type { LiveModel } from "../../../../contract/src/provider-catalog.js";
import { useBridge, useLiveQuery } from "../live/LiveStore.js";
import { useToast } from "../ui/Toast.js";
import { dollars, toMicros, useRun } from "./common.js";

type ProviderModel = ContractProviderModel;
export interface SettingsShape {
  models?: Record<string, ProviderModel>;
  budgets?: { realtimeDebounceSeconds?: number; defaultTurnLimitMicros?: number; toolCallLimit?: number };
  trashRetentionDays?: number;
}

const CUSTOM = "custom";
const providers = providerCatalog.providers;
type CatalogProvider = (typeof providers)[number];

/** Which catalog provider a saved model came from: its own record, else the provider whose address it uses. */
function providerOf(model: ProviderModel | undefined): string {
  if (!model) return "openai";
  if (model.catalogProvider && providers.some((p) => p.id === model.catalogProvider)) return model.catalogProvider;
  return providers.find((p) => !p.placeholders?.length && p.baseUrl === model.baseUrl)?.id ?? CUSTOM;
}

/** Reads placeholder values back out of a filled address, so editing a saved model keeps them. */
function placeholderValues(template: string, url: string): Record<string, string> {
  const keys: string[] = [];
  const pattern = template.replace(/[.*+?^$()|[\]\\]/g, "\\$&").replace(/\\?\{([a-zA-Z]+)\\?\}/g, (_, key: string) => {
    keys.push(key);
    return "([^/]+)";
  });
  const match = new RegExp("^" + pattern + "$").exec(url);
  return match ? Object.fromEntries(keys.map((k, i) => [k, match[i + 1] ?? ""])) : {};
}

const price = (micros: number) => "$" + dollars(micros);

/**
 * The default model: a built-in provider (or any OpenAI-compatible address), a model from its list or typed in, and
 * its key. Address, context and price come from the catalog or the provider's live list; "More details" changes
 * them, and a price changed by hand is kept as yours. The key goes to the engine's key store and is never shown again.
 * Used by Settings and by the first run.
 */
export function ModelForm({ onSaved, submitLabel = "Save" }: { onSaved?(): void; submitLabel?: string }) {
  const settings = useLiveQuery<SettingsShape>("sys.Settings", {}),
    bridge = useBridge(),
    run = useRun(),
    toast = useToast(),
    listId = useId(),
    current = settings.data?.models?.default;
  const [providerId, setProviderId] = useState("openai"),
    [places, setPlaces] = useState<Record<string, string>>({}),
    [customUrl, setCustomUrl] = useState("https://"),
    [model, setModel] = useState(""),
    [key, setKey] = useState(""),
    [context, setContext] = useState(""),
    [priceIn, setPriceIn] = useState(""),
    [priceOut, setPriceOut] = useState(""),
    [priceEdited, setPriceEdited] = useState(false),
    [live, setLive] = useState<{ provider: string; models: LiveModel[]; error?: string }>(),
    [advanced, setAdvanced] = useState(false),
    [busy, setBusy] = useState(false),
    [error, setError] = useState<string>();
  const provider: CatalogProvider | undefined = providers.find((p) => p.id === providerId);

  // The saved model fills the form while it is untouched; once the person edits, a late refresh must not undo it.
  const touched = useRef(false),
    [keyFor, setKeyFor] = useState<string>();
  useEffect(() => {
    if (!current || touched.current) return;
    setKeyFor(current.keyRef ? current.baseUrl : undefined);
    const id = providerOf(current),
      known = providers.find((p) => p.id === id);
    setProviderId(id);
    setPlaces(known ? placeholderValues(known.baseUrl, current.baseUrl) : {});
    setCustomUrl(current.baseUrl);
    setModel(current.model);
    setContext(String(current.capabilities.maxContextTokens));
    setPriceIn(dollars(current.pricing.inputMicrosPerMillion));
    setPriceOut(dollars(current.pricing.outputMicrosPerMillion));
    setPriceEdited(current.pricingSource === "custom");
  }, [current]);

  // OpenRouter and local servers say which models they have; ask once per provider.
  useEffect(() => {
    if (!provider?.liveModels || live?.provider === provider.id) return;
    let alive = true;
    void bridge.app
      .providerModels(provider.id)
      .then((result) => alive && setLive({ provider: provider.id, ...result }))
      .catch(() => alive && setLive({ provider: provider.id, models: [], error: "unreachable" }));
    return () => {
      alive = false;
    };
  }, [provider, live?.provider, bridge]);

  const liveModels = live?.provider === providerId ? live.models : [];
  const choices = useMemo(
    () => [
      ...(provider?.models ?? []).map((m) => ({
        id: m.id,
        name: m.name,
        contextTokens: m.contextTokens,
        price: m.price ?? undefined,
        tools: m.tools,
        jsonSchemaOutput: m.jsonSchemaOutput,
        note: m.note,
        source: "catalog" as const,
      })),
      ...liveModels.map((m) => ({
        ...m,
        tools: true,
        jsonSchemaOutput: false,
        note: undefined,
        source: "live" as const,
      })),
    ],
    [provider, liveModels],
  );
  const chosen = choices.find((c) => c.id === model.trim());

  // Picking a known model brings its price and context, unless the price was set by hand.
  useEffect(() => {
    if (!chosen) return;
    if (chosen.contextTokens) setContext(String(chosen.contextTokens));
    if (!priceEdited) {
      setPriceIn(chosen.price ? dollars(chosen.price.inputMicrosPerMillion) : "");
      setPriceOut(chosen.price ? dollars(chosen.price.outputMicrosPerMillion) : "");
    }
  }, [chosen, priceEdited]);

  const baseUrl = provider ? fillBaseUrl(provider.baseUrl, places) : customUrl.trim();
  const local = provider?.keyNeeded === false;
  // A saved key belongs to the address it was saved for: another provider needs its own.
  const keySaved = keyFor !== undefined && keyFor === baseUrl;

  async function save() {
    setError(undefined);
    if (/\{[a-zA-Z]+\}/.test(baseUrl)) return setError(`Type the ${provider?.placeholders?.[0]?.label ?? "address"}.`);
    try {
      new URL(baseUrl);
    } catch {
      return setError("Type the full address. It must start with https://.");
    }
    if (!model.trim()) return setError("Choose or type a model.");
    if (!local && !keySaved && !key.trim()) return setError("Paste the API key for this provider.");
    const tokens = Number(context),
      inMicros = priceIn.trim() ? toMicros(priceIn) : 0,
      outMicros = priceOut.trim() ? toMicros(priceOut) : 0;
    if (inMicros === undefined || outMicros === undefined) return setError("Prices are dollars, like 2.5.");
    setBusy(true);
    const next: ProviderModel = {
      provider: "openai-compatible",
      baseUrl,
      model: model.trim(),
      ...(current?.keyRef ? { keyRef: current.keyRef } : {}),
      capabilities: {
        tools: chosen?.tools ?? current?.capabilities.tools ?? true,
        jsonSchemaOutput: chosen?.jsonSchemaOutput ?? current?.capabilities.jsonSchemaOutput ?? true,
        streaming: true,
        reportsUsage: true,
        maxContextTokens: Number.isInteger(tokens) && tokens > 0 ? tokens : 128_000,
      },
      // 0 / 0 means "unknown": spending then shows reservations only.
      pricing: { inputMicrosPerMillion: inMicros, outputMicrosPerMillion: outMicros },
      ...(provider ? { catalogProvider: provider.id } : {}),
      pricingSource: priceEdited || !chosen?.price ? "custom" : chosen.source,
    };
    // The model first: the engine stores a key only for a model alias that exists. A local server needs no key,
    // but the engine calls only with one, so it gets a stand-in.
    let ok = (await run("sys.SetSettings", { patch: { models: { default: next } } })) !== undefined;
    const secret = key.trim() || (local && !keySaved ? "local" : "");
    if (ok && secret) ok = (await run("sys.SetProviderKey", { alias: "default", secret })) !== undefined;
    setBusy(false);
    if (ok) {
      touched.current = false;
      if (secret || keySaved) setKeyFor(baseUrl);
      setKey("");
      toast("Model saved");
      onSaved?.();
    }
  }

  return (
    <form
      className="vc-form"
      onChange={() => (touched.current = true)}
      onSubmit={(event) => {
        event.preventDefault();
        void save();
      }}
    >
      <Field label="Provider" hint={provider?.note}>
        <select
          className="vc-select"
          aria-label="Provider"
          value={providerId}
          onChange={(e) => {
            setProviderId(e.target.value);
            setPlaces({});
            setModel("");
            setPriceEdited(false);
          }}
        >
          {providers.map((p) => (
            <option key={p.id} value={p.id}>
              {p.name}
            </option>
          ))}
          <option value={CUSTOM}>Another OpenAI-compatible provider</option>
        </select>
      </Field>
      {!provider && (
        <Field label="Provider address" hint="Any provider that uses the OpenAI API.">
          <Input inputSize="lg" value={customUrl} onChange={(e) => setCustomUrl(e.target.value)} />
        </Field>
      )}
      {(provider?.placeholders ?? []).map((p) => (
        <Field key={p.key} label={p.label}>
          <Input
            inputSize="lg"
            value={places[p.key] ?? ""}
            onChange={(e) => setPlaces((now) => ({ ...now, [p.key]: e.target.value }))}
          />
        </Field>
      ))}
      <Field
        label="Model"
        hint={
          chosen
            ? [
                chosen.price
                  ? `${price(chosen.price.inputMicrosPerMillion)} in · ${price(chosen.price.outputMicrosPerMillion)} out per million tokens`
                  : local
                    ? "Free, on this computer"
                    : "The price is not known. Type it in More details.",
                chosen.contextTokens ? `${Math.round(chosen.contextTokens / 1000)}K context` : undefined,
                chosen.note,
              ]
                .filter(Boolean)
                .join(" · ")
            : live?.provider === providerId && live.error === "unreachable"
              ? local
                ? "Start the local server, then open this page again. You can also type a model name."
                : "VibeCab could not get the model list. Type a model name."
              : choices.length
                ? `${choices.length} to choose from, or type any model name.`
                : "Type the model's name as the provider writes it."
        }
      >
        <Input
          inputSize="lg"
          list={listId}
          autoComplete="off"
          placeholder={choices[0]?.id ?? "model name"}
          value={model}
          onChange={(e) => setModel(e.target.value)}
        />
      </Field>
      <datalist id={listId}>
        {choices.map((c) => (
          <option key={c.source + c.id} value={c.id}>
            {c.name}
          </option>
        ))}
      </datalist>
      {!local && (
        <Field
          label="API key"
          hint={
            keySaved
              ? "Key saved. Paste a new one only to replace it."
              : "VibeCab keeps the key on this computer. You cannot see it again."
          }
        >
          <Input
            inputSize="lg"
            type="password"
            autoComplete="off"
            placeholder={keySaved ? "••••••••" : ""}
            value={key}
            onChange={(e) => setKey(e.target.value)}
          />
        </Field>
      )}
      <button type="button" className="vc-link-button" aria-expanded={advanced} onClick={() => setAdvanced((v) => !v)}>
        {advanced ? "Fewer details" : "More details"}
      </button>
      {advanced && (
        <>
          {provider && <p className="vc-muted small vc-path">{baseUrl}</p>}
          <div className="vc-form-row">
            <Field label="Context window (tokens)">
              <Input inputMode="numeric" value={context} onChange={(e) => setContext(e.target.value)} />
            </Field>
            <Field label="Input price ($ per 1 million tokens)">
              <Input
                inputMode="decimal"
                value={priceIn}
                onChange={(e) => {
                  setPriceIn(e.target.value);
                  setPriceEdited(true);
                }}
              />
            </Field>
            <Field label="Output price ($ per 1 million tokens)">
              <Input
                inputMode="decimal"
                value={priceOut}
                onChange={(e) => {
                  setPriceOut(e.target.value);
                  setPriceEdited(true);
                }}
              />
            </Field>
          </div>
          {provider?.pricingUrl && (
            <p className="vc-muted small">
              Prices from{" "}
              <a href={provider.pricingUrl} target="_blank" rel="noreferrer">
                {provider.name}'s pricing page
              </a>
              , checked {providerCatalog.checkedAt}. A price you change here is kept as yours.
            </p>
          )}
        </>
      )}
      {error && (
        <p className="vc-error" role="alert">
          {error}
        </p>
      )}
      <div className="vc-form-actions">
        <Button type="submit" variant="primary" loading={busy}>
          {submitLabel}
        </Button>
      </div>
    </form>
  );
}
