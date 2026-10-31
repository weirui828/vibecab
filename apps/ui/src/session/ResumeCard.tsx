import type { VcResumeViewOperation } from "../../../../contract/generated/index.js";
import type { SessionDigest } from "../../../../contract/generated/index.js";

type Resume = VcResumeViewOperation["result"];
export function ResumeCard({
  resume,
  digest,
  onGotIt,
}: {
  resume: Resume;
  digest?: SessionDigest;
  onGotIt: () => void;
}) {
  const entries: { id: string; label: string; detail?: string }[] = [],
    seen = new Set<string>();
  const add = (id: string, label: string, detail?: string) => {
    if (!seen.has(id)) {
      seen.add(id);
      entries.push({ id, label, ...(detail ? { detail } : {}) });
    }
  };
  resume.versions.forEach((item, index) =>
    add(
      String(Reflect.get(item, "version") ?? `version-${index}`),
      `New version ${String(Reflect.get(item, "version") ?? "")}`,
    ),
  );
  resume.comments.forEach((item, index) => {
    const body = Reflect.get(item, "body");
    add(
      String(Reflect.get(item, "commentId") ?? `comment-${index}`),
      "New comment",
      typeof body === "string" ? body : undefined,
    );
  });
  resume.replies.forEach((item, index) => {
    const body = Reflect.get(item, "body");
    add(
      String(Reflect.get(item, "commentId") ?? `reply-${index}`),
      "New reply",
      typeof body === "string" ? body : undefined,
    );
  });
  resume.awaitingAgreement.forEach((item, index) =>
    add(String(Reflect.get(item, "itemId") ?? `agreement-${index}`), "Waiting for agreement"),
  );
  resume.conflicts.forEach((item, index) =>
    add(String(Reflect.get(item, "conflictId") ?? `conflict-${index}`), "Open conflict"),
  );
  resume.updates.forEach((item, index) =>
    add(
      String(Reflect.get(item, "updateId") ?? `update-${index}`),
      `Update ${String(Reflect.get(item, "status") ?? "changed")}`,
    ),
  );
  resume.changesSinceOutputSet.forEach((item, index) =>
    add(String(Reflect.get(item, "id") ?? `change-${index}`), "Changed since Snapshot"),
  );
  if (resume.lastOutputSet) add("last-output-set", "Latest Snapshot");
  if (!entries.length) return null;
  return (
    <section className="resume-card" aria-label="Since you were here">
      <div className="card-head">
        <h3>Since you were here</h3>
        <button onClick={onGotIt}>Got it</button>
      </div>
      <ul>
        {entries.map((entry) => (
          <li key={entry.id} data-resume-item>
            {entry.label}
            {entry.detail ? ` · ${entry.detail}` : ""}
          </li>
        ))}
      </ul>
      {digest ? (
        <div className="session-digest">
          <h4>Session digest</h4>
          <p>{digest.whereItStands}</p>
          <small>Machine-written · {digest.purpose}</small>
        </div>
      ) : null}
    </section>
  );
}
