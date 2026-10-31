import { expect, it } from "vitest";
import Database from "better-sqlite3";
import { readFile, readdir } from "node:fs/promises";
import { join } from "node:path";
import { Contract, type Json, type ProviderModel } from "../../contract/src/index.js";
import { ScriptedProvider } from "../src/gateway/fake.js";
import { advanceClock, ctx, fixture } from "./helpers.js";

const model: ProviderModel = {
  provider: "openai-compatible",
  baseUrl: "https://model.example.test/v1",
  model: "review-fake",
  keyRef: "review-test-key",
  capabilities: { tools: false, jsonSchemaOutput: true, streaming: true, maxContextTokens: 8192, reportsUsage: true },
  pricing: { inputMicrosPerMillion: 0, outputMicrosPerMillion: 0 },
};
const contract = new Contract();

it("returns scripted findings, applies only agreed non-conflicting feedback, and marks the second review revised", async () => {
  const provider = new ScriptedProvider();
  provider.setDefaultHandler((_model, request) => {
    const system = request.messages[0]?.content ?? "";
    if (system.includes("Assess the supplied snapshot"))
      return [{ type: "output", json: { recommendation: "Review evidence" } }];
    const raw: unknown = JSON.parse(request.messages[1]?.content ?? "{}"),
      question = string(field(raw, "question")),
      snapshot = field(field(field(raw, "context"), "snapshot"), "items"),
      items = array(snapshot),
      first = items.find((item) => field(field(item, "content"), "text") === "First paragraph."),
      second = items.find((item) => field(field(item, "content"), "text") === "Second paragraph."),
      ref = (item: unknown) => ({ itemId: string(field(item, "itemId")) });
    const findings =
      question === "first review"
        ? [
            finding(
              "apply-first",
              "Clarify the first paragraph",
              "First paragraph needs a tighter sentence.",
              "First paragraph revised.",
              [ref(first)],
            ),
            finding("conflict-a", "Shorten the second paragraph", "It is too long.", "Second paragraph short.", [
              ref(second),
            ]),
            finding(
              "conflict-b",
              "Expand the second paragraph",
              "It needs more context.",
              "Second paragraph expanded.",
              [ref(second)],
            ),
            finding("unresolved", "Missing material", "The reference is absent.", undefined, [
              { itemId: "absent-item" },
            ]),
          ]
        : [
            finding("revised-second", "Revisit the first paragraph", "It changed after review.", "A second revision.", [
              ref(first),
            ]),
          ];
    return [{ type: "output", json: { recommendation: "Address the supported findings.", findings } }];
  });
  const f = await fixture({ modelProviders: { "openai-compatible": provider } });
  try {
    await setModel(f.engine);
    const { artifactId, elements } = await createDraft(f.engine),
      sessionId = await createSession(f.engine, artifactId);
    const comment = await f.engine.command(ctx, {
      commandId: "review-progress-comment",
      type: "vc.Comment",
      payload: {
        sessionId,
        anchor: {
          artifactId,
          elementId: elements[0]!,
          seenVersion: 1,
          locator: { quote: "Draft", prefix: "", suffix: "" },
        },
        body: "Clean up the title",
        suggestion: { replacement: "Review draft" },
      },
    });
    if (!comment.ok) throw new Error(JSON.stringify(comment.error));
    await agree(f.engine, string(field(comment.result, "commentId")), "review-progress-agree");
    const firstReview = await requestReview(f.engine, sessionId, artifactId, elements, "first review"),
      secondReview = await requestReview(f.engine, sessionId, artifactId, elements, "second review");
    const earlyUpdate = await f.engine.command(ctx, {
      commandId: "review-update-during-run",
      type: "vc.StartUpdate",
      payload: { artifactId },
    });
    expect(earlyUpdate.ok).toBe(true);
    if (!earlyUpdate.ok) throw new Error(earlyUpdate.error.message);
    const earlyUpdateId = string(field(earlyUpdate.result, "updateId"));
    expect(["committed", "partially_committed"]).toContain(
      field(await waitForUpdate(f.engine, earlyUpdateId), "status"),
    );

    const firstReport = await waitForReport(f.engine, firstReview),
      secondReport = await waitForReport(f.engine, secondReview);
    expect(field(firstReport, "mode")).toBe("live");
    expect(array(field(firstReport, "inputMaterials"))).toHaveLength(3);
    const feedback = await waitForFindings(f.engine, sessionId, [
      "apply-first",
      "conflict-a",
      "conflict-b",
      "unresolved",
    ]);
    const unique = byFinding(feedback, "apply-first"),
      conflictA = byFinding(feedback, "conflict-a"),
      conflictB = byFinding(feedback, "conflict-b"),
      unresolved = byFinding(feedback, "unresolved");
    expect(unique).toBeDefined();
    expect(conflictA).toBeDefined();
    expect(conflictB).toBeDefined();
    expect(unresolved).toBeDefined();
    const initialFindings = array(
        await f.engine.query(ctx, { name: "vc.Findings", args: { reviewRequestId: firstReview } }),
      ),
      applicability = new Map(
        initialFindings.map((item) => [field(field(item, "finding"), "findingId"), field(item, "applicability")]),
      );
    expect(applicability.get("apply-first")).toBe("current");
    expect(applicability.get("conflict-a")).toBe("current");
    expect(applicability.get("unresolved")).toBe("not_located");

    const uniqueId = string(field(unique, "commentId")),
      conflictAId = string(field(conflictA, "commentId")),
      conflictBId = string(field(conflictB, "commentId"));
    await agree(f.engine, uniqueId, "review-agree-unique");
    await agree(f.engine, conflictAId, "review-agree-conflict-a");
    await agree(f.engine, conflictBId, "review-agree-conflict-b");
    const conflicts = await f.engine.query(ctx, { name: "vc.Conflicts", args: { sessionId } });
    expect(array(conflicts).length).toBeGreaterThan(0);
    const start = await f.engine.command(ctx, {
      commandId: "review-update-agreed",
      type: "vc.StartUpdate",
      payload: { artifactId },
    });
    expect(start.ok).toBe(true);
    if (!start.ok) throw new Error(start.error.message);
    const updateId = string(field(start.result, "updateId"));
    const update = await waitForUpdate(f.engine, updateId);
    expect(["committed", "partially_committed"]).toContain(field(update, "status"));
    const currentElements = await elementsFor(f.engine, artifactId),
      firstCurrent = currentElements.find((element) => field(element, "elementId") === elements[1]),
      secondCurrent = currentElements.find((element) => field(element, "elementId") === elements[2]);
    expect(field(firstCurrent, "text")).toBe("First paragraph revised.");
    expect(field(secondCurrent, "text")).toBe("Second paragraph.");
    const runId = string(field(firstReport, "runId")),
      decisionRecord = array(
        await f.engine.query(ctx, {
          name: "vc.DecisionRecord",
          args: { artifactId, elementId: elements[1]! },
        }),
      );
    expect(decisionRecord).toContainEqual(
      expect.objectContaining({ source: { runId, findingId: "apply-first" }, state: "applied" }),
    );
    const output = await f.engine.command(ctx, {
      commandId: "review-output-set",
      type: "vc.CreateOutputSet",
      payload: { sessionId, artifactIds: [artifactId] },
    });
    expect(output.ok).toBe(true);
    if (!output.ok) throw new Error(output.error.message);
    const outputSetId = string(field(output.result, "outputSetId")),
      outputSets = array(await f.engine.query(ctx, { name: "vc.OutputSets", args: { sessionId } })),
      createdOutputSet = outputSets.find((item) => field(item, "outputSetId") === outputSetId);
    expect(array(field(field(createdOutputSet, "links"), "reviewRequestIds"))).toContain(firstReview);

    const secondFindings = array(
        await f.engine.query(ctx, { name: "vc.Findings", args: { reviewRequestId: secondReview } }),
      ),
      stale = secondFindings.find((item) => field(field(item, "finding"), "findingId") === "revised-second");
    expect(stale).toMatchObject({
      applicability: "revised",
      reviewedContent: "First paragraph.",
      currentContent: "First paragraph revised.",
    });
    const deliveredSecond = await waitForFindings(f.engine, sessionId, ["revised-second"]),
      staleItem = byFinding(deliveredSecond, "revised-second"),
      staleId = string(field(staleItem, "commentId"));
    const noInstruction = await f.engine.command(ctx, {
      commandId: "review-agree-revised-without-instruction",
      type: "vc.Agree",
      payload: { commentId: staleId, kind: "as_written" },
    });
    expect(noInstruction).toMatchObject({
      ok: false,
      error: { code: "invalid", message: "A revised review finding requires an explicit instruction" },
    });
    void secondReport;
  } finally {
    await f.close();
  }
});

