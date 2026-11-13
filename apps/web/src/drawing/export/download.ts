import { sanitizeFolderName, slugify } from '@skysa/draw-core';
import { extensionForType } from '@skysa/storage';

/**
 * A file handed to the user (docs/ARCHITECTURE.md §7, "Export"). Nothing of
 * it goes anywhere but the user's own device: no drawing content reaches the
 * API (CLAUDE.md).
 */

/**
 * How long a download's `blob:` URL is kept before it is let go: the browser
 * reads the blob after the click, and Safari has been seen to lose a download
 * whose URL went at once. FileSaver.js waits as long, for the same reason
 * (https://github.com/eligrey/FileSaver.js/blob/master/src/FileSaver.js).
 */
const REVOKE_AFTER_MS = 40_000;

/** A name's extension, where it is one an export is given, so `plan.png` is not saved as `plan.png.png`. */
const EXPORT_EXTENSION = /\.(?:png|jpe?g|webp|svg)$/i;

/**
 * The name the file is saved as: what the user typed, less what a file
 * system refuses, a leading dot and an export's extension typed after it;
 * the title's slug where that leaves nothing; and the extension of the type
 * the blob actually is, so a WebP a browser could only make as PNG is not
 * named `.webp`.
 */
export const fileName = (typed: string, title: string, type: string): string => {
	const stem = sanitizeFolderName(typed.trim().replace(EXPORT_EXTENSION, ''), slugify(title));
	const extension = extensionForType(type);
	return extension === undefined ? stem : `${stem}.${extension}`;
};

/**
 * `blob` saved as a file called `name`, the way a page can under this app's
 * CSP: an `<a download>` with a `blob:` URL, clicked from script and taken
 * away again. No inline script, and nothing opens in a tab.
 */
export const download = (blob: Blob, name: string): void => {
	const url = URL.createObjectURL(blob);
	const link = document.createElement('a');
	link.setAttribute('href', url);
	link.setAttribute('download', name);
	link.setAttribute('hidden', '');
	// In the page while it is clicked: Firefox has needed it there.
	document.body.append(link);
	link.click();
	link.remove();
	setTimeout(() => URL.revokeObjectURL(url), REVOKE_AFTER_MS);
};
