import { cell } from '@skysa/storage';

import type { Point } from '../geometry.js';
import type { Anchor, PathData, Subpath } from './model.js';

/**
 * Any SVG path's `d` read into anchors (`model.ts`): every command, absolute
 * and relative, with implicit repeats, as SVG 2 defines them
 * (https://svgwg.org/svg2-draft/paths.html#PathData). Lines become cubics
 * with their handles on their anchors, quadratics are raised to cubics, which
 * is exact, and arcs are cut into cubics of a quarter turn or less, which is
 * finer than a screen shows. Data in error is read as far as the last command
 * that is whole, which is what a browser draws of it.
 */

/** One number as a path writes it: `10`, `-.5`, `1e-3`, and `-.5.5` as two. */
const NUMBER = String.raw`[+-]?(?:\d+\.?\d*|\.\d+)(?:[eE][+-]?\d+)?`;

const SEPARATOR = String.raw`[\s,]*`;

/** A command letter and everything up to the next: its parameters. */
const COMMAND = /([MLHVCSQTAZ])([^MLHVCSQTAZ]*)/gi;

/** A command's numbers, one after another, for as long as they run on. */
const NUMBERS = new RegExp(`${SEPARATOR}(${NUMBER})`, 'gy');

/**
 * An arc's seven parameters at a time. Its two flags are one character each
 * and may run into what follows, `a5 5 0 1010 10`, which a plain list of
 * numbers would read as `1010`.
 */
const ARC = new RegExp(
	[NUMBER, NUMBER, NUMBER, '[01]', '[01]', NUMBER, NUMBER]
		.map((part) => `${SEPARATOR}(${part})`)
		.join(''),
	'gy'
);

const ONLY_SEPARATORS = /^[\s,]*$/;

const ONLY_SPACE = /^\s*$/;

/** How many numbers each command takes at a time. */
const ARITY: Readonly<Record<string, number>> = {
	M: 2,
	L: 2,
	T: 2,
	H: 1,
	V: 1,
	S: 4,
	Q: 4,
	C: 6,
	A: 7,
	Z: 0,
};

/** One command with one set of parameters, an implicit repeat being a command of its own. */
type Op = Readonly<{ letter: string; relative: boolean; args: readonly number[] }>;

/** A command's ops, and whether it was whole: the reading stops after one that was not. */
type Parsed = Readonly<{ ops: readonly Op[]; whole: boolean }>;

const parseCommand = (letter: string, text: string): Parsed => {
	const upper = letter.toUpperCase();
	const relative = letter !== upper;
	if (upper === 'Z')
		return { ops: [{ letter: 'Z', relative, args: [] }], whole: ONLY_SEPARATORS.test(text) };
	const arity = ARITY[upper] ?? 1;
	const matches = [...text.matchAll(upper === 'A' ? ARC : NUMBERS)];
	const consumed = matches.reduce((total, match) => total + match[0].length, 0);
	const values = matches.flatMap((match) => match.slice(1).map(Number));
	const count = Math.floor(values.length / arity);
	const ops = Array.from({ length: count }, (_, group) => ({
		// The pairs after a moveto's first are linetos, relative where it was.
		letter: upper === 'M' && group > 0 ? 'L' : upper,
		relative,
		args: values.slice(group * arity, (group + 1) * arity),
	}));
	const whole =
		count > 0 && values.length % arity === 0 && ONLY_SEPARATORS.test(text.slice(consumed));
	return { ops, whole };
};

/** What the commands draw, in order, every point absolute. */
type Curve = Readonly<{ c1: Point; c2: Point; to: Point }>;

type Piece =
	| Readonly<{ kind: 'move'; to: Point }>
	| (Readonly<{ kind: 'curve' }> & Curve)
	| Readonly<{ kind: 'close' }>;

/**
 * Where the reading is: the current point, where the subpath began, the last
 * control point of a cubic or a quadratic for an `S` or a `T` to reflect, and
 * whether the subpath was just closed.
 */
