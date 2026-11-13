import type { DocumentFormat } from '@skysa/storage';

import { DRAWING_EXTENSION } from '../config.js';
import { isDrawingText, readDrawingId, withDrawingId } from './document.js';

/**
 * What a drawing's file is, as the kit's sync engine and adapters are handed
 * it (`DocumentFormat`, docs/ARCHITECTURE.md §7, "Sync engine"): the only
 * questions they ask of what a file holds. Everything else moves the file's
 * text whole, never its parts, so a drawing nobody edited is never
 * re-serialized by a sync. The answers are the drawing's own rules, from
 * `drawing/document.ts` (docs/decisions/0001-the-drawing-file.md).
 */

/**
 * What happens when both sides changed the same drawing (docs/ARCHITECTURE.md
 * §7, "Conflict rule (concrete)"): the copy is written beside the drawing,
 * holding the contents this builds.
 *
 * The local file exactly as it was, with a fresh `draw:id`. The id has to
 * change or the two drawings are the same drawing — the app tracks identity
 * through it, and two files claiming one id is the state the whole scheme is
 * built to avoid. `withDrawingId` rewrites the root tag and nothing else, so
 * every other byte is kept, the attributes this app knows nothing about with
 * them.
 *
 * Text that is not an SVG document has no id to share, so its copy is the
 * text as it is: nobody's drawing is claimed by it, and nothing is made up to
 * put in the user's file.
 */
export const conflictContent = (localContent: string, id: string): string =>
	isDrawingText(localContent) ? withDrawingId(localContent, id) : localContent;

export const DRAW_FORMAT: DocumentFormat = {
	extension: DRAWING_EXTENSION,
	mediaType: 'image/svg+xml',
	/**
	 * The id a file claims to be, where it carries one: the root's `draw:id`. A
	 * file another tool made has none, and is given one by the engine, which is
	 * not written into it until the user edits it.
	 */
	claimedId: readDrawingId,
	conflictContent,
	/**
	 * A `.svg` whose text is not an SVG document — a file misnamed, or one some
	 * tool wrote that is not one — is not a drawing, and is held as one that
	 * will not decode as UTF-8 is (`UnreadableError`): left alone, listed,
	 * never rewritten (docs/ARCHITECTURE.md §3).
	 */
	isDocumentText: isDrawingText,
};
