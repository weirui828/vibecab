import { useState } from "react";
import { Button, Field, Icon, Input } from "@wei/design-system";
import { terms } from "../../../ui/src/copy/terms.js";
import { Hills } from "../ui/Brand.js";
import { useDialogs } from "../home/DialogHost.js";
import { ModelForm } from "./ModelForm.js";
import { toMicros, useRun } from "./common.js";

type Step = "welcome" | "model" | "limit" | "draft";
const order: Step[] = ["welcome", "model", "limit", "draft"];

/**
 * The first visit to an empty workspace without a model: welcome, model, daily limit, first Draft. Every step but
 * the last can be skipped; agent features then say "Add a model in Settings".
 */
export function FirstRun({ onDone }: { onDone(): void }) {
  const [step, setStep] = useState<Step>("welcome"),
    [limit, setLimit] = useState(""),
    run = useRun(),
    dialogs = useDialogs();
  const next = () => setStep(order[order.indexOf(step) + 1] ?? "draft");
  return (
    <div className="vc-page vc-first-run">
      <ol className="vc-dots" aria-label="Steps">
        {order.map((s) => (
          <li key={s} aria-current={s === step ? "step" : undefined} />
        ))}
      </ol>
      {step === "welcome" && (
        <div className="vc-empty">
          <Hills />
          <h1 className="vc-display">Welcome to VibeCab.</h1>
          <p>
            You write comments. The agent replies. It changes only the text that you agree to. Nothing changes until you
            agree.
          </p>
          <Button variant="primary" size="lg" onClick={next}>
            Get started
          </Button>
        </div>
      )}
      {step === "model" && (
        <div className="vc-step">
          <p className="vc-label">1 of 3</p>
          <h1 className="vc-display">Choose a model</h1>
          <p className="vc-muted">Any provider that speaks the OpenAI API. You can change this any time in Settings.</p>
          <ModelForm submitLabel="Save and continue" onSaved={next} />
          <button type="button" className="vc-link-button" onClick={next}>
            Skip for now
          </button>
        </div>
      )}
      {step === "limit" && (
        <form
          className="vc-step"
          onSubmit={(e) => {
            e.preventDefault();
            const micros = limit.trim() ? toMicros(limit) : undefined;
            if (micros === undefined) return next();
            void run("sys.SetBudget", { account: { kind: "daily" }, limitMicros: micros }).then((ok) => ok && next());
          }}
        >
          <p className="vc-label">2 of 3</p>
          <h1 className="vc-display">A daily limit</h1>
          <p className="vc-muted">
            When you reach this limit, VibeCab stops model calls for the day. This limit is optional.
          </p>
          <Field label="Dollars per day">
            <Input
              inputSize="lg"
              inputMode="decimal"
              placeholder="5"
              value={limit}
              onChange={(e) => setLimit(e.target.value)}
            />
          </Field>
          <div className="vc-form-actions start">
            <Button type="submit" variant="primary">
              Continue
            </Button>
            <Button type="button" variant="ghost" onClick={next}>
              Skip
            </Button>
          </div>
        </form>
      )}
      {step === "draft" && (
        <div className="vc-step">
          <p className="vc-label">3 of 3</p>
          <h1 className="vc-display">Your first {terms.draft.toLowerCase()}</h1>
          <p className="vc-muted">Start from a blank page or import a Markdown file.</p>
          <div className="vc-form-actions start">
            <Button
              variant="primary"
              size="lg"
              leadingIcon={<Icon name="plus" />}
              onClick={() => {
                onDone();
                dialogs.newDraft();
              }}
            >
              New {terms.draft.toLowerCase()}
            </Button>
            <Button variant="ghost" onClick={onDone}>
              Later
            </Button>
          </div>
        </div>
      )}
    </div>
  );
}
