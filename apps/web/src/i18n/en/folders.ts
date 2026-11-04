/** The folders down the side. `{name}` is a folder's name. */
export const folders = {
	/** The root: every drawing not in a folder. */
	all: 'All drawings',
	new: 'New folder',
	/** The new folder field's label. */
	name: 'Folder name',
	create: 'Create',
	/** The name given to a folder with nothing usable in its name. */
	unnamed: 'Untitled',
	exists: 'There is already a folder called “{name}”.',
} as const;
