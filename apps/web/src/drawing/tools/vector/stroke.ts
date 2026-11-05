import { cell } from '@skysa/draw-core';

import { editLayer } from '../../document/commands.js';
import type { PointerSample, ToolBehavior, ToolOptions } from '../types.js';
import { apply, lengthScale, type Point } from './geometry.js';
import { guardLayer, layerSpace, targetLayer } from './guard.js';
import { type Attributes, createSvg, setAttributes } from './svg.js';

/**
 * What the pencil and the brush share (docs/ARCHITECTURE.md §7, "The editor"):
 * samples collected from `begin` to `end`, a `<path>` previewed on the overlay
 * as they come, and at the end one command that adds the finished path to the
 * layer. The preview is on the overlay and never on the layer, so the layer is
 * exactly as it was when `editLayer` snapshots it; a canceled stroke leaves
 * nothing anywhere.
 *
 * The size is in the drawing's user units, as the brush's outline shows it
 * (`tools/common/brushOutline.ts`) and the preview draws it, on any layer: a
 * path joins the layer in the layer's units, so its width is the size through
 * the layer's `transform`, and what lands is as wide as what was previewed.
 * One factor for both ways (`lengthScale`), so a layer scaled more one way
 * than the other gets the mean of the two.
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

/** The samples so far, in the drawing's units, so the end can place each in the layer's. */
type Stroke = Readonly<{ samples: readonly PointerSample[]; preview: SVGElement }>;

export const createStrokeBehavior = <P extends Point>(spec: StrokeSpec<P>): ToolBehavior => {
	const stroke = cell<Stroke | undefined>(undefined);

	const pathOf = (samples: readonly PointerSample[], options: ToolOptions): string =>
		spec.path(
			samples.map((sample) => spec.point(sample, options)),
			options
		);

	const forget = (): void => {
		stroke.current?.preview.remove();
		stroke.current = undefined;
	};

	return {
		begin: (context, sample) => {
			forget();
			if (guardLayer(context) === undefined) return;
			const samples = [sample];
			const preview = createSvg(context.overlay.ownerDocument, 'path', {
				...spec.attributes(context.options),
				d: pathOf(samples, context.options),
			});
			context.overlay.appendChild(preview);
			stroke.current = { samples, preview };
		},

		move: (context, sample) => {
			const current = stroke.current;
			if (current === undefined) return;
			const samples = [...current.samples, sample];
			stroke.current = { ...current, samples };
			setAttributes(current.preview, { d: pathOf(samples, context.options) });
		},

		end: (context, sample) => {
			const current = stroke.current;
			if (current === undefined) return;
			const samples = [...current.samples, sample];
			forget();
			const layer = targetLayer(context);
			if (layer === undefined) return;
			// The samples are in the drawing's units; the path joins the layer, in its,
			// and so does its width.
			const { into } = layerSpace(layer);
			const size = Number((context.options.size * lengthScale(into)).toPrecision(6));
			const options = { ...context.options, size };
			const placed = samples.map((each) => ({ ...each, ...apply(into, each) }));
			const attributes: Attributes = {
				...spec.attributes(options),
				d: pathOf(placed, options),
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
