/**
 * The drawing file (docs/decisions/0001-the-drawing-file.md): an SVG document,
 * which every browser, file manager and vector tool already opens, carrying
 * what this app needs to know about it as attributes in a namespace of its own
 * on the root element. The identity is `draw:id`, so a drawing renamed on one
 * device is the same drawing to another, as a note's frontmatter `id` was in
 * skysa-notes; the title is the SVG's own `<title>`, which other tools show.
 *
 * Read with a hand-rolled scanner rather than `DOMParser`: core runs in Node
 * and in Workers, where there is none, and nothing here needs the tree. Only
 * the prolog and the root's start tag are read, however large the drawing, and
 * the first `<title>` after it for the name. What is written is the same root
 * tag with one attribute changed, so a file another tool made keeps every byte
 * of its own.
 */

import { LAYER_ATTRIBUTES, layerId, type LayerKind } from './layers.js';

export const SVG_NAMESPACE = 'http://www.w3.org/2000/svg';

/** The namespace of this app's own attributes on a drawing's root element. */
export const DRAWING_NAMESPACE = 'https://skysa.org/draw/1';

/** The prefix this app binds the namespace to when the file has none yet. */
const PREFERRED_PREFIX = 'draw';

/**
 * What a drawing's id may look like: a UUID, or anything else that is safe in
 * an attribute value unquoted — so an id never has to be escaped, and a file
 * that holds something else at `draw:id` has no id rather than a strange one.
 */
const ID = /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/;

/** Whitespace, as `\s` reads it: the byte-order mark is among it. */
const SPACE = /\s/;

/**
 * Where a run of whitespace from `from` ends: `from` itself where there is
 * none. A loop, as `skipped` is.
 */
const spaceEnd = (text: string, from: number): number => {
	// eslint-disable-next-line functional/no-let -- see `skipped`
	let at = from;
	// eslint-disable-next-line functional/no-loop-statements -- see `skipped`
	while (at < text.length && SPACE.test(text.charAt(at))) at += 1;
	return at;
};

/** Just past the first `close` from `from`, or `undefined` where there is none. */
const closedBy = (text: string, close: string, from: number): number | undefined => {
	const at = text.indexOf(close, from);
	return at === -1 ? undefined : at + close.length;
};

/**
 * The first `mark` from `from` that nothing but whitespace separates from a
 * `>`: where it starts, and just past the `>`. A loop, as `skipped` is; the
 * whitespace after one `mark` ends before the next, so each is read once.
 */
const markThenClose = (
	text: string,
	mark: string,
	from: number
): Readonly<{ at: number; end: number }> | undefined => {
	// eslint-disable-next-line functional/no-let -- see `skipped`
	let at = text.indexOf(mark, from);
	// eslint-disable-next-line functional/no-loop-statements -- see `skipped`
	while (at !== -1) {
		const after = spaceEnd(text, at + mark.length);
		if (text.charAt(after) === '>') return { at, end: after + 1 };
		at = text.indexOf(mark, at + 1);
	}
	return undefined;
};

/**
 * Just past a doctype's internal subset and its `>`, from inside its `[`: the
 * first `]` that nothing but whitespace separates from a `>`. A `]` followed
 * by anything else, as one in a quoted value may be, does not end it; one in
 * a quoted value followed by `>` does, as it did when a pattern read this.
 */
const subsetEnd = (text: string, from: number): number | undefined =>
	markThenClose(text, ']', from)?.end;

/**
 * Just past a doctype, from after its `<!DOCTYPE`: its `>`, or its subset's
 * where a `[` comes before that `>`. With no `>` ahead it is never closed,
 * subset or not. The `[` is looked for only up to the `>`, so that each of a
 * great many doctypes costs its own length, not the rest of the file's.
 */
const doctypeEnd = (text: string, from: number): number | undefined => {
	const close = text.indexOf('>', from);
	if (close === -1) return undefined;
	const open = text.slice(from, close).indexOf('[');
	return open === -1 ? close + 1 : subsetEnd(text, from + open + 1);
};

/**
 * Just past whitespace or a comment that starts at `at`, each comment ending
 * at its first `-->` as XML's do: what may come before the root, and before
 * its title. `undefined` where neither starts there, or a comment never ends.
 */
