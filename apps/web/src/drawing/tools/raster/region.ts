import { cell, SVG_NAMESPACE } from '@skysa/draw-core';

import type { PointerSample, ToolBehaviour, ToolContext, ToolOptions } from '../types.js';
import { type Box, constrainRect, type Point, rectFrom, simplify } from '../vector/geometry.js';
import { addToArea, areaOf, areaPixelBox, clipToArea, polygonPath, rectPath } from './area.js';
import { guardedSurface, reportFailure } from './guard.js';

/**
 * The marquee and the lasso (docs/decisions/0004-the-interface.md: "Select
 * pixels in a region" on a raster layer, "Select elements in a region" on a
 * vector one), and Delete with an area selected. One drag makes the area for
 * both kinds of layer, with a preview on the overlay: the marquee a rectangle
 * from corner to corner, kept square by the constrain option and drawn from
 * its centre with Alt; the lasso a freehand outline, closed where the pointer
 * lifts and simplified by Ramer–Douglas–Peucker (`simplify`). What the area
 * then is, is the layer's: on a raster layer it is set (`ToolContext.region`)
 * and outlives the tool, and the raster tools paint inside it; on a vector
 * layer it selects elements (`tools/vector/region.ts`).
 *
 * Shift held as the drag begins adds the new area to the one there, as a
 * second subpath, which under `nonzero` is the union of the two
 * (`addToArea`). Subtracting with Alt, as Photoshop does, would take the
 * difference of two arbitrary paths, which no fill rule gives; it is not
 * here, and Alt is the marquee's from-the-centre at any time. Shift pressed
 * after the drag began keeps the marquee square, unless it began the drag:
 * that Shift is adding.
 */

type AreaKind = 'marquee' | 'lasso';

interface Drag {
	readonly start: Point;
	/** The lasso's points so far; the marquee needs only where it began. */
	readonly points: readonly Point[];
	/** Whether Shift was held as the drag began: the area made is added to the one there. */
	readonly adding: boolean;
	readonly preview: Element;
}

/** What a drag that ended does with the area it made: none for a click. */
type AreaMade = (context: ToolContext, path: string | undefined, adding: boolean) => void;

/** A drag shorter than this on screen, in CSS pixels, either way, was a click. */
const CLICK_PX = 3;

/** How far a lasso's point may stray from the line its neighbours make and be let go, in CSS pixels. */
const LASSO_SLACK_PX = 0.5;

const pointOf = (sample: PointerSample): Point => ({ x: sample.x, y: sample.y });

/** The marquee's rectangle, from where the drag began to the pointer. */
const marqueeBox = (
	start: Point,
	sample: PointerSample,
	options: ToolOptions,
	adding: boolean
): Box => {
	const square = options.constrain || (sample.shiftKey && !adding);
	const end = constrainRect(start, pointOf(sample), square);
	if (!sample.altKey) return rectFrom(start, end);
	const dx = Math.abs(end.x - start.x);
	const dy = Math.abs(end.y - start.y);
	return { x: start.x - dx, y: start.y - dy, width: 2 * dx, height: 2 * dy };
};

/** The longer side of the box round the points: how far the drag went either way. */
const extentOf = (points: readonly Point[]): number => {
	const xs = points.map((p) => p.x);
	const ys = points.map((p) => p.y);
	return Math.max(Math.max(...xs) - Math.min(...xs), Math.max(...ys) - Math.min(...ys));
};

/** The lasso's outline so far, open: it closes where the pointer lifts. */
const lassoPreview = (points: readonly Point[]): string => {
	const [first, ...rest] = points;
	if (first === undefined) return '';
	return `M ${first.x} ${first.y} ${rest.map((p) => `L ${p.x} ${p.y}`).join(' ')}`;
};

/** Screen pixels per user unit, never nothing. */
const scaleOf = (context: ToolContext): number =>
	context.viewport.scale > 0 ? context.viewport.scale : 1;

