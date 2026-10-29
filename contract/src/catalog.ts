import type { OperationMeta } from '../generated/index.js';
export const unsupportedGroups: readonly {
    prefix: string;
    commands: string;
    queries: string;
    effect?: OperationMeta['effect'];
}[] = [
    { prefix: 'sys', commands: 'OpenWorkspace SetSettings', queries: 'Settings', effect: 'admin' },
    { prefix: 'vc', commands: 'CaptureIdea CreateProject StartSession AttachArtifact PauseSession EndSession', queries: 'Ideas Projects Sessions ResumeView AttentionInbox' },
    { prefix: 'vc', commands: 'HoldElement SaveElement ReleaseHold', queries: '' },
    { prefix: 'vc', commands: 'Comment EditComment DeleteComment Agree Decline SetReplyTrigger AskAgent', queries: 'Threads FeedbackItems DecisionRecord Conflicts' },
    { prefix: 'vc', commands: 'StartUpdate ApprovePlan CancelUpdate', queries: 'Updates UpdateDetail' },
    { prefix: 'vc', commands: 'CreateGrant RevokeGrant', queries: 'Grants AgentTurns Manifest', effect: 'admin' },
    { prefix: 'sys', commands: 'ConnectToolServer DisconnectToolServer SetToolPolicy', queries: 'ToolServers ToolCalls', effect: 'admin' },
    { prefix: 'vc', commands: 'RequestReview', queries: '' },
    { prefix: 'tmr', commands: 'CancelRun ResumeRun', queries: 'Runs Run Report Findings' },
    { prefix: 'vc', commands: 'CreateOutputSet Label', queries: 'OutputSets' },
    { prefix: 'vc', commands: 'Trash Restore Export', queries: 'Exports PurgePreview' },
    { prefix: 'sys', commands: 'Purge Backup RestoreBackup', queries: '', effect: 'admin' },
    { prefix: 'sys', commands: 'CreateAccessToken RevokeAccessToken', queries: 'AccessTokens', effect: 'admin' },
    { prefix: 'sys', commands: 'SetProviderKeyRef SetBudget', queries: 'Usage Budgets', effect: 'admin' }
];
