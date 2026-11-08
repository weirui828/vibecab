// Which queries each event makes stale. Mirrors docs/design/app-events.md.
const map: Record<string, string[]> = {
  "vc.IdeaCaptured": ["vc.Ideas"],
  "vc.IdeaEdited": ["vc.Ideas", "vc.Projects"],
  "vc.ProjectCreated": ["vc.Projects"],
  // Projects list their items, and Ideas, Sessions and Drafts list the projects they belong to.
  "vc.ProjectItemAttached": ["vc.Projects", "vc.Ideas", "vc.Sessions", "vc.Artifacts"],
  "vc.ProjectItemDetached": ["vc.Projects", "vc.Ideas", "vc.Sessions", "vc.Artifacts"],
  "vc.ReplyTriggerChanged": ["vc.Sessions"],
  "vc.SessionStarted": ["vc.Sessions", "vc.Artifacts"],
  "vc.SessionStateChanged": ["vc.Sessions", "vc.Artifacts"],
  "vc.SessionRenamed": ["vc.Sessions", "vc.Artifacts"],
  "vc.ArtifactAttached": ["vc.Sessions", "vc.Artifacts", "vc.Threads"],
  "vc.ArtifactCreated": ["vc.Artifact", "vc.Artifacts", "vc.Outline", "vc.Elements", "vc.Versions"],
  "vc.ArtifactRenamed": ["vc.Artifact", "vc.Artifacts", "vc.Outline", "vc.Elements", "vc.Versions"],
  "vc.VersionCommitted": ["vc.Artifact", "vc.Artifacts", "vc.Outline", "vc.Elements", "vc.Versions"],
  "vc.HoldChanged": ["vc.Artifact", "vc.Artifacts", "vc.Outline", "vc.Elements", "vc.Versions"],
  "vc.CommentPosted": ["vc.Threads", "vc.FeedbackItems", "vc.AttentionInbox"],
  "vc.CommentEdited": ["vc.Threads", "vc.FeedbackItems", "vc.AttentionInbox"],
  "vc.CommentDeleted": ["vc.Threads", "vc.FeedbackItems", "vc.AttentionInbox"],
  "vc.CommentsRead": ["vc.Threads", "vc.AttentionInbox"],
  "vc.FeedbackStateChanged": ["vc.DecisionRecord", "vc.Conflicts", "vc.AttentionInbox", "vc.FeedbackItems"],
  "vc.ConflictDetected": ["vc.DecisionRecord", "vc.Conflicts", "vc.AttentionInbox", "vc.FeedbackItems"],
  "vc.ConflictResolved": ["vc.DecisionRecord", "vc.Conflicts", "vc.AttentionInbox", "vc.FeedbackItems"],
  "vc.DeliveryStateChanged": ["vc.DeliveryState", "vc.Threads"],
  "vc.UpdateChanged": ["vc.Updates", "vc.DecisionRecord", "vc.Artifact", "vc.Versions", "vc.AttentionInbox"],
  "vc.AgentTurnChanged": ["vc.AgentTurns", "vc.Threads", "vc.DeliveryState", "vc.AttentionInbox"],
  "vc.LifecycleChanged": [
    "vc.OutputSets",
    "vc.Labels",
    "vc.Exports",
    "sys.Backups",
    "vc.Artifacts",
    "vc.Sessions",
    "vc.Ideas",
    "vc.Projects",
    "vc.AttentionInbox",
  ],
  "sys.AccessTokenCreated": ["sys.AccessTokens"],
  "sys.AccessTokenRevoked": ["sys.AccessTokens"],
  "sys.SettingsChanged": ["sys.Settings", "sys.Budgets", "sys.Usage"],
  "sys.ProviderKeyRefSet": ["sys.Settings"],
  "vc.ToolServerChanged": ["vc.ToolServers", "vc.Grants"],
  "vc.ToolPolicyChanged": ["vc.ToolServers", "vc.Grants"],
  "sys.BudgetChanged": ["sys.Settings", "sys.Budgets", "sys.Usage"],
};

/** Events no screen of the web app shows yet (TMR runs, review requests, external tool calls). */
export const unshownEvents: readonly string[] = [
  "tmr.ProcessProgress",
  "tmr.RunChanged",
  "vc.ExternalToolCalled",
  "vc.ReportArrived",
  "vc.ReviewProgress",
  "vc.ReviewRequested",
];

export function mappedEvents(): readonly string[] {
  return Object.keys(map);
}

export function staleQueries(eventType: string): readonly string[] {
  return map[eventType] ?? [];
}
