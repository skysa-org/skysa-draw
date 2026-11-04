import type { Behaviours } from '../types.js';
import { createBrush } from './brush.js';
import { createEraser } from './eraser.js';
import { createEyedropper } from './eyedropper.js';
import { createFill } from './fill.js';
import { type Measure, measureOf } from './measure.js';
import { createPencil } from './pencil.js';
import { createSelect } from './select.js';
import { createShape } from './shapes.js';

/**
 * What each tool does on a vector layer (docs/decisions/0004-the-interface.md).
 * A factory, so a test can hand the tools a measurer that reads an element's
 * attributes where jsdom has no `getBBox()`; the editor takes the browser's.
 */
export const createVectorBehaviours = ({
	measure = measureOf,
}: Readonly<{ measure?: Measure }>): Behaviours => ({
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

export const vectorBehaviours: Behaviours = createVectorBehaviours({});

export { deleteSelection } from './select.js';
