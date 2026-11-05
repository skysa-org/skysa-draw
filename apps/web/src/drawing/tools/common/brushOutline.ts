import type { PointerSample, ToolBehavior, ToolContext } from '../types.js';
import type { Point } from '../vector/geometry.js';
import { createSvg, setAttributes } from '../vector/svg.js';

/**
 * The brush's outline (docs/decisions/0004-the-interface.md, "The brush's
 * outline"): Photoshop's Normal Brush Tip, the pointer of every tool with a
 * size. Over the canvas a circle as big on the screen as what the tool paints,
 * `size` across in the drawing's user units and so drawn on the overlay in
 * them, grows and shrinks with the zoom and follows the pointer, with a small
 * crosshair at its middle; where the circle would be smaller on the screen
 * than `RING_MIN_PX` across, the crosshair alone shows where the pointer is,
 * as Photoshop's does. It shows the size, never what pressure makes of it, as
 * Photoshop's does.
 *
 * Each line is drawn twice, a light halo under a dark hairline, the same width
 * on the screen at any zoom (`viewport.css`), so it reads on any picture, as
 * the marching ants do. The system's pointer is hidden while it shows, and the
 * canvas has the tool's crosshair before it does (`viewport.css`).
 *
 * It follows a mouse or a pen that hovers, and the stroke; takes a new size at
 * once (`optionsChanged`), whether from the strip or from `[` and `]`; and goes
 * when the pointer leaves the canvas (`leave`), on cancel, when the tool is put
 * down, since the viewport empties the overlay, and when a finger lifts. A
 * finger has no hover and covers the brush, so it is never shown for one.
 * The circle is in user units, so a zoom with the pointer still keeps it
 * true; the crosshair's arms, and whether the circle is too small to show,
 * are read at the zoom of the pointer's last move, until its next.
 */

/** The attribute that marks the outline on the overlay. */
const OUTLINE_MARK = 'data-brush-outline';

/** Under this many screen pixels across, the circle is left out and the crosshair alone is shown. */
const RING_MIN_PX = 6;

/** How far each arm of the crosshair reaches from the middle, in screen pixels. */
const ARM_PX = 4;

/** The outline's parts, in the order they are painted: both halos under both hairlines. */
const PARTS = [
	['circle', 'brush-outline-halo'],
	['path', 'brush-outline-halo'],
	['circle', 'brush-outline-line'],
	['path', 'brush-outline-line'],
] as const;

const outlineOf = (overlay: SVGSVGElement): Element | null =>
	overlay.querySelector(`[${OUTLINE_MARK}]`);

/** The outline on top of whatever the overlay holds, made where it is not there yet. */
const outlineIn = (overlay: SVGSVGElement): Element => {
	const found = outlineOf(overlay);
	if (found !== null) {
		// Over a stroke's own preview, which a tool adds as it begins.
		if (overlay.lastElementChild !== found) overlay.append(found);
		return found;
	}
	const owner = overlay.ownerDocument;
	const outline = createSvg(owner, 'g', { [OUTLINE_MARK]: '', class: 'brush-outline' });
	outline.append(
		...PARTS.map(([name, kind]) =>
			createSvg(owner, name, { class: kind, 'vector-effect': 'non-scaling-stroke' })
		)
	);
	overlay.append(outline);
	return outline;
};

/** How wide the tool paints, in user units: its size, or nothing for one that is not a size. */
const diameterOf = (context: ToolContext): number => {
	const { size } = context.options;
	return Number.isFinite(size) && size > 0 ? size : 0;
};

/** The screen's pixels per user unit, or 1 where the view has not said. */
const scaleOf = (context: ToolContext): number => {
	const { scale } = context.viewport;
	return Number.isFinite(scale) && scale > 0 ? scale : 1;
};

/** The outline's parts placed about `at`, the circle `diameter` across, in user units. */
const place = (outline: Element, at: Point, diameter: number, scale: number): void => {
	const arm = ARM_PX / scale;
	const ring = diameter * scale >= RING_MIN_PX;
	const cross = `M ${at.x - arm} ${at.y} H ${at.x + arm} M ${at.x} ${at.y - arm} V ${at.y + arm}`;
	Array.from(outline.children).forEach((part) => {
		if (part.localName === 'path') {
			setAttributes(part, { d: cross });
			return;
		}
		setAttributes(part, {
			cx: at.x,
			cy: at.y,
			r: diameter / 2,
			display: ring ? undefined : 'none',
		});
	});
};

/** Where the outline is, in user units, read back from it. */
const centerOf = (outline: Element): Point | undefined => {
	const circle = outline.querySelector('circle');
	const x = Number(circle?.getAttribute('cx'));
	const y = Number(circle?.getAttribute('cy'));
	return circle === null || !Number.isFinite(x) || !Number.isFinite(y) ? undefined : { x, y };
};

const hide = (context: ToolContext): void => {
	outlineOf(context.overlay)?.remove();
};

/** The outline where a sample is; none for a finger. */
const follow = (context: ToolContext, sample: PointerSample): void => {
	if (sample.pointerType === 'touch') {
		hide(context);
		return;
	}
	place(
		outlineIn(context.overlay),
		{ x: sample.x, y: sample.y },
		diameterOf(context),
		scaleOf(context)
	);
};

/**
 * A tool with a size, with the brush's outline as its pointer: `behavior`
 * does what it does, and the outline is drawn over what it draws on the
 * overlay.
 */
export const withBrushOutline = (behavior: ToolBehavior): ToolBehavior => ({
	...behavior,
	begin: (context, sample) => {
		behavior.begin(context, sample);
		follow(context, sample);
	},
	move: (context, sample) => {
		behavior.move(context, sample);
		follow(context, sample);
	},
	end: (context, sample) => {
		behavior.end(context, sample);
		follow(context, sample);
	},
	cancel: (context) => {
		behavior.cancel(context);
		hide(context);
	},
	hover: (context, sample) => {
		behavior.hover?.(context, sample);
		follow(context, sample);
	},
	leave: (context) => {
		behavior.leave?.(context);
		hide(context);
	},
	optionsChanged: (context) => {
		behavior.optionsChanged?.(context);
		const outline = outlineOf(context.overlay);
		const at = outline === null ? undefined : centerOf(outline);
		if (outline === null || at === undefined) return;
		place(outline, at, diameterOf(context), scaleOf(context));
	},
});
