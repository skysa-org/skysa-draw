/**
 * The drawing's Image operations, in the editor's menu, as Photoshop's Image
 * menu has them (`drawing/document/canvasOps.ts`): the image's size, the
 * canvas's, its rotation, trim and reveal all; their dialogs; and what is
 * said when one of them changes nothing. `{width}` and `{height}` are a size
 * in the drawing's pixels.
 */
export const image = {
	imageSize: 'Image size…',
	canvasSize: 'Canvas size…',
	/** The submenu of fixed turns and flips, and Arbitrary…. */
	rotation: 'Image rotation',
	trim: 'Trim…',
	revealAll: 'Reveal all',
	turns: {
		rotate180: '180°',
		rotate90cw: '90° clockwise',
		rotate90ccw: '90° counterclockwise',
		/** A turn by any angle, asked in a dialog. */
		arbitrary: 'Arbitrary…',
		flipHorizontal: 'Flip canvas horizontal',
		flipVertical: 'Flip canvas vertical',
	},
	/** What undo calls each. */
	undo: {
		imageSize: 'Image size',
		canvasSize: 'Canvas size',
		rotate: 'Rotate canvas',
		flip: 'Flip canvas',
		trim: 'Trim',
		revealAll: 'Reveal all',
	},
	/** What the dialogs share: the canvas's size, the fields for a new one, and the button that applies. */
	fields: {
		/** Over the fields, the canvas as it is. */
		current: 'Current size: {width} × {height} px',
		/** Canvas size's, under fields that say how much to add or take away: the size that makes. */
		next: 'New size: {width} × {height} px',
		width: 'Width',
		height: 'Height',
		/** After a field in pixels: its unit, which a screen reader says after the field's name. */
		px: 'px',
		/** After a field in degrees. */
		degrees: '°',
		apply: 'Apply',
	},
	/** Image size…: everything drawn scaled with the canvas. */
	sizeDialog: {
		title: 'Image size',
		/** Photoshop's link between the width and the height: one changed, the other follows. */
		constrain: 'Constrain proportions',
		/** Photoshop's Resample: a raster layer's pixels made again at the new size, rather than stretched. */
		resample: 'Resample',
	},
	/** Canvas size…: the canvas grown or cut, and nothing drawn moved or scaled. */
	canvasDialog: {
		title: 'Canvas size',
		/** Photoshop's Relative: the fields say how much to add or take away. */
		relative: 'Relative',
		/** The nine places the drawing can keep as the canvas grows or shrinks around it, as a group. */
		anchor: 'Anchor',
		anchors: {
			topLeft: 'Top left',
			top: 'Top',
			topRight: 'Top right',
			left: 'Left',
			center: 'Center',
			right: 'Right',
			bottomLeft: 'Bottom left',
			bottom: 'Bottom',
			bottomRight: 'Bottom right',
		},
	},
	/** Arbitrary…: the canvas turned by any angle, and grown to hold what was on it. */
	rotateDialog: {
		title: 'Rotate canvas',
		angle: 'Angle',
		/** Which way it turns, as a group. */
		direction: 'Direction',
		clockwise: 'Clockwise',
		counterclockwise: 'Counterclockwise',
	},
	/** Trim…: the canvas cut to what is painted, on the sides chosen. */
	trimDialog: {
		title: 'Trim',
		/** What is cut away, as a group. */
		basedOn: 'Based on',
		bases: {
			transparent: 'Transparent pixels',
			topLeft: 'Top left pixel color',
			bottomRight: 'Bottom right pixel color',
		},
		/** The sides that may be cut, as a group. */
		trimAway: 'Trim away',
		sides: {
			top: 'Top',
			bottom: 'Bottom',
			left: 'Left',
			right: 'Right',
		},
	},
	/** An operation that would change nothing, which is then not done. */
	nothing: {
		imageSize: 'The image is already that size.',
		trim: 'There is nothing to trim.',
		revealAll: 'Everything is already on the canvas.',
	},
	/** The drawing changed while an operation measured it or read its pixels: an undo, a stroke. */
	changed: 'The drawing changed before this could finish, so it is as it was. Try again.',
	/** A layer's picture the browser would not decode or let be read. */
	unrenderable:
		'This browser could not read the picture of a layer, so the drawing is as it was.',
	/** Anything else that stopped an operation. */
	failed: 'That could not be done, so the drawing is as it was.',
} as const;
