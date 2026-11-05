import { RASTER_MAX_SIDE } from '@skysa/draw-core';

import type { Box, Mat } from '../vector/geometry.js';
import type { Point } from './pixels.js';
import { outlinePath, traceMask } from './trace.js';

/**
 * The area as a mask of cells, for what is done to its outline as a whole
 * (`areaOps.ts`): the outline filled onto a grid of square cells under
 * `nonzero`, a cell in where its center is, as a canvas samples a pixel;
 * masks met cell by cell; and the cells traced back into an outline along
 * their edges (`trace.ts`), outer boundaries clockwise and holes the other
 * way, as the area writes every outline. Pure, with no canvas and no
 * `Path2D`, so the same outline gives the same bytes in a browser, in a
 * worker and in a test.
 *
 * A cell is one user unit, on whole units, so it is a raster layer's pixel
 * where the layer has one pixel a unit (`pixelGrid`), and an outline on
 * whole units, the marquee's on such a layer, is filled and traced back
 * exactly. What lies between is taken to the cells: a slanted edge comes
 * back as a staircase, as a selection in Photoshop is a mask of pixels.
 *
 * Past `AREA_MAX_CELLS` the cells are larger, a whole number of units each,
 * so the grid is never more than that: a byte a cell for each mask, and two
 * more for a distance (`morph.ts`).
 */

/**
 * The most cells a grid has: as many as the largest raster layer has pixels
 * (`RASTER_MAX_SIDE` a side), so an area any layer can hold is one cell a
 * unit. A larger box would make a layer whose pixels are larger than a unit,
 * and its cells are about as large: 16 MB a mask at most, a quarter of what
 * such a layer's own pixels take.
 */
export const AREA_MAX_CELLS = RASTER_MAX_SIDE * RASTER_MAX_SIDE;

/** Fewer cells than a grid around any box has, its ring of empty cells and all: so a grid of larger cells always fits at last. */
const LEAST_CELLS = 64;

/** A grid of square cells over the drawing's user units, row by row. */
export type AreaGrid = Readonly<{
	/** The top-left corner in user units: a multiple of `cell`. */
	x: number;
	y: number;
	/** A cell's side in user units: a whole number, 1 unless that would pass the most cells. */
	cell: number;
	/** Cells across. */
	width: number;
	/** Cells down. */
	height: number;
}>;

/** The cells along one side, as a first cell's index and a count, around `from` to `to` and `reach` past them, with a ring more. */
const spanOf = (
	from: number,
	to: number,
	reach: number,
	cell: number
): Readonly<{ first: number; count: number }> => {
	const ring = Math.ceil(reach / cell) + 1;
	const first = Math.floor(from / cell) - ring;
	return { first, count: Math.ceil(to / cell) + ring - first };
};

/**
 * The grid over `box` grown by `reach` user units, with one ring of cells
 * more, which nothing filled reaches: so every cell an outline in the box
 * covers, or one grown by `reach` does, is on the grid, and the cells off it
 * are as empty as that ring. One unit a cell unless that would be more than
 * `maxCells`; else the fewest whole units a cell that fit, found from an
 * estimate by the square root of how far over it is.
 */
export const gridAround = (box: Box, reach: number, maxCells = AREA_MAX_CELLS): AreaGrid => {
	const most = Math.max(LEAST_CELLS, maxCells);
	const at = (cell: number): AreaGrid => {
		const across = spanOf(box.x, box.x + box.width, reach, cell);
		const down = spanOf(box.y, box.y + box.height, reach, cell);
		return {
			x: across.first * cell,
			y: down.first * cell,
			cell,
			width: across.count,
			height: down.count,
		};
	};
	const fit = (cell: number): AreaGrid => {
		const grid = at(cell);
		const cells = grid.width * grid.height;
		if (cells <= most) return grid;
		return fit(Math.max(cell + 1, Math.floor(cell * Math.sqrt(cells / most))));
	};
	const spread = (box.width + 2 * reach) * (box.height + 2 * reach);
	return fit(Math.max(1, Math.floor(Math.sqrt(spread / most))));
};

/** From the grid's cells to user units: a cell's corner `(i, j)` is at the grid's corner and `i` and `j` cells on. */
const cellsToUnits = (grid: AreaGrid): Mat => [grid.cell, 0, 0, grid.cell, grid.x, grid.y];

