/**
 * The account panel under the sources in the library (docs/ARCHITECTURE.md
 * §6): how a source's syncing is going, what it needs from the user, the
 * devices holding it, and letting it go. What a source is called where the
 * user has not named it, and how far a long run has got, are the sync
 * layer's words (`connection`).
 *
 * `{provider}` is a storage provider's name ("Dropbox", "Google Drive"), or
 * `connection.someStorage` where a source no longer says which it was.
 */
export const account = {
	/** Where to withdraw the app's access by hand, under the question before a disconnect. Each tag is a link. */
	leftAtProvider: {
		onedrive:
			'Microsoft keeps this app’s access to its folder after it is disconnected, until it is removed there: <consent>microsoft.com/consent</consent> for a personal account; <myApps>My Apps</myApps> for a work or school account, or ask your administrator.',
	},
	/** The panel, as a landmark. */
	region: 'Storage',
	/** The `⋯` at the end of the showing source's row. */
	menu: {
		/** `{name}` is the source's name, as its row shows it. */
		sourceLabel: 'Options for “{name}”',
		rename: 'Rename',
		about: 'About {provider}',
		downloadAll: 'Download all drawings',
		syncNow: 'Sync now',
		rescan: 'Re-scan from scratch',
		stopHere: 'Stop syncing on this device',
		disconnect: 'Disconnect',
	},
	/** The panel while nothing is connected. "them" is the drawings on this device. */
	local: {
		signInMissing: 'Connecting storage needs a sign-in this server does not offer yet.',
		unreachable: 'Connecting storage needs the server, which cannot be reached.',
		mayClear:
			'This browser may clear them without warning. To keep them, connect storage or download them.',
		line: 'On this device only',
	},
	/**
	 * The status line: how the source's syncing is going, in a few words. It
	 * does not name the source, whose row is marked above it; its tooltip and
	 * the panel it opens (`details`) do, with the account. One line, whatever
	 * it says, and cut with "…" where the column is too narrow for it.
	 * `{time}` is a time today, or a date.
	 */
	line: {
		syncing: 'Syncing…',
		/** Syncing, held up on this device behind another tab or window of the app (`status.waiting`). */
		waiting: 'Waiting for a tab',
		synced: 'Synced',
		syncedAt: 'Synced {time}',
		offline: 'Offline',
		retrying: 'Trying again shortly',
		notSyncing: 'Not syncing',
		/** Changes sent so far in a long sync, of how many there are to send. */
		sending: '{done} of {total} sent',
		/** Drawings received so far in a long sync, of how many there are to receive. */
		receiving: '{done} of {total} received',
		/** A re-scan, with how many drawings it has found so far. */
		looking: {
			one: '{count} drawing found',
			other: '{count} drawings found',
		},
		/** The user paused syncing (`SyncDetails`), until they resume it. */
		paused: 'Paused',
		/** A re-scan before it has found enough to count. */
		lookingStart: 'Looking for drawings…',
		/** Reading what has changed since the last sync, before it has found enough to count. */
		checking: 'Checking…',
		/** The same, with how many changed drawings it has found so far. */
		checkingFound: {
			one: '{count} change found',
			other: '{count} changes found',
		},
	},
	/** Who the source's account is, as the status line's tooltip begins. */
	title: {
		syncing: 'Syncing with {provider}',
		/** `{account}` is the account's name at the provider, often an email address. */
		syncingAs: 'Syncing with {provider} · {account}',
	},
	/** The bar under the status line during a long sync. */
	progress: 'Sync progress',
	/**
	 * How syncing is going, opened from the status line (`SyncDetails`): the
	 * source and its account, what a sync is doing, and the way to pause it or
	 * resume it.
	 */
	details: {
		title: 'Syncing with {provider}',
		/** `{account}` is the account's name at the provider, often an email address. */
		titleAs: 'Syncing with {provider} · {account}',
		pausedTitle: 'Syncing paused',
		pause: 'Pause syncing',
		/** Under Pause syncing, before it is pressed. */
		pauseHint:
			'Pausing stops this sync now. Nothing syncs on this device until you resume it, choose Sync now, or open the app again.',
		resume: 'Resume syncing',
	},
	/**
	 * How syncing is going, as a sentence. `{error}` is what the provider or the
	 * browser said went wrong, as it said it, or `unknownError`.
	 */
	status: {
		syncing: 'Syncing…',
		waiting:
			'Syncing is waiting for another tab or window of this app to finish with the drawings on this device. If this does not go away, close the app’s other tabs.',
		synced: 'Synced',
		syncedAt: 'Synced {time}',
		offline: 'Offline. Changes are kept on this device and sync when the connection is back.',
		retrying: 'Could not sync with {provider}. Trying again shortly ({error}).',
		paused: 'Syncing with {provider} is paused on this device. Your edits are kept here and sent when it resumes.',
		lookingStart: 'Looking for drawings in {provider}…',
		checking: 'Checking {provider} for changes…',
		cannotSync: 'This app cannot sync with {provider} yet.',
		refused: {
			notAllowed: 'This account is not allowed to sync on this server.',
			lapsed: "This account's access to sync on this server has lapsed.",
			limitReached: 'This server is at its limit for syncing accounts.',
			unspecified: 'This account cannot sync on this server.',
		},
		notFound: 'The server no longer has this {provider} connection.',
		notSent:
			'Some changes could not be sent to {provider}. They will be tried again ({error}).',
		/** In place of what went wrong, where nothing said. */
		unknownError: 'unknown error',
	},
	/**
	 * Which change the provider would not take, after `{count}` tries. `{path}`
	 * is the drawing's, folder's or file's path in the source. “Sync now” is the
	 * menu item `menu.syncNow`.
	 */
	stuck: {
		write: {
			one: '{provider} would not take the edit to {path} after {count} try ({error}). Everything queued behind it is waiting. “Sync now” tries again.',
			other: '{provider} would not take the edit to {path} after {count} tries ({error}). Everything queued behind it is waiting. “Sync now” tries again.',
		},
		move: {
			one: '{provider} would not take the rename of {path} after {count} try ({error}). Everything queued behind it is waiting. “Sync now” tries again.',
			other: '{provider} would not take the rename of {path} after {count} tries ({error}). Everything queued behind it is waiting. “Sync now” tries again.',
		},
		delete: {
			one: '{provider} would not take the deletion of {path} after {count} try ({error}). Everything queued behind it is waiting. “Sync now” tries again.',
			other: '{provider} would not take the deletion of {path} after {count} tries ({error}). Everything queued behind it is waiting. “Sync now” tries again.',
		},
		mkdir: {
			one: '{provider} would not take the new folder {path} after {count} try ({error}). Everything queued behind it is waiting. “Sync now” tries again.',
			other: '{provider} would not take the new folder {path} after {count} tries ({error}). Everything queued behind it is waiting. “Sync now” tries again.',
		},
		rmdir: {
			one: '{provider} would not take the removal of the folder {path} after {count} try ({error}). Everything queued behind it is waiting. “Sync now” tries again.',
			other: '{provider} would not take the removal of the folder {path} after {count} tries ({error}). Everything queued behind it is waiting. “Sync now” tries again.',
		},
		upload: {
			one: '{provider} would not take the upload of {path} after {count} try ({error}). Everything queued behind it is waiting. “Sync now” tries again.',
			other: '{provider} would not take the upload of {path} after {count} tries ({error}). Everything queued behind it is waiting. “Sync now” tries again.',
		},
		moveFile: {
			one: '{provider} would not take the move of the file to {path} after {count} try ({error}). Everything queued behind it is waiting. “Sync now” tries again.',
			other: '{provider} would not take the move of the file to {path} after {count} tries ({error}). Everything queued behind it is waiting. “Sync now” tries again.',
		},
		deleteFile: {
			one: '{provider} would not take the deletion of the file {path} after {count} try ({error}). Everything queued behind it is waiting. “Sync now” tries again.',
			other: '{provider} would not take the deletion of the file {path} after {count} tries ({error}). Everything queued behind it is waiting. “Sync now” tries again.',
		},
		/** A change queued for {path} that this version of the app cannot read, such as one a newer version queued. */
		malformed: {
			one: 'A change to {path} could not be sent to {provider} after {count} try: this version of the app cannot read it ({error}). Everything queued behind it is waiting. Updating the app may let it through.',
			other: 'A change to {path} could not be sent to {provider} after {count} tries: this version of the app cannot read it ({error}). Everything queued behind it is waiting. Updating the app may let it through.',
		},
	},
	/** A link to the drawing a stuck change is about. */
	openDrawing: 'Open the drawing',
	/**
	 * Drawings edited on two devices at once. "conflict" is the word put in the
	 * copy's file name, which stays English in every language.
	 */
	conflicts: {
		one: 'A drawing was edited here and elsewhere at once. Both versions are kept; the copy has "conflict" in its name.',
		other: '{count} drawings were edited here and elsewhere at once. Both versions of each are kept; the copies have "conflict" in their names.',
	},
	/** Files in the source that are not drawings this app can read, which sync leaves alone. */
	unreadable: {
		/** `<path>` is the one file's path; `<paths></paths>` is where the list of them goes. */
		files: {
			one: '<path>{path}</path> in {provider} is not an SVG drawing this app can read, so it is left alone: not shown here, not changed. Save it as an SVG file, or delete it, and it will be read.',
			other: '{count} files in {provider} are not SVG drawings this app can read, so they are left alone: <paths></paths>. Save them as SVG files, or delete them, and they will be read.',
		},
		/**
		 * After the sentence above: where the user's drawings went when one of those
		 * files took their name. `<paths></paths>` is where the list of them goes.
		 */
		moved: {
			one: 'A drawing of yours had that name; it is now at <paths></paths>.',
			other: 'Drawings of yours had those names; they are now at <paths></paths>.',
		},
	},
	/** A list of file paths, the first few by name. */
	paths: {
		/** Between two paths in the list. */
		separator: ', ',
		/** `<list></list>` is where the paths named go; `{count}` is how many more there are. */
		more: {
			one: '<list></list>, … and {count} more',
			other: '<list></list>, … and {count} more',
		},
	},
	/** The way back for a source the device can no longer sync. */
	reconnect: {
		cannotReach: 'This device can no longer reach {provider}.',
		needed: '{provider} needs to be connected again.',
		again: 'Connect again',
		/** For a source that has been disconnected. */
		detached: 'Reconnect',
	},
	/** The question before a re-scan, and its answer. */
	rescan: {
		question:
			'Read everything in {provider} again? This device compares every drawing with the folder from scratch. Drawings that are no longer in {provider} are removed here too, unless they have edits that have not been sent.',
		confirm: 'Re-scan',
	},
	/** The other devices holding this source's connection. */
	devices: {
		count: {
			one: '{count} other device signed in on this account',
			other: '{count} other devices signed in on this account',
		},
		title: 'Other devices signed in on this account',
		list: 'Other devices',
		none: 'No other device is signed in on this account.',
		/** `{device}` is what its browser called it ("Safari on iPhone"); `{when}` is a time today, or a date. */
		named: '{device}, last used {when}',
		unnamed: 'A device, last used {when}',
		namedIdle: '{device}, last used {when} · signed out for being idle',
		unnamedIdle: 'A device, last used {when} · signed out for being idle',
		remove: 'Remove',
		stillSignedIn: 'That device is still signed in: the server would not remove it.',
		failed: {
			answered: 'The server could not remove that device. Try again.',
			unreachable: 'The server cannot be reached, so nothing was removed. Try again.',
			device: 'Something on this device went wrong, so nothing was removed. Try again.',
			unknown: 'Something went wrong. That device may already have been removed; try again.',
		},
	},
	/** Letting a source go, and what came of it where that was not what was asked for. */
	disconnect: {
		refused: {
			notEntitled:
				'This account cannot sync on this server, and it would not disconnect it either.',
			declined: 'The server would not disconnect this account.',
		},
		/**
		 * `…OnServer` where the server was asked to disconnect the account, and
		 * `…Here` where only this device was to stop syncing it.
		 */
		failed: {
			answered: 'The server could not disconnect the account. Try again.',
			unreachable:
				'The server cannot be reached, so the account is still connected. Try again.',
			deviceOnServer:
				'Something on this device went wrong. The account may already be disconnected; try again.',
			deviceHere:
				'Something on this device went wrong. This device may still be syncing the account; try again.',
			unknownOnServer:
				'Something went wrong. The account may already be disconnected; try again.',
			unknownHere:
				'Something went wrong. This device may still be syncing the account; try again.',
		},
		outcome: {
			detached:
				'Something was saved in this source after the list was shown. It was not on the list, so it has been kept.',
			holding:
				'A drawing here has changes that could not be saved, so the drawing and this source have been kept rather than removed with it. Open the drawing and export a copy somewhere safe.',
			reconnected: 'This source was connected again meanwhile. Nothing has been changed.',
			noTarget: 'That source is not connected any more, so nothing was moved.',
			unverified:
				'This source has not been checked against its account yet, so what it holds could not be told apart from work that was never sent. Nothing was moved.',
			nothingToMove: 'There was nothing here to move, so nothing was moved.',
		},
		unreadable: 'What is on this device could not be read, so nothing was disconnected.',
		/** The step before the question, as a group's name and as what it says. */
		sending: 'Sending your last changes',
		sendingNow: 'Sending your last changes…',
	},
} as const;
