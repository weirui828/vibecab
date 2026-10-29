import { createHash } from 'node:crypto';
import canonicalize from 'canonicalize';
import { fail } from '../../../contract/src/index.js';
import type { Element } from '../../../contract/src/index.js';
export function canonical(value: unknown): string {
    let result: unknown;
    try { result = canonicalize(value); }
    catch { fail('invalid', 'Value cannot be canonicalized'); }
    if (typeof result !== 'string') fail('invalid', 'Value cannot be canonicalized');
    return result;
}
export function revisionHash(element: Element): string { return createHash('sha256').update(canonical(element)).digest('hex'); }
