import { describe, expect, it } from 'vitest';

import { emptyDrawing, readDrawingId, withDrawingId } from '../../src/drawing/document.js';
import { conflictContent, DRAW_FORMAT } from '../../src/drawing/format.js';

/**
 * What the kit's sync engine is handed of a drawing's file (`DRAW_FORMAT`):
 * the id a file claims, the contents of a conflict copy, an id of its own so
 * the copy and the original are never the same drawing, and which text is a
 * drawing at all. Its names are `tests/names/slug.test.ts`'s, and what the
 * engine does with text that is not a drawing is `notSvg.sync.test.ts`'s.
 */

describe('DRAW_FORMAT', () => {
	it('is a .svg, told to a provider as image/svg+xml', () => {
		expect(DRAW_FORMAT.extension).toBe('.svg');
		expect(DRAW_FORMAT.mediaType).toBe('image/svg+xml');
		expect(DRAW_FORMAT.conflictContent).toBe(conflictContent);
	});
});

describe('conflictContent', () => {
	const original = [
		'<?xml version="1.0" encoding="UTF-8"?>',
		'<!-- made by another tool -->',
		'<svg xmlns="http://www.w3.org/2000/svg" xmlns:draw="https://skysa.org/draw/1"',
		'     xmlns:inkscape="http://www.inkscape.org/namespaces/inkscape"',
		'     draw:id="original-id" inkscape:version="1.3" viewBox="0 0 10 10">',
		'  <title>Floor plan</title>',
		'  <g id="layer-1" inkscape:label="Walls"><path d="M0 0h10"/></g>',
		'</svg>',
		'',
	].join('\n');

	it('gives the copy an identity of its own', () => {
		// Two files claiming one id is the state the whole identity scheme
		// exists to avoid: the pair would fight over the same drawing for ever.
		const copy = conflictContent(original, 'fresh-id');
		expect(readDrawingId(copy)).toBe('fresh-id');
		expect(copy).not.toContain('original-id');
	});

	it('keeps every other byte, attributes the app knows nothing about included', () => {
		const copy = conflictContent(original, 'fresh-id');
		expect(copy).toBe(original.replace('original-id', 'fresh-id'));
	});

	it('gives a drawing from elsewhere with no id one, so the copy can be tracked', () => {
		const theirs =
			'<svg xmlns="http://www.w3.org/2000/svg"><rect width="1" height="1"/></svg>\n';
		const copy = conflictContent(theirs, 'fresh-id');
		expect(readDrawingId(copy)).toBe('fresh-id');
		expect(copy).toContain('<rect width="1" height="1"/>');
	});

	it('is the same bytes given the same id twice', () => {
		const once = conflictContent(emptyDrawing({ id: 'a', title: 'x' }), 'fresh-id');
		expect(conflictContent(once, 'fresh-id')).toBe(once);
	});

	it('leaves text that is not a drawing exactly as it is', () => {
		// It carries no id to share, so the copy claims nobody's drawing by
		// keeping it, and nothing is made up to put in the user's file.
		expect(conflictContent('not svg at all\n', 'fresh-id')).toBe('not svg at all\n');
	});
});

describe('claimedId', () => {
	const { claimedId } = DRAW_FORMAT;

	it('is the draw:id a file carries', () => {
		expect(claimedId(emptyDrawing({ id: 'from-the-file' }))).toBe('from-the-file');
	});

	it('is nothing for a drawing another tool made', () => {
		expect(claimedId('<svg xmlns="http://www.w3.org/2000/svg"/>')).toBeUndefined();
	});

	it('is nothing for text that is not a drawing', () => {
		expect(claimedId('---\nid: n1\n---\n')).toBeUndefined();
	});
});

describe('isDocumentText', () => {
	const isDocumentText = (text: string) => DRAW_FORMAT.isDocumentText?.(text);

	it('takes a drawing as one', () => {
		expect(
			isDocumentText(withDrawingId('<svg xmlns="http://www.w3.org/2000/svg"/>\n', 'n1'))
		).toBe(true);
	});

	it('refuses text that is not an SVG document', () => {
		// A `.svg` that decodes and is not one is a file misnamed, and the engine
		// leaves it alone as one that will not decode (docs/ARCHITECTURE.md §3).
		expect(isDocumentText('# a note\n')).toBe(false);
	});
});
