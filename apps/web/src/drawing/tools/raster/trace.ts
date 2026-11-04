import { apply, type Mat } from '../vector/geometry.js';

/**
 * A pixel mask's outline (docs/ARCHITECTURE.md §7, "Tools"): what the magic
 * wand makes the area selection of. The boundary is traced along the pixels'
 * edges into closed loops, and each straight run is one segment, so a
 * rectangle of pixels is four corners.
 *
 * Every side of a selected pixel that does not touch another selected pixel
 * is an edge, walked with that pixel on its right. On a screen whose y runs
 * down, that winds an outer boundary clockwise, as the marquee winds its
 * rectangle, and a hole counter-clockwise. Under `nonzero` the edges wind
 * once around every selected pixel and not at all around any other, whatever
 * loops they are walked in: a ring keeps its hole, and a subpath the marquee
 * adds with Shift (`addToArea`), clockwise too, is a union with it.
 *
 * Where two selected pixels touch only at a corner, the walk turns into the
 * pixel it came along, so pixels joined only diagonally make loops of their
 * own, as the wand's flood joins pixels only by their sides.
 *
 * Linear in the mask: one pass over it finds the edges, one pass over them
 * walks them, each loop begun at the first edge not yet walked, found by
 * `indexOf` from where the last loop began, which never looks back. Nothing
 * recurses, so no outline is too long for the stack.
 */

/** A selection of pixels, row by row: non-zero where a pixel is selected. */
export type PixelMask = Readonly<{
	selected: Uint8Array;
	width: number;
	height: number;
}>;

/** The directions an edge runs in, in the order a right turn takes them on a y-down screen. */
const EAST = 0;
const SOUTH = 1;
const WEST = 2;
const NORTH = 3;

/** What is known of an edge, by its start point and its direction. */
const NONE = 0;
const WAITING = 1;
const WALKED = 2;

/**
 * A mask's outline, traced: its corners, each a grid point's index
 * (`y * stride + x`), loop after loop. How many there are is what its path
 * would cost, known before it is written.
 */
export type Outline = Readonly<{
	corners: Uint32Array;
	/** Where each loop ends among `corners`, exclusive. */
	ends: Uint32Array;
	/** Grid points per row: the mask's width and one. */
	stride: number;
}>;

/* eslint-disable functional/immutable-data -- the outline is found and walked in typed arrays written in place; a copy per edge would be the whole outline again */
/**
 * Every boundary edge of the mask, `WAITING`, at `point * 4 + direction`,
 * where the point is the grid point it starts from; and how many there are.
 */
const edgesOf = ({
	selected,
	width,
	height,
}: PixelMask): Readonly<{ edges: Uint8Array; count: number }> => {
	const stride = width + 1;
	const pixels = width * height;
	const edges = new Uint8Array(stride * (height + 1) * 4);
	// [the edges found]
	const tally = new Uint32Array(1);
	const mark = (point: number, direction: number): void => {
		edges[point * 4 + direction] = WAITING;
		tally[0] = (tally[0] ?? 0) + 1;
	};
	selected.forEach((on, index) => {
		if (on === 0 || index >= pixels) return;
		const x = index % width;
		const y = (index - x) / width;
		const corner = y * stride + x;
		if (y === 0 || selected[index - width] === 0) mark(corner, EAST);
		if (x + 1 === width || selected[index + 1] === 0) mark(corner + 1, SOUTH);
		if (y + 1 === height || selected[index + width] === 0) mark(corner + stride + 1, WEST);
		if (x === 0 || selected[index - 1] === 0) mark(corner + stride, NORTH);
	});
	return { edges, count: tally[0] ?? 0 };
};

/**
 * The edges in the order they are walked, and where each loop ends among
 * them. From the end of an edge the walk turns right where an edge goes
 * that way, else goes straight on, else turns left: every point has as many
 * edges in as out, and where it has two of each, the right turn keeps to
 * the pixel the walk came along. So each edge has one edge after it and one
 * before, and a loop closes when the edge after is one already walked.
 */
