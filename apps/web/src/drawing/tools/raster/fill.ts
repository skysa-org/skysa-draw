import { t } from '../../../i18n/t.js';
import type { ToolBehavior } from '../types.js';
import { inkOf } from '../vector/svg.js';
import { type Area, areaMask, areaOf, releaseCanvas } from './area.js';
import { guardedSurface, reportFailure } from './guard.js';
import { floodFill, parseColor, type Rgba, toCss } from './pixels.js';
import { type RasterSurface, type Room, surfaceFor } from './surface.js';

/**
 * The fill and the eyedropper on a raster layer
 * (docs/decisions/0004-the-interface.md): a flood fill from the point, and
 * the color of the pixel under it. Both wait for the layer's picture to be
 * decoded, so both are a promise; the fill's is work a save waits for, the
 * eyedropper's is not.
 */

const BLACK: Rgba = [0, 0, 0, 255];

const nothing = (): void => undefined;

/**
 * How much of each pixel, by index, a fill may lay its color on: all of
 * every one with no area selected; with one, as much as it covers, so the
 * fill fades over a feathered edge, takes in an inverse's outside and not
 * its hole, and stops at the edge, which is a wall. Where the browser cannot
 * draw the area's mask (jsdom), every one. A pixel no write may land on, off
 * both the layer's own and the drawing's canvas (`Room`), is a wall too.
 */
const coverOf = (
	surface: RasterSurface,
	area: Area | undefined,
	room: Room
): ((index: number) => number) | undefined => {
	const { width, height } = surface.canvas;
	const mask = area === undefined ? undefined : areaMask(surface, area);
	const data = mask?.getContext('2d')?.getImageData(0, 0, width, height).data;
	if (mask !== undefined) releaseCanvas(mask);
	const covered =
		data === undefined ? undefined : (index: number) => (data[index * 4 + 3] ?? 0) / 255;
	if (room.everywhere) return covered;
	const holds = (index: number): boolean => room.holds(index % width, Math.floor(index / width));
	return covered === undefined
		? (index) => (holds(index) ? 1 : 0)
		: (index) => (holds(index) ? covered(index) : 0);
};

/**
 * The fill on a raster layer, as Photoshop's paint bucket: the drawing's
 * canvas outside the layer's pixels is transparent pixels of the layer, so a
 * press there, or on a transparent pixel joined to it, floods them across
 * the canvas, and the layer's pixels grow to hold what was filled
 * (`RasterSurface`). A press off the canvas and the pixels fills nothing.
 */
export const fill: ToolBehavior = {
	begin: (context, sample) => {
		const surface = guardedSurface(context);
		if (surface === undefined) return;
		const color = parseColor(inkOf(context.options, 'fill')) ?? BLACK;
		const { tolerance } = context.options;
		const area = areaOf(context);
		// An area with no inside takes no paint.
		if (area !== undefined && area.bounds === undefined) return;
		// On the layer's pixels themselves, not the stroke canvas: a fill
		// replaces what is there rather than compositing over it. A fill that
		// changed no pixel writes nothing, and one from outside the area
		// changes none.
		const work = surface
			.paint(
				'tools.fill',
				(ctx, room) => {
					const [px, py] = surface.toPixel(sample.x, sample.y);
					const { width, height } = surface.canvas;
					const image = ctx.getImageData(0, 0, width, height);
					const changed = floodFill(
						image.data,
						image.width,
						image.height,
						px,
						py,
						color,
						tolerance,
						coverOf(surface, area, room)
					);
					if (changed > 0) ctx.putImageData(image, 0, 0);
					return changed > 0;
				},
				{ reach: () => surface.paintRoom() }
			)
			.catch((error: unknown) => reportFailure(context, surface, error));
		context.document.pending(work);
	},
	move: nothing,
	end: nothing,
	cancel: nothing,
};

export const eyedropper: ToolBehavior = {
	begin: (context, sample) => {
		if (context.layer === undefined) {
			context.notify(t('layers.noneActive'));
			return;
		}
		// Reading needs no permission: a locked or a hidden layer still has colors.
		const surface = surfaceFor(context);
		if (surface === undefined) return;
		const which = sample.altKey ? 'stroke' : 'fill';
		surface.ready
			.then(() => {
				const ctx = surface.canvas.getContext('2d');
				if (ctx === null) return;
				const [x, y] = surface.toPixel(sample.x, sample.y);
				const px = Math.floor(x);
				const py = Math.floor(y);
				if (px < 0 || py < 0 || px >= surface.canvas.width || py >= surface.canvas.height) {
					return;
				}
				const { data } = ctx.getImageData(px, py, 1, 1);
				const rgba: Rgba = [data[0] ?? 0, data[1] ?? 0, data[2] ?? 0, data[3] ?? 0];
				// A transparent pixel has no color to take.
				if (rgba[3] === 0) return;
				context.setColor(which, toCss(rgba));
			})
			.catch(nothing);
	},
	move: nothing,
	end: nothing,
	cancel: nothing,
};
