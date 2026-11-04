/**
 * The editor's frame (docs/ARCHITECTURE.md §7, "The interface"): the top bar,
 * the panes named for a screen reader, zoom and colour. `{title}` is the
 * drawing's title, `{percent}` a zoom level, `{n}` an option's value.
 */
export const editor = {
	/** The top bar's way back to the library, on a compact window. */
	back: 'Back to drawings',
	/** The top bar's library control elsewhere. */
	library: 'Drawings',
	undo: 'Undo',
	redo: 'Redo',
	more: 'More',
	saved: 'Saved',
	saving: 'Saving…',
	panes: {
		tools: 'Tools',
		options: 'Tool options',
		canvas: 'Canvas',
		properties: 'Properties',
		/** The expanded window's column of panels beside the canvas. */
		dock: 'Layers and properties',
	},
	zoom: {
		fit: 'Fit to window',
		actual: 'Actual size',
		in: 'Zoom in',
		out: 'Zoom out',
		level: '{percent}%',
	},
	/** How a tool option's value reads beside its slider. `{n}` is the value. */
	units: {
		px: '{n} px',
		percent: '{n}%',
		degrees: '{n}°',
	},
	/** The top bar's More: export the drawing as a picture or as the SVG file. */
	export: 'Export…',
	/** The top bar's More: a picture from a file, as a new raster layer. */
	placePicture: 'Place picture…',
	/** The hidden file field "Place picture…" opens. */
	pictureFile: 'Picture to place',

	colour: {
		title: 'Colour',
		fill: 'Fill',
		stroke: 'Stroke',
		swap: 'Swap colours',
	},
	/** A file the sanitizer could not parse: shown as an image, not edited. */
	unreadable: 'This file cannot be edited here. It is shown as the browser draws it.',
	/**
	 * The drawing changed elsewhere, by sync or another tab, under unsaved
	 * edits: the other change kept the drawing, and the edits were kept as a
	 * drawing of their own beside it. `{title}` is the copy's title.
	 */
	keptCopy: 'This drawing changed elsewhere, so your edits were kept in a copy, “{title}”.',
	/**
	 * The drawing was deleted elsewhere, by sync or another tab, under unsaved
	 * edits: the edits were kept as a drawing of their own in its place, which
	 * the editor opened. `{title}` is its title.
	 */
	keptDeleted: 'This drawing was deleted elsewhere, so your edits were kept as “{title}”.',
	/**
	 * A conflict copy's title: the drawing's own, `{title}`, marked as its
	 * filename is, with `{stamp}` the time, UTC to the minute (`conflictStamp`).
	 */
	conflictTitle: '{title} (conflict {stamp})',
	/** A link to a drawing that is not on this device. */
	notFound:
		'This drawing is not on this device. It may have been deleted, or not have arrived here yet.',
} as const;
