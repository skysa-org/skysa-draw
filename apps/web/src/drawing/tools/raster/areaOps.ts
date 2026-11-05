import type { AreaMode, Region } from '../types.js';
import type { Box } from '../vector/geometry.js';
import { addToArea, areaPolygons, boundsOf } from './area.js';
import {
	type AreaGrid,
	bothOf,
	fillOutline,
	gridAround,
	holdsBox,
	outlineOf,
	withoutOf,
} from './areaMask.js';
import { deepOf, majorityOf, nearOf } from './morph.js';
import type { Point } from './pixels.js';

/**
 * What is done to an area's outline as a whole (docs/decisions/0004-the-interface.md,
 * "Selection modes" and "Modify"): a new outline met with the area there, as
 * the selection tools' four modes meet it, and the area expanded,
 * contracted, smoothed or made a border, as Photoshop's Select > Modify does.
 *
 * An inverted area is the canvas outside its outline, and it is met without
 * the canvas, by the outline alone: with the canvas `C`, the outline `P` and
 * what is made `N`, adding is `(C − P) ∪ N = C − (P − N)`, an inverse still,
 * of `P − N`; subtracting is `(C − P) − N = C − (P ∪ N)`, an inverse of the
 * two outlines as one, which `nonzero` gives exactly (`addToArea`); and
 * intersecting is `(C − P) ∩ N = N − P`, a plain area. Adding to a plain
 * area is the two outlines as one too, exact; every other meeting and every
 * Modify is worked on a mask of cells (`areaMask.ts`), one a unit on whole
 * units, and traced back, so its edges are the cells' edges, as a selection
 * in Photoshop is a mask of pixels: an outline on whole units comes back
 * exactly, a slanted one as a staircase. An outline whose box does not meet
 * the other's is not touched.
 *
 * Expand, Contract and Border measure by the Euclidean distance between the
 * cells' centers (`morph.ts`), so a corner grown is round, as Photoshop's
 * is; Smooth is a majority of the square around each cell. For an inverse,
 * Expand is the canvas outside the outline contracted, and Contract the
 * canvas outside it expanded, so the canvas's own edge never moves; Smooth
 * smooths the outline; Border is the band on the outline, a plain area.
 */

/** How Modify… changes the area, Photoshop's Select > Modify less Feather, which has its own. */
export type AreaModify = 'expand' | 'contract' | 'smooth' | 'border';

/**
 * The radius each Modify… takes, in user units, whole ones, as Photoshop's
 * Select > Modify takes pixels: Expand, Contract and Smooth from 1 to 500,
 * Border from 1 to 200.
 */
export const MODIFY_LIMITS: Readonly<Record<AreaModify, Readonly<{ min: number; max: number }>>> = {
	expand: { min: 1, max: 500 },
	contract: { min: 1, max: 500 },
	smooth: { min: 1, max: 500 },
	border: { min: 1, max: 200 },
};

/** A radius as Modify… takes it: rounded to a whole unit and held to `MODIFY_LIMITS`; the least for one that is not a number. */
export const modifyRadius = (how: AreaModify, radius: number): number => {
	const { min, max } = MODIFY_LIMITS[how];
	return Number.isNaN(radius) ? min : Math.min(max, Math.max(min, Math.round(radius)));
};

type Polygons = readonly (readonly Point[])[];

/** An outline filled onto a grid around it. */
type Filled = Readonly<{ grid: AreaGrid; selected: Uint8Array }>;

/** A box whose every number is finite; none for one that is not, or none at all. */
const finiteBox = (box: Box | undefined): Box | undefined =>
	box !== undefined && [box.x, box.y, box.width, box.height].every(Number.isFinite)
		? box
		: undefined;

/** What two boxes share, where it has an inside; none where they only touch or miss. */
const overlapOf = (a: Box | undefined, b: Box | undefined): Box | undefined => {
	if (a === undefined || b === undefined) return undefined;
	const x = Math.max(a.x, b.x);
	const y = Math.max(a.y, b.y);
	const width = Math.min(a.x + a.width, b.x + b.width) - x;
	const height = Math.min(a.y + a.height, b.y + b.height) - y;
	return width > 0 && height > 0 ? { x, y, width, height } : undefined;
};

