import { isDrawingText, readDrawingId, withDrawingId } from '../drawing/document.js';
import { type EntryRef, type StorageProvider, UnreadableError } from '../providers/types.js';

/**
 * The document seam (docs/ARCHITECTURE.md §7, "Sync engine"): the one module
 * of the engine that knows what a drawing's file holds. Everything else moves
 * the file's text whole, never its parts, so a drawing nobody edited is never
 * re-serialized by a sync. skysa-notes' engine read a note's frontmatter in
 * the same three places; here they are the drawing's own rules, from
 * `drawing/document.ts` (docs/decisions/0001-the-drawing-file.md).
 */

/**
 * The id a file claims to be, where it carries one: the root's `draw:id`. A
 * file another tool made has none, and is given one by the engine
 * (`idForNewDrawing`), which is not written into it until the user edits it.
 */
export const claimedId: (content: string) => string | undefined = readDrawingId;

/**
 * What happens when both sides changed the same drawing (docs/ARCHITECTURE.md
 * §7, "Conflict rule (concrete)"): the copy is written beside the drawing,
 * under a name from `names/conflicts.ts`, holding the contents this builds.
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

/**
 * A drawing's text and version, read from the provider: `read`, with one rule
 * more. A `.svg` whose text is not an SVG document — a file misnamed, or one
 * some tool wrote that is not one — is not a drawing, and is answered as one
 * that will not decode as UTF-8 is (`UnreadableError`): left alone, listed,
 * never rewritten (docs/ARCHITECTURE.md §3). Used wherever the engine reads a
 * file to hold or compare it as a drawing; a read that asks only for a
 * version, or whether bytes are the ones last synced, asks the provider.
 */
export const readDrawingText = (
	provider: StorageProvider,
	ref: EntryRef
): Promise<{ content: string; version: string }> =>
	provider.read(ref).then((file) => {
		if (!isDrawingText(file.content)) throw new UnreadableError(ref.path);
		return file;
	});
