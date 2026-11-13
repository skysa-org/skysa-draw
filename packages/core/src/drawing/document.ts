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
 * the first `<title>` after it for the name. What is written changes only what
 * it is about: `withDrawingId` adds or replaces the id on the root tag, and
 * the namespace's declaration where it has none, and `withDrawingTitle` the
 * title's text, so a file another tool made keeps every other byte of its
 * own, but the whitespace before the `>` of a tag added to or opened. A title
 * a rename makes SVG's, and a root `withDrawingViewport` sizes for an export,
 * have their start tag written again, each attribute after one space.
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
/** What XML does not count as whitespace, as `\s` does a no-break space. */
const NOT_XML_SPACE = /[^ \t\r\n]/;
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

/**
 * Where a run from `from` of what `stop` does not match ends: `from` itself
 * where there is none. One search, not a test of each character: `stop`
 * matches a single character, so it has nothing to backtrack over.
 */
const runEnd = (text: string, from: number, stop: RegExp): number => {
	const at = text.slice(from).search(stop);
	return at === -1 ? Math.max(from, text.length) : from + at;
};

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
 * `>`: where it starts, and just past the `>`. The whitespace after one `mark`
 * ends before the next, so each is read once.
 */
const markThenClose = (
	text: string,
	mark: string,
	from: number
): Readonly<{ at: number; end: number }> | undefined => {
	const at = skipped(text, text.indexOf(mark, from), (_, at) =>
		at === -1 || markClosedAt(text, mark, at) !== undefined
			? undefined
			: text.indexOf(mark, at + 1)
	);
	const end = markClosedAt(text, mark, at);
	return end === undefined ? undefined : { at, end };
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
 * `skipped` reads it, and each of them: no more than `most`, where it stops.
 */
const readRun = <T extends Readonly<{ end: number }>>(
	text: string,
	from: number,
	item: (text: string, at: number) => T | undefined,
	most: number
): Readonly<{ items: readonly T[]; end: number }> => {
	const items: T[] = [];
	const end = skipped(text, from, (_, at) => {
		if (items.length >= most) return undefined;
		const next = item(text, at);
		// eslint-disable-next-line functional/immutable-data -- built here, and only read once returned
		if (next !== undefined && next.end > at) items.push(next);
		return next?.end;
	});
	return { items, end };
};

/**
 * The most attributes a root this reads may have, but the app's own
 * (`appAttributes`), and a title, but its `xmlns`: more, and it is not read.
 * Those are not counted, so that what this app writes to one it reads, an id
 * or SVG's namespace on a title, is read again. Each one read is kept, as a
 * few numbers, so memory grows with them, and without a bound a root of
 * millions ran a tab out of memory. The root's pattern this replaced ran out
 * of stack before a million that had values, so no root it read that XML
 * reads is refused: only one of more than a million without values, which no
 * XML parser reads. Its title's pattern had no such limit, so a title of more
 * than a million that it read is not read now, as any title this cannot read.
 */
const MOST_ATTRIBUTES = 1_000_000;

/** What a name cannot hold, and what a value without quotes cannot. */
const NOT_NAME = /[\s"'<>/=]/;
/**
 * What HTML reads an end tag's name as starting with after `</`: anything else
 * there starts what it reads as a comment, to the next `>`.
 */
const ASCII_LETTER = /[A-Za-z]/;
/**
 * What a name can start with, as XML has it (`NameStartChar`): after a `<`,
 * what starts a tag, not text. A character past the BMP is read by the first
 * half of its surrogate pair.
 */
const NAME_START =
	/[:A-Z_a-z\u00c0-\u00d6\u00d8-\u00f6\u00f8-\u02ff\u0370-\u037d\u037f-\u1fff\u200c-\u200d\u2070-\u218f\u2c00-\u2fef\u3001-\ud7ff\ud800-\udb7f\uf900-\ufdcf\ufdf0-\ufffd]/;
const NOT_BARE = /[\s"'=<>`]/;

/**
 * An attribute where it is in the text: from its name to the end of its value,
 * where its name ends, and where its value begins and ends, inside its quotes.
 * Places, not strings, so a tag of a great many holds a few numbers for each.
 */
interface Attribute {
	readonly start: number;
	readonly end: number;
	readonly nameEnd: number;
	readonly valueStart: number;
	readonly valueEnd: number;
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
	const equals = spaceEnd(text, nameEnd);
	if (text.charAt(equals) !== '=') {
		return { start, end: nameEnd, nameEnd, valueStart: nameEnd, valueEnd: nameEnd };
	}
	const from = spaceEnd(text, equals + 1);
	const quote = text.charAt(from);
	if (quote === '"' || quote === "'") {
		const close = text.indexOf(quote, from + 1);
		return close === -1
			? undefined
			: { start, end: close + 1, nameEnd, valueStart: from + 1, valueEnd: close };
	}
	const end = runEnd(text, from, NOT_BARE);
	return end === from ? undefined : { start, end, nameEnd, valueStart: from, valueEnd: end };
};

/**
 * Just past where a tag whose attributes end at `attributesEnd` closes, with
 * `>` or `/>` and any whitespace before it, and which; `undefined` where
 * neither follows.
 */
const tagClose = (
	text: string,
	attributesEnd: number
): Readonly<{ end: number; selfClosing: boolean }> | undefined => {
	const close = spaceEnd(text, attributesEnd);
	if (text.startsWith('/>', close)) return { end: close + 2, selfClosing: true };
	return text.charAt(close) === '>' ? { end: close + 1, selfClosing: false } : undefined;
};

interface StartTag {
	/** The text it is in, which its attributes' places are in. */
	readonly text: string;
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
	/** Each attribute where it is, in order. */
	readonly attributeList: readonly Attribute[];
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
const startTagAt = (
	text: string,
	start: number,
	localName: string,
	most: number
): StartTag | undefined => {
	if (text.charAt(start) !== '<') return undefined;
	const nameEnd = runEnd(text, start + 1, NOT_NAME);
	const name = text.slice(start + 1, nameEnd);
	const colon = name.indexOf(':');
	if (colon === 0 || name.slice(colon + 1) !== localName) return undefined;
	const { items, end: attributesEnd } = readRun(text, nameEnd, spacedAttributeAt, most);
	const close = tagClose(text, attributesEnd);
	if (close === undefined) return undefined;
	return {
		text,
		start,
		end: close.end,
		attributesEnd,
		name,
		prefix: colon === -1 ? undefined : name.slice(0, colon),
		attributeList: items,
		selfClosing: close.selfClosing,
	};
};

/** An attribute's name, and its value without its quotes. */
const nameOf = (tag: StartTag, attribute: Attribute): string =>
	tag.text.slice(attribute.start, attribute.nameEnd);
const valueOf = (tag: StartTag, attribute: Attribute): string =>
	tag.text.slice(attribute.valueStart, attribute.valueEnd);

/** Whether an attribute is named `name`, read where it is rather than sliced out. */
const isNamed = (tag: StartTag, attribute: Attribute, name: string): boolean =>
	attribute.nameEnd - attribute.start === name.length &&
	tag.text.startsWith(name, attribute.start);

/** The last of a tag's attributes named `name`: the one read where it is there twice. */
const lastNamed = (tag: StartTag, name: string): Attribute | undefined =>
	tag.attributeList.filter((attribute) => isNamed(tag, attribute, name)).at(-1);

/** The value of a tag's attribute named `name`, the last where it is there twice. */
const valueNamed = (tag: StartTag, name: string): string | undefined => {
	const attribute = lastNamed(tag, name);
	return attribute === undefined ? undefined : valueOf(tag, attribute);
};

/** A tag's attributes as the text has them, each after one space, but those `dropped` names. */
const attributesText = (tag: StartTag, dropped: ReadonlySet<string>): string =>
	tag.attributeList
		.filter((attribute) => !dropped.has(nameOf(tag, attribute)))
		.map((attribute) => ` ${tag.text.slice(attribute.start, attribute.end)}`)
		.join('');

/**
 * Whether a tag that does not close itself ends in a bare value's slash and
 * its `>`, as `height=10/>` does: one its author may have meant to close
 * itself, or one whose value ends in a slash.
 */
const endsInBareSlash = (tag: StartTag): boolean =>
	!tag.selfClosing && tag.text.charAt(tag.end - 2) === '/';

/**
 * Each prefix the root binds, and the namespace it binds it to, in order: one
 * declared twice where it was first, with the last one's namespace.
 */
const prefixBindings = (root: StartTag): readonly (readonly [string, string])[] => [
	...new Map(
		root.attributeList
			.filter((attribute) => root.text.startsWith('xmlns:', attribute.start))
			.map((attribute) => [
				root.text.slice(attribute.start + 'xmlns:'.length, attribute.nameEnd),
				valueOf(root, attribute),
			])
	),
];

/** The prefixes the root binds to `DRAWING_NAMESPACE`, in order. */
const drawingPrefixes = (root: StartTag): readonly string[] =>
	prefixBindings(root)
		.filter(([, namespace]) => namespace === DRAWING_NAMESPACE)
		.map(([prefix]) => prefix);

/**
 * How many of the root's attributes are the app's own: the first prefix bound
 * to its namespace, and that prefix's `id`, which are what `withDrawingId`
 * adds. Neither counts against `MOST_ATTRIBUTES`, so a root given an id is
 * read as it was before, however many it has.
 */
const appAttributes = (root: StartTag): number => {
	const [prefix] = drawingPrefixes(root);
	if (prefix === undefined) return 0;
	return lastNamed(root, `${prefix}:id`) === undefined ? 1 : 2;
};

/**
 * The root's start tag, where the prolog is followed by an `svg`, with or
 * without a prefix, and its attributes but the app's own are no more than
 * `MOST_ATTRIBUTES`. A bare value that runs into its `/>` keeps the slash, so
 * the root is open, as it always was read here; the rewrites read it so too.
 */
const rootTagOf = (text: string): StartTag | undefined => {
	const root = startTagAt(text, prologEnd(text), 'svg', MOST_ATTRIBUTES + 2);
	if (root === undefined) return undefined;
	// The app's own are looked for only past the bound, so a root within it is
	// not walked again.
	const count = root.attributeList.length;
	return count > MOST_ATTRIBUTES && count - appAttributes(root) > MOST_ATTRIBUTES
		? undefined
		: root;
};

/**
 * A start tag opened up to its last attribute, without the whitespace and the
 * `>` or `/>` after it: where an attribute is added, or a tag that closes
 * itself is opened.
 */
const openedTag = (tag: StartTag): string => tag.text.slice(tag.start, tag.attributesEnd);

/**
 * `head`, a start tag up to its attributes, closed with `>`: after a space
 * where its last value is bare and ends in a slash, so the slash stays the
 * value's, and the tag is not one that might close itself (`endsInBareSlash`).
 */
const closedTag = (head: string): string => `${head}${head.endsWith('/') ? ' ' : ''}>`;

/** The root is an `svg` element in the SVG namespace, however it is declared. */
const isSvgRoot = (root: StartTag): boolean =>
	valueNamed(root, root.prefix === undefined ? 'xmlns' : `xmlns:${root.prefix}`) ===
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

/**
 * A drawing's id, or `undefined` for a file with none, or one this app cannot
 * use: the `id` under the first prefix the root binds to `DRAWING_NAMESPACE`,
 * as this file has always read it, so the id a file is known by never changes.
 */
export const readDrawingId = (text: string): string | undefined => {
	const root = rootTagOf(text);
	if (root === undefined || !isSvgRoot(root)) return undefined;
	const [prefix] = drawingPrefixes(root);
	const id = prefix === undefined ? undefined : valueNamed(root, `${prefix}:id`);
	return id !== undefined && ID.test(id) ? id : undefined;
};

/**
 * The prefix to bind the app's namespace to on a root that binds it to none:
 * `draw`, or `draw2`, `draw3`, …, the first that `bound`, the prefixes the
 * root binds already, does not hold. Of one more candidate than it holds, one
 * is free; looked for among them, not by a recursion, so however many are
 * bound it does not run out of stack. The editor's too (`drawingPrefixOf`),
 * so both choose the same one.
 */
export const freeDrawingPrefixAmong = (bound: ReadonlySet<string>): string => {
	const numbered = (n: number): string =>
		n === 1 ? PREFERRED_PREFIX : `${PREFERRED_PREFIX}${n}`;
	const candidates = Array.from({ length: bound.size + 1 }, (_, index) => numbered(index + 1));
	// One of them is free, so what follows `??` never runs: it is there for the type.
	return candidates.find((candidate) => !bound.has(candidate)) ?? numbered(bound.size + 1);
};

const freePrefix = (root: StartTag): string =>
	freeDrawingPrefixAmong(new Set(prefixBindings(root).map(([prefix]) => prefix)));

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
	// In place of the one read (`readDrawingId`), or one under the prefix about
	// to be declared, so a file given its id once is the same bytes given it
	// again, and one that has it already keeps its bytes. Where there is none,
	// in place of the last under another prefix bound to the namespace, which
	// is not read, and never was: beside it, the new one would be a second
	// attribute of the same expanded name, which XML's namespaces refuse.
	// Found among the attributes, so the same characters in another
	// attribute's value are not taken for it. At the end of the tag otherwise.
	const read = lastNamed(root, `${prefix}:id`);
	if (declaration === '' && read !== undefined && valueOf(root, read) === id) return text;
	const others = new Set(prefixes.slice(1).map((other) => `${other}:id`));
	const existing =
		read ??
		root.attributeList
			.filter(
				(attribute) =>
					text.startsWith(':id', attribute.nameEnd - 3) &&
					others.has(nameOf(root, attribute))
			)
			.at(-1);
	return existing === undefined
		? `${text.slice(0, root.start)}${openedTag(root)} ${declaration}${prefix}:id="${id}"${root.selfClosing ? '/>' : '>'}${text.slice(root.end)}`
		: `${text.slice(0, existing.start)}${declaration}${prefix}:id="${id}"${text.slice(existing.end)}`;
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
	const box = (valueNamed(root, 'viewBox') ?? '')
		.trim()
		.split(/[\s,]+/)
		.map(Number);
	const [, , boxWidth, boxHeight] = box;
	if (box.length === 4 && boxWidth !== undefined && boxHeight !== undefined) {
		return positive(boxWidth) && positive(boxHeight)
			? { width: boxWidth, height: boxHeight }
			: undefined;
	}
	const width = userUnits(valueNamed(root, 'width'));
	const height = userUnits(valueNamed(root, 'height'));
	return width !== undefined && height !== undefined && positive(width) && positive(height)
		? { width, height }
		: undefined;
};

/** The root's attributes `withDrawingViewport` sets, and so takes away first. */
const VIEWPORT: ReadonlySet<string> = new Set(['viewBox', 'width', 'height']);

/**
 * The same text with its root's `viewBox` set to `box`, and its `width` and
 * `height` to `size`, in place of any it has, its other attributes and every
 * byte outside the root tag as they were: how a render asks for the size it
 * wants (the web app's export). `undefined` for text that is not an SVG document.
 */
export const withDrawingViewport = (
	text: string,
	box: Readonly<{ x: number; y: number; width: number; height: number }>,
	size: DrawingSize
): string | undefined => {
	const root = rootTagOf(text);
	if (root === undefined || !isSvgRoot(root)) return undefined;
	const kept = attributesText(root, VIEWPORT);
	const viewport = `viewBox="${box.x} ${box.y} ${box.width} ${box.height}" width="${size.width}" height="${size.height}"`;
	return `${text.slice(0, root.start)}<${root.name}${kept} ${viewport}${root.selfClosing ? '/' : ''}>${text.slice(root.end)}`;
};

/**
 * The five references XML predefines, and numeric ones, as the characters
 * they name. One to half of a surrogate pair names none, and is left out:
 * decoded, two would make one character of what XML reads as neither.
 */
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
		if (code >= 0xd800 && code <= 0xdfff) return '';
		return code > 0 && code <= 0x10ffff ? String.fromCodePoint(code) : whole;
	});

/**
 * The namespace a start tag's name is in: its prefix's, or the default where
 * it has none, as the tag itself or the root binds it. `''` where neither
 * binds it, or `xmlns=""` takes the default away: no namespace.
 */
const namespaceOf = (tag: StartTag, root: StartTag): string => {
	const binding = tag.prefix === undefined ? 'xmlns' : `xmlns:${tag.prefix}`;
	return valueNamed(tag, binding) ?? valueNamed(root, binding) ?? '';
};

/**
 * Whether SVG is the root's default namespace, so that a `title` with no
 * prefix is SVG's.
 */
const svgIsDefault = (root: StartTag): boolean => valueNamed(root, 'xmlns') === SVG_NAMESPACE;

/**
 * The name this app writes a title under: `title` where SVG is the root's
 * default namespace, and under the root's own prefix where it is not, so the
 * title is SVG's in a file whose root is `svg:svg`.
 */
const titleName = (root: StartTag): string =>
	root.prefix === undefined || svgIsDefault(root) ? 'title' : `${root.prefix}:title`;

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
 * The elements whose content HTML reads as text, markup and all, up to an end
 * tag of their own name, `title` among them. HTML opens one at its start tag
 * whether or not a slash comes before its `>`, where XML reads `<textarea/>`
 * as empty.
 */
const RAW_TEXT: ReadonlySet<string> = new Set([
	'iframe',
	'noembed',
	'noframes',
	'noscript',
	'plaintext',
	'script',
	'style',
	'textarea',
	'title',
	'xmp',
]);

/** A tag's name as HTML compares one: its ASCII letters in lower case, and nothing else changed. */
const htmlName = (name: string): string =>
	name.replace(/[A-Z]+/g, (letters) => letters.toLowerCase());

/**
 * Whether a title named `name` that opens before `from` ends at `until`, where
 * its first `</name>` starts, as XML reads it: whether no comment, CDATA
 * section, processing instruction or tag in its text, start or end, holds that
 * end tag, as a quoted value can, or starts before it and never closes; no
 * comment or instruction ends where HTML ends it and XML does not, as
 * `<?a > b?>` and `<!-- a --!>`; no tag of its own name opens in it, in any
 * case, closing itself or not, nor one of an element HTML reads as text
 * (`RAW_TEXT`): the end tag would be that one's, to XML or to HTML, or text to
 * HTML; and no end tag of its name comes first that HTML ends it at and XML
 * does not, as `</TITLE>`, or `</title x>`, which a `>` does not close.
 * A `<` before a name that starts no tag a `>` closes is one a tool could read
 * either way, so it is not passed either. Walked from `<` to `<`, each tag
 * once, no further than `until`.
 */
const endsAt = (text: string, name: string, from: number, until: number): boolean => {
	const own = htmlName(name);
	// Just past a tag whose name ends at `nameEnd`, its attributes passed over
	// rather than kept, as `startTagAt` keeps them. An end tag's are read too,
	// as HTML reads them, so a quoted value in one holds what it holds.
	const tagEnd = (nameEnd: number): number | undefined => {
		const attributesEnd = skipped(
			text,
			nameEnd,
			(_, next) => spacedAttributeAt(text, next)?.end
		);
		return tagClose(text, attributesEnd)?.end;
	};
	// Just past a start tag at `at`; one character where no name starts.
	const startTagEnd = (at: number): number | undefined => {
		if (!NAME_START.test(text.charAt(at + 1))) return at + 1;
		const nameEnd = runEnd(text, at + 1, NOT_NAME);
		const tagName = htmlName(text.slice(at + 1, nameEnd));
		return tagName === own || RAW_TEXT.has(tagName) ? undefined : tagEnd(nameEnd);
	};
	// Just past a comment or an instruction at `at`, where XML and HTML end it
	// at once. HTML ends an instruction at its first `>`, and a comment at the
	// first `--!>` as well as `-->`, or at once as `<!-->` and `<!--->`. Each
	// looks no further than XML's end, so a run of them costs their length.
	const sectionEnd = (at: number): number | undefined => {
		const end = commentOrInstructionEnd(text, at);
		if (end === undefined) return undefined;
		const endsEarlier = text.startsWith('<!--', at)
			? text.startsWith('>', at + 4) ||
				text.startsWith('->', at + 4) ||
				text.slice(at + 4, end).includes('--!>')
			: text.slice(at + 2, end - 1).includes('>');
		return endsEarlier ? undefined : end;
	};
	// Past what starts at a `<`: a section or a tag; `undefined` where it does
	// not end, or is an end tag of the title's name in any case before `until`,
	// or is a `<!`, or a `</` before anything but an ASCII letter, which an
	// HTML parser reads as a comment to the next `>`, and XML as no markup, or
	// an end tag that no start tag in the title opened.
	const past = (at: number): number | undefined => {
		const ownEnd =
			htmlName(text.slice(at, at + name.length + 2)) === `</${own}` &&
			NOT_NAME.test(text.charAt(at + name.length + 2));
		if (ownEnd) return undefined;
		if (text.startsWith('<![CDATA[', at)) return closedBy(text, ']]>', at + 9);
		if (text.startsWith('<!--', at) || text.startsWith('<?', at)) return sectionEnd(at);
		if (text.startsWith('<!', at)) return undefined;
		if (!text.startsWith('</', at)) return startTagEnd(at);
		return ASCII_LETTER.test(text.charAt(at + 2))
			? tagEnd(runEnd(text, at + 2, NOT_NAME))
			: undefined;
	};
	const reached = skipped(text, text.indexOf('<', from), (_, at) => {
		if (at === -1 || at >= until) return undefined;
		const after = past(at);
		return after === undefined || after > until ? undefined : text.indexOf('<', after);
	});
	return reached === until;
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
 * comment, CDATA section, processing instruction or tag's quoted value in it
 * holds its first `</title>`, or starts before it and never closes, XML ends
 * it elsewhere (`endsAt`), and a tool that knows none of them there; and where
 * a comment or instruction in it ends earlier to HTML than to XML, as
 * `<?a > b?>`, what follows may hold it to one and not the other. So does
 * one that holds a tag of its own name in any case, or of one whose text HTML
 * reads as text, as `<textarea>`, or an end tag of its name that XML does not
 * end it at, as `</TITLE>` or `</title x>`, which HTML does.
 *
 * SVG's title, under whatever prefix binds SVG; or a `title` with no prefix
 * in no namespace, as this app's 0.1.0 wrote one under an `svg:svg` root, and
 * which `withDrawingTitle` writes as SVG's. `undefined` where the root's first
 * child is something else, or the title never closes.
 */
const firstTitle = (text: string, root: StartTag): TitleElement | undefined => {
	const tag = startTagAt(text, skipped(text, root.end, miscEnd), 'title', MOST_ATTRIBUTES + 1);
	if (tag === undefined || endsInBareSlash(tag)) return undefined;
	const declarations = tag.attributeList.filter((attribute) =>
		isNamed(tag, attribute, 'xmlns')
	).length;
	if (tag.attributeList.length - declarations > MOST_ATTRIBUTES) return undefined;
	const namespace = namespaceOf(tag, root);
	const svg = namespace === SVG_NAMESPACE;
	if (!svg && (tag.prefix !== undefined || namespace !== '')) return undefined;
	if (tag.selfClosing) return { tag, svg, end: tag.end, close: tag.end };
	const end = markThenClose(text, `</${tag.name}`, tag.end);
	if (end === undefined || !endsAt(text, tag.name, tag.end, end.at)) return undefined;
	// Only XML's whitespace before its `>`: with another space there, as a
	// no-break one, an HTML parser reads an end tag of another name.
	if (NOT_XML_SPACE.test(text.slice(end.at + tag.name.length + 2, end.end - 1))) return undefined;
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
		found === undefined
			? ''
			: cleanDrawingTitle(decodeReferences(text.slice(found.tag.end, found.end)));
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

/** The attribute a rename replaces on a title it makes SVG's. */
const DEFAULT_NAMESPACE: ReadonlySet<string> = new Set(['xmlns']);

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
		return `${before}${closedTag(openedTag(root))}${element}</${root.name}>${text.slice(root.end)}`;
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
	// its own `xmlns` where it has one: no prefix of an attribute changes, so
	// neither does what it means. So does one under a prefix where SVG is the
	// root's default, so that it is named `title`, as the editor keeps it.
	const svgDefault = svgIsDefault(root);
	if (!found.svg || (found.tag.prefix !== undefined && svgDefault)) {
		const declared = svgDefault ? '' : ` xmlns="${SVG_NAMESPACE}"`;
		const kept = attributesText(found.tag, DEFAULT_NAMESPACE);
		return `${before}${tag}${lead}${closedTag(`<title${declared}${kept}`)}${escapeText(trimmed)}</title>${after}`;
	}
	const open = found.tag.selfClosing
		? closedTag(openedTag(found.tag))
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
	const cleaned = title === undefined ? '' : cleanDrawingTitle(title);
	const titled = cleaned === '' ? '' : `\n  <title>${escapeText(cleaned)}</title>`;
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
