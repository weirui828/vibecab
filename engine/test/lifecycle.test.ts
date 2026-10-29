import { expect, it } from "vitest";
import Database from "better-sqlite3";
import { join } from "node:path";
import { appendFile, mkdtemp, readFile, readdir, rm } from "node:fs/promises";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { Contract } from "../../contract/src/index.js";
import type { Element, OutputSet, ProviderModel, SessionDigest, Json } from "../../contract/src/index.js";
import { ctx, fixture } from "./helpers.js";
import { ScriptedProvider } from "../src/gateway/fake.js";

const model: ProviderModel = {
  provider: "openai-compatible",
  baseUrl: "https://model.example.test/v1",
  model: "fake",
  capabilities: {
    tools: false,
    jsonSchemaOutput: true,
    streaming: true,
    maxContextTokens: 8192,
    reportsUsage: true,
  },
  pricing: { inputMicrosPerMillion: 0, outputMicrosPerMillion: 0 },
};
const runFile = promisify(execFile);

async function importArtifact(engine: import("../src/engine.js").Engine, content: string) {
  const result = await engine.command(ctx, {
    commandId: "lifecycle-import",
    type: "vc.ImportContent",
    payload: { content, format: "markdown", title: "Draft" },
  });
  if (!result.ok) throw Error(result.error.message);
  return new Contract().read<{ artifactId: string; version: number }>(
    "operations/vc.ImportContent",
    result.result,
    "#/properties/result",
  );
}

async function startSession(engine: import("../src/engine.js").Engine, artifactId: string) {
  const project = await engine.command(ctx, {
    commandId: "lifecycle-project",
    type: "vc.CreateProject",
    payload: { title: "Project" },
  });
  if (!project.ok) throw Error(project.error.message);
  const projectId = new Contract().read<{ projectId: string }>(
    "operations/vc.CreateProject",
    project.result,
    "#/properties/result",
  ).projectId;
  const session = await engine.command(ctx, {
    commandId: "lifecycle-session",
    type: "vc.StartSession",
    payload: { title: "Review", primaryProjectId: projectId },
  });
  if (!session.ok) throw Error(session.error.message);
  const sessionId = new Contract().read<{ sessionId: string }>(
    "operations/vc.StartSession",
    session.result,
    "#/properties/result",
  ).sessionId;
  const attached = await engine.command(ctx, {
    commandId: "lifecycle-attach",
    type: "vc.AttachArtifact",
    payload: { sessionId, artifactId, role: "primary" },
  });
  if (!attached.ok) throw Error(attached.error.message);
  return sessionId;
}

async function waitForExport(engine: import("../src/engine.js").Engine, exportId: string) {
  for (let i = 0; i < 100; i++) {
    const result = await engine.query(ctx, { name: "vc.Exports", args: {} });
    const rows = new Contract().read<import("../../contract/src/index.js").ExportRecord[]>(
      "operations/vc.Exports",
      result,
      "#/properties/result",
    );
    const record = rows.find((row) => row.exportId === exportId);
    if (record?.status === "completed" || record?.status === "failed") return record;
    await new Promise<void>((resolve) => setTimeout(resolve, 10));
  }
  throw Error("Export did not complete");
}

