import { describe, expect, it } from "vitest";
import fc from "fast-check";
import { Contract } from "../../contract/src/index.js";
import type { Anchor, FeedbackConflict } from "../../contract/src/index.js";
import { ctx, fixture } from "./helpers.js";
let commandSequence = 0;

async function command(
  f: Awaited<ReturnType<typeof fixture>>,
  type: string,
  payload: unknown,
  commandId = type + "-" + ++commandSequence,
) {
  return f.engine.command(ctx, {
    commandId,
    type,
    payload: new Contract().read("json", payload),
  });
}
async function setupSession(
  f: Awaited<ReturnType<typeof fixture>>,
  content: string,
  format: "text" | "markdown" = "text",
) {
  const imported = await command(f, "vc.ImportContent", { content, format }, "import");
  if (!imported.ok) throw Error(imported.error.message);
  const a = new Contract().read<{ artifactId: string }>(
    "operations/vc.ImportContent",
    imported.result,
    "#/properties/result",
  );
  const project = await command(f, "vc.CreateProject", { title: "Project" }, "project");
  if (!project.ok) throw Error(project.error.message);
  const p = new Contract().read<{ projectId: string }>(
    "operations/vc.CreateProject",
    project.result,
    "#/properties/result",
  );
  const started = await command(f, "vc.StartSession", { title: "Session", primaryProjectId: p.projectId }, "session");
  if (!started.ok) throw Error(started.error.message);
  const session = new Contract().read<{ sessionId: string }>(
    "operations/vc.StartSession",
    started.result,
    "#/properties/result",
  );
  const attached = await command(
    f,
    "vc.AttachArtifact",
    { sessionId: session.sessionId, artifactId: a.artifactId, role: "primary" },
    "attach",
  );
  if (!attached.ok) throw Error(attached.error.message);
  const elements = await f.engine.query(ctx, {
    name: "vc.Elements",
    args: { artifactId: a.artifactId },
  });
  const e = new Contract().read<import("../../contract/src/index.js").Element[]>(
    "operations/vc.Elements",
    elements,
    "#/properties/result",
  );
  const versions = await f.engine.query(ctx, {
    name: "vc.Versions",
    args: { artifactId: a.artifactId },
  });
  const version = new Contract().read<import("../../contract/src/index.js").Version[]>(
    "operations/vc.Versions",
    versions,
    "#/properties/result",
  )[0]!;
  return {
    artifactId: a.artifactId,
    sessionId: session.sessionId,
    elements: e,
    version,
  };
}
async function comment(
  f: Awaited<ReturnType<typeof fixture>>,
  sessionId: string,
  anchor: Omit<Anchor, "seenHash">,
  body: string,
  replacement: string | undefined,
  commandId: string,
) {
  const result = await command(
    f,
    "vc.Comment",
    {
      sessionId,
      anchor,
      body,
      ...(replacement === undefined ? {} : { suggestion: { replacement } }),
    },
    commandId,
  );
  if (!result.ok) throw Error(result.error.message);
  return new Contract().read<{ commentId: string; threadId: string }>(
    "operations/vc.Comment",
    result.result,
    "#/properties/result",
  );
}
async function agree(f: Awaited<ReturnType<typeof fixture>>, commentId: string, commandId: string) {
  const result = await command(f, "vc.Agree", { commentId, kind: "as_written" }, commandId);
  if (!result.ok) throw Error(result.error.message);
  return new Contract().read<{ agreementId: string }>("operations/vc.Agree", result.result, "#/properties/result");
}
describe("feedback", () => {
  it("captures ideas, lists projects, and validates session lifecycle and reply-trigger settings", async () => {
    const f = await fixture();
    try {
      const captured = await command(
        f,
        "vc.CaptureIdea",
        { text: "A useful idea", links: ["https://example.test/source"] },
        "idea",
      );
      expect(captured.ok).toBe(true);
      const ideas = new Contract().read<import("../../contract/src/index.js").Idea[]>(
        "operations/vc.Ideas",
        await f.engine.query(ctx, { name: "vc.Ideas", args: {} }),
        "#/properties/result",
      );
      expect(ideas).toHaveLength(1);
      const data = await setupSession(f, "Session lifecycle.");
      expect(await command(f, "vc.PauseSession", { sessionId: data.sessionId }, "pause")).toMatchObject({ ok: true });
      expect(
        await command(f, "vc.Comment", { sessionId: data.sessionId, body: "Paused" }, "paused-comment"),
      ).toMatchObject({ ok: false, error: { code: "conflict" } });
      expect(await command(f, "vc.ResumeSession", { sessionId: data.sessionId }, "resume")).toMatchObject({ ok: true });
      expect(
        await command(
          f,
          "vc.SetReplyTrigger",
          { sessionId: data.sessionId, mode: "batch", batch: { count: 5 } },
          "trigger",
        ),
      ).toMatchObject({ ok: true });
      const sessions = new Contract().read<import("../../contract/src/index.js").Session[]>(
        "operations/vc.Sessions",
        await f.engine.query(ctx, { name: "vc.Sessions", args: {} }),
        "#/properties/result",
      );
      expect(sessions.find((s) => s.sessionId === data.sessionId)?.replyTrigger).toBe("batch");
      expect(await command(f, "vc.EndSession", { sessionId: data.sessionId }, "end")).toMatchObject({ ok: true });
      expect(await command(f, "vc.ResumeSession", { sessionId: data.sessionId }, "resume-ended")).toMatchObject({
        ok: false,
        error: { code: "conflict" },
      });
    } finally {
      await f.close();
    }
  });
  it("rejects anchors that are unattached or absent at seenVersion and suggestions without a quote", async () => {
    const f = await fixture();
    try {
      const data = await setupSession(f, "First sentence.");
      const anchor = {
        artifactId: data.artifactId,
        elementId: data.elements[0]!.elementId,
        seenVersion: 1,
      };
      expect(
        await command(f, "vc.Comment", {
          sessionId: data.sessionId,
          body: "Not attached",
          anchor: { ...anchor, artifactId: "missing" },
        }),
      ).toMatchObject({ ok: false, error: { code: "invalid" } });
      expect(
        await command(f, "vc.Comment", {
          sessionId: data.sessionId,
          body: "Missing",
          anchor: { ...anchor, elementId: "missing" },
        }),
      ).toMatchObject({ ok: false, error: { code: "invalid" } });
      expect(
        await command(f, "vc.Comment", {
          sessionId: data.sessionId,
          body: "No quote",
          anchor,
          suggestion: { replacement: "replacement" },
        }),
      ).toMatchObject({ ok: false, error: { code: "invalid" } });
    } finally {
      await f.close();
    }
  });
  it("detects same-element agreement conflicts once, resolves them, and supersedes the losing agreement", async () => {
    const f = await fixture();
    try {
      const data = await setupSession(f, "Alpha beta gamma.");
      const anchor = {
        artifactId: data.artifactId,
        elementId: data.elements[0]!.elementId,
        seenVersion: 1,
        locator: { quote: "beta", prefix: "Alpha ", suffix: " gamma." },
      };
      const one = await comment(f, data.sessionId, anchor, "Replace beta.", "BETA", "comment-one");
      const two = await comment(f, data.sessionId, anchor, "Remove beta.", "", "comment-two");
      const a1 = await agree(f, one.commentId, "agree-one"),
        a2 = await agree(f, two.commentId, "agree-two");
      const rawConflicts = await f.engine.query(ctx, {
        name: "vc.Conflicts",
        args: { sessionId: data.sessionId },
      });
      const conflicts = new Contract().read<FeedbackConflict[]>(
        "operations/vc.Conflicts",
        rawConflicts,
        "#/properties/result",
      );
      expect(conflicts).toHaveLength(1);
      const rawThreads = await f.engine.query(ctx, {
        name: "vc.Threads",
        args: { sessionId: data.sessionId },
      });
      const threads = new Contract().read<import("../../contract/src/index.js").Thread[]>(
        "operations/vc.Threads",
        rawThreads,
        "#/properties/result",
      );
      expect(threads.flatMap((t) => t.comments).filter((c) => c.author.kind === "system")).toHaveLength(2);
      const resolution = await command(
        f,
        "vc.ResolveConflict",
        { keep: a1.agreementId, supersede: [a2.agreementId] },
        "resolve",
      );
      expect(resolution.ok).toBe(true);
      expect(
        await command(f, "vc.ResolveConflict", { keep: a1.agreementId, supersede: [a2.agreementId] }, "resolve"),
      ).toEqual(resolution);
      expect(
        await f.engine.query(ctx, {
          name: "vc.Conflicts",
          args: { sessionId: data.sessionId },
        }),
      ).toEqual([]);
      const records = new Contract().read<import("../../contract/src/index.js").Agreement[]>(
        "operations/vc.DecisionRecord",
        await f.engine.query(ctx, {
          name: "vc.DecisionRecord",
          args: { artifactId: data.artifactId },
        }),
        "#/properties/result",
      );
      expect(records.find((a) => a.agreementId === a2.agreementId)?.state).toBe("superseded");
      const threadQuery = await f.engine.query(ctx, {
        name: "vc.Threads",
        args: { sessionId: data.sessionId },
      });
      expect(
        new Contract()
          .read<import("../../contract/src/index.js").Thread[]>(
            "operations/vc.Threads",
            threadQuery,
            "#/properties/result",
          )
          .flatMap((t) => t.comments)
          .filter((c) => c.author.kind === "system"),
      ).toHaveLength(2);
    } finally {
      await f.close();
    }
  });
  it("allows non-overlapping verbatim suggestions on a shared element", async () => {
    const f = await fixture();
    try {
      const data = await setupSession(f, "Alpha beta gamma.");
      const id = data.elements[0]!.elementId;
      const one = await comment(
        f,
        data.sessionId,
        {
          artifactId: data.artifactId,
          elementId: id,
          seenVersion: 1,
          locator: { quote: "Alpha", prefix: "", suffix: " beta" },
        },
        "Change Alpha",
        "A",
        "comment-a",
      );
      const two = await comment(
        f,
        data.sessionId,
        {
          artifactId: data.artifactId,
          elementId: id,
          seenVersion: 1,
          locator: { quote: "gamma", prefix: " beta ", suffix: "." },
        },
        "Change gamma",
        "G",
        "comment-b",
      );
      await agree(f, one.commentId, "agree-a");
      await agree(f, two.commentId, "agree-b");
      expect(
        await f.engine.query(ctx, {
          name: "vc.Conflicts",
          args: { sessionId: data.sessionId },
        }),
      ).toEqual([]);
    } finally {
      await f.close();
    }
  });
  it("flags ancestor and descendant anchors as a conflict", async () => {
    const f = await fixture();
    try {
      const data = await setupSession(f, "- Item", "markdown");
      const list = data.elements.find((e) => e.type === "list")!,
        item = data.elements.find((e) => e.type === "list_item")!;
      const one = await comment(
        f,
        data.sessionId,
        {
          artifactId: data.artifactId,
          elementId: list.elementId,
          seenVersion: 1,
        },
        "Restructure list",
        undefined,
        "comment-list",
      );
      const two = await comment(
        f,
        data.sessionId,
        {
          artifactId: data.artifactId,
          elementId: item.elementId,
          seenVersion: 1,
          locator: { quote: "Item", prefix: "", suffix: "" },
        },
        "Change item",
        "y",
        "comment-item",
      );
      await agree(f, one.commentId, "agree-list");
      await agree(f, two.commentId, "agree-item");
      const conflicts = new Contract().read<FeedbackConflict[]>(
        "operations/vc.Conflicts",
        await f.engine.query(ctx, {
          name: "vc.Conflicts",
          args: { sessionId: data.sessionId },
        }),
        "#/properties/result",
      );
      expect(conflicts).toHaveLength(1);
    } finally {
      await f.close();
    }
  });
  it("rejects invalid state transitions and keeps deleted comment history hidden by default", async () => {
    const f = await fixture();
    try {
      const data = await setupSession(f, "A sentence.");
      const posted = await command(f, "vc.Comment", { sessionId: data.sessionId, body: "Comment" }, "state-comment");
      if (!posted.ok) throw Error(posted.error.message);
      const commentId = new Contract().read<{ commentId: string }>(
        "operations/vc.Comment",
        posted.result,
        "#/properties/result",
      ).commentId;
      const discarded = await command(
        f,
        "vc.Comment",
        { sessionId: data.sessionId, body: "Discarded" },
        "discard-comment",
      );
      if (!discarded.ok) throw Error(discarded.error.message);
      const discardedId = new Contract().read<{ commentId: string }>(
        "operations/vc.Comment",
        discarded.result,
        "#/properties/result",
      ).commentId;
      expect((await command(f, "vc.DeleteComment", { commentId: discardedId }, "discard-delete")).ok).toBe(true);
      const visible = new Contract().read<import("../../contract/src/index.js").Thread[]>(
        "operations/vc.Threads",
        await f.engine.query(ctx, {
          name: "vc.Threads",
          args: { sessionId: data.sessionId },
        }),
        "#/properties/result",
      );
      expect(visible.flatMap((t) => t.comments).some((c) => c.commentId === discardedId)).toBe(false);
      const retained = new Contract().read<import("../../contract/src/index.js").Thread[]>(
        "operations/vc.Threads",
        await f.engine.query(ctx, {
          name: "vc.Threads",
          args: { sessionId: data.sessionId, includeDeleted: true },
        }),
        "#/properties/result",
      );
      expect(retained.flatMap((t) => t.comments).find((c) => c.commentId === discardedId)?.deleted).toBe(true);
      const agreed = await agree(f, commentId, "state-agree");
      expect(await command(f, "vc.Decline", { commentId }, "bad-decline")).toMatchObject({
        ok: false,
        error: { code: "conflict" },
      });
      expect(await command(f, "vc.DeleteComment", { commentId }, "bad-delete")).toMatchObject({
        ok: false,
        error: { code: "conflict" },
      });
      expect(await command(f, "vc.Agree", { commentId, kind: "as_written" }, "state-agree")).toMatchObject({
        ok: true,
      });
      expect(agreed.agreementId).toBeTruthy();
    } finally {
      await f.close();
    }
  });
  it("keeps random comment and reply sequences within the defined state machine", async () => {
    const actions = fc.array(fc.constantFrom("reply", "agree", "decline", "edit", "delete"), {
      minLength: 1,
      maxLength: 10,
    });
    await fc.assert(
      fc.asyncProperty(actions, async (sequence) => {
        await new Promise<void>((resolve) => setImmediate(resolve));
        const f = await fixture();
        try {
          const data = await setupSession(f, "State machine.");
          const root = await command(f, "vc.Comment", { sessionId: data.sessionId, body: "Root" }, "root");
          if (!root.ok) throw Error(root.error.message);
          const commentId = new Contract().read<{ commentId: string }>(
            "operations/vc.Comment",
            root.result,
            "#/properties/result",
          ).commentId;
          let state: "open" | "discussing" | "agreed" | "declined" = "open",
            deleted = false,
            n = 0;
          for (const action of sequence) {
            const id = "step-" + ++n;
            const input =
              action === "reply"
                ? {
                    sessionId: data.sessionId,
                    replyTo: commentId,
                    body: "Reply",
                  }
                : action === "agree"
                  ? { commentId, kind: "as_written" }
                  : action === "decline"
                    ? { commentId }
                    : action === "edit"
                      ? { commentId, body: "Edited" }
                      : { commentId };
            const type =
              action === "reply"
                ? "vc.Comment"
                : action === "agree"
                  ? "vc.Agree"
                  : action === "decline"
                    ? "vc.Decline"
                    : action === "edit"
                      ? "vc.EditComment"
                      : "vc.DeleteComment";
            const result = await command(f, type, input, id);
            const canChange = !deleted && (state === "open" || state === "discussing");
            if (!canChange)
              expect(result).toMatchObject({
                ok: false,
                error: { code: "conflict" },
              });
            else {
              expect(result.ok).toBe(true);
              if (action === "reply") state = "discussing";
              if (action === "agree") state = "agreed";
              if (action === "decline") state = "declined";
              if (action === "delete") deleted = true;
            }
            const threads = new Contract().read<import("../../contract/src/index.js").Thread[]>(
              "operations/vc.Threads",
              await f.engine.query(ctx, {
                name: "vc.Threads",
                args: { sessionId: data.sessionId, includeDeleted: true },
              }),
              "#/properties/result",
            );
            const current = threads.flatMap((t) => t.comments).find((c) => c.commentId === commentId)!;
            expect(current.state).toBe(state);
            expect(current.deleted).toBe(deleted);
          }
        } finally {
          await f.close();
        }
      }),
      { seed: 20261029, numRuns: 25, verbose: true },
    );
  });
});
