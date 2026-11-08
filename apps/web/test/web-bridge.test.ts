import { describe, expect, it } from "vitest";
import { BridgeError, sseParser, webBridge } from "../src/bridge/webBridge.js";
import { staleQueries } from "../src/live/refreshMap.js";

const event = (seq: number, type = "vc.CommentPosted") =>
  `id: ${seq}\nevent: ${type}\ndata: ${JSON.stringify({ seq, ts: "2026-11-07T00:00:00Z", type, entity: { kind: "comment", id: "c" + seq }, payload: {} })}\n\n`;

function stream(chunks: string[], keepOpen = false): Response {
  const encoder = new TextEncoder();
  return new Response(
    new ReadableStream<Uint8Array>({
      start(controller) {
        for (const chunk of chunks) controller.enqueue(encoder.encode(chunk));
        if (!keepOpen) controller.close();
      },
    }),
    { headers: { "Content-Type": "text/event-stream" } },
  );
}

describe("sseParser", () => {
  it("joins chunks split anywhere and ignores ids and names", () => {
    const seen: string[] = [],
      feed = sseParser((data) => seen.push(data)),
      text = event(1) + event(2);
    for (let i = 0; i < text.length; i += 7) feed(text.slice(i, i + 7));
    expect(seen.map((d) => (JSON.parse(d) as { seq: number }).seq)).toEqual([1, 2]);
  });
});

describe("webBridge", () => {
  it("reconnects after a drop from the last seq and never delivers an event twice", async () => {
    const urls: string[] = [];
    let call = 0;
    const fakeFetch: typeof fetch = async (input) => {
      urls.push(String(input));
      call++;
      // First stream drops after 2 events; the second replays 2 (as a server may) and adds 3; then stay open.
      if (call === 1) return stream([event(1), event(2)]);
      if (call === 2) return stream([event(2), event(3)], true);
      return stream([], true);
    };
    const bridge = webBridge({ fetch: fakeFetch, retryMs: 1 }),
      seqs: number[] = [];
    const stop = bridge.subscribe(0, {}, (e) => seqs.push(e.seq));
    await new Promise((resolve) => setTimeout(resolve, 50));
    stop();
    expect(seqs).toEqual([1, 2, 3]);
    expect(urls[0]).toContain("after=0");
    expect(urls[1]).toContain("after=2");
  });

  it("returns command errors as results and throws query errors as BridgeError", async () => {
    const fakeFetch: typeof fetch = async (input) =>
      new Response(
        JSON.stringify({
          code: String(input).includes("commands") ? "invalid" : "not_found",
          message: "no",
          retryable: false,
        }),
        {
          status: String(input).includes("commands") ? 400 : 404,
        },
      );
    const bridge = webBridge({ fetch: fakeFetch });
    expect(await bridge.command("vc.StartSession", {})).toEqual({
      ok: false,
      error: { code: "invalid", message: "no", retryable: false },
    });
    await expect(bridge.query("vc.Sessions", {})).rejects.toBeInstanceOf(BridgeError);
  });

  it("reuses the commandId it is given, so a retried action is idempotent", async () => {
    const bodies: string[] = [];
    const fakeFetch: typeof fetch = async (_input, init) => {
      bodies.push(String(init?.body));
      return new Response(JSON.stringify({ ok: true, result: {}, seq: 1 }));
    };
    const bridge = webBridge({ fetch: fakeFetch });
    await bridge.command("vc.StartSession", { title: "a" }, "same-id");
    await bridge.command("vc.StartSession", { title: "a" }, "same-id");
    expect(bodies.map((b) => (JSON.parse(b) as { commandId: string }).commandId)).toEqual(["same-id", "same-id"]);
  });

  it("maps a 401 from the web host to unauthenticated", async () => {
    const bridge = webBridge({ fetch: async () => new Response("", { status: 401, statusText: "Unauthorized" }) });
    await expect(bridge.app.state()).rejects.toMatchObject({ error: { code: "unauthenticated" } });
  });
});

describe("refresh map", () => {
  it("follows docs/design/app-events.md for the Home queries", () => {
    expect(staleQueries("vc.SessionStarted")).toEqual(expect.arrayContaining(["vc.Sessions", "vc.Artifacts"]));
    expect(staleQueries("vc.CommentPosted")).toContain("vc.AttentionInbox");
    expect(staleQueries("vc.VersionCommitted")).toContain("vc.Artifacts");
    expect(staleQueries("unknown.Event")).toEqual([]);
  });
});
