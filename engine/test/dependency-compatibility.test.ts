import { createHash } from 'node:crypto';
import { expect, it } from 'vitest';
import { generateKeyBetween } from 'fractional-indexing';
import { Contract } from '../../contract/src/index.js';
import type { Element } from '../../contract/src/index.js';
import { canonical, revisionHash } from '../src/content/hash.js';
import { fixture, ctx } from './helpers.js';

it('preserves the persisted canonical JSON bytes and revision hashes', () => {
    const element = new Contract().read<Element>('element', {
        elementId: 'el_00000000000000000000000001',
        type: 'paragraph', parentId: null, order: 'a0', props: {}, text: 'Café 🌍',
    });
    const persisted = '{"elementId":"el_00000000000000000000000001","order":"a0","parentId":null,"props":{},"text":"Café 🌍","type":"paragraph"}';
    expect(canonical(element)).toBe(persisted);
    expect(revisionHash(element)).toBe(createHash('sha256').update(persisted).digest('hex'));
    expect(canonical({ z: -0, b: [1e30, 0.000001], a: '\u20ac' })).toBe('{"a":"€","b":[1e+30,0.000001],"z":0}');
});

it('extends existing fractional order keys without changing their format', () => {
    expect(generateKeyBetween(null, null)).toBe('a0');
    expect(generateKeyBetween('a0', null)).toBe('a1');
    expect(generateKeyBetween(null, 'a0')).toBe('Zz');
    expect(generateKeyBetween('a0', 'a1')).toBe('a0V');
});

it('maps strict Unicode canonicalization failures to invalid input', async () => {
    const f = await fixture();
    try {
        const result = await f.engine.command(ctx, {
            commandId: 'invalid-unicode', type: 'vc.CreateArtifact',
            payload: { title: '\uD800', mediaKind: 'doc' },
        });
        expect(result).toMatchObject({ ok: false, error: { code: 'invalid' } });
    } finally { await f.close(); }
});
