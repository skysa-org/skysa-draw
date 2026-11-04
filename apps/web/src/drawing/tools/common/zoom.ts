import type { PointerSample, ToolBehaviour, ToolContext } from '../types.js';

/**
 * The zoom tool (docs/decisions/0004-the-interface.md): a click zooms in about
 * the point, with Alt out; a drag zooms continuously, by how far the pointer
 * went to the right or the left of where it began, about where it began. The
 * begin point stays under its screen point throughout, since every zoom is
 * about it, so the pointer's screen distance from it is its user distance
 * times the scale of the moment.
 */

/** What a click multiplies the scale by, in; Alt divides by it. */
export const ZOOM_CLICK = 1.5;
/** A drag of this many screen pixels multiplies the scale by e. */
export const ZOOM_DRAG_PX = 200;
/** A pointer that never got this far, in screen pixels, clicked rather than dragged. */
const CLICK_SLOP = 4;

type ZoomStroke = Readonly<{ anchor: PointerSample; scale: number; dragged: boolean }>;

const strokes = new WeakMap<ToolContext, ZoomStroke>();

export const zoomBehaviour: ToolBehaviour = {
	begin: (context, sample) => {
		strokes.set(context, { anchor: sample, scale: context.viewport.scale, dragged: false });
	},
	move: (context, sample) => {
		const stroke = strokes.get(context);
		if (stroke === undefined) return;
		const { scale } = context.viewport;
		const dx = (sample.x - stroke.anchor.x) * scale;
		const dy = (sample.y - stroke.anchor.y) * scale;
		const dragged = stroke.dragged || Math.hypot(dx, dy) >= CLICK_SLOP;
		if (!dragged) return;
		strokes.set(context, { ...stroke, dragged });
		const target = stroke.scale * Math.exp(dx / ZOOM_DRAG_PX);
		context.viewport.zoomBy(target / scale, stroke.anchor.x, stroke.anchor.y);
	},
	end: (context, sample) => {
		const stroke = strokes.get(context);
		strokes.delete(context);
		if (stroke === undefined || stroke.dragged) return;
		context.viewport.zoomBy(sample.altKey ? 1 / ZOOM_CLICK : ZOOM_CLICK, sample.x, sample.y);
	},
	cancel: (context) => {
		strokes.delete(context);
	},
};
