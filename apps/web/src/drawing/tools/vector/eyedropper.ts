import { t } from '../../../i18n/t.js';
import type { ToolBehavior } from '../types.js';
import { activeLayerElement, layerSpace } from './guard.js';
import { elementsOf, paintedColor, topmostAt } from './hit.js';
import type { Measure } from './measure.js';

const nothing = (): undefined => undefined;

/** What SVG paints with where nothing says: a black fill, and no stroke. */
const DEFAULTS = { fill: '#000000', stroke: 'none' } as const;

/**
 * The eyedropper on a vector layer (docs/decisions/0004-the-interface.md): a
 * click reads the fill of the element under the pointer into the fill color;
 * with Alt, its stroke into the stroke color. It only reads, so a locked or a
 * hidden layer is as good a source as any; it needs a layer to read from. A
 * color the element does not set is the one it inherits, from its layer or
 * from any group or the root above it.
 */
export const createEyedropper = (measure: Measure): ToolBehavior => ({
	begin: (context, sample) => {
		const layer = activeLayerElement(context);
		if (layer === undefined) {
			context.notify(t('layers.noneActive'));
			return;
		}
		const point = { x: sample.x, y: sample.y };
		const hit = topmostAt(elementsOf(layer), point, measure, 0, layerSpace(layer).outOf);
		if (hit === undefined) return;
		const which = sample.altKey ? 'stroke' : 'fill';
		context.setColor(which, paintedColor(hit, which, context.document.root, DEFAULTS[which]));
	},
	move: nothing,
	end: nothing,
	cancel: nothing,
});
