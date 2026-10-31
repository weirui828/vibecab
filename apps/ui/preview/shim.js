/* global window, document, location, URLSearchParams, EventSource, crypto, fetch, setTimeout */
// Browser stand-in for the Electron preload: implements window.vibecab over same-origin HTTP.
// Used only by the design preview server (apps/ui/preview/server.mjs); never shipped.
(() => {
  let counter = 0;
  const id = () => "preview-" + Date.now().toString(36) + "-" + ++counter;
  async function post(path, body) {
    const res = await fetch(path, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    });
    const value = await res.json();
    return { ok: res.ok, value };
  }
  const listeners = { theme: new Set(), navigate: new Set() };
  const params = new URLSearchParams(location.search);
  const dark = params.get("theme") === "dark";
  document.documentElement.classList.toggle("dark", dark);
  window.vibecab = {
    async command(type, payload, commandId) {
      const { ok, value } = await post("/v1/commands/" + encodeURIComponent(type), {
        commandId: commandId ?? id(),
        payload,
      });
      return ok ? value : { ok: false, error: value };
    },
    async query(name, args) {
      const { ok, value } = await post("/v1/queries/" + encodeURIComponent(name), { args });
      if (!ok) throw Object.assign(new Error(value.message ?? "Query failed"), value);
      return value;
    },
    subscribe(afterSeq, filter, onEvent) {
      const qs =
        "?after=" +
        afterSeq +
        (filter && Object.keys(filter).length ? "&filter=" + encodeURIComponent(JSON.stringify(filter)) : "");
      const source = new EventSource("/v1/events" + qs);
      source.onmessage = (e) => onEvent(JSON.parse(e.data));
      source.addEventListener("error", () => undefined);
      const types = ["vc.", "sys.", "tmr."];
      // Named SSE events: forward everything.
      const handler = (e) => onEvent(JSON.parse(e.data));
      for (const t of [
        "vc.VersionCommitted",
        "vc.CommentPosted",
        "vc.FeedbackStateChanged",
        "vc.UpdateChanged",
        "vc.AgentTurnChanged",
        "vc.DeliveryStateChanged",
        "vc.ConflictDetected",
        "vc.ConflictResolved",
        "vc.LifecycleChanged",
        "vc.ArtifactRenamed",
        "vc.SessionRenamed",
        "vc.ArtifactCreated",
        "vc.SessionStarted",
        "vc.ArtifactAttached",
        "vc.SessionStateChanged",
        "sys.SettingsChanged",
      ])
        source.addEventListener(t, handler);
      void types;
      return () => source.close();
    },
    async putBlob(bytes, mediaType) {
      const digest = await crypto.subtle.digest("SHA-256", bytes);
      const hash = [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, "0")).join("");
      await fetch("/v1/blobs/" + hash, { method: "PUT", headers: { "Content-Type": mediaType }, body: bytes });
      return hash;
    },
    async getBlob(hash) {
      return new Uint8Array(await (await fetch("/v1/blobs/" + hash)).arrayBuffer());
    },
    blobUrl: (hash) => "/v1/blobs/" + hash,
    app: {
      state: async () => "Connected",
      startEngine: async () => "Connected",
      saveProvider: async () => undefined,
      openMarkdown: async () => undefined,
      openExternal: async () => undefined,
      setTheme: async (theme) => {
        const d = theme === "dark";
        document.documentElement.classList.toggle("dark", d);
        listeners.theme.forEach((l) => l(d));
      },
      getLoginItem: async () => false,
      setLoginItem: async (v) => v,
      trayStatus: async () => ({ running: true, status: [], recentSessions: [] }),
      setNotificationsEnabled: async () => undefined,
      getNotificationsEnabled: async () => false,
      saveFiles: async () => undefined,
      copyText: async () => undefined,
      reveal: async () => undefined,
      workspacePath: async () => "~/Library/Application Support/VibeCab/workspaces/default",
      restoreBackup: async () => undefined,
      mcpRelayPath: async () => "/Applications/VibeCab.app/Contents/Resources/engine/bin/vibecab-mcp",
      openMcpConfig: async () => undefined,
      nodeVersion: async () => "v26.13.0",
      version: async () => "0.1.0",
      onNewDraft: () => () => undefined,
      onImport: () => () => undefined,
      onTheme: (l) => {
        listeners.theme.add(l);
        setTimeout(() => l(dark), 0);
        return () => listeners.theme.delete(l);
      },
      onConnectionLost: () => () => undefined,
      onNavigate: (l) => {
        listeners.navigate.add(l);
        return () => listeners.navigate.delete(l);
      },
    },
  };
})();
