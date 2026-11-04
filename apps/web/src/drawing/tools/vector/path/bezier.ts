import { distance, type Point } from '../geometry.js';
import type { Cubic } from './model.js';

/** One cubic Bézier, measured: a point at `t`, its halves either side, the point nearest another. */

const lerp = (a: Point, b: Point, t: number): Point => ({
	x: a.x + (b.x - a.x) * t,
	y: a.y + (b.y - a.y) * t,
});

export const pointAt = (c: Cubic, t: number): Point => {
	const [p0, p1, p2, p3] = c;
	const u = 1 - t;
	const w0 = u * u * u;
	const w1 = 3 * u * u * t;
	const w2 = 3 * u * t * t;
	const w3 = t * t * t;
	return {
		x: w0 * p0.x + w1 * p1.x + w2 * p2.x + w3 * p3.x,
		y: w0 * p0.y + w1 * p1.y + w2 * p2.y + w3 * p3.y,
	};
};

/** De Casteljau's construction at `t`: the two cubics either side of it, which draw the same curve. */
export const splitCubic = (c: Cubic, t: number): readonly [Cubic, Cubic] => {
	const [p0, p1, p2, p3] = c;
	const a = lerp(p0, p1, t);
	const b = lerp(p1, p2, t);
	const e = lerp(p2, p3, t);
	const ab = lerp(a, b, t);
	const be = lerp(b, e, t);
	const at = lerp(ab, be, t);
	return [
		[p0, a, ab, at],
		[at, be, e, p3],
	];
};

export type Nearest = Readonly<{ t: number; point: Point; distance: number }>;

/** Samples along the curve the nearest is first looked for among. */
const SAMPLES = 24;

/** Thirds taken off the span round the nearest sample: two-thirds to the sixteenth is a ten-thousandth of `t`. */
const NARROWINGS = 16;

/**
 * The point of the curve nearest `p`: the nearest of evenly spaced samples,
 * then the span either side of it narrowed by thirds, the distance falling to
 * the nearest point there and rising from it.
 */
export const nearestOnCubic = (c: Cubic, p: Point): Nearest => {
	const at = (t: number): Nearest => {
		const point = pointAt(c, t);
		return { t, point, distance: distance(point, p) };
	};
	const coarse = Array.from({ length: SAMPLES + 1 }, (_, i) => at(i / SAMPLES)).reduce(
		(best, each) => (each.distance < best.distance ? each : best)
	);
	const span = Array.from({ length: NARROWINGS }).reduce<Readonly<{ lo: number; hi: number }>>(
		({ lo, hi }) => {
			const a = lo + (hi - lo) / 3;
			const b = hi - (hi - lo) / 3;
			return at(a).distance < at(b).distance ? { lo, hi: b } : { lo: a, hi };
		},
		{ lo: Math.max(0, coarse.t - 1 / SAMPLES), hi: Math.min(1, coarse.t + 1 / SAMPLES) }
	);
	const fine = at((span.lo + span.hi) / 2);
	return fine.distance < coarse.distance ? fine : coarse;
};

/** Straight pieces per cubic, for an inside test: plenty for a click. */
const FLATTEN_STEPS = 16;

/** The curve as a polyline, its start included. */
export const flatten = (c: Cubic): readonly Point[] =>
	Array.from({ length: FLATTEN_STEPS + 1 }, (_, i) => pointAt(c, i / FLATTEN_STEPS));
