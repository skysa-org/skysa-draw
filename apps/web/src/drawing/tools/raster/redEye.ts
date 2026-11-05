import { cell, SVG_NAMESPACE } from '@skysa/draw-core';

import { t } from '../../../i18n/t.js';
import type { PointerSample, ToolBehavior, ToolContext } from '../types.js';
import { type Box, type Point, rectFrom } from '../vector/geometry.js';
import { type Area, areaMask, areaOf, rectPath, releaseCanvas } from './area.js';
import { guardedSurface, reportFailure } from './guard.js';
import { fixRedEye, type PixelBox, type RedEyeOutcome } from './redEyeFix.js';
import type { RasterSurface } from './surface.js';

/**
 * Photoshop's Red Eye tool on a raster layer (docs/decisions/0004-the-interface.md):
 * a click on a pupil a flash turned red, or a box dragged around one, makes
 * the red found there a dark neutral, by the options' Pupil size and Darken
 * amount, in one command (`redEye.command`). The correction is `fixRedEye`'s
 * (`redEyeFix.ts`), on the layer's own pixels, read and written through its
 * surface, so the layer's `transform` and its pixels per unit are taken into
 * account as every raster tool takes them (`RasterSurface.toPixel`).
 *
 * A click looks for the pupil in a square `CLICK_SEARCH_PX` across on the
 * screen around it, since the user aims at what they see at the zoom they
 * are at, and the pupil it finds may grow to a square `CLICK_REACH` times
 * that, so a pupil larger on screen than the search, at a close zoom, is
 * corrected whole. A drag keeps both to the box it draws, which the overlay
 * shows as the marquee's rectangle; Escape, a second finger or another tool
 * cancels it, and nothing is written.
 *
 * Where an area is selected, a pixel changes by as much as the area covers
 * it. A locked or a hidden layer says so and nothing is written; a press
 * where no red pupil is found, or one found only outside the area, says so
 * too and writes nothing.
 */

/**
 * The square a click looks for a pupil in, in CSS pixels across on the
 * screen: twice a fingertip's width, so a finger that lands on the iris
 * still finds the pupil, and at the zoom a face is worked at, about the
 * width of one eye, so the other eye is seldom in it; and the nearer of the
 * two is taken where both are.
 */
export const CLICK_SEARCH_PX = 100;

/** How many times the search's side a pupil a click found may grow to, in a square around the click. */
const CLICK_REACH = 3;

/** A drag shorter than this on screen, in CSS pixels, either way, was a click, as the marquee's. */
const CLICK_PX = 3;

/** A press under way: the surface and the area it began on, where, and the box shown while it drags. */
interface Press {
	readonly surface: RasterSurface;
	readonly area: Area | undefined;
	readonly start: Point;
	readonly preview: Element;
}

/** Where to look for a pupil and how far it may grow, in user units, and where the user aimed. */
type Search = Readonly<{ search: Box; reach: Box; at: Point }>;

const pointOf = (sample: PointerSample): Point => ({ x: sample.x, y: sample.y });

/** Screen pixels per user unit, never nothing. */
const scaleOf = (context: ToolContext): number =>
	context.viewport.scale > 0 ? context.viewport.scale : 1;

/** A square of `side` around a point. */
const squareAround = (at: Point, side: number): Box => ({
	x: at.x - side / 2,
	y: at.y - side / 2,
	width: side,
	height: side,
});

/** What a press from `start` to `end` searches: a square on screen around a click, or the box a drag drew. */
const searchOf = (context: ToolContext, start: Point, end: Point): Search => {
	const scale = scaleOf(context);
	const box = rectFrom(start, end);
	if (Math.max(box.width, box.height) * scale >= CLICK_PX) {
		const at = { x: box.x + box.width / 2, y: box.y + box.height / 2 };
		return { search: box, reach: box, at };
	}
	const side = CLICK_SEARCH_PX / scale;
	return {
		search: squareAround(start, side),
		reach: squareAround(start, side * CLICK_REACH),
		at: start,
	};
};

/**
 * A box in user units as the whole pixels of the surface it covers, through
 * the layer's map, its `transform` included; kept inside the pixels, and
 * none where it misses them.
 */