it("converts a suggested review using the final human fields and rejects an omitted mode", async () => {
  const f = await fixture();
  try {
    const { artifactId, elements } = await createDraft(f.engine),
      sessionId = await createSession(f.engine, artifactId);
    const draftId = "draft-human-conversion";
    const db = new Database(join(f.dir, "workspace.sqlite"));
    db.prepare("INSERT INTO vc_feedback(kind,id,json) VALUES(?,?,?)").run(
      "review-draft",
      draftId,
      JSON.stringify({
        draftId,
        sessionId,
        question: "Suggested question",
        elementIds: [elements[1]],
        createdByTurnId: "turn-test",
        createdAt: "2026-10-28T00:00:00.000Z",
      }),
    );
    db.close();
    const invalid = await f.engine.command(ctx, {
      commandId: "convert-review-missing-mode",
      type: "vc.ConvertSuggestedReview",
      payload: {
        draftId,
        question: "Final question",
        elementRefs: [{ artifactId, elementIds: [elements[1]!] }],
        preset: "independent-review",
        limits: { spendMicros: 0 },
      },
    });
    expect(invalid).toMatchObject({ ok: false, error: { code: "invalid" } });
    const converted = await f.engine.command(ctx, {
      commandId: "convert-review-final",
      type: "vc.ConvertSuggestedReview",
      payload: {
        draftId,
        question: "Final human question",
        elementRefs: [{ artifactId, elementIds: [elements[1]!] }],
        criteria: ["Use current evidence"],
        preset: "independent-review",
        limits: { spendMicros: 0 },
        mode: "demo",
      },
    });
    expect(converted.ok).toBe(true);
    if (!converted.ok) throw new Error(converted.error.message);
    const requestId = string(field(converted.result, "reviewRequestId")),
      report = await waitForReport(f.engine, requestId);
    expect(field(field(report, "scope"), "question")).toBe("Final human question");
    expect(field(report, "mode")).toBe("demo");
  } finally {
    await f.close();
  }
});

