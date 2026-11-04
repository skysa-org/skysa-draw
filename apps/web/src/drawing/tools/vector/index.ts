import type { Behaviours, ToolBehaviour } from '../types.js';
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

/**
 * What each tool does on a vector layer (docs/decisions/0004-the-interface.md).
 * A factory, so a test can hand the tools a measurer that reads an element's
 * attributes where jsdom has no `getBBox()`; the editor takes the browser's.
 */
export const createVectorBehaviours = ({
	measure = measureOf,
}: Readonly<{ measure?: Measure }>): Behaviours => ({
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
});

/** The tools that are built, of those named: a stub that is not yet is left out. */
const defined = (behaviours: Readonly<Record<string, ToolBehaviour | undefined>>): Behaviours =>
	Object.fromEntries(Object.entries(behaviours).filter(([, each]) => each !== undefined));

export const vectorBehaviours: Behaviours = createVectorBehaviours({});

export { deleteSelection } from './select.js';