const pixelBoxOf = (surface: RasterSurface, box: Box): PixelBox | undefined => {
	const corners = [
		surface.toPixel(box.x, box.y),
		surface.toPixel(box.x + box.width, box.y),
		surface.toPixel(box.x + box.width, box.y + box.height),
		surface.toPixel(box.x, box.y + box.height),
	];
	const xs = corners.map(([x]) => x);
	const ys = corners.map(([, y]) => y);
	const left = Math.max(0, Math.floor(Math.min(...xs)));
	const top = Math.max(0, Math.floor(Math.min(...ys)));
	const right = Math.min(surface.canvas.width, Math.ceil(Math.max(...xs)));
	const bottom = Math.min(surface.canvas.height, Math.ceil(Math.max(...ys)));
	if (right <= left || bottom <= top) return undefined;
	return { x: left, y: top, width: right - left, height: bottom - top };
};

/** How much the area covers each pixel of `region`, as RGBA; none for no area, or where the browser cannot draw its mask. */
const coverageOf = (
	surface: RasterSurface,
	area: Area | undefined,
	region: PixelBox
): Uint8ClampedArray | undefined => {
	if (area === undefined) return undefined;
	const mask = areaMask(surface, area);
	const data = mask
		?.getContext('2d')
		?.getImageData(region.x, region.y, region.width, region.height).data;
	if (mask !== undefined) releaseCanvas(mask);
	return data;
};

/** The line to the user for a press that wrote nothing. */
const NOTICES: Readonly<Record<Exclude<RedEyeOutcome, 'corrected'>, () => string>> = {
	notFound: () => t('redEye.notFound'),
	outsideArea: () => t('redEye.outsideArea'),
};

/**
 * The pupil the press found corrected on the layer's own pixels, once they
 * are decoded, and written by one command; nothing written where nothing
 * changed, and the user told why.
 */
const correct = (context: ToolContext, press: Press, end: Point): void => {
	const { surface, area } = press;
	const { search, reach, at } = searchOf(context, press.start, end);
	const { pupilSize, darken } = context.options;
	const work = surface
		.paint('redEye.command', (ctx) => {
			const region = pixelBoxOf(surface, reach);
			const within = pixelBoxOf(surface, search);
			if (region === undefined || within === undefined) {
				context.notify(NOTICES.notFound());
				return false;
			}
			const image = ctx.getImageData(region.x, region.y, region.width, region.height);
			const [ax, ay] = surface.toPixel(at.x, at.y);
			const result = fixRedEye({
				pixels: image,
				search: { ...within, x: within.x - region.x, y: within.y - region.y },
				at: { x: ax - region.x, y: ay - region.y },
				pupilSize,
				darken,
				coverage: coverageOf(surface, area, region),
			});
			if (result.outcome !== 'corrected') {
				context.notify(NOTICES[result.outcome]());
				return false;
			}
			image.data.set(result.data);
			ctx.putImageData(image, region.x, region.y);
			return true;
		})
		.catch((error: unknown) => reportFailure(context, surface, error));
	context.document.pending(work);
};

export const redEyeBehavior = (): ToolBehavior => {
	const active = cell<Press | undefined>(undefined);

	const cancel = (): void => {
		active.current?.preview.remove();
		active.current = undefined;
	};

	return {
		begin: (context, sample) => {
			cancel();
			const surface = guardedSurface(context);
			if (surface === undefined) return;
			const preview = context.overlay.ownerDocument.createElementNS(SVG_NAMESPACE, 'path');
			preview.setAttribute('class', 'viewport-area-drag');
			preview.setAttribute('fill-rule', 'nonzero');
			preview.setAttribute('vector-effect', 'non-scaling-stroke');
			preview.setAttribute('pointer-events', 'none');
			context.overlay.appendChild(preview);
			active.current = { surface, area: areaOf(context), start: pointOf(sample), preview };
		},
		move: (_context, sample) => {
			const press = active.current;
			if (press === undefined) return;
			press.preview.setAttribute('d', rectPath(rectFrom(press.start, pointOf(sample))) ?? '');
		},
		end: (context, sample) => {
			const press = active.current;
			if (press === undefined) return;
			cancel();
			correct(context, press, pointOf(sample));
		},
		cancel,
	};
};