type Cursor = Readonly<{
	point: Point;
	start: Point;
	cubic: Point | undefined;
	quad: Point | undefined;
	closed: boolean;
}>;

const ORIGIN: Point = { x: 0, y: 0 };

const START: Cursor = {
	point: ORIGIN,
	start: ORIGIN,
	cubic: undefined,
	quad: undefined,
	closed: false,
};

const pointOf = (args: readonly number[], at: number): Point => ({
	x: args[at] ?? 0,
	y: args[at + 1] ?? 0,
});

/** An op's numbers made absolute: relative ones are from the current point, and only coordinates move. */
const absolute = (op: Op, from: Point): readonly number[] => {
	if (!op.relative) return op.args;
	const [a = 0] = op.args;
	if (op.letter === 'H') return [a + from.x];
	if (op.letter === 'V') return [a + from.y];
	if (op.letter === 'A') {
		return op.args.map((value, i) => value + (i === 5 ? from.x : i === 6 ? from.y : 0));
	}
	return op.args.map((value, i) => value + (i % 2 === 0 ? from.x : from.y));
};

const lerp = (a: Point, b: Point, t: number): Point => ({
	x: a.x + (b.x - a.x) * t,
	y: a.y + (b.y - a.y) * t,
});

/** A control point turned about `about`; `about` itself where there was none to turn. */
const reflect = (control: Point | undefined, about: Point): Point =>
	control === undefined ? about : { x: 2 * about.x - control.x, y: 2 * about.y - control.y };

/** A line as a cubic: its handles on its ends, so it stays a line however its ends move. */
const lineTo = (from: Point, to: Point): Curve => ({ c1: from, c2: to, to });

/** Two points the same to well below anything drawn: a closed subpath that ends where it began. */
const coincide = (a: Point, b: Point): boolean =>
	Math.abs(a.x - b.x) < 1e-6 && Math.abs(a.y - b.y) < 1e-6;

/**
 * A quadratic raised to the cubic that draws it exactly; a line where its
 * control point is one of its ends, as a `T` with no quadratic before it has.
 */
const elevate = (from: Point, control: Point, to: Point): Curve =>
	coincide(control, from) || coincide(control, to)
		? lineTo(from, to)
		: { c1: lerp(from, control, 2 / 3), c2: lerp(to, control, 2 / 3), to };

const angleBetween = (u: Point, v: Point): number =>
	Math.atan2(u.x * v.y - u.y * v.x, u.x * v.x + u.y * v.y);

/**
 * An elliptical arc as cubics, by the conversion from endpoints to a center in
 * SVG's implementation notes
 * (https://www.w3.org/TR/SVG2/implnote.html#ArcConversionEndpointToCenter),
 * radii too small for the endpoints grown until they reach
 * (https://www.w3.org/TR/SVG2/implnote.html#ArcOutOfRangeParameters). Each
 * piece turns a quarter or less, its handles `4/3 · tan(θ/4)` of the radius
 * long, which is within a few parts in ten thousand of the true curve. Equal
 * endpoints draw nothing; a zero radius draws a line.
 */
