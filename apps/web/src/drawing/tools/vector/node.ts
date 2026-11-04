import type { ToolBehaviour } from '../types.js';

/**
 * The node tool on a vector layer: a path's points and handles, moved (docs/decisions/0004-the-interface.md).
 * Not built yet: `undefined` until it is, so the tool says it does nothing here.
 */
export const createNode = (): ToolBehaviour | undefined => undefined;