/** The closed path the drag made, in user units; none for a click, or an outline with no inside. */
const madeBy = (
	kind: AreaKind,
	drag: Drag,
	sample: PointerSample,
	context: ToolContext
): string | undefined => {
	const scale = scaleOf(context);
	if (kind === 'marquee') {
		const box = marqueeBox(drag.start, sample, context.options, drag.adding);
		if (Math.max(box.width, box.height) * scale < CLICK_PX) return undefined;
		return rectPath(box);
	}
	const points = [...drag.points, pointOf(sample)];
	if (extentOf(points) * scale < CLICK_PX) return undefined;
	return polygonPath(simplify(points, LASSO_SLACK_PX / scale));
};

/** The preview's outline for the drag so far. */
const previewOf = (
	kind: AreaKind,
	drag: Drag,
	sample: PointerSample,
	context: ToolContext
): string =>
	kind === 'marquee'
		? (rectPath(marqueeBox(drag.start, sample, context.options, drag.adding)) ?? '')
		: lassoPreview(drag.points);

/**
 * A drag that makes an area, for either kind of layer: `made` is told what it
 * made when it ends, and `allowed`, where given, says at its start whether
 * the layer may be worked on at all.
 */
export const areaDrag = (
	kind: AreaKind,
	made: AreaMade,
	allowed: (context: ToolContext) => boolean = () => true
): ToolBehaviour => {
	const active = cell<Drag | undefined>(undefined);

	const cancel = (): void => {
		active.current?.preview.remove();
		active.current = undefined;
	};

	return {
		begin: (context, sample) => {
			cancel();
			if (!allowed(context)) return;
			const preview = context.overlay.ownerDocument.createElementNS(SVG_NAMESPACE, 'path');
			preview.setAttribute('class', 'viewport-area-drag');
			preview.setAttribute('fill-rule', 'nonzero');
			preview.setAttribute('vector-effect', 'non-scaling-stroke');
			preview.setAttribute('pointer-events', 'none');
			context.overlay.appendChild(preview);
			const start = pointOf(sample);
			active.current = { start, points: [start], adding: sample.shiftKey, preview };
		},
		move: (context, sample) => {
			const drag = active.current;
			if (drag === undefined) return;
			const next =
				kind === 'lasso' ? { ...drag, points: [...drag.points, pointOf(sample)] } : drag;
			active.current = next;
			next.preview.setAttribute('d', previewOf(kind, next, sample, context));
		},
		end: (context, sample) => {
			const drag = active.current;
			if (drag === undefined) return;
			active.current = undefined;
			drag.preview.remove();
			made(context, madeBy(kind, drag, sample, context), drag.adding);
		},
		cancel,
	};
};

/**
 * On a raster layer the area is set, and outlives the tool: a click with
 * nothing added drops it, as in every editor, and Shift adds to it. Making
 * an area changes no pixel, so a locked or a hidden layer may have one.
 */
export const regionBehaviour = (kind: AreaKind): ToolBehaviour =>
	areaDrag(kind, (context, path, adding) => {
		if (path === undefined) {
			if (!adding) context.region.set(undefined);
			return;
		}
		context.region.set(adding ? addToArea(context.region.path, path) : path);
	});

/**
 * What Delete does with an area selected on a raster layer: the layer's
 * pixels inside it cleared, by one command (`regions.clear`), and none
 * written where none there had any colour. Whether Delete was this one's: it
 * is wherever there is an area, though a locked or a hidden layer says so
 * and keeps its pixels.
 */
export const clearArea = (context: ToolContext): boolean => {
	const area = areaOf(context);
	if (area === undefined) return false;
	const surface = guardedSurface(context);
	if (surface === undefined) return true;
	const work = surface
		.paint('regions.clear', (ctx) => {
			const box = areaPixelBox(surface, area);
			if (box === undefined) return false;
			const { data } = ctx.getImageData(box.x, box.y, box.width, box.height);
			if (!data.some((value, index) => index % 4 === 3 && value > 0)) return false;
			ctx.save();
			const clipped = clipToArea(ctx, area, surface.toPixel);
			if (clipped) ctx.clearRect(box.x, box.y, box.width, box.height);
			ctx.restore();
			return clipped;
		})
		.catch((error: unknown) => reportFailure(context, surface, error));
	context.document.pending(work);
	return true;
};