/**
 * The first cell along one side whose center is at `at` or past it, at
 * `origin` and `cell` units a cell, not held to the grid: a center on an
 * edge is in on one side of it and out on the other, as a GPU's top-left
 * rule has it, so two outlines that share an edge share no cell.
 */
const cellFrom = (origin: number, cell: number, at: number): number =>
	Math.ceil((at - origin) / cell - 0.5);

/** The first row whose center is at `y` or below it, inside the grid or one past it. */
const rowFrom = (grid: AreaGrid, y: number): number =>
	Math.min(grid.height, Math.max(0, cellFrom(grid.y, grid.cell, y)));

/** The first column whose center is at `x` or right of it, inside the grid or one past it. */
const columnFrom = (grid: AreaGrid, x: number): number =>
	Math.min(grid.width, Math.max(0, cellFrom(grid.x, grid.cell, x)));

/** Where an outline crosses the rows' centers: each crossing's first column at or right of it, and which way the edge runs. */
type Crossings = Readonly<{
	columns: Int32Array;
	turns: Int8Array;
	/** Where each row's crossings begin, and where the last row's end. */
	starts: Int32Array;
}>;

/* eslint-disable functional/no-loop-statements, functional/no-let, functional/immutable-data -- a pass over every cell of a grid of millions, in plain loops over typed arrays written in place: a closure a cell is several times slower */

/** A polygon's edges that are not level, after `start` in `edges`, four numbers each: from x, from y, to x, to y; where they end. */
const addEdges = (polygon: readonly Point[], edges: Float64Array, start: number): number => {
	let at = start;
	for (let k = 0; k < polygon.length; k++) {
		const a = polygon[k];
		const b = polygon[(k + 1) % polygon.length];
		if (a === undefined || b === undefined || a.y === b.y) continue;
		edges[at] = a.x;
		edges[at + 1] = a.y;
		edges[at + 2] = b.x;
		edges[at + 3] = b.y;
		at += 4;
	}
	return at;
};

/** Every edge of the outline that is not level, closing each polygon. */
const edgesOf = (polygons: readonly (readonly Point[])[]): Float64Array => {
	const edges = new Float64Array(polygons.reduce((sum, polygon) => sum + polygon.length, 0) * 4);
	let at = 0;
	for (const polygon of polygons) at = addEdges(polygon, edges, at);
	return edges.subarray(0, at);
};

/** Where each row's crossings begin: the rows an edge crosses counted by a difference, then summed. */
const startsOf = (grid: AreaGrid, edges: Float64Array): Int32Array => {
	const change = new Int32Array(grid.height + 1);
	for (let e = 0; e < edges.length; e += 4) {
		const ya = edges[e + 1] ?? 0;
		const yb = edges[e + 3] ?? 0;
		const first = rowFrom(grid, Math.min(ya, yb));
		const last = rowFrom(grid, Math.max(ya, yb));
		change[first] = (change[first] ?? 0) + 1;
		change[last] = (change[last] ?? 0) - 1;
	}
	const starts = new Int32Array(grid.height + 1);
	let open = 0;
	for (let row = 0; row < grid.height; row++) {
		open += change[row] ?? 0;
		starts[row + 1] = (starts[row] ?? 0) + open;
	}
	return starts;
};

/**
 * Every crossing of the outline with a row's center, in its row: an edge
 * crosses the rows whose centers are at its upper end or below and above
 * its lower one, so a corner where two edges meet is crossed once.
 */
const crossingsOf = (grid: AreaGrid, edges: Float64Array): Crossings => {
	const starts = startsOf(grid, edges);
	const total = starts[grid.height] ?? 0;
	const columns = new Int32Array(total);
	const turns = new Int8Array(total);
	const next = starts.slice(0, grid.height);
	for (let e = 0; e < edges.length; e += 4) {
		const ax = edges[e] ?? 0;
		const ay = edges[e + 1] ?? 0;
		const by = edges[e + 3] ?? 0;
		const slope = ((edges[e + 2] ?? 0) - ax) / (by - ay);
		const turn = by > ay ? 1 : -1;
		const last = rowFrom(grid, Math.max(ay, by));
		for (let row = rowFrom(grid, Math.min(ay, by)); row < last; row++) {
			const at = next[row] ?? 0;
			columns[at] = columnFrom(grid, ax + (grid.y + (row + 0.5) * grid.cell - ay) * slope);
			turns[at] = turn;
			next[row] = at + 1;
		}
	}
	return { columns, turns, starts };
};

