import { monotonicFactory } from 'ulid';
export interface Clock {
    now(): string;
}
export interface IdGenerator {
    next(prefix: string): string;
}
export interface Dependencies {
    clock: Clock;
    ids: IdGenerator;
    seed: number;
}
export function defaults(): Dependencies {
    const next = monotonicFactory();
    return { clock: { now: () => new Date().toISOString() }, ids: { next: prefix => prefix + next() }, seed: 0 };
}
export function random(seed: number): () => number {
    let state = seed >>> 0;
    return () => { state = (Math.imul(1664525, state) + 1013904223) >>> 0; return state / 0x100000000; };
}
