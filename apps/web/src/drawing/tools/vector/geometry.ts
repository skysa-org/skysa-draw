/**
 * The geometry the vector tools share (docs/ARCHITECTURE.md §7, "The editor"):
 * points, the path a freehand stroke becomes, the outline of a brush stroke,
 * the constraints a shape or a line keeps under Shift, and a 2D affine matrix
 * for `transform`. All of it is pure and knows no DOM, so it is tested as
 * arithmetic; jsdom has no `DOMMatrix` and no `getBBox`, and the editor needs
 * neither here. Numbers are written with two decimals, which is finer than a
 * screen pixel at any zoom the editor offers, and keeps a path short.
 */

export type Point = Readonly<{ x: number; y: number }>;

/** A point of a brush stroke, with the width of the stroke there. */
type WidePoint = Point & Readonly<{ w: number }>;

export type Box = Readonly<{ x: number; y: number; width: number; height: number }>;

/** `matrix(a b c d e f)`: x' = ax + cy + e, y' = bx + dy + f. */
export type Mat = Readonly<[number, number, number, number, number, number]>;

export const IDENTITY: Mat = [1, 0, 0, 1, 0, 0];

/** Two points closer than this are the same point. */
const EPSILON = 1e-9;

/** A number rounded to `decimals`, with `-0` made `0` so it never prints a sign. */
const roundTo = (n: number, decimals: number): number => {
	const factor = 10 ** decimals;
	const rounded = Math.round(n * factor) / factor;
	return rounded === 0 ? 0 : rounded;
};

/** A coordinate as a path writes it: two decimals, no trailing zeros. */
const fmt = (n: number): string => String(roundTo(n, 2));

const coords = (p: Point): string => `${fmt(p.x)} ${fmt(p.y)}`;

export const distance = (a: Point, b: Point): number => Math.hypot(b.x - a.x, b.y - a.y);

const same = (a: Point, b: Point): boolean => distance(a, b) < EPSILON;

/** Consecutive repeats of a point folded into one, so no tangent is ever zero. */
const distinct = <P extends Point>(points: readonly P[]): readonly P[] =>
	points.filter((p, i) => {
		const previous = points[i - 1];
		return previous === undefined || !same(previous, p);
	});

/** How far `p` lies from the line through `a` and `b`; from `a` when they coincide. */
const deviation = (p: Point, a: Point, b: Point): number => {
	const length = distance(a, b);
	if (length < EPSILON) return distance(p, a);
	return Math.abs((b.x - a.x) * (a.y - p.y) - (a.x - p.x) * (b.y - a.y)) / length;
};

/**
 * Ramer–Douglas–Peucker: the points that matter, keeping every one that
 * strays more than `epsilon` from the line between its neighbors that are
 * kept. The ends always stay, so a stroke keeps its reach however hard it is
 * simplified.
 */
export const simplify = (points: readonly Point[], epsilon: number): readonly Point[] => {
	const first = points[0];
	const last = points.at(-1);
	if (first === undefined || last === undefined || points.length < 3) return points;
	const farthest = points.reduce(
		(best, p, index) => {
			const d = deviation(p, first, last);
			return d > best.d ? { index, d } : best;
		},
		{ index: 0, d: 0 }
	);
	if (farthest.d <= epsilon) return [first, last];
	return [
		...simplify(points.slice(0, farthest.index + 1), epsilon),
		...simplify(points.slice(farthest.index), epsilon).slice(1),
	];
};

/**
 * How far a point may stray before the simplification keeps it, in user units:
 * nothing at 0, so every sample is kept; four units at 1, which is heavy for a
 * pencil of the default width. Squared so the middle of the slider is gentle.
 */
const epsilonFor = (smoothing: number): number => 4 * Math.min(1, Math.max(0, smoothing)) ** 2;

/** One cubic from `p1` to `p2`: a Catmull-Rom segment with its neighbors as the tangents. */
const cubic = (p0: Point, p1: Point, p2: Point, p3: Point): string => {
	const c1 = { x: p1.x + (p2.x - p0.x) / 6, y: p1.y + (p2.y - p0.y) / 6 };
	const c2 = { x: p2.x - (p3.x - p1.x) / 6, y: p2.y - (p3.y - p1.y) / 6 };
	return `C ${coords(c1)} ${coords(c2)} ${coords(p2)}`;
};

