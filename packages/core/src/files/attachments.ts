import { extensionOf } from '../names/extension.js';
import { mediaOf } from './mediaTypes.js';

/**
 * What the app knows about a file beside a drawing from its name alone (#187).
 * By name, because the name is all a drawing and a listing carry; the type a
 * provider recorded at upload is the uploader's word, and decides nothing here.
 *
 * Ported from skysa-notes with only what the sync engine uses (§12); the rest
 * of notes' module (how to show a file, what to call it, whether it opens in a
 * tab) comes with attachments beside a drawing (docs/ARCHITECTURE.md §10).
 */

/**
 * The type to tell a provider a file is, as it is uploaded, by its name (the
 * table's `upload`). Anything else goes up as bytes. This is what the provider
 * records and nothing more — the app reads the extension, never this.
 */
export const contentTypeOf = (name: string): string | undefined => {
	const media = mediaOf(extensionOf(name));
	return media?.upload === true ? media.type : undefined;
};
