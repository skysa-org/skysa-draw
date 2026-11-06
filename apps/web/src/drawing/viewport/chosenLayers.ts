import { outermostLayers } from '../document/arrange.js';
import type { LayerInfo } from '../document/model.js';
import { movesWith, nudgeLayers } from '../tools/common/layersMove.js';
import { nudgeArea } from '../tools/raster/index.js';
import type { ToolContext } from '../tools/types.js';
import { nudgeElements } from '../tools/vector/nudge.js';

/**
 * The layers chosen in the panel, as the viewport works with them
 * (docs/ARCHITECTURE.md §7, "The editor"). The tools are given the outermost
 * of them (`ToolContext.layers`), and the move tool, with more than one,
 * moves them together whatever the active layer's kind, as Photoshop's does
 * (`tools/common/layersMove.ts`): an area on a raster layer, its float, and
 * the elements selected on a vector layer keep their meaning with one layer
 * chosen alone. Auto-select's press on a layer that moves with them keeps the
 * choice; on another layer it makes that one active, which chooses it alone,
 * and the press is that layer's, as before.
 */

/** The outermost of the layers chosen, in paint order; none where none were given. */
export const chosenLayersIn = (
	root: Element,
	ids: readonly string[] | undefined
): readonly string[] => (ids === undefined || ids.length === 0 ? [] : outermostLayers(root, ids));

/**
 * Whether Auto-select's pick under a press keeps the choice: several layers
 * are chosen, and the one picked is among them or inside a group that is.
 */
export const keepsChoice = (
	layers: readonly LayerInfo[],
	chosen: readonly string[],
	picked: LayerInfo | undefined
): boolean => chosen.length > 1 && picked !== undefined && movesWith(layers, chosen, picked.id);

/**
 * The arrows on the active layer alone, where no area of a raster layer took
 * them: the elements selected on a vector layer, else the layer whole, as
 * Photoshop's move tool moves the layer with nothing selected. A layer held,
 * itself or by a group, takes the key, moves nothing and says why, as each
 * of those says it (`guardLayer`, `mayMove`); a stroke under way (`busy`)
 * takes it and moves nothing, saying nothing, since its drag would put back
 * what the key moved.
 */
const nudgeAlone = (context: ToolContext, dx: number, dy: number, busy: boolean): boolean => {
	if (context.layer === undefined) return false;
	if (busy) return true;
	return nudgeElements(context, dx, dy) || nudgeLayers(context, dx, dy);
};

/**
 * The arrows' nudge with the move tool, by `by` (`nudgeFor`), as a drag would
 * move the same: the chosen layers whole where there are several, and a
 * group active alone whole; otherwise the area's pixels on a raster layer
 * where an area reaches them or they are afloat, the elements selected on a
 * vector layer, and with none of those the active layer whole. `busy` is a
 * stroke under way in the viewport. Whether it was theirs to do.
 */
export const nudgeWith = (
	context: ToolContext,
	[dx, dy]: readonly [number, number],
	busy: boolean
): boolean => {
	if ((context.layers?.length ?? 0) > 1 || context.layer?.kind === 'group') {
		return nudgeLayers(context, dx, dy);
	}
	return nudgeArea(context, dx, dy) || nudgeAlone(context, dx, dy, busy);
};
