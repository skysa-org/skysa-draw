import type { Behaviors } from '../types.js';
import { brushBehavior } from './brush.js';
import { eyedropper, fill } from './fill.js';
import { redEyeBehavior } from './redEye.js';
import { regionBehavior } from './region.js';
import { removeBehavior } from './remove.js';
import { select } from './select.js';
import { shapeBehavior } from './shapes.js';
import { smudgeBehavior } from './smudge.js';
import { wandBehavior } from './wand.js';

/**
 * What each tool does on a raster layer (docs/decisions/0004-the-interface.md).
 * A stroke is painted on a canvas the size of the layer's pixels, shown live,
 * and written into the layer's `<image>` when it ends; the encoding is
 * asynchronous and a save waits for it (docs/ARCHITECTURE.md §7, "The editor").
 * Where an area is selected, every tool that paints paints inside it.
 */
export const rasterBehaviors: Behaviors = {
	select,
	marquee: regionBehavior('marquee'),
	lasso: regionBehavior('lasso'),
	wand: wandBehavior(),
	pencil: brushBehavior('pencil'),
	brush: brushBehavior('brush'),
	eraser: brushBehavior('eraser'),
	smudge: smudgeBehavior(),
	remove: removeBehavior(),
	redEye: redEyeBehavior(),
	fill,
	eyedropper,
	rectangle: shapeBehavior('rectangle'),
	ellipse: shapeBehavior('ellipse'),
	line: shapeBehavior('line'),
};

export { clearArea, fillArea, layerViaArea } from './region.js';
export { nudgeArea } from './move.js';
