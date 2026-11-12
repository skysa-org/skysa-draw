/**
 * Connecting a storage account (the kit's docs/ARCHITECTURE.md §6, "Storage
 * OAuth, as built"): the question asked first when this device holds drawings
 * of its own, why a connect did not start, and what is said on the way back
 * from the provider.
 *
 * `{provider}` is a storage provider's name ("Dropbox", "Google Drive").
 */
export const connect = {
	/**
	 * The question before the drawings on this device move into the account.
	 * "Cancel" is the question's Cancel button.
	 */
	move: {
		title: 'Move your drawings to {provider}?',
		confirm: 'Connect and move',
		folders: {
			one: 'Your {count} folder on this device will move into {provider} and sync there. Cancel to keep it on this device only.',
			other: 'Your {count} folders on this device will move into {provider} and sync there. Cancel to keep them on this device only.',
		},
		drawings: {
			one: 'Your {count} drawing on this device will move into {provider} and sync there. Cancel to keep it on this device only.',
			other: 'Your {count} drawings on this device will move into {provider} and sync there. Cancel to keep them on this device only.',
		},
		/** Folders and drawings both: `{count}` is the drawings, and `{folders}` is `folderCount`. */
		both: {
			one: 'Your {folders} and {count} drawing on this device will move into {provider} and sync there. Cancel to keep them on this device only.',
			other: 'Your {folders} and {count} drawings on this device will move into {provider} and sync there. Cancel to keep them on this device only.',
		},
		/** How many folders, inside `both`. */
		folderCount: {
			one: '{count} folder',
			other: '{count} folders',
		},
	},
	/** The server would not start connecting, by what it said. */
	refused: {
		forbiddenOrigin:
			'The server would not start connecting from this page. Reload and try again.',
		notFound: 'This deployment does not offer that provider.',
		declined: 'The server would not start connecting. Try again.',
	},
	/** Connecting failed, by where it failed. */
	failed: {
		answered: 'The server could not start connecting. Try again.',
		unreachable: 'The server cannot be reached, so nothing was connected. Try again.',
		device: 'Something on this device went wrong, so nothing was connected. Try again.',
		unknown: 'Something went wrong. Try again.',
	},
	/** How connecting a storage account went, said on the way back from the provider (`?connect=…`). */
	outcome: {
		ok: 'Storage connected. Your drawings will sync with it.',
		/** The user said no at the provider's consent screen. */
		denied: 'Connecting storage was canceled.',
		failed: 'The storage account could not be connected. Try again.',
		/** The user unchecked the permission to their files on the provider's consent screen. */
		partial:
			'Access to your files was not granted, so storage was not connected. Connect again and leave that permission checked.',
		/** This server's operator will not take the account, for the reason each says. */
		refused: {
			/** A code typed into the operator's field before connecting. */
			code: 'The code you entered was not accepted or has expired, so storage was not connected.',
			notAllowed:
				'This account is not allowed to sync on this server, so storage was not connected.',
			lapsed: "This account's access to sync on this server has lapsed, so storage was not connected.",
			limitReached:
				'This server is at its limit for syncing accounts, so storage was not connected.',
			/** The server gave no reason. */
			cannotSync: 'This account cannot sync on this server, so storage was not connected.',
		},
		expired: 'Connecting storage did not finish. If it is not connected, connect it again.',
		/** The control that puts the message away. */
		dismiss: 'Dismiss',
	},
} as const;
