import { t } from '../../../i18n/t.js';
import type { LayerInfo } from '../../document/model.js';
import { layerDisplayName } from '../../layerName.js';

/**
 * Whether a layer is out of a tool's reach (docs/ARCHITECTURE.md §7, "The
 * editor"): locked or hidden itself, or held so by a group around it, since
 * what a group holds shares its lock and its visibility, as Photoshop's
 * locked group locks every layer in it. Every tool's guard asks it
 * (`guardLayer`, `tools/vector/guard.ts`; `guardedLayer`,
 * `tools/raster/guard.ts`), and so do the move tool's layers and its arrows
 * (`layersMove.ts`), the same question the layers panel asks of a layer's
 * items (`isLayerHeld`, `document/elements.ts`), and the answer is said in
 * the same words, the nearest layer or group that holds it named as the
 * panel names it.
 */

/** What a tool does to a layer: changes it, or only reads its pixels, which a lock allows. */
export type LayerNeed = 'change' | 'read';

/**
 * Why `layer` is out of reach of a tool that `needs` it, in the user's
 * words: hidden, or locked for a change, the layer itself first and then
 * each group around it, nearest first, among `layers`, the snapshot's; none
 * where nothing holds it.
 */
export const heldBy = (
	layers: readonly LayerInfo[],
	layer: LayerInfo | undefined,
	needs: LayerNeed = 'change'
): string | undefined => {
	if (layer === undefined) return undefined;
	const index = layers.findIndex((each) => each.id === layer.id);
	const name = layerDisplayName(layer, Math.max(0, index));
	if (needs === 'change' && layer.locked) return t('layers.locked', { name });
	if (layer.hidden) return t('layers.hidden', { name });
	const parent =
		layer.parentId === undefined
			? undefined
			: layers.find((each) => each.id === layer.parentId);
	return heldBy(layers, parent, needs);
};

/**
 * `layer` as the tools reach it: locked where it or a group around it is
 * locked, and hidden where it or one is hidden, so what reads its flags, the
 * selection's actions (`selectionActions.ts`), offers what the guards allow.
 */
export const asReached = (layers: readonly LayerInfo[], layer: LayerInfo): LayerInfo => {
	const parent =
		layer.parentId === undefined
			? undefined
			: layers.find((each) => each.id === layer.parentId);
	const around = parent === undefined ? undefined : asReached(layers, parent);
	return {
		...layer,
		locked: layer.locked || around?.locked === true,
		hidden: layer.hidden || around?.hidden === true,
	};
};
