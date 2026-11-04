import { SVG_NAMESPACE } from '@skysa/draw-core';

import { XMLNS_NAMESPACE } from './namespaces.js';

/**
 * The drawing's text from the tree (docs/ARCHITECTURE.md §3, "The drawing
 * file"; §7, "The editor"). `XMLSerializer` writes the root and what is in it,
 * namespaces and all, and nothing before it: no XML declaration, no comment,
 * no doctype. That is why the file's own prolog is kept as it was read and put
 * back in front, so a file from Inkscape keeps its comment and its doctype
 * through an edit. The newline at the end is the one `emptyDrawing` writes.
 */

const START_TAG_END = /^[\s/>]/;

/**
 * The root as it was named. The DOM Parsing spec's serializer, which jsdom
 * follows and Chrome with it, writes an unprefixed root as `<svg:svg>` when
 * the root also binds a prefix to SVG's namespace, as Inkscape's `xmlns:svg`
 * does on every file it saves. That is the same element to an XML parser, but
 * not to DOMPurify, which will not sanitize a prefixed root in place, so the
 * drawing would not open again. The root keeps its `xmlns` for SVG, so `svg`
 * alone means the same, and the prefix is taken off the start and end tags.
 */
const unprefixedRoot = (root: Element, serialized: string): string => {
	if (root.prefix !== null || root.getAttributeNS(XMLNS_NAMESPACE, 'xmlns') !== SVG_NAMESPACE) {
		return serialized;
	}
	const prefix = [...root.attributes]
		.filter(
			(attribute) =>
				attribute.namespaceURI === XMLNS_NAMESPACE &&
				attribute.prefix === 'xmlns' &&
				attribute.value === SVG_NAMESPACE
		)
		.map((attribute) => attribute.localName)
		.find((candidate) => {
			const start = `<${candidate}:${root.localName}`;
			return (
				serialized.startsWith(start) && START_TAG_END.test(serialized.slice(start.length))
			);
		});
	if (prefix === undefined) return serialized;
	const start = `<${prefix}:${root.localName}`;
	const end = `</${prefix}:${root.localName}>`;
	const body = serialized.slice(start.length);
	return body.endsWith(end)
		? `<${root.localName}${body.slice(0, -end.length)}</${root.localName}>`
		: `<${root.localName}${body}`;
};

export const serializeDrawing = (root: Element, prolog: string): string =>
	`${prolog}${unprefixedRoot(root, new XMLSerializer().serializeToString(root))}\n`;
