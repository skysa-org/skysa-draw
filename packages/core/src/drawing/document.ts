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

/** Whitespace, as `\s` reads it: the byte-order mark is among it; and what is not. */
const SPACE = /\s/;
const NOT_SPACE = /\S/;

/**
 * Where a run of things from `from` ends, that `item` reads one after another
 * and answers just past each: where the next is none, or one that starts and
 * never ends. Every scan in this file is this loop.
 *
 * This file reads the prolog, the start tags and what lies between them with
 * `indexOf` rather than patterns, and in this loop rather than by recursion,
 * so that it is linear in the text however the text is written. Patterns for
 * them took seconds over a file another tool left half written (a doctype
 * never closed before a long run of spaces, a long run of spaces before no
 * title), or ran out of stack over millions of attributes; recursion would run
 * out of stack over thousands of comments.
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

/** Where a run from `from` of what `stop` does not match ends: `from` itself where there is none. */
const runEnd = (text: string, from: number, stop: RegExp): number =>
	skipped(text, from, (_, at) =>
		at < text.length && !stop.test(text.charAt(at)) ? at + 1 : undefined
	);

/** Where a run of whitespace from `from` ends. */
const spaceEnd = (text: string, from: number): number => runEnd(text, from, NOT_SPACE);

/** Just past the first `close` from `from`, or `undefined` where there is none. */
const closedBy = (text: string, close: string, from: number): number | undefined => {
	const at = text.indexOf(close, from);
	return at === -1 ? undefined : at + close.length;
};

/** Just past `mark`, whitespace and a `>` at `at`, where they are there. */
const markClosedAt = (text: string, mark: string, at: number): number | undefined => {
	if (at === -1 || !text.startsWith(mark, at)) return undefined;
	const after = spaceEnd(text, at + mark.length);
	return text.charAt(after) === '>' ? after + 1 : undefined;
};

/**
 * The first `mark` from `from` that nothing but whitespace separates from a
 * `>`, among the places `next` steps to from `first`: where it starts, and
 * just past the `>`. The whitespace after one `mark` ends before the next, so
 * each is read once. `next` answers -1, as `indexOf` does, where there is
 * nowhere more to look, or `undefined` where the search is to stop unanswered.
 */
const closingMark = (
	text: string,
	mark: string,
	first: number,
	next: (at: number) => number | undefined
): Readonly<{ at: number; end: number }> | undefined => {
	const at = skipped(text, first, (_, at) =>
		at === -1 || markClosedAt(text, mark, at) !== undefined ? undefined : next(at)
	);
	const end = markClosedAt(text, mark, at);
	return end === undefined ? undefined : { at, end };
};

/** The first `mark` from `from` that nothing but whitespace separates from a `>` (`closingMark`). */
const markThenClose = (
	text: string,
	mark: string,
	from: number
): Readonly<{ at: number; end: number }> | undefined =>
	closingMark(text, mark, text.indexOf(mark, from), (at) => text.indexOf(mark, at + 1));

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
 * Just past a comment or a processing instruction that starts at `at`, each
 * ending at its first close as XML's do. `undefined` where neither starts
 * there, or one never ends.
 */
const commentOrInstructionEnd = (text: string, at: number): number | undefined => {
	if (text.startsWith('<!--', at)) return closedBy(text, '-->', at + 4);
	if (text.startsWith('<?', at)) return closedBy(text, '?>', at + 2);
	return undefined;
};

/**
 * Just past whitespace, a comment or a processing instruction that starts at
 * `at`: what XML calls "Misc", which may come before the root, and between it
 * and its title. `undefined` where none starts there, or one never ends.
 */
const miscEnd = (text: string, at: number): number | undefined =>
	SPACE.test(text.charAt(at)) ? spaceEnd(text, at) : commentOrInstructionEnd(text, at);

/**
 * Just past what the prolog may hold that starts at `at`: whitespace, a
 * processing instruction or the XML declaration, a comment, or a doctype.
 * `undefined` where none starts there, or one starts and never ends.
 */
