import { withBrushOutline } from '../common/brushOutline.js';
import type { ToolBehavior } from '../types.js';
import { followsPressure, pressureWidth, strokeOutline } from './geometry.js';
import { createStrokeBehavior } from './stroke.js';
import { inkOf, opacityOf } from './svg.js';

/**
 * The brush on a vector layer (docs/decisions/0004-the-interface.md): a filled
 * `<path>` whose width follows a pen's pressure (`followsPressure`), as the outline of the stroke.
 * It always makes a mark, so with no fill color it paints in the stroke color.
 * Its pointer is the brush's outline, the whole size whatever the pressure
 * (`tools/common/brushOutline.ts`).
 */
export const createBrush = (): ToolBehavior =>
	withBrushOutline(
		createStrokeBehavior({
			label: 'tools.brush',
			point: (sample, options) => ({
				x: sample.x,
				y: sample.y,
				w: pressureWidth(
					options.size,
					sample.pressure,
					followsPressure(options.pressure, sample.pointerType)
				),
			}),
			attributes: (options) => ({
				fill: inkOf(options, 'fill'),
				'fill-rule': 'nonzero',
				opacity: opacityOf(options),
			}),
			path: strokeOutline,
		})
	);