it("freezes Output Set members and labels at the selected versions", async () => {
  const f = await fixture();
  try {
    const artifact = await importArtifact(f.engine, "# A heading\n\nFirst paragraph.");
    const sessionId = await startSession(f.engine, artifact.artifactId);
    const output = await f.engine.command(ctx, {
      commandId: "lifecycle-output-set",
      type: "vc.CreateOutputSet",
      payload: { sessionId, label: "Draft 1", artifactIds: [artifact.artifactId] },
    });
    expect(output.ok).toBe(true);
    const outputSetId = new Contract().read<{ outputSetId: string }>(
      "operations/vc.CreateOutputSet",
      output.ok ? output.result : {},
      "#/properties/result",
    ).outputSetId;
    const initialSets = new Contract().read<OutputSet[]>(
      "operations/vc.OutputSets",
      await f.engine.query(ctx, { name: "vc.OutputSets", args: { sessionId } }),
      "#/properties/result",
    );
    const setBefore = initialSets.find((set) => set.outputSetId === outputSetId);
    expect(setBefore).toBeDefined();
    const label = await f.engine.command(ctx, {
      commandId: "lifecycle-label",
      type: "vc.Label",
      payload: { target: { outputSetId }, label: "approved" },
    });
    expect(label.ok).toBe(true);
    const restore = await f.engine.command(ctx, {
      commandId: "lifecycle-new-version",
      type: "vc.RestoreVersion",
      payload: { artifactId: artifact.artifactId, version: 1 },
    });
    expect(restore.ok).toBe(true);
    const setsAfter = new Contract().read<OutputSet[]>(
      "operations/vc.OutputSets",
      await f.engine.query(ctx, { name: "vc.OutputSets", args: { sessionId } }),
      "#/properties/result",
    );
    expect(setsAfter.find((set) => set.outputSetId === outputSetId)).toEqual(setBefore!);
    const labels = new Contract().read<import("../../contract/src/index.js").Label[]>(
      "operations/vc.Labels",
      await f.engine.query(ctx, { name: "vc.Labels", args: { outputSetId } }),
      "#/properties/result",
    );
    expect(labels).toMatchObject([{ target: { outputSetId }, label: "approved" }]);
    const versions = new Contract().read<import("../../contract/src/index.js").Version[]>(
      "operations/vc.Versions",
      await f.engine.query(ctx, { name: "vc.Versions", args: { artifactId: artifact.artifactId } }),
      "#/properties/result",
    );
    expect(versions[0]).toHaveProperty("outputSetIds", [outputSetId]);
    expect(versions[1]).toHaveProperty("outputSetIds", []);
  } finally {
    await f.close();
  }
});

it("exports doc deterministically and Markdown round-trips element types and text", async () => {
  const f = await fixture();
  try {
    const imageHash = await f.engine.putBlob(ctx, new Uint8Array([137, 80, 78, 71, 13, 10, 26, 10, 0]), "image/png");
    const artifact = await importArtifact(
      f.engine,
      `# Heading\n\nA **bold** paragraph.\n\n> Quote\n\n![tiny](blob:${imageHash})`,
    );
    const exportOnce = async (commandId: string, format: "markdown" | "html" = "markdown") => {
      const result = await f.engine.command(ctx, {
        commandId,
        type: "vc.Export",
        payload: { target: { artifactId: artifact.artifactId, version: 1 }, format },
      });
      if (!result.ok) throw Error(result.error.message);
      const exportId = new Contract().read<{ exportId: string }>(
        "operations/vc.Export",
        result.result,
        "#/properties/result",
      ).exportId;
      const record = await waitForExport(f.engine, exportId);
      expect(record.status).toBe("completed");
      return f.engine.getBlob(ctx, record.blobHash!);
    };
    const first = await exportOnce("lifecycle-export-one");
    const second = await exportOnce("lifecycle-export-two");
    expect(first).toEqual(second);
    const html = new TextDecoder().decode(await exportOnce("lifecycle-export-html", "html"));
    expect(html.match(/<!doctype html>/gi)).toHaveLength(1);
    expect(html).toContain(
      `data:image/png;base64,${Buffer.from([137, 80, 78, 71, 13, 10, 26, 10, 0]).toString("base64")}`,
    );
    expect(html).not.toContain("blob:");
    const imported = await f.engine.command(ctx, {
      commandId: "lifecycle-round-trip",
      type: "vc.ImportContent",
      payload: { content: new TextDecoder().decode(first), format: "markdown", title: "Round trip" },
    });
    expect(imported.ok).toBe(true);
    const newId = new Contract().read<{ artifactId: string }>(
      "operations/vc.ImportContent",
      imported.ok ? imported.result : {},
      "#/properties/result",
    ).artifactId;
    const originalElements = new Contract().read<Element[]>(
      "operations/vc.Elements",
      await f.engine.query(ctx, { name: "vc.Elements", args: { artifactId: artifact.artifactId } }),
      "#/properties/result",
    );
    const roundTrip = new Contract().read<Element[]>(
      "operations/vc.Elements",
      await f.engine.query(ctx, { name: "vc.Elements", args: { artifactId: newId } }),
      "#/properties/result",
    );
    const content = (element: Element) => ({ type: element.type, text: "text" in element ? element.text : undefined });
    expect(roundTrip.map(content)).toEqual(originalElements.map(content));
    expect(roundTrip.find((element) => element.type === "image")).toMatchObject({ type: "image", blobHash: imageHash });
  } finally {
    await f.close();
  }
});

