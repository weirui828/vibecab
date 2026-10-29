import { fail } from "../../../contract/src/index.js";
import type { Json } from "../../../contract/src/index.js";
import { nextCommandId } from "./client.js";
import type { CliClient } from "./types.js";

export async function purge(client: CliClient, target: Json, confirmed: boolean): Promise<Json> {
  const preview = await client.query({ name: "vc.PurgePreview", args: { target } });
  if (!confirmed) return { preview, queued: false };
  const result = await client.command({ commandId: nextCommandId(), type: "vc.Purge", payload: { target } });
  if (!result.ok) fail(result.error.code, result.error.message, result.error.details);
  return { preview, queued: true, result: result.result };
}