/**
 * The `d` of a freehand stroke: the points simplified by `smoothing` and a
 * Catmull-Rom spline through what is left, written as cubic Béziers, which is
 * what Figma and Illustrator do with a pencil. At 0 nothing is simplified and
 * the path is the samples joined by straight lines. One point is a dot, drawn
 * as a zero-length line so a round cap shows it.
 */
export const smoothPath = (points: readonly Point[], smoothing: number): string => {
	const kept = distinct(points);
	const first = kept[0];
	if (first === undefined) return '';
	if (kept.length === 1) return `M ${coords(first)} L ${coords(first)}`;
	const lines = (ps: readonly Point[]): string =>
		`M ${coords(first)} ${ps
			.slice(1)
			.map((p) => `L ${coords(p)}`)
			.join(' ')}`;
	if (smoothing <= 0) return lines(kept);
	const simple = simplify(kept, epsilonFor(smoothing));
	if (simple.length < 3) return lines(simple);
	const curves = simple.slice(1).map((p2, i) => {
		const p1 = simple[i] ?? p2;
		const p0 = simple[i - 1] ?? p1;
		const p3 = simple[i + 2] ?? p2;
		return cubic(p0, p1, p2, p3);
	});
	return `M ${coords(first)} ${curves.join(' ')}`;
};

/** The unit tangent at `index`, from its neighbors; at either end, from the one neighbor. */
const tangentAt = (points: readonly Point[], index: number): Point => {
	const before = points[index - 1] ?? points[index];
	const after = points[index + 1] ?? points[index];
	if (before === undefined || after === undefined) return { x: 1, y: 0 };
	const length = distance(before, after);
	if (length < EPSILON) return { x: 1, y: 0 };
	return { x: (after.x - before.x) / length, y: (after.y - before.y) / length };
};

/** How many points draw a semicircular cap. */
const CAP_STEPS = 8;

/**
 * The points of a half circle of `radius` about `center`, from `from` radians
 * through increasing angles, which is clockwise on a screen whose y runs down.
 */
const cap = (center: Point, radius: number, from: number): readonly Point[] =>
	Array.from({ length: CAP_STEPS - 1 }, (_, k) => {
		const angle = from + ((k + 1) * Math.PI) / CAP_STEPS;
		return { x: center.x + radius * Math.cos(angle), y: center.y + radius * Math.sin(angle) };
	});

const circlePath = (center: Point, radius: number): string => {
	const r = fmt(radius);
	return `M ${fmt(center.x + radius)} ${fmt(center.y)} A ${r} ${r} 0 1 1 ${fmt(center.x - radius)} ${fmt(center.y)} A ${r} ${r} 0 1 1 ${fmt(center.x + radius)} ${fmt(center.y)} Z`;
};

/**
 * The closed outline of a stroke whose width varies along it: each point
 * pushed out along the normal of its tangent by half its width, the left side
 * walked forward, the end capped with a half circle, the right side walked
 * back and the start capped, which is how a brush stroke is a filled path
 * (docs/decisions/0004-the-interface.md). One distinct point is a circle of its
 * width; two make a capsule, as the general case gives.
 */
export const strokeOutline = (points: readonly WidePoint[]): string => {
	const kept = distinct(points);
	const first = kept[0];
	if (first === undefined) return '';
	if (kept.length === 1) return circlePath(first, first.w / 2);
	const last = kept.at(-1) ?? first;
	const tangents = kept.map((_, i) => tangentAt(kept, i));
	// Left of the direction of travel, on a screen whose y runs down, is the tangent turned counterclockwise.
	const offset = (p: WidePoint, t: Point, side: 1 | -1): Point => ({
		x: p.x + (side * t.y * p.w) / 2,
		y: p.y - (side * t.x * p.w) / 2,
	});
	const left = kept.map((p, i) => offset(p, tangents[i] ?? { x: 1, y: 0 }, 1));
	const right = kept.map((p, i) => offset(p, tangents[i] ?? { x: 1, y: 0 }, -1)).reverse();
	const endTangent = tangents.at(-1) ?? { x: 1, y: 0 };
	const startTangent = tangents[0] ?? { x: 1, y: 0 };
	// From the left side around the front to the right, then from the right around the back to the left.
	const endCap = cap(last, last.w / 2, Math.atan2(endTangent.y, endTangent.x) - Math.PI / 2);
	const startCap = cap(
		first,
		first.w / 2,
		Math.atan2(startTangent.y, startTangent.x) + Math.PI / 2
	);
	const [head, ...rest] = [...left, ...endCap, ...right, ...startCap];
	if (head === undefined) return '';
	return `M ${coords(head)} ${rest.map((p) => `L ${coords(p)}`).join(' ')} Z`;
};

