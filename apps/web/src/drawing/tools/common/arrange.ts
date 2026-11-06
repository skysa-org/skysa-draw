import type { AlignTo, ToolContext } from '../types.js';
import { arrangeElements } from '../vector/alignElements.js';
import type { Measure } from '../vector/measure.js';
import { arrangeLayers, type Arrangement, type LayerExtent } from './align.js';
import { movedIds } from './layersMove.js';

/**
 * What a press of the move tool's alignment arranges
 * (docs/decisions/0004-the-interface.md, "Align and distribute"): the
 * elements selected on the active vector layer, where the move tool would
 * move that layer alone, as Photoshop's path selection tool aligns the paths
 * it has selected (`vector/alignElements.ts`); else the layers the move tool
 * moves, as its options bar aligns layers (`align.ts`).
 */
const arrangesElements = (context: ToolContext): boolean =>
	context.selection.elements.length > 0 &&
	context.layer?.kind === 'vector' &&
	movedIds(context).length <= 1;

/** The press done: to the elements selected, measured by `measure`, or to the layers, by `extent`. */
export const arrange = (
	context: ToolContext,
	arrangement: Arrangement,
	alignTo: AlignTo,
	readers: Readonly<{ extent: LayerExtent; measure: Measure }>
): Promise<boolean> =>
	arrangesElements(context)
		? Promise.resolve(arrangeElements(context, arrangement, alignTo, readers.measure))
		: arrangeLayers(context, arrangement, alignTo, readers.extent);

/**
 * How many things a press arranges, for the options strip to offer what
 * applies (`arrangementsFor`): the elements selected, where those are what it
 * arranges, else the layers it moves (`arrangedIds`).
 */
export const arrangedCount = (layerIds: readonly string[], elements: number): number =>
	layerIds.length <= 1 && elements > 0 ? elements : layerIds.length;
