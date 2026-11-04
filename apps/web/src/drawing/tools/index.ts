import type { LayerKind } from '@skysa/draw-core';

import { t } from '../../i18n/t.js';
import { autoSelect } from './common/autoSelect.js';
import { cropBehavior } from './common/crop.js';
import { handBehavior } from './common/hand.js';
import { zoomBehavior } from './common/zoom.js';
import { rasterBehaviors } from './raster/index.js';
import type { Tool, ToolBehavior, ToolId, ToolOptionKey } from './types.js';
import { vectorBehaviors } from './vector/index.js';
import { measureOf } from './vector/measure.js';

/**
 * The tools the bar shows, in its order (docs/decisions/0004-the-interface.md;
 * docs/ARCHITECTURE.md §7, "Tools"). One tool is one tool: its name, its key
 * and its options are the same on every kind of layer, and here its vector and
 * raster behaviors are put under one id. The hand and the zoom need no layer
 * and so have one behavior for any. The select tool, which is the move tool,
 * picks the layer a press acts on where Auto-Select is on (`Tool.pick`).
 */

/**
 * A tool's behaviors by kind, with a key only where there is a behavior, so
 * that a kind the tool names is a kind it works on for whoever reads the
 * keys; `behaviorFor` falls through to `any` past an absent one either way.
 */
const behaviorsOf = (id: ToolId, any?: ToolBehavior): Tool['behaviors'] => {
	const vector = vectorBehaviors[id];
	const raster = rasterBehaviors[id];
	return {
		...(vector === undefined ? {} : { vector }),
		...(raster === undefined ? {} : { raster }),
		...(any === undefined ? {} : { any }),
	};
};

const tool = (
	id: ToolId,
	options: readonly ToolOptionKey[],
	cursor: string,
	any?: ToolBehavior
): Tool => ({ id, options, behaviors: behaviorsOf(id, any), cursor });

const CROSSHAIR = 'crosshair';

export const TOOLS: readonly Tool[] = [
	{ ...tool('select', ['autoSelect'], 'default'), pick: autoSelect(measureOf) },
	tool('node', [], 'default'),
	tool('marquee', ['constrain'], CROSSHAIR),
	tool('lasso', [], CROSSHAIR),
	tool('wand', ['tolerance', 'contiguous'], CROSSHAIR),
	tool('hand', [], 'grab', handBehavior),
	tool('zoom', [], 'zoom-in', zoomBehavior),
	tool('crop', ['constrain'], CROSSHAIR, cropBehavior()),
	tool('pencil', ['size', 'smoothing', 'stroke', 'opacity'], CROSSHAIR),
	tool('brush', ['size', 'opacity', 'hardness', 'pressure', 'smoothing', 'fill'], CROSSHAIR),
	tool('eraser', ['size', 'hardness'], CROSSHAIR),
	tool('smudge', ['size', 'strength', 'hardness'], CROSSHAIR),
	tool('fill', ['fill', 'tolerance'], CROSSHAIR),
	tool('eyedropper', [], CROSSHAIR),
	tool('pen', ['fill', 'stroke', 'strokeWidth'], CROSSHAIR),
	tool('text', ['fill', 'fontSize'], 'text'),
	tool('rectangle', ['fill', 'stroke', 'strokeWidth', 'cornerRadius', 'constrain'], CROSSHAIR),
	tool('ellipse', ['fill', 'stroke', 'strokeWidth', 'constrain'], CROSSHAIR),
	tool('line', ['stroke', 'strokeWidth', 'constrain'], CROSSHAIR),
];

export const toolById = (id: ToolId): Tool | undefined =>
	TOOLS.find((candidate) => candidate.id === id);

/** What the tool does on a layer of this kind: its own behavior for the kind, else the one for any. */
export const behaviorFor = (tool: Tool, kind: LayerKind | undefined): ToolBehavior | undefined =>
	(kind === undefined ? undefined : tool.behaviors[kind]) ?? tool.behaviors.any;

const NOT_ON = {
	vector: 'tools.notOnVector',
	raster: 'tools.notOnRaster',
	group: 'tools.notOnGroup',
} as const satisfies Record<LayerKind, string>;

/**
 * The line that says a tool does nothing on the active layer's kind, in the
 * user's words. Nothing for no layer at all: that is a different line, the
 * layers panel's, and the viewport says it.
 */
export const notAvailableMessage = (tool: Tool, kind: LayerKind | undefined): string | undefined =>
	kind === undefined ? undefined : t(NOT_ON[kind], { tool: t(`tools.${tool.id}`) });
