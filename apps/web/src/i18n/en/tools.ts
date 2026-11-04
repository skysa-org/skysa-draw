/**
 * The tools, by the names users know them by, and the options they share
 * (docs/decisions/0004-the-interface.md). One tool is one tool on a vector
 * layer and on a raster one, so each has one name. `{tool}` is a tool's name.
 */
export const tools = {
	select: 'Select',
	node: 'Node',
	hand: 'Hand',
	zoom: 'Zoom',
	pencil: 'Pencil',
	brush: 'Brush',
	eraser: 'Eraser',
	smudge: 'Smudge',
	fill: 'Fill',
	eyedropper: 'Eyedropper',
	rectangle: 'Rectangle',
	ellipse: 'Ellipse',
	line: 'Line',
	pen: 'Pen',
	text: 'Text',
	marquee: 'Marquee',
	lasso: 'Lasso',
	wand: 'Magic wand',
	crop: 'Crop',
	options: {
		size: 'Size',
		opacity: 'Opacity',
		hardness: 'Hardness',
		smoothing: 'Smoothing',
		pressure: 'Pressure',
		fill: 'Fill',
		stroke: 'Stroke',
		strokeWidth: 'Stroke width',
		cornerRadius: 'Corner radius',
		tolerance: 'Tolerance',
		/** A shape or a selection kept to a square, a circle, a straight angle. */
		constrain: 'Constrain',
		fontSize: 'Font size',
		strength: 'Strength',
		/** The magic wand: only the pixels joined to the one clicked, or every one of its color. */
		contiguous: 'Contiguous',
		/** The move tool: a press first makes the topmost layer with something under it the active one, as Photoshop's Auto-Select. */
		autoSelect: 'Auto-select',
	},
	/** The magic wand on a raster layer whose picture would not decode: nothing is selected. */
	wandUnreadable: 'This layer’s picture could not be read, so nothing can be selected from it.',
	/** The magic wand's outline would be too long to use as a selection: nothing is selected. */
	wandTooDetailed: 'That selection has too many edges to make. Try a higher tolerance.',
	/** A tool that does nothing on the active layer's kind. */
	notOnVector: '{tool} does not work on a vector layer.',
	notOnRaster: '{tool} does not work on a raster layer.',
	notOnGroup: '{tool} does not work on a group. Choose a layer inside it.',
} as const;