export const arcToCubics = (
	from: Point,
	radii: Readonly<{ rx: number; ry: number }>,
	rotation: number,
	large: boolean,
	sweep: boolean,
	to: Point
): readonly Curve[] => {
	if (from.x === to.x && from.y === to.y) return [];
	const rx = Math.abs(radii.rx);
	const ry = Math.abs(radii.ry);
	if (rx === 0 || ry === 0) return [lineTo(from, to)];
	const phi = (rotation * Math.PI) / 180;
	const cos = Math.cos(phi);
	const sin = Math.sin(phi);
	const dx = (from.x - to.x) / 2;
	const dy = (from.y - to.y) / 2;
	const x1 = cos * dx + sin * dy;
	const y1 = -sin * dx + cos * dy;
	const lambda = (x1 * x1) / (rx * rx) + (y1 * y1) / (ry * ry);
	const grow = lambda > 1 ? Math.sqrt(lambda) : 1;
	const a = rx * grow;
	const b = ry * grow;
	const numerator = a * a * b * b - a * a * y1 * y1 - b * b * x1 * x1;
	const denominator = a * a * y1 * y1 + b * b * x1 * x1;
	const root = Math.sqrt(Math.max(0, numerator / denominator)) * (large === sweep ? -1 : 1);
	const cx1 = (root * a * y1) / b;
	const cy1 = (-root * b * x1) / a;
	const cx = cos * cx1 - sin * cy1 + (from.x + to.x) / 2;
	const cy = sin * cx1 + cos * cy1 + (from.y + to.y) / 2;
	const u = { x: (x1 - cx1) / a, y: (y1 - cy1) / b };
	const v = { x: (-x1 - cx1) / a, y: (-y1 - cy1) / b };
	const theta = angleBetween({ x: 1, y: 0 }, u);
	const turn = angleBetween(u, v);
	const delta =
		!sweep && turn > 0 ? turn - 2 * Math.PI : sweep && turn < 0 ? turn + 2 * Math.PI : turn;
	const count = Math.max(1, Math.ceil(Math.abs(delta) / (Math.PI / 2) - 1e-9));
	const step = delta / count;
	const k = (4 / 3) * Math.tan(step / 4);
	// A point of the unit circle onto the ellipse: scaled by the radii, turned, moved to the center.
	const place = (p: Point): Point => ({
		x: cx + cos * a * p.x - sin * b * p.y,
		y: cy + sin * a * p.x + cos * b * p.y,
	});
	return Array.from({ length: count }, (_, i) => {
		const start = theta + i * step;
		const end = start + step;
		return {
			c1: place({
				x: Math.cos(start) - k * Math.sin(start),
				y: Math.sin(start) + k * Math.cos(start),
			}),
			c2: place({
				x: Math.cos(end) + k * Math.sin(end),
				y: Math.sin(end) - k * Math.cos(end),
			}),
			// The last piece ends where the arc was told to, exactly, so the next command starts there.
			to: i === count - 1 ? to : place({ x: Math.cos(end), y: Math.sin(end) }),
		};
	});
};

type Drawn = Readonly<{ curves: readonly Curve[]; cubic?: Point; quad?: Point }>;

/** What one drawing command adds from `cursor`, with its numbers absolute. */
const drawn = (cursor: Cursor, letter: string, args: readonly number[]): Drawn => {
	const from = cursor.point;
	const [first = 0] = args;
	if (letter === 'H') return { curves: [lineTo(from, { x: first, y: from.y })] };
	if (letter === 'V') return { curves: [lineTo(from, { x: from.x, y: first })] };
	if (letter === 'C') {
		const c2 = pointOf(args, 2);
		return { curves: [{ c1: pointOf(args, 0), c2, to: pointOf(args, 4) }], cubic: c2 };
	}
	if (letter === 'S') {
		const c2 = pointOf(args, 0);
		return {
			curves: [{ c1: reflect(cursor.cubic, from), c2, to: pointOf(args, 2) }],
			cubic: c2,
		};
	}
	if (letter === 'Q') {
		const control = pointOf(args, 0);
		return { curves: [elevate(from, control, pointOf(args, 2))], quad: control };
	}
	if (letter === 'T') {
		const control = reflect(cursor.quad, from);
		return { curves: [elevate(from, control, pointOf(args, 0))], quad: control };
	}
	if (letter === 'A') {
		const [rx = 0, ry = 0, rotation = 0, large = 0, sweep = 0] = args;
		return {
			curves: arcToCubics(
				from,
				{ rx, ry },
				rotation,
				large !== 0,
				sweep !== 0,
				pointOf(args, 5)
			),
		};
	}
	return { curves: [lineTo(from, pointOf(args, 0))] };
};

