import { Button } from "@wei/design-system";
import { terms } from "../copy/terms.js";

export function HelpView({
  onBack,
  onIdeas,
  onDrafts,
}: {
  onBack: () => void;
  onIdeas: () => void;
  onDrafts: () => void;
}) {
  return (
    <div className="page help-page">
      <header className="page-header">
        <div>
          <p className="eyebrow">A quick guide</p>
          <h1 className="page-title">How to use VibeCab</h1>
          <p className="meta">Two ways to work together. Your work is saved as you go.</p>
        </div>
        <Button variant="secondary" onClick={onBack}>
          Back
        </Button>
      </header>
      <section className="help-flow">
        <p className="eyebrow">Improve a Draft</p>
        <ol>
          <li>Choose or import a {terms.draft.toLowerCase()}.</li>
          <li>Start a {terms.session.toLowerCase()} to discuss changes and work through suggestions.</li>
          <li>
            Pause and come back later, or end when you’re done. The improved {terms.draft.toLowerCase()} stays saved.
          </li>
        </ol>
        <Button variant="secondary" onClick={onDrafts}>
          Choose a Draft
        </Button>
      </section>
      <section className="help-flow">
        <p className="eyebrow">Explore Ideas</p>
        <ol>
          <li>Capture thoughts in your {terms.idea.toLowerCase()} inbox.</li>
          <li>
            Choose a few {terms.idea.toLowerCase()}s and explore them in a {terms.session.toLowerCase()}.
          </li>
          <li>
            When a direction is worth pursuing, create a {terms.project.toLowerCase()} and bring in the related{" "}
            {terms.idea.toLowerCase()}s and {terms.draft.toLowerCase()}s.
          </li>
        </ol>
        <Button variant="secondary" onClick={onIdeas}>
          Browse Ideas
        </Button>
      </section>
      <p className="help-note">
        Projects are optional. Drafts and Sessions can stand on their own or be organized into Projects.
      </p>
    </div>
  );
}
