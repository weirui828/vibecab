import { setTimeout as delay } from "node:timers/promises";
import type { EngineLink } from "./engine.js";

// Development only (`--seed`, needs VIBECAB_DEV=1 and `dev/fake-provider.json`): a realistic workspace for building
// and reviewing screens. Talks to the engine over its HTTP API like any other client.
export async function seedWorkspace(engine: EngineLink): Promise<void> {
  const target = await engine.target();
  if (!target) throw new Error("Engine is not running");
  let n = 0;
  async function call(kind: "commands" | "queries", name: string, body: unknown): Promise<unknown> {
    const res = await fetch(new URL(`/v1/${kind}/${encodeURIComponent(name)}`, target!.url), {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: "Bearer " + target!.token },
      body: JSON.stringify(body),
    });
    const value = (await res.json()) as { ok?: boolean; result?: unknown };
    if (!res.ok || (kind === "commands" && value.ok === false)) throw new Error(`${name}: ${JSON.stringify(value)}`);
    return kind === "commands" ? value.result : value;
  }
  const cmd = <T>(type: string, payload: unknown) =>
    call("commands", type, { commandId: `seed-${Date.now()}-${++n}`, payload }) as Promise<T>;
  const query = <T>(name: string, args: unknown = {}) => call("queries", name, { args }) as Promise<T>;
  async function until(check: () => Promise<boolean>, ms = 30_000) {
    const end = Date.now() + ms;
    while (Date.now() < end) {
      if (await check()) return;
      await delay(250);
    }
    throw new Error("Timed out while seeding");
  }
  if ((await query<unknown[]>("vc.Sessions")).length > 0) return;

  const model = {
    provider: "openai-compatible",
    baseUrl: "https://example.invalid/v1",
    model: "scripted",
    capabilities: { tools: true, jsonSchemaOutput: true, streaming: true, maxContextTokens: 8192, reportsUsage: false },
    pricing: { inputMicrosPerMillion: 0, outputMicrosPerMillion: 0 },
  };
  const draft = (title: string, content: string) =>
    cmd<{ artifactId: string }>("vc.ImportContent", { title, format: "markdown", content });
  const session = (title: string, replyTrigger = "manual") =>
    cmd<{ sessionId: string }>("vc.StartSession", { title, replyTrigger });
  const attach = (sessionId: string, artifactId: string, role = "primary") =>
    cmd("vc.AttachArtifact", { sessionId, artifactId, role });

  const explainer = await draft(
    "From idea to results",
    `# From idea to results

Covibe is how a person and an agent shape one piece of work together. You comment; the agent replies; nothing changes until you agree.

## How a round works

1. Read the draft and leave comments where something feels off.
2. The agent answers in the thread, sometimes with a concrete proposal.
3. When you agree, the next Update rewrites only what you agreed to.

> Untouched means untouched: every Update changes only the parts you agreed on.

Snapshots freeze a set of drafts so you can share or export them later.`,
  );
  const launch = await draft("Launch notes", "# Launch notes\n\nWhat ships first, and what waits for the second week.");
  const faq = await draft("Launch FAQ", "# Launch FAQ\n\nShort answers to the questions people will ask on day one.");
  const reading = await draft("Reading list", "# Reading list\n\nPapers worth a second look.");
  const retro = await draft("Q3 retrospective", "# Q3 retrospective\n\nWhat worked, what did not, what we change.");
  await draft("Interview questions", "# Interview questions\n\nFor the writing-tools study.");

  const covibe = await session("Covibe explainer", "realtime");
  await attach(covibe.sessionId, explainer.artifactId);
  await cmd("sys.SetSettings", {
    patch: {
      models: { default: model, planner: model, writer: model },
      sessions: { [covibe.sessionId]: { realtimeDebounceSeconds: 1, updateIdleMinutes: 60 } },
    },
  });
  await cmd("sys.SetBudget", { account: { kind: "daily" }, limitMicros: 2_000_000 });

  const elements = await query<Array<{ elementId: string; type: string }>>("vc.Elements", {
    artifactId: explainer.artifactId,
  });
  const heading = elements.find((e) => e.type === "heading"),
    intro = elements.find((e) => e.type === "paragraph");
  if (!heading || !intro) throw new Error("Seed Document has no heading or paragraph");
  await cmd("vc.Comment", {
    sessionId: covibe.sessionId,
    anchor: {
      artifactId: explainer.artifactId,
      elementId: heading.elementId,
      seenVersion: 1,
      locator: { quote: "From idea to results", prefix: "", suffix: "" },
    },
    body: "The title feels flat. Can it say what covibe actually is?",
  });
  type Thread = { comments: Array<{ commentId: string; author: { kind: string } }> };
  await until(async () =>
    JSON.stringify(await query("vc.Threads", { sessionId: covibe.sessionId })).includes("Covibe:"),
  );
  const reply = (await query<Thread[]>("vc.Threads", { sessionId: covibe.sessionId }))
    .flatMap((t) => t.comments)
    .find((c) => c.author.kind === "agent");
  if (!reply) throw new Error("No agent reply");
  await cmd("vc.Agree", { commentId: reply.commentId, kind: "option", optionLabel: "Name the idea" });
  await cmd("vc.StartUpdate", { artifactId: explainer.artifactId });
  await until(
    async () =>
      (await query<{ headVersion: number }>("vc.Artifact", { artifactId: explainer.artifactId })).headVersion >= 2,
  );
  await cmd("vc.SetReplyTrigger", { sessionId: covibe.sessionId, mode: "manual" });
  await cmd("vc.Comment", {
    sessionId: covibe.sessionId,
    anchor: {
      artifactId: explainer.artifactId,
      elementId: intro.elementId,
      seenVersion: 2,
      locator: { quote: "nothing changes until you agree", prefix: "the agent replies; ", suffix: "." },
    },
    body: "Maybe say this earlier — it is the whole point.",
  });
  await cmd("vc.Comment", { sessionId: covibe.sessionId, body: "Overall: shorter is better. Aim for one screen." });

  const ship = await session("Launch week");
  await attach(ship.sessionId, launch.artifactId);
  await attach(ship.sessionId, faq.artifactId, "reference");
  await cmd("vc.Comment", { sessionId: ship.sessionId, body: "Lead with the one thing people can do on day one." });

  const papers = await session("Reading notes");
  await attach(papers.sessionId, reading.artifactId);
  await cmd("vc.PauseSession", { sessionId: papers.sessionId });

  const q3 = await session("Q3 retro");
  await attach(q3.sessionId, retro.artifactId);
  await cmd("vc.EndSession", { sessionId: q3.sessionId });
}