type Step = Readonly<{ cursor: Cursor; pieces: readonly Piece[] }>;

const step = (cursor: Cursor, op: Op): Step => {
	if (op.letter === 'Z') {
		// A second close in a row closes nothing new.
		if (cursor.closed) return { cursor, pieces: [] };
		return {
			cursor: {
				...cursor,
				point: cursor.start,
				cubic: undefined,
				quad: undefined,
				closed: true,
			},
			pieces: [{ kind: 'close' }],
		};
	}
	const args = absolute(op, cursor.point);
	if (op.letter === 'M') {
		const to = pointOf(args, 0);
		return {
			cursor: { point: to, start: to, cubic: undefined, quad: undefined, closed: false },
			pieces: [{ kind: 'move', to }],
		};
	}
	const { curves, cubic, quad } = drawn(cursor, op.letter, args);
	// A command after a close starts a new subpath where the closed one began.
	const reopen: readonly Piece[] = cursor.closed ? [{ kind: 'move', to: cursor.start }] : [];
	return {
		cursor: {
			point: curves.at(-1)?.to ?? cursor.point,
			start: cursor.start,
			cubic,
			quad,
			closed: false,
		},
		pieces: [...reopen, ...curves.map((curve) => ({ kind: 'curve' as const, ...curve }))],
	};
};

/** The ops read in order, each from where the last left the pen. */
const piecesOf = (ops: readonly Op[]): readonly Piece[] => {
	const cursor = cell(START);
	return ops.flatMap((op) => {
		const next = step(cursor.current, op);
		cursor.current = next.cursor;
		return next.pieces;
	});
};

/**
 * A closed subpath whose last anchor is its first again, as `… L 0 0 Z` and
 * every circle are written: the two are one anchor, which comes in by the
 * last one's handle, so the close adds no segment of no length.
 */
const merged = (anchors: readonly Anchor[]): readonly Anchor[] => {
	const first = anchors[0];
	const last = anchors.at(-1);
	if (first === undefined || last === undefined || anchors.length < 2) return anchors;
	if (!coincide(first.point, last.point)) return anchors;
	return [{ ...first, in: last.in }, ...anchors.slice(1, -1)];
};

const isCurve = (piece: Piece): piece is Extract<Piece, { kind: 'curve' }> =>
	piece.kind === 'curve';

/** One run of pieces from a move: its anchors, each with the handles of the curves either side. */
const subpathOf = (run: readonly Piece[]): Subpath => {
	const [move] = run;
	if (move?.kind !== 'move') return { anchors: [], closed: false };
	const curves = run.filter(isCurve);
	const closed = run.some((piece) => piece.kind === 'close');
	const points = [move.to, ...curves.map((curve) => curve.to)];
	const anchors = points.map((point, i) => ({
		point,
		in: curves[i - 1]?.c2 ?? point,
		out: curves[i]?.c1 ?? point,
	}));
	return { anchors: closed ? merged(anchors) : anchors, closed };
};

/** A path's `d` as anchors; nothing for one that does not begin with a moveto, which draws nothing. */
export const parsePath = (d: string): PathData => {
	const commands = [...d.matchAll(COMMAND)];
	const [first] = commands;
	if (first === undefined || !ONLY_SPACE.test(d.slice(0, first.index))) return [];
	const parsed = commands.map((match) => parseCommand(match[1] ?? '', match[2] ?? ''));
	const broken = parsed.findIndex((command) => !command.whole);
	const ops = (broken < 0 ? parsed : parsed.slice(0, broken + 1)).flatMap(
		(command) => command.ops
	);
	if (ops[0]?.letter !== 'M') return [];
	const pieces = piecesOf(ops);
	const starts = pieces.flatMap((piece, i) => (piece.kind === 'move' ? [i] : []));
	return starts.map((at, k) => subpathOf(pieces.slice(at, starts[k + 1] ?? pieces.length)));
};
