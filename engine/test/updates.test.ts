import { expect, it } from "vitest";
import { Contract } from "../../contract/src/index.js";
import { ctx, fixture } from "./helpers.js";
import { ScriptedProvider } from "../src/gateway/fake.js";
import type { ProviderModel } from "../src/gateway/types.js";

async function waitForUpdate(
  engine: import("../src/engine.js").Engine,
  updateId: string,
) {
  for (let i = 0; i < 100; i++) {
    const value = await engine.query(ctx, {
      name: "vc.UpdateDetail",
      args: { updateId },
    });
    const update = new Contract().read<
      import("../../contract/src/index.js").Update
    >("operations/vc.UpdateDetail", value, "#/properties/result");
    if (["committed", "partially_committed", "failed"].includes(update.status))
      return update;
    await new Promise<void>((resolve) => setTimeout(resolve, 10));
  }
  throw Error("Update did not complete");
}

it("applies a unique verbatim agreed suggestion without calling a model and commits only its element", async () => {
  const f = await fixture();
  try {
    const imported = await f.engine.command(ctx, {
      commandId: "import-update",
      type: "vc.ImportContent",
      payload: {
        content: "The quick brown fox.",
        format: "text",
        title: "Draft",
      },
    });
    if (!imported.ok) throw Error(imported.error.message);
    const { artifactId } = new Contract().read<{ artifactId: string }>(
      "operations/vc.ImportContent",
      imported.result,
      "#/properties/result",
    );
    const project = await f.engine.command(ctx, {
      commandId: "project-update",
      type: "vc.CreateProject",
      payload: { title: "Update" },
    });
    if (!project.ok) throw Error(project.error.message);
    const { projectId } = new Contract().read<{ projectId: string }>(
      "operations/vc.CreateProject",
      project.result,
      "#/properties/result",
    );
    const session = await f.engine.command(ctx, {
      commandId: "session-update",
      type: "vc.StartSession",
      payload: { title: "Review", primaryProjectId: projectId },
    });
    if (!session.ok) throw Error(session.error.message);
    const { sessionId } = new Contract().read<{ sessionId: string }>(
      "operations/vc.StartSession",
      session.result,
      "#/properties/result",
    );
    await f.engine.command(ctx, {
      commandId: "attach-update",
      type: "vc.AttachArtifact",
      payload: { sessionId, artifactId, role: "primary" },
    });
    const elements = new Contract().read<
      import("../../contract/src/index.js").Element[]
    >(
      "operations/vc.Elements",
      await f.engine.query(ctx, { name: "vc.Elements", args: { artifactId } }),
      "#/properties/result",
    );
    const comment = await f.engine.command(ctx, {
      commandId: "suggestion",
      type: "vc.Comment",
      payload: {
        sessionId,
        body: "Use a stronger verb.",
        anchor: {
          artifactId,
          elementId: elements[0]!.elementId,
          seenVersion: 1,
          locator: { quote: "quick", prefix: "The ", suffix: " brown" },
        },
        suggestion: { replacement: "swift" },
      },
    });
    if (!comment.ok) throw Error(comment.error.message);
    const { commentId } = new Contract().read<{ commentId: string }>(
      "operations/vc.Comment",
      comment.result,
      "#/properties/result",
    );
    const agreement = await f.engine.command(ctx, {
      commandId: "agree-suggestion",
      type: "vc.Agree",
      payload: { commentId, kind: "as_written" },
    });
    expect(agreement.ok).toBe(true);
    const update = await f.engine.command(ctx, {
      commandId: "start-update",
      type: "vc.StartUpdate",
      payload: { artifactId },
    });
    expect(update).toMatchObject({ ok: true, result: { status: "queued" } });
    if (!update.ok) throw Error(update.error.message);
    const { updateId } = new Contract().read<{ updateId: string }>(
      "operations/vc.StartUpdate",
      update.result,
      "#/properties/result",
    );
    expect(await waitForUpdate(f.engine, updateId)).toMatchObject({
      status: "committed",
      resultVersion: 2,
    });
    expect(
      new Contract().read<import("../../contract/src/index.js").Element[]>(
        "operations/vc.Elements",
        await f.engine.query(ctx, {
          name: "vc.Elements",
          args: { artifactId },
        }),
        "#/properties/result",
      )[0],
    ).toMatchObject({ text: expect.stringContaining("swift") });
    const restored = await f.engine.command(ctx, {
      commandId: "restore-update",
      type: "vc.RestoreVersion",
      payload: { artifactId, version: 1 },
    });
    expect(restored).toMatchObject({ ok: true, result: { version: 3 } });
    const decisions = new Contract().read<
      import("../../contract/src/index.js").Agreement[]
    >(
      "operations/vc.DecisionRecord",
      await f.engine.query(ctx, {
        name: "vc.DecisionRecord",
        args: { artifactId },
      }),
      "#/properties/result",
    );
    expect(decisions[0]).toMatchObject({
      state: "applied",
      appliedVersion: 2,
      revertedInVersion: 3,
    });
  } finally {
    await f.close();
  }
});

