/**
 * The two colors at the foot of the tool bar (docs/ARCHITECTURE.md §7, "The
 * interface"): the fill and the stroke, each named with its value, and the
 * swap; and the reset, which is the color panel's. `{color}` is a color as
 * `#rrggbb` where it has that form, and as the drawing wrote it where it
 * does not.
 */
export const colorPair = {
	/** The pair, named for a screen reader; and its one control where the bar is short of room. */
	title: 'Colors',
	/** The fill's control, which opens the color panel on the fill. */
	fill: 'Fill color: {color}',
	/** The fill's control when there is no fill. */
	fillNone: 'Fill color: none',
	/** The stroke's control, which opens the color panel on the stroke. */
	stroke: 'Stroke color: {color}',
	/** The stroke's control when there is no stroke. */
	strokeNone: 'Stroke color: none',
	/** The fill becomes the stroke and the stroke the fill. */
	swap: 'Swap colors',
	/** The fill and the stroke put back as a new drawing starts with them. */
	reset: 'Reset colors',
} as const;
