import { cell } from '@skysa/draw-core';

import { editLayer } from '../../document/commands.js';
import type { PointerSample, ToolBehavior, ToolContext, ToolOptions } from '../types.js';
import { apply, constrainLine, constrainRect, distance, type Point, rectFrom } from './geometry.js';
import { guardLayer, layerSpace, targetLayer } from './guard.js';
import { type Attributes, createSvg, inkOf, opacityOf, paintOf, setAttributes } from './svg.js';
import { rounded } from './textMarkup.js';

/**
 * The shape tools on a vector layer (docs/decisions/0004-the-interface.md): a
 * drag from one corner to the other makes a `<rect>`, an `<ellipse>` or a
 * `<line>`, previewed on the overlay and added to the layer by one command at
 * the end. Shift, or the constrain option, keeps a rectangle square, an
 * ellipse round and a line to a multiple of 45°. A drag shorter than a user
 * unit is a click, and makes nothing.
 */
type ShapeKind = 'rectangle' | 'ellipse' | 'line';

const ELEMENT: Readonly<Record<ShapeKind, string>> = {
	rectangle: 'rect',
	ellipse: 'ellipse',
	line: 'line',
};

/** Below this, in user units, a drag was a click. */
const LEAST_DRAG = 1;

type Drag = Readonly<{ from: Point; preview: SVGElement }>;

const pointOf = (sample: PointerSample): Point => ({ x: sample.x, y: sample.y });

const attributesOf = (
	kind: ShapeKind,
	from: Point,
	to: Point,
	options: ToolOptions
): Attributes => {
	if (kind === 'line') {
		// A line has no inside, so it always has a stroke: the fill color where none is set.
		return {
			x1: rounded(from.x),
			y1: rounded(from.y),
			x2: rounded(to.x),
			y2: rounded(to.y),
			stroke: inkOf(options, 'stroke'),
			'stroke-width': options.strokeWidth,
			opacity: opacityOf(options),
		};
	}
	const box = rectFrom(from, to);
	if (kind === 'rectangle') {
		const radius = options.cornerRadius > 0 ? options.cornerRadius : undefined;
		return {
			x: rounded(box.x),
			y: rounded(box.y),
			width: rounded(box.width),
			height: rounded(box.height),
			rx: radius,
			ry: radius,
			...paintOf(options),
		};
	}
	return {
		cx: rounded(box.x + box.width / 2),
		cy: rounded(box.y + box.height / 2),
		rx: rounded(box.width / 2),
		ry: rounded(box.height / 2),
		...paintOf(options),
	};
};

const constrained = (kind: ShapeKind, from: Point, to: Point, constrain: boolean): Point =>
	kind === 'line' ? constrainLine(from, to, constrain) : constrainRect(from, to, constrain);

export const createShape = (kind: ShapeKind): ToolBehavior => {
	const drag = cell<Drag | undefined>(undefined);

	const endOf = (context: ToolContext, from: Point, sample: PointerSample): Point =>
		constrained(kind, from, pointOf(sample), context.options.constrain || sample.shiftKey);

	const forget = (): void => {
		drag.current?.preview.remove();
		drag.current = undefined;
	};

	return {
		begin: (context, sample) => {
			forget();
			if (guardLayer(context) === undefined) return;
			const from = pointOf(sample);
			const preview = createSvg(
				context.overlay.ownerDocument,
				ELEMENT[kind],
				attributesOf(kind, from, from, context.options)
			);
			context.overlay.appendChild(preview);
			drag.current = { from, preview };
		},

		move: (context, sample) => {
			const current = drag.current;
			if (current === undefined) return;
			const to = endOf(context, current.from, sample);
			setAttributes(current.preview, attributesOf(kind, current.from, to, context.options));
		},

		end: (context, sample) => {
			const current = drag.current;
			if (current === undefined) return;
			const to = endOf(context, current.from, sample);
			forget();
			if (distance(current.from, to) < LEAST_DRAG) return;
			const layer = targetLayer(context);
			if (layer === undefined) return;
			const { into } = layerSpace(layer);
			const attributes = attributesOf(
				kind,
				apply(into, current.from),
				apply(into, to),
				context.options
			);
			context.document.execute(
				editLayer(layer.id, `tools.${kind}`, (g: Element) => {
					g.appendChild(createSvg(g.ownerDocument, ELEMENT[kind], attributes));
				})
			);
		},

		cancel: forget,
	};
};