it("resubmits a review request after restart without creating a second TMR run", async () => {
  const provider = new ScriptedProvider();
  provider.setDefaultHandler((_model, request) => {
    const system = request.messages[0]?.content ?? "";
    return [
      {
        type: "output",
        json: system.includes("Assess the supplied snapshot")
          ? { recommendation: "Supported" }
          : { recommendation: "Reviewed" },
      },
    ];
  });
  const f = await fixture({ modelProviders: { "openai-compatible": provider } });
  try {
    await setModel(f.engine);
    const { artifactId, elements } = await createDraft(f.engine),
      sessionId = await createSession(f.engine, artifactId),
      requestId = await requestReview(f.engine, sessionId, artifactId, elements, "crash retry review");
    await f.engine.stop();
    await f.engine.start(f.dir);
    expect(await requestReview(f.engine, sessionId, artifactId, elements, "crash retry review")).toBe(requestId);
    await waitForReport(f.engine, requestId);
    const runs = array(await f.engine.query(ctx, { name: "tmr.Runs", args: { limit: 20 } }));
    expect(runs.filter((run) => field(run, "requestId") === requestId)).toHaveLength(1);
  } finally {
    await f.close();
  }
});

it("automatically deletes a review whose every quoted source is purged", async () => {
  const f = await fixture();
  try {
    const { artifactId, elements } = await createDraft(f.engine),
      sessionId = await createSession(f.engine, artifactId),
      reviewRequestId = await requestReview(f.engine, sessionId, artifactId, elements, "purge review");
    const report = await waitForReport(f.engine, reviewRequestId),
      runId = string(field(report, "runId"));
    const trashed = await f.engine.command(ctx, {
      commandId: "review-purge-trash",
      type: "vc.Trash",
      payload: { target: { kind: "artifact", id: artifactId } },
    });
    expect(trashed.ok).toBe(true);
    const previewRaw = await f.engine.query(ctx, {
        name: "vc.PurgePreview",
        args: { target: { kind: "artifact", id: artifactId } },
      }),
      preview = array(field(previewRaw, "reviewRuns"));
    expect(preview).toContainEqual(
      expect.objectContaining({
        reviewRequestId,
        runId,
        action: "delete",
        removes: expect.any(Array),
      }),
    );
    const purge = await f.engine.command(ctx, {
      commandId: "review-purge-redact",
      type: "vc.Purge",
      payload: { target: { kind: "artifact", id: artifactId } },
    });
    expect(purge.ok).toBe(true);
    if (!purge.ok) throw new Error(purge.error.message);
    await waitForPurge(f.dir, string(field(purge.result, "purgeId")));
    const db = new Database(join(f.dir, "workspace.sqlite")),
      rows = db
        .prepare("SELECT kind,json FROM vc_feedback WHERE kind IN ('tmr-snapshot','tmr-contribution','tmr-report')")
        .all() as Array<{ kind: string; json: string }>;
    expect(rows.some((row) => row.json.includes("First paragraph."))).toBe(false);
    expect(rows).toHaveLength(0);
    db.close();
    const runs = array(await f.engine.query(ctx, { name: "tmr.Runs", args: { limit: 20 } }));
    expect(runs.some((run) => field(run, "runId") === runId)).toBe(false);
    const files = await workspaceFiles(f.dir),
      retained = await Promise.all(files.map((file) => readFile(file).catch(() => Buffer.alloc(0))));
    expect(files.filter((_, index) => retained[index]?.includes(Buffer.from("First paragraph.")))).toEqual([]);
  } finally {
    await f.close();
  }
});