const prologItemEnd = (text: string, at: number): number | undefined =>
	text.startsWith('<!DOCTYPE', at) ? doctypeEnd(text, at + 9) : miscEnd(text, at);

/**
 * Where the prolog ends: everything XML allows before the root element, a BOM,
 * whitespace, the XML declaration and processing instructions, comments and a
 * document type declaration with or without an internal subset. Each ends at
 * the first close that fits, as XML's own do.
 */
const prologEnd = (text: string): number => skipped(text, 0, prologItemEnd);

/**
 * The run of things from `from` that `item` reads one after another, as
 * `skipped` reads it, and each of them.
 */
const readRun = <T extends Readonly<{ end: number }>>(
	text: string,
	from: number,
	item: (text: string, at: number) => T | undefined
): Readonly<{ items: readonly T[]; end: number }> => {
	const items: T[] = [];
	const end = skipped(text, from, (_, at) => {
		const next = item(text, at);
		// eslint-disable-next-line functional/immutable-data -- built here, and only read once returned
		if (next !== undefined && next.end > at) items.push(next);
		return next?.end;
	});
	return { items, end };
};

/** What a name cannot hold, and what a value without quotes cannot. */
const NOT_NAME = /[\s"'<>/=]/;
const NOT_BARE = /[\s"'=<>`]/;

interface Attribute {
	readonly name: string;
	readonly value: string;
	/** Where it begins and ends in the text, from its name to the end of its value. */
	readonly start: number;
	readonly end: number;
}

/**
 * The attribute after whitespace at `at`: its name, and `=` and a value where
 * they follow, with whitespace about the `=`. The value is in double or single
 * quotes, or bare up to whitespace or what else such a value cannot hold. A
 * bare value takes a slash before the tag's `>`, as HTML reads one, and as
 * the pattern this replaced did: XML has every value quoted, so the tag may
 * have been meant to close itself, and `firstTitle` does not read a title
 * that ends so (`endsInBareSlash`). `undefined` where there is no whitespace
 * there, or no attribute after it, or an `=` with no value.
 */
const spacedAttributeAt = (text: string, at: number): Attribute | undefined => {
	const start = spaceEnd(text, at);
	const nameEnd = runEnd(text, start, NOT_NAME);
	if (start === at || nameEnd === start) return undefined;
	const name = text.slice(start, nameEnd);
	const equals = spaceEnd(text, nameEnd);
	if (text.charAt(equals) !== '=') return { name, value: '', start, end: nameEnd };
	const from = spaceEnd(text, equals + 1);
	const quote = text.charAt(from);
	if (quote === '"' || quote === "'") {
		const close = text.indexOf(quote, from + 1);
		return close === -1
			? undefined
			: { name, value: text.slice(from + 1, close), start, end: close + 1 };
	}
	const end = runEnd(text, from, NOT_BARE);
	return end === from ? undefined : { name, value: text.slice(from, end), start, end };
};

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

/**
 * The start tag at `start` of an element named `localName`, with one prefix
 * or none, as XML's namespaces allow: its name, attributes each after
 * whitespace (`spacedAttributeAt`), and `>` or `/>` with any whitespace
 * before it. `undefined` where there is another element there, or something
 * else. Scanned in a loop, as the prolog is: a pattern for it ran out of
 * stack over a great many attributes.
 */
const startTagAt = (text: string, start: number, localName: string): StartTag | undefined => {
	if (text.charAt(start) !== '<') return undefined;
	const nameEnd = runEnd(text, start + 1, NOT_NAME);
	const name = text.slice(start + 1, nameEnd);
	const colon = name.indexOf(':');
	if (colon === 0 || name.slice(colon + 1) !== localName) return undefined;
	const { items, end: attributesEnd } = readRun(text, nameEnd, spacedAttributeAt);
	const close = spaceEnd(text, attributesEnd);
	const selfClosing = text.startsWith('/>', close);
	if (!selfClosing && text.charAt(close) !== '>') return undefined;
	return {
		start,
		end: close + (selfClosing ? 2 : 1),
		attributesEnd,
		name,
		prefix: colon === -1 ? undefined : name.slice(0, colon),
		attributeList: items,
		attributes: new Map(items.map(({ name, value }) => [name, value])),
		selfClosing,
	};
};

/**
 * Whether a tag that does not close itself ends in a bare value's slash and
 * its `>`, as `height=10/>` does: one its author may have meant to close
 * itself, or one whose value ends in a slash.
 */
const endsInBareSlash = (text: string, tag: StartTag): boolean =>
	!tag.selfClosing && text.charAt(tag.end - 2) === '/';

/**
 * The root's start tag, where the prolog is followed by an `svg`, with or
 * without a prefix. A bare value that runs into its `/>` keeps the slash, so
 * the root is open, as it always was read here; the rewrites read it so too.
 */
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

/** The prefixes the root binds to `DRAWING_NAMESPACE`, in order. */
const drawingPrefixes = (root: StartTag): readonly string[] =>
	[...root.attributes]
		.filter(([name, value]) => name.startsWith('xmlns:') && value === DRAWING_NAMESPACE)
		.map(([name]) => name.slice('xmlns:'.length));

/** The last attribute named `name`, which is the one read where there are two. */
const lastNamed = (root: StartTag, name: string): Attribute | undefined =>
	root.attributeList.filter((attribute) => attribute.name === name).at(-1);

/**
 * The attribute that holds the drawing's id: the last `id` under any prefix
 * the root binds to `DRAWING_NAMESPACE`, as the last of a name is the one read.
 */
const idAttribute = (root: StartTag): Attribute | undefined => {
	const names = new Set(drawingPrefixes(root).map((prefix) => `${prefix}:id`));
	return root.attributeList.filter(({ name }) => names.has(name)).at(-1);
};

/** A drawing's id, or `undefined` for a file with none, or one this app cannot use. */
export const readDrawingId = (text: string): string | undefined => {
	const root = rootTagOf(text);
	if (root === undefined || !isSvgRoot(root)) return undefined;
	const id = idAttribute(root)?.value;
	return id !== undefined && ID.test(id) ? id : undefined;
};

/** A prefix not bound on the root: `draw`, or `draw2`, `draw3`, … where it is taken. */
const freePrefix = (root: StartTag): string => {
	const taken = [...root.attributes.keys()].filter((name) =>
		name.startsWith(`xmlns:${PREFERRED_PREFIX}`)
	);
	// One of as many as are taken, and one more, is free.
	return (
		Array.from({ length: taken.length + 1 }, (_, i) =>
			i === 0 ? PREFERRED_PREFIX : `${PREFERRED_PREFIX}${i + 1}`
		).find((candidate) => !root.attributes.has(`xmlns:${candidate}`)) ?? PREFERRED_PREFIX
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
	const prefixes = drawingPrefixes(root);
	const prefix = prefixes[0] ?? freePrefix(root);
	const declaration = prefixes.length === 0 ? `xmlns:${prefix}="${DRAWING_NAMESPACE}" ` : '';
	// In place where the file has the attribute, under its own prefix, so a
	// file given its id once is the same bytes given it again: the one read
	// (`idAttribute`), or one under the prefix about to be declared. Found
	// among the attributes, so the same characters in another attribute's
	// value are not taken for it. At the end of the tag otherwise.
	const existing = prefixes.length === 0 ? lastNamed(root, `${prefix}:id`) : idAttribute(root);
	return existing === undefined
		? `${text.slice(0, root.start)}${openedTag(text, root)} ${declaration}${prefix}:id="${id}"${root.selfClosing ? '/>' : '>'}${text.slice(root.end)}`
		: `${text.slice(0, existing.start)}${declaration}${existing.name}="${id}"${text.slice(existing.end)}`;
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
 * Where a title's text ends, from `from`, and just past its end tag: the first
 * `</name` that nothing but whitespace separates from a `>`, past whatever
 * comments, CDATA sections and processing instructions the text holds, which
 * may hold one. `undefined` where none closes it.
 */
const titleEnd = (
	text: string,
	name: string,
	from: number
): Readonly<{ at: number; end: number }> | undefined => {
	// Past what starts at a `<`: one character, or a section that never ends.
	const sectionEnd = (at: number): number | undefined =>
		text.startsWith('<!--', at)
			? closedBy(text, '-->', at + 4)
			: text.startsWith('<![CDATA[', at)
				? closedBy(text, ']]>', at + 9)
				: text.startsWith('<?', at)
					? closedBy(text, '?>', at + 2)
					: at + 1;
	return closingMark(text, `</${name}`, text.indexOf('<', from), (at) => {
		const after = sectionEnd(at);
		return after === undefined ? undefined : text.indexOf('<', after);
	});
};

/**
 * The first `<title>` after the root tag, which is where SVG puts a document's
 * name and where this app writes it: past whatever whitespace, comments and
 * processing instructions lead to it (`miscEnd`). Its start tag is read as the
 * root's is, so a `>` in a quoted value does not end it, and one that closes
 * itself is an empty title.
 *
 * Where it could end in two places, it is not read, and a rename puts a new
 * title ahead of it and takes nothing away: one whose last value is bare and
 * runs into `/>` (`endsInBareSlash`) may close itself or not; and where a
 * comment, CDATA section or processing instruction in it holds its first
 * `</title>`, or starts before it and never closes, XML ends it elsewhere
 * (`titleEnd`), and a tool that knows none of them there.
 *
 * SVG's title, under whatever prefix binds SVG; or a `title` with no prefix
 * in no namespace, as this app's 0.1.0 wrote one under an `svg:svg` root, and
 * which `withDrawingTitle` writes as SVG's. `undefined` where the root's first
 * child is something else, or the title never closes.
 */
const firstTitle = (text: string, root: StartTag): TitleElement | undefined => {
	const tag = startTagAt(text, skipped(text, root.end, miscEnd), 'title');
	if (tag === undefined || endsInBareSlash(text, tag)) return undefined;
	const namespace = namespaceOf(tag, root);
	const svg = namespace === SVG_NAMESPACE;
	if (!svg && (tag.prefix !== undefined || namespace !== '')) return undefined;
	if (tag.selfClosing) return { tag, svg, end: tag.end, close: tag.end };
	const end = titleEnd(text, tag.name, tag.end);
	if (end === undefined || end.end !== markThenClose(text, `</${tag.name}`, tag.end)?.end) {
		return undefined;
	}
	return { tag, svg, end: end.at, close: end.end };
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

/**
 * What XML 1.0 has no place for in text: the control characters but tab, line
 * feed and carriage return, U+FFFE and U+FFFF, and a surrogate with no
 * partner. A title holding one would leave a file no XML parser reads.
 */
// eslint-disable-next-line no-control-regex
const NOT_XML = /[\u0000-\u0008\u000b\u000c\u000e-\u001f\ufffe\uffff]|\p{Surrogate}/gu;

/**
 * A title as it is written: without what XML has no place for, and trimmed.
 * What the store keeps for a drawing's title too, so the row and the file
 * agree, and a title of nothing else is a blank one.
 */
export const cleanDrawingTitle = (title: string): string => title.replace(NOT_XML, '').trim();

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
	const trimmed = cleanDrawingTitle(title);
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
	// The title keeps its attributes, so an `id` the root's `aria-labelledby`
	// names still names it. SVG's keeps its start tag as it is, opened where it
	// closed itself. One in no namespace has SVG's made its default, in place of
	// its own `xmlns` where it has one: no prefix changes, so neither does what
	// any of its attributes means.
	if (!found.svg) {
		const declared =
			root.attributes.get('xmlns') === SVG_NAMESPACE ? '' : ` xmlns="${SVG_NAMESPACE}"`;
		const kept = found.tag.attributeList
			.filter((attribute) => attribute.name !== 'xmlns')
			.map((attribute) => ` ${text.slice(attribute.start, attribute.end)}`)
			.join('');
		return `${before}${tag}${lead}<title${declared}${kept}>${escapeText(trimmed)}</title>${after}`;
	}
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
		title === undefined || cleanDrawingTitle(title) === ''
			? ''
			: `\n  <title>${escapeText(cleanDrawingTitle(title))}</title>`;
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
