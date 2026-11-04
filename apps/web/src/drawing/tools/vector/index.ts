import type { Behaviors, ToolBehavior } from '../types.js';
import { createBrush } from './brush.js';
import { createEraser } from './eraser.js';
import { createEyedropper } from './eyedropper.js';
import { createFill } from './fill.js';
import { type Measure, measureOf } from './measure.js';
import { createNode } from './node.js';
import { createPen } from './pen.js';
import { createPencil } from './pencil.js';
import { createRegionSelect } from './region.js';
import { createSelect } from './select.js';
import { createShape } from './shapes.js';
import { createText } from './text.js';
import { createWand } from './wand.js';

/**
 * What each tool does on a vector layer (docs/decisions/0004-the-interface.md).
 * A factory, so a test can hand the tools a measurer that reads an element's
 * attributes where jsdom has no `getBBox()`; the editor takes the browser's.
 */
export const createVectorBehaviors = ({
	measure = measureOf,
}: Readonly<{ measure?: Measure }>): Behaviors => ({
	...defined({
		node: createNode(),
		pen: createPen(),
		text: createText(),
		marquee: createRegionSelect('marquee'),
		lasso: createRegionSelect('lasso'),
	}),
	select: createSelect(measure),
	pencil: createPencil(),
	brush: createBrush(),
	eraser: createEraser(measure),
	fill: createFill(measure),
	eyedropper: createEyedropper(measure),
	rectangle: createShape('rectangle'),
	ellipse: createShape('ellipse'),
	line: createShape('line'),
	wand: createWand(measure),
});

/** The tools that are built, of those named: a stub that is not yet is left out. */
const defined = (behaviors: Readonly<Record<string, ToolBehavior | undefined>>): Behaviors =>
	Object.fromEntries(Object.entries(behaviors).filter(([, each]) => each !== undefined));

export const vectorBehaviors: Behaviors = createVectorBehaviors({});

export { deleteSelection } from './select.js';
