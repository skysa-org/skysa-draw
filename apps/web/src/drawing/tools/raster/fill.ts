import { t } from '../../../i18n/t.js';
import type { ToolBehaviour } from '../types.js';
import { inkOf } from '../vector/svg.js';
import { type Area, areaMask, areaOf } from './area.js';
import { guardedSurface, reportFailure } from './guard.js';
import { floodFill, parseColour, type Rgba, toCss } from './pixels.js';
import { type RasterSurface, surfaceFor } from './surface.js';

/**
 * The fill and the eyedropper on a raster layer
 * (docs/decisions/0004-the-interface.md): a flood fill from the point, and
 * the colour of the pixel under it. Both wait for the layer's picture to be
 * decoded, so both are a promise; the fill's is work a save waits for, the
 * eyedropper's is not.
 */

const BLACK: Rgba = [0, 0, 0, 255];

const nothing = (): void => undefined;

/** A pixel at least half inside the area is in it, for a fill, which has no soft edge. */
const HALF = 128;

/**
 * Which pixels a fill may reach, by index: every one with no area selected;
 * with one, those it covers, which makes its edge a wall. Where the browser
 * cannot draw the area's mask (jsdom), every one.
 */
const insideOf = (
	surface: RasterSurface,
	area: Area | undefined
): ((index: number) => boolean) | undefined => {
	if (area === undefined) return undefined;
	const mask = areaMask(surface, area);
	const data = mask
		?.getContext('2d')
		?.getImageData(0, 0, surface.canvas.width, surface.canvas.height).data;
	if (data === undefined) return undefined;
	return (index) => (data[index * 4 + 3] ?? 0) >= HALF;
};

export const fill: ToolBehaviour = {
	begin: (context, sample) => {
		const surface = guardedSurface(context);
		if (surface === undefined) return;
		const colour = parseColour(inkOf(context.options, 'fill')) ?? BLACK;
		const { tolerance } = context.options;
		const area = areaOf(context);
		// An area with no inside takes no paint.
		if (area !== undefined && area.bounds === undefined) return;
		// On the layer's pixels themselves, not the stroke canvas: a fill
		// replaces what is there rather than compositing over it. A fill that
		// changed no pixel writes nothing, and one from outside the area
		// changes none.
		const work = surface
			.paint('tools.fill', (ctx) => {
				const [px, py] = surface.toPixel(sample.x, sample.y);
				const image = ctx.getImageData(0, 0, surface.canvas.width, surface.canvas.height);
				const changed = floodFill(
					image.data,
					image.width,
					image.height,
					px,
					py,
					colour,
					tolerance,
					insideOf(surface, area)
				);
				if (changed > 0) ctx.putImageData(image, 0, 0);
				return changed > 0;
			})
			.catch((error: unknown) => reportFailure(context, surface, error));
		context.document.pending(work);
	},
	move: nothing,
	end: nothing,
	cancel: nothing,
};

export const eyedropper: ToolBehaviour = {
	begin: (context, sample) => {
		if (context.layer === undefined) {
			context.notify(t('layers.noneActive'));
			return;
		}
		// Reading needs no permission: a locked or a hidden layer still has colours.
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
				// A transparent pixel has no colour to take.
				if (rgba[3] === 0) return;
				context.setColour(which, toCss(rgba));
			})
			.catch(nothing);
	},
	move: nothing,
	end: nothing,
	cancel: nothing,
};
