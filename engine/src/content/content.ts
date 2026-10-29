import { generateKeyBetween } from "fractional-indexing";
import { Contract, fail } from "../../../contract/src/index.js";
import type {
  CommitInput,
  Element,
  Principal,
  Version,
  VersionSource,
} from "../../../contract/src/index.js";
import type { Repository } from "../storage/repository.js";
import type { Clock, IdGenerator } from "../kernel/dependencies.js";
import { canonical, revisionHash } from "./hash.js";
import { importContent } from "./import.js";
export class Content {
  constructor(
    private readonly store: Repository,
    private readonly contract: Contract,
    private readonly clock: Clock,
    private readonly ids: IdGenerator,
  ) {}
  validateTree(elements: Element[]): void {
    this.contract.read("doc-tree", elements);
  }
  create(title: string, principal: Principal) {
    const artifactId = this.ids.next("art_"),
      createdAt = this.clock.now();
    this.store.createArtifact({
      artifactId,
      title,
      mediaKind: "doc",
      headVersion: 1,
      createdAt,
    });
    this.store.saveVersion(
      {
        artifactId,
        version: 1,
        parentVersion: null,
        manifest: {},
        createdBy: principal,
        source: {},
        createdAt,
      },
      [],
    );
    this.store.appendEvent({
      ts: createdAt,
      type: "vc.ArtifactCreated",
      entity: { kind: "artifact", id: artifactId },
      payload: { artifactId, title, mediaKind: "doc" },
    });
    this.versionEvent(artifactId, 1, [], {});
    return { artifactId, version: 1 };
  }
  import(
    input: {
      artifactId?: string;
      title?: string;
      format: "markdown" | "text";
      content: string;
    },
    principal: Principal,
  ) {
    const nodes = importContent(input.content, input.format),
      source = { importId: this.ids.next("imp_") };
    if (!input.artifactId) {
      // Initial import is version 1, rather than an observable empty version followed by version 2.
      const artifactId = this.ids.next("art_"),
        ts = this.clock.now();
      this.store.createArtifact({
        artifactId,
        title: input.title ?? "Untitled",
        mediaKind: "doc",
        headVersion: 1,
        createdAt: ts,
      });
      this.store.appendEvent({
        ts,
        type: "vc.ArtifactCreated",
        entity: { kind: "artifact", id: artifactId },
        payload: {
          artifactId,
          title: input.title ?? "Untitled",
          mediaKind: "doc",
        },
      });
      const result = this.commitInitial(artifactId, nodes, principal, source);
      return { artifactId, ...result };
    }
    const artifactId = input.artifactId,
      head = this.store.artifact(artifactId).headVersion;
    return {
      artifactId,
      ...this.commit({
        artifactId,
        baseVersion: head,
        changes: nodes,
        createdBy: principal,
        source,
      }),
    };
  }
  private commitInitial(
    artifactId: string,
    changes: CommitInput["changes"],
    createdBy: Principal,
    source: VersionSource,
  ) {
    return this.apply(
      { artifactId, baseVersion: 1, changes, createdBy, source },
      undefined,
    );
  }
  commit(raw: unknown) {
    const input = this.contract.read<CommitInput>("commit-input", raw);
    return this.apply(input, this.store.version(input.artifactId));
  }
  restore(artifactId: string, version: number, principal: Principal) {
    const head = this.store.version(artifactId),
      target = this.store.version(artifactId, version);
    const input: CommitInput = {
      artifactId,
      baseVersion: head.version,
      changes: [],
      createdBy: principal,
      source: { restoreOf: version },
    };
    return { artifactId, ...this.apply(input, head, target) };
  }
  private apply(
    input: CommitInput,
    head: Version | undefined,
    restore?: Version,
  ) {
    const { artifactId, createdBy, source } = input;
    const base = head
      ? this.store.version(artifactId, input.baseVersion)
      : undefined;
    const original = head ? this.store.elements(artifactId, head.version) : [];
    const map = new Map(original.map((e) => [e.elementId, e]));
    const writeSet = new Set<string>(),
      idMap: Record<string, string> = {};
    const removed = new Set<string>();
    const descendants = (id: string) => {
      const found = new Set([id]);
      let changed = true;
      const elements = [
        ...original,
        ...(base ? this.store.elements(artifactId, base.version) : []),
      ];
      while (changed) {
        changed = false;
        for (const e of elements)
          if (e.parentId && found.has(e.parentId) && !found.has(e.elementId)) {
            found.add(e.elementId);
            changed = true;
          }
      }
      return found;
    };
    for (const change of input.changes) {
      if (change.op === "add") {
        if (Object.hasOwn(idMap, change.tempId))
          fail("conflict", "Duplicate temporary ID");
        const id = this.ids.next("el_");
        if (this.store.elementIdExists(id) || Object.values(idMap).includes(id))
          fail("conflict", "Element ID already used");
        idMap[change.tempId] = id;
        writeSet.add(id);
      } else {
        writeSet.add(change.elementId);
        if (change.op === "remove")
          for (const id of descendants(change.elementId)) {
            removed.add(id);
            writeSet.add(id);
          }
      }
    }
    if (restore) {
      const target = this.store.elements(artifactId, restore.version);
      map.clear();
      for (const e of target) map.set(e.elementId, e);
      for (const id of new Set([
        ...Object.keys(head?.manifest ?? {}),
        ...Object.keys(restore.manifest),
      ]))
        if (head?.manifest[id] !== restore.manifest[id]) writeSet.add(id);
    }
    const conflicting = [...writeSet].filter(
      (id) =>
        !Object.values(idMap).includes(id) &&
        head?.manifest[id] !== base?.manifest[id],
    );
    if (conflicting.length)
      fail("stale_base", "Elements changed since base version", {
        conflictingElementIds: conflicting.sort(),
      });
    const resolveId = (id: string) => idMap[id] ?? id;
    for (const change of input.changes) {
      if (change.op === "add") {
        const element = this.contract.read<Element>("element", {
          ...change.element,
          elementId: idMap[change.tempId],
          parentId:
            change.parentId === null ? null : resolveId(change.parentId),
          order: "a0",
        });
        map.set(element.elementId, element);
      }
    }
    const positioned = new Set<string>();
    for (const change of input.changes) {
      if (change.op !== "add" && !map.has(change.elementId))
        fail("conflict", "Element does not exist at head");
      if (change.op === "remove") {
        for (const id of descendants(change.elementId)) map.delete(id);
        continue;
      }
      if (change.op === "update") {
        const current = map.get(change.elementId);
        if (!current) fail("conflict", "Element was removed");
        if (current.type !== change.element.type)
          fail("conflict", "An update cannot change element type");
        if (
          "blobHash" in current &&
          "blobHash" in change.element &&
          current.blobHash !== change.element.blobHash
        )
          fail("conflict", "An update can only change text and props");
        map.set(
          change.elementId,
          this.contract.read<Element>("element", {
            ...change.element,
            elementId: current.elementId,
            parentId: current.parentId,
            order: current.order,
          }),
        );
        continue;
      }
      const id = change.op === "add" ? idMap[change.tempId]! : change.elementId;
      const current = map.get(id);
      if (!current) fail("conflict", "Element was removed");
      const parentId =
          change.parentId === null ? null : resolveId(change.parentId),
        parent = parentId === null ? undefined : map.get(parentId);
      if (
        (parentId !== null && (!parent || removed.has(parentId))) ||
        !this.contract.allows(parent, current)
      )
        fail("conflict", "Invalid target parent");
      const siblings = [...map.values()]
        .filter(
          (e) =>
            e.parentId === parentId &&
            e.elementId !== id &&
            !removed.has(e.elementId) &&
            (!Object.values(idMap).includes(e.elementId) ||
              positioned.has(e.elementId)),
        )
        .sort((a, b) => (a.order < b.order ? -1 : 1));
      let at = siblings.length - 1;
      if (change.after === null) at = -1;
      else if (change.after !== undefined) {
        at = siblings.findIndex(
          (e) => e.elementId === resolveId(change.after!),
        );
        if (at < 0) fail("conflict", "after must name a sibling");
      }
      const order = generateKeyBetween(
        siblings[at]?.order ?? null,
        siblings[at + 1]?.order ?? null,
      );
      map.set(id, { ...current, parentId, order });
      positioned.add(id);
    }
    const elements = [...map.values()];
    try {
      this.validateTree(elements);
    } catch {
      fail("conflict", "Commit would produce an invalid document tree");
    }
    const manifest: Record<string, string> = {};
    for (const e of elements) manifest[e.elementId] = revisionHash(e);
    if (head)
      for (const id of new Set([
        ...Object.keys(head.manifest),
        ...Object.keys(manifest),
      ]))
        if (!writeSet.has(id) && head.manifest[id] !== manifest[id])
          throw Error("Untouched element changed");
    if (restore && canonical(manifest) !== canonical(restore.manifest))
      throw Error("Restore changed historical manifest");
    const version = (head?.version ?? 0) + 1;
    this.store.saveVersion(
      {
        artifactId,
        version,
        parentVersion: head?.version ?? null,
        manifest,
        createdBy,
        source,
        createdAt: this.clock.now(),
      },
      elements,
    );
    this.versionEvent(artifactId, version, [...writeSet], source);
    return { version, idMap, writeSet: [...writeSet] };
  }
  private versionEvent(
    artifactId: string,
    version: number,
    writeSet: string[],
    source: VersionSource,
  ) {
    this.store.appendEvent({
      ts: this.clock.now(),
      type: "vc.VersionCommitted",
      entity: { kind: "artifact", id: artifactId },
      payload: {
        artifactId,
        version,
        writeSet,
        source: this.contract.read("version-source", source),
      },
    });
  }
}
