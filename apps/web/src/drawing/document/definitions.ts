import { SVG_NAMESPACE } from '@skysa/draw-core';
import { cell } from '@skysa/storage';

import {
	declaring,
	definitionById,
	isReferenced,
	isSvgElement,
	markupSize,
	placeAfter,
	SMALL_COMMAND_BYTES,
	spaceBefore,
	undeclare,
} from './dom.js';
import type { Command } from './model.js';

/**
 * What the app keeps in the root's `<defs>` (docs/decisions/0003-layers.md:
 * "a mask, a clip and an adjustment are `mask`, `clip-path` and `filter`
 * referring into the root's `<defs>`"), as commands: an entry made, rebuilt or
 * taken away, and the entries nothing refers to any more let go. Each finds
 * its entry by id on every apply and every revert, as a layer command finds
 * its layer, and puts back the very node it took out, so undo gives the file
 * its own bytes again.
 */

type Kept = Readonly<{
	/** The entry as it was, out of the document while this command is applied. */
	old: Element | undefined;
	/** Where `old` was, and the indentation it had, for putting it back. */
	parent: Node | null;
	next: Node | null;
	space: Text | undefined;
	/** The `<defs>` this command made, with its indentation, to take away again. */
	defs: Readonly<{ element: Element; space: Text | undefined }> | undefined;
	/** The indentation the new entry was given, where it went in as a new child. */
	madeSpace: Text | undefined;
	declared: string | undefined;
	bytes: number;
}>;

type MadeDefs = Readonly<{
	element: Element;
	made: Readonly<{ element: Element; space: Text | undefined }> | undefined;
}>;

/**
 * The root's first `<defs>`, or one made after the `<title>`, indented as it
 * is, or first among the root's elements where there is no title.
 */
const defsFor = (root: SVGSVGElement): MadeDefs => {
	const existing = [...root.children].find((child) => isSvgElement(child, 'defs'));
	if (existing !== undefined) return { element: existing, made: undefined };
	const defs = root.ownerDocument.createElementNS(SVG_NAMESPACE, 'defs');
	const title = [...root.children].find((child) => isSvgElement(child, 'title'));
	if (title !== undefined)
		return { element: defs, made: { element: defs, space: placeAfter(title, defs) } };
	const first = root.firstElementChild;
	if (first === null) {
		root.appendChild(defs);
		return { element: defs, made: { element: defs, space: undefined } };
	}
	const space = spaceBefore(first)?.cloneNode() as Text | undefined;
	first.before(defs);
	if (space !== undefined) defs.after(space);
	return { element: defs, made: { element: defs, space } };
};

/** The entry at the end of `defs`, indented as the one before it is. */
const append = (defs: Element, entry: Element): Text | undefined => {
	const last = defs.lastElementChild;
	if (last !== null) return placeAfter(last, entry);
	defs.appendChild(entry);
	return undefined;
};

/**
 * `entry` in `old`'s place, or at the end of the `<defs>` where there is no
 * `old`, or, with no `entry`, `old` taken out with its indentation: what was
 * done, for the revert.
 */
const put = (
	root: SVGSVGElement,
	old: Element | undefined,
	entry: Element | undefined
): Omit<Kept, 'declared'> => {
	const bytes =
		SMALL_COMMAND_BYTES +
		(old === undefined ? 0 : markupSize(old)) +
		(entry === undefined ? 0 : markupSize(entry));
	const where = { old, parent: old?.parentNode ?? null, next: old?.nextSibling ?? null, bytes };
	if (old === undefined) {
		if (entry === undefined)
			return { ...where, space: undefined, defs: undefined, madeSpace: undefined };
		const placed = defsFor(root);
		const madeSpace = append(placed.element, entry);
		return { ...where, space: undefined, defs: placed.made, madeSpace };
	}
	if (entry !== undefined) {
		old.replaceWith(entry);
		return { ...where, space: undefined, defs: undefined, madeSpace: undefined };
	}
	const space = spaceBefore(old);
	space?.remove();
	old.remove();
	return { ...where, space, defs: undefined, madeSpace: undefined };
};

/**
 * The entry `id` in the root's `<defs>` made by `make`, in the old one's place
 * where there is one and at the end of the `<defs>` where there is none; with
 * no `make`, the entry taken away. `make` runs on every apply, so a redo
 * builds the same entry again; what it declares on the root, the app's
 * namespace for a `draw:*` attribute, undo takes back.
 */
export const setDefinition = (
	id: string,
	localName: string,
	make: ((root: SVGSVGElement) => Element) | undefined
): Command => {
	const kept = cell<Kept | undefined>(undefined);
	return {
		label: 'layers.definition',
		apply: (root) => {
			const old = definitionById(root, id, localName);
			if (old === undefined && make === undefined) {
				kept.current = undefined;
				return;
			}
			const made = cell<Element | undefined>(undefined);
			const declared = declaring(root, () => {
				made.current = make?.(root);
			});
			kept.current = { ...put(root, old, made.current), declared };
		},
		revert: (root) => {
			const done = kept.current;
			if (done === undefined) return;
			const current = definitionById(root, id, localName);
			if (done.old !== undefined && current !== undefined) current.replaceWith(done.old);
			if (done.old === undefined) {
				current?.remove();
				done.madeSpace?.remove();
			}
			if (done.old !== undefined && current === undefined && done.parent !== null) {
				// The entry was taken away: back where it was, with its indentation.
				const next = done.next?.parentNode === done.parent ? done.next : null;
				done.parent.insertBefore(done.old, next);
				if (done.space !== undefined) done.parent.insertBefore(done.space, done.old);
			}
			done.defs?.element.remove();
			done.defs?.space?.remove();
			undeclare(root, done.declared);
		},
		get bytes() {
			return kept.current?.bytes ?? 0;
		},
	};
};

type Removed = Readonly<{
	entry: Element;
	parent: Node;
	next: Node | null;
	space: Text | undefined;
}>;

/**
 * The entries named that nothing in the drawing refers to any more, taken
 * out: a layer's filter once the layer is rasterized, a clip once the layer it
 * clipped is merged. One that something still uses, a duplicate of the layer
 * that shares it, stays. Undo puts each back where it was, in the reverse of
 * the order they went.
 */
export const removeUnreferenced = (
	entries: readonly Readonly<{ id: string; localName: string }>[]
): Command => {
	const removed = cell<readonly Removed[]>([]);
	return {
		label: 'layers.definition',
		apply: (root) => {
			removed.current = entries.flatMap(({ id, localName }) => {
				const entry = definitionById(root, id, localName);
				const parent = entry?.parentNode ?? null;
				if (entry === undefined || parent === null || isReferenced(root, id)) return [];
				const space = spaceBefore(entry);
				const record: Removed = { entry, parent, next: entry.nextSibling, space };
				space?.remove();
				entry.remove();
				return [record];
			});
		},
		revert: () => {
			[...removed.current].reverse().forEach(({ entry, parent, next, space }) => {
				parent.insertBefore(entry, next?.parentNode === parent ? next : null);
				if (space !== undefined) parent.insertBefore(space, entry);
			});
		},
		get bytes() {
			return removed.current.reduce(
				(total, { entry }) => total + SMALL_COMMAND_BYTES + markupSize(entry),
				0
			);
		},
	};
};
