// @vitest-environment jsdom
import { afterEach, expect, it } from "vitest";
import { cleanup, fireEvent, render, waitFor } from "@testing-library/react";
import type { CommandResult } from "../../../contract/src/index.js";
import type { ContractBridge } from "../src/api.js";
import { App } from "../src/view/App.js";
import { TrashView } from "../src/view/TrashView.js";

afterEach(cleanup);

it("shows the chosen purge action and sends no review choices from Trash", async () => {
  const commands: Array<{ type: string; payload: unknown }> = [],
    preview = { reviewRuns: [{ runId: "run-delete", action: "delete", active: false, removes: [] }] };
  window.vibecab = makeBridge(commands, preview);
  const view = render(<TrashView onBack={() => undefined} onChanged={() => undefined} />);
  expect(await view.findByText(/1 review quoted this Draft/)).toBeTruthy();
  await view.getByRole("button", { name: "Delete permanently" }).click();
  expect(await view.findByText(/Review run-delete will be deleted/)).toBeTruthy();
  const input = await view.findByLabelText(/Type/);
  fireEvent.change(input, { target: { value: "Reviewed Draft" } });
  const buttons = view.getAllByRole("button", { name: "Delete permanently" });
  fireEvent.click(buttons[buttons.length - 1]!);
  await waitFor(() =>
    expect(commands).toContainEqual({ type: "vc.Purge", payload: { target: { kind: "artifact", id: "draft-1" } } }),
  );
  expect(commands.some(({ payload }) => field(payload, "reviewActions") !== undefined)).toBe(false);
});

it("shows the dependent-review count in the undo toast when a Draft is trashed", async () => {
  const commands: Array<{ type: string; payload: unknown }> = [];
  window.vibecab = makeBridge(commands, { reviewRuns: [{ runId: "r1" }, { runId: "r2" }] }, true);
  const view = render(<App />);
  const trash = await view.findByRole("button", { name: "Move to trash" });
  fireEvent.click(trash);
  expect(await view.findByText(/Moved to Trash\. 2 reviews quoted this Draft/)).toBeTruthy();
  expect(view.getByRole("button", { name: "Undo" })).toBeTruthy();
});

it("lists automatic review actions in the Empty trash confirmation", async () => {
  const commands: Array<{ type: string; payload: unknown }> = [];
  window.vibecab = makeBridge(commands, {
    reviewRuns: [{ runId: "run-redact", action: "redact", active: false, removes: [] }],
  });
  const view = render(<TrashView onBack={() => undefined} onChanged={() => undefined} />);
  await view.findByText(/1 review quoted this Draft/);
  fireEvent.click(view.getByRole("button", { name: "Empty trash" }));
  await view.findByRole("region", { name: "Empty trash confirmation" });
  expect(view.container.textContent).toContain(
    "Reviewed Draft: review run-redact will be kept with the purged source redacted.",
  );
  fireEvent.change(await view.findByLabelText("Empty trash confirmation text"), {
    target: { value: "EMPTY TRASH" },
  });
  fireEvent.click(view.getByRole("button", { name: "Empty trash permanently" }));
  await waitFor(() =>
    expect(commands).toContainEqual({ type: "vc.Purge", payload: { target: { kind: "artifact", id: "draft-1" } } }),
  );
});

function makeBridge(
  commands: Array<{ type: string; payload: unknown }>,
  purgePreview: unknown,
  activeDraft = false,
): ContractBridge {
  const artifact = {
    artifactId: "draft-1",
    title: "Reviewed Draft",
    mediaKind: "doc",
    headVersion: 1,
    createdAt: "2026-10-28T00:00:00.000Z",
    updatedAt: "2026-10-28T00:00:00.000Z",
  };
  return {
    async command(type, payload): Promise<CommandResult> {
      commands.push({ type, payload });
      return { ok: true, result: type === "vc.Purge" ? { purgeId: "purge-1", status: "queued" } : {}, seq: 1 };
    },
    async query<T = unknown>(name: string, args: unknown): Promise<T> {
      const includeTrashed = field(args, "includeTrashed") === true,
        value =
          name === "vc.Artifacts"
            ? includeTrashed
              ? [artifact]
              : activeDraft
                ? [artifact]
                : []
            : name === "vc.Sessions"
              ? []
              : name === "vc.FeedbackItems"
                ? []
                : name === "sys.Settings"
                  ? { trashRetentionDays: 30, models: { default: { model: "test" } } }
                  : name === "vc.AttentionInbox"
                    ? []
                    : name === "vc.PurgePreview"
                      ? {
                          recordIds: [],
                          revisionHashes: [],
                          blobHashes: [],
                          manifestIds: [],
                          digestIds: [],
                          commentIds: [],
                          agreementIds: [],
                          updateIds: [],
                          conflictIds: [],
                          outputSetIds: [],
                          reviewRuns: field(purgePreview, "reviewRuns") ?? [],
                        }
                      : undefined;
      return value as T;
    },
    subscribe: () => () => undefined,
    async putBlob() {
      return "blob-hash";
    },
    async getBlob() {
      return new Uint8Array();
    },
    blobUrl: (hash) => hash,
    app: {
      state: async () => "Connected",
      startEngine: async () => "Connected",
      saveProvider: async () => undefined,
      openMarkdown: async () => undefined,
      openExternal: async () => undefined,
      setTheme: async () => undefined,
      getLoginItem: async () => false,
      setLoginItem: async () => false,
      trayStatus: async () => ({ running: true, status: [], recentSessions: [] }),
      setNotificationsEnabled: async () => undefined,
      getNotificationsEnabled: async () => false,
      saveFiles: async () => undefined,
      copyText: async () => undefined,
      reveal: async () => undefined,
      workspacePath: async () => "/workspace",
      restoreBackup: async () => undefined,
      mcpRelayPath: async () => "/vibecab-mcp",
      openMcpConfig: async () => undefined,
      nodeVersion: async () => "26",
      version: async () => "1.0.0",
      onNewDraft: () => () => undefined,
      onImport: () => () => undefined,
      onTheme: () => () => undefined,
      onConnectionLost: () => () => undefined,
      onNavigate: () => () => undefined,
    },
  };
}

function field(value: unknown, key: string): unknown {
  return typeof value === "object" && value !== null ? Reflect.get(value, key) : undefined;
}
