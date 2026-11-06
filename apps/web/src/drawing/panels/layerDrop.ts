import type { LayerPlace } from '../document/arrange.js';

/**
 * Where layers dragged in the layers panel would land (docs/ARCHITECTURE.md
 * §7, "The interface"), and where Alt with an arrow key moves them, as a place
 * in the stack (`LayerPlace`, `document/arrange.ts`). Pure, over the panel's
 * rows top first, a group's layers under it, one deeper; the panel measures
 * the rows and draws what this says.
 *
 * Over a row, its upper half is the gap above it and its lower half the gap
 * below it; on a group's row the middle band is into the group, at its top,
 * as a folder takes what is dropped on it. The gap above a row places as that
 * row's sibling, directly above it. The gap below a row places as its sibling,
 * directly below it, except that the pointer's x can choose a shallower depth,
 * as far out as the depth of the row under the gap, which is directly below
 * the row's group at that depth: so the bottom of a group, and each level out
 * of it, can be reached at the foot of a nested group, where every one of
 * them is the same gap. Under the last row is the bottom of the drawing.
 * Whether a place can be had at all, not into a dragged group nor where the
 * layers already are, is `canPlaceLayers`'s to say.
 *
 * A collapsed group shows no rows of its layers, so it is one row here: into
 * it is still at its top, above its top layer, and under its row is under the
 * group, beside it, never among layers no row shows; Alt with an arrow passes
 * over it whole.
 */

export type DropRow = Readonly<{
	id: string;
	/** 0 at the root; one more inside each group. */
	depth: number;
	parentId: string | undefined;
	group: boolean;
	/** A group whose layers no row shows: collapsed in the panel. */
	collapsed?: boolean;
	/** A collapsed group's top layer, which no row shows: what into it goes above. */
	topLayer?: string;
}>;

/** A row as it is drawn: its top and bottom edges, in CSS px from the top of the page. */
export type MeasuredRow = DropRow & Readonly<{ top: number; bottom: number }>;

/** Where depth 0 begins across the page, and how far in each depth more is, in CSS px. */
export type Indent = Readonly<{ left: number; step: number }>;

/**
 * What the panel shows for a drop: a line in a gap, the gap above the row at
 * `before`, or under the last row where it is the rows' length, drawn in from
 * the left to `depth`; or a group's row lit, for into that group.
 */
export type DropTarget =
	| Readonly<{ kind: 'gap'; before: number; depth: number; place: LayerPlace }>
	| Readonly<{ kind: 'into'; id: string; place: LayerPlace }>;

/** The middle of a group's row, as a share of its height, that drops into the group. */
const INTO_FROM = 0.25;
const INTO_TO = 0.75;

const BOTTOM: LayerPlace = { parentId: undefined, aboveId: undefined };

/** Directly above the row `at`, among its siblings. */
const aboveRow = (rows: readonly DropRow[], at: number): LayerPlace => ({
	parentId: rows[at]?.parentId,
	aboveId: rows[at]?.id,
});

/** Directly below the row `at`, among its siblings: above the next of them, or at their bottom. */
const belowRow = (rows: readonly DropRow[], at: number): LayerPlace => {
	const row = rows[at];
	if (row === undefined) return BOTTOM;
	// Past what the row holds, the next row as deep or shallower is its next
	// sibling, or, where the row is the last of them, a layer further out.
	const next = rows.slice(at + 1).find((each) => each.depth <= row.depth);
	return {
		parentId: row.parentId,
		aboveId: next !== undefined && next.parentId === row.parentId ? next.id : undefined,
	};
};

/**
 * Into the group at `at`, at its top: above its top layer, the row under it
 * or, collapsed, the one no row shows; or its only place where it is empty.
 */
const intoGroup = (rows: readonly DropRow[], at: number): LayerPlace => {
	const row = rows[at];
	const next = rows[at + 1];
	return {
		parentId: row?.id,
		aboveId: next !== undefined && next.parentId === row?.id ? next.id : row?.topLayer,
	};
};

/** The row `at`, or the group holding it at `depth`, as an index into `rows`. */
const ancestorAt = (rows: readonly DropRow[], at: number, depth: number): number => {
	const row = rows[at];
	if (row === undefined || row.depth <= depth) return at;
	return ancestorAt(
		rows,
		rows.findIndex((each) => each.id === row.parentId),
		depth
	);
};

/** Every depth from `deepest` out to `shallowest`, both included. */
const depthsFrom = (deepest: number, shallowest: number): readonly number[] =>
	Array.from({ length: Math.max(0, deepest - shallowest) + 1 }, (_, step) => deepest - step);

type GapPlace = Readonly<{ depth: number; place: LayerPlace }>;

/**
 * The places in the gap under the row `at`, deepest first: under a group's
 * row, over its first layer, into it, the one place there; elsewhere directly
 * below the row and below each group holding it, out to the depth of the row
 * under the gap, or the root's under the last.
 */
const placesUnder = (rows: readonly DropRow[], at: number): readonly GapPlace[] => {
	const row = rows[at];
	if (row === undefined) return [];
	const next = rows[at + 1];
	if (next !== undefined && next.depth > row.depth) {
		return [{ depth: next.depth, place: aboveRow(rows, at + 1) }];
	}
	return depthsFrom(row.depth, next?.depth ?? 0).map((depth) => ({
		depth,
		place: belowRow(rows, ancestorAt(rows, at, depth)),
	}));
};

