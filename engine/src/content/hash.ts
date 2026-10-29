import { createHash } from 'node:crypto';
import canonicalize from 'canonicalize';
import { fail } from '../../../contract/src/index.js';
import type { Element } from '../../../contract/src/index.js';
export function canonical(value: unknown): string { const serialize: unknown = canonicalize; if (typeof serialize !== 'function')
    throw Error('Invalid canonicalizer'); const result: unknown = serialize(value); if (typeof result !== 'string')
    fail('invalid', 'Value cannot be canonicalized'); return result; }
export function revisionHash(element: Element): string { return createHash('sha256').update(canonical(element)).digest('hex'); }
