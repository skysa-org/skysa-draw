import { type RefObject, useEffect, useEffectEvent, useSyncExternalStore } from 'react';

import { SELECTION_TOOLS } from '../selectionActions.js';
import type { ToolContext, ToolId } from '../tools/types.js';
import { hideSelection, showSelection } from '../tools/vector/region.js';
import type { Observable } from './observable.js';

/**
 * What is selected on a vector layer, shown on the canvas whoever selected it
 * (docs/ARCHITECTURE.md §7, "The interface"): a tool shows what it selects as
 * it selects it, and this shows what was selected from elsewhere, an item's
 * row in the layers panel, the same way (`showSelection`): the move tool's
 * box and handles, which a press then works from, or outlines, as the
 * marquee, the lasso and the wand show it, and the move tool where several
 * layers chosen move whole and a handle would do nothing
 * (`viewport/selectionCommands.ts`); nothing for another tool, which lets go
 * of the selection as it is taken up.
 *
 * Drawn after the selection or the tool changed, once React has rendered the
 * change, and never while a stroke is under way (`stroke`), so a tool's own
 * drawing during a drag is never fought: what a tool sets as a press begins
 * or as it is dragged is its to show, and what it sets as the press ends it
 * has shown already, which this draws again the same. Nothing selected takes
 * the box and the outlines away, and nothing else of a tool's.
 */
export const useSelectionShown = (
	selection: Observable<readonly Element[]>,
	toolId: ToolId,
	/** Whether the move tool is in hand with several layers chosen, which it moves whole. */
	together: boolean,
	/** The stroke under way, if one is. */
	stroke: RefObject<unknown>,
	/** The tools' context, as a press would have it; none before the viewport is laid out. */
	context: () => ToolContext | undefined
): void => {
	const elements = useSyncExternalStore(selection.subscribe, selection.get);
	const show = useEffectEvent(() => {
		if (stroke.current !== undefined || !SELECTION_TOOLS.has(toolId)) return;
		const shown = context();
		if (shown === undefined) return;
		if (elements.length === 0) {
			hideSelection(shown.overlay);
			return;
		}
		showSelection(shown, elements, toolId === 'select' && !together);
	});
	useEffect(() => {
		show();
	}, [elements, toolId, together]);
};
