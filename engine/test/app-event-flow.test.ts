import { readFileSync } from "node:fs";
import { expect, it } from "vitest";
import { Contract } from "../../contract/src/index.js";
import type { EventEnvelope, Json, ProviderModel } from "../../contract/src/index.js";
import { ScriptedProvider } from "../src/gateway/fake.js";
import { ctx, fixture } from "./helpers.js";

const model: ProviderModel = {
  provider: "openai-compatible",
  baseUrl: "https://model.example.test/v1",
  model: "event-audit",
  capabilities: { tools: true, jsonSchemaOutput: true, streaming: true, maxContextTokens: 4096, reportsUsage: true },
  pricing: { inputMicrosPerMillion: 0, outputMicrosPerMillion: 0 },
};

it("emits and query-resolves events for comment, reply, agreement, Update, Snapshot, and export", async () => {
  const provider = new ScriptedProvider();
  let threadId = "";
  provider.setDefaultHandler(() => [
    {
      type: "tool_call",
      call: {
        id: "reply-tool-call",
        name: "reply",
        arguments: { threadId, body: "I reviewed this wording." },
      },
    },
    { type: "done", finishReason: "tool_calls" },
    { type: "text_delta", text: "I replied in the thread." },
    { type: "done", finishReason: "stop" },
  ]);
  const f = await fixture({ modelProviders: { "openai-compatible": provider } });
  const contract = new Contract(),
    subscription = f.engine.subscribe(ctx, { afterSeq: 0 })[Symbol.asyncIterator](),
    events: EventEnvelope[] = [];
  let collecting = true;
  const pump = (async () => {
    while (collecting) {
      const next = await subscription.next();
      if (next.done) break;
      events.push(next.value);
    }
  })();
  try {
    await command(
      f.engine,
      "sys.SetSettings",
      "audit-settings",
      contract.read<Json>("json", {
        patch: { models: { default: model }, budgets: { defaultTurnLimitMicros: 100_000, toolCallLimit: 12 } },
      }),
    );
    const imported = await command(f.engine, "vc.ImportContent", "audit-import", {
      content: "The quick brown fox.",
      format: "text",
      title: "Audit draft",
    });
    const artifactId = string(field(imported, "artifactId"));
    const elements = array(await f.engine.query(ctx, { name: "vc.Elements", args: { artifactId } })),
      elementId = string(field(elements[0], "elementId"));
    const project = await command(f.engine, "vc.CreateProject", "audit-project", { title: "Audit" }),
      projectId = string(field(project, "projectId")),
      session = await command(f.engine, "vc.StartSession", "audit-session", {
        title: "Audit session",
        primaryProjectId: projectId,
        replyTrigger: "manual",
      }),
      sessionId = string(field(session, "sessionId"));
    await command(f.engine, "vc.AttachArtifact", "audit-attach", { sessionId, artifactId, role: "primary" });
    const comment = await command(f.engine, "vc.Comment", "audit-comment", {
      sessionId,
      body: "Please strengthen the verb.",
      anchor: {
        artifactId,
        elementId,
        seenVersion: 1,
        locator: { quote: "quick", prefix: "The ", suffix: " brown" },
      },
      suggestion: { replacement: "swift" },
    });
    threadId = string(field(comment, "threadId"));
    const asked = await command(f.engine, "vc.AskAgent", "audit-ask", { sessionId, threadIds: [threadId] }),
      turnId = string(field(asked, "turnId"));
    await waitUntil(async () => {
      const turns = array(await f.engine.query(ctx, { name: "vc.AgentTurns", args: { sessionId } }));
      return turns.some((turn) => field(turn, "turnId") === turnId && field(turn, "status") === "completed");
    });
    await command(f.engine, "vc.Agree", "audit-agree", {
      commentId: string(field(comment, "commentId")),
      kind: "as_written",
    });
    const started = await command(f.engine, "vc.StartUpdate", "audit-update", { artifactId }),
      updateId = string(field(started, "updateId"));
    await waitUntil(async () => {
      const update = contract.read<{ status: string }>(
        "operations/vc.UpdateDetail",
        await f.engine.query(ctx, {
          name: "vc.UpdateDetail",
          args: { updateId },
        }),
        "#/properties/result",
      );
      return update.status === "committed" || update.status === "partially_committed";
    });
    const snapshot = await command(f.engine, "vc.CreateOutputSet", "audit-snapshot", {
      sessionId,
      artifactIds: [artifactId],
    });
    const exported = await command(f.engine, "vc.Export", "audit-export", {
      target: { artifactId, version: 2 },
      format: "markdown",
    });
    const exportId = string(field(exported, "exportId"));
    await waitUntil(async () => {
      const records = array(await f.engine.query(ctx, { name: "vc.Exports", args: {} }));
      return records.some(
        (record) => field(record, "exportId") === exportId && field(record, "status") === "completed",
      );
    });
    await new Promise((resolve) => setTimeout(resolve, 20));
    collecting = false;
    await subscription.return?.();
    await pump;

    const appTypes = events.map((event) => event.type).filter((type) => type.startsWith("vc."));
    expect(appTypes).toEqual([
      "vc.ArtifactCreated",
      "vc.VersionCommitted",
      "vc.ProjectCreated",
      "vc.SessionStarted",
      "vc.ArtifactAttached",
      "vc.CommentPosted",
      "vc.DeliveryStateChanged",
      "vc.AgentTurnChanged",
      "vc.DeliveryStateChanged",
      "vc.AgentTurnChanged",
      "vc.DeliveryStateChanged",
      "vc.CommentPosted",
      "vc.DeliveryStateChanged",
      "vc.AgentTurnChanged",
      "vc.FeedbackStateChanged",
      "vc.UpdateChanged",
      "vc.UpdateChanged",
      "vc.VersionCommitted",
      "vc.DeliveryStateChanged",
      "vc.CommentPosted",
      "vc.UpdateChanged",
      "vc.LifecycleChanged",
      "vc.LifecycleChanged",
      "vc.LifecycleChanged",
    ]);
    expect(string(field(snapshot, "outputSetId"))).toBeTruthy();
    expect(appTypes.filter((type) => type === "vc.LifecycleChanged").length).toBeGreaterThanOrEqual(2);
    await assertEventsResolveToQueries(events, f.engine, contract, artifactId, sessionId);
  } finally {
    collecting = false;
    await subscription.return?.();
    await pump;
    await f.close();
  }
});

