import type {
  VcArtifactsOperation,
  VcCreateArtifactOperation,
  VcImportContentOperation,
} from "../../../../contract/generated/index.js";
import { errorMessage } from "../copy/errors.js";

export async function listArtifacts(): Promise<VcArtifactsOperation["result"]> {
  const payload: VcArtifactsOperation["payload"] = {};
  return window.vibecab.query<VcArtifactsOperation["result"]>("vc.Artifacts", payload);
}
export async function createBlank(title: string): Promise<VcCreateArtifactOperation["result"]> {
  const payload: VcCreateArtifactOperation["payload"] = { title, mediaKind: "doc" },
    result = await window.vibecab.command("vc.CreateArtifact", payload);
  if (!result.ok) throw Error(errorMessage(result.error.code));
  return result.result as VcCreateArtifactOperation["result"];
}
export async function importMarkdown(title: string, content: string): Promise<VcImportContentOperation["result"]> {
  const payload: VcImportContentOperation["payload"] = { title, format: "markdown", content },
    result = await window.vibecab.command("vc.ImportContent", payload);
  if (!result.ok) throw Error(errorMessage(result.error.code));
  return result.result as VcImportContentOperation["result"];
}