it("requires an enabled direct-edit session and a live hold before committing an element", async () => {
  const f = await fixture();
  try {
    const imported = await f.engine.command(ctx, {
      commandId: "direct-import",
      type: "vc.ImportContent",
      payload: { content: "Original text.", format: "text", title: "Draft" },
    });
    if (!imported.ok) throw Error(imported.error.message);
    const { artifactId } = new Contract().read<{ artifactId: string }>(
      "operations/vc.ImportContent",
      imported.result,
      "#/properties/result",
    );
    const project = await f.engine.command(ctx, {
      commandId: "direct-project",
      type: "vc.CreateProject",
      payload: { title: "Project" },
    });
    if (!project.ok) throw Error(project.error.message);
    const { projectId } = new Contract().read<{ projectId: string }>(
      "operations/vc.CreateProject",
      project.result,
      "#/properties/result",
    );
    const session = await f.engine.command(ctx, {
      commandId: "direct-session",
      type: "vc.StartSession",
      payload: { title: "Editing", primaryProjectId: projectId },
    });
    if (!session.ok) throw Error(session.error.message);
    const { sessionId } = new Contract().read<{ sessionId: string }>(
      "operations/vc.StartSession",
      session.result,
      "#/properties/result",
    );
    await f.engine.command(ctx, {
      commandId: "direct-attach",
      type: "vc.AttachArtifact",
      payload: { sessionId, artifactId, role: "primary" },
    });
    const elements = new Contract().read<
      import("../../contract/src/index.js").Element[]
    >(
      "operations/vc.Elements",
      await f.engine.query(ctx, { name: "vc.Elements", args: { artifactId } }),
      "#/properties/result",
    );
    const element = elements[0]!;
    const disabled = await f.engine.command(ctx, {
      commandId: "direct-disabled",
      type: "vc.HoldElement",
      payload: { artifactId, elementId: element.elementId },
    });
    expect(disabled).toMatchObject({ ok: false, error: { code: "forbidden" } });
    await f.engine.command(ctx, {
      commandId: "direct-settings",
      type: "sys.SetSettings",
      payload: {
        patch: { sessions: { [sessionId]: { directEditing: true } } },
      },
    });
    expect(
      (
        await f.engine.command(ctx, {
          commandId: "direct-hold",
          type: "vc.HoldElement",
          payload: { artifactId, elementId: element.elementId },
        })
      ).ok,
    ).toBe(true);
    const save = await f.engine.command(ctx, {
      commandId: "direct-save",
      type: "vc.SaveElement",
      payload: {
        artifactId,
        elementId: element.elementId,
        baseVersion: 1,
        element: { type: "paragraph", props: {}, text: "Edited text." },
      },
    });
    expect(save).toMatchObject({ ok: true, result: { version: 2 } });
    expect(
      (
        await f.engine.command(ctx, {
          commandId: "direct-release",
          type: "vc.ReleaseHold",
          payload: { artifactId, elementId: element.elementId },
        })
      ).ok,
    ).toBe(true);
  } finally {
    await f.close();
  }
});

