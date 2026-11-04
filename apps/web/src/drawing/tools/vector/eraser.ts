import { cell } from '@skysa/draw-core';

import { editLayer } from '../../document/commands.js';
import type { PointerSample, ToolBehaviour, ToolContext } from '../types.js';
import { apply, type Mat } from './geometry.js';
import { activeLayerElement, guardLayer, layerSpace, targetLayer } from './guard.js';
import { elementsAt, elementsAtPositions, elementsOf, positionsIn } from './hit.js';
import type { Measure } from './measure.js';
import { CHROME_STYLE, createSvg, setAttributes } from './svg.js';

/**
 * The eraser on a vector layer (docs/decisions/0004-the-interface.md): every
 * element the pointer passes over, within half the eraser's size, is removed
 * when the stroke ends, by one command. A ring the eraser's size follows the
 * pointer on the overlay so the reach is visible. The command finds what it
 * removes by its place in the layer, so a redo removes it again from a layer
 * an undo rebuilt.
 */
type Stroke = Readonly<{
	layer: Element;
	into: Mat;
	/** Collected as the pointer passes; a `Set` so an element crossed twice is counted once. */
	hits: Set<Element>;
	preview: SVGElement;
}>;

export const createEraser = (measure: Measure): ToolBehaviour => {
	const stroke = cell<Stroke | undefined>(undefined);

	const forget = (): void => {
		stroke.current?.preview.remove();
		stroke.current = undefined;
	};

	const collect = (context: ToolContext, sample: PointerSample): void => {
		const current = stroke.current;
		if (current === undefined) return;
		const point = apply(current.into, { x: sample.x, y: sample.y });
		elementsAt(elementsOf(current.layer), point, measure, context.options.size / 2).forEach(
			(element) => current.hits.add(element)
		);
		setAttributes(current.preview, { cx: sample.x, cy: sample.y });
	};

	return {
		begin: (context, sample) => {
			forget();
			if (guardLayer(context) === undefined) return;
			const layer = activeLayerElement(context);
			if (layer === undefined) return;
			const preview = createSvg(context.overlay.ownerDocument, 'circle', {
				r: context.options.size / 2,
				fill: 'none',
				style: CHROME_STYLE,
				'vector-effect': 'non-scaling-stroke',
				'pointer-events': 'none',
			});
			context.overlay.appendChild(preview);
			stroke.current = { layer, into: layerSpace(layer).into, hits: new Set(), preview };
			collect(context, sample);
		},

		move: collect,

		end: (context, sample) => {
			collect(context, sample);
			const current = stroke.current;
			forget();
			if (current === undefined || current.hits.size === 0) return;
			// Where they are, read before a loose layer is wrapped, which keeps them in order.
			const positions = positionsIn(current.layer, [...current.hits]);
			const layer = targetLayer(context);
			if (layer === undefined) return;
			context.document.execute(
				editLayer(layer.id, 'tools.eraser', (g: Element) => {
					elementsAtPositions(g, positions).forEach((element) => element.remove());
				})
			);
		},

		cancel: forget,
	};
};
