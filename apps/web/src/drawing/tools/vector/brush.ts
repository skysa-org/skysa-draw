import type { ToolBehavior } from '../types.js';
import { pressureWidth, strokeOutline } from './geometry.js';
import { createStrokeBehavior } from './stroke.js';
import { inkOf, opacityOf } from './svg.js';

/**
 * The brush on a vector layer (docs/decisions/0004-the-interface.md): a filled
 * `<path>` whose width follows the pen's pressure, as the outline of the stroke.
 * It always makes a mark, so with no fill color it paints in the stroke color.
 */
export const createBrush = (): ToolBehavior =>
	createStrokeBehavior({
		label: 'tools.brush',
		point: (sample, options) => ({
			x: sample.x,
			y: sample.y,
			w: pressureWidth(options.size, sample.pressure, options.pressure),
		}),
		attributes: (options) => ({
			fill: inkOf(options, 'fill'),
			'fill-rule': 'nonzero',
			opacity: opacityOf(options),
		}),
		path: strokeOutline,
	});
