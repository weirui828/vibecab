import { fail } from "../../../contract/src/index.js";
import type {
  Agreement,
  FeedbackComment,
  FeedbackConflict,
  Json,
  VcAgreeOperation,
  VcResolveConflictOperation,
} from "../../../contract/src/index.js";
import { FeedbackCommandRuntime } from "./command-runtime.js";
import { sessionPreferences } from "../session-preferences.js";
export abstract class FeedbackAgreementRuntime extends FeedbackCommandRuntime {
  protected agree(p: VcAgreeOperation["payload"]): {
    agreementId: string;
    commentId: string;
  } {
    const c = this.comment(p.commentId);
    this.editable(c);
    if (c.itemKind === "finding" && c.anchor) {
      const currentHash = this.store.version(c.anchor.artifactId).manifest[c.anchor.elementId];
      if (currentHash !== c.anchor.seenHash && p.instruction === undefined)
        fail("invalid", "A revised review finding requires an explicit instruction");
    }
    if (p.kind === "agent_proposal" && (c.author.kind !== "agent" || !c.proposal || Array.isArray(c.proposal)))
      fail("conflict", "Only an agent's single proposal can be agreed as an agent proposal");
    if (p.kind === "option" && !p.optionLabel) fail("invalid", "Option agreements require an optionLabel");
    if (p.kind !== "option" && p.optionLabel) fail("invalid", "optionLabel is only valid for option agreements");
    const selectedOption =
      p.kind === "option" && Array.isArray(c.proposal)
        ? c.proposal.find((option) => option.label === p.optionLabel)
        : undefined;
    if (p.kind === "option" && (!selectedOption || c.author.kind !== "agent"))
      fail("conflict", "The selected option is not available on this agent reply");
    const instruction =
      p.instruction ??
      (p.kind === "as_written"
        ? (c.suggestion?.replacement ?? c.body)
        : p.kind === "agent_proposal" && c.proposal && !Array.isArray(c.proposal)
          ? c.proposal.text
          : selectedOption?.text);
    if (instruction === undefined) fail("invalid", "Agreement requires an instruction");
    const agreementId = this.ids.next("agreement_"),
      agreedAt = this.clock.now();
    this.save<Agreement>("agreement", "agreement", agreementId, {
      agreementId,
      commentId: c.commentId,
      ...(c.source ? { source: c.source } : {}),
      instruction,
      explicitInstruction: p.instruction !== undefined,
      kind: p.kind,
      ...(p.optionLabel ? { optionLabel: p.optionLabel } : {}),
      agreedBy: "human",
      agreedAt,
      state: "agreed",
    });
    this.save<FeedbackComment>("comment", "feedback-comment", c.commentId, {
      ...c,
      state: "agreed",
      updatedAt: agreedAt,
    });
    this.event(
      "vc.FeedbackStateChanged",
      { kind: "comment", id: c.commentId },
      { commentId: c.commentId, sessionId: c.sessionId, state: "agreed" },
    );
    this.detectConflicts(agreementId);
    if (c.anchor?.artifactId) {
      const settings = sessionPreferences(this.settings(), c.sessionId),
        delay = settings?.updateIdleMinutes ?? 2;
      this.store.enqueue(
        "agent.update.trigger",
        this.ids.next("update_trigger_"),
        this.contract.read<Json>("json", {
          artifactId: c.anchor.artifactId,
          notBefore: new Date(Date.parse(agreedAt) + delay * 60_000).toISOString(),
        }),
        agreedAt,
      );
    }
    return { agreementId, commentId: c.commentId };
  }
  private detectsOverlap(a: FeedbackComment, b: FeedbackComment): boolean {
    const aa = a.anchor,
      bb = b.anchor;
    if (!aa || !bb) return false;
    if (aa.artifactId !== bb.artifactId) return false;
    const all = this.store.elements(aa.artifactId),
      parents = new Map(all.map((e) => [e.elementId, e.parentId]));
    const ancestor = (parent: string, child: string) => {
      let next = parents.get(child);
      while (next !== undefined && next !== null) {
        if (next === parent) return true;
        next = parents.get(next);
      }
      return false;
    };
    if (aa.elementId !== bb.elementId)
      return ancestor(aa.elementId, bb.elementId) || ancestor(bb.elementId, aa.elementId);
    if (a.suggestion && b.suggestion && aa.locator?.quote && bb.locator?.quote) {
      const element = all.find((e) => e.elementId === aa.elementId);
      if (element && "text" in element) {
        const unique = (quote: string) => {
          const start = element.text.indexOf(quote);
          return start >= 0 && element.text.indexOf(quote, start + 1) < 0 ? start : undefined;
        };
        const startA = unique(aa.locator.quote),
          startB = unique(bb.locator.quote);
        if (
          startA !== undefined &&
          startB !== undefined &&
          (startA + aa.locator.quote.length <= startB || startB + bb.locator.quote.length <= startA)
        )
          return false;
      }
    }
    return true;
  }
  private detectConflicts(agreementId: string) {
    const added = this.agreement(agreementId),
      current = this.comment(added.commentId);
    const existing = this.list<Agreement>("agreement", "agreement").filter(
      (a) => a.state === "agreed" && a.agreementId !== agreementId,
    );
    for (const other of existing) {
      const aComment = this.comment(other.commentId),
        bComment = current;
      if (!this.detectsOverlap(aComment, bComment)) continue;
      const itemIds = [other.agreementId, added.agreementId].sort();
      if (
        this.list<FeedbackConflict>("conflict", "feedback-conflict").some(
          (x) => x.itemIds.length === 2 && x.itemIds.every((id) => itemIds.includes(id)),
        )
      )
        continue;
      const conflictId = this.ids.next("conflict_");
      const conflict = this.save<FeedbackConflict>("conflict", "feedback-conflict", conflictId, {
        conflictId,
        itemIds,
        stage: "deterministic",
        state: "open",
        sessionId: current.sessionId,
        artifactId: current.anchor?.artifactId ?? aComment.anchor?.artifactId,
      });
      this.event("vc.ConflictDetected", { kind: "conflict", id: conflictId }, { conflictId, itemIds });
      for (const c of [aComment, bComment])
        this.postSystemNotice(c, conflict, c.commentId === aComment.commentId ? added : other);
    }
  }
  private postSystemNotice(target: FeedbackComment, conflict: FeedbackConflict, other: Agreement) {
    const duplicate = this.list<FeedbackComment>("comment", "feedback-comment").some(
      (c) => c.author.kind === "system" && c.threadId === target.threadId && c.body.includes(conflict.conflictId),
    );
    if (duplicate) return;
    const agreedComment = this.comment(other.commentId),
      commentId = this.ids.next("comment_"),
      now = this.clock.now();
    this.save<FeedbackComment>("comment", "feedback-comment", commentId, {
      commentId,
      sessionId: target.sessionId,
      author: { kind: "system" },
      body: `Conflict ${conflict.conflictId}: ${agreedComment.author.kind} agreed to item ${other.agreementId}.`,
      threadId: target.threadId,
      state: "open",
      deleted: false,
      read: false,
      createdAt: now,
      updatedAt: now,
    });
    this.event(
      "vc.CommentPosted",
      { kind: "comment", id: commentId },
      { commentId, sessionId: target.sessionId, threadId: target.threadId },
    );
  }
  protected resolve(p: VcResolveConflictOperation["payload"]): {
    conflictId: string;
    state: "resolved";
  } {
    const keep = this.agreement(p.keep);
    if (keep.state !== "agreed") fail("conflict", "The kept agreement must still be active");
    const open = this.list<FeedbackConflict>("conflict", "feedback-conflict").filter((c) => c.state === "open");
    const related = new Set([p.keep]);
    let changed = true;
    while (changed) {
      changed = false;
      for (const c of open)
        if (c.itemIds.some((id) => related.has(id)))
          for (const id of c.itemIds)
            if (!related.has(id)) {
              related.add(id);
              changed = true;
            }
    }
    const conflicts = open.filter((c) => c.itemIds.some((id) => related.has(id)));
    if (!conflicts.length) fail("not_found", "Open conflict not found");
    const expected = new Set(conflicts.flatMap((c) => c.itemIds.filter((id) => id !== p.keep)));
    if (p.supersede.length !== expected.size || p.supersede.some((id) => !expected.has(id)))
      fail("conflict", "ResolveConflict must supersede every other conflicting agreement");
    for (const id of p.supersede) {
      const agreement = this.agreement(id);
      if (agreement.state !== "agreed") fail("conflict", "Only active agreements can be superseded");
      this.save<Agreement>("agreement", "agreement", id, {
        ...agreement,
        state: "superseded",
        supersedes: [...(agreement.supersedes ?? []), keep.agreementId],
      });
      const c = this.comment(agreement.commentId);
      this.save<FeedbackComment>("comment", "feedback-comment", c.commentId, {
        ...c,
        state: "superseded",
        updatedAt: this.clock.now(),
      });
      this.event(
        "vc.FeedbackStateChanged",
        { kind: "comment", id: c.commentId },
        { commentId: c.commentId, sessionId: c.sessionId, state: "superseded" },
      );
    }
    for (const conflict of conflicts) {
      this.save<FeedbackConflict>("conflict", "feedback-conflict", conflict.conflictId, {
        ...conflict,
        state: "resolved",
      });
      this.event(
        "vc.ConflictResolved",
        { kind: "conflict", id: conflict.conflictId },
        {
          conflictId: conflict.conflictId,
          keep: p.keep,
          supersede: p.supersede,
        },
      );
    }
    return { conflictId: conflicts[0]!.conflictId, state: "resolved" };
  }
}