/** A brush's width at a sample: a quarter of its size at no pressure, all of it at full. */
export const pressureWidth = (size: number, pressure: number, usePressure: boolean): number =>
	usePressure ? size * (0.25 + 0.75 * pressure) : size;

/**
 * Whether a stroke's width follows its pressure: with the option on, and only
 * from a pen, as Photoshop reads pressure only from a tablet. A mouse says
 * 0.5 whatever it does and most fingers say nothing, which would paint every
 * stroke at a fraction of the size the brush's outline shows.
 */
export const followsPressure = (
	usePressure: boolean,
	pointerType: 'mouse' | 'pen' | 'touch'
): boolean => usePressure && pointerType === 'pen';

const signOf = (n: number): number => (n < 0 ? -1 : 1);

/** The far corner of a rectangle from `a`, made a square when constrained, by the longer side. */
export const constrainRect = (a: Point, b: Point, constrain: boolean): Point => {
	if (!constrain) return b;
	const side = Math.max(Math.abs(b.x - a.x), Math.abs(b.y - a.y));
	return { x: a.x + signOf(b.x - a.x) * side, y: a.y + signOf(b.y - a.y) * side };
};

/** The end of a line from `a`, snapped to the nearest multiple of 45° when constrained. */
export const constrainLine = (a: Point, b: Point, constrain: boolean): Point => {
	if (!constrain) return b;
	const length = distance(a, b);
	const step = Math.PI / 4;
	const angle = Math.round(Math.atan2(b.y - a.y, b.x - a.x) / step) * step;
	return { x: a.x + length * Math.cos(angle), y: a.y + length * Math.sin(angle) };
};

/** The rectangle with `a` and `b` as opposite corners, whichever way the drag went. */
export const rectFrom = (a: Point, b: Point): Box => ({
	x: Math.min(a.x, b.x),
	y: Math.min(a.y, b.y),
	width: Math.abs(b.x - a.x),
	height: Math.abs(b.y - a.y),
});

/** The smallest box holding every one given; none for none. */
export const unionBox = (boxes: readonly Box[]): Box | undefined => {
	const [first, ...rest] = boxes;
	if (first === undefined) return undefined;
	return rest.reduce((whole, box) => {
		const x = Math.min(whole.x, box.x);
		const y = Math.min(whole.y, box.y);
		return {
			x,
			y,
			width: Math.max(whole.x + whole.width, box.x + box.width) - x,
			height: Math.max(whole.y + whole.height, box.y + box.height) - y,
		};
	}, first);
};

/** Whether `p` is inside `box`, grown by `slop` on every side. */
export const boxContains = (box: Box, p: Point, slop = 0): boolean =>
	p.x >= box.x - slop &&
	p.x <= box.x + box.width + slop &&
	p.y >= box.y - slop &&
	p.y <= box.y + box.height + slop;

export const boxesIntersect = (a: Box, b: Box): boolean =>
	a.x <= b.x + b.width && b.x <= a.x + a.width && a.y <= b.y + b.height && b.y <= a.y + a.height;

/** `m` after `n`: the matrix that applies `n` first, as SVG reads `transform="m n"`. */
export const multiply = (m: Mat, n: Mat): Mat => {
	const [a1, b1, c1, d1, e1, f1] = m;
	const [a2, b2, c2, d2, e2, f2] = n;
	return [
		a1 * a2 + c1 * b2,
		b1 * a2 + d1 * b2,
		a1 * c2 + c1 * d2,
		b1 * c2 + d1 * d2,
		a1 * e2 + c1 * f2 + e1,
		b1 * e2 + d1 * f2 + f1,
	];
};

export const translate = (tx: number, ty: number): Mat => [1, 0, 0, 1, tx, ty];

/** A matrix applied about a point: moved there, applied, moved back. */
const about = (m: Mat, center: Point | undefined): Mat =>
	center === undefined
		? m
		: multiply(translate(center.x, center.y), multiply(m, translate(-center.x, -center.y)));

