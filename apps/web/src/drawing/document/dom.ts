import { SVG_NAMESPACE } from '@skysa/draw-core';

import { boundDrawingPrefix } from './layers.js';
import { XLINK_NAMESPACE, XMLNS_NAMESPACE } from './namespaces.js';

/**
 * What the commands share (docs/ARCHITECTURE.md §7, "Commands and history"):
 * an element's attributes kept and put back in their order, a namespace
 * declaration taken back, the indentation a new sibling is given, the ids and
 * the references between elements. Nothing here records an undo; the commands
 * in `commands.ts` and beside it do, around these.
 */

export type SavedAttribute = Readonly<{ namespace: string | null; name: string; value: string }>;

export const attributesOf = (element: Element): readonly SavedAttribute[] =>
	[...element.attributes].map((attribute) => ({
		namespace: attribute.namespaceURI,
		name: attribute.name,
		value: attribute.value,
	}));

/** The element's attributes as they were, in the order they were: an attribute set anew goes last. */
export const resetAttributes = (element: Element, saved: readonly SavedAttribute[]): void => {
	[...element.attributes].forEach((attribute) => element.removeAttributeNode(attribute));
	saved.forEach(({ namespace, name, value }) => element.setAttributeNS(namespace, name, value));
};

export const savedBytes = (saved: readonly SavedAttribute[]): number =>
	saved.reduce((total, { name, value }) => total + name.length + value.length, 0);

/**
 * Roughly what an element and everything in it hold, in characters: its
 * attributes' values and its text, which is where a drawing's bytes are, without
 * serializing it to find out.
 */
export const markupSize = (element: Element): number =>
	[element, ...element.querySelectorAll('*')].reduce(
		(total, each) => total + savedBytes(attributesOf(each)),
		element.textContent.length
	);

/** What a command that keeps only a few attributes costs, at least. */
export const SMALL_COMMAND_BYTES = 64;

/**
 * Runs a write that may declare the app's namespace on the root, and says
 * which prefix it declared, so the revert can take the declaration away again
 * and leave the root as it was.
 */
export const declaring = (root: Element, write: () => void): string | undefined => {
	const before = boundDrawingPrefix(root);
	write();
	return before === undefined ? boundDrawingPrefix(root) : undefined;
};

export const undeclare = (root: Element, prefix: string | undefined): void => {
	if (prefix !== undefined) root.removeAttributeNS(XMLNS_NAMESPACE, prefix);
};

export const isSpace = (node: Node | null): node is Text =>
	node instanceof Text && node.data.trim() === '';

/** The indentation before an element, to give a new sibling the same. */
export const spaceBefore = (element: Element): Text | undefined => {
	const previous = element.previousSibling;
	return isSpace(previous) ? previous : undefined;
};

/** `element` after `anchor`, indented as `anchor` is; returns the indentation it added. */
export const placeAfter = (anchor: Element, element: Element): Text | undefined => {
	const space = spaceBefore(anchor)?.cloneNode() as Text | undefined;
	if (space === undefined) anchor.after(element);
	else anchor.after(space, element);
	return space;
};

export const isSvgElement = (node: Node | null, localName: string): node is SVGElement =>
	node instanceof Element && node.namespaceURI === SVG_NAMESPACE && node.localName === localName;

/** The element under the root with this id, of these local names: a mask, a filter. */
export const definitionById = (root: Element, id: string, localName: string): Element | undefined =>
	[...root.getElementsByTagNameNS(SVG_NAMESPACE, localName)].find(
		(element) => element.getAttribute('id') === id
	);

/** `url(#id)` alone, with or without quotes, as a `mask` or a `filter` names what it uses. */
const SOLE_URL = /^url\(\s*(['"]?)#([^'")\s]+)\1\s*\)$/;

/** The id a `mask`, `filter` or `clip-path` value names, where it is one `url(#…)` and nothing else. */
export const soleReference = (value: string | null): string | undefined => {
	const match = SOLE_URL.exec((value ?? '').trim());
	return match?.[2];
};

const REFERENCE = /url\(\s*(['"]?)#([^'")\s]+)\1\s*\)/g;

/** The ids an attribute's value refers to: every `url(#…)` in it, and a whole `#…` link. */
const referencedIds = (attribute: Attr): readonly string[] => {
	const urls = [...attribute.value.matchAll(REFERENCE)].map((match) => match[2] ?? '');
	const isLink =
		attribute.localName === 'href' &&
		(attribute.namespaceURI === null || attribute.namespaceURI === XLINK_NAMESPACE);
	const link = isLink && attribute.value.startsWith('#') ? [attribute.value.slice(1)] : [];
	return [...urls, ...link].filter((id) => id !== '');
};

/** Every id something in `element`, itself included, refers to. */
export const idsReferencedIn = (element: Element): ReadonlySet<string> =>
	new Set(
		[element, ...element.querySelectorAll('*')].flatMap((each) =>
			[...each.attributes].flatMap(referencedIds)
		)
	);

/** Whether anything under the root refers to `id`, by `url(#id)` or by a `#id` link. */
export const isReferenced = (root: Element, id: string): boolean => idsReferencedIn(root).has(id);

/** `base`, or `base-2`, `base-3`, … where that is taken by an element already. */
export const freeIdFrom = (base: string, taken: ReadonlySet<string>): string =>
	Array.from({ length: taken.size + 1 }, (_, index) =>
		index === 0 ? base : `${base}-${index + 1}`
	).find((candidate) => !taken.has(candidate)) ?? `${base}-${taken.size + 2}`;