async function command(
  engine: Awaited<ReturnType<typeof fixture>>["engine"],
  type: string,
  commandId: string,
  payload: Json,
): Promise<Json> {
  const result = await engine.command(
    ctx,
    new Contract().read<import("../../contract/src/index.js").CommandEnvelope>("command-envelope", {
      type,
      commandId,
      payload,
    }),
  );
  if (!result.ok) throw Error(`${type}: ${result.error.code}: ${result.error.message}`);
  return new Contract().read<Json>(`operations/${type}`, result.result, "#/properties/result");
}

async function assertEventsResolveToQueries(
  events: EventEnvelope[],
  engine: Awaited<ReturnType<typeof fixture>>["engine"],
  contract: Contract,
  artifactId: string,
  sessionId: string,
) {
  const rows = readFileSync("docs/design/app-events.md", "utf8")
    .split("\n")
    .filter((line) => line.startsWith("| `"));
  for (const event of events) {
    const row = rows.find((line) => line.includes(`\`${event.type}\``));
    if (!row) continue;
    const queryNames = [...(row.split("|")[3] ?? "").matchAll(/`((?:vc|sys)\.[A-Z][A-Za-z]+)`/g)].map(
      (match) => match[1]!,
    );
    let resolved = false;
    for (const name of queryNames) {
      const args = contract.read<Json>("json", queryArgs(contract, name, event, artifactId, sessionId));
      try {
        const result = await engine.query(ctx, { name, args });
        if (
          containsEntity(result, event.entity.id) ||
          (event.entity.kind === "settings" && name === "sys.Settings" && result !== undefined)
        )
          resolved = true;
      } catch {
        // A query with unrelated required identifiers is not the query for this entity.
      }
    }
    expect(resolved, `${event.type} entity ${event.entity.id} was not returned by ${queryNames.join(", ")}`).toBe(true);
  }
}

function queryArgs(contract: Contract, name: string, event: EventEnvelope, artifactId: string, sessionId: string) {
  const schema = contract.schema(`operations/${name}`),
    schemaProperties = Reflect.get(schema, "properties"),
    payload =
      typeof schemaProperties === "object" && schemaProperties !== null
        ? Reflect.get(schemaProperties, "payload")
        : undefined,
    required = payload && Reflect.get(payload, "required"),
    args: Record<string, string> = {};
  if (!Array.isArray(required)) return args;
  for (const key of required) {
    if (key === "artifactId") args[key] = artifactId;
    else if (key === "sessionId") args[key] = sessionId;
    else if (key === "commentId" && event.entity.kind === "comment") args[key] = event.entity.id;
    else if (key === "updateId" && event.entity.kind === "update") args[key] = event.entity.id;
    else if (key === "outputSetId" && event.entity.kind === "output_set") args[key] = event.entity.id;
    else continue;
  }
  return args;
}

function containsEntity(value: unknown, id: string): boolean {
  if (value === id) return true;
  if (Array.isArray(value)) return value.some((item) => containsEntity(item, id));
  if (typeof value !== "object" || value === null) return false;
  return Object.values(value).some((item) => containsEntity(item, id));
}

async function waitUntil(check: () => Promise<boolean>) {
  for (let attempt = 0; attempt < 200; attempt++) {
    if (await check()) return;
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  throw new Error("Timed out waiting for scripted app event flow");
}

function field(value: unknown, key: string): unknown {
  if (typeof value !== "object" || value === null || !Reflect.has(value, key)) throw new Error(`Missing ${key}`);
  return Reflect.get(value, key);
}

function string(value: unknown): string {
  if (typeof value !== "string") throw new Error("Expected string");
  return value;
}

function array(value: unknown): Json[] {
  if (!Array.isArray(value)) throw new Error("Expected array");
  return value.map((item) => new Contract().read<Json>("json", item));
}
