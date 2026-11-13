/**
 * The frame around everything: what it says when the app itself is in trouble,
 * and the screen around the drawings.
 */
export const shell = {
	error: {
		title: 'Something went wrong',
		text: 'The app hit an error it could not recover from by itself. The drawings saved on this device have not been touched.',
		details: 'What the error said',
	},
	update: {
		available: 'A new version is available.',
		updating: 'Updating…',
		slow: 'Still updating. If the app has not reloaded in a few minutes, close all of its windows and open it again.',
	},
	/** The three panes, named for a screen reader. */
	panes: {
		folders: 'Folders',
		drawings: 'Drawings',
		drawing: 'Drawing',
	},
	/** A newer build in another window has the database, or is waiting for it (`StaleTabGate`). */
	staleTab: {
		text: 'A newer version of the app is open in another window, and this one can no longer save. Reload to carry on here.',
		notYet: 'Not yet',
		cannotSave:
			'This window is out of date and cannot save. Export what you need, then reload.',
		waiting:
			'Waiting for an older window of this app to finish. If this does not go away, close the other windows.',
	},
	sync: {
		/** A provider request given up on: the words reach the storage panel. */
		timedOut: 'The storage provider did not answer in time.',
	},
} as const;
