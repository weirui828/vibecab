import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { parseArgs } from "../server/main.js";
import { fetched, raw, startTestHost } from "./helpers.js";
import type { TestHost } from "./helpers.js";

let t: TestHost, token: string;
beforeAll(async () => {
  t = await startTestHost();
  token = (await readFile(join(t.workspace, ".vibecab", "app-token"), "utf8")).trim();
}, 60_000);
afterAll(async () => t?.close());

const json = (body: unknown) => ({
  headers: { "Content-Type": "application/json" },
  body: JSON.stringify(body),
});

describe("browser access", () => {
  it("serves the frame an HTML Draft is shown in with a policy of its own, not the app's", async () => {
    const res = await raw(t.host.port, "GET", "/draft-frame");
    expect(res.status).toBe(200);
    const policy = String(res.headers["content-security-policy"]);
    expect(policy).toContain("default-src 'none'");
    expect(policy).toContain("sandbox allow-scripts");
    expect(policy).not.toContain("connect-src");
    expect(res.body).toContain("vcFrame");
  });

  it("needs no sign-in: VibeCab's own pages reach /v1 and /app with no cookie", async () => {
    expect((await raw(t.host.port, "GET", "/app/state")).status).toBe(200);
    const query = await raw(t.host.port, "POST", "/v1/queries/vc.Sessions", {
      ...json({ args: {} }),
      headers: { "Content-Type": "application/json", Origin: "http://127.0.0.1:" + t.host.port },
    });
    expect(query.status).toBe(200);
    // An old sign-in link still opens VibeCab, and sets nothing.
    const old = await raw(t.host.port, "GET", "/?launch=" + "A".repeat(43));
    expect(old.status).toBe(303);
    expect(old.headers.location).toBe("/");
    expect(old.headers["set-cookie"]).toBeUndefined();
  });

  it("keeps other websites out: a foreign Host (DNS rebinding) and a foreign Origin (CSRF)", async () => {
    const host = await raw(t.host.port, "GET", "/app/state", { headers: { Host: "evil.example:" + t.host.port } });
    expect(host.status).toBe(403);
    const csrf = await raw(t.host.port, "POST", "/v1/commands/vc.StartSession", {
      headers: { "Content-Type": "application/json", Origin: "https://evil.example" },
      body: JSON.stringify({ commandId: "csrf", payload: { title: "Not mine" } }),
    });
    expect(csrf.status).toBe(403);
    // Another local app is another origin too.
    const otherPort = await raw(t.host.port, "POST", "/v1/queries/vc.Sessions", {
      ...json({ args: {} }),
      headers: { "Content-Type": "application/json", Origin: "http://localhost:3000" },
    });
    expect(otherPort.status).toBe(403);
  });

  it("has a second wall behind the Origin check: Sec-Fetch-Site and JSON-only commands", async () => {
    const post = (headers: Record<string, string>, body = JSON.stringify({ args: {} })) =>
      raw(t.host.port, "POST", "/v1/queries/vc.Sessions", { headers, body });
    // The browser says where a request comes from, and a page cannot change that: other sites are refused, and so
    // is another port on this computer ("same-site"), even if a broken browser sent no Origin.
    for (const site of ["cross-site", "same-site"])
      expect((await post({ "Content-Type": "application/json", "Sec-Fetch-Site": site })).status).toBe(403);
    expect((await raw(t.host.port, "GET", "/app/state", { headers: { "Sec-Fetch-Site": "cross-site" } })).status).toBe(
      403,
    );
    // VibeCab's own pages, an address typed by the person, and programs (no such header) pass.
    for (const site of ["same-origin", "none"])
      expect((await post({ "Content-Type": "application/json", "Sec-Fetch-Site": site })).status).toBe(200);
    expect((await post({ "Content-Type": "application/json" })).status).toBe(200);
    // A form on another site can post text/plain without asking the browser first; JSON it cannot.
    expect((await post({ "Content-Type": "text/plain" })).status).toBe(415);
    expect((await post({})).status).toBe(415);
    const command = await raw(t.host.port, "POST", "/v1/commands/vc.StartSession", {
      headers: { "Content-Type": "text/plain" },
      body: JSON.stringify({ commandId: "plain", payload: { title: "No" } }),
    });
    expect(command.status).toBe(415);
  });

  it("sends a page opened on localhost to 127.0.0.1, so a browser keeps one set of preferences", async () => {
    const page = await raw(t.host.port, "GET", "/s/abc?x=1", { headers: { Host: "localhost:" + t.host.port } });
    expect(page.status).toBe(307);
    expect(page.headers.location).toBe(`http://127.0.0.1:${t.host.port}/s/abc?x=1`);
    // Calls from a page are not moved: only page loads are.
    const call = await raw(t.host.port, "GET", "/app/state", { headers: { Host: "localhost:" + t.host.port } });
    expect(call.status).toBe(200);
  });

  it("refuses development flags without VIBECAB_DEV=1", () => {
    const before = process.env.VIBECAB_DEV;
    process.env.VIBECAB_DEV = "0";
    try {
      expect(() => parseArgs(["--fake-provider", "x.json"])).toThrow(/VIBECAB_DEV=1/);
      expect(() => parseArgs(["--seed"])).toThrow(/VIBECAB_DEV=1/);
      expect(() => parseArgs(["--temp-workspace"])).toThrow(/VIBECAB_DEV=1/);
      expect(parseArgs(["--port", "5000", "--no-open"])).toMatchObject({ port: 5000, open: false });
      expect(parseArgs([])).toMatchObject({ port: 5163, open: true });
    } finally {
      process.env.VIBECAB_DEV = before;
    }
  });
});

