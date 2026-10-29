import type { CommitInput } from "../../contract/src/index.js";
import { Contract } from "../../contract/src/index.js";
import { SqliteStore } from "../src/storage/sqlite.js";
import { Content } from "../src/content/content.js";
import { clock, ids } from "./helpers.js";
export function contentFixture() {
  const contract = new Contract(),
    store = new SqliteStore(":memory:", contract),
    content = new Content(store, contract, clock, ids());
  const artifact = store.transaction(() =>
    content.create("Test", { kind: "human" }),
  );
  return {
    store,
    content,
    artifactId: artifact.artifactId,
    commit: (
      input: Pick<CommitInput, "baseVersion"> & {
        changes: unknown[];
      },
    ) =>
      store.transaction(() =>
        content.commit({
          ...input,
          artifactId: artifact.artifactId,
          createdBy: { kind: "human" },
          source: {},
        }),
      ),
  };
}
