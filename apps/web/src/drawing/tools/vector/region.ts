import type { ToolBehaviour } from '../types.js';

/**
 * The marquee and the lasso on a vector layer: every element the area touches, selected.
 * Not built yet: `undefined` until it is, so the tool says it does nothing here.
 */
export const createRegionSelect = (_kind: 'marquee' | 'lasso'): ToolBehaviour | undefined =>
	undefined;
