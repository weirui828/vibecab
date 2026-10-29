import { createHash } from "node:crypto";
import { mkdir, open, readFile, rename, unlink, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { errorOf, fail } from "../../../contract/src/index.js";
import type { CallContext, EventEnvelope, Json, Settings, Subscription } from "../../../contract/src/index.js";
import { canonical } from "../content/hash.js";
import type { CallAuth, CallMetadata } from "../auth.js";
import { EngineCore } from "../kernel/engine-core.js";
import type { Content } from "../content/content.js";
import type { Feedback } from "../feedback/feedback.js";
import type { BudgetLedger } from "../gateway/ledger.js";
import type { ProviderGateway } from "../gateway/gateway.js";

export abstract class StorageAccessRuntime extends EngineCore {
  protected content: Content | undefined;
  protected feedback: Feedback | undefined;
  protected budgets: BudgetLedger | undefined;
  protected gateway: ProviderGateway | undefined;

  protected saveSettings(value: unknown): Settings {
    const settings = this.contract.read<Settings>("settings", value);
    this.available().saveFeedback("settings", "workspace", this.contract.read<Json>("json", settings));
    return settings;
  }

  subscribe(auth: CallAuth, metadata: CallMetadata, rawSub: Subscription): AsyncIterable<EventEnvelope> {
    const currentStore = () => this.store;
    const listeners = this.listeners;
    let ctx: CallContext, sub: Subscription;
    try {
      ctx = this.context(auth, metadata);
      sub = this.contract.read<Subscription>("subscription", rawSub);
      this.authorize(ctx, "read");
      this.available();
    } catch (error) {
      throwBoundary(error);
    }
    let cursor = sub.afterSeq,
      ended = false,
      wakeup: (() => void) | undefined;
    const iterator: AsyncIterableIterator<EventEnvelope> = {
      [Symbol.asyncIterator]() {
        return this;
      },
      async next() {
        try {
          while (!ended && currentStore()) {
            for (const event of currentStore()!.eventsAfter(cursor)) {
              cursor = event.seq;
              const filter = sub.filter;
              if (filter?.types && !filter.types.includes(event.type)) continue;
              if (
                filter?.artifactIds &&
                (event.entity.kind !== "artifact" || !filter.artifactIds.includes(event.entity.id))
              )
                continue;
              if (filter?.sessionIds) continue;
              return { done: false, value: event };
            }
            await new Promise<void>((resolve) => {
              wakeup = () => {
                listeners.delete(wakeup!);
                resolve();
              };
              listeners.add(wakeup);
            });
          }
          return { done: true, value: undefined };
        } catch (error) {
          throwBoundary(error);
        }
      },
      async return() {
        ended = true;
        wakeup?.();
        return { done: true, value: undefined };
      },
    };
    return iterator;
  }

  async putBlob(auth: CallAuth, metadata: CallMetadata, bytes: Uint8Array, mediaType: string): Promise<string> {
    try {
      this.available();
      if (!this.accepting) fail("unavailable", "Engine is draining");
      if (!(bytes instanceof Uint8Array) || typeof mediaType !== "string" || !mediaType.length)
        fail("invalid", "Invalid blob");
      const snapshot = Uint8Array.from(bytes),
        hash = createHash("sha256").update(snapshot).digest("hex");
      await this.queue.run(async () => {
        const ctx = this.context(auth, metadata);
        this.authorize(ctx, "collaborate");
        const dir = join(this.workspace, "blobs", hash.slice(0, 2), hash.slice(2, 4));
        await mkdir(dir, { recursive: true });
        const path = join(dir, hash),
          temporary = join(dir, hash + "." + this.deps.ids.next("blob_"));
        const file = await open(temporary, "wx", 0o600);
        try {
          await file.writeFile(snapshot);
          await file.sync();
          await file.close();
          await rename(temporary, path);
          await writeFile(join(dir, `${hash}.meta.json`), canonical({ mediaType }), { mode: 0o600 });
        } catch (error) {
          await file.close().catch(() => undefined);
          await unlink(temporary).catch(() => undefined);
          throw error;
        }
      });
      return hash;
    } catch (error) {
      throwBoundary(error);
    }
  }

  async getBlob(auth: CallAuth, metadata: CallMetadata, hash: string): Promise<Uint8Array> {
    try {
      this.available();
      if (!/^[a-f0-9]{64}$/.test(hash)) fail("invalid", "Invalid blob hash");
      return await this.queue.run(() => {
        const ctx = this.context(auth, metadata);
        this.authorize(ctx, "read");
        const bytes = readFile(join(this.workspace, "blobs", hash.slice(0, 2), hash.slice(2, 4), hash));
        return bytes.then((value) => {
          if (createHash("sha256").update(value).digest("hex") !== hash)
            fail("internal", "Blob integrity check failed");
          return new Uint8Array(value);
        });
      });
    } catch (error) {
      if (isCode(error, "ENOENT")) fail("not_found", "Blob not found");
      throwBoundary(error);
    }
  }
}

function throwBoundary(error: unknown): never {
  const contractError = errorOf(error);
  fail(contractError.code, contractError.message, contractError.details);
}

function isCode(error: unknown, code: string): boolean {
  return typeof error === "object" && error !== null && "code" in error && error.code === code;
}
