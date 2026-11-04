import { SVG_NAMESPACE } from '@skysa/draw-core';
import DOMPurify, { type Config } from 'dompurify';

import {
	MATHML_NAMESPACE,
	XHTML_NAMESPACE,
	XLINK_NAMESPACE,
	XML_NAMESPACE,
	XMLNS_NAMESPACE,
} from './namespaces.js';

export {
	MATHML_NAMESPACE,
	XHTML_NAMESPACE,
	XLINK_NAMESPACE,
	XMLNS_NAMESPACE,
} from './namespaces.js';

/**
 * The way a drawing gets into the page (docs/ARCHITECTURE.md §7, "The editor";
 * §9, "SVG is script's way in"). An SVG in the DOM runs its `<script>`, its
 * `on*` handlers and its `javascript:` links, and this app keeps a credential
 * in IndexedDB that a script could copy out (CLAUDE.md), so nothing of a
 * drawing is put into the page before DOMPurify has been over it, in place, in
 * the XML document the text was parsed into. What it takes out no drawing
 * needs; what it would take out that a drawing does need is kept here on
 * purpose, and `tests/drawing/sanitize.test.ts` holds both lists.
 *
 * Elements and attributes in a namespace that is not SVG's, XHTML's or
 * MathML's are kept: a browser gives them no behavior at all, so they are
 * inert, and they are Inkscape's vocabulary, the metadata other tools write,
 * and this app's own (`draw:*`).
 */

/** Where a parser says it could not read the text: Firefox's and jsdom's root, Chrome's and Safari's child. */
const PARSE_ERROR_NAMESPACES = [
	'http://www.mozilla.org/newlayout/xml/parsererror.xml',
	XHTML_NAMESPACE,
];

/**
 * The text as an XML document, or `undefined` where it is not well-formed or
 * its root is not an `svg` element in the SVG namespace: such a file is shown
 * as an image and never rewritten (§3).
 */
export const parseDrawing = (text: string): XMLDocument | undefined => {
	const parsed = new DOMParser().parseFromString(text, 'image/svg+xml');
	const failed = PARSE_ERROR_NAMESPACES.some(
		(namespace) => parsed.getElementsByTagNameNS(namespace, 'parsererror').length > 0
	);
	const root = parsed.documentElement;
	if (failed || root.namespaceURI !== SVG_NAMESPACE || root.localName !== 'svg') return undefined;
	return parsed;
};

/** The namespaces a browser gives elements behavior in. */
const LIVE_NAMESPACES: ReadonlySet<string> = new Set([
	SVG_NAMESPACE,
	XHTML_NAMESPACE,
	MATHML_NAMESPACE,
]);

/**
 * The namespaces of the attributes a browser reads on an SVG element: SVG's
 * own are in no namespace, and beside them only XLink's `href` and XML's
 * `space` and `lang` mean anything. These, and the three above to be sure, are
 * left to DOMPurify's lists; an attribute in any other namespace is inert.
 */
const READ_ATTRIBUTE_NAMESPACES: ReadonlySet<string> = new Set([
	...LIVE_NAMESPACES,
	XLINK_NAMESPACE,
	XML_NAMESPACE,
]);

const isLiveElement = (element: Element): boolean =>
	element.namespaceURI !== null && LIVE_NAMESPACES.has(element.namespaceURI);

/** An element in no namespace is not kept either: nothing writes one, and DOMPurify refuses it. */
const isForeignElement = (element: Element): boolean =>
	element.namespaceURI !== null && !isLiveElement(element);

/** A namespace declaration, or an attribute in a namespace no browser reads. */
const isInertAttribute = (attribute: Attr): boolean =>
	attribute.namespaceURI === XMLNS_NAMESPACE ||
	(attribute.namespaceURI !== null && !READ_ATTRIBUTE_NAMESPACES.has(attribute.namespaceURI));

/**
 * A URL with every space and control character taken out, wherever it is, in
 * lower case: the most a URL parser could make of it when it looks for a
 * scheme, which strips some of them and is told apart by none of them.
 */
const compactUrl = (value: string): string =>
	[...value]
		.filter((character) => character > ' ')
		.join('')
		.toLowerCase();

/** A reference into this document: `#id`, which is all a `<use>` may point at. */
const isFragmentReference = (value: string): boolean => compactUrl(value).startsWith('#');

/**
 * A `data:` URL that is not a picture. DOMPurify lets an `<image>` have any
 * `data:` URL, since an image's bytes cannot run; one that is HTML has no
 * business in a drawing, and an `href` that is one is taken out.
 */
const isDataOtherThanImage = (value: string): boolean => {
	const url = compactUrl(value);
	return url.startsWith('data:') && !url.startsWith('data:image/');
};

/**
 * The hooks, on an instance of DOMPurify's own so that no other caller of it
 * in the app gets them. Each answers by writing to the event DOMPurify hands
 * it, which is the hooks' contract and the one mutation of something not ours.
 */
const purifier = DOMPurify(window);

