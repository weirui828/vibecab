import type { Dispatch, SetStateAction } from "react";
import type { Settings } from "../../../../contract/generated/index.js";

type Defaults = Settings["sessions"][string];

export function AgentDefaults({
  value,
  original,
  onChange,
  onSave,
}: {
  value: Defaults;
  original: Defaults;
  onChange: Dispatch<SetStateAction<Defaults>>;
  onSave: (patch: Record<string, unknown>) => void;
}) {
  const set = <K extends keyof Defaults>(key: K, next: Defaults[K]) =>
    onChange((current) => ({ ...current, [key]: next }));
  return (
    <section aria-label="Agent settings">
      <label>
        Reply trigger
        <select
          aria-label="Default reply trigger"
          value={value.replyTrigger ?? "manual"}
          onChange={(event) => set("replyTrigger", event.target.value as "realtime" | "batch" | "manual")}
        >
          <option value="realtime">Realtime</option>
          <option value="batch">Batch</option>
          <option value="manual">Manual</option>
        </select>
      </label>
      <label>
        Batch comment threshold
        <input
          aria-label="Batch comment threshold"
          type="number"
          min="1"
          value={value.batchCommentThreshold ?? 5}
          onChange={(event) => set("batchCommentThreshold", Number(event.target.value))}
        />
      </label>
      <label>
        Batch idle minutes
        <input
          aria-label="Batch idle minutes"
          type="number"
          min="0.1"
          step="0.1"
          value={value.batchIdleMinutes ?? 10}
          onChange={(event) => set("batchIdleMinutes", Number(event.target.value))}
        />
      </label>
      <label>
        Update idle minutes
        <input
          aria-label="Update idle minutes"
          type="number"
          min="0.1"
          step="0.1"
          value={value.updateIdleMinutes ?? 2}
          onChange={(event) => set("updateIdleMinutes", Number(event.target.value))}
        />
      </label>
      <label>
        <input
          aria-label="Review Update plans by default"
          type="checkbox"
          checked={value.planReview ?? false}
          onChange={(event) => set("planReview", event.target.checked)}
        />
        Review Update plans
      </label>
      <label>
        Agent profile
        <textarea
          aria-label="Agent profile"
          value={value.agentProfile ?? ""}
          onChange={(event) => set("agentProfile", event.target.value)}
        />
      </label>
      <label>
        Brief
        <textarea
          aria-label="Agent brief"
          value={value.brief ?? ""}
          onChange={(event) => set("brief", event.target.value)}
        />
      </label>
      <button
        onClick={() => {
          const patch = Object.fromEntries(
            Object.entries(value).filter(
              ([key, item]) => JSON.stringify(item) !== JSON.stringify(Reflect.get(original, key)),
            ),
          );
          onSave(patch);
        }}
      >
        Save agent defaults
      </button>
    </section>
  );
}