export const scale = (sx: number, sy: number, center?: Point): Mat =>
	about([sx, 0, 0, sy, 0, 0], center);

export const rotate = (degrees: number, center?: Point): Mat => {
	const radians = (degrees * Math.PI) / 180;
	const cos = Math.cos(radians);
	const sin = Math.sin(radians);
	return about([cos, sin, -sin, cos, 0, 0], center);
};

const skewX = (degrees: number): Mat => [1, 0, Math.tan((degrees * Math.PI) / 180), 1, 0, 0];

const skewY = (degrees: number): Mat => [1, Math.tan((degrees * Math.PI) / 180), 0, 1, 0, 0];

export const apply = (m: Mat, p: Point): Point => {
	const [a, b, c, d, e, f] = m;
	return { x: a * p.x + c * p.y + e, y: b * p.x + d * p.y + f };
};

/**
 * How much a matrix scales a length, as one factor: the square root of what
 * it scales an area by. Exact for a scale the same either way, turned or
 * not; for any other, the mean of the two.
 */
export const lengthScale = (m: Mat): number => Math.sqrt(Math.abs(m[0] * m[3] - m[1] * m[2]));

/** The inverse, where there is one; the identity for a matrix that flattens the plane. */
export const invert = (m: Mat): Mat => {
	const [a, b, c, d, e, f] = m;
	const det = a * d - b * c;
	if (Math.abs(det) < EPSILON) return IDENTITY;
	return [d / det, -b / det, -c / det, a / det, (c * f - d * e) / det, (b * e - a * f) / det];
};

/** The bounding box of `box` after `m`: its four corners transformed and boxed again. */
export const transformBox = (m: Mat, box: Box): Box => {
	const corners = [
		{ x: box.x, y: box.y },
		{ x: box.x + box.width, y: box.y },
		{ x: box.x, y: box.y + box.height },
		{ x: box.x + box.width, y: box.y + box.height },
	].map((corner) => apply(m, corner));
	const xs = corners.map((p) => p.x);
	const ys = corners.map((p) => p.y);
	const x = Math.min(...xs);
	const y = Math.min(...ys);
	return { x, y, width: Math.max(...xs) - x, height: Math.max(...ys) - y };
};

const TRANSFORM_FUNCTION = /([a-zA-Z]+)\s*\(([^)]*)\)/g;

const numbersIn = (text: string): readonly number[] =>
	text
		.trim()
		.split(/[\s,]+/)
		.filter((part) => part !== '')
		.map(Number);

/** One function of a `transform` list as a matrix; the identity for one that is not well formed. */
const transformFunction = (name: string, args: readonly number[]): Mat => {
	const [a = 0, b, c, d, e, f] = args;
	if (args.some((n) => !Number.isFinite(n))) return IDENTITY;
	if (name === 'matrix') {
		return b === undefined || c === undefined || d === undefined || e === undefined
			? IDENTITY
			: [a, b, c, d, e, f ?? 0];
	}
	if (name === 'translate') return translate(a, b ?? 0);
	if (name === 'scale') return scale(a, b ?? a);
	if (name === 'rotate') {
		return b === undefined || c === undefined ? rotate(a) : rotate(a, { x: b, y: c });
	}
	if (name === 'skewX') return skewX(a);
	if (name === 'skewY') return skewY(a);
	return IDENTITY;
};

/**
 * A `transform` attribute as one matrix: the functions in it, left to right,
 * each applied after the ones to its right as SVG defines the list.
 * https://svgwg.org/svg2-draft/coords.html#TransformProperty
 */
export const parseTransform = (attribute: string | null): Mat =>
	[...(attribute ?? '').matchAll(TRANSFORM_FUNCTION)].reduce<Mat>(
		(m, match) => multiply(m, transformFunction(match[1] ?? '', numbersIn(match[2] ?? ''))),
		IDENTITY
	);

const isIdentity = (m: Mat): boolean =>
	m.every((value, i) => Math.abs(value - (IDENTITY[i] ?? 0)) < 1e-9);

/** `matrix(a b c d e f)` to four decimals; the empty string for the identity, which is no attribute. */
export const formatTransform = (m: Mat): string =>
	isIdentity(m) ? '' : `matrix(${m.map((value) => String(roundTo(value, 4))).join(' ')})`;
