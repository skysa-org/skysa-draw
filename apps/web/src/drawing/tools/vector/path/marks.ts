import type { Point } from '../geometry.js';
import { type Attributes, CHROME_STYLE } from '../svg.js';

/**
 * How the pen and the node tool mark a path on the overlay: its outline, a
 * square for each anchor, filled where it is chosen, and a line out to a dot
 * for each handle, as Illustrator and Figma draw them. Tables of attributes,
 * not elements, so the sizes are tested without a DOM; the tools make the
 * elements (`createSvg`). The overlay is in the drawing's units, so a size
 * that should stay the same on screen is divided by the viewport's scale.
 */
export type Mark = Readonly<{ name: string; attributes: Attributes }>;

/** An anchor's side on screen, in CSS pixels. */
const ANCHOR_PX = 7;

/** A handle's dot's diameter on screen, in CSS pixels. */
const HANDLE_PX = 7;

/** How far from an anchor or a handle a press still takes it, in CSS pixels: more than it is drawn, for a finger. */
export const REACH_PX = 8;

/** How far from a segment a press still lands on it, in CSS pixels. */
export const SEGMENT_REACH_PX = 6;

const ACCENT = 'var(--accent, #2563eb)';

const OUTLINE_STYLE = `stroke: ${ACCENT}; fill: none`;

const CHOSEN_STYLE = `stroke: ${ACCENT}; fill: ${ACCENT}`;

const HAIRLINE = { 'vector-effect': 'non-scaling-stroke', 'stroke-width': 1 } as const;

/** The path's outline, a hairline in the accent, so a path with no stroke is still seen. */
export const outlineMark = (d: string): Mark => ({
	name: 'path',
	attributes: { d, style: OUTLINE_STYLE, ...HAIRLINE },
});

export const anchorMark = (p: Point, scale: number, chosen: boolean, grow = 1): Mark => {
	const side = (ANCHOR_PX * grow) / scale;
	return {
		name: 'rect',
		attributes: {
			'data-anchor': '',
			x: p.x - side / 2,
			y: p.y - side / 2,
			width: side,
			height: side,
			style: chosen ? CHOSEN_STYLE : CHROME_STYLE,
			...HAIRLINE,
		},
	};
};

/** A handle: the line from its anchor and the dot at its end. */
export const handleMarks = (anchor: Point, handle: Point, scale: number): readonly Mark[] => [
	{
		name: 'line',
		attributes: {
			x1: anchor.x,
			y1: anchor.y,
			x2: handle.x,
			y2: handle.y,
			style: OUTLINE_STYLE,
			...HAIRLINE,
		},
	},
	{
		name: 'circle',
		attributes: {
			'data-handle': '',
			cx: handle.x,
			cy: handle.y,
			r: HANDLE_PX / 2 / scale,
			style: CHROME_STYLE,
			...HAIRLINE,
		},
	},
];