it("resume view lists each new comment and version once and advances only on MarkSeen", async () => {
  const f = await fixture();
  try {
    const artifact = await importArtifact(f.engine, "One paragraph.");
    const sessionId = await startSession(f.engine, artifact.artifactId);
    const elements = new Contract().read<Element[]>(
      "operations/vc.Elements",
      await f.engine.query(ctx, { name: "vc.Elements", args: { artifactId: artifact.artifactId } }),
      "#/properties/result",
    );
    const comment = await f.engine.command(ctx, {
      commandId: "resume-comment",
      type: "vc.Comment",
      payload: {
        sessionId,
        body: "Please clarify.",
        anchor: { artifactId: artifact.artifactId, elementId: elements[0]!.elementId, seenVersion: 1 },
      },
    });
    expect(comment.ok).toBe(true);
    const version = await f.engine.command(ctx, {
      commandId: "resume-new-version",
      type: "vc.RestoreVersion",
      payload: { artifactId: artifact.artifactId, version: 1 },
    });
    expect(version.ok).toBe(true);
    const first = new Contract().read<{ comments: unknown[]; versions: unknown[] }>(
      "operations/vc.ResumeView",
      await f.engine.query(ctx, { name: "vc.ResumeView", args: { sessionId } }),
      "#/properties/result",
    );
    expect(first.comments).toHaveLength(1);
    expect(new Set(first.comments.map((row) => JSON.stringify(row))).size).toBe(1);
    expect(first.versions).toHaveLength(1);
    const marked = await f.engine.command(ctx, {
      commandId: "resume-mark-seen",
      type: "vc.MarkSeen",
      payload: { sessionId },
    });
    expect(marked.ok).toBe(true);
    const afterSeen = new Contract().read<{ comments: unknown[]; versions: unknown[] }>(
      "operations/vc.ResumeView",
      await f.engine.query(ctx, { name: "vc.ResumeView", args: { sessionId } }),
      "#/properties/result",
    );
    expect(afterSeen.comments).toHaveLength(0);
    expect(afterSeen.versions).toHaveLength(0);
  } finally {
    await f.close();
  }
});

it("creates machine digests on pause and human edits as a new version without feedback changes", async () => {
  const provider = new ScriptedProvider();
  provider.enqueueDefaultSequence([
    [
      {
        type: "output",
        json: {
          purpose: "Review",
          whereItStands: "One open comment.",
          openQuestions: ["Clarify the lead."],
          nextSteps: ["Revise the opening."],
        },
      },
      { type: "usage", inputTokens: 20, outputTokens: 20, quality: "reported" },
      { type: "done", finishReason: "stop" },
    ],
  ]);
  const f = await fixture({ modelProviders: { "openai-compatible": provider } });
  try {
    await f.engine.command(ctx, {
      commandId: "digest-settings",
      type: "sys.SetSettings",
      payload: new Contract().read<Json>("json", {
        patch: { models: { digest: model }, budgets: { defaultTurnLimitMicros: 100_000 } },
      }),
    });
    const artifact = await importArtifact(f.engine, "One paragraph.");
    const sessionId = await startSession(f.engine, artifact.artifactId);
    const elements = new Contract().read<Element[]>(
      "operations/vc.Elements",
      await f.engine.query(ctx, { name: "vc.Elements", args: { artifactId: artifact.artifactId } }),
      "#/properties/result",
    );
    const comment = await f.engine.command(ctx, {
      commandId: "digest-comment",
      type: "vc.Comment",
      payload: {
        sessionId,
        body: "Clarify the lead.",
        anchor: { artifactId: artifact.artifactId, elementId: elements[0]!.elementId, seenVersion: 1 },
      },
    });
    expect(comment.ok).toBe(true);
    const paused = await f.engine.command(ctx, {
      commandId: "digest-pause",
      type: "vc.PauseSession",
      payload: { sessionId },
    });
    expect(paused.ok).toBe(true);
    let digests: SessionDigest[] = [];
    for (let i = 0; i < 100 && !digests.length; i++) {
      digests = new Contract().read<SessionDigest[]>(
        "operations/vc.Digest",
        await f.engine.query(ctx, { name: "vc.Digest", args: { sessionId } }),
        "#/properties/result",
      );
      if (!digests.length) await new Promise<void>((resolve) => setTimeout(resolve, 10));
    }
    expect(digests[0]).toMatchObject({ createdBy: "machine", version: 1 });
    const edited = await f.engine.command(ctx, {
      commandId: "digest-edit",
      type: "vc.EditDigest",
      payload: { sessionId, purpose: "Revised review", whereItStands: "Still open.", openQuestions: [], nextSteps: [] },
    });
    expect(edited.ok).toBe(true);
    expect(new Contract().read<SessionDigest>("session-digest", edited.ok ? edited.result : {}).version).toBe(2);
    const feedback = new Contract().read<import("../../contract/src/index.js").FeedbackComment[]>(
      "operations/vc.FeedbackItems",
      await f.engine.query(ctx, { name: "vc.FeedbackItems", args: { sessionId } }),
      "#/properties/result",
    );
    expect(feedback).toHaveLength(1);
    expect(feedback[0]?.state).toBe("open");
    expect(provider.calls).toHaveLength(1);
  } finally {
    await f.close();
  }
});

