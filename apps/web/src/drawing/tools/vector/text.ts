import type { ToolBehaviour } from '../types.js';

/**
 * The text tool on a vector layer: a `<text>`, typed in place (docs/decisions/0004-the-interface.md).
 * Not built yet: `undefined` until it is, so the tool says it does nothing here.
 */
export const createText = (): ToolBehaviour | undefined => undefined;
