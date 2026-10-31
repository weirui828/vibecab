import { useEffect, useRef } from "react";

// Saves a finished export to disk once: waits for the export job, then hands the bytes to the app.
export function useExportSaver(
  pendingExportId: string | undefined,
  setPendingExportId: (id: string | undefined) => void,
  title: string | undefined,
  setMessage: (message: string) => void,
) {
  const savedExports = useRef(new Set<string>());
  useEffect(() => {
    if (!pendingExportId || savedExports.current.has(pendingExportId)) return;
    let cancelled = false;
    const waitForExport = async () => {
      for (let attempt = 0; attempt < 60 && !cancelled; attempt++) {
        const exports = await window.vibecab.query<
            Array<{ exportId: string; status: string; blobHash?: string; format: string }>
          >("vc.Exports", {}),
          item = exports.find((candidate) => candidate.exportId === pendingExportId);
        if (item?.status === "failed") throw new Error("Export failed.");
        if (item?.status === "completed" && item.blobHash) {
          savedExports.current.add(pendingExportId);
          const bytes = await window.vibecab.getBlob(item.blobHash),
            ext = item.format === "markdown" ? "md" : item.format;
          if (!cancelled) {
            await window.vibecab.app.saveFiles([{ name: `${title ?? "VibeCab"}.${ext}`, bytes }]);
            setMessage("Export saved");
            setPendingExportId(undefined);
          }
          return;
        }
        await new Promise((resolve) => window.setTimeout(resolve, 250));
      }
    };
    void waitForExport().catch((error: unknown) => {
      if (!cancelled) setMessage(error instanceof Error ? error.message : "Could not save export.");
    });
    return () => {
      cancelled = true;
    };
  }, [pendingExportId, title, setPendingExportId, setMessage]);
}
