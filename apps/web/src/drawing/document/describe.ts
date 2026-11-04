import { adjustmentsOf } from './adjustments.js';
import { clipStateOf } from './clip.js';
import { layerElementsOf, layersOf } from './layers.js';
import type { LayerInfo } from './model.js';

/**
 * The layers as the snapshot gives them to the panels: what `layersOf` reads
 * of each, with what it refers to in the root's `<defs>`, a clip and its
 * adjustments (docs/decisions/0003-layers.md), read here where the root is to
 * hand. Each is there only where the layer has it, so a layer with neither
 * reads as it always did.
 */
export const describeLayers = (root: SVGSVGElement): readonly LayerInfo[] => {
	const elements = layerElementsOf(root);
	return layersOf(root).map((info, index) => {
		const element = elements[index];
		if (element === undefined) return info;
		const adjustments = adjustmentsOf(root, element);
		return {
			...info,
			...(clipStateOf(root, element) === 'clipped' ? { clipped: true } : {}),
			...(adjustments === undefined ? {} : { adjustments }),
		};
	});
};
