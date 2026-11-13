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
 * none. A loop, as `prologEnd` is.
 */
const spaceEnd = (text: string, from: number): number => {
	// eslint-disable-next-line functional/no-let -- see `prologEnd`
	let at = from;
	// eslint-disable-next-line functional/no-loop-statements -- see `prologEnd`
	while (at < text.length && SPACE.test(text.charAt(at))) at += 1;
	return at;
};

/** Just past the first `close` from `from`, or `undefined` where there is none. */
const closedBy = (text: string, close: string, from: number): number | undefined => {
	const at = text.indexOf(close, from);
	return at === -1 ? undefined : at + close.length;
};

/**
 * Just past a doctype's internal subset and its `>`, from inside its `[`: the
 * first `]` that nothing but whitespace separates from a `>`, so that a `]` in
 * a quoted value inside it does not end it.
 */
const subsetEnd = (text: string, from: number): number | undefined => {
	// eslint-disable-next-line functional/no-let -- see `prologEnd`
	let close = text.indexOf(']', from);
	// eslint-disable-next-line functional/no-loop-statements -- see `prologEnd`
	while (close !== -1) {
		const after = spaceEnd(text, close + 1);
		if (text.charAt(after) === '>') return after + 1;
		close = text.indexOf(']', close + 1);
	}
	return undefined;
};

/** Just past a doctype, from after its `<!DOCTYPE`: its `>`, or its subset's. */
const doctypeEnd = (text: string, from: number): number | undefined => {
	const close = text.indexOf('>', from);
	const open = text.indexOf('[', from);
	if (open === -1 || (close !== -1 && close < open)) {
		return close === -1 ? undefined : close + 1;
	}
	return subsetEnd(text, open + 1);
};

/**
 * Just past what the prolog may hold that starts at `at`: whitespace, a
 * processing instruction or the XML declaration, a comment, or a doctype.
 * `undefined` where none starts there, or one starts and never ends.
 */
const itemEnd = (text: string, at: number): number | undefined => {
	if (SPACE.test(text.charAt(at))) return spaceEnd(text, at);
	if (text.startsWith('<?', at)) return closedBy(text, '?>', at + 2);
	if (text.startsWith('<!--', at)) return closedBy(text, '-->', at + 4);
	if (text.startsWith('<!DOCTYPE', at)) return doctypeEnd(text, at + 9);
	return undefined;
};

/**
 * Where the prolog ends: everything XML allows before the root element, a BOM,
 * whitespace, the XML declaration and processing instructions, comments and a
 * document type declaration with or without an internal subset. Each ends at
 * the first close that fits, as XML's own do.
 *
 * Read with `indexOf` rather than a pattern, and in a loop rather than by
 * recursion, so it is linear in the text however it is written: a pattern for
 * this had a doctype never closed, before a long run of spaces, take seconds,
 * and a file another tool left half written is enough to make one. A prolog
 * of thousands of comments would run recursion out of stack.
 */
const prologEnd = (text: string): number => {
	// eslint-disable-next-line functional/no-let -- see above: linear, and no stack to run out of
	let at = 0;
	// eslint-disable-next-line functional/no-loop-statements -- see above
	for (;;) {
		const next = itemEnd(text, at);
		if (next === undefined || next <= at) return at;
		at = next;
	}
};

