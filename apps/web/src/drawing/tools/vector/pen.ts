import type { ToolBehaviour } from '../types.js';

/**
 * The pen on a vector layer: a Bézier `<path>`, point by point (docs/decisions/0004-the-interface.md).
 * Not built yet: `undefined` until it is, so the tool says it does nothing here.
 */
export const createPen = (): ToolBehaviour | undefined => undefined;
