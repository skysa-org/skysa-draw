import type { EditorDocument } from '../document/model.js';

/** A rectangle in the drawing's user units. */
export type Box = Readonly<{ x: number; y: number; width: number; height: number }>;

/**
 * The drawing's canvas, as the editor shows it (docs/ARCHITECTURE.md §3, "The
 * drawing file"): the live root's `viewBox`, read again each time so a crop is
 * seen; or, for a file with none or one that is not four numbers with a size,
 * the size the document was opened at, from the origin.
 */
export const canvasBox = (document: EditorDocument): Box => {
	const numbers = (document.root.getAttribute('viewBox') ?? '')
		.trim()
		.split(/[\s,]+/)
		.map(Number);
	const [x = 0, y = 0, width = 0, height = 0] = numbers;
	const valid = numbers.length === 4 && numbers.every(Number.isFinite) && width > 0 && height > 0;
	return valid ? { x, y, width, height } : { x: 0, y: 0, ...document.size };
};
