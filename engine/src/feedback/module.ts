import { createModule } from "../modules/create-module.js";
import type { EngineModuleHost } from "../kernel/module-registry.js";

/** The commands the feedback module owns; the engine runtime sends each one here unless it special-cases it. */
export const feedbackCommands: readonly string[] = [
  "vc.CaptureIdea",
  "vc.EditIdea",
  "vc.CreateProject",
  "vc.AttachProjectItem",
  "vc.DetachProjectItem",
  "vc.StartSession",
  "vc.RenameSession",
  "vc.AttachArtifact",
  "vc.PauseSession",
  "vc.ResumeSession",
  "vc.EndSession",
  "vc.Comment",
  "vc.EditComment",
  "vc.DeleteComment",
  "vc.Agree",
  "vc.Decline",
  "vc.ResolveConflict",
  "vc.SetReplyTrigger",
  "vc.MarkHandled",
  "vc.MarkRead",
];

export function feedbackModule(host: EngineModuleHost) {
  return createModule(
    "feedback",
    host,
    [...feedbackCommands],
    [
      "vc.Ideas",
      "vc.Projects",
      "vc.Sessions",
      "vc.Threads",
      "vc.FeedbackItems",
      "vc.DecisionRecord",
      "vc.Conflicts",
      "vc.AttentionInbox",
    ],
  );
}
