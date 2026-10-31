import type { Job } from "../../../contract/src/index.js";
import type { Repository } from "../storage/repository.js";
import type { Clock } from "../dependencies.js";
type Mutate = <T>(action: () => T) => Promise<T>;
const idempotent = Object.freeze([
  "test.noop",
  "tmr.submit",
  "digest",
  "export",
  "purge",
  "trash.sweep",
  "agent.trigger",
  "agent.update.trigger",
]);
export class JobRunner {
  private readonly running = new Map<Promise<void>, Job>();
  private stopped = false;
  private finishingAllowed = true;
  constructor(
    private readonly store: Repository,
    private readonly clock: Clock,
    private readonly mutate: Mutate,
    private readonly options: {
      leaseMs: number;
      handlers: Record<string, (job: Job) => Promise<void>>;
      lostLeasePolicies?: Readonly<Record<string, "rerun" | "uncertain">>;
      onUncertain?: (job: Job) => void;
      onInterrupted?: (job: Job) => void;
    },
  ) {}
  private recoverState(job: Job): Job["state"] {
    if (job.kind === "model.call") return "uncertain";
    const policy = this.options.lostLeasePolicies?.[job.kind];
    if (policy === "uncertain") return "uncertain";
    if (policy === "rerun") return "pending";
    return idempotent.includes(job.kind) ? "pending" : "interrupted";
  }
  async recover() {
    await this.mutate(() => {
      for (const job of this.store.jobs()) {
        if (job.state === "leased" || job.state === "interrupted") {
          const state = this.recoverState(job);
          this.store.jobState(job.id, state);
          if (state === "uncertain") this.options.onUncertain?.(job);
          if (state === "interrupted") this.options.onInterrupted?.(job);
        }
      }
    });
  }
  async tick() {
    const leased = await this.mutate(() => {
      if (this.stopped) return [];
      for (const job of this.store.jobs()) {
        if (job.state === "leased" && job.leaseUntil !== null && job.leaseUntil <= this.clock.now()) {
          const state = this.recoverState(job);
          if (state === "uncertain") this.options.onUncertain?.(job);
          if (state === "interrupted") this.options.onInterrupted?.(job);
          this.store.jobState(job.id, state);
        }
      }
      const due = this.store
        .jobs()
        .filter((job) => job.state === "pending" && this.options.handlers[job.kind] && jobDue(job, this.clock.now()));
      let replyLeased = this.store.jobs().some((job) => job.kind === "agent.reply" && job.state === "leased");
      const jobs = due.filter((job) => {
        if (job.kind !== "agent.reply") return true;
        if (replyLeased) return false;
        replyLeased = true;
        return true;
      });
      const until = new Date(Date.parse(this.clock.now()) + this.options.leaseMs).toISOString();
      for (const job of jobs) this.store.lease(job.id, until);
      return jobs.map(
        (job) =>
          ({
            ...job,
            state: "leased",
            attempts: job.attempts + 1,
            leaseUntil: until,
          }) satisfies Job,
      );
    });
    const tasks = leased.map((job) => ({ job, task: this.execute(job) }));
    for (const { job, task } of tasks) {
      this.running.set(task, job);
      void task.then(
        () => this.running.delete(task),
        () => this.running.delete(task),
      );
    }
    await Promise.all(tasks.map(({ task }) => task));
  }
  private async execute(job: Job) {
    let state: Job["state"] = "completed";
    try {
      await this.options.handlers[job.kind]!(job);
    } catch {
      state = "interrupted";
    }
    // An expired or drained attempt has no authority over a later lease.
    if (!this.finishingAllowed) return;
    await this.mutate(() => {
      const current = this.store.jobs().find((candidate) => candidate.id === job.id);
      if (this.finishingAllowed && current?.state === "leased" && current.attempts === job.attempts)
        this.store.jobState(job.id, state);
    });
  }
  async drain(graceMs: number) {
    this.stopped = true;
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
      await Promise.race([
        Promise.all([...this.running.keys()]),
        new Promise<void>((resolve) => {
          timer = setTimeout(resolve, Math.max(0, graceMs));
        }),
      ]);
      await Promise.all([...this.running].filter(([, job]) => job.kind === "trash.sweep").map(([task]) => task));
    } finally {
      if (timer) clearTimeout(timer);
    }
    this.finishingAllowed = false;
    await this.mutate(() => {
      for (const job of this.store.jobs())
        if (job.state === "leased") {
          this.store.jobState(job.id, job.kind === "model.call" ? "uncertain" : "interrupted");
          if (job.kind === "model.call") {
            this.options.onUncertain?.(job);
          } else {
            this.options.onInterrupted?.(job);
          }
        }
    });
  }
}
function jobDue(job: Job, now: string): boolean {
  const payload = job.payload;
  if (typeof payload !== "object" || payload === null || Array.isArray(payload)) return true;
  const notBefore = Reflect.get(payload, "notBefore");
  return typeof notBefore !== "string" || Date.parse(notBefore) <= Date.parse(now);
}
