import { useEffect, useState } from "react";
import { Button, Checkbox } from "@wei/design-system";
import { errorMessage } from "../../../ui/src/copy/errors.js";
import { useBridge } from "../live/LiveStore.js";
import { Dialog } from "../ui/Dialog.js";
import { newCommandId } from "../bridge/webBridge.js";
import type { WebBridge } from "../bridge/webBridge.js";

export type ExportTarget = { artifactId: string; version?: number } | { outputSetId: string };
type Format = "markdown" | "html" | "json";
const extension: Record<Format, string> = { markdown: "md", html: "html", json: "json" };

interface ExportRecord {
  exportId: string;
  status: "queued" | "completed" | "failed";
  blobHash?: string;
  error?: string;
}

/** A file name from a title: letters, digits and dashes, never empty. */
export function fileName(title: string, format: Format): string {
  const base =
    title
      .normalize("NFKD")
      .replace(/[^\p{L}\p{N}]+/gu, "-")
      .replace(/^-+|-+$/g, "")
      .slice(0, 80) || "vibecab-export";
  return `${base}.${extension[format]}`;
}

/** Runs an export to completion and returns its bytes. Exported for tests. */
export async function runExport(
  bridge: WebBridge,
  target: ExportTarget,
  format: Format,
  include: { threads: boolean; decisionRecord: boolean },
  timeoutMs = 30_000,
): Promise<Uint8Array> {
  const started = await bridge.command("vc.Export", { target, format, include }, newCommandId());
  if (!started.ok) throw new Error(errorMessage(started.error.code));
  const exportId = (started.result as { exportId: string }).exportId,
    deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const record = (await bridge.query<ExportRecord[]>("vc.Exports", {})).find((r) => r.exportId === exportId);
    if (record?.status === "completed" && record.blobHash) return bridge.getBlob(record.blobHash);
    if (record?.status === "failed") throw new Error(record.error ?? "The export did not finish.");
    await new Promise((resolve) => setTimeout(resolve, 250));
  }
  throw new Error("The export is taking too long. Try again.");
}

function download(bytes: Uint8Array, name: string, format: Format) {
  const type = format === "html" ? "text/html" : format === "json" ? "application/json" : "text/markdown";
  const url = URL.createObjectURL(new Blob([bytes as BlobPart], { type })),
    link = document.createElement("a");
  link.href = url;
  link.download = name;
  link.click();
  setTimeout(() => URL.revokeObjectURL(url), 10_000);
}

export function ExportDialog({
  open,
  target,
  title,
  onClose,
}: {
  open: boolean;
  target: ExportTarget | undefined;
  title: string;
  onClose(): void;
}) {
  const bridge = useBridge(),
    [format, setFormat] = useState<Format>("markdown"),
    [threads, setThreads] = useState(false),
    [decisions, setDecisions] = useState(false),
    [busy, setBusy] = useState(false),
    [error, setError] = useState<string>();
  useEffect(() => {
    if (open) setError(undefined);
  }, [open]);
  async function submit() {
    if (!target) return;
    setBusy(true);
    setError(undefined);
    try {
      const bytes = await runExport(bridge, target, format, { threads, decisionRecord: decisions });
      download(bytes, fileName(title, format), format);
      onClose();
    } catch (failure) {
      setError(failure instanceof Error ? failure.message : "The export did not finish.");
    } finally {
      setBusy(false);
    }
  }
  const formats: Array<[Format, string, string]> = [
    ["markdown", "Markdown", "Plain text with light formatting."],
    ["html", "Web page", "Opens in any browser."],
    ["json", "JSON", "Everything, for other tools."],
  ];
  return (
    <Dialog
      open={open}
      title="Export"
      lede={`“${title}” as a file on this computer.`}
      onClose={onClose}
      onSubmit={() => void submit()}
      buttons={
        <>
          <Button type="button" variant="ghost" onClick={onClose}>
            Cancel
          </Button>
          <Button type="submit" variant="primary" loading={busy}>
            Download
          </Button>
        </>
      }
    >
      <div className="vc-choice three" role="radiogroup" aria-label="Format">
        {formats.map(([value, label, hint]) => (
          <label key={value}>
            <input type="radio" name="format" checked={format === value} onChange={() => setFormat(value)} />
            <strong>{label}</strong>
            <span>{hint}</span>
          </label>
        ))}
      </div>
      <div className="vc-checks">
        <Checkbox
          label="Include the threads"
          checked={threads}
          onChange={(event) => setThreads(event.target.checked)}
        />
        <Checkbox
          label="Include what was agreed"
          checked={decisions}
          onChange={(event) => setDecisions(event.target.checked)}
        />
      </div>
      {error && (
        <p className="vc-error" role="alert">
          {error}
        </p>
      )}
    </Dialog>
  );
}
