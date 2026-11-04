/** The list of drawings, and the one that is open. `{title}` is a drawing's title. */
export const drawings = {
	new: 'New drawing',
	/** The title a drawing is made with, until it is given one. */
	untitled: 'Untitled',
	/** A folder with no drawings in it. */
	none: 'No drawings here yet.',
	/** Nothing open in the drawing pane. */
	nothingOpen: 'Choose a drawing, or make a new one.',
	/** The open drawing's picture, for a screen reader. */
	preview: 'Preview of “{title}”',
	rename: 'Rename',
	/** The rename field's label. */
	title: 'Title',
	save: 'Save',
	delete: 'Delete',
	/** Asked before a drawing is deleted. */
	confirmDelete: 'Delete “{title}”? This cannot be undone on this device.',
	/** A list row, for a screen reader: the title and when it last changed. */
	changed: 'Changed {when}',
} as const;
