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
	/** A tool asked to change a locked layer. */
	locked: '“{name}” is locked.',
	/** A tool asked to draw on a hidden layer. */
	hidden: '“{name}” is hidden.',
	/** No layer is active: a tool asked to draw. */
	noneActive: 'Choose a layer to draw on.',
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