it("plans and writes an agreed instruction through budgeted structured model calls", async () => {
  const provider = new ScriptedProvider(),
    model = {
      provider: "openai-compatible",
      baseUrl: "https://model.example.test/v1",
      model: "fake",
      capabilities: {
        tools: true,
        jsonSchemaOutput: true,
        streaming: true,
        maxContextTokens: 8192,
        reportsUsage: true,
      },
      pricing: { inputMicrosPerMillion: 0, outputMicrosPerMillion: 0 },
    } satisfies ProviderModel;
  const f = await fixture({
    modelProviders: { "openai-compatible": provider },
  });
  try {
    await f.engine.command(ctx, {
      commandId: "plan-settings",
      type: "sys.SetSettings",
      payload: {
        patch: {
          models: { default: model },
          budgets: { defaultTurnLimitMicros: 100_000 },
        },
      },
    });
    const imported = await f.engine.command(ctx, {
      commandId: "plan-import",
      type: "vc.ImportContent",
      payload: { content: "Original text.", format: "text", title: "Draft" },
    });
    if (!imported.ok) throw Error(imported.error.message);
    const { artifactId } = new Contract().read<{ artifactId: string }>(
      "operations/vc.ImportContent",
      imported.result,
      "#/properties/result",
    );
    const element = new Contract().read<
      import("../../contract/src/index.js").Element[]
    >(
      "operations/vc.Elements",
      await f.engine.query(ctx, { name: "vc.Elements", args: { artifactId } }),
      "#/properties/result",
    )[0]!;
    const project = await f.engine.command(ctx, {
      commandId: "plan-project",
      type: "vc.CreateProject",
      payload: { title: "Project" },
    });
    if (!project.ok) throw Error(project.error.message);
    const { projectId } = new Contract().read<{ projectId: string }>(
      "operations/vc.CreateProject",
      project.result,
      "#/properties/result",
    );
    const session = await f.engine.command(ctx, {
      commandId: "plan-session",
      type: "vc.StartSession",
      payload: { title: "Review", primaryProjectId: projectId },
    });
    if (!session.ok) throw Error(session.error.message);
    const { sessionId } = new Contract().read<{ sessionId: string }>(
      "operations/vc.StartSession",
      session.result,
      "#/properties/result",
    );
    await f.engine.command(ctx, {
      commandId: "plan-attach",
      type: "vc.AttachArtifact",
      payload: { sessionId, artifactId, role: "primary" },
    });
    await f.engine.command(ctx, {
      commandId: "plan-review-settings",
      type: "sys.SetSettings",
      payload: { patch: { sessions: { [sessionId]: { planReview: true } } } },
    });
    const comment = await f.engine.command(ctx, {
      commandId: "plan-comment",
      type: "vc.Comment",
      payload: {
        sessionId,
        body: "Make the prose clearer.",
        anchor: { artifactId, elementId: element.elementId, seenVersion: 1 },
      },
    });
    if (!comment.ok) throw Error(comment.error.message);
    const { commentId } = new Contract().read<{ commentId: string }>(
      "operations/vc.Comment",
      comment.result,
      "#/properties/result",
    );
    const agreement = await f.engine.command(ctx, {
      commandId: "plan-agree",
      type: "vc.Agree",
      payload: { commentId, kind: "as_written" },
    });
    if (!agreement.ok) throw Error(agreement.error.message);
    const { agreementId } = new Contract().read<{ agreementId: string }>(
      "operations/vc.Agree",
      agreement.result,
      "#/properties/result",
    );
    provider.enqueueDefaultSequence([
      [
        {
          type: "output",
          json: {
            items: [
              {
                itemId: agreementId,
                action: "edit",
                elementIds: [element.elementId],
                note: "Rewrite this block",
              },
            ],
          },
        },
        {
          type: "usage",
          inputTokens: 100,
          outputTokens: 50,
          quality: "reported",
        },
        { type: "done", finishReason: "stop" },
      ],
      [
        {
          type: "output",
          json: {
            changes: [
              {
                op: "update",
                elementId: "outside-write-set",
                element: { type: "paragraph", props: {}, text: "Unsafe." },
              },
            ],
            itemResults: [
              {
                itemId: agreementId,
                status: "addressed",
                elementIds: ["outside-write-set"],
              },
            ],
          },
        },
        {
          type: "usage",
          inputTokens: 120,
          outputTokens: 60,
          quality: "reported",
        },
        { type: "done", finishReason: "stop" },
      ],
      [
        {
          type: "output",
          json: {
            changes: [
              {
                op: "update",
                elementId: element.elementId,
                element: {
                  type: "paragraph",
                  props: {},
                  text: "Clearer text.",
                },
              },
            ],
            itemResults: [
              {
                itemId: agreementId,
                status: "addressed",
                elementIds: [element.elementId],
              },
            ],
          },
        },
        {
          type: "usage",
          inputTokens: 120,
          outputTokens: 60,
          quality: "reported",
        },
        { type: "done", finishReason: "stop" },
      ],
    ]);
    const update = await f.engine.command(ctx, {
      commandId: "plan-start",
      type: "vc.StartUpdate",
      payload: { artifactId },
    });
    if (!update.ok) throw Error(update.error.message);
    const { updateId } = new Contract().read<{ updateId: string }>(
      "operations/vc.StartUpdate",
      update.result,
      "#/properties/result",
    );
    let detail: import("../../contract/src/index.js").Update | undefined;
    for (let i = 0; i < 100; i++) {
      const value = await f.engine.query(ctx, {
        name: "vc.UpdateDetail",
        args: { updateId },
      });
      detail = new Contract().read<
        import("../../contract/src/index.js").Update
      >("operations/vc.UpdateDetail", value, "#/properties/result");
      if (detail.status === "awaiting_plan_review") break;
      await new Promise<void>((resolve) => setTimeout(resolve, 10));
    }
    expect(detail?.status).toBe("awaiting_plan_review");
    expect(provider.calls).toHaveLength(1);
    expect(
      (
        await f.engine.command(ctx, {
          commandId: "approve-plan",
          type: "vc.ApprovePlan",
          payload: { updateId },
        })
      ).ok,
    ).toBe(true);
    const completed = await waitForUpdate(f.engine, updateId);
    expect(completed.status).toBe("committed");
    expect(provider.calls).toHaveLength(3);
  } finally {
    await f.close();
  }
});