/** Where a drag over the rows, at `point` on the page, would drop. */
export const dropTargetAt = (
	rows: readonly MeasuredRow[],
	point: Readonly<{ x: number; y: number }>,
	indent: Indent
): DropTarget | undefined => {
	const first = rows[0];
	const last = rows.at(-1);
	if (first === undefined || last === undefined) return undefined;
	if (point.y < first.top) {
		return { kind: 'gap', before: 0, depth: first.depth, place: aboveRow(rows, 0) };
	}
	if (point.y >= last.bottom)
		return { kind: 'gap', before: rows.length, depth: 0, place: BOTTOM };
	const at = rows.findIndex((row) => point.y < row.bottom);
	const row = rows[at];
	if (row === undefined) return undefined;
	const height = row.bottom - row.top;
	const share = height > 0 ? (point.y - row.top) / height : 0;
	if (row.group && share >= INTO_FROM && share < INTO_TO) {
		return { kind: 'into', id: row.id, place: intoGroup(rows, at) };
	}
	if (share < 0.5)
		return { kind: 'gap', before: at, depth: row.depth, place: aboveRow(rows, at) };
	const choices = placesUnder(rows, at);
	// The depth whose indent the pointer is past, from the left: each depth is
	// a column `step` wide, so pointing left of a row's own indent goes out.
	const wanted =
		indent.step > 0
			? Math.floor((point.x - indent.left) / indent.step)
			: Number.POSITIVE_INFINITY;
	const chosen = choices.find((choice) => choice.depth <= wanted) ?? choices.at(-1);
	return chosen === undefined
		? undefined
		: { kind: 'gap', before: at + 1, depth: chosen.depth, place: chosen.place };
};

const samePlace = (one: LayerPlace, other: LayerPlace): boolean =>
	one.parentId === other.parentId && one.aboveId === other.aboveId;

/**
 * Every place a drop could go, top to bottom, over rows that hold none of the
 * layers moved: above the first row, into each empty group, and every place
 * in each gap, deepest first, since the foot of a group is above what is
 * below the group. A collapsed group is passed over whole: into it is no step.
 */
const everyPlace = (rows: readonly DropRow[]): readonly LayerPlace[] =>
	rows.length === 0
		? [BOTTOM]
		: [
				aboveRow(rows, 0),
				...rows.flatMap((row, at) => [
					...(row.group && row.collapsed !== true && rows[at + 1]?.parentId !== row.id
						? [{ parentId: row.id, aboveId: undefined }]
						: []),
					...placesUnder(rows, at).map((choice) => choice.place),
				]),
			];

/** The ids of the rows `ids` name and of every row inside them. */
const movingIn = (rows: readonly DropRow[], ids: readonly string[]): ReadonlySet<string> =>
	rows.reduce<ReadonlySet<string>>(
		(moving, row) =>
			ids.includes(row.id) || (row.parentId !== undefined && moving.has(row.parentId))
				? new Set([...moving, row.id])
				: moving,
		new Set()
	);

/**
 * Where Alt with an arrow key moves the layers `ids`: the next place up or
 * down from where they are, as a drag to the gap beside them would put them,
 * one step at a time, so a layer goes into a group it meets at its top, down
 * through it, and out of it a level at a time at its foot. From the topmost
 * of them going up, the bottommost going down; the next place that differs
 * from where they are and that `accepts` takes, or none at the end.
 */
export const nextPlace = (
	rows: readonly DropRow[],
	ids: readonly string[],
	direction: 'up' | 'down',
	accepts: (place: LayerPlace) => boolean
): LayerPlace | undefined => {
	const moving = movingIn(rows, ids);
	const outermost = rows.filter(
		(row) => ids.includes(row.id) && (row.parentId === undefined || !moving.has(row.parentId))
	);
	const from = direction === 'up' ? outermost[0] : outermost.at(-1);
	if (from === undefined) return undefined;
	const under = rows
		.slice(rows.indexOf(from) + 1)
		.find((row) => row.parentId === from.parentId && !moving.has(row.id));
	const here: LayerPlace = { parentId: from.parentId, aboveId: under?.id };
	const places = everyPlace(rows.filter((row) => !moving.has(row.id)));
	const at = places.findIndex((place) => samePlace(place, here));
	if (at === -1) return undefined;
	const ahead = direction === 'up' ? places.slice(0, at).reverse() : places.slice(at + 1);
	return ahead.find((place) => !samePlace(place, here) && accepts(place));
};

/** How near the scrolling box's top or bottom a drag scrolls it, in CSS px: a control's height. */
const SCROLL_EDGE_PX = 44;

/** The most a drag scrolls the box in a frame, in CSS px: at its edge, or past it. */
const SCROLL_MOST_PX = 12;

/**
 * How far a drag at `y` scrolls the box between `top` and `bottom` this
 * frame: up, as a negative, near its top, down near its bottom, faster the
 * nearer the edge and fastest past it, and not at all in between. The edge is
 * a third of a short box at most, so its middle never scrolls.
 */
export const scrollStep = (box: Readonly<{ top: number; bottom: number }>, y: number): number => {
	const edge = Math.min(SCROLL_EDGE_PX, (box.bottom - box.top) / 3);
	if (edge <= 0) return 0;
	const speed = (inside: number) =>
		Math.ceil((Math.min(edge, edge - inside) / edge) * SCROLL_MOST_PX);
	if (y < box.top + edge) return -speed(y - box.top);
	if (y > box.bottom - edge) return speed(box.bottom - y);
	return 0;
};
