import { SVG_NAMESPACE, withDrawingId } from '../../src/drawing/document.js';

const escaped = (text: string): string =>
	text.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');

/**
 * A drawing's text for a test, told apart from another by `marker`: an SVG
 * document as another tool would write it, with no `draw:id`, and the marker
 * in its `<desc>`, byte for byte, so two markers are two drawings' bytes and a
 * test can say which one a row holds. skysa-notes' tests wrote a note as its
 * marker alone, a markdown file with no frontmatter; this is that file as a
 * drawing (docs/ARCHITECTURE.md §3), which the engine reads as one where it
 * would read the bare marker as a `.svg` that is not (`DRAW_FORMAT.isDocumentText`).
 *
 * With `id`, the same with this app's id on the root (`withDrawingId`), as a
 * file this app wrote carries it. What the app writes for a new drawing is
 * `emptyDrawing`, for a test about that shape.
 */
export const svg = (marker: string, id?: string): string => {
	const text = `<svg xmlns="${SVG_NAMESPACE}"><desc>${escaped(marker)}</desc></svg>\n`;
	return id === undefined ? text : withDrawingId(text, id);
};
