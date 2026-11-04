import type { ToolBehaviour } from '../types.js';

/**
 * The marquee and the lasso on a raster layer: an area the other raster tools paint inside.
 * Not built yet: `undefined` until it is, so the tool says it does nothing here.
 */
export const regionBehaviour = (_kind: 'marquee' | 'lasso'): ToolBehaviour | undefined => undefined;
