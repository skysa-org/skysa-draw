/**
 * The layers panel (docs/ARCHITECTURE.md §3, "Layers"). `{n}` is an unnamed
 * layer's number, `{name}` a layer's name as the panel shows it.
 */
export const layers = {
	title: 'Layers',
	/** An unnamed layer, by its number. */
	unnamed: 'Layer {n}',
	add: 'New layer',
	addRaster: 'New raster layer',
	addGroup: 'New group',
	delete: 'Delete layer',
	duplicate: 'Duplicate layer',
	rename: 'Rename layer',
	/** The rename field's label. */
	name: 'Name',
	/** A shape loose in the drawing, put in a layer of its own the first time it is edited: what undo calls that. */
	wrap: 'Make into a layer',
	hide: 'Hide layer',
	show: 'Show layer',
	lock: 'Lock layer',
	unlock: 'Unlock layer',
	opacity: 'Opacity',
	blend: 'Blend mode',
	moveUp: 'Move up',
	moveDown: 'Move down',
	/** The menu of the rarer actions on the active layer. */
	actions: 'Layer actions',
	/** Puts the active layer in a new group of its own. */
	group: 'Group layer',
	/** Puts a group's layers back where the group was, and takes the group away. */
	ungroup: 'Ungroup',
	/** The active layer and the one below it become one. */
	mergeDown: 'Merge down',
	/** A vector layer, or a group, drawn as pixels in a raster layer. */
	rasterize: 'Rasterize layer',
	/** Photoshop's clipping mask: the layer shows only where the layer below it has paint. */
	clip: 'Clip to layer below',
	unclip: 'Release clip',
	/** Said after a clipped layer's name, to a screen reader; the row shows an arrow. */
	clipped: 'Clipped to the layer below',
	/** What undo calls a change to the root's definitions that a step made beside its own. */
	definition: 'Change definitions',
	/** Ungroup asked of a group whose opacity, blend mode, filter, mask or style its layers would lose. */
	ungroupStyled:
		'This group has an opacity, a blend mode, an effect or a style of its own, which its layers would lose. Take it off the group first.',
	mergeHidden: 'Hidden layers cannot be merged. Show both layers first.',
	mergeLocked: 'Locked layers cannot be merged. Unlock both layers first.',
	rasterizeLocked: 'A locked layer cannot be rasterized. Unlock it first.',
	/** Clip asked of a layer that has a mask from another tool, which is never rewritten. */
	clipForeign:
		'This layer already has a mask from another tool, so it cannot be clipped as well.',
	/** A merge or a rasterize whose render the browser could not do: nothing changed. */
	renderFailed: 'This browser could not draw the layer as pixels, so nothing was changed.',
	/** The drawing changed while a merge or a rasterize was rendering: nothing changed. */
	renderChanged:
		'The drawing changed while the layer was being drawn as pixels, so nothing was changed. Try again.',
	/** A tool asked to change a locked layer. */
	locked: '“{name}” is locked.',
	/** A tool asked to draw on a hidden layer. */
	hidden: '“{name}” is hidden.',
	/** No layer is active: a tool asked to draw. */
	noneActive: 'Choose a layer to draw on.',
	/**
	 * A layer's adjustments, SVG filters on the layer (docs/decisions/0003-layers.md).
	 * `{name}` is an adjustment's name, as `kinds` gives it.
	 */
	adjustments: {
		title: 'Adjustments',
		add: 'Add adjustment',
		remove: 'Remove {name}',
		moveUp: 'Move {name} up',
		moveDown: 'Move {name} down',
		/** A filter on the layer that another tool made, which is left alone. */
		foreign: 'Filter from another tool',
		foreignNote: 'This layer has a filter made in another tool. It is kept as it is.',
		/** What undo calls each change to the adjustments. */
		change: 'Change adjustment',
		removed: 'Remove adjustment',
		reorder: 'Reorder adjustments',
		kinds: {
			brightness: 'Brightness',
			contrast: 'Contrast',
			hue: 'Hue',
			saturation: 'Saturation',
			blur: 'Blur',
			invert: 'Invert',
			grayscale: 'Greyscale',
			shadow: 'Drop shadow',
		},
		/** A drop shadow's sliders, named apart from the layer's own opacity. */
		shadow: {
			dx: 'Shadow offset across',
			dy: 'Shadow offset down',
			blur: 'Shadow blur',
			opacity: 'Shadow opacity',
		},
	},
	kind: {
		vector: 'Vector',
		raster: 'Raster',
		group: 'Group',
	},
	blendModes: {
		normal: 'Normal',
		multiply: 'Multiply',
		screen: 'Screen',
		overlay: 'Overlay',
		darken: 'Darken',
		lighten: 'Lighten',
		colorDodge: 'Colour dodge',
		colorBurn: 'Colour burn',
		hardLight: 'Hard light',
		softLight: 'Soft light',
		difference: 'Difference',
		exclusion: 'Exclusion',
		hue: 'Hue',
		saturation: 'Saturation',
		color: 'Colour',
		luminosity: 'Luminosity',
	},
} as const;
