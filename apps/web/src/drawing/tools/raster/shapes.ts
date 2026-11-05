import { cell, SVG_NAMESPACE } from '@skysa/draw-core';

import type { PointerSample, ToolBehavior, ToolContext, ToolOptions } from '../types.js';
import { type Box, constrainLine, constrainRect, distance, rectFrom } from '../vector/geometry.js';
import { inkOf } from '../vector/svg.js';
import { type Area, areaOf, reachesArea } from './area.js';
import { guardedSurface, reportFailure } from './guard.js';
import type { Point } from './pixels.js';
import type { RasterSurface } from './surface.js';

/**
 * The rectangle, the ellipse and the line on a raster layer
 * (docs/decisions/0004-the-interface.md): a drag with a preview on the
 * overlay, in user units, and at its end the shape drawn onto the stroke
 * canvas in pixels and committed. The same options as on a vector layer, read
 * the same way: Shift or the constrain option keeps a rectangle square, an
 * ellipse round and a line to 45°; a drag shorter than a user unit is a click
 * and makes nothing. The preview stays until the new href has landed, as a
 * brush stroke stays on the screen canvas. Where an area is selected the
 * shape is drawn inside it, and one that misses it makes nothing. A shape
 * past the layer's pixels grows them to hold it, on the drawing's canvas
 * (`RasterSurface`).
 */

type ShapeKind = 'rectangle' | 'ellipse' | 'line';

interface Drag {
	readonly surface: RasterSurface;
	readonly start: Point;
	readonly preview: Element;
	/** The area selected when the drag began; none for anywhere. */
	readonly area: Area | undefined;
}

const TAGS: Readonly<Record<ShapeKind, string>> = {
	rectangle: 'rect',
	ellipse: 'ellipse',
	line: 'line',
};

/** Below this, in user units, a drag was a click: the vector shapes' rule. */
const LEAST_DRAG = 1;

/** The far point, kept to a square, a circle or a 45° angle when asked. */
const endOf = (
	kind: ShapeKind,
	context: ToolContext,
	start: Point,
	sample: PointerSample
): Point => {
	const point = { x: sample.x, y: sample.y };
	const constrain = context.options.constrain || sample.shiftKey;
	return kind === 'line'
		? constrainLine(start, point, constrain)
		: constrainRect(start, point, constrain);
};

/** A rectangle's corner radius, as SVG clamps `rx`: never past half a side. */
const radiusOf = (options: ToolOptions, width: number, height: number): number =>
	Math.max(0, Math.min(options.cornerRadius, width / 2, height / 2));

/** The preview's geometry, in user units, from the two corners of the drag. */
const setGeometry = (
	kind: ShapeKind,
	preview: Element,
	start: Point,
	end: Point,
	options: ToolOptions
): void => {
	if (kind === 'line') {
		preview.setAttribute('x1', String(start.x));
		preview.setAttribute('y1', String(start.y));
		preview.setAttribute('x2', String(end.x));
		preview.setAttribute('y2', String(end.y));
		return;
	}
	const { x, y, width, height } = rectFrom(start, end);
	if (kind === 'rectangle') {
		preview.setAttribute('x', String(x));
		preview.setAttribute('y', String(y));
		preview.setAttribute('width', String(width));
		preview.setAttribute('height', String(height));
		preview.setAttribute('rx', String(radiusOf(options, width, height)));
		return;
	}
	preview.setAttribute('cx', String(x + width / 2));
	preview.setAttribute('cy', String(y + height / 2));
	preview.setAttribute('rx', String(width / 2));
	preview.setAttribute('ry', String(height / 2));
};

/** The preview element, styled as the shape will be, its outline the same on screen at any zoom. */
const makePreview = (kind: ShapeKind, context: ToolContext): Element => {
	const { options, overlay } = context;
	const preview = overlay.ownerDocument.createElementNS(SVG_NAMESPACE, TAGS[kind]);
	preview.setAttribute('fill', kind === 'line' ? 'none' : options.fill);
	preview.setAttribute('stroke', kind === 'line' ? inkOf(options, 'stroke') : options.stroke);
	preview.setAttribute('stroke-width', String(options.strokeWidth));
	preview.setAttribute('vector-effect', 'non-scaling-stroke');
	preview.setAttribute('opacity', String(options.opacity));
	preview.setAttribute('pointer-events', 'none');
	overlay.appendChild(preview);
	return preview;
};

/** What the shape covers in user units: the box between its corners, grown by half its outline. */
const shapeBox = (start: Point, end: Point, options: ToolOptions): Box => {
	const box = rectFrom(start, end);
	const half = options.strokeWidth / 2;
	return {
		x: box.x - half,
		y: box.y - half,
		width: box.width + 2 * half,
		height: box.height + 2 * half,
	};
};