/** One row of the mask: each crossing's turn added at its column, then summed along the row, a cell in where the sum is not 0. */
const fillRow = (
	row: number,
	width: number,
	crossings: Crossings,
	sums: Int32Array,
	selected: Uint8Array
): void => {
	const { columns, turns, starts } = crossings;
	const from = starts[row] ?? 0;
	const to = starts[row + 1] ?? 0;
	if (from === to) return;
	for (let k = from; k < to; k++) {
		const column = columns[k] ?? 0;
		sums[column] = (sums[column] ?? 0) + (turns[k] ?? 0);
	}
	const offset = row * width;
	let winding = 0;
	for (let x = 0; x < width; x++) {
		winding += sums[x] ?? 0;
		selected[offset + x] = winding === 0 ? 0 : 1;
	}
	sums.fill(0);
};

/**
 * The cells an outline covers under `nonzero`, 1 in and 0 out, by a
 * scanline fill at the cells' centers: each edge's crossings with the rows
 * it spans, bucketed by row, then each row summed along. Linear in the
 * cells and the crossings. A box is the cells whose centers are at its
 * left and top edges or past them and short of its right and bottom ones,
 * so a box on whole units at one unit a cell is exactly its cells.
 */
export const fillOutline = (
	polygons: readonly (readonly Point[])[],
	grid: AreaGrid
): Uint8Array => {
	const crossings = crossingsOf(grid, edgesOf(polygons));
	const selected = new Uint8Array(grid.width * grid.height);
	const sums = new Int32Array(grid.width + 1);
	for (let row = 0; row < grid.height; row++) fillRow(row, grid.width, crossings, sums, selected);
	return selected;
};

/** The cells both masks hold. */
export const bothOf = (a: Uint8Array, b: Uint8Array): Uint8Array => {
	const out = new Uint8Array(a.length);
	for (let i = 0; i < a.length; i++) out[i] = (a[i] ?? 0) & (b[i] ?? 0);
	return out;
};

/** The cells `a` holds and `b` does not. */
export const withoutOf = (a: Uint8Array, b: Uint8Array): Uint8Array => {
	const out = new Uint8Array(a.length);
	for (let i = 0; i < a.length; i++) out[i] = (a[i] ?? 0) & ((b[i] ?? 0) ^ 1);
	return out;
};

/** Whether a row holds every cell from `left` to `right`, exclusive. */
const rowHolds = (selected: Uint8Array, offset: number, left: number, right: number): boolean => {
	for (let x = left; x < right; x++) if (selected[offset + x] !== 1) return false;
	return true;
};

/**
 * Whether the mask holds every cell whose center is in `box`, as the box
 * would be filled: none of it left outside. A box reaching past the grid has
 * cells off it, which no mask holds.
 */
export const holdsBox = (selected: Uint8Array, grid: AreaGrid, box: Box): boolean => {
	const left = cellFrom(grid.x, grid.cell, box.x);
	const right = cellFrom(grid.x, grid.cell, box.x + box.width);
	const top = cellFrom(grid.y, grid.cell, box.y);
	const bottom = cellFrom(grid.y, grid.cell, box.y + box.height);
	if (right <= left || bottom <= top) return true;
	if (left < 0 || top < 0 || right > grid.width || bottom > grid.height) return false;
	for (let row = top; row < bottom; row++) {
		if (!rowHolds(selected, row * grid.width, left, right)) return false;
	}
	return true;
};

/* eslint-enable functional/no-loop-statements, functional/no-let, functional/immutable-data */

/**
 * The mask's outline as the area's path (`Region.path`): traced along the
 * cells' edges (`traceMask`) and taken into user units, each corner on a
 * cell's corner, written to two decimals. None for a mask of nothing.
 */
export const outlineOf = (selected: Uint8Array, grid: AreaGrid): string | undefined =>
	outlinePath(
		traceMask({ selected, width: grid.width, height: grid.height }),
		cellsToUnits(grid)
	);
