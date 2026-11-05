import { RASTER_MAX_SIDE } from '@skysa/draw-core';

import type { Box } from '../vector/geometry.js';
import { type Bounds, type PixelGrid, pixelGrid } from './pixels.js';

/**
 * How a raster layer's pixels grow to hold what is written past them
 * (docs/ARCHITECTURE.md §3, "Layers"; §7, "The editor"), with no canvas in it,
 * so it runs and is tested in Node. A layer's pixels are its `<image>`'s
 * grid; a stroke, a fill or a move that lands beyond it grows the grid, as
 * Photoshop's layer has no edge of its own: in the layer's own pixels, at the
 * same pixels per unit, by whole pixels, the pixels already there kept where
 * they are and as they are. The boxes here are in the pixels of the grid the
 * layer had when its surface was made, its frame: pixel (0, 0) is that
 * grid's first, and a grid grown left or up starts at a negative one.
 */

type Size = Readonly<{ width: number; height: number }>;

/** Below this a float is the same whole number, whatever arithmetic made it. */
const SLACK = 1e-9;

/** The whole pixels a box touches: its left and top edges floored, its right and bottom ceiled. */
export const wholePixels = (box: Box): Box => {
	const left = Math.floor(box.x + SLACK);
	const top = Math.floor(box.y + SLACK);
	const right = Math.ceil(box.x + box.width - SLACK);
	const bottom = Math.ceil(box.y + box.height - SLACK);
	return { x: left, y: top, width: Math.max(0, right - left), height: Math.max(0, bottom - top) };
};

/** What two boxes share; none where they share no pixel. */
export const intersect = (a: Box, b: Box): Box | undefined => {
	const left = Math.max(a.x, b.x);
	const top = Math.max(a.y, b.y);
	const right = Math.min(a.x + a.width, b.x + b.width);
	const bottom = Math.min(a.y + a.height, b.y + b.height);
	return right > left && bottom > top
		? { x: left, y: top, width: right - left, height: bottom - top }
		: undefined;
};

/** Whether `inner` is wholly inside `outer`. */
export const holdsBox = (outer: Box, inner: Box): boolean =>
	inner.x >= outer.x &&
	inner.y >= outer.y &&
	inner.x + inner.width <= outer.x + outer.width &&
	inner.y + inner.height <= outer.y + outer.height;

export const sameBox = (a: Box, b: Box): boolean =>
	a.x === b.x && a.y === b.y && a.width === b.width && a.height === b.height;

/** A box moved by `dx` and `dy`. */
export const shiftBox = (box: Box, dx: number, dy: number): Box => ({
	...box,
	x: box.x + dx,
	y: box.y + dy,
});

/** A box larger by `by` on every side. */
export const padded = (box: Box, by: number): Box => ({
	x: box.x - by,
	y: box.y - by,
	width: box.width + 2 * by,
	height: box.height + 2 * by,
});

/** The box around two. */
export const joinBoxes = (a: Box, b: Box): Box => {
	const left = Math.min(a.x, b.x);
	const top = Math.min(a.y, b.y);
	return {
		x: left,
		y: top,
		width: Math.max(a.x + a.width, b.x + b.width) - left,
		height: Math.max(a.y + a.height, b.y + b.height) - top,
	};
};

/**
 * The most pixels across and down a layer's grid may have and keep its
 * pixels per unit, so that the grown `<image>` read back gives the same grid
 * (`pixelGrid`): `maxSide` units on the longer side at one pixel a unit, and
 * past `RASTER_MAX_SIDE`, where a layer has fewer pixels than units, no more
 * units on either side than it has on its longer one. Never fewer than it has.
 */
export const mostPixels = (bounds: Bounds, grid: PixelGrid, maxSide = RASTER_MAX_SIDE): Size => ({
	width: grid.width + Math.max(0, Math.floor(maxSide - bounds.width * grid.ppu + SLACK)),
	height: grid.height + Math.max(0, Math.floor(maxSide - bounds.height * grid.ppu + SLACK)),
});

/**
 * The `<image>`'s geometry once its grid is `box`, in the frame of the grid
 * `grid` of `bounds` began as: moved by as many units as the grid grew left
 * and up, and larger by as many as it grew in all. Worked from the first
 * bounds every time, so growing twice is growing once, to the unit.
 */
export const boundsAt = (bounds: Bounds, grid: PixelGrid, box: Box): Bounds => ({
	x: bounds.x + box.x / grid.ppu,
	y: bounds.y + box.y / grid.ppu,
	width: bounds.width + (box.width - grid.width) / grid.ppu,
	height: bounds.height + (box.height - grid.height) / grid.ppu,
});