/** Whether the shape leaves a mark: a line always has ink; a rectangle or an ellipse needs a fill or a stroke. */
const marks = (kind: ShapeKind, options: ToolOptions): boolean =>
	kind === 'line' || options.fill !== 'none' || options.stroke !== 'none';

/** A rectangle with rounded corners as a path; square ones at a radius of 0. */
const roundedRect = (
	ctx: CanvasRenderingContext2D,
	x: number,
	y: number,
	width: number,
	height: number,
	radius: number
): void => {
	ctx.beginPath();
	ctx.moveTo(x + radius, y);
	ctx.arcTo(x + width, y, x + width, y + height, radius);
	ctx.arcTo(x + width, y + height, x, y + height, radius);
	ctx.arcTo(x, y + height, x, y, radius);
	ctx.arcTo(x, y, x + width, y, radius);
	ctx.closePath();
};

/** The current path filled and outlined as the options say, each only where it is not `none`. */
const paintPath = (ctx: CanvasRenderingContext2D, options: ToolOptions): void => {
	if (options.fill !== 'none') {
		ctx.fillStyle = options.fill;
		ctx.fill();
	}
	if (options.stroke !== 'none') {
		ctx.strokeStyle = options.stroke;
		ctx.stroke();
	}
};

/**
 * The shape onto the stroke canvas, in pixels, between the two corners as the
 * layer sees them. Alpha 1: the opacity is the commit's. A corner each is
 * exact for a layer that was moved or scaled; a rotated layer gets the
 * axis-aligned shape between its mapped corners, since a raster layer is not
 * rotated here yet.
 */
const drawShape = (
	kind: ShapeKind,
	surface: RasterSurface,
	start: Point,
	end: Point,
	options: ToolOptions
): void => {
	const ctx = surface.stroke.getContext('2d');
	if (ctx === null) return;
	const [ax, ay] = surface.toStroke(start.x, start.y);
	const [bx, by] = surface.toStroke(end.x, end.y);
	ctx.globalAlpha = 1;
	ctx.lineWidth = options.strokeWidth * surface.ppu;
	if (kind === 'line') {
		ctx.strokeStyle = inkOf(options, 'stroke');
		ctx.beginPath();
		ctx.moveTo(ax, ay);
		ctx.lineTo(bx, by);
		ctx.stroke();
		return;
	}
	const { x, y, width, height } = rectFrom({ x: ax, y: ay }, { x: bx, y: by });
	if (kind === 'rectangle') {
		const radius = radiusOf(options, width / surface.ppu, height / surface.ppu) * surface.ppu;
		roundedRect(ctx, x, y, width, height, radius);
	} else {
		ctx.beginPath();
		ctx.ellipse(x + width / 2, y + height / 2, width / 2, height / 2, 0, 0, Math.PI * 2);
	}
	paintPath(ctx, options);
};

export const shapeBehavior = (kind: ShapeKind): ToolBehavior => {
	const active = cell<Drag | undefined>(undefined);
	const label = `tools.${kind}`;

	return {
		begin: (context, sample) => {
			const surface = guardedSurface(context);
			if (surface === undefined) return;
			const start = { x: sample.x, y: sample.y };
			const preview = makePreview(kind, context);
			setGeometry(kind, preview, start, start, context.options);
			active.current = { surface, start, preview, area: areaOf(context) };
		},
		move: (context, sample) => {
			const drag = active.current;
			if (drag === undefined) return;
			const end = endOf(kind, context, drag.start, sample);
			setGeometry(kind, drag.preview, drag.start, end, context.options);
		},
		end: (context, sample) => {
			const drag = active.current;
			if (drag === undefined) return;
			active.current = undefined;
			const end = endOf(kind, context, drag.start, sample);
			if (
				distance(drag.start, end) < LEAST_DRAG ||
				!marks(kind, context.options) ||
				!reachesArea(drag.area, shapeBox(drag.start, end, context.options))
			) {
				drag.preview.remove();
				return;
			}
			// What stays on screen is what will land, past the layer's pixels too.
			setGeometry(kind, drag.preview, drag.start, end, context.options);
			const box = shapeBox(drag.start, end, context.options);
			drag.surface.extendStroke(box);
			drawShape(kind, drag.surface, drag.start, end, context.options);
			const work = drag.surface.commit(
				label,
				'source-over',
				context.options.opacity,
				drag.area,
				box
			);
			const landed = work.then(
				() => drag.preview.remove(),
				(error: unknown) => {
					drag.preview.remove();
					reportFailure(context, drag.surface, error);
				}
			);
			context.document.pending(landed);
		},
		cancel: () => {
			const drag = active.current;
			active.current = undefined;
			drag?.preview.remove();
		},
	};
};
