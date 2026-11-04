import type { Behaviours } from '../types.js';
import { brushBehaviour } from './brush.js';
import { eyedropper, fill } from './fill.js';
import { select } from './select.js';
import { shapeBehaviour } from './shapes.js';

/**
 * What each tool does on a raster layer (docs/decisions/0004-the-interface.md).
 * A stroke is painted on a canvas the size of the layer's pixels, shown live,
 * and written into the layer's `<image>` when it ends; the encoding is
 * asynchronous and a save waits for it (docs/ARCHITECTURE.md §7, "The editor").
 */
export const rasterBehaviours: Behaviours = {
	select,
	pencil: brushBehaviour('pencil'),
	brush: brushBehaviour('brush'),
	eraser: brushBehaviour('eraser'),
	fill,
	eyedropper,
	rectangle: shapeBehaviour('rectangle'),
	ellipse: shapeBehaviour('ellipse'),
	line: shapeBehaviour('line'),
};
