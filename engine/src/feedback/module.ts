import { createModule } from "../modules/create-module.js";
import type { EngineModuleHost } from "../kernel/module-registry.js";

export function feedbackModule(host: EngineModuleHost) {
  return createModule(
    "feedback",
    host,
    [
      "vc.CaptureIdea",
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
    ],
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
