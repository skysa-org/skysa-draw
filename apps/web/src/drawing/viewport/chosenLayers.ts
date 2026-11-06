import { outermostLayers } from '../document/arrange.js';
import type { LayerInfo } from '../document/model.js';
import { movesWith, nudgeLayers } from '../tools/common/layersMove.js';
import { nudgeArea } from '../tools/raster/index.js';
import type { ToolContext } from '../tools/types.js';

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
 * The arrows' nudge with the move tool, by `by` (`nudgeFor`): the chosen
 * layers whole where there are several, and a group active alone whole, as a
 * drag moves them; otherwise the area's pixels on a raster layer, as before.
 * Whether it was theirs to do.
 */
export const nudgeWith = (context: ToolContext, [dx, dy]: readonly [number, number]): boolean =>
	(context.layers?.length ?? 0) > 1 || context.layer?.kind === 'group'
		? nudgeLayers(context, dx, dy)
		: nudgeArea(context, dx, dy);
