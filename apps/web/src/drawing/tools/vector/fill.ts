import { editLayer } from '../../document/commands.js';
import type { ToolBehavior } from '../types.js';
import { apply } from './geometry.js';
import { activeLayerElement, guardLayer, layerSpace, targetLayer } from './guard.js';
import {
	elementsAtPositions,
	elementsOf,
	positionsIn,
	topmostAt,
	withoutStyleProperty,
} from './hit.js';
import type { Measure } from './measure.js';

const nothing = (): undefined => undefined;

/**
 * The fill tool on a vector layer (docs/decisions/0004-the-interface.md): a
 * click sets the fill color of the element under the pointer, the topmost
 * where several overlap. A `fill` in the element's `style` is taken out, since
 * it would win over the attribute and the click would seem to do nothing.
 */
export const createFill = (measure: Measure): ToolBehavior => ({
	begin: (context, sample) => {
		if (guardLayer(context) === undefined) return;
		const layer = activeLayerElement(context);
		if (layer === undefined) return;
		const point = apply(layerSpace(layer).into, { x: sample.x, y: sample.y });
		const hit = topmostAt(elementsOf(layer), point, measure);
		if (hit === undefined) return;
		// Where it is, read before a loose layer is wrapped, for the command to find it by.
		const positions = positionsIn(layer, [hit]);
		const target = targetLayer(context);
		if (target === undefined) return;
		const color = context.options.fill;
		context.document.execute(
			editLayer(target.id, 'tools.fill', (g: Element) => {
				elementsAtPositions(g, positions).forEach((element) => {
					const style = element.getAttribute('style');
					if (style !== null)
						element.setAttribute('style', withoutStyleProperty(style, 'fill'));
					element.setAttribute('fill', color);
				});
			})
		);
	},
	move: nothing,
	end: nothing,
	cancel: nothing,
});
