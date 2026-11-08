import { expect, it } from "vitest";
import { Contract } from "../../contract/src/index.js";
import type { EventEnvelope, Json, ProviderModel } from "../../contract/src/index.js";
import { ScriptedProvider } from "../src/gateway/fake.js";
import { ctx, fixture } from "./helpers.js";

const model: ProviderModel = {
  provider: "openai-compatible",
  baseUrl: "https://model.example.test/v1",
  model: "live-events",
  capabilities: { tools: true, jsonSchemaOutput: true, streaming: true, maxContextTokens: 4096, reportsUsage: true },
  pricing: { inputMicrosPerMillion: 0, outputMicrosPerMillion: 0 },
};

// Writes made by background jobs (an agent reply turn) must reach subscribers when they commit, not only when the
// next command happens to wake the event stream.
it("delivers events written by a background job without waiting for another command", async () => {
  const provider = new ScriptedProvider();
  let threadId = "";
  provider.setDefaultHandler(() => [
    { type: "tool_call", call: { id: "reply-1", name: "reply", arguments: { threadId, body: "Here is my reply." } } },
    { type: "done", finishReason: "tool_calls" },
    { type: "text_delta", text: "Replied." },
    { type: "done", finishReason: "stop" },
  ]);
  const f = await fixture({ modelProviders: { "openai-compatible": provider } });
  const contract = new Contract();
  const run = async (type: string, raw: unknown) => {
    const payload = contract.read<Json>("json", raw);
    const result = await f.engine.command(ctx, {
      commandId: type + ":" + JSON.stringify(payload).length,
      type,
      payload,
    });
    if (!result.ok) throw new Error(result.error.message);
    return result.result as Record<string, string>;
  };
  const events: EventEnvelope[] = [];
  const iterator = f.engine.subscribe(ctx, { afterSeq: 0 })[Symbol.asyncIterator]();
  let collecting = true;
  const pump = (async () => {
    while (collecting) {
      const next = await iterator.next();
      if (next.done) break;
      events.push(next.value);
    }
  })();
  try {
    await run("sys.SetSettings", { patch: { models: { default: model } } });
    const { sessionId } = await run("vc.StartSession", { title: "Live", replyTrigger: "manual" });
    threadId = (await run("vc.Comment", { sessionId: sessionId!, body: "Is this clear?" })).threadId!;
    await run("vc.AskAgent", { sessionId: sessionId! });
    // No further commands from here on: only the job runner writes.
    const deadline = Date.now() + 5000;
    const turnDone = () =>
      events.some(
        (e) => e.type === "vc.AgentTurnChanged" && JSON.stringify(e.payload).includes('"status":"completed"'),
      );
    while (!turnDone() && Date.now() < deadline) await new Promise((resolve) => setTimeout(resolve, 25));
    expect(turnDone()).toBe(true);
    // The agent's reply is the thread's second CommentPosted.
    expect(
      events.filter((e) => e.type === "vc.CommentPosted" && JSON.stringify(e.payload).includes(threadId)),
    ).toHaveLength(2);
  } finally {
    collecting = false;
    await iterator.return?.();
    await pump;
    await f.close();
  }
});
