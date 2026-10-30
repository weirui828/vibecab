import { useEffect, useState } from "react";
import type { ProviderModel, Settings } from "../../../../contract/generated/index.js";

export function Spending({ settings, onSave }: { settings?: Settings; onSave: (limitMicros: number | null) => void }) {
  const [limit, setLimit] = useState("");
  const [usage, setUsage] = useState<{
    accounts: Array<{
      account: { kind: string; key?: string };
      limitMicros: number | null;
      usedMicros: number;
      reservedMicros: number;
    }>;
    calls: Array<{
      callId: string;
      alias: string;
      model: string;
      usageQuality: string;
      finishReason: string;
      settledMicros: number;
      createdAt: string;
    }>;
  }>();
  useEffect(() => {
    void window.vibecab.query<typeof usage>("sys.Usage", {}).then((value) => {
      if (value) setUsage(value);
    });
  }, []);
  const timezone = settings?.budgets.localTimeZone ?? "UTC",
    today = dateInZone(new Date(), timezone),
    calls = usage?.calls ?? [],
    todayMicros = calls
      .filter((call) => dateInZone(new Date(call.createdAt), timezone) === today)
      .reduce((total, call) => total + call.settledMicros, 0),
    monthMicros = calls
      .filter((call) => dateInZone(new Date(call.createdAt), timezone).startsWith(today.slice(0, 7)))
      .reduce((total, call) => total + call.settledMicros, 0);
  return (
    <section aria-label="Spending settings">
      <label>
        Daily limit (micro-units)
        <input aria-label="Daily limit" value={limit} onChange={(event) => setLimit(event.target.value)} />
      </label>
      <button onClick={() => onSave(Number(limit) || null)}>Save daily limit</button>
      <p>Default turn limit {settings?.budgets.defaultTurnLimitMicros ?? 0}</p>
      <p>Today's usage: {todayMicros} micro-units</p>
      <p>This month's usage: {monthMicros} micro-units</p>
      {usage?.accounts
        .filter((item) => item.account.kind === "daily")
        .map((item) => (
          <p key={item.account.key ?? item.account.kind}>
            {item.usedMicros} used / {item.limitMicros ?? "unlimited"} daily limit
          </p>
        ))}
      <h3>Recent calls</h3>
      {calls
        .slice(-10)
        .reverse()
        .map((call) => (
          <p key={call.callId} className={call.usageQuality === "unknown" ? "uncertain-usage" : undefined}>
            {call.model} · {call.alias} · {call.settledMicros} ·{" "}
            {call.usageQuality === "unknown"
              ? "Uncertain usage — provider did not report token counts"
              : call.usageQuality}
          </p>
        ))}
    </section>
  );
}

function dateInZone(date: Date, timezone: string): string {
  return new Intl.DateTimeFormat("en-CA", {
    timeZone: timezone,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).format(date);
}

export function ModelAdvanced({ model, onSave }: { model: ProviderModel; onSave: (model: ProviderModel) => void }) {
  const [draft, setDraft] = useState(model);
  useEffect(() => setDraft(model), [model]);
  return (
    <details>
      <summary>Capabilities and pricing</summary>
      {(["tools", "jsonSchemaOutput", "streaming", "reportsUsage"] as const).map((field) => (
        <label key={field}>
          <input
            type="checkbox"
            aria-label={field}
            checked={draft.capabilities[field]}
            onChange={(event) =>
              setDraft((current) => ({
                ...current,
                capabilities: { ...current.capabilities, [field]: event.target.checked },
              }))
            }
          />
          {field}
        </label>
      ))}
      <label>
        Maximum context tokens
        <input
          aria-label="Maximum context tokens"
          type="number"
          value={draft.capabilities.maxContextTokens}
          onChange={(event) =>
            setDraft((current) => ({
              ...current,
              capabilities: { ...current.capabilities, maxContextTokens: Number(event.target.value) },
            }))
          }
        />
      </label>
      <label>
        Input price per million tokens (micro-units)
        <input
          aria-label="Input price"
          type="number"
          value={draft.pricing.inputMicrosPerMillion}
          onChange={(event) =>
            setDraft((current) => ({
              ...current,
              pricing: { ...current.pricing, inputMicrosPerMillion: Number(event.target.value) },
            }))
          }
        />
      </label>
      <label>
        Output price per million tokens (micro-units)
        <input
          aria-label="Output price"
          type="number"
          value={draft.pricing.outputMicrosPerMillion}
          onChange={(event) =>
            setDraft((current) => ({
              ...current,
              pricing: { ...current.pricing, outputMicrosPerMillion: Number(event.target.value) },
            }))
          }
        />
      </label>
      <button onClick={() => onSave(draft)}>Save capabilities and pricing</button>
    </details>
  );
}

export function AliasModel({
  alias,
  model,
  fallback,
  onSave,
}: {
  alias: string;
  model?: ProviderModel;
  fallback?: ProviderModel;
  onSave: (model: ProviderModel) => void;
}) {
  const [name, setName] = useState(model?.model ?? fallback?.model ?? ""),
    [baseUrl, setBaseUrl] = useState(model?.baseUrl ?? fallback?.baseUrl ?? "");
  useEffect(() => {
    setName(model?.model ?? fallback?.model ?? "");
    setBaseUrl(model?.baseUrl ?? fallback?.baseUrl ?? "");
  }, [model, fallback]);
  return (
    <fieldset>
      <legend>{alias}</legend>
      <label>
        Model
        <input aria-label={`${alias} model`} value={name} onChange={(event) => setName(event.target.value)} />
      </label>
      <label>
        Base URL
        <input aria-label={`${alias} base URL`} value={baseUrl} onChange={(event) => setBaseUrl(event.target.value)} />
      </label>
      <button
        disabled={!fallback}
        onClick={() => {
          if (model) onSave({ ...model, model: name, baseUrl });
          else if (fallback) onSave({ ...fallback, model: name, baseUrl });
        }}
      >
        Save {alias} model
      </button>
    </fieldset>
  );
}