it("keeps conflicting agreed items out of an Update when the judge marks them conflicting", async () => {
  const provider = new ScriptedProvider(),
    model = {
      provider: "openai-compatible",
      baseUrl: "https://model.example.test/v1",
      model: "fake",
      capabilities: {
        tools: true,
        jsonSchemaOutput: true,
        streaming: true,
        maxContextTokens: 8192,
        reportsUsage: true,
      },
      pricing: { inputMicrosPerMillion: 0, outputMicrosPerMillion: 0 },
    } satisfies ProviderModel,
    f = await fixture({ modelProviders: { "openai-compatible": provider } });
  try {
    await f.engine.command(ctx, {
      commandId: "judge-settings",
      type: "sys.SetSettings",
      payload: {
        patch: {
          models: { judge: model },
          budgets: { defaultTurnLimitMicros: 100_000 },
        },
      },
    });
    const imported = await f.engine.command(ctx, {
      commandId: "judge-import",
      type: "vc.ImportContent",
      payload: {
        content: "The original sentence.",
        format: "text",
        title: "Draft",
      },
    });
    if (!imported.ok) throw Error(imported.error.message);
    const { artifactId } = new Contract().read<{ artifactId: string }>(
        "operations/vc.ImportContent",
        imported.result,
        "#/properties/result",
      ),
      element = new Contract().read<
        import("../../contract/src/index.js").Element[]
      >(
        "operations/vc.Elements",
        await f.engine.query(ctx, {
          name: "vc.Elements",
          args: { artifactId },
        }),
        "#/properties/result",
      )[0]!;
    const project = await f.engine.command(ctx, {
      commandId: "judge-project",
      type: "vc.CreateProject",
      payload: { title: "Project" },
    });
    if (!project.ok) throw Error(project.error.message);
    const { projectId } = new Contract().read<{ projectId: string }>(
        "operations/vc.CreateProject",
        project.result,
        "#/properties/result",
      ),
      session = await f.engine.command(ctx, {
        commandId: "judge-session",
        type: "vc.StartSession",
        payload: { title: "Review", primaryProjectId: projectId },
      });
    if (!session.ok) throw Error(session.error.message);
    const { sessionId } = new Contract().read<{ sessionId: string }>(
      "operations/vc.StartSession",
      session.result,
      "#/properties/result",
    );
    await f.engine.command(ctx, {
      commandId: "judge-attach",
      type: "vc.AttachArtifact",
      payload: { sessionId, artifactId, role: "primary" },
    });
    for (let n = 0; n < 2; n++) {
      const c = await f.engine.command(ctx, {
        commandId: "judge-comment-" + n,
        type: "vc.Comment",
        payload: {
          sessionId,
          body: "Replace this phrase, proposal " + n,
          anchor: {
            artifactId,
            elementId: element.elementId,
            seenVersion: 1,
            locator: {
              quote: "original sentence",
              prefix: "The ",
              suffix: ".",
            },
          },
          suggestion: { replacement: "changed " + n },
        },
      });
      if (!c.ok) throw Error(c.error.message);
      const { commentId } = new Contract().read<{ commentId: string }>(
        "operations/vc.Comment",
        c.result,
        "#/properties/result",
      );
      await f.engine.command(ctx, {
        commandId: "judge-agree-" + n,
        type: "vc.Agree",
        payload: { commentId, kind: "as_written" },
      });
    }
    provider.enqueueDefaultSequence([
      [
        {
          type: "output",
          json: {
            verdict: "conflicting",
            reason: "The replacements request incompatible wording.",
          },
        },
        {
          type: "usage",
          inputTokens: 80,
          outputTokens: 20,
          quality: "reported",
        },
        { type: "done", finishReason: "stop" },
      ],
    ]);
    const start = await f.engine.command(ctx, {
      commandId: "judge-start",
      type: "vc.StartUpdate",
      payload: { artifactId },
    });
    if (!start.ok) throw Error(start.error.message);
    const { updateId } = new Contract().read<{ updateId: string }>(
      "operations/vc.StartUpdate",
      start.result,
      "#/properties/result",
    );
    expect((await waitForUpdate(f.engine, updateId)).status).toBe("failed");
    expect(
      await f.engine.query(ctx, { name: "vc.Conflicts", args: { artifactId } }),
    ).toMatchObject([{ state: "open" }]);
    expect(provider.calls).toHaveLength(1);
  } finally {
    await f.close();
  }
});

