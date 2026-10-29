import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createEngine } from '../src/engine.js';
import type { CallContext, ElementDraft } from '../../contract/src/index.js';
import type { Dependencies } from '../src/kernel/dependencies.js';
export const ctx: CallContext = { contractVersion: '1.0', principal: { kind: 'human' }, channel: 'in_process', scope: 'admin', requestId: 'test' };
export const clock = { now: () => '2026-10-28T00:00:00.000Z' };
export function ids() {
    let n = 0;
    const alphabet = '0123456789ABCDEFGHJKMNPQRSTVWXYZ';
    return { next: (prefix: string) => { let number = ++n, encoded = ''; do {
            encoded = alphabet[number % 32] + encoded;
            number = Math.floor(number / 32);
        } while (number); return prefix + encoded.padStart(26, '0'); } };
}
export function paragraph(text: string): ElementDraft { return { type: 'paragraph', props: {}, text }; }
export async function fixture(options: Partial<Dependencies> = {}) {
    const dir = await mkdtemp(join(tmpdir(), 'vibecab-'));
    const engine = createEngine({ clock, ids: ids(), seed: 42, modelProviders: {}, ...options });
    await engine.start(dir);
    return { engine, dir, close: async () => { await engine.stop(); await rm(dir, { recursive: true, force: true }); } };
}
export function tokenFactory() { let n = 0; return () => ('test-token-' + (++n)).padEnd(32, '0'); }
