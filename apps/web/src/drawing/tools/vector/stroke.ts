import { cell } from '@skysa/draw-core';

import { editLayer } from '../../document/commands.js';
import type { PointerSample, ToolBehavior, ToolOptions } from '../types.js';
import { apply, type Point } from './geometry.js';
import { guardLayer, layerSpace, targetLayer } from './guard.js';
import { type Attributes, createSvg, setAttributes } from './svg.js';

/**
 * What the pencil and the brush share (docs/ARCHITECTURE.md §7, "The editor"):
 * samples collected from `begin` to `end`, a `<path>` previewed on the overlay
 * as they come, and at the end one command that adds the finished path to the
 * layer. The preview is on the overlay and never on the layer, so the layer is
 * exactly as it was when `editLayer` snapshots it; a canceled stroke leaves
 * nothing anywhere.
 */
type StrokeSpec<P extends Point> = Readonly<{
	/** The command's label, a catalog key: `'tools.pencil'`. */
	label: string;
	/** A sample as a point of this stroke, with whatever else the stroke keeps of it. */
	point: (sample: PointerSample, options: ToolOptions) => P;
	/** The path's paint, from the options. */
	attributes: (options: ToolOptions) => Attributes;
	/** The `d` the points make. */
	path: (points: readonly P[], options: ToolOptions) => string;
}>;

type Stroke<P> = Readonly<{ points: readonly P[]; preview: SVGElement }>;

export const createStrokeBehavior = <P extends Point>(spec: StrokeSpec<P>): ToolBehavior => {
	const stroke = cell<Stroke<P> | undefined>(undefined);

	const forget = (): void => {
		stroke.current?.preview.remove();
		stroke.current = undefined;
	};

	return {
		begin: (context, sample) => {
			forget();
			if (guardLayer(context) === undefined) return;
			const points = [spec.point(sample, context.options)];
			const preview = createSvg(context.overlay.ownerDocument, 'path', {
				...spec.attributes(context.options),
				d: spec.path(points, context.options),
			});
			context.overlay.appendChild(preview);
			stroke.current = { points, preview };
		},

		move: (context, sample) => {
			const current = stroke.current;
			if (current === undefined) return;
			const points = [...current.points, spec.point(sample, context.options)];
			stroke.current = { ...current, points };
			setAttributes(current.preview, { d: spec.path(points, context.options) });
		},

		end: (context, sample) => {
			const current = stroke.current;
			if (current === undefined) return;
			const points = [...current.points, spec.point(sample, context.options)];
			forget();
			const layer = targetLayer(context);
			if (layer === undefined) return;
			// The samples are in the drawing's units; the path joins the layer, in its.
			const { into } = layerSpace(layer);
			const placed = points.map((p) => ({ ...p, ...apply(into, p) }));
			const attributes: Attributes = {
				...spec.attributes(context.options),
				d: spec.path(placed, context.options),
			};
			context.document.execute(
				editLayer(layer.id, spec.label, (g: Element) => {
					g.appendChild(createSvg(g.ownerDocument, 'path', attributes));
				})
			);
		},

		cancel: forget,
	};
};
