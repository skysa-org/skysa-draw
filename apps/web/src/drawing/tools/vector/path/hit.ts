import { distance, type Point } from '../geometry.js';
import { flatten, type Nearest, nearestOnCubic } from './bezier.js';
import {
	anchorAt,
	type AnchorRef,
	type Cubic,
	type HandleRef,
	nextIndex,
	type PathData,
	previousIndex,
	samePlace,
	segmentCount,
	segmentOf,
	type SegmentRef,
	segmentsOf,
} from './model.js';

/**
 * What of a path is under the pointer (docs/decisions/0004-the-interface.md):
 * an anchor, a handle, a point on a segment, or its inside. Everything in one
 * space, the caller's, which is the drawing's units for the node tool, with
 * the reach already divided by the viewport's scale.
 */

const nearestOf = <T extends Readonly<{ distance: number }>>(
	items: readonly T[],
	reach: number
): T | undefined =>
	items.reduce<T | undefined>(
		(best, each) =>
			each.distance <= reach && (best === undefined || each.distance < best.distance)
				? each
				: best,
		undefined
	);

/** The anchor nearest `p` within `reach`. */
export const nearestAnchor = (data: PathData, p: Point, reach: number): AnchorRef | undefined =>
	nearestOf(
		data.flatMap((subpath, s) =>
			subpath.anchors.map((anchor, index) => ({
				ref: { subpath: s, index },
				distance: distance(anchor.point, p),
			}))
		),
		reach
	)?.ref;

export const handlePoint = (data: PathData, handle: HandleRef): Point | undefined =>
	anchorAt(data, handle)?.[handle.side];

/** Of `handles`, the one nearest `p` within `reach`. */
export const nearestHandle = (
	data: PathData,
	handles: readonly HandleRef[],
	p: Point,
	reach: number
): HandleRef | undefined =>
	nearestOf(
		handles.flatMap((handle) => {
			const at = handlePoint(data, handle);
			return at === undefined ? [] : [{ handle, distance: distance(at, p) }];
		}),
		reach
	)?.handle;

const sameHandle = (a: HandleRef, b: HandleRef): boolean =>
	a.subpath === b.subpath && a.index === b.index && a.side === b.side;

/**
 * The handles shown around the chosen anchors, as Illustrator shows them: both
 * of each chosen anchor's, and the near handle of each neighbor, so every
 * segment that touches a chosen anchor can be reshaped from either end. A
 * handle on its anchor pulls nothing and is not shown, nor is one on the far
 * side of an open end, which no segment uses.
 */
export const shownHandles = (
	data: PathData,
	chosen: readonly AnchorRef[]
): readonly HandleRef[] => {
	const all = chosen.flatMap((ref): readonly HandleRef[] => {
		const subpath = data[ref.subpath];
		if (subpath === undefined) return [];
		const previous = previousIndex(subpath, ref.index);
		const next = nextIndex(subpath, ref.index);
		return [
			...(previous === undefined
				? []
				: [
						{ ...ref, side: 'in' as const },
						{ subpath: ref.subpath, index: previous, side: 'out' as const },
					]),
			...(next === undefined
				? []
				: [
						{ ...ref, side: 'out' as const },
						{ subpath: ref.subpath, index: next, side: 'in' as const },
					]),
		];
	});
	return all.filter((handle, i) => {
		const anchor = anchorAt(data, handle);
		return (
			anchor !== undefined &&
			!samePlace(anchor[handle.side], anchor.point) &&
			all.findIndex((other) => sameHandle(other, handle)) === i
		);
	});
};

/** Whether `p` is within `reach` of a cubic's control points' box, which holds the curve: a quick test before a slow one. */
const nearBox = (c: Cubic, p: Point, reach: number): boolean => {
	const xs = c.map((q) => q.x);
	const ys = c.map((q) => q.y);
	return (
		p.x >= Math.min(...xs) - reach &&
		p.x <= Math.max(...xs) + reach &&
		p.y >= Math.min(...ys) - reach &&
		p.y <= Math.max(...ys) + reach
	);
};

type OnPath = SegmentRef & Nearest;

/** The point of the path nearest `p` within `reach`: which segment, where along it, and how far. */
export const nearestOnPath = (data: PathData, p: Point, reach: number): OnPath | undefined =>
	nearestOf(
		data.flatMap((subpath, s) =>
			Array.from({ length: segmentCount(subpath) }, (_, segment) => {
				const c = segmentOf(subpath, segment);
				return c === undefined || !nearBox(c, p, reach)
					? []
					: [{ subpath: s, segment, ...nearestOnCubic(c, p) }];
			}).flat()
		),
		reach
	);

/** Twice the signed area of `a`, `b`, `p`: which side of the line through `a` and `b` the point is. */
const side = (a: Point, b: Point, p: Point): number =>
	(b.x - a.x) * (p.y - a.y) - (p.x - a.x) * (b.y - a.y);

/** How many times a closed polygon winds around `p`, counterclockwise counted up. */
const windingOf = (polygon: readonly Point[], p: Point): number =>
	polygon.reduce((winding, a, i) => {
		const b = polygon[(i + 1) % polygon.length] ?? a;
		if (a.y <= p.y) return b.y > p.y && side(a, b, p) > 0 ? winding + 1 : winding;
		return b.y <= p.y && side(a, b, p) < 0 ? winding - 1 : winding;
	}, 0);

/**
 * Whether `p` is inside the path as its fill paints it, by the nonzero rule:
 * every subpath closed for the purpose, as a fill closes an open one, and
 * each cubic as a polyline.
 */
export const insideFill = (data: PathData, p: Point): boolean =>
	data.reduce(
		(winding, subpath) => winding + windingOf(segmentsOf(subpath).flatMap(flatten), p),
		0
	) !== 0;
