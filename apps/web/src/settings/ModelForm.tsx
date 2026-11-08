import { useEffect, useState } from "react";
import { Button, Field, Input } from "@wei/design-system";
import { useLiveQuery } from "../live/LiveStore.js";
import { useToast } from "../ui/Toast.js";
import { toMicros, useRun } from "./common.js";

interface ProviderModel {
  provider: "openai-compatible";
  baseUrl: string;
  model: string;
  keyRef?: string;
  capabilities: {
    tools: boolean;
    jsonSchemaOutput: boolean;
    streaming: boolean;
    maxContextTokens: number;
    reportsUsage: boolean;
  };
  pricing?: { inputMicrosPerMillion: number; outputMicrosPerMillion: number };
}
export interface SettingsShape {
  models?: Record<string, ProviderModel>;
  budgets?: { realtimeDebounceSeconds?: number; defaultTurnLimitMicros?: number; toolCallLimit?: number };
  trashRetentionDays?: number;
}

const defaults: ProviderModel["capabilities"] = {
  tools: true,
  jsonSchemaOutput: true,
  streaming: true,
  maxContextTokens: 128_000,
  reportsUsage: true,
};

/**
 * The default model: where it lives, its name and its key. The key goes to the engine's key store and is never
 * shown again; only "Key saved" is. Used by Settings and by the first run.
 */
export function ModelForm({ onSaved, submitLabel = "Save" }: { onSaved?(): void; submitLabel?: string }) {
  const settings = useLiveQuery<SettingsShape>("sys.Settings", {}),
    run = useRun(),
    toast = useToast(),
    current = settings.data?.models?.default;
  const [baseUrl, setBaseUrl] = useState("https://api.openai.com/v1"),
    [model, setModel] = useState(""),
    [key, setKey] = useState(""),
    [context, setContext] = useState("128000"),
    [priceIn, setPriceIn] = useState(""),
    [priceOut, setPriceOut] = useState(""),
    [advanced, setAdvanced] = useState(false),
    [busy, setBusy] = useState(false),
    [error, setError] = useState<string>();
  useEffect(() => {
    if (!current) return;
    setBaseUrl(current.baseUrl);
    setModel(current.model);
    setContext(String(current.capabilities.maxContextTokens));
    if (current.pricing) {
      setPriceIn(String(current.pricing.inputMicrosPerMillion / 1_000_000));
      setPriceOut(String(current.pricing.outputMicrosPerMillion / 1_000_000));
    }
  }, [current]);
  async function save() {
    setError(undefined);
    try {
      new URL(baseUrl);
    } catch {
      return setError("Enter the full address, starting with https://");
    }
    if (!model.trim()) return setError("Name the model, for example gpt-5.");
    if (!current?.keyRef && !key.trim()) return setError("Paste the API key for this provider.");
    const tokens = Number(context);
    setBusy(true);
    let keyRef = current?.keyRef;
    if (key.trim()) {
      const saved = await run<{ keyRef: string }>("sys.SetProviderKey", { alias: "default", secret: key.trim() });
      keyRef = saved?.keyRef;
    }
    const inMicros = priceIn ? toMicros(priceIn) : undefined,
      outMicros = priceOut ? toMicros(priceOut) : undefined;
    const next: ProviderModel = {
      provider: "openai-compatible",
      baseUrl,
      model: model.trim(),
      ...(keyRef ? { keyRef } : {}),
      capabilities: {
        ...(current?.capabilities ?? defaults),
        maxContextTokens: Number.isInteger(tokens) && tokens > 0 ? tokens : 128_000,
      },
      ...(inMicros !== undefined && outMicros !== undefined
        ? { pricing: { inputMicrosPerMillion: inMicros, outputMicrosPerMillion: outMicros } }
        : current?.pricing
          ? { pricing: current.pricing }
          : {}),
    };
    const ok = keyRef !== undefined && (await run("sys.SetSettings", { patch: { models: { default: next } } }));
    setBusy(false);
    if (ok) {
      setKey("");
      toast("Model saved");
      onSaved?.();
    }
  }
  return (
    <form
      className="vc-form"
      onSubmit={(event) => {
        event.preventDefault();
        void save();
      }}
    >
      <Field label="Provider address" hint="Any service that speaks the OpenAI API.">
        <Input inputSize="lg" value={baseUrl} onChange={(e) => setBaseUrl(e.target.value)} />
      </Field>
      <Field label="Model">
        <Input inputSize="lg" placeholder="gpt-5" value={model} onChange={(e) => setModel(e.target.value)} />
      </Field>
      <Field
        label="API key"
        hint={
          current?.keyRef
            ? "Key saved. Paste a new one only to replace it."
            : "Stored by VibeCab on this computer; never shown again."
        }
      >
        <Input
          inputSize="lg"
          type="password"
          autoComplete="off"
          placeholder={current?.keyRef ? "••••••••" : ""}
          value={key}
          onChange={(e) => setKey(e.target.value)}
        />
      </Field>
      <button type="button" className="vc-link-button" aria-expanded={advanced} onClick={() => setAdvanced((v) => !v)}>
        {advanced ? "Fewer details" : "More details"}
      </button>
      {advanced && (
        <div className="vc-form-row">
          <Field label="Context window (tokens)">
            <Input inputMode="numeric" value={context} onChange={(e) => setContext(e.target.value)} />
          </Field>
          <Field label="$ per million tokens in">
            <Input inputMode="decimal" value={priceIn} onChange={(e) => setPriceIn(e.target.value)} />
          </Field>
          <Field label="$ per million tokens out">
            <Input inputMode="decimal" value={priceOut} onChange={(e) => setPriceOut(e.target.value)} />
          </Field>
        </div>
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
