import { cell } from '@skysa/draw-core';

import { editLayer } from '../../document/commands.js';
import { withBrushOutline } from '../common/brushOutline.js';
import type { PointerSample, ToolBehavior } from '../types.js';
import { apply, lengthScale, type Mat } from './geometry.js';
import { activeLayerElement, guardLayer, layerSpace, targetLayer } from './guard.js';
import { elementsAt, elementsAtPositions, elementsOf, positionsIn } from './hit.js';
import type { Measure } from './measure.js';

/**
 * The eraser on a vector layer (docs/decisions/0004-the-interface.md): every
 * element the pointer passes over, within half the eraser's size, is removed
 * when the stroke ends, by one command. The size is in the drawing's user
 * units on any layer, so its reach is the brush's outline, its pointer, which
 * shows it (`tools/common/brushOutline.ts`). The command finds what it removes
 * by its place in the layer, so a redo removes it again from a layer an undo
 * rebuilt.
 */
type Stroke = Readonly<{
	layer: Element;
	into: Mat;
	/** Half the eraser's size, in the layer's units. */
	reach: number;
	/** Collected as the pointer passes; a `Set` so an element crossed twice is counted once. */
	hits: Set<Element>;
}>;

export const createEraser = (measure: Measure): ToolBehavior => {
	const stroke = cell<Stroke | undefined>(undefined);

	const forget = (): void => {
		stroke.current = undefined;
	};

	const collect = (sample: PointerSample): void => {
		const current = stroke.current;
		if (current === undefined) return;
		const point = apply(current.into, { x: sample.x, y: sample.y });
		elementsAt(elementsOf(current.layer), point, measure, current.reach).forEach((element) =>
			current.hits.add(element)
		);
	};

	return withBrushOutline({
		begin: (context, sample) => {
			forget();
			if (guardLayer(context) === undefined) return;
			const layer = activeLayerElement(context);
			if (layer === undefined) return;
			const { into } = layerSpace(layer);
			const reach = (context.options.size / 2) * lengthScale(into);
			stroke.current = { layer, into, reach, hits: new Set() };
			collect(sample);
		},

		move: (_context, sample) => {
			collect(sample);
		},

		end: (context, sample) => {
			collect(sample);
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
	});
};
