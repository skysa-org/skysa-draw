import type { ToolBehavior } from '../types.js';
import { smoothPath } from './geometry.js';
import { createStrokeBehavior } from './stroke.js';
import { inkOf, opacityOf } from './svg.js';

/**
 * The pencil on a vector layer (docs/decisions/0004-the-interface.md): a
 * freehand `<path>` of one width, smoothed by the smoothing option. It always
 * makes a mark, so with no stroke color it draws in the fill color.
 */
export const createPencil = (): ToolBehavior =>
	createStrokeBehavior({
		label: 'tools.pencil',
		point: (sample) => ({ x: sample.x, y: sample.y }),
		attributes: (options) => ({
			fill: 'none',
			stroke: inkOf(options, 'stroke'),
			'stroke-width': options.size,
			'stroke-linecap': 'round',
			'stroke-linejoin': 'round',
			opacity: opacityOf(options),
		}),
		path: (points, options) => smoothPath(points, options.smoothing),
	});
