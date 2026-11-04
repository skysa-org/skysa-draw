import { cell } from '@skysa/draw-core';

import { t } from '../../../i18n/t.js';
import type { LayerInfo } from '../../document/model.js';
import { layerDisplayName } from '../../layerName.js';
import type { ScreenCanvas, ToolContext } from '../types.js';
import { clearCanvas, type RasterSurface, surfaceFor, UnreadablePictureError } from './surface.js';

/**
 * What every raster tool checks before it touches a layer (docs/ARCHITECTURE.md
 * §7, "The editor"): that there is one, and that it is neither locked nor
 * hidden. A tool that may not draw says why, in the user's words, and does
 * nothing for the stroke.
 */

/**
 * The active layer, where a tool may change it, or, with `'read'`, take its
 * pixels without changing them, which a locked layer allows and a hidden one
 * does not, since what it would take cannot be seen; otherwise the user is
 * told and nothing comes back.
 */
/** A layer's name, as the panel shows it, for a line to the user. */
const nameOf = (context: ToolContext, layer: LayerInfo): string => {
	const index = context.document.snapshot().layers.findIndex((each) => each.id === layer.id);
	return layerDisplayName(layer, Math.max(0, index));
};

/** The active layer's name, as the panel shows it; nothing with none active. */
export const activeLayerName = (context: ToolContext): string =>
	context.layer === undefined ? '' : nameOf(context, context.layer);

export const guardedLayer = (
	context: ToolContext,
	needs: 'change' | 'read' = 'change'
): LayerInfo | undefined => {
	const { layer } = context;
	if (layer === undefined) {
		context.notify(t('layers.noneActive'));
		return undefined;
	}
	const locked = needs === 'change' && layer.locked;
	if (!locked && !layer.hidden) return layer;
	const name = nameOf(context, layer);
	context.notify(locked ? t('layers.locked', { name }) : t('layers.hidden', { name }));
	return undefined;
};

/** The active layer's surface, where a tool may paint on it. */
export const guardedSurface = (context: ToolContext): RasterSurface | undefined =>
	guardedLayer(context) === undefined ? undefined : surfaceFor(context);

/** The live stroke gone from the screen canvas, and the opacity the stroke gave it. */
export const clearScreen = (target: ScreenCanvas): void => {
	clearCanvas(target.canvas);
	target.canvas.style.removeProperty('opacity');
};

/**
 * Strokes begun on the screen canvas, by any raster tool: one canvas shows
 * them all, so a stroke that lands clears it only when no stroke has begun
 * since, and a later one still under way keeps what it drew.
 */
const begun = cell(0);

/** A stroke's turn on the screen canvas: which it is among all begun. */
export const claimScreen = (): number => {
	begun.current += 1;
	return begun.current;
};

/** The screen cleared for a stroke that landed, unless another has begun since. */
export const releaseScreen = (target: ScreenCanvas, serial: number): void => {
	if (begun.current === serial) clearScreen(target);
};

/**
 * A commit that failed: the user is told, and the surface is forgotten, since
 * its pixels may no longer be the file's. The next stroke reads the file again.
 */
export const reportFailure = (
	context: ToolContext,
	surface: RasterSurface,
	error: unknown
): void => {
	surface.discard();
	context.notify(
		error instanceof UnreadablePictureError ? t('raster.unreadable') : t('raster.failed')
	);
};
