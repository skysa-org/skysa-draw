import { describe, expect, it } from 'vitest';

import { emptyDrawing, readDrawingId, withDrawingId } from '../../src/drawing/document.js';
import { createFakeProvider } from '../../src/providers/fake.js';
import { UnreadableError } from '../../src/providers/types.js';
import { claimedId, conflictContent, readDrawingText } from '../../src/sync/document.js';

/**
 * The document seam: what the engine reads of a drawing's file, and the
 * contents of a conflict copy, an id of its own so the copy and the original
 * are never the same drawing. Its name is `tests/names/conflicts.test.ts`.
 */

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

describe('readDrawingText', () => {
	it('reads a drawing as the provider has it', async () => {
		const provider = createFakeProvider();
		await provider.ensureRoot();
		const text = withDrawingId('<svg xmlns="http://www.w3.org/2000/svg"/>\n', 'n1');
		const entry = await provider.write('a.svg', text, {});
		await expect(readDrawingText(provider, entry)).resolves.toEqual({
			content: text,
			version: entry.version,
		});
	});

	it('answers text that is not an SVG document as unreadable', async () => {
		// A `.svg` that decodes and is not one is a file misnamed, and is left
		// alone as one that will not decode is (docs/ARCHITECTURE.md §3).
		const provider = createFakeProvider();
		await provider.ensureRoot();
		const entry = await provider.write('a.svg', '# a note\n', {});
		await expect(readDrawingText(provider, entry)).rejects.toBeInstanceOf(UnreadableError);
	});
});
