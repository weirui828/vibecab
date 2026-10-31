import type {
  CallLog,
  CommandResult,
  Element,
  EventEnvelope,
  Job,
  Json,
  VcArtifactOperation,
  Version,
} from "../../../contract/src/index.js";
export type Artifact = VcArtifactOperation["result"];
export interface SearchHit {
  kind: "comment" | "element";
  id: string;
  artifactId?: string;
  text: string;
}
export interface StoredAccessToken {
  tokenId: string;
  name: string;
  channel: "http" | "cli" | "mcp";
  scope: "read" | "collaborate" | "admin";
  secretHash: string;
  createdAt: string;
  revokedAt?: string;
}
export interface Repository {
  transaction<T>(action: () => T): T;
  artifact(id: string): Artifact;
  createArtifact(artifact: Artifact): void;
  renameArtifact(id: string, title: string, updatedAt: string): Artifact;
  version(id: string, version?: number): Version;
  versions(id: string): Version[];
  elements(id: string, version?: number): Element[];
  elementIdExists(id: string): boolean;
  saveVersion(version: Version, elements: Element[]): void;
  appendEvent(event: Omit<EventEnvelope, "seq">): EventEnvelope;
  eventsAfter(seq: number): EventEnvelope[];
  lastSeq(): number;
  command(id: string): CommandResult | undefined;
  saveCommand(id: string, result: CommandResult): void;
  enqueue(kind: string, id: string, payload: Json, ts: string): void;
  rescheduleJob(id: string, payload: Json, ts: string): void;
  deleteJob(id: string): void;
  jobs(): Job[];
  pruneCompletedJobs(kind: string): number;
  lease(id: string, until: string): void;
  jobState(id: string, state: Job["state"]): void;
  feedback(kind: string, id: string): Json | undefined;
  feedbackList(kind: string): Json[];
  saveFeedback(kind: string, id: string, value: Json): void;
  deleteFeedback(kind: string, id: string): void;
  deleteArtifact(id: string): void;
  pruneElementRevisions(): string[];
  artifactIds(): string[];
  callLogs(): CallLog[];
  saveCallLog(log: CallLog): void;
  search(sessionId: string, query: string): SearchHit[];
  accessTokens(): StoredAccessToken[];
  createAccessToken(token: StoredAccessToken): void;
  revokeAccessToken(tokenId: string, revokedAt: string): void;
  close(): void;
  compact(): void;
}