/** Two outlines as one, an empty one being none. */
const joined = (a: string, b: string): string => (a === '' ? b : addToArea(a, b));

/** What `kept` selects and `taken` does not; `kept` itself, untouched, where their boxes do not meet; none where nothing is left. */
const differenceOf = (kept: string, taken: string): string | undefined => {
	const keeping = areaPolygons(kept);
	const box = finiteBox(boundsOf(keeping));
	if (box === undefined) return undefined;
	const taking = areaPolygons(taken);
	if (overlapOf(box, finiteBox(boundsOf(taking))) === undefined) return kept;
	const grid = gridAround(box, 0);
	return outlineOf(withoutOf(fillOutline(keeping, grid), fillOutline(taking, grid)), grid);
};

/** What both outlines select; none where nothing is. */
const intersectionOf = (a: string, b: string): string | undefined => {
	const first = areaPolygons(a);
	const second = areaPolygons(b);
	const box = overlapOf(finiteBox(boundsOf(first)), finiteBox(boundsOf(second)));
	if (box === undefined) return undefined;
	const grid = gridAround(box, 0);
	return outlineOf(bothOf(fillOutline(first, grid), fillOutline(second, grid)), grid);
};

/** The area of `region` with this outline instead; none for no outline. */
const withPath = (region: Region, path: string | undefined): Region | undefined =>
	path === undefined ? undefined : { ...region, path };

/**
 * An inverted area of this outline: the canvas outside it, and for an
 * outline of nothing the whole canvas, an inverse whose path is empty, which
 * selects what select-all does and whose ants trace the canvas's edge.
 */
const inverseOf = (region: Region, path: string | undefined): Region => ({
	...region,
	inverted: true,
	path: path ?? '',
});

/**
 * The area after a selection tool made `made` in `mode` over `there`, the
 * area selected before; `made` none for a click, which drops the area in
 * `new` and leaves it as it was in the others. `new` is `made`, plain;
 * `add` what either selects, `subtract` what `there` selects and `made`
 * does not, `intersect` what both select, an inverted `there` read as the
 * canvas outside its outline, so each is right for an inverse too. With
 * nothing selected, `add` is `made`, as `new` is, and `subtract` and
 * `intersect` select nothing, since nothing less anything, or anything
 * shared with nothing, is nothing. What is left keeps `there`'s feather;
 * nothing left is none. Adding over an inverse whose outline `made` covers
 * leaves the whole canvas, an inverse with an empty path (`inverseOf`).
 * The outline is written as the area writes every outline: absolute,
 * straight, closed subpaths, outer ones clockwise and holes the other way,
 * so that `nonzero` is their union (`Region.path`).
 */
export const combineAreas = (
	there: Region | undefined,
	made: string | undefined,
	mode: AreaMode
): Region | undefined => {
	if (made === undefined) return mode === 'new' ? undefined : there;
	if (mode === 'new') return { path: made, inverted: false, feather: 0 };
	if (there === undefined) {
		return mode === 'add' ? { path: made, inverted: false, feather: 0 } : undefined;
	}
	if (mode === 'add') {
		return there.inverted
			? inverseOf(there, differenceOf(there.path, made))
			: { ...there, path: joined(there.path, made) };
	}
	if (mode === 'subtract') {
		return there.inverted
			? { ...there, path: joined(there.path, made) }
			: withPath(there, differenceOf(there.path, made));
	}
	return there.inverted
		? withPath({ ...there, inverted: false }, differenceOf(made, there.path))
		: withPath(there, intersectionOf(there.path, made));
};

/** The outline filled onto a grid that reaches `reach` user units past it; none for an outline with no box. */
const filledAround = (polygons: Polygons, reach: number): Filled | undefined => {
	const box = finiteBox(boundsOf(polygons));
	if (box === undefined) return undefined;
	const grid = gridAround(box, reach);
	return { grid, selected: fillOutline(polygons, grid) };
};

/**
 * A distance in user units as whole cells of the grid: as many units at one
 * a cell, and one cell at least on larger ones, so a Modify… there still
 * does something.
 */
const inCells = (grid: AreaGrid, units: number): number =>
	Math.max(1, Math.round(units / grid.cell));

