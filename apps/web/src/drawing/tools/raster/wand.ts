import { cell } from '@skysa/storage';

import { t } from '../../../i18n/t.js';
import { areaModeOf } from '../../keys.js';
import type { PointerSample, ToolBehavior, ToolContext } from '../types.js';
import { invert } from '../vector/geometry.js';
import { affineOf } from './area.js';
import { guardedLayer } from './guard.js';
import { colorDistance, type Rgba } from './pixels.js';
import { selectArea } from './region.js';
import { surfaceFor } from './surface.js';
import { outlinePath, type PixelMask, traceMask } from './trace.js';

/**
 * The magic wand on a raster layer (docs/decisions/0004-the-interface.md:
 * "Select pixels of a color"), as Photoshop's: a click selects the pixels
 * whose color is within `tolerance` of the one clicked, by the fill's own
 * distance (`colorDistance`, alpha with the rest), so a click on a
 * transparent pixel selects the transparent pixels there. With `contiguous`
 * on, only those joined to it by their sides, as the fill floods; off, every
 * such pixel of the layer. The pixels are the active layer's alone.
 *
 * What is selected becomes the area selection, as the marquee makes it: its
 * outline traced along the pixels' edges (`trace.ts`) and taken into the
 * drawing's user units through the inverse of the layer's own map
 * (`RasterSurface.toPixel`, its `transform` included), so the ants sit on the
 * pixels' edges wherever the layer is. It meets the area there in the
 * click's mode as the marquee's outline does (`selectArea`): a new plain
 * area, or added to, subtracted from or intersected with the one there, by
 * the option or by Shift, Alt or both held as the press began
 * (`areaModeOf`). A click outside the layer's pixels selects nothing, which
 * deselects in a new selection, as in Photoshop, and leaves the area in the
 * other modes. The edge is hard, a pixel in or out: there is no anti-alias.
 *
 * It only reads, so a locked layer may be selected from; a hidden one may not,
 * as the fill and the eyedropper read none, since what would be selected
 * cannot be seen. Selection is not part of the history: no command is written.
 */

/**
 * Past this many corners an outline is refused rather than made: a path of
 * some twelve megabytes, which every stroke inside the area reads again, and
 * the ants draw. A click on a photograph of two thousand pixels a side makes
 * a few hundred thousand; what reaches this is a picture of specks with
 * `contiguous` off, where the outline is more corners than the picture has
 * pixels.
 */
export const WAND_MAX_CORNERS = 1_000_000;

/** The pixels as the canvas gives them: RGBA, row by row. */
export type Pixels = Readonly<{ data: Uint8ClampedArray; width: number; height: number }>;

const colorAt = (data: Uint8ClampedArray, index: number): Rgba => [
	data[index * 4] ?? 0,
	data[index * 4 + 1] ?? 0,
	data[index * 4 + 2] ?? 0,
	data[index * 4 + 3] ?? 0,
];

/* eslint-disable functional/immutable-data -- the mask is filled in place over a queue the size of the picture, as the fill's flood is; a copy per pixel would be the whole picture */
/**
 * The pixels joined to `seed` by their sides, through pixels that are `near`:
 * a breadth-first walk over a queue the size of the picture, as the fill
 * floods (`floodFill`), every pixel tested once and nothing recursing.
 */
const flood = (
	width: number,
	height: number,
	seed: number,
	near: (index: number) => boolean
): Uint8Array => {
	const count = width * height;
	const selected = new Uint8Array(count);
	const tested = new Uint8Array(count);
	const queue = new Uint32Array(count);
	// [the queue's length]
	const tally = new Uint32Array(1);
	const consider = (index: number): void => {
		if (tested[index] === 1) return;
		tested[index] = 1;
		if (!near(index)) return;
		queue[tally[0] ?? 0] = index;
		tally[0] = (tally[0] ?? 0) + 1;
	};
	consider(seed);
	queue.some((index, position) => {
		if (position >= (tally[0] ?? 0)) return true;
		selected[index] = 1;
		const x = index % width;
		if (x > 0) consider(index - 1);
		if (x + 1 < width) consider(index + 1);
		if (index >= width) consider(index - width);
		if (index + width < count) consider(index + width);
		return false;
	});
	return selected;
};
/* eslint-enable functional/immutable-data */

