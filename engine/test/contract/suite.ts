import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type {
  CommandEnvelope,
  CommandResult,
  EventEnvelope,
  Json,
  QueryEnvelope,
  Subscription,
} from "../../../contract/src/index.js";
import { Contract } from "../../../contract/src/index.js";
export interface Client {
  channel?: "in_process" | "http" | "cli" | "mcp";
  command(cmd: CommandEnvelope): Promise<CommandResult>;
  query(q: QueryEnvelope): Promise<Json>;
  subscribe(sub: Subscription): AsyncIterable<EventEnvelope>;
  putBlob(bytes: Uint8Array, mediaType: string): Promise<string>;
  getBlob(hash: string): Promise<Uint8Array>;
}
export function contractSuite(
  name: string,
  setup: () => Promise<{
    client: Client;
    close: () => Promise<void>;
  }>,
) {
  describe(name, () => {
    let client: Client,
      close: () => Promise<void>,
      n = 0;
    const schema = new Contract();
    const cmd = (type: string, payload: Json, commandId = "cmd-" + ++n) => client.command({ commandId, type, payload });
    const query = (name: string, args: Json = {}) => client.query({ name, args });
    async function imported(content = "Alpha beta", format: "text" | "markdown" = "text") {
      const r = await cmd("vc.ImportContent", {
        content,
        format,
        title: "Test",
      });
      expect(r.ok).toBe(true);
      if (!r.ok) throw Error();
      return schema.read<{
        artifactId: string;
        version: number;
      }>("operations/vc.ImportContent", r.result, "#/properties/result");
    }
    beforeEach(async () => {
      ({ client, close } = await setup());
    });
    afterEach(async () => {
      await close();
    });
    it("supports every L1 operation through validated results", async () => {
      const empty = await cmd("vc.CreateArtifact", {
        title: "Empty",
        mediaKind: "doc",
      });
      expect(empty.ok).toBe(true);
      const a = await imported("# Heading\n\nAlpha **beta**\n\n- One\n- Two", "markdown");
      const artifact = await query("vc.Artifact", { artifactId: a.artifactId });
      expect(artifact).toMatchObject({ headVersion: 1, mediaKind: "doc" });
      const outline = await query("vc.Outline", { artifactId: a.artifactId });
      expect(outline).toHaveLength(3);
      const elements = schema.read<import("../../../contract/src/index.js").VcElementsOperation["result"]>(
        "operations/vc.Elements",
        await query("vc.Elements", { artifactId: a.artifactId }),
        "#/properties/result",
      );
      expect(elements.map((e) => e.type)).toEqual(
        expect.arrayContaining(["heading", "paragraph", "list", "list_item"]),
      );
      const versions = schema.read<import("../../../contract/src/index.js").Version[]>(
        "operations/vc.Versions",
        await query("vc.Versions", { artifactId: a.artifactId }),
        "#/properties/result",
      );
      const element = elements[0]!;
      expect(
        await query("vc.ResolveAnchors", {
          anchors: [
            {
              artifactId: a.artifactId,
              elementId: element.elementId,
              seenVersion: 1,
              seenHash: versions[0]!.manifest[element.elementId]!,
            },
          ],
        }),
      ).toMatchObject([{ state: "current" }]);
      const appended = await cmd("vc.ImportContent", {
        artifactId: a.artifactId,
        content: "Appended",
        format: "text",
      });
      if (client.channel === "mcp") {
        expect(appended).toMatchObject({
          ok: false,
          error: { code: "forbidden", details: { reason: "existing_artifact_import_not_allowed_through_mcp" } },
        });
        expect(await query("vc.Versions", { artifactId: a.artifactId })).toHaveLength(1);
      } else expect(appended.ok).toBe(true);
      if (client.channel !== "mcp")
        expect(await query("vc.Diff", { artifactId: a.artifactId, from: 1, to: 2 })).toMatchObject({
          removed: [],
          changed: [],
          moved: [],
        });
      expect(
        (
          await cmd("vc.RestoreVersion", {
            artifactId: a.artifactId,
            version: 1,
          })
        ).ok,
      ).toBe(true);
      expect(await query("vc.Versions", { artifactId: a.artifactId })).toHaveLength(client.channel === "mcp" ? 2 : 3);
      expect(
        await query("vc.Elements", { artifactId: a.artifactId, version: client.channel === "mcp" ? 2 : 3 }),
      ).toEqual(elements);
      expect(await query("sys.Capabilities")).toMatchObject({
        contractVersion: "1.0",
        mediaKinds: ["doc"],
      });
    });
    it("rejects invalid input, unsupported operations, and inadequate authority", async () => {
      expect(await cmd("vc.CreateArtifact", { title: "Bad", mediaKind: "page" })).toMatchObject({
        ok: false,
        error: { code: "invalid" },
      });
      expect(
        await cmd("vc.CreateProject", {
          title: "Forged principal",
          principal: { kind: "agent", turnId: "forged" },
        }),
      ).toMatchObject({ ok: false, error: { code: "invalid" } });
      expect(() =>
        schema.read("call-metadata", { contractVersion: "1.0", requestId: "forged", channel: "http", scope: "admin" }),
      ).toThrow();
      expect(await cmd("vc.Comment", {})).toMatchObject({
        ok: false,
        error: { code: "invalid" },
      });
      await expect(client.query({ name: "vc.Settings", args: {} })).rejects.toMatchObject({
        contract: { code: "unsupported" },
      });
    });
    it("is idempotent and does not widen authority on retry", async () => {
      const first = await cmd("vc.CreateArtifact", { title: "Once", mediaKind: "doc" }, "same");
      expect(await cmd("vc.CreateArtifact", { title: "Different", mediaKind: "doc" }, "same")).toEqual(first);
    });
    it("validates every operation payload and retains failed command results", async () => {
      const capabilities = schema.read<import("../../../contract/src/index.js").SysCapabilitiesOperation["result"]>(
        "operations/sys.Capabilities",
        await query("sys.Capabilities"),
        "#/properties/result",
      );
      for (const op of capabilities.operations.filter((op) => op.supported)) {
        const channelAllowed = op.meta.channels.includes(client.channel ?? "in_process");
        if (op.kind === "command")
          expect(await cmd(op.name, [])).toMatchObject({
            ok: false,
            error: { code: channelAllowed ? "invalid" : "forbidden" },
          });
        else
          await expect(query(op.name, [])).rejects.toMatchObject({
            contract: { code: channelAllowed ? "invalid" : "forbidden" },
          });
      }
      const first = await cmd("vc.CreateArtifact", { mediaKind: "doc" }, "failed-id");
      expect(first).toMatchObject({ ok: false, error: { code: "invalid" } });
      expect(await cmd("vc.CreateArtifact", { title: "Retry", mediaKind: "doc" }, "failed-id")).toEqual(first);
    });
    it("replays and resumes events without gaps or duplicates", async () => {
      const a = await imported();
      if (client.channel === "mcp") await cmd("vc.CreateArtifact", { title: "Next", mediaKind: "doc" });
      else await cmd("vc.ImportContent", { artifactId: a.artifactId, format: "text", content: "Next" });
      const iterator = client.subscribe({ afterSeq: 0 })[Symbol.asyncIterator]();
      const seqs: number[] = [];
      for (let i = 0; i < 3; i++) seqs.push((await iterator.next()).value!.seq);
      expect(seqs).toEqual([1, 2, 3]);
      await iterator.return?.();
      const resumed = client.subscribe({ afterSeq: 3 })[Symbol.asyncIterator]();
      const live = resumed.next();
      if (client.channel === "mcp") await cmd("vc.CreateArtifact", { title: "Live", mediaKind: "doc" });
      else await cmd("vc.ImportContent", { artifactId: a.artifactId, format: "text", content: "Live" });
      expect((await live).value!.seq).toBe(4);
      await resumed.return?.();
    });
    it("stores and reads content-addressed blobs", async () => {
      const bytes = new TextEncoder().encode("blob");
      const hash = await client.putBlob(bytes, "text/plain");
      expect(hash).toMatch(/^[a-f0-9]{64}$/);
      expect(await client.getBlob(hash)).toEqual(bytes);
    });
    it("marks comments read, only within their own session", async () => {
      const read = <T>(op: string, result: unknown) =>
        schema.read<T>("operations/" + op, result, "#/properties/result");
      const one = await cmd("vc.StartSession", { title: "Reading" }),
        other = await cmd("vc.StartSession", { title: "Elsewhere" });
      if (!one.ok || !other.ok) throw Error("setup failed");
      const sessionId = read<{ sessionId: string }>("vc.StartSession", one.result).sessionId,
        otherId = read<{ sessionId: string }>("vc.StartSession", other.result).sessionId;
      const posted = await cmd("vc.Comment", { sessionId, body: "Read me." });
      if (!posted.ok) throw Error("setup failed");
      const { commentId } = read<{ commentId: string }>("vc.Comment", posted.result);
      expect(await cmd("vc.MarkRead", { sessionId, commentIds: [commentId] })).toMatchObject({
        ok: true,
        result: { commentIds: [commentId] },
      });
      expect(await cmd("vc.MarkRead", { sessionId: otherId, commentIds: [commentId] })).toMatchObject({
        ok: false,
        error: { code: "not_found" },
      });
      expect(await cmd("vc.MarkRead", { sessionId, commentIds: [] })).toMatchObject({
        ok: false,
        error: { code: "invalid" },
      });
    });
    it("edits an Idea's text and keeps everything else", async () => {
      const idea = await cmd("vc.CaptureIdea", { text: "A rough thught", links: ["https://example.test/a"] });
      if (!idea.ok) throw Error("setup failed");
      const { ideaId } = schema.read<{ ideaId: string }>(
        "operations/vc.CaptureIdea",
        idea.result,
        "#/properties/result",
      );
      expect(await cmd("vc.EditIdea", { ideaId, text: "A rough thought" })).toMatchObject({
        ok: true,
        result: { ideaId },
      });
      const ideas = schema.read<Array<{ ideaId: string; text: string; links?: string[] }>>(
        "operations/vc.Ideas",
        await query("vc.Ideas"),
        "#/properties/result",
      );
      expect(ideas.find((i) => i.ideaId === ideaId)).toMatchObject({
        text: "A rough thought",
        links: ["https://example.test/a"],
      });
      expect(await cmd("vc.EditIdea", { ideaId, text: "" })).toMatchObject({ ok: false, error: { code: "invalid" } });
      expect(await cmd("vc.EditIdea", { ideaId: "idea_missing", text: "x" })).toMatchObject({
        ok: false,
        error: { code: "not_found" },
      });
    });
    it("attaches and detaches Ideas, Drafts and Sessions on a Project", async () => {
      const read = <T>(op: string, result: unknown) =>
        schema.read<T>("operations/" + op, result, "#/properties/result");
      const project = await cmd("vc.CreateProject", { title: "Gathered" }),
        idea = await cmd("vc.CaptureIdea", { text: "A thought" });
      if (!project.ok || !idea.ok) throw Error("setup failed");
      const projectId = read<{ projectId: string }>("vc.CreateProject", project.result).projectId,
        ideaId = read<{ ideaId: string }>("vc.CaptureIdea", idea.result).ideaId;
      // Gathering items into a Project is not offered to an assistant over MCP.
      if (client.channel === "mcp") {
        expect(await cmd("vc.AttachProjectItem", { projectId, item: { kind: "idea", id: ideaId } })).toMatchObject({
          ok: false,
          error: { code: "forbidden" },
        });
        return;
      }
      expect(await cmd("vc.AttachProjectItem", { projectId, item: { kind: "idea", id: ideaId } })).toMatchObject({
        ok: true,
      });
      expect(await query("vc.Projects", {})).toMatchObject([{ projectId, ideaIds: [ideaId] }]);
      expect(await cmd("vc.DetachProjectItem", { projectId, item: { kind: "idea", id: ideaId } })).toMatchObject({
        ok: true,
      });
      expect(await query("vc.Projects", {})).toMatchObject([{ projectId, ideaIds: [] }]);
    });

    it("supports project sessions, attached anchored threads, and explicit agreement", async () => {
      const a = await imported("Target sentence.");
      const project = await cmd("vc.CreateProject", { title: "Draft" });
      expect(project.ok).toBe(true);
      if (!project.ok) throw Error();
      const projectId = schema.read<{ projectId: string }>(
        "operations/vc.CreateProject",
        project.result,
        "#/properties/result",
      ).projectId;
      const started = await cmd("vc.StartSession", {
        title: "Review",
        primaryProjectId: projectId,
        replyTrigger: "manual",
      });
      expect(started.ok).toBe(true);
      if (!started.ok) throw Error();
      const sessionId = schema.read<{ sessionId: string }>(
        "operations/vc.StartSession",
        started.result,
        "#/properties/result",
      ).sessionId;
      expect(
        (
          await cmd("vc.AttachArtifact", {
            sessionId,
            artifactId: a.artifactId,
            role: "primary",
          })
        ).ok,
      ).toBe(true);
      const elements = schema.read<import("../../../contract/src/index.js").VcElementsOperation["result"]>(
        "operations/vc.Elements",
        await query("vc.Elements", { artifactId: a.artifactId }),
        "#/properties/result",
      );
      const elementId = elements[0]!.elementId;
      const posted = await cmd("vc.Comment", {
        sessionId,
        anchor: {
          artifactId: a.artifactId,
          elementId,
          seenVersion: 1,
          locator: { quote: "sentence", prefix: "Target ", suffix: "." },
        },
        body: "Tighten this.",
        suggestion: { replacement: "line" },
      });
      expect(posted.ok).toBe(true);
      if (!posted.ok) throw Error();
      const commentId = schema.read<{ commentId: string }>(
        "operations/vc.Comment",
        posted.result,
        "#/properties/result",
      ).commentId;
      const thread = schema.read<import("../../../contract/src/index.js").Thread[]>(
        "operations/vc.Threads",
        await query("vc.Threads", { sessionId }),
        "#/properties/result",
      )[0]!;
      expect(thread.comments[0]!.anchor?.seenHash).toMatch(/^[a-f0-9]{64}$/);
      expect(thread.anchorResolutions[0]!.state).toBe("current");
      expect((await cmd("vc.Agree", { commentId, kind: "as_written" })).ok).toBe(true);
      expect(await query("vc.FeedbackItems", { sessionId })).toMatchObject([{ commentId, state: "agreed" }]);
      expect(await query("vc.Sessions", {})).toMatchObject([{ sessionId, state: "active", replyTrigger: "manual" }]);
      expect(await query("vc.Sessions", { sessionId })).toMatchObject([{ sessionId, artifactIds: [a.artifactId] }]);
      expect(await query("vc.Artifacts", { sessionId })).toMatchObject([
        { artifactId: a.artifactId, sessionIds: [sessionId], role: "primary" },
      ]);
      expect(await query("vc.Artifacts", {})).toMatchObject([
        { artifactId: a.artifactId, updatedAt: expect.any(String) },
      ]);
      // A session lists every attached Draft with the role it was attached as, reference Drafts included.
      const reference = await cmd("vc.CreateArtifact", { title: "Reference draft", mediaKind: "doc" });
      if (!reference.ok) throw Error(reference.error.message);
      const referenceId = schema.read<{ artifactId: string }>(
        "operations/vc.CreateArtifact",
        reference.result,
        "#/properties/result",
      ).artifactId;
      expect((await cmd("vc.AttachArtifact", { sessionId, artifactId: referenceId, role: "reference" })).ok).toBe(true);
      const listed = schema.read<Array<{ artifactId: string; role?: string }>>(
        "operations/vc.Artifacts",
        await query("vc.Artifacts", { sessionId }),
        "#/properties/result",
      );
      expect(listed.map(({ artifactId, role }) => ({ artifactId, role }))).toEqual(
        expect.arrayContaining([
          { artifactId: a.artifactId, role: "primary" },
          { artifactId: referenceId, role: "reference" },
        ]),
      );
      expect((await cmd("vc.Trash", { target: { kind: "artifact", id: referenceId } })).ok).toBe(true);
      expect((await cmd("vc.RenameArtifact", { artifactId: a.artifactId, title: "Renamed draft" })).ok).toBe(true);
      expect(await query("vc.Artifact", { artifactId: a.artifactId })).toMatchObject({ title: "Renamed draft" });
      expect((await cmd("vc.RenameSession", { sessionId, title: "Renamed session" })).ok).toBe(true);
      expect(await query("vc.Sessions", { sessionId })).toMatchObject([{ title: "Renamed session" }]);
    });
  });
}
