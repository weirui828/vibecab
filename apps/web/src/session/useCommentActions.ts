import { useCallback } from "react";
import { errorMessage } from "../../../ui/src/copy/errors.js";
import { useBridge } from "../live/LiveStore.js";
import { useToast } from "../ui/Toast.js";
import { newCommandId } from "../bridge/webBridge.js";

export interface NewAnchor {
  artifactId: string;
  elementId: string;
  seenVersion: number;
  locator?: { quote: string; prefix: string; suffix: string };
}

/** Comment commands. Each returns whether it succeeded; failures become a short toast. */
export function useCommentActions(sessionId: string) {
  const bridge = useBridge(),
    toast = useToast();
  const run = useCallback(
    async (type: string, payload: unknown) => {
      const result = await bridge.command(type, payload, newCommandId());
      if (!result.ok) toast(errorMessage(result.error.code));
      return result.ok;
    },
    [bridge, toast],
  );
  return {
    comment: (body: string, anchor?: NewAnchor, replacement?: string) =>
      run("vc.Comment", {
        sessionId,
        body,
        ...(anchor ? { anchor } : {}),
        ...(replacement !== undefined ? { suggestion: { replacement } } : {}),
      }),
    reply: (replyTo: string, body: string) => run("vc.Comment", { sessionId, body, replyTo }),
    edit: (commentId: string, body: string, replacement?: string) =>
      run("vc.EditComment", {
        commentId,
        body,
        ...(replacement !== undefined ? { suggestion: { replacement } } : {}),
      }),
    remove: (commentId: string) => run("vc.DeleteComment", { commentId }),
    agree: (
      commentId: string,
      choice: { kind: "as_written" | "agent_proposal" } | { kind: "option"; optionLabel: string },
    ) => run("vc.Agree", { commentId, ...choice }),
    decline: (commentId: string, reason?: string) => run("vc.Decline", { commentId, ...(reason ? { reason } : {}) }),
    setReplyMode: (mode: "realtime" | "batch" | "manual") => run("vc.SetReplyTrigger", { sessionId, mode }),
    ask: (threadIds?: string[]) => run("vc.AskAgent", { sessionId, ...(threadIds ? { threadIds } : {}) }),
  };
}