describe("finding the running host", () => {
  it("writes its address for `vibecab-web link`, and no secret", async () => {
    const runtime = JSON.parse(await readFile(join(t.workspace, ".vibecab", "web.json"), "utf8")) as Record<
      string,
      unknown
    >;
    expect(runtime.url).toBe(t.host.url);
    expect(Object.keys(runtime).sort()).toEqual(["pid", "url"]);
  });
});

describe("forwarding to the engine", () => {
  it("passes commands and queries through and reports the connection", async () => {
    const state = (await (await t.fetch("/app/state")).json()) as { connection: string };
    expect(state.connection).toBe("Connected");
    const created = (await (
      await t.fetch("/v1/commands/vc.StartSession", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ commandId: "web-host-1", payload: { title: "Forwarded" } }),
      })
    ).json()) as { ok: boolean; result: { sessionId: string } };
    expect(created.ok).toBe(true);
    const sessions = (await (
      await t.fetch("/v1/queries/vc.Sessions", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ args: {} }),
      })
    ).json()) as Array<{ sessionId: string; title: string }>;
    expect(sessions.map((s) => s.title)).toContain("Forwarded");
  });

  it("keeps contract errors and their status", async () => {
    const res = await t.fetch("/v1/commands/vc.StartSession", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ commandId: "web-host-bad", payload: { title: "" } }),
    });
    expect(res.status).toBe(400);
    expect(((await res.json()) as { code: string }).code).toBe("invalid");
  });

  it("streams events over SSE", async () => {
    const controller = new AbortController(),
      res = await t.fetch("/v1/events?after=0", {
        signal: controller.signal,
        headers: { Accept: "text/event-stream" },
      });
    expect(res.headers.get("content-type")).toMatch(/text\/event-stream/);
    const reader = res.body!.getReader(),
      decoder = new TextDecoder();
    let text = "";
    while (!text.includes("vc.SessionStarted")) {
      const part = await reader.read();
      if (part.done) break;
      text += decoder.decode(part.value, { stream: true });
    }
    controller.abort();
    expect(text).toMatch(/event: vc\.SessionStarted/);
  });

  it("round-trips a blob", async () => {
    const bytes = new TextEncoder().encode("hello blob"),
      digest = await crypto.subtle.digest("SHA-256", bytes),
      hash = [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, "0")).join("");
    const put = await t.fetch("/v1/blobs/" + hash, {
      method: "PUT",
      headers: { "Content-Type": "text/plain" },
      body: bytes,
    });
    expect(put.status).toBe(200);
    expect(await (await t.fetch("/v1/blobs/" + hash)).text()).toBe("hello blob");
  });

  it("never sends the app token to the browser", async () => {
    const responses = [
      await raw(t.host.port, "GET", "/app/state", { headers: { Cookie: t.cookie } }),
      await raw(t.host.port, "POST", "/v1/queries/vc.Sessions", {
        ...json({ args: {} }),
        headers: { "Content-Type": "application/json", Cookie: t.cookie },
      }),
      await raw(t.host.port, "POST", "/v1/commands/vc.StartSession", {
        headers: { "Content-Type": "application/json", Cookie: t.cookie },
        body: JSON.stringify({ commandId: "x", payload: {} }),
      }),
      await raw(t.host.port, "GET", "/"),
    ];
    for (const res of responses) {
      expect(res.body).not.toContain(token);
      expect(JSON.stringify(res.headers)).not.toContain(token);
    }
  });

  it("does not forward the browser's own Authorization header", async () => {
    const res = await raw(t.host.port, "POST", "/v1/queries/vc.Sessions", {
      ...json({ args: {} }),
      headers: { "Content-Type": "application/json", Cookie: t.cookie, Authorization: "Bearer not-the-token" },
    });
    expect(res.status).toBe(200);
  });
});

describe("model lists", () => {
  it("fetches a built-in provider's live list from the catalog's own address, never one the page sends", async () => {
    fetched.length = 0;
    const res = await t.fetch(t.host.url + "/app/provider-models?provider=openrouter");
    expect(await res.json()).toEqual({
      models: [
        {
          id: "acme/swift-1",
          name: "Acme: Swift 1",
          contextTokens: 200000,
          price: { inputMicrosPerMillion: 500_000, outputMicrosPerMillion: 1_500_000 },
        },
      ],
    });
    expect(fetched).toEqual(["https://openrouter.ai/api/v1/models"]);
    // A provider with no live list, or an address smuggled in, fetches nothing.
    for (const provider of ["openai", "https://evil.test/models", ""]) {
      const none = await t.fetch(t.host.url + "/app/provider-models?provider=" + encodeURIComponent(provider));
      expect(await none.json()).toEqual({ models: [], error: "no_list" });
    }
    expect(fetched).toEqual(["https://openrouter.ai/api/v1/models"]);
    // An unreachable server is said plainly.
    const down = await t.fetch(t.host.url + "/app/provider-models?provider=lm-studio");
    expect(await down.json()).toEqual({ models: [], error: "unreachable" });
  });

  it("refuses another website like every /app endpoint (CSRF)", async () => {
    const res = await raw(t.host.port, "GET", "/app/provider-models?provider=openrouter", {
      headers: { Origin: "https://evil.example" },
    });
    expect(res.status).toBe(403);
  });
});

describe("engine facts", () => {
  it("reports when the running engine started and whether its code is older than the build", async () => {
    const state = (await (await t.fetch(t.host.url + "/app/state")).json()) as {
      engine: { startedAt: string; builtAt?: string; outdated: boolean } | null;
    };
    expect(state.engine?.startedAt).toMatch(/^\d{4}-\d{2}-\d{2}T/);
    expect(typeof state.engine?.outdated).toBe("boolean");
  });
});