/** Whether the bounds of `box` read back as `box`'s own grid, at the pixels per unit the layer has. */
export const keepsGrid = (bounds: Bounds, grid: PixelGrid, box: Box): boolean => {
	const read = pixelGrid(boundsAt(bounds, grid, box));
	return read.width === box.width && read.height === box.height;
};

/**
 * One axis of `held`: `[start, end)` holding `kept`, and as much of `wanted`
 * as `limit` pixels allow, `prefer` among it first where it all cannot fit.
 */
const heldAxis = (
	kept: readonly [number, number],
	wanted: readonly [number, number],
	prefer: readonly [number, number],
	limit: number
): readonly [number, number] => {
	const start = Math.min(kept[0], wanted[0]);
	const end = Math.max(kept[1], wanted[1]);
	if (end - start <= limit) return [start, end];
	const keepsPreferred = Math.max(kept[1], prefer[1]) - limit <= Math.min(kept[0], prefer[0]);
	const lowest = keepsPreferred ? Math.max(kept[1], prefer[1]) - limit : kept[1] - limit;
	const at = Math.max(lowest, start);
	return [at, at + limit];
};

/**
 * The box a layer's grid grows to for `wanted`: the box around it and
 * `kept`, the pixels the layer has, held to `limit` pixels either way
 * (`mostPixels`), where the part of `wanted` past that is let go, and
 * `prefer`, a part of it, kept first. Never smaller than `kept`.
 */
export const heldTo = (kept: Box, wanted: Box, limit: Size, prefer: Box = wanted): Box => {
	const [left, right] = heldAxis(
		[kept.x, kept.x + kept.width],
		[wanted.x, wanted.x + wanted.width],
		[prefer.x, prefer.x + prefer.width],
		Math.max(limit.width, kept.width)
	);
	const [top, bottom] = heldAxis(
		[kept.y, kept.y + kept.height],
		[wanted.y, wanted.y + wanted.height],
		[prefer.y, prefer.y + prefer.height],
		Math.max(limit.height, kept.height)
	);
	return { x: left, y: top, width: right - left, height: bottom - top };
};

/** What of `region` is outside `kept`, as up to four boxes: above it, below it, left and right of it. */
export const outside = (region: Box, kept: Box): readonly Box[] => {
	const shared = intersect(region, kept);
	if (shared === undefined) return [region];
	const right = region.x + region.width;
	const bottom = region.y + region.height;
	const sharedRight = shared.x + shared.width;
	const sharedBottom = shared.y + shared.height;
	return [
		{ x: region.x, y: region.y, width: region.width, height: shared.y - region.y },
		{ x: region.x, y: sharedBottom, width: region.width, height: bottom - sharedBottom },
		{ x: region.x, y: shared.y, width: shared.x - region.x, height: shared.height },
		{ x: sharedRight, y: shared.y, width: right - sharedRight, height: shared.height },
	].filter((box) => box.width > 0 && box.height > 0);
};

/** The bits of a pixel, read as one 32-bit number from RGBA bytes, that are its alpha. */
const ALPHA_BITS = new Uint8Array(new Uint32Array([1]).buffer)[0] === 1 ? 0xff000000 : 0x000000ff;

const inked = (pixel: number): boolean => (pixel & ALPHA_BITS) !== 0;

/**
 * The box around the pixels with any alpha in `data`, RGBA rows `box.width`
 * wide, as `getImageData` gives them for `box`; none where every one is
 * clear. Read a pixel at a time, rows from either end and then columns, so a
 * box with ink near its edges is read only that far.
 */
export const inkExtent = (data: Uint8ClampedArray, box: Box): Box | undefined => {
	const pixels = new Uint32Array(data.buffer, data.byteOffset, box.width * box.height);
	const first = pixels.findIndex(inked);
	if (first < 0) return undefined;
	const last = pixels.findLastIndex(inked);
	const top = Math.floor(first / box.width);
	const bottom = Math.floor(last / box.width);
	const rows = Array.from({ length: bottom - top + 1 }, (_, i) =>
		pixels.subarray((top + i) * box.width, (top + i + 1) * box.width)
	);
	const left = rows.reduce((least, row) => {
		const at = row.findIndex(inked);
		return at < 0 ? least : Math.min(least, at);
	}, box.width);
	const right = rows.reduce((most, row) => Math.max(most, row.findLastIndex(inked)), -1);
	return { x: box.x + left, y: box.y + top, width: right - left + 1, height: bottom - top + 1 };
};
