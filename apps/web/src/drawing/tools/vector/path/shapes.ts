import type { PathData } from './model.js';
import { parsePath } from './parse.js';

/**
 * The shapes as the paths they draw, so the node tool can edit a `<rect>`, an
 * `<ellipse>`, a `<circle>`, a `<line>`, a `<polyline>` or a `<polygon>` as it
 * does a `<path>`: it becomes one on its first edit, keeping every attribute
 * that is not its geometry (https://svgwg.org/svg2-draft/shapes.html). Read
 * through an element's `localName` and `getAttribute` alone, so this is as
 * pure as the rest of `path/`.
 */
type ElementLike = Readonly<{
	localName: string;
	getAttribute: (name: string) => string | null;
}>;

/** The attributes that place each shape, which its path's `d` says instead once it is one. */
export const GEOMETRY: Readonly<Record<string, readonly string[]>> = {
	rect: ['x', 'y', 'width', 'height', 'rx', 'ry'],
	circle: ['cx', 'cy', 'r'],
	ellipse: ['cx', 'cy', 'rx', 'ry'],
	line: ['x1', 'y1', 'x2', 'y2'],
	polyline: ['points'],
	polygon: ['points'],
};

/** Whether an element has points to edit: a path, or a shape that can become one. */
export const hasPoints = (localName: string): boolean =>
	localName === 'path' || Object.hasOwn(GEOMETRY, localName);

/** A plain number, or one in `px`, which is the same; the start of a list of coordinates. */
const LENGTH = /^\s*([+-]?(?:\d+\.?\d*|\.\d+)(?:[eE][+-]?\d+)?)(?:px)?\s*$/;

const COORDINATE = /[+-]?(?:\d+\.?\d*|\.\d+)(?:[eE][+-]?\d+)?/g;

/**
 * A length as a number; `auto` where none is given; nothing for a length in
 * a unit or a percentage, which needs the viewport to resolve, and which the
 * node tool leaves alone rather than guess.
 */
const lengthOf = (text: string | null): number | 'auto' | undefined => {
	const trimmed = text?.trim() ?? '';
	if (trimmed === '' || trimmed === 'auto') return 'auto';
	const match = LENGTH.exec(trimmed);
	return match?.[1] === undefined ? undefined : Number(match[1]);
};

type Read = ElementLike['getAttribute'];

/** Each named length as a number, `auto` as 0; nothing if any is in a unit. */
const lengths = (read: Read, names: readonly string[]): readonly number[] | undefined => {
	const values = names.map((name) => lengthOf(read(name)));
	if (values.some((value) => value === undefined)) return undefined;
	return values.map((value) => (typeof value === 'number' ? value : 0));
};

/** A radius as SVG 2 resolves it: its own, else the other's, else none; a negative one is `auto`. */
const radius = (own: number | 'auto', other: number | 'auto'): number => {
	if (own !== 'auto' && own >= 0) return own;
	return other !== 'auto' && other >= 0 ? other : 0;
};

/** Four quarter arcs from the right-hand point, clockwise on a screen whose y runs down. */
const ellipseText = (cx: number, cy: number, rx: number, ry: number): string | undefined => {
	if (rx <= 0 || ry <= 0) return undefined;
	const arc = `A ${rx} ${ry} 0 0 1`;
	return `M ${cx + rx} ${cy} ${arc} ${cx} ${cy + ry} ${arc} ${cx - rx} ${cy} ${arc} ${cx} ${cy - ry} ${arc} ${cx + rx} ${cy} Z`;
};

/**
 * A rectangle from its top left, clockwise; with rounded corners, each corner
 * a quarter of an ellipse and each side what is left between, a side the
 * corners use up whole left out rather than drawn as a line of no length.
 */
