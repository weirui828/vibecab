import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type {
  CallContext,
  CommandEnvelope,
  CommandResult,
  EventEnvelope,
  Json,
  QueryEnvelope,
  Subscription,
} from "../../../contract/src/index.js";
import { Contract } from "../../../contract/src/index.js";
import { ctx } from "../helpers.js";
export interface Client {
  command(ctx: CallContext, cmd: CommandEnvelope): Promise<CommandResult>;
  query(ctx: CallContext, q: QueryEnvelope): Promise<Json>;
  subscribe(ctx: CallContext, sub: Subscription): AsyncIterable<EventEnvelope>;
  putBlob(ctx: CallContext, bytes: Uint8Array, mediaType: string): Promise<string>;
  getBlob(ctx: CallContext, hash: string): Promise<Uint8Array>;
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
    const cmd = (type: string, payload: Json, commandId = "cmd-" + ++n, context = ctx) =>
      client.command(context, { commandId, type, payload });
    const query = (name: string, args: Json = {}) => client.query(ctx, { name, args });
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
      expect(
        (
          await cmd("vc.ImportContent", {
            artifactId: a.artifactId,
            content: "Appended",
            format: "text",
          })
        ).ok,
      ).toBe(true);
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
      expect(await query("vc.Versions", { artifactId: a.artifactId })).toHaveLength(3);
      expect(await query("vc.Elements", { artifactId: a.artifactId, version: 3 })).toEqual(elements);
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
        schema.read("call-context", {
          ...ctx,
          principal: { kind: "agent", turnId: "forged" },
        }),
      ).toThrow();
      expect(await cmd("vc.Comment", {})).toMatchObject({
        ok: false,
        error: { code: "invalid" },
      });
      expect(
        await cmd("vc.CreateArtifact", { title: "Read", mediaKind: "doc" }, undefined, { ...ctx, scope: "read" }),
      ).toMatchObject({ ok: false, error: { code: "forbidden" } });
      expect(
        await cmd("vc.CreateArtifact", { title: "Wrong version", mediaKind: "doc" }, undefined, {
          ...ctx,
          contractVersion: "2.0",
        }),
      ).toMatchObject({ ok: false, error: { code: "unsupported" } });
      await expect(client.query(ctx, { name: "vc.Settings", args: {} })).rejects.toMatchObject({
        contract: { code: "unsupported" },
      });
    });
    it("is idempotent and does not widen authority on retry", async () => {
      const first = await cmd("vc.CreateArtifact", { title: "Once", mediaKind: "doc" }, "same");
      expect(await cmd("vc.CreateArtifact", { title: "Different", mediaKind: "doc" }, "same")).toEqual(first);
      expect(
        await cmd("vc.CreateArtifact", { title: "Once", mediaKind: "doc" }, "same", { ...ctx, scope: "read" }),
      ).toMatchObject({ ok: false, error: { code: "forbidden" } });
    });
    it("validates every operation payload and retains failed command results", async () => {
      const capabilities = schema.read<import("../../../contract/src/index.js").SysCapabilitiesOperation["result"]>(
        "operations/sys.Capabilities",
        await query("sys.Capabilities"),
        "#/properties/result",
      );
      for (const op of capabilities.operations.filter((op) => op.supported)) {
        if (op.kind === "command")
          expect(await cmd(op.name, [])).toMatchObject({
            ok: false,
            error: { code: "invalid" },
          });
        else
          await expect(query(op.name, [])).rejects.toMatchObject({
            contract: { code: "invalid" },
          });
      }
      const first = await cmd("vc.CreateArtifact", { mediaKind: "doc" }, "failed-id");
      expect(first).toMatchObject({ ok: false, error: { code: "invalid" } });
      expect(await cmd("vc.CreateArtifact", { title: "Retry", mediaKind: "doc" }, "failed-id")).toEqual(first);
    });
    it("replays and resumes events without gaps or duplicates", async () => {
      const a = await imported();
      await cmd("vc.ImportContent", {
        artifactId: a.artifactId,
        format: "text",
        content: "Next",
      });
      const iterator = client.subscribe(ctx, { afterSeq: 0 })[Symbol.asyncIterator]();
      const seqs: number[] = [];
      for (let i = 0; i < 3; i++) seqs.push((await iterator.next()).value!.seq);
      expect(seqs).toEqual([1, 2, 3]);
      await iterator.return?.();
      const resumed = client.subscribe(ctx, { afterSeq: 3 })[Symbol.asyncIterator]();
      const live = resumed.next();
      await cmd("vc.ImportContent", {
        artifactId: a.artifactId,
        format: "text",
        content: "Live",
      });
      expect((await live).value!.seq).toBe(4);
      await resumed.return?.();
    });
    it("stores and reads content-addressed blobs", async () => {
      const bytes = new TextEncoder().encode("blob");
      const hash = await client.putBlob(ctx, bytes, "text/plain");
      expect(hash).toMatch(/^[a-f0-9]{64}$/);
      expect(await client.getBlob(ctx, hash)).toEqual(bytes);
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
      expect(
        await cmd("vc.Comment", { sessionId, body: "Denied" }, undefined, {
          ...ctx,
          scope: "read",
        }),
      ).toMatchObject({ ok: false, error: { code: "forbidden" } });
    });
  });
}
