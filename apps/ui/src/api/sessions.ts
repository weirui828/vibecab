import type {
  VcAttachArtifactOperation,
  VcSessionsOperation,
  VcStartSessionOperation,
} from "../../../../contract/generated/index.js";
import { errorMessage } from "../copy/errors.js";

export async function listSessions(): Promise<VcSessionsOperation["result"]> {
  const payload: VcSessionsOperation["payload"] = {};
  return window.vibecab.query<VcSessionsOperation["result"]>("vc.Sessions", payload);
}
export async function startSession(title: string): Promise<VcStartSessionOperation["result"]> {
  const payload: VcStartSessionOperation["payload"] = { title, replyTrigger: "manual" },
    result = await window.vibecab.command("vc.StartSession", payload);
  if (!result.ok) throw Error(errorMessage(result.error.code));
  return result.result as VcStartSessionOperation["result"];
}
export async function attachArtifact(sessionId: string, artifactId: string): Promise<void> {
  const payload: VcAttachArtifactOperation["payload"] = { sessionId, artifactId, role: "primary" },
    result = await window.vibecab.command("vc.AttachArtifact", payload);
  if (!result.ok) throw Error(errorMessage(result.error.code));
}