/** An attribute: a name, and a value in double quotes, single quotes or bare. */
const ATTRIBUTE = /([^\s"'<>/=]+)(?:\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s"'=<>`]+)))?/g;

/** The root's start tag, `svg` with or without a prefix, attributes and all. */
const ROOT_TAG =
	/^<((?:[^\s"'<>/=:]+:)?svg)((?:\s+[^\s"'<>/=]+(?:\s*=\s*(?:"[^"]*"|'[^']*'|[^\s"'=<>`]+))?)*)\s*(\/?)>/;

interface RootTag {
	/** Where the tag begins and ends in the text, so it can be put back. */
	readonly start: number;
	readonly end: number;
	/** The element's prefix, where it has one: `svg:svg` is `svg`. */
	readonly prefix: string | undefined;
	readonly attributes: ReadonlyMap<string, string>;
	readonly selfClosing: boolean;
}

const attributesOf = (body: string): ReadonlyMap<string, string> =>
	new Map(
		[...body.matchAll(ATTRIBUTE)].map((match) => [
			match[1] ?? '',
			match[2] ?? match[3] ?? match[4] ?? '',
		])
	);

const rootTagOf = (text: string): RootTag | undefined => {
	const start = prologEnd(text);
	const match = ROOT_TAG.exec(text.slice(start));
	if (match === null) return undefined;
	const [tag, name = '', body = '', slash = ''] = match;
	const colon = name.indexOf(':');
	return {
		start,
		end: start + tag.length,
		prefix: colon === -1 ? undefined : name.slice(0, colon),
		attributes: attributesOf(body),
		selfClosing: slash === '/',
	};
};

/** The root is an `svg` element in the SVG namespace, however it is declared. */
const isSvgRoot = (root: RootTag): boolean =>
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
const drawingPrefix = (root: RootTag): string | undefined =>
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

const escapeRegExp = (text: string): string => text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

/** A prefix not bound on the root: `draw`, or `draw2`, `draw3`, … where it is taken. */
const freePrefix = (root: RootTag, n = 1): string => {
	const candidate = n === 1 ? PREFERRED_PREFIX : `${PREFERRED_PREFIX}${n}`;
	return root.attributes.has(`xmlns:${candidate}`) ? freePrefix(root, n + 1) : candidate;
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
	const declaration = bound === undefined ? ` xmlns:${prefix}="${DRAWING_NAMESPACE}"` : '';
	const tag = text.slice(root.start, root.end);
	const existing = new RegExp(
		`(\\s${escapeRegExp(prefix)}:id\\s*=\\s*)(?:"[^"]*"|'[^']*'|[^\\s"'=<>\`]+)`
	);
	// In place where the file has the attribute, so a file given its id once
	// is the same bytes given it again; at the end of the tag otherwise.
	const rewritten = existing.test(tag)
		? tag.replace(existing, `$1"${id}"`)
		: tag.replace(/\s*(\/?)>$/, `${declaration} ${prefix}:id="${id}"$1>`);
	return `${text.slice(0, root.start)}${rewritten}${text.slice(root.end)}`;
};

export interface DrawingSize {
	readonly width: number;
	readonly height: number;
}

const positive = (value: number): boolean => Number.isFinite(value) && value > 0;

/** A length in user units: a number, with or without `px`. Anything else is not. */
const userUnits = (value: string | undefined): number | undefined => {
	const match = /^\s*([+]?(?:\d+\.?\d*|\.\d+)(?:e[+-]?\d+)?)\s*(?:px)?\s*$/i.exec(value ?? '');
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
 * The drawing's title: the text of the first `<title>` element directly after
 * the root tag, which is where SVG puts a document's name and where this app
 * writes it. `undefined` where there is none, or it is empty; the app then
 * names the drawing by its file (`titleFromFilename`).
 */
export const readDrawingTitle = (text: string): string | undefined => {
	const root = rootTagOf(text);
	if (root === undefined || !isSvgRoot(root) || root.selfClosing) return undefined;
	const match = /^(?:\s+|<!--[\s\S]*?-->)*<title(?:\s[^>]*)?>([\s\S]*?)<\/title\s*>/.exec(
		text.slice(root.end)
	);
	const title = match?.[1] === undefined ? '' : decodeReferences(match[1]).trim();
	return title === '' ? undefined : title;
};

/** The first `<title>` after the root tag, with whatever whitespace and comments lead to it. */
const FIRST_TITLE = /^((?:\s+|<!--[\s\S]*?-->)*)<title(?:\s[^>]*)?>[\s\S]*?<\/title\s*>/;

const escapeText = (text: string): string =>
	text.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');

/**
 * The same text with `title` as the drawing's title: the first `<title>` after
 * the root tag replaced, or one put there where the file has none. An empty
 * title takes the element away, and the drawing goes by its file's name again.
 * A `RangeError` for text that is not a drawing.
 */
export const withDrawingTitle = (text: string, title: string): string => {
	const root = rootTagOf(text);
	if (root === undefined || !isSvgRoot(root)) throw new RangeError('not an SVG document');
	const trimmed = title.trim();
	const element = trimmed === '' ? '' : `<title>${escapeText(trimmed)}</title>`;
	const before = text.slice(0, root.start);
	const tag = text.slice(root.start, root.end);
	if (root.selfClosing) {
		if (element === '') return text;
		const name = root.prefix === undefined ? 'svg' : `${root.prefix}:svg`;
		const opened = tag.replace(/\s*\/>$/, '>');
		return `${before}${opened}${element}</${name}>${text.slice(root.end)}`;
	}
	const after = text.slice(root.end);
	const found = FIRST_TITLE.exec(after);
	if (found !== null) {
		const [whole, lead = ''] = found;
		const kept = element === '' ? lead.replace(/\s+$/, '') : `${lead}${element}`;
		return `${before}${tag}${kept}${after.slice(whole.length)}`;
	}
	return element === '' ? text : `${before}${tag}\n  ${element}${after}`;
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
