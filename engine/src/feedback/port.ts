import { fail, type FeedbackComment, type Json } from "../../../contract/src/index.js";
import type { ModuleContext } from "../kernel/module-registry.js";

export type ReviewCapture = {
  threadId: string;
  items: Json[];
  sourceMap: Record<
    string,
    { itemId: string; artifactId: string; version: number; elementId: string; elementHash: string }
  >;
};

export interface FeedbackPort {
  captureReview(
    ctx: ModuleContext,
    input: { sessionId: string; threadId?: string; elementRefs: Json[]; commentIds?: string[] },
  ): ReviewCapture;
  postReviewReport(ctx: ModuleContext, input: { sessionId: string; threadId: string; runId: string }): void;
  createFindingItem(
    ctx: ModuleContext,
    input: {
      sessionId: string;
      threadId: string;
      runId: string;
      finding: Json;
      source?: { artifactId: string; version: number; elementId: string; elementHash: string; content: Json };
    },
  ): void;
  resolveHead(
    ctx: ModuleContext,
    artifactId: string,
    elementId: string,
  ): {
    version: number;
    hash?: string;
    content?: Json;
  };
  purgeRunComments(ctx: ModuleContext, runId: string, action: "redact" | "delete"): void;
}

export function feedbackPort(): FeedbackPort {
  return {
    captureReview(ctx, input) {
      const session = read(ctx, "session", ctx.repository.feedback("session", input.sessionId));
      if (field(session, "state") !== "active") fail("conflict", "Reviews require an active session");
      const threadId = input.threadId ?? ctx.ids.next("thread_"),
        items: Json[] = [],
        sourceMap: ReviewCapture["sourceMap"] = {};
      if (
        input.threadId &&
        !ctx.repository.feedbackList("comment").some((value) => {
          const item = read(ctx, "feedback-comment", value);
          return field(item, "sessionId") === input.sessionId && field(item, "threadId") === input.threadId;
        })
      )
        fail("invalid", "Review thread must belong to the requested session");
      for (const ref of input.elementRefs) {
        const artifactId = string(field(ref, "artifactId"));
        if (!ctx.repository.feedback("attachment", `${input.sessionId}:${artifactId}`))
          fail("invalid", "Review artifact is not attached to the session");
        const version = ctx.repository.version(artifactId),
          elements = ctx.repository.elements(artifactId, version.version);
        for (const elementId of strings(field(ref, "elementIds"))) {
          const element = elements.find((candidate) => candidate.elementId === elementId),
            elementHash = version.manifest[elementId];
          if (!element || !elementHash) fail("not_found", "Review element is not at the current artifact head");
          const itemId = ctx.ids.next("snapshot_item_"),
            source = `vc:artifact/${artifactId}@${version.version}#${elementId}`;
          items.push(ctx.contract.read<Json>("json", { itemId, kind: "element", content: element, source }));
          sourceMap[itemId] = { itemId, artifactId, version: version.version, elementId, elementHash };
        }
      }
      for (const commentId of input.commentIds ?? []) {
        const comment = read(ctx, "feedback-comment", ctx.repository.feedback("comment", commentId));
        if (field(comment, "sessionId") !== input.sessionId || field(comment, "deleted") === true)
          fail("invalid", "Review comment is not available in this session");
        const itemId = ctx.ids.next("snapshot_item_");
        items.push(
          ctx.contract.read<Json>("json", {
            itemId,
            kind: "comment",
            content: field(comment, "body"),
            source: `vc:comment/${commentId}`,
          }),
        );
      }
      return { threadId, items, sourceMap };
    },
    postReviewReport(ctx, input) {
      const commentId = `review-report:${input.runId}`;
      if (ctx.repository.feedback("comment", commentId)) return;
      const now = ctx.clock.now();
      saveComment(ctx, commentId, {
        commentId,
        itemKind: "comment",
        sessionId: input.sessionId,
        author: { kind: "system" },
        body: `TMR review report is ready (run ${input.runId}).`,
        threadId: input.threadId,
        state: "open",
        deleted: false,
        read: false,
        createdAt: now,
        updatedAt: now,
      });
    },
    createFindingItem(ctx, input) {
      const findingId = string(field(input.finding, "findingId")),
        commentId = `finding:${input.runId}:${findingId}`;
      if (ctx.repository.feedback("comment", commentId)) return;
      const now = ctx.clock.now(),
        suggestion = optionalString(field(input.finding, "suggestion")),
        reviewed = input.source?.content,
        quote = optionalString(field(reviewed, "text"));
      saveComment(ctx, commentId, {
        commentId,
        itemKind: "finding",
        source: { runId: input.runId, findingId },
        sessionId: input.sessionId,
        author: { kind: "system" },
        ...(input.source
          ? {
              anchor: {
                artifactId: input.source.artifactId,
                elementId: input.source.elementId,
                seenVersion: input.source.version,
                seenHash: input.source.elementHash,
                ...(quote ? { locator: { quote, prefix: "", suffix: "" } } : {}),
              },
            }
          : {}),
        ...(suggestion && quote ? { suggestion: { replacement: suggestion } } : {}),
        body: `${optionalString(field(input.finding, "concern")) ?? "Finding"}: ${optionalString(field(input.finding, "rationale")) ?? ""}`,
        threadId: input.threadId,
        state: "open",
        deleted: false,
        read: false,
        createdAt: now,
        updatedAt: now,
      });
    },
    resolveHead(ctx, artifactId, elementId) {
      const version = ctx.repository.version(artifactId),
        content = ctx.repository
          .elements(artifactId, version.version)
          .find((element) => element.elementId === elementId);
      return {
        version: version.version,
        ...(version.manifest[elementId] ? { hash: version.manifest[elementId] } : {}),
        ...(content ? { content: ctx.contract.read<Json>("json", content) } : {}),
      };
    },
    purgeRunComments(ctx, runId, action) {
      const comments = ctx.repository
        .feedbackList("comment")
        .map((value) => read(ctx, "feedback-comment", value))
        .filter(
          (comment) =>
            field(field(comment, "source"), "runId") === runId ||
            field(comment, "commentId") === `review-report:${runId}`,
        );
      const commentIds = new Set(comments.map((comment) => string(field(comment, "commentId"))));
      if (action === "delete") {
        const agreementIds = new Set(
          ctx.repository
            .feedbackList("agreement")
            .map((value) => ctx.contract.read<Json>("agreement", value))
            .filter((agreement) => commentIds.has(string(field(agreement, "commentId"))))
            .map((agreement) => string(field(agreement, "agreementId"))),
        );
        for (const conflict of ctx.repository.feedbackList("conflict")) {
          const value = ctx.contract.read<Json>("feedback-conflict", conflict),
            itemIds = strings(field(value, "itemIds"));
          if (itemIds.some((id) => agreementIds.has(id))) {
            const conflictId = optionalString(field(value, "conflictId"));
            if (conflictId) ctx.repository.deleteFeedback("conflict", conflictId);
          }
        }
        for (const agreementId of agreementIds) ctx.repository.deleteFeedback("agreement", agreementId);
      }
      for (const comment of comments) {
        const id = string(field(comment, "commentId"));
        if (action === "delete") {
          ctx.repository.deleteFeedback("comment", id);
          continue;
        }
        const redacted: Record<string, Json> = {
          ...record(comment),
          body: "Review material redacted.",
          deleted: false,
          updatedAt: ctx.clock.now(),
        };
        delete redacted.suggestion;
        delete redacted.anchor;
        saveComment(ctx, id, redacted);
      }
    },
  };
}

function saveComment(ctx: ModuleContext, id: string, value: unknown): void {
  const checked = ctx.contract.read<FeedbackComment>("feedback-comment", value);
  ctx.repository.saveFeedback("comment", id, ctx.contract.read<Json>("json", checked));
}
function read(ctx: ModuleContext, schema: string, value: unknown): Json {
  if (value === undefined) fail("not_found", "Feedback record not found");
  return ctx.contract.read<Json>(schema, value);
}
function field(value: unknown, key: string): unknown {
  return value && typeof value === "object" ? Reflect.get(value, key) : undefined;
}
function record(value: unknown): Record<string, Json> {
  return isJsonRecord(value) ? value : {};
}
function isJsonRecord(value: unknown): value is Record<string, Json> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
function string(value: unknown): string {
  if (typeof value !== "string") fail("invalid", "Expected string");
  return value;
}
function optionalString(value: unknown): string | undefined {
  return typeof value === "string" ? value : undefined;
}
function strings(value: unknown): string[] {
  return Array.isArray(value) ? value.filter((item): item is string => typeof item === "string") : [];
}