// A `<use>` draws another element in its place, and one that reaches outside
// this document draws something the sanitizer never saw: it is let in (SVG's
// default lists leave it out) and then taken out unless every reference it
// has, `href` or `xlink:href`, is to an element here.
purifier.addHook('uponSanitizeElement', (node) => {
	if (!(node instanceof Element)) return;
	if (node.namespaceURI !== SVG_NAMESPACE || node.localName !== 'use') return;
	const references = [
		node.getAttributeNS(null, 'href'),
		node.getAttributeNS(XLINK_NAMESPACE, 'href'),
	].filter((value) => value !== null);
	if (!references.every(isFragmentReference)) node.remove();
});

// DOMPurify names an attribute by its qualified name in lower case. XML names
// are case-sensitive, so the attribute is found by every name that lowers to
// it, and kept only when each of them is inert: `Foo:href` bound to XLink
// beside `foo:href` bound to Inkscape is judged by DOMPurify's lists, not ours.
purifier.addHook('uponSanitizeAttribute', (element, event) => {
	const named = [...element.attributes].filter(
		(attribute) => attribute.name.toLowerCase() === event.attrName
	);
	if (named.length > 0 && named.every(isInertAttribute)) {
		// eslint-disable-next-line functional/immutable-data -- the hook's answer (see above)
		event.forceKeepAttr = true;
		return;
	}
	const isLink = event.attrName === 'href' || event.attrName === 'xlink:href';
	// eslint-disable-next-line functional/immutable-data -- the hook's answer (see above)
	if (isLink && isDataOtherThanImage(event.attrValue)) event.keepAttr = false;
});

/**
 * SVG and SVG's filters, as DOMPurify knows them, in place, with `<use>` (see
 * the hook) and with a filter's `<feImage>` allowed a `data:` picture as an
 * `<image>` is.
 */
const CONFIG: Config & Readonly<{ IN_PLACE: true }> = {
	IN_PLACE: true,
	USE_PROFILES: { svg: true, svgFilters: true },
	ADD_TAGS: ['use'],
	ADD_DATA_URI_TAGS: ['feImage'],
};

/** The processing instructions inside a foreign element, which DOMPurify takes out everywhere else. */
const processingInstructionsIn = (element: Element): readonly ProcessingInstruction[] => {
	const walker = element.ownerDocument.createTreeWalker(
		element,
		NodeFilter.SHOW_PROCESSING_INSTRUCTION
	);
	const collect = (found: readonly ProcessingInstruction[]): readonly ProcessingInstruction[] => {
		const next = walker.nextNode();
		return next instanceof ProcessingInstruction ? collect([...found, next]) : found;
	};
	return collect([]);
};

/**
 * A foreign element is inert, and so is everything in it that is foreign too;
 * an SVG, XHTML or MathML element inside one is not, since a `<script>` runs
 * wherever it is. Those are taken out, with what no browser should read on a
 * foreign element even though none does: an `on*` attribute, an XLink.
 */
const neutralizeForeign = (element: Element): void => {
	const inside = [...element.querySelectorAll('*')];
	inside.filter(isLiveElement).forEach((live) => live.remove());
	[element, ...element.querySelectorAll('*')].forEach((each) =>
		[...each.attributes]
			.filter(
				(attribute) =>
					attribute.namespaceURI === XLINK_NAMESPACE ||
					(attribute.namespaceURI === null &&
						attribute.localName.toLowerCase().startsWith('on'))
			)
			.forEach((attribute) => each.removeAttributeNode(attribute))
	);
	processingInstructionsIn(element).forEach((instruction) => instruction.remove());
};

/**
 * Every outermost foreign element, swapped for an empty text node to stand in
 * its place while DOMPurify runs. DOMPurify cannot be told to keep them: its
 * namespace check removes any element outside SVG, XHTML and MathML whatever
 * its lists allow, and widening its list of tags by name from a hook would let
 * in a real `<script>` after a foreign one named the same. So they are lifted
 * out, made safe here by the rule above, and put back where their stand-ins
 * still are; one whose stand-in went, with an element DOMPurify removed whole,
 * goes too.
 */
const liftForeign = (root: Element): ReadonlyMap<Text, Element> => {
	const lifted = new Map<Text, Element>();
	[...root.querySelectorAll('*')].forEach((element) => {
		// In document order, so an outer one is lifted first and takes its inner ones with it.
		if (!isForeignElement(element) || !root.contains(element)) return;
		const standIn = root.ownerDocument.createTextNode('');
		element.replaceWith(standIn);
		neutralizeForeign(element);
		lifted.set(standIn, element);
	});
	return lifted;
};

/**
 * Takes out of the drawing, in place, everything that could run or reach
 * outside it: scripts, event handlers, `javascript:` and other active URLs,
 * `data:` links that are not pictures, `<foreignObject>`, a `<use>` of
 * something elsewhere, an animation of a link. Throws, and leaves the root
 * stripped bare, where DOMPurify will not work on the root in place (an
 * `svg:svg` with a prefix): such a drawing is shown as an image instead.
 */
export const sanitizeDrawing = (document: XMLDocument): void => {
	const root = document.documentElement;
	const lifted = liftForeign(root);
	purifier.sanitize(root, CONFIG);
	lifted.forEach((element, standIn) => {
		if (root.contains(standIn)) standIn.replaceWith(element);
	});
};
