# App event refresh map

The renderer subscribes once and refreshes the named query when its current view uses that data. Event entities identify the record to refresh.

| Event | Entity | Queries to refresh |
|---|---|---|
| `vc.IdeaCaptured` | idea | `vc.Ideas` |
| `vc.ProjectCreated` | project | `vc.Projects` |
| `vc.SessionStarted`, `vc.SessionStateChanged`, `vc.SessionRenamed` | session | `vc.Sessions`, `vc.Artifacts` |
| `vc.ArtifactAttached` | session | `vc.Sessions`, `vc.Artifacts`, `vc.Threads` |
| `vc.ArtifactCreated`, `vc.ArtifactRenamed`, `vc.VersionCommitted`, `vc.HoldChanged` | artifact | `vc.Artifact`, `vc.Artifacts`, `vc.Outline`, `vc.Elements`, `vc.Versions` |
| `vc.CommentPosted`, `vc.CommentEdited`, `vc.CommentDeleted` | comment | `vc.Threads`, `vc.FeedbackItems`, `vc.AttentionInbox` |
| `vc.FeedbackStateChanged`, `vc.ConflictDetected`, `vc.ConflictResolved` | feedback record | `vc.DecisionRecord`, `vc.Conflicts`, `vc.AttentionInbox`, `vc.FeedbackItems` |
| `vc.DeliveryStateChanged` | session | `vc.DeliveryState`, `vc.Threads` |
| `vc.UpdateChanged` | update | `vc.Updates`, `vc.DecisionRecord`, `vc.Artifact`, `vc.Versions`, `vc.AttentionInbox` |
| `vc.AgentTurnChanged` | agent turn | `vc.AgentTurns`, `vc.Threads`, `vc.DeliveryState`, `vc.AttentionInbox` |
| `vc.LifecycleChanged` (`output_set`, `label`, export, backup, trash actions) | lifecycle record | `vc.OutputSets`, `vc.Labels`, `vc.Exports`, `sys.Backups`, or the corresponding target query |
| `sys.AccessTokenCreated`, `sys.AccessTokenRevoked` | access token | `sys.AccessTokens` |
| `sys.SettingsChanged`, `sys.BudgetChanged` | settings or budget | `sys.Settings`, `sys.Budgets`, `sys.Usage` |

The four app-specific events (`vc.UpdateChanged`, `vc.AgentTurnChanged`, `vc.DeliveryStateChanged`, and `vc.HoldChanged`) are emitted at each persisted state transition. Existing domain events cover the remaining rows.
