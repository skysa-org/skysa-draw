import type { PointerSample, ToolBehavior, ToolContext } from '../types.js';

/**
 * The hand (docs/decisions/0004-the-interface.md): the drawing follows the
 * pointer, on any kind of layer and on none. Each sample arrives in user units
 * through the view as it is at that moment, so once the view is panned by the
 * sample's distance from the point the stroke began at, that point is under
 * the pointer again, and the next sample's distance from it is exactly the
 * next pan. Nothing accumulates and nothing drifts, which is why the begin
 * sample is kept and never moved. It is kept by the context, which is one
 * object for one stroke, begin to end.
 */
const anchors = new WeakMap<ToolContext, PointerSample>();

export const handBehavior: ToolBehavior = {
	begin: (context, sample) => {
		anchors.set(context, sample);
	},
	move: (context, sample) => {
		const anchor = anchors.get(context);
		if (anchor === undefined) return;
		context.viewport.panBy(sample.x - anchor.x, sample.y - anchor.y);
	},
	end: (context) => {
		anchors.delete(context);
	},
	cancel: (context) => {
		anchors.delete(context);
	},
};