const walk = (
	edges: Uint8Array,
	count: number,
	stride: number
): Readonly<{ order: Uint32Array; ends: Uint32Array; loops: number }> => {
	const steps = [1, stride, -1, -stride];
	const order = new Uint32Array(count);
	// A loop has four edges at least.
	const ends = new Uint32Array(Math.floor(count / 4) + 1);
	// [where the last loop began among `edges`, the loops closed]
	const at = new Uint32Array(2);
	const after = (edge: number): number => {
		const direction = edge % 4;
		const end = ((edge - direction) / 4 + (steps[direction] ?? 0)) * 4;
		const right = (direction + 1) % 4;
		if (edges[end + right] !== NONE) return end + right;
		if (edges[end + direction] !== NONE) return end + direction;
		return end + ((direction + 3) % 4);
	};
	order.forEach((_, position) => {
		const following = position === 0 ? undefined : after(order[position - 1] ?? 0);
		const continues = following !== undefined && edges[following] === WAITING;
		if (position > 0 && !continues) {
			ends[at[1] ?? 0] = position;
			at[1] = (at[1] ?? 0) + 1;
		}
		const edge = continues ? following : edges.indexOf(WAITING, at[0]);
		if (!continues) at[0] = edge;
		order[position] = edge;
		edges[edge] = WALKED;
	});
	const loops = count === 0 ? 0 : (at[1] ?? 0) + 1;
	if (count > 0) ends[loops - 1] = count;
	return { order, ends, loops };
};

/** The mask's outline: where each loop's direction changes, so a straight run is one segment. */
export const traceMask = (mask: PixelMask): Outline => {
	const stride = mask.width + 1;
	const { edges, count } = edgesOf(mask);
	const { order, ends, loops } = walk(edges, count, stride);
	const corners = new Uint32Array(count);
	const cornerEnds = new Uint32Array(loops);
	// [the corners so far, the loop under way]
	const tally = new Uint32Array(2);
	order.forEach((edge, position) => {
		const loop = tally[1] ?? 0;
		const begin = loop === 0 ? 0 : (ends[loop - 1] ?? 0);
		const end = ends[loop] ?? count;
		const previous = order[position === begin ? end - 1 : position - 1] ?? edge;
		if (edge % 4 !== previous % 4) {
			corners[tally[0] ?? 0] = (edge - (edge % 4)) / 4;
			tally[0] = (tally[0] ?? 0) + 1;
		}
		if (position + 1 === end) {
			cornerEnds[loop] = tally[0] ?? 0;
			tally[1] = loop + 1;
		}
	});
	return { corners: corners.subarray(0, tally[0] ?? 0), ends: cornerEnds, stride };
};
/* eslint-enable functional/immutable-data */

/** A coordinate as the area writes one (`area.ts`): two decimals, never `-0`. */
const fmt = (n: number): string => {
	const rounded = Math.round(n * 100) / 100;
	return String(rounded === 0 ? 0 : rounded);
};

/**
 * An outline as the area's path (`Region.path`): one subpath a loop,
 * absolute, straight, closed, each corner taken from the mask's pixels by
 * `matrix` and written to two decimals, as the marquee writes its own. A
 * matrix that mirrors (a flip on the layer) would wind every loop the other
 * way around, so each is written backward then, and an outer boundary is
 * still clockwise in the drawing's units. None for an outline of nothing.
 */
export const outlinePath = (
	{ corners, ends, stride }: Outline,
	matrix: Mat
): string | undefined => {
	if (corners.length === 0) return undefined;
	const [a, b, c, d] = matrix;
	const mirrored = a * d - b * c < 0;
	const pointAt = (corner: number): string => {
		const x = corner % stride;
		const p = apply(matrix, { x, y: (corner - x) / stride });
		return `${fmt(p.x)} ${fmt(p.y)}`;
	};
	return Array.from(ends, (end, loop) => {
		const own = corners.subarray(loop === 0 ? 0 : (ends[loop - 1] ?? 0), end);
		const [first, ...rest] = Array.from(own, (_, i) =>
			pointAt((mirrored ? own[own.length - 1 - i] : own[i]) ?? 0)
		);
		return `M ${first ?? ''} ${rest.map((p) => `L ${p}`).join(' ')} Z`;
	}).join(' ');
};
