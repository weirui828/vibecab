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
  it("accepts the launch secret once and answers with an HttpOnly, SameSite=Strict cookie", async () => {
    const launch = new URL(t.host.launchUrl()),
      first = await raw(t.host.port, "GET", launch.pathname + launch.search),
      second = await raw(t.host.port, "GET", launch.pathname + launch.search);
    expect(first.status).toBe(303);
    expect(first.headers["set-cookie"]?.[0]).toMatch(/HttpOnly; SameSite=Strict; Path=\//);
    expect(second.status).toBe(303);
    expect(second.headers["set-cookie"]).toBeUndefined();
  });

  it("refuses /v1 and /app without the cookie, and a guessed secret signs nothing in", async () => {
    expect((await raw(t.host.port, "POST", "/v1/queries/vc.Sessions", json({ args: {} }))).status).toBe(401);
    expect((await raw(t.host.port, "GET", "/app/state")).status).toBe(401);
    const guess = await raw(t.host.port, "GET", "/?launch=" + "A".repeat(43));
    expect(guess.headers["set-cookie"]).toBeUndefined();
    const forged = await raw(t.host.port, "GET", "/app/state", { headers: { Cookie: t.cookie + "x" } });
    expect(forged.status).toBe(401);
  });

  it("rejects a foreign Host (DNS rebinding) and a foreign Origin, even with the cookie", async () => {
    const host = await raw(t.host.port, "GET", "/app/state", {
      headers: { Host: "evil.example:" + t.host.port, Cookie: t.cookie },
    });
    expect(host.status).toBe(403);
    const origin = await raw(t.host.port, "POST", "/v1/queries/vc.Sessions", {
      ...json({ args: {} }),
      headers: { "Content-Type": "application/json", Origin: "https://evil.example", Cookie: t.cookie },
    });
    expect(origin.status).toBe(403);
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

describe("sign-in links for another browser", () => {
  it("makes a fresh link for a signed-in tab, and for the workspace owner's terminal, but not for anyone else", async () => {
    const fromTab = await raw(t.host.port, "POST", "/app/launch-link", { headers: { Cookie: t.cookie } });
    expect(fromTab.status).toBe(200);
    expect((JSON.parse(fromTab.body) as { url: string }).url).toMatch(/\/\?launch=[\w-]{43}$/);
    const runtime = JSON.parse(await readFile(join(t.workspace, ".vibecab", "web.json"), "utf8")) as {
      url: string;
      control: string;
    };
    expect(runtime.url).toBe(t.host.url);
    const fromTerminal = await raw(t.host.port, "POST", "/app/launch-link", {
      headers: { "x-vibecab-control": runtime.control },
    });
    expect(fromTerminal.status).toBe(200);
    const link = new URL((JSON.parse(fromTerminal.body) as { url: string }).url);
    const signIn = await raw(t.host.port, "GET", link.pathname + link.search);
    expect(signIn.headers["set-cookie"]?.[0]).toMatch(/HttpOnly/);
    expect((await raw(t.host.port, "POST", "/app/launch-link")).status).toBe(401);
    expect(
      (await raw(t.host.port, "POST", "/app/launch-link", { headers: { "x-vibecab-control": "A".repeat(43) } })).status,
    ).toBe(401);
    // The control secret only opens the link endpoint, nothing else.
    expect(
      (await raw(t.host.port, "GET", "/app/state", { headers: { "x-vibecab-control": runtime.control } })).status,
    ).toBe(401);
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

  it("needs the signed-in cookie like every /app endpoint", async () => {
    expect((await raw(t.host.port, "GET", "/app/provider-models?provider=openrouter")).status).toBe(401);
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
