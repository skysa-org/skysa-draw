import type { LayerKind } from '@skysa/draw-core';

import { t } from '../../i18n/t.js';
import { handBehaviour } from './common/hand.js';
import { zoomBehaviour } from './common/zoom.js';
import { rasterBehaviours } from './raster/index.js';
import type { Tool, ToolBehaviour, ToolId, ToolOptionKey } from './types.js';
import { vectorBehaviours } from './vector/index.js';

/**
 * The tools the bar shows, in its order (docs/decisions/0004-the-interface.md;
 * docs/ARCHITECTURE.md §7, "Tools"). One tool is one tool: its name, its key
 * and its options are the same on every kind of layer, and here its vector and
 * raster behaviours are put under one id. The hand and the zoom need no layer
 * and so have one behaviour for any.
 */

/**
 * A tool's behaviours by kind, with a key only where there is a behaviour, so
 * that a kind the tool names is a kind it works on for whoever reads the
 * keys; `behaviourFor` falls through to `any` past an absent one either way.
 */
const behavioursOf = (id: ToolId, any?: ToolBehaviour): Tool['behaviours'] => {
	const vector = vectorBehaviours[id];
	const raster = rasterBehaviours[id];
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
	any?: ToolBehaviour
): Tool => ({ id, options, behaviours: behavioursOf(id, any), cursor });

const CROSSHAIR = 'crosshair';

export const TOOLS: readonly Tool[] = [
	tool('select', [], 'default'),
	tool('hand', [], 'grab', handBehaviour),
	tool('zoom', [], 'zoom-in', zoomBehaviour),
	tool('pencil', ['size', 'smoothing', 'stroke', 'opacity'], CROSSHAIR),
	tool('brush', ['size', 'opacity', 'hardness', 'pressure', 'smoothing', 'fill'], CROSSHAIR),
	tool('eraser', ['size', 'hardness'], CROSSHAIR),
	tool('fill', ['fill', 'tolerance'], CROSSHAIR),
	tool('eyedropper', [], CROSSHAIR),
	tool('rectangle', ['fill', 'stroke', 'strokeWidth', 'cornerRadius', 'constrain'], CROSSHAIR),
	tool('ellipse', ['fill', 'stroke', 'strokeWidth', 'constrain'], CROSSHAIR),
	tool('line', ['stroke', 'strokeWidth', 'constrain'], CROSSHAIR),
];

export const toolById = (id: ToolId): Tool | undefined =>
	TOOLS.find((candidate) => candidate.id === id);

/** What the tool does on a layer of this kind: its own behaviour for the kind, else the one for any. */
export const behaviourFor = (tool: Tool, kind: LayerKind | undefined): ToolBehaviour | undefined =>
	(kind === undefined ? undefined : tool.behaviours[kind]) ?? tool.behaviours.any;

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