const rectText = (read: Read): string | undefined => {
	const box = lengths(read, ['x', 'y', 'width', 'height']);
	const rxGiven = lengthOf(read('rx'));
	const ryGiven = lengthOf(read('ry'));
	if (box === undefined || rxGiven === undefined || ryGiven === undefined) return undefined;
	const [x = 0, y = 0, width = 0, height = 0] = box;
	if (width <= 0 || height <= 0) return undefined;
	const rx = Math.min(radius(rxGiven, ryGiven), width / 2);
	const ry = Math.min(radius(ryGiven, rxGiven), height / 2);
	const right = x + width;
	const bottom = y + height;
	if (rx <= 0 || ry <= 0) return `M ${x} ${y} H ${right} V ${bottom} H ${x} Z`;
	const arc = `A ${rx} ${ry} 0 0 1`;
	const across = rx < width / 2;
	const down = ry < height / 2;
	return [
		`M ${x + rx} ${y}`,
		across ? `H ${right - rx}` : '',
		`${arc} ${right} ${y + ry}`,
		down ? `V ${bottom - ry}` : '',
		`${arc} ${right - rx} ${bottom}`,
		across ? `H ${x + rx}` : '',
		`${arc} ${x} ${bottom - ry}`,
		down ? `V ${y + ry}` : '',
		`${arc} ${x + rx} ${y}`,
		'Z',
	]
		.filter((part) => part !== '')
		.join(' ');
};

/** A polyline's or a polygon's `points`, in pairs; an odd one out at the end is dropped, as SVG does. */
const pointsText = (read: Read, closed: boolean): string | undefined => {
	const numbers = (read('points')?.match(COORDINATE) ?? []).map(Number);
	const pairs = Array.from(
		{ length: Math.floor(numbers.length / 2) },
		(_, i) => `${numbers[2 * i] ?? 0} ${numbers[2 * i + 1] ?? 0}`
	);
	const [first, ...rest] = pairs;
	if (first === undefined) return undefined;
	return [`M ${first}`, ...rest.map((pair) => `L ${pair}`), ...(closed ? ['Z'] : [])].join(' ');
};

const circleText = (read: Read): string | undefined => {
	const values = lengths(read, ['cx', 'cy', 'r']);
	if (values === undefined) return undefined;
	const [cx = 0, cy = 0, r = 0] = values;
	return ellipseText(cx, cy, r, r);
};

const ellipseOf = (read: Read): string | undefined => {
	const center = lengths(read, ['cx', 'cy']);
	const rxGiven = lengthOf(read('rx'));
	const ryGiven = lengthOf(read('ry'));
	if (center === undefined || rxGiven === undefined || ryGiven === undefined) return undefined;
	const [cx = 0, cy = 0] = center;
	return ellipseText(cx, cy, radius(rxGiven, ryGiven), radius(ryGiven, rxGiven));
};

const lineText = (read: Read): string | undefined => {
	const values = lengths(read, ['x1', 'y1', 'x2', 'y2']);
	if (values === undefined) return undefined;
	const [x1 = 0, y1 = 0, x2 = 0, y2 = 0] = values;
	return `M ${x1} ${y1} L ${x2} ${y2}`;
};

/** The `d` an element draws: a path's own, or a shape's as a path; none for anything else, or a shape that draws nothing. */
const pathTextOf = (element: ElementLike): string | undefined => {
	const read: Read = (name) => element.getAttribute(name);
	const name = element.localName;
	if (name === 'path') return read('d') ?? undefined;
	if (name === 'rect') return rectText(read);
	if (name === 'circle') return circleText(read);
	if (name === 'ellipse') return ellipseOf(read);
	if (name === 'line') return lineText(read);
	if (name === 'polyline' || name === 'polygon') return pointsText(read, name === 'polygon');
	return undefined;
};

/** An element's points, in its own units; none where it has none to edit. */
export const pathDataOf = (element: ElementLike): PathData | undefined => {
	const text = pathTextOf(element);
	const data = text === undefined ? [] : parsePath(text);
	return data.length === 0 ? undefined : data;
};
