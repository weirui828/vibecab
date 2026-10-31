import { useState } from "react";
import { Button, Spinner } from "@wei/design-system";
import { Mark } from "./Brand.js";

export function Onboarding({
  onSkip,
  onSave,
}: {
  onSkip: () => void;
  onSave: (baseUrl: string, model: string, key: string) => Promise<void>;
}) {
  const [step, setStep] = useState(0),
    [baseUrl, setBaseUrl] = useState("https://api.openai.com/v1"),
    [model, setModel] = useState(""),
    [key, setKey] = useState(""),
    [saving, setSaving] = useState(false),
    [error, setError] = useState("");
  return (
    <section className="onboarding" aria-label="Welcome">
      {step === 0 ? (
        <>
          <Mark width={132} />
          <p className="eyebrow">Welcome</p>
          <h2>Think together, one comment at a time.</h2>
          <p>VibeCab keeps your drafts and conversations in one private workspace.</p>
          <Button variant="primary" onClick={() => setStep(1)}>
            Get started
          </Button>
        </>
      ) : (
        <>
          <p className="eyebrow">Model setup · optional</p>
          <h2>Add a model</h2>
          <div className="form">
            <label>
              Base URL
              <input value={baseUrl} onChange={(event) => setBaseUrl(event.target.value)} />
            </label>
            <label>
              Model name
              <input value={model} onChange={(event) => setModel(event.target.value)} />
            </label>
            <label>
              API key
              <input type="password" value={key} onChange={(event) => setKey(event.target.value)} />
            </label>
          </div>
          {error ? <p role="alert">{error}</p> : null}
          <p className="notice">Daily spending limits can be set later in Settings.</p>
          <p className="notice">
            Connection testing is not available yet. You can still save the model and try it later.
          </p>
          <div className="row">
            <Button variant="secondary" onClick={onSkip}>
              Skip for now
            </Button>
            <Button
              variant="primary"
              disabled={!model || !key || saving}
              onClick={() => {
                setSaving(true);
                void onSave(baseUrl, model, key)
                  .catch((reason) => setError(String(reason)))
                  .finally(() => {
                    setKey("");
                    setSaving(false);
                  });
              }}
            >
              {saving ? <Spinner size="sm" /> : "Save and continue"}
            </Button>
          </div>
        </>
      )}
    </section>
  );
}
