/**
 * Exporting a drawing, and placing a picture in one (docs/ARCHITECTURE.md §7,
 * "Export"). `{width}` and `{height}` are an export's size in pixels, `{n}` a
 * scale, `{max}` the most pixels an export has on its longer side.
 */
export const exporting = {
	title: 'Export',
	format: 'Format',
	formats: {
		png: 'PNG',
		jpeg: 'JPEG',
		webp: 'WebP',
		svg: 'SVG',
	},
	scale: 'Scale',
	/** One of the scales offered: `{n}` is how many pixels a unit of the canvas gets across. */
	scaleOption: '{n}×',
	/** The size the export will be, beside the scale. */
	size: '{width} × {height} px',
	/** The scale asked for more pixels than a canvas can hold, so the export is smaller. */
	capped: 'An export is at most {max} px on its longer side, so this one is smaller.',
	/** SVG chosen: the drawing's own file, which has no pixels to scale. */
	svgNote: 'The drawing’s own file, which stays sharp at any size.',
	/** What a JPEG, which cannot be see-through, has behind the drawing. */
	background: 'Background',
	/** The field for the exported file's name, without its extension. */
	name: 'File name',
	export: 'Export',
	busy: 'Exporting…',
	/** The browser could not render the drawing: a canvas too large for it, or a picture it could not decode. */
	failed: 'The drawing could not be exported. Try a smaller scale.',
	/** What undo calls a picture placed from a file, a paste or a drop. */
	place: 'Place picture',
	/** A file that is not a picture the app places, or one whose bytes it cannot read. */
	cannotPlace: 'This file cannot be placed. A picture in PNG, JPEG, GIF, WebP or SVG can.',
} as const;
