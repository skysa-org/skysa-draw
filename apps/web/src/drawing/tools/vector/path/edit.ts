import { distance, type Point } from '../geometry.js';
import { pointAt, splitCubic } from './bezier.js';
import {
	type Anchor,
	type AnchorRef,
	corner,
	type HandleRef,
	isLine,
	nextIndex,
	opposite,
	type PathData,
	sameRef,
	segmentOf,
	type SegmentRef,
	type Side,
	updateAnchor,
} from './model.js';

/**
 * What the node tool and the pen do to a path's points
 * (docs/decisions/0004-the-interface.md), each a new path with the change and
 * the rest as it was.
 */

const EPSILON = 1e-9;

/** How far from a straight line the two handles of a smooth point may lean: about two degrees. */
const SMOOTH_SINE = 0.035;

/** How much the two handles of a symmetric point may differ in length, as a fraction of the longer. */
const SYMMETRY = 0.01;

const plus = (p: Point, d: Point): Point => ({ x: p.x + d.x, y: p.y + d.y });

/** `p` turned half a turn about `about`: the other handle of a mirrored pair. */
export const mirror = (about: Point, p: Point): Point => ({
	x: 2 * about.x - p.x,
	y: 2 * about.y - p.y,
});

const withHandle = (anchor: Anchor, side: Side, p: Point): Anchor =>
	side === 'in' ? { ...anchor, in: p } : { ...anchor, out: p };

/** The chosen anchors moved by `delta`, each with its handles, so the curves either side keep their shape. */
export const moveAnchors = (data: PathData, refs: readonly AnchorRef[], delta: Point): PathData =>
	data.map((subpath, s) => ({
		...subpath,
		anchors: subpath.anchors.map((anchor, index) =>
			refs.some((ref) => sameRef(ref, { subpath: s, index }))
				? {
						point: plus(anchor.point, delta),
						in: plus(anchor.in, delta),
						out: plus(anchor.out, delta),
					}
				: anchor
		),
	}));

/** Whether an anchor's handles lie on one line through it, either side: a smooth point, as against a corner. */
export const isSmooth = (anchor: Anchor): boolean => {
	const away = { x: anchor.out.x - anchor.point.x, y: anchor.out.y - anchor.point.y };
	const toward = { x: anchor.point.x - anchor.in.x, y: anchor.point.y - anchor.in.y };
	const lengths = Math.hypot(away.x, away.y) * Math.hypot(toward.x, toward.y);
	if (lengths < EPSILON) return false;
	const cross = (away.x * toward.y - away.y * toward.x) / lengths;
	const dot = (away.x * toward.x + away.y * toward.y) / lengths;
	return dot > 0 && Math.abs(cross) < SMOOTH_SINE;
};

const isSymmetric = (anchor: Anchor): boolean => {
	const a = distance(anchor.point, anchor.in);
	const b = distance(anchor.point, anchor.out);
	return Math.abs(a - b) <= SYMMETRY * Math.max(a, b);
};

/**
 * One handle moved to `to`. Kept smooth, the other handle turns to stay
 * opposite it, keeping its own length, or the same length where the two were
 * equal, so a point the pen made symmetric stays so: Figma's "mirror angle"
 * and "mirror angle and length", told apart by the point itself.
 */
export const moveHandle = (
	data: PathData,
	handle: HandleRef,
	to: Point,
	keepSmooth: boolean
): PathData =>
	updateAnchor(data, handle, (anchor) => {
		const moved = withHandle(anchor, handle.side, to);
		const away = { x: anchor.point.x - to.x, y: anchor.point.y - to.y };
		const length = Math.hypot(away.x, away.y);
		if (!keepSmooth || length < EPSILON) return moved;
		const other = opposite(handle.side);
		const reach = isSymmetric(anchor) ? length : distance(anchor.point, anchor[other]);
		return withHandle(moved, other, {
			x: anchor.point.x + (away.x / length) * reach,
			y: anchor.point.y + (away.y / length) * reach,
		});
	});

/** An anchor made smooth by pulling: its `out` handle at `to`, its `in` mirrored. */
export const pullHandles = (data: PathData, ref: AnchorRef, to: Point): PathData =>
	updateAnchor(data, ref, (anchor) => ({
		point: anchor.point,
		in: mirror(anchor.point, to),
		out: to,
	}));

/**
 * A point put into a segment at `t`, which keeps the curve as it was: a
 * corner on a straight segment, and on a curved one the cubic split in two by
 * de Casteljau, the new anchor smooth between the halves and the handles
 * either side shortened to fit. Says where the new anchor is.
 */
export const insertPoint = (
	data: PathData,
	at: SegmentRef,
	t: number
): Readonly<{ data: PathData; ref: AnchorRef }> | undefined => {
	const subpath = data[at.subpath];
	const c = subpath === undefined ? undefined : segmentOf(subpath, at.segment);
	const end = subpath === undefined ? undefined : nextIndex(subpath, at.segment);
	if (subpath === undefined || c === undefined || end === undefined) return undefined;
	const index = at.segment + 1;
	const ref = { subpath: at.subpath, index };
	const [left, right] = splitCubic(c, t);
	const straight = isLine(c);
	const reshaped = straight
		? subpath.anchors
		: subpath.anchors
				.map((anchor, i) => (i === at.segment ? { ...anchor, out: left[1] } : anchor))
				.map((anchor, i) => (i === end ? { ...anchor, in: right[2] } : anchor));
	const added: Anchor = straight
		? corner(pointAt(c, t))
		: { point: left[3], in: left[2], out: right[1] };
	const anchors = [...reshaped.slice(0, index), added, ...reshaped.slice(index)];
	return {
		data: data.map((each, s) => (s === at.subpath ? { ...each, anchors } : each)),
		ref,
	};
};

/**
 * An anchor taken out, its neighbors joined by the handles they had. A
 * subpath left with fewer than two anchors draws nothing and goes too.
 */
export const removeAnchor = (data: PathData, ref: AnchorRef): PathData =>
	data.flatMap((subpath, s) => {
		if (s !== ref.subpath) return [subpath];
		const anchors = subpath.anchors.filter((_, index) => index !== ref.index);
		return anchors.length < 2 ? [] : [{ ...subpath, anchors }];
	});