/** The area's cells grown by `radius`, on a grid that holds them. */
const expanded = (polygons: Polygons, radius: number): Filled | undefined => {
	const filled = filledAround(polygons, radius);
	if (filled === undefined) return undefined;
	const { grid, selected } = filled;
	return { grid, selected: nearOf(selected, grid.width, grid.height, inCells(grid, radius)) };
};

/** The area's cells shrunk by `radius`. */
const contracted = (polygons: Polygons, radius: number): Filled | undefined => {
	const filled = filledAround(polygons, 0);
	if (filled === undefined) return undefined;
	const { grid, selected } = filled;
	return { grid, selected: deepOf(selected, grid.width, grid.height, inCells(grid, radius)) };
};

/** The area's cells smoothed over a square of `radius` either side of each. */
const smoothed = (polygons: Polygons, radius: number): Filled | undefined => {
	const filled = filledAround(polygons, 0);
	if (filled === undefined) return undefined;
	const { grid, selected } = filled;
	return { grid, selected: majorityOf(selected, grid.width, grid.height, inCells(grid, radius)) };
};

/**
 * The band `width` wide on the outline: half of it inside and half outside,
 * the inside taking the odd unit, so a border of 1 is the ring of cells just
 * inside the outline.
 */
const bordered = (polygons: Polygons, width: number): Filled | undefined => {
	const outside = Math.floor(width / 2);
	const filled = filledAround(polygons, outside);
	if (filled === undefined) return undefined;
	const { grid, selected } = filled;
	const out =
		outside === 0
			? selected
			: nearOf(selected, grid.width, grid.height, inCells(grid, outside));
	const inner = deepOf(selected, grid.width, grid.height, inCells(grid, width - outside));
	return { grid, selected: withoutOf(out, inner) };
};

/** The outline of the cells; none where there are none. */
const traced = (filled: Filled | undefined): string | undefined =>
	filled === undefined ? undefined : outlineOf(filled.selected, filled.grid);

/** Modify… on a plain area: the outline itself changed. */
const modifyPlain = (polygons: Polygons, how: AreaModify, radius: number): string | undefined => {
	if (how === 'expand') return traced(expanded(polygons, radius));
	if (how === 'contract') return traced(contracted(polygons, radius));
	if (how === 'smooth') return traced(smoothed(polygons, radius));
	return traced(bordered(polygons, radius));
};

/**
 * Contract on an inverse: the canvas outside the outline expanded; none
 * where that leaves none of the canvas.
 */
const contractInverse = (
	region: Region,
	polygons: Polygons,
	radius: number,
	canvas: Box
): Region | undefined => {
	const grown = expanded(polygons, radius);
	if (grown === undefined) return inverseOf(region, undefined);
	if (holdsBox(grown.selected, grown.grid, canvas)) return undefined;
	return inverseOf(region, traced(grown));
};

/**
 * The area after Modify…: `expand` grows it by `radius` user units all
 * around, by the distance from it, so a corner grows round; `contract`
 * shrinks it by as much; `smooth` takes off what is smaller than a square
 * `radius` either side of each unit and fills what is narrower, as
 * Photoshop's Smooth does, by the majority of that square; `border` is a
 * band `radius` wide centered on the outline, a plain area. `radius` is
 * taken as `modifyRadius` takes it. `canvas` is the drawing's canvas, which
 * an inverted area is the rest of: its expand is the outline contracted and
 * its contract the outline expanded, so the canvas's edge stays where it is;
 * its smooth smooths the outline, and its border is the outline's. Keeps the
 * feather; none where nothing is left.
 */
export const modifyArea = (
	region: Region,
	how: AreaModify,
	radius: number,
	canvas: Box
): Region | undefined => {
	const units = modifyRadius(how, radius);
	const polygons = areaPolygons(region.path);
	if (how === 'border') {
		return withPath({ ...region, inverted: false }, traced(bordered(polygons, units)));
	}
	if (!region.inverted) return withPath(region, modifyPlain(polygons, how, units));
	if (how === 'contract') return contractInverse(region, polygons, units, canvas);
	if (how === 'expand') return inverseOf(region, traced(contracted(polygons, units)));
	return inverseOf(region, traced(smoothed(polygons, units)));
};
