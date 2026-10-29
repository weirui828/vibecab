import type { Job } from '../../../contract/src/index.js';
import type { Repository } from '../storage/repository.js';
import type { Clock } from './dependencies.js';
type Mutate = <T>(action: () => T) => Promise<T>;
const idempotent = Object.freeze(['test.noop', 'tmr.submit', 'digest', 'export', 'purge']);
export class JobRunner {
    private readonly running = new Set<Promise<void>>();
    private stopped = false;
    private finishingAllowed = true;
    constructor(private readonly store: Repository, private readonly clock: Clock, private readonly mutate: Mutate, private readonly options: {
        leaseMs: number;
        handlers: Record<string, (job: Job) => Promise<void>>;
    }) {}
    private recoverState(job: Job): Job['state'] {
        if (job.kind === 'model.call') return 'uncertain';
        return idempotent.includes(job.kind) ? 'pending' : 'interrupted';
    }
    async recover() {
        await this.mutate(() => {
            for (const job of this.store.jobs()) {
                if (job.state === 'leased' || job.state === 'interrupted') this.store.jobState(job.id, this.recoverState(job));
            }
        });
    }
    async tick() {
        const leased = await this.mutate(() => {
            if (this.stopped) return [];
            for (const job of this.store.jobs()) {
                if (job.state === 'leased' && job.leaseUntil !== null && job.leaseUntil <= this.clock.now()) this.store.jobState(job.id, this.recoverState(job));
            }
            const jobs = this.store.jobs().filter(job => job.state === 'pending' && this.options.handlers[job.kind]);
            const until = new Date(Date.parse(this.clock.now()) + this.options.leaseMs).toISOString();
            for (const job of jobs) this.store.lease(job.id, until);
            return jobs.map(job => ({ ...job, state: 'leased', attempts: job.attempts + 1, leaseUntil: until } satisfies Job));
        });
        const tasks = leased.map(job => this.execute(job));
        for (const task of tasks) {
            this.running.add(task);
            void task.then(() => this.running.delete(task), () => this.running.delete(task));
        }
        await Promise.all(tasks);
    }
    private async execute(job: Job) {
        let state: Job['state'] = 'completed';
        try { await this.options.handlers[job.kind]!(job); }
        catch { state = 'interrupted'; }
        // An expired or drained attempt has no authority over a later lease.
        if (!this.finishingAllowed) return;
        await this.mutate(() => {
            const current = this.store.jobs().find(candidate => candidate.id === job.id);
            if (this.finishingAllowed && current?.state === 'leased' && current.attempts === job.attempts) this.store.jobState(job.id, state);
        });
    }
    async drain(graceMs: number) {
        this.stopped = true;
        let timer: ReturnType<typeof setTimeout> | undefined;
        try {
            await Promise.race([Promise.all([...this.running]), new Promise<void>(resolve => { timer = setTimeout(resolve, Math.max(0, graceMs)); })]);
        } finally { if (timer) clearTimeout(timer); }
        this.finishingAllowed = false;
        await this.mutate(() => {
            for (const job of this.store.jobs()) if (job.state === 'leased') this.store.jobState(job.id, 'interrupted');
        });
    }
}