const spaceOrCommentEnd = (text: string, at: number): number | undefined => {
	if (SPACE.test(text.charAt(at))) return spaceEnd(text, at);
	if (text.startsWith('<!--', at)) return closedBy(text, '-->', at + 4);
	return undefined;
};

/**
 * Just past what the prolog may hold that starts at `at`: whitespace, a
 * processing instruction or the XML declaration, a comment, or a doctype.
 * `undefined` where none starts there, or one starts and never ends.
 */
const prologItemEnd = (text: string, at: number): number | undefined => {
	if (text.startsWith('<?', at)) return closedBy(text, '?>', at + 2);
	if (text.startsWith('<!DOCTYPE', at)) return doctypeEnd(text, at + 9);
	return spaceOrCommentEnd(text, at);
};

/**
 * Just past the run of things from `from` that `item` reads one after another:
 * where the next is none of them, or one that starts and never ends.
 *
 * This file reads the prolog, and the whitespace and comments before a title,
 * with `indexOf` rather than patterns, and in loops rather than by recursion,
 * so that it is linear in the text however the text is written. Patterns for
 * them took seconds over a file another tool left half written: a doctype
 * never closed before a long run of spaces, a long run of spaces before no
 * title. Recursion would run out of stack over thousands of comments.
 */
const skipped = (
	text: string,
	from: number,
	item: (text: string, at: number) => number | undefined
): number => {
	// eslint-disable-next-line functional/no-let -- see above: linear, and no stack to run out of
	let at = from;
	// eslint-disable-next-line functional/no-loop-statements -- see above
	for (;;) {
		const next = item(text, at);
		if (next === undefined || next <= at) return at;
		at = next;
	}
};

/**
 * Where the prolog ends: everything XML allows before the root element, a BOM,
 * whitespace, the XML declaration and processing instructions, comments and a
 * document type declaration with or without an internal subset. Each ends at
 * the first close that fits, as XML's own do.
 */
const prologEnd = (text: string): number => skipped(text, 0, prologItemEnd);

