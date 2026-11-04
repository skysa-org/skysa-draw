import { apply, type Box, type Mat, type Point } from '../geometry.js';

/**
 * A path's points as the pen makes them and the node tool edits them
 * (docs/decisions/0004-the-interface.md): each subpath a run of anchors, every
 * anchor with the handle the curve comes in by and the one it leaves by, and
 * every segment a cubic Bézier from one anchor through its `out` handle and
 * the next anchor's `in` to the next. A line is a cubic whose handles sit on
 * its anchors, a quadratic is raised to a cubic and an arc is cut into cubics
 * (`parse.ts`), so one shape of data holds any `d`. A handle that pulls
 * nowhere sits on its anchor. Pure and DOM-free, so it is tested as arithmetic.
 */
export type Anchor = Readonly<{ point: Point; in: Point; out: Point }>;

export type Subpath = Readonly<{ anchors: readonly Anchor[]; closed: boolean }>;

export type PathData = readonly Subpath[];

/** A cubic Bézier: its start, its two control points, its end. */
export type Cubic = Readonly<[Point, Point, Point, Point]>;

/** One anchor, by its subpath and its place in it. */
export type AnchorRef = Readonly<{ subpath: number; index: number }>;

export type Side = 'in' | 'out';

/** One handle: an anchor's, on one side of it. */
export type HandleRef = AnchorRef & Readonly<{ side: Side }>;

/** A segment, by its subpath and the anchor it starts from: the last of a closed one runs back to the first. */
export type SegmentRef = Readonly<{ subpath: number; segment: number }>;

/** A number as a path writes it: two decimals, finer than a screen pixel at any zoom the editor offers, and `-0` as `0`. */
export const roundForPath = (n: number): number => {
	const rounded = Math.round(n * 100) / 100;
	return rounded === 0 ? 0 : rounded;
};

/** Whether two points are the same once written: what makes a handle sit on its anchor. */
export const samePlace = (a: Point, b: Point): boolean =>
	roundForPath(a.x) === roundForPath(b.x) && roundForPath(a.y) === roundForPath(b.y);

/** A segment whose handles both sit on its anchors is a straight line. */
export const isLine = (c: Cubic): boolean => samePlace(c[0], c[1]) && samePlace(c[2], c[3]);

/** A point with no handles: a corner, and every point of a polyline. */
export const corner = (point: Point): Anchor => ({ point, in: point, out: point });

export const opposite = (side: Side): Side => (side === 'in' ? 'out' : 'in');

export const sameRef = (a: AnchorRef, b: AnchorRef): boolean =>
	a.subpath === b.subpath && a.index === b.index;

export const anchorAt = (data: PathData, ref: AnchorRef): Anchor | undefined =>
	data[ref.subpath]?.anchors[ref.index];

/** How many segments a subpath draws: one between each two anchors, and one back to the start if it is closed. */
export const segmentCount = (subpath: Subpath): number =>
	subpath.closed ? subpath.anchors.length : Math.max(0, subpath.anchors.length - 1);

/** Segment `index` of a subpath as a cubic; none past its last. */
export const segmentOf = (subpath: Subpath, index: number): Cubic | undefined => {
	if (index >= segmentCount(subpath)) return undefined;
	const from = subpath.anchors[index];
	const to = subpath.anchors[index + 1] ?? subpath.anchors[0];
	if (from === undefined || to === undefined) return undefined;
	return [from.point, from.out, to.in, to.point];
};

export const segmentsOf = (subpath: Subpath): readonly Cubic[] =>
	Array.from({ length: segmentCount(subpath) }, (_, index) => segmentOf(subpath, index)).filter(
		(each): each is Cubic => each !== undefined
	);

/** The anchor after `index` in its subpath, round to the first in a closed one; none at an open end. */
export const nextIndex = (subpath: Subpath, index: number): number | undefined => {
	if (index + 1 < subpath.anchors.length) return index + 1;
	return subpath.closed ? 0 : undefined;
};

/** The anchor before `index`, round to the last in a closed one; none at an open start. */
export const previousIndex = (subpath: Subpath, index: number): number | undefined => {
	if (index > 0) return index - 1;
	return subpath.closed ? subpath.anchors.length - 1 : undefined;
};

/** One anchor changed, the rest of the path as it was. */
export const updateAnchor = (
	data: PathData,
	ref: AnchorRef,
	change: (anchor: Anchor) => Anchor
): PathData =>
	data.map((subpath, s) =>
		s === ref.subpath
			? {
					...subpath,
					anchors: subpath.anchors.map((anchor, i) =>
						i === ref.index ? change(anchor) : anchor
					),
				}
			: subpath
	);

const mapAnchor = (m: Mat, anchor: Anchor): Anchor => ({
	point: apply(m, anchor.point),
	in: apply(m, anchor.in),
	out: apply(m, anchor.out),
});

/**
 * The path after an affine matrix: every anchor and handle moved by it, which
 * is exact, since an affine map takes a Bézier to the Bézier of its moved
 * control points. How a path goes between an element's units and the drawing's.
 */
export const mapPath = (m: Mat, data: PathData): PathData =>
	data.map((subpath) => ({
		...subpath,
		anchors: subpath.anchors.map((anchor) => mapAnchor(m, anchor)),
	}));

export const mapAnchors = (m: Mat, anchors: readonly Anchor[]): readonly Anchor[] =>
	anchors.map((anchor) => mapAnchor(m, anchor));

/**
 * The box around every anchor and handle: the curve lies inside its control
 * points, so this holds it, a little generously where a handle reaches out.
 * None for a path with no points.
 */
export const boundsOf = (data: PathData): Box | undefined => {
	const points = data.flatMap((subpath) =>
		subpath.anchors.flatMap((anchor) => [anchor.point, anchor.in, anchor.out])
	);
	const [first] = points;
	if (first === undefined) return undefined;
	// By `reduce`, not `Math.min(...)`, which a long pencil path would take past the engine's argument limit.
	const edges = points.reduce(
		(box, p) => ({
			left: Math.min(box.left, p.x),
			top: Math.min(box.top, p.y),
			right: Math.max(box.right, p.x),
			bottom: Math.max(box.bottom, p.y),
		}),
		{ left: first.x, top: first.y, right: first.x, bottom: first.y }
	);
	return {
		x: edges.left,
		y: edges.top,
		width: edges.right - edges.left,
		height: edges.bottom - edges.top,
	};
};
