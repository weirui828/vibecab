import { useState } from "react";
import { Button } from "@wei/design-system";
import type { AppState } from "../bridge/webBridge.js";
import { relativeTime } from "../ui/time.js";

const when = (iso: string) =>
  `${new Date(iso).toLocaleString(undefined, { dateStyle: "medium", timeStyle: "short" })} (${relativeTime(iso)})`;

/**
 * The engine behind the app: when it started and when its code was built. An engine older than the build on
 * disk refuses what the new app sends, so it says so and offers a restart.
 */
export function EngineFacts({ engine, onRestart }: { engine: AppState["engine"]; onRestart(): Promise<void> }) {
  const [busy, setBusy] = useState(false);
  if (engine === undefined) return null;
  if (engine === null) return <p className="vc-muted small">The engine does not run.</p>;
  return (
    <div className="vc-engine-facts">
      <dl>
        <div>
          <dt>Engine started</dt>
          <dd>{when(engine.startedAt)}</dd>
        </div>
        {engine.builtAt && (
          <div>
            <dt>Engine code built</dt>
            <dd>{when(engine.builtAt)}</dd>
          </div>
        )}
      </dl>
      {engine.outdated && (
        <p className="vc-warning" role="status">
          The engine runs older code than this app. Restart the engine to use the new code.
        </p>
      )}
      <Button
        size="sm"
        variant={engine.outdated ? "secondary" : "ghost"}
        loading={busy}
        onClick={() => {
          setBusy(true);
          void onRestart().finally(() => setBusy(false));
        }}
      >
        Restart engine
      </Button>
    </div>
  );
}
