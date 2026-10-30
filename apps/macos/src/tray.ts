import { Menu, nativeImage, Notification, Tray } from "electron";
import { randomUUID } from "node:crypto";
import { Contract } from "../../../contract/src/index.js";
import type { CommandEnvelope, EventEnvelope, Subscription } from "../../../contract/src/index.js";
import type { httpClient } from "../../../adapters/http/src/index.js";
import { status } from "../../../host/src/index.js";
import { menuStatus, recentSessionItems } from "./tray-state.js";

type Client = ReturnType<typeof httpClient>;
type Session = { sessionId: string; title: string; createdAt: string; updatedAt: string };
type Snapshot = { running: boolean; status: string[]; recentSessions: Array<{ sessionId: string; title: string }> };
type ReplyMode = "realtime" | "batch" | "manual";
type PausedTrigger = { sessionId: string; threadId?: string; mode: ReplyMode };

function record(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function stringField(value: Record<string, unknown>, key: string): string | undefined {
  const field = Reflect.get(value, key);
  return typeof field === "string" ? field : undefined;
}

function arrayField(value: unknown, key: string): unknown[] {
  if (!record(value)) return [];
  const field = Reflect.get(value, key);
  return Array.isArray(field) ? field : [];
}

function records(value: unknown): Array<Record<string, unknown>> {
  return Array.isArray(value) ? value.filter((item): item is Record<string, unknown> => record(item)) : [];
}

function recordArray(value: unknown, key: string): Array<Record<string, unknown>> {
  return records(record(value) ? Reflect.get(value, key) : undefined);
}

function replyMode(value: string | undefined): value is ReplyMode {
  return value === "realtime" || value === "batch" || value === "manual";
}

export function createTrayManager(options: {
  client: Client;
  workspace: string;
  iconPath: string;
  getNotificationsEnabled: () => Promise<boolean>;
  isWindowFocused: () => boolean;
  openWindow: () => Promise<void>;
  newDraft: () => void;
  navigate: (path: string) => void;
  stop: () => void;
}) {
  const contract = new Contract(),
    subscriptions = new Map<string, AbortController>(),
    pausedTriggers = new Map<string, PausedTrigger>();
  let tray: Tray | undefined;
  let snapshot: Snapshot = { running: false, status: ["Engine stopped"], recentSessions: [] };

  async function open(): Promise<void> {
    await options.openWindow();
  }

  function rebuildMenu(): void {
    if (!tray) return;
    tray.setContextMenu(
      Menu.buildFromTemplate([
        ...snapshot.status.map((label) => ({ label, enabled: false })),
        { type: "separator" },
        { label: "Open VibeCab", accelerator: "CmdOrCtrl+O", click: () => void open() },
        {
          label: "New draft",
          click: () =>
            void (async () => {
              await open();
              options.newDraft();
            })(),
        },
        {
          label: "Recent sessions",
          submenu: snapshot.recentSessions.length
            ? snapshot.recentSessions.map((item) => ({
                label: item.title,
                click: () =>
                  void (async () => {
                    await open();
                    options.navigate(`/s/${encodeURIComponent(item.sessionId)}`);
                  })(),
              }))
            : [{ label: "No recent sessions", enabled: false }],
        },
        {
          label: pausedTriggers.size ? "Resume agent replies" : "Pause agent replies",
          click: () => void togglePausedReplies(),
        },
        {
          label: "Settings…",
          click: () =>
            void (async () => {
              await open();
              options.navigate("/settings");
            })(),
        },
        { type: "separator" },
        { label: "Quit VibeCab", click: options.stop },
      ]),
    );
  }

  async function refresh(): Promise<void> {
    const running = (await status(options.workspace)).running;
    if (!running) {
      snapshot = { running, status: menuStatus({ running, needsYou: 0 }), recentSessions: [] };
      rebuildMenu();
      return;
    }
    try {
      const [rawUpdates, attention, sessions] = await Promise.all([
        options.client.query({ name: "vc.Updates", args: {} }),
        options.client.query({ name: "vc.AttentionInbox", args: {} }),
        options.client.query({ name: "vc.Sessions", args: {} }),
      ]);
      const updates = recordArray(rawUpdates, "updates"),
        active = updates.find((item) =>
          ["queued", "planning", "writing", "checking"].includes(String(Reflect.get(item, "status"))),
        ),
        artifactId = active ? stringField(active, "artifactId") : undefined,
        artifact = artifactId ? await options.client.query({ name: "vc.Artifact", args: { artifactId } }) : undefined,
        title = record(artifact) ? stringField(artifact, "title") : undefined,
        items: Session[] = records(sessions).flatMap((item) => {
          const sessionId = stringField(item, "sessionId"),
            sessionTitle = stringField(item, "title"),
            createdAt = stringField(item, "createdAt");
          return sessionId && sessionTitle && createdAt
            ? [{ sessionId, title: sessionTitle, createdAt, updatedAt: createdAt }]
            : [];
        });
      snapshot = {
        running,
        status: menuStatus({
          running,
          ...(title && active ? { updateTitle: title } : {}),
          needsYou: Array.isArray(attention) ? attention.length : 0,
        }),
        recentSessions: recentSessionItems(items),
      };
    } catch {
      snapshot = { running, status: menuStatus({ running, needsYou: 0 }), recentSessions: [] };
    }
    rebuildMenu();
  }

  async function togglePausedReplies(): Promise<void> {
    if (pausedTriggers.size) {
      for (const [key, entry] of pausedTriggers) {
        await options.client.command(
          contract.read<CommandEnvelope>("command-envelope", {
            commandId: randomUUID(),
            type: "vc.SetReplyTrigger",
            payload: {
              sessionId: entry.sessionId,
              ...(entry.threadId ? { threadId: entry.threadId } : {}),
              mode: entry.mode,
            },
          }),
        );
        pausedTriggers.delete(key);
      }
    } else {
      const sessions = await options.client.query({ name: "vc.Sessions", args: {} });
      for (const item of records(sessions)) {
        const sessionId = stringField(item, "sessionId"),
          state = stringField(item, "state"),
          trigger = stringField(item, "replyTrigger");
        if (!sessionId || state !== "active" || !replyMode(trigger)) continue;
        pausedTriggers.set(sessionId, { sessionId, mode: trigger });
        await setTrigger(sessionId, undefined, "manual");
        const threads = await options.client.query({ name: "vc.Threads", args: { sessionId } });
        for (const thread of records(threads)) {
          const threadId = stringField(thread, "threadId"),
            replyTrigger = Reflect.get(thread, "replyTrigger"),
            mode = record(replyTrigger) ? stringField(replyTrigger, "mode") : undefined;
          if (!threadId || !replyMode(mode)) continue;
          pausedTriggers.set(`${sessionId}:${threadId}`, { sessionId, threadId, mode });
          await setTrigger(sessionId, threadId, "manual");
        }
      }
    }
    await refresh();
  }

  async function setTrigger(sessionId: string, threadId: string | undefined, mode: ReplyMode): Promise<void> {
    await options.client.command(
      contract.read<CommandEnvelope>("command-envelope", {
        commandId: randomUUID(),
        type: "vc.SetReplyTrigger",
        payload: { sessionId, ...(threadId ? { threadId } : {}), mode },
      }),
    );
  }

  async function notify(event: EventEnvelope): Promise<void> {
    if (!Notification.isSupported() || !(await options.getNotificationsEnabled())) return;
    let title: string | undefined;
    if (event.type === "vc.ConflictDetected") title = "Conflict detected";
    if (event.type === "vc.UpdateChanged" && record(event.payload)) {
      const state = Reflect.get(event.payload, "status");
      if (state === "committed" || state === "partially_committed") title = "Update committed";
      else if (state === "failed") title = "Update failed";
    }
    if (event.type === "vc.CommentPosted" && record(event.payload)) {
      if (options.isWindowFocused()) return;
      const sessionId = stringField(event.payload, "sessionId");
      const commentId = stringField(event.payload, "commentId");
      const threads = sessionId ? await options.client.query({ name: "vc.Threads", args: { sessionId } }) : undefined;
      if (
        commentId &&
        records(threads).some((thread) =>
          arrayField(thread, "comments").some((comment) => {
            if (!record(comment) || stringField(comment, "commentId") !== commentId) return false;
            const author = record(comment) ? Reflect.get(comment, "author") : undefined;
            return record(author) && stringField(author, "kind") === "agent";
          }),
        )
      )
        title = "Agent replied";
    }
    if (!title) return;
    const notification = new Notification({ title, body: "Open VibeCab to review." });
    notification.on("click", () => void open());
    notification.show();
  }

  return {
    create() {
      tray = new Tray(nativeImage.createFromPath(options.iconPath));
      tray.setToolTip("VibeCab");
      void refresh();
    },
    refresh,
    snapshot: () => snapshot,
    startEvents() {
      const controller = new AbortController();
      subscriptions.set("tray", controller);
      void (async () => {
        for await (const event of options.client.subscribe(
          contract.read<Subscription>("subscription", { afterSeq: 0, filter: {} }),
          undefined,
          controller.signal,
        )) {
          void refresh();
          void notify(event);
        }
      })().catch(() => undefined);
    },
    stop() {
      for (const controller of subscriptions.values()) controller.abort();
      subscriptions.clear();
      tray?.destroy();
      tray = undefined;
    },
  };
}
