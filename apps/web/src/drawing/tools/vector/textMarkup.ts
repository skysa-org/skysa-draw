import { SVG_NAMESPACE } from '@skysa/draw-core';

import { XML_NAMESPACE } from '../../document/namespaces.js';

/**
 * A `<text>`'s words as lines, both ways (docs/decisions/0004-the-interface.md):
 * what the text tool writes, and what it reads back to edit. It writes the
 * first line as the text's own words and each later line as a `<tspan>` at
 * the text's `x`, moved down by `dy`, with `xml:space="preserve"` so the
 * spaces typed are the spaces drawn. It reads that, and the other way a file
 * carries lines, a `<tspan>` placed at its own `x` and `y` as Inkscape writes
 * them. The words go in as text nodes, never as markup, so a `<` typed is a
 * `<` drawn.
 */

/** How far apart the lines are, in ems: the field's `line-height` and each line's `dy`. */
export const LINE_HEIGHT = 1.2;

/** Children of a `<text>` that are not its words, kept where they are when the words change. */
const NOT_WORDS = new Set(['title', 'desc', 'metadata']);

const NUMBER = /-?(?:\d+\.?\d*|\.\d+)(?:e[+-]?\d+)?/i;

/** The first number of an attribute, which may be a list (`x="10 20 30"`, one per character). */
export const firstNumber = (value: string | null): number | undefined => {
	const found = NUMBER.exec(value ?? '');
	return found === null ? undefined : Number(found[0]);
};

/** Two decimals, as the other tools write a coordinate, and never `-0`. */
export const rounded = (n: number): number => {
	const value = Math.round(n * 100) / 100;
	return value === 0 ? 0 : value;
};

/** A field's value as lines; the field gives `\n`, a pasted text may hold `\r\n`. */
export const linesOf = (value: string): readonly string[] => value.split(/\r\n|\r|\n/);

/** Nothing to draw: no line holds anything but spaces, which no one could see or click. */
export const isBlank = (lines: readonly string[]): boolean =>
	lines.every((line) => line.trim() === '');

/** The lines without the empty ones at the end, which draw nothing. */
const withoutTrailing = (lines: readonly string[]): readonly string[] => {
	const last = lines.findLastIndex((line) => line !== '');
	return lines.slice(0, last + 1);
};

const ems = (lines: number): string => `${rounded(lines * LINE_HEIGHT)}em`;

/**
 * The lines as the text's content, in place of the words it had; what is not
 * words (a `<title>`) stays first. Each later line that holds anything is one
 * `<tspan x dy>`, its `dy` one line height for each line it moves down. A
 * blank line is not a `<tspan>` of its own but the next one's extra line
 * height, since an empty `<tspan>` places no character and so moves nothing
 * (SVG 2, §11.8.1, https://www.w3.org/TR/SVG2/text.html#TSpanAttributes).
 */
export const fillText = (text: Element, lines: readonly string[]): void => {
	const owner = text.ownerDocument;
	const x = String(firstNumber(text.getAttribute('x')) ?? 0);
	const [first = '', ...rest] = withoutTrailing(lines);
	const placed = rest
		.map((line, index) => ({ line, index: index + 1 }))
		.filter(({ line }) => line !== '');
	const tspans = placed.map(({ line, index }, k) => {
		const tspan = owner.createElementNS(SVG_NAMESPACE, 'tspan');
		tspan.setAttribute('x', x);
		tspan.setAttribute('dy', ems(index - (placed[k - 1]?.index ?? 0)));
		tspan.append(owner.createTextNode(line));
		return tspan;
	});
	const kept = [...text.children].filter((child) => NOT_WORDS.has(child.localName));
	text.replaceChildren(
		...kept,
		...(first === '' ? [] : [owner.createTextNode(first)]),
		...tspans
	);
	text.setAttributeNS(XML_NAMESPACE, 'xml:space', 'preserve');
};

/** Whether the text keeps its spaces as typed: `xml:space="preserve"` on it or the nearest element above that says. */
const keepsSpaces = (element: Element | null): boolean => {
	if (element === null) return false;
	const space = element.getAttributeNS(XML_NAMESPACE, 'space');
	return space === null ? keepsSpaces(element.parentElement) : space === 'preserve';
};

/** SVG's default for the rest: line breaks dropped, tabs as spaces, runs of spaces as one, and none at either end. */
const collapsed = (line: string): string =>
	line
		.replace(/[\r\n]/g, '')
		.replace(/\t/g, ' ')
		.replace(/ {2,}/g, ' ')
		.trim();

/** A tspan's `dy` as lines: in ems over the line height, at least one. */
const linesMoved = (tspan: Element): number => {
	const match = /^\s*([\d.]+)em\s*$/.exec(tspan.getAttribute('dy') ?? '');
	const value = match === null ? Number.NaN : Number(match[1]);
	return Number.isFinite(value) && value > 0 ? Math.max(1, Math.round(value / LINE_HEIGHT)) : 1;
};

/**
 * How many lines a child of the text starts before its words. A `<tspan>`
 * with a `dy` moves down from the line before, even the first line, which is
 * then empty; one placed only by its own `x` or `y` starts a line, except
 * before any words, where it is the first. Anything else runs on in the line.
 */
const breaksBefore = (node: Element, started: boolean): number => {
	if (node.localName !== 'tspan') return 0;
	if (node.hasAttribute('dy')) return linesMoved(node);
	return started && (node.hasAttribute('x') || node.hasAttribute('y')) ? 1 : 0;
};

/** The lines with `breaks` new ones opened, and `words` at the end of the last. */
const appended = (lines: readonly string[], breaks: number, words: string): readonly string[] => {
	const opened = [...lines, ...Array.from({ length: breaks }, () => '')];
	return [...opened.slice(0, -1), `${opened.at(-1) ?? ''}${words}`];
};

/** The text's words as lines, for the field to start from. */
export const linesIn = (text: Element): readonly string[] => {
	const lines = [...text.childNodes].reduce<readonly string[]>(
		(so, node) => {
			if (node.nodeType === node.TEXT_NODE || node.nodeType === node.CDATA_SECTION_NODE) {
				return appended(so, 0, node.textContent ?? '');
			}
			if (!(node instanceof Element) || NOT_WORDS.has(node.localName)) return so;
			const started = so.some((line) => line.trim() !== '');
			return appended(so, breaksBefore(node, started), node.textContent);
		},
		['']
	);
	return withoutTrailing(keepsSpaces(text) ? lines : lines.map(collapsed));
};
