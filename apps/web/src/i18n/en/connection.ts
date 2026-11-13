/**
 * The connection to a storage account as the sync layer says it
 * (docs/ARCHITECTURE.md §6, §7): what a source is called where the user has
 * not named it, how far a sync or a first import has got, and what a download
 * of a source's drawings is called and says. The screens show these beside
 * their own words (`account`, `firstImport`, `unsent`).
 *
 * `{provider}` is a storage provider's name ("Dropbox", "Google Drive"), or
 * `someStorage` where a source no longer says which it was.
 */
export const connection = {
	/** The device's own drawings, as a source: on its row, and wherever a source is named. */
	pile: 'This device',
	/** A source that no longer says which provider it was at, as its row is named. */
	unknownSource: 'A source',
	/** The way to connect, while nothing is connected: a button with the words beside its `+`. */
	connectFirst: 'Connect storage provider',
	/** Stands in for a provider's name in a sentence, for a source that no longer says which it was. */
	someStorage: 'storage',
	/** A source named by its provider and the account there: "Dropbox · ann@example.com". */
	sourceName: '{provider} · {account}',
	/** The second and later source at one provider: "Dropbox 2". `{number}` is which of them it is. */
	numbered: '{provider} {number}',
	/** What Google Drive keeps the app from seeing in its own folder. `{folder}` is the folder's name. */
	unseen: {
		gdrive: {
			summary: 'Drawings added on the Drive website do not appear here',
			detail: '{provider} lets this app see only the files it made. Drawings added to the {folder} folder any other way, such as on the Drive website, with Drive for desktop or by another app, do not appear here. To bring a drawing in, open it in this app.',
		},
	},
	/**
	 * How far a long run has got, as a sentence that names the source
	 * (`runSentence` in `components/account/statusWords.ts`). `{done}` of
	 * `{total}` so far.
	 */
	progress: {
		looking: {
			one: 'Looking for drawings in {provider}: {count} found so far.',
			other: 'Looking for drawings in {provider}: {count} found so far.',
		},
		checkingFound: {
			one: 'Checking {provider} for changes: {count} changed drawing found so far.',
			other: 'Checking {provider} for changes: {count} changed drawings found so far.',
		},
		sending: 'Sending changes to {provider}: {done} of {total}.',
		receiving: 'Receiving drawings from {provider}: {done} of {total}.',
	},
	/**
	 * A source's drawings out of the app as one ZIP of `.svg` files
	 * (`store/exportDrawings.ts`): what the download and the files in it are
	 * called, and what is said once it has been handed over, or could not be.
	 */
	download: {
		/** The archive's file name, before `.zip`. `{date}` is the day it is made: 2026-10-07. */
		fileName: 'drawings-{date}',
		/** A file's name in the archive, before `.svg`, where nothing is left of the name it had. */
		unnamedFile: 'untitled',
		incomplete:
			'Downloaded, but a drawing here has changes that could not be saved, and the archive does not have them. Export that drawing before you close it.',
		/** Files the source has that this device holds no current copy of, and so not in the archive. */
		missing: {
			one: "Downloaded, without {count} file this device has no current copy of. It is still in the source's storage.",
			other: "Downloaded, without {count} files this device has no current copy of. They are still in the source's storage.",
		},
		failed: 'The drawings could not be downloaded. Try again.',
		/** `{most}` is the most entries a ZIP can hold. */
		tooMany:
			'There are too many drawings, folders and files here for one archive, which holds at most {most}. Nothing was downloaded.',
		tooLarge:
			'These drawings and files come to more than one archive can hold, which is 4 GB. Nothing was downloaded.',
		tooLong:
			'A drawing, folder or file here has a path too long to put in an archive. Nothing was downloaded.',
	},
} as const;
