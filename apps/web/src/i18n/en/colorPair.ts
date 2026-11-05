/**
 * The two colors in the tool bar (docs/ARCHITECTURE.md §7, "The
 * interface"): one button for the pair, which opens and closes the color
 * panel, described by what each color is; and the reset, which is the color
 * panel's. `{color}` is a color as `#rrggbb` where it has that form, and as
 * the drawing wrote it where it does not.
 */
export const colorPair = {
	/** The pair's button, which opens and closes the color panel. */
	title: 'Colors',
	/** What the fill is, said after the button's name. */
	fill: 'Fill color: {color}',
	/** What the fill is when there is none. */
	fillNone: 'Fill color: none',
	/** What the stroke is, said after the button's name. */
	stroke: 'Stroke color: {color}',
	/** What the stroke is when there is none. */
	strokeNone: 'Stroke color: none',
	/** The fill and the stroke put back as a new drawing starts with them. */
	reset: 'Reset colors',
} as const;
