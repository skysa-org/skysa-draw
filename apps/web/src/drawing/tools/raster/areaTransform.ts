import {
	apply,
	type Box,
	boxContains,
	IDENTITY,
	type Mat,
	type Point,
	translate,
} from '../vector/geometry.js';
import {
	anchorOf,
	type Handle,
	handlePositions,
	HANDLES,
	resizeMatrix,
	rotateMatrix,
} from '../vector/selection.js';
import { areaPolygons, boundsOf } from './area.js';
import { heldMove } from './pixels.js';

/**
 * Transform selection (docs/decisions/0004-the-interface.md, "Transform
 * selection"): the area's outline, not its pixels, moved, scaled and rotated
 * by a box with handles, as Photoshop's Select › Transform Selection does.
 * The outline is absolute, straight and closed, `M`, `L` and `Z` as the area
 * writes it (`area.ts`), so an affine map of every corner is the map of the
 * outline, exactly. The math is here and pure; the mode that drags it is the
 * viewport's (`viewport/areaTransform.ts`).
 *
 * The box is the select tool's (`tools/vector/selection.ts`): the box around
 * the outline as it is now, its eight handles and the rotate handle above,
 * dragged as the select tool drags its own, Shift keeping the ratio and
 * snapping a rotation to 15°. Alt scales about the box's middle, as the
 * marquee draws from its middle with Alt, and Shift holds a move across,
 * down or at 45°, as a drag of the outline with the marquee does. Since a
 * finger is wider than a handle, each handle takes a press 44 px across on
 * the screen, the nearest winning, and the middle half of the box always
 * moves, so a box too small on the screen for its handles is still moved.
 */

/** The area's outline as its corners, subpath by subpath (`areaPolygons`). */
export type Outline = readonly (readonly Point[])[];

/** What a press takes hold of: a handle, the inside of the box to move it, or outside it to rotate. */
export type Grip = Handle | 'move';

/** Half a handle's target on the screen, in CSS pixels: 44 px across, a finger's, for every pointer. */
const GRIP_PX = 22;

/** A coordinate as the area writes it: two decimals, never `-0`. */
const fmt = (n: number): string => {
	const rounded = Math.round(n * 100) / 100;
	return String(rounded === 0 ? 0 : rounded);
};

/** Two matrices the same, as far as a drag can tell. */
export const sameMatrix = (a: Mat, b: Mat): boolean =>
	a.every((value, i) => Math.abs(value - (b[i] ?? 0)) < 1e-9);

const subpathOf = (points: readonly Point[]): string => {
	const [first, ...rest] = points;
	if (first === undefined) return '';
	return `M ${fmt(first.x)} ${fmt(first.y)} ${rest.map((p) => `L ${fmt(p.x)} ${fmt(p.y)}`).join(' ')} Z`;
};

/**
 * The outline after `matrix`, written as the area writes it, and the box
 * around it. A map that mirrors, a handle dragged past the one across from
 * it, would turn every subpath the other way; each is walked back, so an
 * outline stays clockwise and a hole in it the other way, and a subpath
 * Shift adds later is still a union (`addToArea`).
 */
export const placeOutline = (
	outline: Outline,
	matrix: Mat
): Readonly<{ path: string; box: Box | undefined }> => {
	const [a, b, c, d] = matrix;
	const mirrored = a * d - b * c < 0;
	const placed = outline.map((polygon) => {
		const points = polygon.map((p) => apply(matrix, p));
		return mirrored ? [...points].reverse() : points;
	});
	return { path: placed.map(subpathOf).join(' '), box: boundsOf(placed) };
};

/** An area's outline, `d` in the area's grammar, after `matrix`. */
export const transformPath = (d: string, matrix: Mat): string =>
	placeOutline(areaPolygons(d), matrix).path;

/** The box around an area's outline; none for one with no subpath. */
export const outlineBox = (d: string): Box | undefined =>
	placeOutline(areaPolygons(d), IDENTITY).box;

const centerOf = (box: Box): Point => ({ x: box.x + box.width / 2, y: box.y + box.height / 2 });

/** The middle half of a box, where a press always moves it. */
const middleOf = (box: Box): Box => ({
	x: box.x + box.width / 4,
	y: box.y + box.height / 4,
	width: box.width / 2,
	height: box.height / 2,
});

/**
 * What a press at `point` takes hold of, in the drawing's units, with the
 * box drawn around `box` at `scale` screen pixels a unit: the middle half of
 * the box moves; else the nearest handle within `GRIP_PX` of the press on
 * the screen either way; else the rest of the box moves and outside it
 * rotates, as in Photoshop.
 */
export const gripAt = (box: Box, point: Point, scale: number): Grip => {
	if (boxContains(middleOf(box), point)) return 'move';
	const reach = GRIP_PX / scale;
	const positions = handlePositions(box, scale);
	const near = HANDLES.map((handle) => {
		const at = positions[handle];
		return { handle, dx: Math.abs(point.x - at.x), dy: Math.abs(point.y - at.y) };
	})
		.filter(({ dx, dy }) => dx <= reach && dy <= reach)
		.reduce<{ handle: Handle; distance: number } | undefined>(
			(best, { handle, dx, dy }) =>
				best === undefined || Math.hypot(dx, dy) < best.distance
					? { handle, distance: Math.hypot(dx, dy) }
					: best,
			undefined
		);
	if (near !== undefined) return near.handle;
	return boxContains(box, point) ? 'move' : 'rotate';
};

/** A drag of the box: what it took hold of, the box then, and where it began, in the drawing's units. */
export type GripDrag = Readonly<{ grip: Grip; box: Box; from: Point }>;

/** The keys a drag reads, at each of its samples, so one pressed or let go during it counts at once. */
export type DragKeys = Readonly<{ shiftKey: boolean; altKey: boolean }>;

/**
 * What a drag from `drag.from` to `to` does to the outline, in the drawing's
 * units: a move, Shift holding it across, down or at 45°; a rotation about
 * the box's middle, Shift snapping it to 15°; or a resize about the side or
 * corner across, or about the middle with Alt, Shift keeping the ratio.
 */
export const gripMatrix = (drag: GripDrag, to: Point, keys: DragKeys, scale: number): Mat => {
	const { grip, box, from } = drag;
	if (grip === 'move') {
		const [dx, dy] = [to.x - from.x, to.y - from.y];
		const by = keys.shiftKey ? heldMove(dx, dy) : { x: dx, y: dy };
		return translate(by.x, by.y);
	}
	if (grip === 'rotate') return rotateMatrix({ from, center: centerOf(box) }, to, keys.shiftKey);
	const anchor = keys.altKey ? centerOf(box) : anchorOf(box, grip, scale);
	return resizeMatrix({ from, handle: grip, anchor }, to, keys.shiftKey);
};

/**
 * The cursor over what a press would take hold of. The box is always the one
 * around the outline as it is, square to the screen, so a side's cursor is
 * always the side's. CSS has no cursor for a rotation; the crosshair says
 * that the press is outside the box.
 */
export const GRIP_CURSORS: Readonly<Record<Grip, string>> = {
	nw: 'nwse-resize',
	se: 'nwse-resize',
	ne: 'nesw-resize',
	sw: 'nesw-resize',
	n: 'ns-resize',
	s: 'ns-resize',
	e: 'ew-resize',
	w: 'ew-resize',
	move: 'move',
	rotate: 'crosshair',
};