it("backs up the live SQLite workspace and referenced blob directory into a hashed archive", async () => {
  const f = await fixture();
  try {
    await importArtifact(f.engine, "Backup content.");
    const result = await f.engine.command(ctx, { commandId: "backup-create", type: "sys.Backup", payload: {} });
    expect(result.ok).toBe(true);
    const backupId = new Contract().read<{ backupId: string }>(
      "operations/sys.Backup",
      result.ok ? result.result : {},
      "#/properties/result",
    ).backupId;
    let records: import("../../contract/src/index.js").BackupRecord[] = [];
    for (let i = 0; i < 100; i++) {
      records = new Contract().read<import("../../contract/src/index.js").BackupRecord[]>(
        "operations/sys.Backups",
        await f.engine.query(ctx, { name: "sys.Backups", args: {} }),
        "#/properties/result",
      );
      if (records.find((record) => record.backupId === backupId)?.status === "completed") break;
      await new Promise<void>((resolve) => setTimeout(resolve, 10));
    }
    const backup = records.find((record) => record.backupId === backupId);
    expect(backup?.status).toBe("completed");
    const archive = await readFile(backup!.archivePath!);
    const hash = await import("node:crypto").then(({ createHash }) =>
      createHash("sha256").update(archive).digest("hex"),
    );
    expect(hash).toBe(backup?.archiveHash);
    expect(archive.subarray(0, 2)).toEqual(Buffer.from([0x1f, 0x8b]));
  } finally {
    await f.close();
  }
});

it("trashes recoverably, previews purge contents, and removes the selected content from storage", async () => {
  const f = await fixture();
  try {
    const secret = "purge-sensitive-phrase";
    const artifact = await importArtifact(f.engine, secret);
    const sessionId = await startSession(f.engine, artifact.artifactId);
    const elements = new Contract().read<Element[]>(
      "operations/vc.Elements",
      await f.engine.query(ctx, { name: "vc.Elements", args: { artifactId: artifact.artifactId } }),
      "#/properties/result",
    );
    const comment = await f.engine.command(ctx, {
      commandId: "purge-comment",
      type: "vc.Comment",
      payload: {
        sessionId,
        body: secret,
        anchor: { artifactId: artifact.artifactId, elementId: elements[0]!.elementId, seenVersion: 1 },
      },
    });
    expect(comment.ok).toBe(true);
    const trash = await f.engine.command(ctx, {
      commandId: "purge-trash",
      type: "vc.Trash",
      payload: { target: { kind: "artifact", id: artifact.artifactId } },
    });
    expect(trash.ok).toBe(true);
    const hidden = await f.engine.query(ctx, { name: "vc.Artifact", args: { artifactId: artifact.artifactId } }).then(
      () => false,
      (error: unknown) => {
        const contract = typeof error === "object" && error !== null ? Reflect.get(error, "contract") : undefined;
        return typeof contract === "object" && contract !== null && Reflect.get(contract, "code") === "not_found";
      },
    );
    expect(hidden).toBe(true);
    const visible = await f.engine.query(ctx, {
      name: "vc.Artifact",
      args: { artifactId: artifact.artifactId, includeTrashed: true },
    });
    expect(new Contract().read("operations/vc.Artifact", visible, "#/properties/result")).toHaveProperty(
      "artifactId",
      artifact.artifactId,
    );
    const preview = new Contract().read<{ commentIds: string[]; revisionHashes: string[] }>(
      "operations/vc.PurgePreview",
      await f.engine.query(ctx, {
        name: "vc.PurgePreview",
        args: { target: { kind: "artifact", id: artifact.artifactId } },
      }),
      "#/properties/result",
    );
    expect(preview.commentIds).toHaveLength(1);
    expect(preview.revisionHashes).toHaveLength(1);
    const purge = await f.engine.command(ctx, {
      commandId: "purge-run",
      type: "vc.Purge",
      payload: { target: { kind: "artifact", id: artifact.artifactId } },
    });
    expect(purge.ok).toBe(true);
    let purged = false;
    for (let i = 0; i < 100 && !purged; i++) {
      purged = await f.engine
        .query(ctx, { name: "vc.Artifact", args: { artifactId: artifact.artifactId, includeTrashed: true } })
        .then(
          () => false,
          (error: unknown) => {
            const contract = typeof error === "object" && error !== null ? Reflect.get(error, "contract") : undefined;
            return typeof contract === "object" && contract !== null && Reflect.get(contract, "code") === "not_found";
          },
        );
      if (!purged) await new Promise<void>((resolve) => setTimeout(resolve, 10));
    }
    expect(purged).toBe(true);
    const db = new Database(join(f.dir, "workspace.sqlite"), { readonly: true });
    try {
      const rows: unknown[] = db
        .prepare("SELECT json FROM vc_element_revisions UNION ALL SELECT json FROM vc_feedback")
        .all();
      expect(
        rows.some(
          (row) => typeof row === "object" && row !== null && String(Reflect.get(row, "json")).includes(secret),
        ),
      ).toBe(false);
      const fts: unknown[] = db.prepare("SELECT text FROM vc_search").all();
      expect(
        fts.some((row) => typeof row === "object" && row !== null && String(Reflect.get(row, "text")).includes(secret)),
      ).toBe(false);
    } finally {
      db.close();
    }
  } finally {
    await f.close();
  }
});