it("redacts only purged sources and keeps a review that also quotes surviving sources", async () => {
  const f = await fixture();
  try {
    const first = await createDraft(f.engine, "# First Draft\n\nSensitive first source phrase.", "First mixed draft"),
      second = await createDraft(f.engine, "# Second Draft\n\nSurviving second source phrase.", "Second mixed draft"),
      sessionId = await createSession(f.engine, first.artifactId);
    const attach = await f.engine.command(ctx, {
      commandId: "mixed-review-attach-second",
      type: "vc.AttachArtifact",
      payload: { sessionId, artifactId: second.artifactId, role: "reference" },
    });
    expect(attach.ok).toBe(true);
    const request = await f.engine.command(ctx, {
      commandId: "mixed-source-review",
      type: "vc.RequestReview",
      payload: {
        sessionId,
        question: "Compare both drafts",
        elementRefs: [
          { artifactId: first.artifactId, elementIds: first.elements },
          { artifactId: second.artifactId, elementIds: second.elements },
        ],
        preset: "independent-review",
        limits: { spendMicros: 1_000_000_000 },
        mode: "live",
      },
    });
    if (!request.ok) throw new Error(request.error.message);
    const reviewRequestId = string(field(request.result, "reviewRequestId")),
      report = await waitForReport(f.engine, reviewRequestId),
      runId = string(field(report, "runId"));
    await f.engine.command(ctx, {
      commandId: "mixed-review-trash-first",
      type: "vc.Trash",
      payload: { target: { kind: "artifact", id: first.artifactId } },
    });
    const preview = await f.engine.query(ctx, {
      name: "vc.PurgePreview",
      args: { target: { kind: "artifact", id: first.artifactId } },
    });
    expect(array(field(preview, "reviewRuns"))).toContainEqual(expect.objectContaining({ runId, action: "redact" }));
    const result = await f.engine.command(ctx, {
      commandId: "mixed-review-purge-first",
      type: "vc.Purge",
      payload: { target: { kind: "artifact", id: first.artifactId } },
    });
    expect(result.ok).toBe(true);
    if (!result.ok) throw new Error(result.error.message);
    await waitForPurge(f.dir, string(field(result.result, "purgeId")));
    const runs = array(await f.engine.query(ctx, { name: "tmr.Runs", args: { limit: 20 } }));
    expect(runs.some((run) => field(run, "runId") === runId)).toBe(true);
    const db = new Database(join(f.dir, "workspace.sqlite")),
      snapshot = db
        .prepare(
          "SELECT json FROM vc_feedback WHERE kind='tmr-snapshot' AND id=(SELECT json_extract(json,'$.snapshotId') " +
            "FROM vc_feedback WHERE kind='tmr-run' AND id=?)",
        )
        .get(runId) as { json: string },
      items = array(field(JSON.parse(snapshot.json), "items"));
    expect(items).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ content: expect.objectContaining({ redacted: true }) }),
        expect.objectContaining({ content: expect.objectContaining({ text: "Surviving second source phrase." }) }),
      ]),
    );
    db.close();
    const files = await workspaceFiles(f.dir),
      retained = await Promise.all(files.map((file) => readFile(file).catch(() => Buffer.alloc(0)))),
      purgedCopies = files.filter((_, index) =>
        retained[index]?.includes(Buffer.from("Sensitive first source phrase.")),
      );
    expect(purgedCopies).toEqual([]);
    expect(Buffer.concat(retained).includes(Buffer.from("Surviving second source phrase."))).toBe(true);
  } finally {
    await f.close();
  }
});

