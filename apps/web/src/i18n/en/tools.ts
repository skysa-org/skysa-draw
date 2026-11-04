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
	},
	/** A tool that does nothing on the active layer's kind. */
	notOnVector: '{tool} does not work on a vector layer.',
	notOnRaster: '{tool} does not work on a raster layer.',
	notOnGroup: '{tool} does not work on a group. Choose a layer inside it.',
} as const;
