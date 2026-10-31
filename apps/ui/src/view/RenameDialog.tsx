import { useState } from "react";
import { Button } from "@wei/design-system";

export type RenameTarget = { kind: "artifact" | "session"; id: string; title: string };

export function RenameDialog({
  title,
  onCancel,
  onSave,
}: {
  title: string;
  onCancel: () => void;
  onSave: (title: string) => void;
}) {
  const [name, setName] = useState(title);
  return (
    <div className="rename-backdrop">
      <section role="dialog" aria-modal="true" aria-labelledby="rename-heading" className="rename-dialog">
        <form
          onSubmit={(event) => {
            event.preventDefault();
            if (name.trim()) onSave(name);
          }}
        >
          <h2 id="rename-heading">Rename</h2>
          <label className="field">
            <span>Name</span>
            <input autoFocus value={name} onChange={(event) => setName(event.target.value)} />
          </label>
          <div className="rename-actions">
            <Button variant="secondary" type="button" onClick={onCancel}>
              Cancel
            </Button>
            <Button variant="primary" type="submit" disabled={!name.trim()}>
              Save name
            </Button>
          </div>
        </form>
      </section>
    </div>
  );
}