async function setModel(engine: Awaited<ReturnType<typeof fixture>>["engine"]): Promise<void> {
  const result = await engine.command(ctx, {
    commandId: "review-configure-model",
    type: "sys.SetSettings",
    payload: contract.read<Json>("json", { patch: { models: { default: model } } }),
  });
  if (!result.ok) throw new Error(result.error.message);
}
async function workspaceFiles(directory: string): Promise<string[]> {
  const entries = await readdir(directory, { withFileTypes: true }),
    paths = await Promise.all(
      entries.map((entry) => {
        const path = join(directory, entry.name);
        return entry.isDirectory() ? workspaceFiles(path) : Promise.resolve([path]);
      }),
    );
  return paths.flat();
}

async function createDraft(
  engine: Awaited<ReturnType<typeof fixture>>["engine"],
  content = "# Draft\n\nFirst paragraph.\n\nSecond paragraph.",
  title = "Review draft",
): Promise<{ artifactId: string; elements: string[] }> {
  const imported = await engine.command(ctx, {
    commandId: `review-import-draft:${title}`,
    type: "vc.ImportContent",
    payload: { content, format: "markdown", title },
  });
  if (!imported.ok) throw new Error(imported.error.message);
  const artifactId = string(field(imported.result, "artifactId")),
    elements = await elementsFor(engine, artifactId);
  return { artifactId, elements: elements.map((element) => string(field(element, "elementId"))) };
}

async function createSession(
  engine: Awaited<ReturnType<typeof fixture>>["engine"],
  artifactId: string,
): Promise<string> {
  const result = await engine.command(ctx, {
    commandId: "review-start-session",
    type: "vc.StartSession",
    payload: { title: "Review session" },
  });
  if (!result.ok) throw new Error(result.error.message);
  const sessionId = string(field(result.result, "sessionId")),
    attached = await engine.command(ctx, {
      commandId: "review-attach-artifact",
      type: "vc.AttachArtifact",
      payload: { sessionId, artifactId, role: "primary" },
    });
  if (!attached.ok) throw new Error(attached.error.message);
  return sessionId;
}

async function requestReview(
  engine: Awaited<ReturnType<typeof fixture>>["engine"],
  sessionId: string,
  artifactId: string,
  elementIds: string[],
  question: string,
  mode: "live" | "demo" = "live",
): Promise<string> {
  const result = await engine.command(ctx, {
    commandId: `request:${question}`,
    type: "vc.RequestReview",
    payload: {
      sessionId,
      question,
      elementRefs: [{ artifactId, elementIds }],
      preset: "independent-review",
      limits: { spendMicros: 1_000_000_000 },
      mode,
    },
  });
  if (!result.ok) throw new Error(result.error.message);
  return string(field(result.result, "reviewRequestId"));
}

