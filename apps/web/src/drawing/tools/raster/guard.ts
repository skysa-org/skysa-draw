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

/** The active layer, where a tool may change it; otherwise the user is told and nothing comes back. */
export const guardedLayer = (context: ToolContext): LayerInfo | undefined => {
	const { layer } = context;
	if (layer === undefined) {
		context.notify(t('layers.noneActive'));
		return undefined;
	}
	if (!layer.locked && !layer.hidden) return layer;
	const index = context.document.snapshot().layers.findIndex((each) => each.id === layer.id);
	const name = layerDisplayName(layer, Math.max(0, index));
	context.notify(layer.locked ? t('layers.locked', { name }) : t('layers.hidden', { name }));
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
