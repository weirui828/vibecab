import { useMemo, useState } from "react";
import { Button } from "@wei/design-system";
import type { DiffResult, Element } from "../../../../contract/generated/index.js";
import { errorMessage } from "../../../ui/src/copy/errors.js";
import { useBridge, useLiveQuery } from "../live/LiveStore.js";
import { DocumentView } from "../document/DocumentView.js";
import { useToast } from "../ui/Toast.js";
import { newCommandId } from "../bridge/webBridge.js";

/** An older version, read-only, with a way back, a comparison with the latest, and restore. */
export function VersionView({
  artifactId,
  version,
  head,
  readOnly,
  onBack,
}: {
  artifactId: string;
  version: number;
  head: number;
  readOnly: boolean;
  onBack(): void;
}) {
  const bridge = useBridge(),
    toast = useToast(),
    [comparing, setComparing] = useState(false),
    [confirming, setConfirming] = useState(false),
    [busy, setBusy] = useState(false);
  const old = useLiveQuery<Element[]>("vc.Elements", { artifactId, version }),
    latest = useLiveQuery<Element[]>("vc.Elements", { artifactId }, comparing),
    diff = useLiveQuery<DiffResult>("vc.Diff", { artifactId, from: version, to: head }, comparing);
  const docDiff = useMemo(
    () =>
      comparing && diff.data && old.data
        ? { result: diff.data, removed: old.data.filter((e) => diff.data!.removed.includes(e.elementId)) }
        : undefined,
    [comparing, diff.data, old.data],
  );
  async function restore() {
    setBusy(true);
    const result = await bridge.command("vc.RestoreVersion", { artifactId, version }, newCommandId());
    setBusy(false);
    if (!result.ok) return toast(errorMessage(result.error.code));
    toast(`Version ${(result.result as { version: number }).version} has the content of version ${version}`);
    onBack();
  }
  const shown = comparing ? latest.data : old.data;
  return (
    <div className="vc-changes">
      <div className="vc-strip" data-tone="done" role="region" aria-label="Older version">
        <span className="dot" aria-hidden="true" />
        <span className="text">
          <span className="lead">{comparing ? `Version ${version} → ${head}` : `Viewing version ${version}`}</span>
          <span className="vc-facts">{comparing ? "what changed since" : "read only"}</span>
        </span>
        <span className="actions">
          {confirming ? (
            <>
              <Button size="sm" variant="ghost" onClick={() => setConfirming(false)}>
                Cancel
              </Button>
              <Button size="sm" variant="primary" loading={busy} onClick={() => void restore()}>
                Restore
              </Button>
            </>
          ) : (
            <>
              <Button size="sm" variant="ghost" onClick={() => setComparing((v) => !v)}>
                {comparing ? `Show version ${version}` : "Compare with latest"}
              </Button>
              {!readOnly && (
                <Button size="sm" variant="secondary" onClick={() => setConfirming(true)}>
                  Restore this version
                </Button>
              )}
              <Button size="sm" variant="primary" onClick={onBack}>
                Back to latest
              </Button>
            </>
          )}
        </span>
        {confirming && (
          <p className="vc-strip-note">
            Creates version {head + 1} with the content of version {version}. Nothing is lost.
          </p>
        )}
      </div>
      {shown && (!comparing || docDiff) ? (
        <DocumentView elements={shown} blobUrl={bridge.blobUrl} diff={docDiff} />
      ) : null}
    </div>
  );
}
