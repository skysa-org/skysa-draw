import { layerNumber } from '@skysa/draw-core';

import { t } from '../i18n/t.js';
import type { LayerInfo } from './document/model.js';

/**
 * What a layer is called on screen (docs/decisions/0003-layers.md): the name
 * the user gave it, or "Layer n" by the number in the id the app gave it, so a
 * layer keeps its number when it is moved; a layer from elsewhere with neither
 * goes by its place from the bottom, counted from 1.
 */
export const layerDisplayName = (layer: LayerInfo, indexFromBottom: number): string =>
	layer.name ?? t('layers.unnamed', { n: layerNumber(layer.id) ?? indexFromBottom + 1 });