async function waitForReport(
  engine: Awaited<ReturnType<typeof fixture>>["engine"],
  reviewRequestId: string,
): Promise<Json> {
  for (let attempt = 0; attempt < 300; attempt++) {
    try {
      return await engine.query(ctx, { name: "vc.ReviewReport", args: { reviewRequestId } });
    } catch {
      await delay();
    }
  }
  throw new Error("TMR review report did not arrive");
}
async function waitForUpdate(engine: Awaited<ReturnType<typeof fixture>>["engine"], updateId: string): Promise<Json> {
  for (let attempt = 0; attempt < 300; attempt++) {
    const update = await engine.query(ctx, { name: "vc.UpdateDetail", args: { updateId } });
    if (["committed", "partially_committed", "failed", "cancelled"].includes(string(field(update, "status"))))
      return update;
    await delay();
  }
  throw new Error("Update did not finish");
}
async function waitForPurge(directory: string, purgeId: string): Promise<void> {
  const db = new Database(join(directory, "workspace.sqlite"));
  for (let attempt = 0; attempt < 300; attempt++) {
    const pending = db.prepare("SELECT 1 FROM vc_feedback WHERE kind='purge-request' AND id=?").get(purgeId);
    if (!pending) {
      db.close();
      return;
    }
    await delay();
  }
  db.close();
  throw new Error("Purge job did not complete");
}
async function feedbackItems(
  engine: Awaited<ReturnType<typeof fixture>>["engine"],
  sessionId: string,
): Promise<Json[]> {
  return array(await engine.query(ctx, { name: "vc.FeedbackItems", args: { sessionId } }));
}
async function waitForFindings(
  engine: Awaited<ReturnType<typeof fixture>>["engine"],
  sessionId: string,
  findingIds: string[],
): Promise<Json[]> {
  for (let attempt = 0; attempt < 300; attempt++) {
    const items = await feedbackItems(engine, sessionId);
    if (findingIds.every((findingId) => byFinding(items, findingId))) return items;
    advanceClock(1_000);
    await delay();
  }
  throw new Error(`Review findings were not delivered: ${findingIds.join(", ")}`);
}
async function elementsFor(engine: Awaited<ReturnType<typeof fixture>>["engine"], artifactId: string): Promise<Json[]> {
  return array(await engine.query(ctx, { name: "vc.Elements", args: { artifactId } }));
}
async function agree(
  engine: Awaited<ReturnType<typeof fixture>>["engine"],
  commentId: string,
  commandId: string,
): Promise<void> {
  const result = await engine.command(ctx, { commandId, type: "vc.Agree", payload: { commentId, kind: "as_written" } });
  if (!result.ok) throw new Error(result.error.message);
}
function byFinding(items: Json[], findingId: string): Json | undefined {
  return items.find((item) => field(field(item, "source"), "findingId") === findingId);
}
function finding(
  findingId: string,
  concern: string,
  rationale: string,
  suggestion: string | undefined,
  refs: Json[],
): Json {
  return {
    findingId,
    concern,
    rationale,
    refs,
    supportedBy: ["reviewer-1"],
    opposedBy: [],
    ...(suggestion ? { suggestion } : {}),
  };
}
function array(value: unknown): Json[] {
  return Array.isArray(value) ? value.filter(isJson) : [];
}
function field(value: unknown, key: string): unknown {
  return value && typeof value === "object" ? Reflect.get(value, key) : undefined;
}
function string(value: unknown): string {
  if (typeof value !== "string") throw new Error("Expected string");
  return value;
}
function isJson(value: unknown): value is Json {
  if (value === null || typeof value === "string" || typeof value === "number" || typeof value === "boolean")
    return true;
  if (Array.isArray(value)) return value.every(isJson);
  return typeof value === "object" && value !== null && Object.values(value).every(isJson);
}
function delay(): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, 10));
}
