import { describe, expect, it } from 'vitest';
import { paragraph } from './helpers.js';
import { contentFixture } from './content-fixture.js';
describe('commit rules', () => {
    it('allocates IDs, preserves untouched hashes, and rejects caller IDs and order', () => {
        const f = contentFixture();
        try {
            const first = f.commit({ baseVersion: 1, changes: [{ op: 'add', tempId: 'new:1', parentId: null, element: paragraph('One') }, { op: 'add', tempId: 'new:2', parentId: null, element: paragraph('Two') }] });
            const id = first.idMap['new:1']!, other = first.idMap['new:2']!, before = f.store.version(f.artifactId, 2);
            f.commit({ baseVersion: 2, changes: [{ op: 'update', elementId: id, element: paragraph('Changed') }] });
            expect(f.store.version(f.artifactId, 3).manifest[other]).toBe(before.manifest[other]);
            expect(() => f.commit({ baseVersion: 3, changes: [{ op: 'add', tempId: 'el_bad', parentId: null, element: paragraph('Bad') }] })).toThrow();
            expect(() => f.commit({ baseVersion: 3, changes: [{ op: 'add', tempId: 'new:8', parentId: null, element: { ...paragraph('Bad'), order: 'bad' } }] })).toThrow();
        }
        finally {
            f.store.close();
        }
    });
    it('detects stale writes exactly and permits changes to other elements', () => {
        const f = contentFixture();
        try {
            const a = f.commit({ baseVersion: 1, changes: [{ op: 'add', tempId: 'new:1', parentId: null, element: paragraph('One') }, { op: 'add', tempId: 'new:2', parentId: null, element: paragraph('Two') }] });
            const one = a.idMap['new:1']!, two = a.idMap['new:2']!;
            f.commit({ baseVersion: 2, changes: [{ op: 'update', elementId: one, element: paragraph('New') }] });
            expect(() => f.commit({ baseVersion: 2, changes: [{ op: 'update', elementId: one, element: paragraph('Stale') }] })).toThrow(expect.objectContaining({ contract: { code: 'stale_base', message: expect.any(String), retryable: false, details: { conflictingElementIds: [one] } } }));
            expect(f.commit({ baseVersion: 2, changes: [{ op: 'update', elementId: two, element: paragraph('Fine') }] }).version).toBe(4);
        }
        finally {
            f.store.close();
        }
    });
    it('validates parent types, removed parents, cycles, and invalid after positions atomically', () => {
        const f = contentFixture();
        try {
            const a = f.commit({ baseVersion: 1, changes: [{ op: 'add', tempId: 'new:1', parentId: null, element: { type: 'list', props: { ordered: false } } }, { op: 'add', tempId: 'new:2', parentId: 'new:1', element: { type: 'list_item', props: {}, text: 'Item' } }] });
            const parent = a.idMap['new:1']!, child = a.idMap['new:2']!;
            for (const changes of [
                [{ op: 'add', tempId: 'new:3', parentId: parent, element: paragraph('Invalid') }],
                [{ op: 'remove', elementId: parent }, { op: 'add', tempId: 'new:3', parentId: parent, element: { type: 'list_item', props: {}, text: 'Invalid' } }],
                [{ op: 'move', elementId: parent, parentId: child }],
                [{ op: 'move', elementId: parent, parentId: null, after: 'el_missing' }]
            ])
                expect(() => f.commit({ baseVersion: 2, changes })).toThrow();
            expect(f.store.artifact(f.artifactId).headVersion).toBe(2);
            const removed = f.commit({ baseVersion: 2, changes: [{ op: 'remove', elementId: parent }] });
            expect(new Set(removed.writeSet)).toEqual(new Set([parent, child]));
        }
        finally {
            f.store.close();
        }
    });
    it('allows a changed parent but prevents type changes and stale descendant removal', () => {
        const f = contentFixture();
        try {
            const a = f.commit({ baseVersion: 1, changes: [{ op: 'add', tempId: 'new:1', parentId: null, element: { type: 'list', props: { ordered: false } } }, { op: 'add', tempId: 'new:2', parentId: 'new:1', element: { type: 'list_item', props: {}, text: 'Item' } }] });
            const parent = a.idMap['new:1']!, child = a.idMap['new:2']!;
            f.commit({ baseVersion: 2, changes: [{ op: 'update', elementId: parent, element: { type: 'list', props: { ordered: true } } }] });
            expect(f.commit({ baseVersion: 2, changes: [{ op: 'add', tempId: 'new:3', parentId: parent, element: { type: 'list_item', props: {}, text: 'New' } }] }).version).toBe(4);
            expect(() => f.commit({ baseVersion: 4, changes: [{ op: 'update', elementId: child, element: paragraph('Changed type') }] })).toThrow();
            f.commit({ baseVersion: 4, changes: [{ op: 'update', elementId: child, element: { type: 'list_item', props: {}, text: 'Revised' } }] });
            expect(() => f.commit({ baseVersion: 4, changes: [{ op: 'remove', elementId: parent }] })).toThrow(expect.objectContaining({ contract: expect.objectContaining({ code: 'stale_base' }) }));
        }
        finally {
            f.store.close();
        }
    });
});
it('updates are limited to text and props', () => {
    const f = contentFixture();
    try {
        const added = f.commit({ baseVersion: 1, changes: [{ op: 'add', tempId: 'new:0', parentId: null, element: { type: 'image', props: { alt: 'Picture' }, blobHash: 'a'.repeat(64) } }] });
        const id = added.idMap['new:0']!;
        expect(() => f.commit({ baseVersion: 2, changes: [{ op: 'update', elementId: id, element: { type: 'image', props: { alt: 'Picture' }, blobHash: 'b'.repeat(64) } }] })).toThrow();
    }
    finally {
        f.store.close();
    }
});
it('rejects a generated element ID already used by another artifact', async () => {
    const { Content } = await import('../src/content/content.js');
    const { Contract } = await import('../../contract/src/index.js');
    const { clock } = await import('./helpers.js');
    const f = contentFixture();
    try {
        const first = f.commit({ baseVersion: 1, changes: [{ op: 'add', tempId: 'new:0', parentId: null, element: paragraph('First') }] });
        const duplicate = first.idMap['new:0']!;
        const content = new Content(f.store, new Contract(), clock, { next: prefix => prefix === 'el_' ? duplicate : 'art_second' });
        const second = f.store.transaction(() => content.create('Second', { kind: 'human' }));
        expect(() => f.store.transaction(() => content.commit({ artifactId: second.artifactId, baseVersion: 1, createdBy: { kind: 'human' }, source: {}, changes: [{ op: 'add', tempId: 'new:0', parentId: null, element: paragraph('Second') }] }))).toThrow();
    }
    finally {
        f.store.close();
    }
});
