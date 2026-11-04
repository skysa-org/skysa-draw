import { SVG_NAMESPACE } from '@skysa/draw-core';

import type { ToolOptions } from '../types.js';

/**
 * Making and changing SVG elements the way the lint rules allow: through
 * `createElementNS` and `setAttribute`, never a property assignment, which
 * `functional/immutable-data` refuses and which an XML document would not
 * reflect anyway. A value of `undefined` takes the attribute away, so one
 * table of attributes says what a preview has and what it has no longer.
 */
export type Attributes = Readonly<Record<string, string | number | undefined>>;

export const setAttributes = (element: Element, attributes: Attributes): void => {
	Object.entries(attributes).forEach(([name, value]) => {
		if (value === undefined) {
			element.removeAttribute(name);
			return;
		}
		element.setAttribute(name, String(value));
	});
};

/** An element in `owner`, the document of the layer or the overlay it will join. */
export const createSvg = (
	owner: Document,
	name: string,
	attributes: Attributes = {}
): SVGElement => {
	const element = owner.createElementNS(SVG_NAMESPACE, name);
	setAttributes(element, attributes);
	return element;
};

/**
 * How the overlay's own marks look: the selection box and its handles, the
 * marquee, the eraser's ring. The app's tokens through `var()`, which a
 * `style` attribute takes and a presentation attribute does not, so the chrome
 * follows the theme (`styles/tokens.css`), with the light theme's values as the
 * fallback.
 */
export const CHROME_STYLE = 'stroke: var(--accent, #2563eb); fill: var(--bg, #ffffff)';

/** What a mark is drawn in where neither color is set: SVG's own default fill. */
const DEFAULT_INK = '#000000';

/**
 * The color a tool that always makes a mark draws with: the one it prefers,
 * else the other, else black. A pencil with no stroke color draws in the
 * fill color rather than drawing nothing.
 */
export const inkOf = (options: ToolOptions, prefer: 'fill' | 'stroke'): string => {
	const first = options[prefer];
	if (first !== 'none') return first;
	const other = prefer === 'fill' ? options.stroke : options.fill;
	return other === 'none' ? DEFAULT_INK : other;
};

/** `opacity` for a mark, or no attribute at full opacity, which is SVG's default. */
export const opacityOf = (options: ToolOptions): string | undefined =>
	options.opacity < 1 ? String(options.opacity) : undefined;

/**
 * The `fill`, `stroke` and `stroke-width` a shape gets from the options: a
 * fill of `none` is written out, since SVG's default is black, and a stroke of
 * `none` is left off, since that is SVG's default.
 */
export const paintOf = (options: ToolOptions): Attributes => ({
	fill: options.fill,
	stroke: options.stroke === 'none' ? undefined : options.stroke,
	'stroke-width': options.stroke === 'none' ? undefined : options.strokeWidth,
	opacity: opacityOf(options),
});
