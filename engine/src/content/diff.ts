import { diffWords } from 'diff';
import type { Anchor, AnchorResolution, DiffResult, Element, Outline } from '../../../contract/src/index.js';
import type { Repository } from '../storage/repository.js';
import { canonical } from './hash.js';
export function diffVersions(store: Repository, id: string, from: number, to: number): DiffResult {
    const a = store.version(id, from), b = store.version(id, to), old = new Map(store.elements(id, from).map(e => [e.elementId, e])), next = new Map(store.elements(id, to).map(e => [e.elementId, e]));
    const result: DiffResult = { added: [], removed: [], changed: [], moved: [], textDiffs: {} };
    for (const elementId of new Set([...Object.keys(a.manifest), ...Object.keys(b.manifest)])) {
        const before = old.get(elementId), after = next.get(elementId);
        if (!before) {
            result.added.push(elementId);
            continue;
        }
        if (!after) {
            result.removed.push(elementId);
            continue;
        }
        if (before.parentId !== after.parentId || before.order !== after.order)
            result.moved.push(elementId);
        const withoutPosition = (e: Element) => { const { parentId: _, order: __, ...rest } = e; void _; void __; return rest; };
        if (canonical(withoutPosition(before)) !== canonical(withoutPosition(after))) {
            result.changed.push(elementId);
            if (('text' in before || 'text' in after) && ('text' in before ? before.text : '') !== ('text' in after ? after.text : ''))
                result.textDiffs[elementId] = diffWords('text' in before ? before.text : '', 'text' in after ? after.text : '').map(p => ({ value: p.value, ...(p.added ? { added: true } : {}), ...(p.removed ? { removed: true } : {}) }));
        }
    }
    return result;
}
export function outline(elements: Element[]): Outline {
    const children = (parentId: string | null): Outline => elements.filter(e => e.parentId === parentId).map(e => ({ elementId: e.elementId, type: e.type, preview: 'text' in e ? e.text.slice(0, 60) : '', children: children(e.elementId) }));
    return children(null);
}
export function resolveAnchors(store: Repository, anchors: Anchor[]): AnchorResolution[] {
    return anchors.map(anchor => {
        const seen = store.version(anchor.artifactId, anchor.seenVersion);
        if (seen.manifest[anchor.elementId] !== anchor.seenHash)
            throw new Error('Anchor does not match seen version');
        const head = store.version(anchor.artifactId), hash = head.manifest[anchor.elementId];
        if (hash === undefined)
            return { anchor, state: 'removed' };
        if (hash === anchor.seenHash)
            return { anchor, state: 'current' };
        const result: AnchorResolution = { anchor, state: 'revised' };
        if (anchor.locator) {
            const e = store.elements(anchor.artifactId).find(e => e.elementId === anchor.elementId);
            if (e && 'text' in e) {
                const { quote, prefix, suffix } = anchor.locator;
                const unique = (value: string) => { const at = e.text.indexOf(value); return at >= 0 && e.text.indexOf(value, at + 1) < 0 ? at : undefined; };
                const context = unique(prefix + quote + suffix), at = context === undefined ? unique(quote) : context + prefix.length;
                if (at !== undefined)
                    result.range = { start: at, end: at + quote.length };
            }
        }
        return result;
    });
}
