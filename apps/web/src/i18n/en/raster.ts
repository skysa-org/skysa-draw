/** What the raster tools say (docs/ARCHITECTURE.md §7, "The editor"). */
export const raster = {
	/** The layer's picture would not decode, so a stroke on it would replace it with nothing; none is written. */
	unreadable: 'This layer’s picture could not be read, so it cannot be painted on.',
	/** A stroke's pixels could not be encoded or written into the layer. */
	failed: 'The stroke could not be saved. Try again.',
} as const;