/** What a name cannot hold, and what a value without quotes cannot. */
const NOT_NAME = /[\s"'<>/=]/;
const NOT_BARE = /[\s"'=<>`]/;

/** Where a run from `from` of what `stop` does not match ends. A loop, as `skipped` is. */
const runEnd = (text: string, from: number, stop: RegExp): number => {
	// eslint-disable-next-line functional/no-let -- see `skipped`
	let at = from;
	// eslint-disable-next-line functional/no-loop-statements -- see `skipped`
	while (at < text.length && !stop.test(text.charAt(at))) at += 1;
	return at;
};

/**
 * Just past a value without quotes that starts at `at`: up to whitespace or
 * what else such a value cannot hold, or to a `/>` after its first character,
 * which closes the tag. XML has every value quoted; a `width=10/>` some tool
 * wrote ends its value before the slash, as its author meant.
 */
const bareEnd = (text: string, at: number): number => {
	const end = runEnd(text, at, NOT_BARE);
	return end > at + 1 && text.startsWith('/>', end - 1) ? end - 1 : end;
};

/**
 * Just past the value that starts at `at`, after an attribute's `=`: one in
 * double or single quotes to its closing quote, or one without to `bareEnd`.
 * `undefined` where none starts there, or a quote is never closed.
 */
const valueEnd = (text: string, at: number): number | undefined => {
	const quote = text.charAt(at);
	if (quote === '"' || quote === "'") return closedBy(text, quote, at + 1);
	const end = bareEnd(text, at);
	return end === at ? undefined : end;
};

/**
 * Just past whitespace and the attribute after it, from `at`: its name, and
 * `=` and a value where they follow, with whitespace about the `=`.
 * `undefined` where there is no whitespace there, or no attribute after it,
 * or an `=` with no value.
 */
const spacedAttributeEnd = (text: string, at: number): number | undefined => {
	const name = spaceEnd(text, at);
	const nameEnd = runEnd(text, name, NOT_NAME);
	if (name === at || nameEnd === name) return undefined;
	const equals = spaceEnd(text, nameEnd);
	return text.charAt(equals) === '=' ? valueEnd(text, spaceEnd(text, equals + 1)) : nameEnd;
};

/**
 * An attribute, as `spacedAttributeEnd` reads one: a name, and a value in
 * double quotes, single quotes or bare. Only run over attributes it has read,
 * so a bare value never meets a `/>`.
 */
const ATTRIBUTE = /([^\s"'<>/=]+)(?:\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s"'=<>`]+)))?/g;

interface Attribute {
	readonly name: string;
	readonly value: string;
	/** Where it begins and ends in the text, from its name to the end of its value. */
	readonly start: number;
	readonly end: number;
}

interface StartTag {
	/** Where the tag begins and ends in the text, so it can be put back. */
	readonly start: number;
	readonly end: number;
	/**
	 * Where its last attribute ends, or its name where it has none: what
	 * follows is how it closes, `>` or `/>` with any whitespace before it.
	 */
	readonly attributesEnd: number;
	/** The element's name as written, and its prefix where it has one: `svg:svg` is `svg`. */
	readonly name: string;
	readonly prefix: string | undefined;
	/** Each attribute where it is, in order, and the value each name has. */
	readonly attributeList: readonly Attribute[];
	readonly attributes: ReadonlyMap<string, string>;
	readonly selfClosing: boolean;
}

/** The attributes of a start tag's `body`, which begins at `offset` in the text. */
const attributesOf = (body: string, offset: number): readonly Attribute[] =>
	[...body.matchAll(ATTRIBUTE)].map((match) => ({
		name: match[1] ?? '',
		value: match[2] ?? match[3] ?? match[4] ?? '',
		start: offset + match.index,
		end: offset + match.index + match[0].length,
	}));

/**
 * The start tag at `start` of an element named `localName`, with one prefix
 * or none, as XML's namespaces allow: its name, attributes each after
 * whitespace (`spacedAttributeEnd`), and `>` or `/>` with any whitespace
 * before it. `undefined` where there is another element there, or something
 * else. Read with `skipped`, as the prolog is: a pattern for it ran out of
 * stack over a great many attributes.
 */
const startTagAt = (text: string, start: number, localName: string): StartTag | undefined => {
	if (text.charAt(start) !== '<') return undefined;
	const nameEnd = runEnd(text, start + 1, NOT_NAME);
	const name = text.slice(start + 1, nameEnd);
	const colon = name.indexOf(':');
	if (colon === 0 || name.slice(colon + 1) !== localName) return undefined;
	const attributesEnd = skipped(text, nameEnd, spacedAttributeEnd);
	const close = spaceEnd(text, attributesEnd);
	const selfClosing = text.startsWith('/>', close);
	if (!selfClosing && text.charAt(close) !== '>') return undefined;
	const attributeList = attributesOf(text.slice(nameEnd, attributesEnd), nameEnd);
	return {
		start,
		end: close + (selfClosing ? 2 : 1),
		attributesEnd,
		name,
		prefix: colon === -1 ? undefined : name.slice(0, colon),
		attributeList,
		attributes: new Map(attributeList.map(({ name, value }) => [name, value])),
		selfClosing,
	};
};

/** The root's start tag, where the prolog is followed by an `svg`, with or without a prefix. */
const rootTagOf = (text: string): StartTag | undefined => startTagAt(text, prologEnd(text), 'svg');

/**
 * A start tag opened up to its last attribute, without the whitespace and the
 * `>` or `/>` after it: where an attribute is added, or a tag that closes
 * itself is opened.
 */
const openedTag = (text: string, tag: StartTag): string => text.slice(tag.start, tag.attributesEnd);

/** The root is an `svg` element in the SVG namespace, however it is declared. */
const isSvgRoot = (root: StartTag): boolean =>
	root.attributes.get(root.prefix === undefined ? 'xmlns' : `xmlns:${root.prefix}`) ===
	SVG_NAMESPACE;

/**
 * Whether text is an SVG document, which is what every `.svg` in the folder is
 * taken to be: one this app wrote, or one another tool did, which the app shows
 * and may give an id to (`withDrawingId`).
 */
export const isDrawingText = (text: string): boolean => {
	const root = rootTagOf(text);
	return root !== undefined && isSvgRoot(root);
};

/**
 * Everything before the root's start tag, byte for byte: a BOM, the XML
 * declaration, processing instructions, comments, a doctype and the whitespace
 * between them; `''` where the root tag opens the file. The editor serializes
 * the tree it holds and puts this back in front of it (docs/ARCHITECTURE.md §7,
 * "The editor"), so a file from Inkscape keeps its comment and its doctype
 * through an edit, and a drawing opened and closed is the same bytes.
 * `undefined` for text that is not an SVG document, which has no root to
 * serialize.
 */
export const readDrawingProlog = (text: string): string | undefined => {
	const root = rootTagOf(text);
	return root === undefined || !isSvgRoot(root) ? undefined : text.slice(0, root.start);
};

/** The prefix the root binds to `DRAWING_NAMESPACE`, where it binds one. */
const drawingPrefix = (root: StartTag): string | undefined =>
	[...root.attributes]
		.filter(([name, value]) => name.startsWith('xmlns:') && value === DRAWING_NAMESPACE)
		.map(([name]) => name.slice('xmlns:'.length))[0];

/** A drawing's id, or `undefined` for a file with none, or one this app cannot use. */
export const readDrawingId = (text: string): string | undefined => {
	const root = rootTagOf(text);
	if (root === undefined || !isSvgRoot(root)) return undefined;
	const prefix = drawingPrefix(root);
	const id = prefix === undefined ? undefined : root.attributes.get(`${prefix}:id`);
	return id !== undefined && ID.test(id) ? id : undefined;
};

/** A prefix not bound on the root: `draw`, or `draw2`, `draw3`, … where it is taken. */
const freePrefix = (root: StartTag): string => {
	const free = (candidate: string): boolean => !root.attributes.has(`xmlns:${candidate}`);
	if (free(PREFERRED_PREFIX)) return PREFERRED_PREFIX;
	// One of as many more as the root has attributes is free.
	return (
		Array.from({ length: root.attributes.size }, (_, i) => `${PREFERRED_PREFIX}${i + 2}`).find(
			free
		) ?? PREFERRED_PREFIX
	);
};

/**
 * The same text with `id` as the drawing's id: set on a file that has none,
 * replaced on one that has another. The root tag is the only thing rewritten,
 * and the namespace is declared there where the file does not declare it yet.
 * A `RangeError` for an id this app would not write, or text that is not a
 * drawing: neither is something to put in a file.
 */
export const withDrawingId = (text: string, id: string): string => {
	if (!ID.test(id)) throw new RangeError(`a drawing's id is a UUID or the like, not ${id}`);
	const root = rootTagOf(text);
	if (root === undefined || !isSvgRoot(root)) throw new RangeError('not an SVG document');
	const bound = drawingPrefix(root);
	const prefix = bound ?? freePrefix(root);
	const attribute = `${bound === undefined ? `xmlns:${prefix}="${DRAWING_NAMESPACE}" ` : ''}${prefix}:id="${id}"`;
	// In place where the file has the attribute, so a file given its id once
	// is the same bytes given it again: the last of that name, which is the
	// one read. Found among the attributes, so the same characters in another
	// attribute's value are not taken for it. At the end of the tag otherwise.
	const existing = root.attributeList.filter(({ name }) => name === `${prefix}:id`).at(-1);
	return existing === undefined
		? `${text.slice(0, root.start)}${openedTag(text, root)} ${attribute}${root.selfClosing ? '/>' : '>'}${text.slice(root.end)}`
		: `${text.slice(0, existing.start)}${attribute}${text.slice(existing.end)}`;
};

export interface DrawingSize {
	readonly width: number;
	readonly height: number;
}

const positive = (value: number): boolean => Number.isFinite(value) && value > 0;

/**
 * A length in user units: a number, with or without `px`. Anything else is not.
 * Trimmed first, and each part read one way only, so a long value is answered
 * in time to its length: whitespace on both sides of an optional `px` was two
 * runs that could split a run of spaces, and `\d+\.?\d*` two that could split
 * a run of digits.
 */
const USER_UNITS = /^([+]?(?:\d+(?:\.\d*)?|\.\d+)(?:e[+-]?\d+)?)(?:\s*px)?$/i;

const userUnits = (value: string | undefined): number | undefined => {
	const match = USER_UNITS.exec((value ?? '').trim());
	return match?.[1] === undefined ? undefined : Number(match[1]);
};

/**
 * The size of the drawing's canvas in user units: what `viewBox` says, or
 * failing that `width` and `height` where they are plain numbers. `undefined`
 * for a file that says neither, or says it in units only a renderer can
 * resolve; the app then shows it at a size of its own.
 */
export const readDrawingSize = (text: string): DrawingSize | undefined => {
	const root = rootTagOf(text);
	if (root === undefined || !isSvgRoot(root)) return undefined;
	const box = (root.attributes.get('viewBox') ?? '')
		.trim()
		.split(/[\s,]+/)
		.map(Number);
	const [, , boxWidth, boxHeight] = box;
	if (box.length === 4 && boxWidth !== undefined && boxHeight !== undefined) {
		return positive(boxWidth) && positive(boxHeight)
			? { width: boxWidth, height: boxHeight }
			: undefined;
	}
	const width = userUnits(root.attributes.get('width'));
	const height = userUnits(root.attributes.get('height'));
	return width !== undefined && height !== undefined && positive(width) && positive(height)
		? { width, height }
		: undefined;
};

/** The five references XML predefines, and numeric ones, as the characters they name. */
const decodeReferences = (text: string): string =>
	text.replace(/&(#x[0-9a-f]+|#\d+|lt|gt|amp|quot|apos);/gi, (whole, name: string) => {
		const lower = name.toLowerCase();
		if (lower === 'lt') return '<';
		if (lower === 'gt') return '>';
		if (lower === 'amp') return '&';
		if (lower === 'quot') return '"';
		if (lower === 'apos') return "'";
		const code = lower.startsWith('#x')
			? Number.parseInt(lower.slice(2), 16)
			: Number(lower.slice(1));
		return code > 0 && code <= 0x10ffff ? String.fromCodePoint(code) : whole;
	});

/**
 * The namespace a start tag's name is in: its prefix's, or the default where
 * it has none, as the tag itself or the root binds it. `''` where neither
 * binds it, or `xmlns=""` takes the default away: no namespace.
 */
const namespaceOf = (tag: StartTag, root: StartTag): string => {
	const binding = tag.prefix === undefined ? 'xmlns' : `xmlns:${tag.prefix}`;
	return tag.attributes.get(binding) ?? root.attributes.get(binding) ?? '';
};

/**
 * The name this app writes a title under: `title` where SVG is the root's
 * default namespace, and under the root's own prefix where it is not, so the
 * title is SVG's in a file whose root is `svg:svg`.
 */
const titleName = (root: StartTag): string =>
	root.prefix === undefined || root.attributes.get('xmlns') === SVG_NAMESPACE
		? 'title'
		: `${root.prefix}:title`;

interface TitleElement {
	/** Its start tag, which begins where what leads to it ends, and its text begins where it ends. */
	readonly tag: StartTag;
	/** Whether it is SVG's title, rather than one in no namespace (`firstTitle`). */
	readonly svg: boolean;
	/** Where its text ends, and just past its end tag. */
	readonly end: number;
	readonly close: number;
}

/**
 * The first `<title>` after the root tag, which is where SVG puts a document's
 * name and where this app writes it: past whatever whitespace and comments
 * lead to it (`spaceOrCommentEnd`). Its start tag is read as the root's is,
 * so a `>` in a quoted value does not end it, and one that closes itself is
 * an empty title. Its end tag is the first `</title` under the same name that
 * nothing but whitespace separates from a `>`.
 *
 * SVG's title, under whatever prefix binds SVG; or a `title` with no prefix
 * in no namespace, as this app's 0.1.0 wrote one under an `svg:svg` root, and
 * which `withDrawingTitle` writes as SVG's. `undefined` where the root's first
 * child is something else, or the title never closes.
 */
const firstTitle = (text: string, root: StartTag): TitleElement | undefined => {
	const tag = startTagAt(text, skipped(text, root.end, spaceOrCommentEnd), 'title');
	if (tag === undefined) return undefined;
	const namespace = namespaceOf(tag, root);
	const svg = namespace === SVG_NAMESPACE;
	if (!svg && (tag.prefix !== undefined || namespace !== '')) return undefined;
	if (tag.selfClosing) return { tag, svg, end: tag.end, close: tag.end };
	const end = markThenClose(text, `</${tag.name}`, tag.end);
	return end === undefined ? undefined : { tag, svg, end: end.at, close: end.end };
};

/**
 * The drawing's title: the text of the first `<title>` element directly after
 * the root tag (`firstTitle`). `undefined` where there is none, or it is
 * empty; the app then names the drawing by its file (`titleFromFilename`).
 */
export const readDrawingTitle = (text: string): string | undefined => {
	const root = rootTagOf(text);
	if (root === undefined || !isSvgRoot(root) || root.selfClosing) return undefined;
	const found = firstTitle(text, root);
	const title =
		found === undefined ? '' : decodeReferences(text.slice(found.tag.end, found.end)).trim();
	return title === '' ? undefined : title;
};

const escapeText = (text: string): string =>
	text.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');

/**
 * The same text with `title` as the drawing's title: the first `<title>` after
 * the root tag given it, or one put there where the file has none. An empty
 * title takes the element away, and the drawing goes by its file's name again.
 * A `RangeError` for text that is not a drawing.
 */
export const withDrawingTitle = (text: string, title: string): string => {
	const root = rootTagOf(text);
	if (root === undefined || !isSvgRoot(root)) throw new RangeError('not an SVG document');
	const trimmed = title.trim();
	const name = titleName(root);
	const element = `<${name}>${escapeText(trimmed)}</${name}>`;
	const before = text.slice(0, root.start);
	const tag = text.slice(root.start, root.end);
	if (root.selfClosing) {
		if (trimmed === '') return text;
		return `${before}${openedTag(text, root)}>${element}</${root.name}>${text.slice(root.end)}`;
	}
	const found = firstTitle(text, root);
	if (found === undefined) {
		return trimmed === '' ? text : `${before}${tag}\n  ${element}${text.slice(root.end)}`;
	}
	const lead = text.slice(root.end, found.tag.start);
	const after = text.slice(found.close);
	if (trimmed === '') return `${before}${tag}${lead.trimEnd()}${after}`;
	// SVG's title keeps its own start tag, attributes and all, so an `id` the
	// root's `aria-labelledby` names still names it, and is opened where it
	// closed itself. One in no namespace is written anew, as SVG's.
	if (!found.svg) return `${before}${tag}${lead}${element}${after}`;
	const open = found.tag.selfClosing
		? `${openedTag(text, found.tag)}>`
		: text.slice(found.tag.start, found.tag.end);
	return `${before}${tag}${lead}${open}${escapeText(trimmed)}</${found.tag.name}>${after}`;
};

/** The size a new drawing is given where nothing says otherwise: a 16:10 canvas. */
export const DEFAULT_DRAWING_SIZE: DrawingSize = { width: 1600, height: 1000 };

/** The kind of the one layer a new drawing starts with: something to draw on. */
const FIRST_LAYER_KIND: LayerKind = 'vector';

/**
 * A new, empty drawing: the root with its namespaces, id and canvas, a title
 * where one is given, and one empty vector layer, so the first stroke has a
 * layer to land on (docs/ARCHITECTURE.md §3, "The drawing file"). What the app
 * writes on "new drawing", and the shape every drawing it saves keeps.
 */
export const emptyDrawing = ({
	id,
	title,
	size = DEFAULT_DRAWING_SIZE,
}: {
	id: string;
	title?: string;
	size?: DrawingSize;
}): string => {
	if (!ID.test(id)) throw new RangeError(`a drawing's id is a UUID or the like, not ${id}`);
	if (!positive(size.width) || !positive(size.height)) {
		throw new RangeError('a drawing is wider and taller than nothing');
	}
	const titled =
		title === undefined || title.trim() === ''
			? ''
			: `\n  <title>${escapeText(title.trim())}</title>`;
	// After the title, as §3 shows it: the title is the root's first child, and
	// the layer the first thing that draws. Its kind is written, not left to be
	// inferred, so the file says what the app meant.
	const layer = `\n  <g id="${layerId(1)}" ${PREFERRED_PREFIX}:${LAYER_ATTRIBUTES.kind}="${FIRST_LAYER_KIND}"/>`;
	return [
		'<?xml version="1.0" encoding="UTF-8"?>',
		`<svg xmlns="${SVG_NAMESPACE}" xmlns:${PREFERRED_PREFIX}="${DRAWING_NAMESPACE}" ${PREFERRED_PREFIX}:id="${id}" viewBox="0 0 ${size.width} ${size.height}" width="${size.width}" height="${size.height}">${titled}${layer}`,
		'</svg>',
		'',
	].join('\n');
};
