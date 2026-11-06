/**
 * The area and the element selection, and what the canvas's context menu and
 * the options strip's selection bar do with them
 * (docs/decisions/0004-the-interface.md, "The context menu"). `{action}` is
 * one of the actions' names as the menu shows it, `{name}` a layer's name.
 */
export const selection = {
	/** The context menu over the canvas, named for a screen reader. */
	menu: 'Canvas actions',
	/** The same actions as buttons in the options strip, while something is selected. */
	bar: 'Selection',
	/** The actions, as the menu and the bar name them. */
	actions: {
		deselect: 'Deselect',
		selectInverse: 'Select inverse',
		/** Shift F6's alone, which no list shows: Modify… opened at Feather. */
		feather: 'Feather…',
		/** Modify…: the dialog that expands, contracts, smooths, borders or feathers the area, as Photoshop's Select > Modify. */
		modify: 'Modify…',
		/** A box and handles on the area's outline, to scale, rotate and move it, as Photoshop's Select > Transform Selection. */
		transformSelection: 'Transform selection',
		/** The outline kept as the box and handles left it. */
		applyTransform: 'Apply',
		/** The outline put back as it was before the transform. */
		cancelTransform: 'Cancel',
		/** The submenu of the four below, as Illustrator's Object › Arrange: where the selected shapes are among their layer's. */
		arrange: 'Arrange',
		/** The selected shapes above all the others on their layer. */
		bringToFront: 'Bring to front',
		/** Each selected shape above the next one above it. */
		bringForward: 'Bring forward',
		/** Each selected shape below the next one below it. */
		sendBackward: 'Send backward',
		/** The selected shapes below all the others on their layer. */
		sendToBack: 'Send to back',
		/** A copy of each selected shape, just above it, in the same place. */
		duplicateElements: 'Duplicate',
		layerViaCopy: 'Layer via copy',
		layerViaCut: 'Layer via cut',
		/** Fill…: the dialog that asks what the area is filled with, and how, as Photoshop's Edit > Fill. */
		fillDialog: 'Fill…',
		/** The area filled with the fill color at once, as Photoshop's fill with the foreground color: a key's alone. */
		fill: 'Fill with the fill color',
		/** The area filled with the stroke color at once, as Photoshop's fill with the background color: a key's alone. */
		fillWithStroke: 'Fill with the stroke color',
		/** The area's pixels made transparent. */
		clear: 'Clear',
		/** The canvas cut down to the box around the area. */
		crop: 'Crop to selection',
		/** The selected shapes taken out of the layer. */
		delete: 'Delete',
		selectAll: 'Select all',
		undo: 'Undo',
		redo: 'Redo',
		newLayer: 'New layer',
		duplicateLayer: 'Duplicate layer',
	},
	/**
	 * Modify…: the selection expanded, contracted, smoothed, made a border or
	 * feathered, as Photoshop's Select > Modify, in one dialog. Each way has
	 * its name, a line on what it does, and the radius's label as Photoshop's
	 * own dialog for that way names it.
	 */
	modify: {
		title: 'Modify selection',
		/** The five ways, as a group, named for a screen reader: the title says it to the eye. */
		ways: 'How to modify the selection',
		expand: {
			name: 'Expand',
			hint: 'Grows the selection outward on every side.',
			/** The slider's label. */
			radius: 'Expand by',
			/** The number field beside the slider, for a screen reader. */
			radiusValue: 'Expand by, in pixels',
		},
		contract: {
			name: 'Contract',
			hint: 'Shrinks the selection inward on every side.',
			radius: 'Contract by',
			radiusValue: 'Contract by, in pixels',
		},
		smooth: {
			name: 'Smooth',
			/** Photoshop's Smooth: what is smaller than the radius, a bump, a dent, a speck or a gap, is evened out. */
			hint: 'Rounds off corners and clears away specks.',
			radius: 'Sample radius',
			radiusValue: 'Sample radius in pixels',
		},
		border: {
			name: 'Border',
			/** The selection becomes a band on its own outline, as wide as the width, and the inside is left out. */
			hint: 'Selects only a band along the edge.',
			radius: 'Width',
			radiusValue: 'Border width in pixels',
		},
		feather: {
			name: 'Feather',
			/** How far the edge fades, on either side of the outline; the selection's own, set rather than changed by. */
			hint: 'Fades the edge on either side. 0 is a hard edge.',
			radius: 'Feather radius',
			radiusValue: 'Feather radius in pixels',
		},
		apply: 'Apply',
		/** After an Apply that would leave nothing of the area, most often a Contract wider than it: the area is kept as it was. */
		nothingLeft: 'That would leave nothing selected, so the selection is unchanged.',
		/** Over the window while Apply takes a while, on an area of many corners. */
		working: 'Modifying the selection…',
	},
	/**
	 * Fill…: what the area is filled with, and how it is laid over the
	 * layer's pixels. The two colors are the app's fill and stroke, which
	 * Photoshop calls the foreground and the background.
	 */
	fill: {
		title: 'Fill',
		contents: 'Contents',
		/** The fill color, with its swatch beside it. */
		fillColor: 'Fill color',
		/** The stroke color, with its swatch beside it. */
		strokeColor: 'Stroke color',
		/** A color of the user's own, picked in the field that opens under it. */
		color: 'Color…',
		/** The field under Color…, named for a screen reader. */
		colorValue: 'Fill with this color',
		/** The pixels made again from the rest of the picture. */
		contentAware: 'Content-Aware',
		blending: 'Blending',
		mode: 'Mode',
		opacity: 'Opacity',
		/** The number field beside the slider, for a screen reader. */
		opacityValue: 'Opacity in percent',
		/** Photoshop's checkbox: a transparent pixel stays transparent, a part-transparent one keeps its alpha. */
		preserveTransparency: 'Preserve transparency',
		apply: 'Apply',
		/** Over the canvas while a content-aware fill is under way. */
		working: 'Filling from the picture around the selection…',
		/** The button beside it, which Escape does too. */
		stop: 'Stop',
		/** A content-aware fill stopped by the user. */
		stopped: 'The fill was stopped, and the layer is as it was.',
		/** A content-aware fill stopped by a change to the layer while it ran: an undo, a stroke. */
		changed: 'The layer changed while it was being filled, so the fill was not applied.',
		/** A content-aware fill that could not be made. */
		failed: 'The selection could not be filled from the picture around it, so the layer is as it was.',
	},
	/** What undo calls the steps the selection makes on a vector layer. */
	history: {
		layerViaCopy: 'Layer via copy',
		layerViaCut: 'Layer via cut',
		/** Shapes brought to the front or forward, or sent backward or to the back. */
		arrange: 'Arrange',
		/** Shapes copied in place. */
		duplicate: 'Duplicate',
		/** Shapes moved to another place in their layer, or to another layer, from the layers panel. */
		moveElements: 'Move',
	},
	/** An action that changes pixels, asked of a layer that has none. */
	rasterOnly: '“{action}” works on a raster layer. Choose one in the layers panel first.',
	/** Crop to selection of an area that lies outside the canvas. */
	cropOutside: 'The selection is outside the canvas, so there is nothing to crop to.',
	/** Over the window while what changes a raster layer's pixels in the area takes a while. */
	working: {
		/** A fill with a color: Fill…, and the fill or stroke color at once. */
		fill: 'Filling the selection…',
		clear: 'Clearing the selection…',
		layerViaCopy: 'Copying the selection to a new layer…',
		layerViaCut: 'Cutting the selection to a new layer…',
	},
} as const;
