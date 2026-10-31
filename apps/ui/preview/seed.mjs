/* global fetch, process, setTimeout */
// Seeds a preview workspace with a realistic session: a Document, an agent reply, an applied Update and open threads.
// Usage: node apps/ui/preview/seed.mjs http://127.0.0.1:5199
const base = process.argv[2] ?? "http://127.0.0.1:5199";
let n = 0;
async function call(kind, name, body) {
  const res = await fetch(`${base}/v1/${kind}/${encodeURIComponent(name)}`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
  const value = await res.json();
  if (!res.ok || (kind === "commands" && value.ok === false)) throw new Error(`${name}: ${JSON.stringify(value)}`);
  return kind === "commands" ? value.result : value;
}
const cmd = (type, payload) => call("commands", type, { commandId: `seed-${Date.now()}-${++n}`, payload });
const query = (name, args = {}) => call("queries", name, { args });
const wait = (ms) => new Promise((r) => setTimeout(r, ms));
async function until(check, ms = 20_000) {
  const end = Date.now() + ms;
  while (Date.now() < end) {
    const value = await check();
    if (value) return value;
    await wait(250);
  }
  throw new Error("Timed out waiting for preview seed");
}

const model = {
  provider: "openai-compatible",
  baseUrl: "https://example.invalid/v1",
  model: "scripted",
  capabilities: { tools: true, jsonSchemaOutput: true, streaming: true, maxContextTokens: 8192, reportsUsage: false },
  pricing: { inputMicrosPerMillion: 0, outputMicrosPerMillion: 0 },
};

const markdown = `# From idea to results

Covibe is how a person and an agent shape one piece of work together. You comment; the agent replies; nothing changes until you agree.

## How a round works

1. Read the draft and leave comments where something feels off.
2. The agent answers in the thread, sometimes with a concrete proposal.
3. When you agree, the next Update rewrites only what you agreed to.

> Untouched means untouched: every Update changes only the parts you agreed on.

| Stage | Who acts | What changes |
| --- | --- | --- |
| Comment | You | Nothing yet |
| Reply | Agent | Nothing yet |
| Update | Agent, for you | Only agreed parts |

Snapshots freeze a set of drafts so you can share or export them later.`;

const imported = await cmd("vc.ImportContent", {
  title: "From idea to results",
  format: "markdown",
  content: markdown,
});
await cmd("vc.ImportContent", {
  title: "Launch notes",
  format: "markdown",
  content: "# Launch notes\n\nA short list of what ships first.",
});
await cmd("vc.ImportContent", {
  title: "Reading list",
  format: "markdown",
  content: "# Reading list\n\nPapers worth a second look.",
});
const { sessionId } = await cmd("vc.StartSession", { title: "Covibe explainer", replyTrigger: "realtime" });
await cmd("vc.AttachArtifact", { sessionId, artifactId: imported.artifactId, role: "primary" });
await cmd("sys.SetSettings", {
  patch: {
    models: { default: model, planner: model, writer: model },
    sessions: { [sessionId]: { realtimeDebounceSeconds: 1, updateIdleMinutes: 60 } },
  },
});
await cmd("sys.SetBudget", { account: { kind: "daily" }, limitMicros: 2_000_000 });

const elements = await query("vc.Elements", { artifactId: imported.artifactId });
const heading = elements.find((e) => e.type === "heading");
const intro = elements.find((e) => e.type === "paragraph");
await cmd("vc.Comment", {
  sessionId,
  anchor: {
    artifactId: imported.artifactId,
    elementId: heading.elementId,
    seenVersion: 1,
    locator: { quote: "From idea to results", prefix: "", suffix: "" },
  },
  body: "The title feels flat. Can it say what covibe actually is?",
});
await until(async () => JSON.stringify(await query("vc.Threads", { sessionId })).includes("Covibe:"));
const threads = await query("vc.Threads", { sessionId });
const reply = threads.flatMap((t) => t.comments).find((c) => c.author.kind === "agent");
await cmd("vc.Agree", { commentId: reply.commentId, kind: "option", optionLabel: "Name the idea" });
await cmd("vc.StartUpdate", { artifactId: imported.artifactId });
await until(async () => (await query("vc.Artifact", { artifactId: imported.artifactId })).headVersion >= 2, 30_000);

await cmd("vc.SetReplyTrigger", { sessionId, mode: "manual" });
await cmd("vc.Comment", {
  sessionId,
  anchor: {
    artifactId: imported.artifactId,
    elementId: intro.elementId,
    seenVersion: 2,
    locator: { quote: "nothing changes until you agree", prefix: "the agent replies; ", suffix: "." },
  },
  body: "Maybe say this earlier — it is the whole point.",
});
await cmd("vc.Comment", { sessionId, body: "Overall: shorter is better. Aim for one screen." });
process.stdout.write(`SEEDED ${sessionId}\n`);