it("restores a verified backup through the stopped lifecycle and rejects tampered archives", async () => {
  const f = await fixture();
  try {
    const sourceArtifact = await importArtifact(f.engine, "restore continuity text");
    const sourceResult = await f.engine.query(ctx, {
      name: "vc.Artifact",
      args: { artifactId: sourceArtifact.artifactId },
    });
    const result = await f.engine.command(ctx, {
      commandId: "restore-backup-create",
      type: "sys.Backup",
      payload: {},
    });
    expect(result.ok).toBe(true);
    const backupId = new Contract().read<{ backupId: string }>(
      "operations/sys.Backup",
      result.ok ? result.result : {},
      "#/properties/result",
    ).backupId;
    let archivePath = "";
    for (let i = 0; i < 100 && !archivePath; i++) {
      const backups = new Contract().read<import("../../contract/src/index.js").BackupRecord[]>(
        "operations/sys.Backups",
        await f.engine.query(ctx, { name: "sys.Backups", args: {} }),
        "#/properties/result",
      );
      archivePath = backups.find((backup) => backup.backupId === backupId)?.archivePath ?? "";
      if (!archivePath) await new Promise<void>((resolve) => setTimeout(resolve, 10));
    }
    expect(archivePath).not.toBe("");
    const corruptedArchive = join(f.dir, "tampered.tar.gz"),
      tamperRoot = await mkdtemp(join(f.dir, "tamper-"));
    try {
      await runFile("tar", ["-xzf", archivePath, "-C", tamperRoot]);
      await appendFile(join(tamperRoot, "workspace.sqlite"), "tampered");
      await runFile("tar", ["-czf", corruptedArchive, "-C", tamperRoot, "."]);
    } finally {
      await rm(tamperRoot, { recursive: true, force: true });
    }
    const destination = join(f.dir, "restored-workspace");
    await f.engine.stop();
    await expect(f.engine.restoreBackup(corruptedArchive, destination)).rejects.toThrow();
    expect(await readdir(f.dir)).not.toContain("restored-workspace");
    await f.engine.restoreBackup(archivePath, destination);
    await f.engine.start(destination);
    const restored = await f.engine.query(ctx, {
      name: "vc.Artifact",
      args: { artifactId: sourceArtifact.artifactId },
    });
    expect(restored).toEqual(sourceResult);
  } finally {
    await f.close();
    await rm(join(f.dir, "restored-workspace"), { recursive: true, force: true });
  }
});
