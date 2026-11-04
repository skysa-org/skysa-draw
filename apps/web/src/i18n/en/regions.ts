/** The marquee and the lasso, and the area they select (docs/ARCHITECTURE.md §7, "Tools"). */
export const regions = {
	/** What Delete did with an area selected on a raster layer, as the undo history names it. */
	clear: 'Clear selected area',
	/** The area filled with the fill color on a raster layer, as the undo history names it. */
	fill: 'Fill selected area',
	/** The area's pixels made a new layer above, as the undo history names it. */
	viaCopy: 'Layer via copy',
	/** The area's pixels moved to a new layer above, as the undo history names it. */
	viaCut: 'Layer via cut',
	/** The move tool's drag of the area's pixels on a raster layer, as the undo history names it. */
	move: 'Move selected pixels',
	/** Layer via copy or cut, or the move tool, with an area that holds no color on the active layer. */
	empty: 'The selected area of “{name}” is empty.',
} as const;