/**
 * The pixels the wand selects from `(x, y)`, in the layer's pixels: those
 * whose color is within `tolerance` (0 to 1, `colorDistance`) of the one
 * there, joined to it by their sides where `contiguous`, else wherever they
 * are. Never empty, since the pixel clicked is always selected; none for a
 * point outside the pixels.
 */
export const wandMask = (
	pixels: Pixels,
	x: number,
	y: number,
	tolerance: number,
	contiguous: boolean
): PixelMask | undefined => {
	const { data, width, height } = pixels;
	const px = Math.floor(x);
	const py = Math.floor(y);
	if (!(px >= 0 && py >= 0 && px < width && py < height)) return undefined;
	const seed = py * width + px;
	const target = colorAt(data, seed);
	const reach = Math.max(0, tolerance);
	const near = (index: number): boolean => colorDistance(colorAt(data, index), target) <= reach;
	const selected = contiguous
		? flood(width, height, seed, near)
		: new Uint8Array(width * height).map((_, index) => (near(index) ? 1 : 0));
	return { selected, width, height };
};

const nothing = (): undefined => undefined;

/**
 * A tool that acts on a click, where the pointer was pressed, once it lifts:
 * so a press a second finger turns into a pinch, or Escape cancels, selects
 * nothing. The keys are read as the press began, as the marquee reads them.
 */
export const onRelease = (
	act: (context: ToolContext, sample: PointerSample) => void
): ToolBehavior => {
	const pressed = cell<PointerSample | undefined>(undefined);
	return {
		begin: (_context, sample) => {
			pressed.current = sample;
		},
		move: nothing,
		end: (context) => {
			const sample = pressed.current;
			pressed.current = undefined;
			if (sample !== undefined) act(context, sample);
		},
		cancel: () => {
			pressed.current = undefined;
		},
	};
};

/**
 * The area the wand makes from a click: once the layer's picture is
 * decoded, its pixels read, the mask made and traced, and the area met with
 * it in the click's mode. A picture that would not decode says so, and so
 * does an outline past `WAND_MAX_CORNERS`; neither changes the area.
 */
const selectFrom = (context: ToolContext, sample: PointerSample): void => {
	if (guardedLayer(context, 'read') === undefined) return;
	const surface = surfaceFor(context);
	if (surface === undefined) return;
	const { tolerance, contiguous } = context.options;
	const mode = areaModeOf(sample, context.options.areaMode);
	surface.ready
		.then(() => {
			const ctx = surface.canvas.getContext('2d');
			// Without a 2D context (jsdom) there are no pixels to read.
			if (ctx === null) return;
			if (!surface.readable()) {
				context.notify(t('tools.wandUnreadable'));
				return;
			}
			const { width, height } = surface.canvas;
			const [x, y] = surface.toPixel(sample.x, sample.y);
			const mask = wandMask(
				ctx.getImageData(0, 0, width, height),
				x,
				y,
				tolerance,
				contiguous
			);
			if (mask === undefined) {
				selectArea(context, undefined, mode);
				return;
			}
			const outline = traceMask(mask);
			if (outline.corners.length > WAND_MAX_CORNERS) {
				context.notify(t('tools.wandTooDetailed'));
				return;
			}
			const path = outlinePath(outline, invert(affineOf(surface.toPixel)));
			selectArea(context, path, mode);
		})
		.catch(() => context.notify(t('tools.wandUnreadable')));
};

export const wandBehavior = (): ToolBehavior => onRelease(selectFrom);