it("starts an Update after the session agreement quiet period", async () => {
  let now = Date.parse("2026-10-28T00:00:00.000Z");
  const f = await fixture({
    clock: { now: () => new Date(now).toISOString() },
  });
  try {
    const imported = await f.engine.command(ctx, {
      commandId: "auto-import",
      type: "vc.ImportContent",
      payload: { content: "Old wording.", format: "text", title: "Draft" },
    });
    if (!imported.ok) throw Error(imported.error.message);
    const { artifactId } = new Contract().read<{ artifactId: string }>(
        "operations/vc.ImportContent",
        imported.result,
        "#/properties/result",
      ),
      element = new Contract().read<
        import("../../contract/src/index.js").Element[]
      >(
        "operations/vc.Elements",
        await f.engine.query(ctx, {
          name: "vc.Elements",
          args: { artifactId },
        }),
        "#/properties/result",
      )[0]!;
    const project = await f.engine.command(ctx, {
      commandId: "auto-project",
      type: "vc.CreateProject",
      payload: { title: "Project" },
    });
    if (!project.ok) throw Error(project.error.message);
    const { projectId } = new Contract().read<{ projectId: string }>(
        "operations/vc.CreateProject",
        project.result,
        "#/properties/result",
      ),
      session = await f.engine.command(ctx, {
        commandId: "auto-session",
        type: "vc.StartSession",
        payload: { title: "Review", primaryProjectId: projectId },
      });
    if (!session.ok) throw Error(session.error.message);
    const { sessionId } = new Contract().read<{ sessionId: string }>(
      "operations/vc.StartSession",
      session.result,
      "#/properties/result",
    );
    await f.engine.command(ctx, {
      commandId: "auto-attach",
      type: "vc.AttachArtifact",
      payload: { sessionId, artifactId, role: "primary" },
    });
    const comment = await f.engine.command(ctx, {
      commandId: "auto-comment",
      type: "vc.Comment",
      payload: {
        sessionId,
        body: "Use this wording.",
        anchor: {
          artifactId,
          elementId: element.elementId,
          seenVersion: 1,
          locator: { quote: "Old wording", prefix: "", suffix: "." },
        },
        suggestion: { replacement: "New wording" },
      },
    });
    if (!comment.ok) throw Error(comment.error.message);
    const { commentId } = new Contract().read<{ commentId: string }>(
      "operations/vc.Comment",
      comment.result,
      "#/properties/result",
    );
    await f.engine.command(ctx, {
      commandId: "auto-agree",
      type: "vc.Agree",
      payload: { commentId, kind: "as_written" },
    });
    now += 120_000;
    let updates: import("../../contract/src/index.js").Update[] = [];
    for (let i = 0; i < 100; i++) {
      const value = await f.engine.query(ctx, {
        name: "vc.Updates",
        args: { artifactId },
      });
      updates = new Contract().read<
        import("../../contract/src/index.js").Update[]
      >("operations/vc.Updates", value, "#/properties/result");
      if (updates.some((u) => u.status === "committed")) break;
      await new Promise<void>((resolve) => setTimeout(resolve, 10));
    }
    expect(updates).toMatchObject([{ status: "committed", resultVersion: 2 }]);
  } finally {
    await f.close();
  }
});
