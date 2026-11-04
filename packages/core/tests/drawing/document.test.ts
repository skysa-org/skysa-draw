import { describe, expect, it } from 'vitest';

import {
	DEFAULT_DRAWING_SIZE,
	DRAWING_NAMESPACE,
	emptyDrawing,
	isDrawingText,
	readDrawingId,
	readDrawingProlog,
	readDrawingSize,
	readDrawingTitle,
	SVG_NAMESPACE,
	withDrawingId,
	withDrawingTitle,
} from '../../src/drawing/document.js';

const ID = '7f1b8c2e-4a7d-4d1f-9a3b-5c6d7e8f9a0b';

/** An SVG as another tool saves one: a prolog, a doctype, and no id of ours. */
const FOREIGN = `<?xml version="1.0" encoding="UTF-8" standalone="no"?>
<!-- Created with Inkscape (http://www.inkscape.org/) -->
<!DOCTYPE svg PUBLIC "-//W3C//DTD SVG 1.1//EN" "http://www.w3.org/Graphics/SVG/1.1/DTD/svg11.dtd">
<svg
   width="210mm"
   height="297mm"
   viewBox="0 0 210 297"
   version="1.1"
   xmlns="http://www.w3.org/2000/svg"
   xmlns:svg="http://www.w3.org/2000/svg">
  <title>A4 sheet</title>
  <rect x="10" y="10" width="50" height="50" />
</svg>
`;

/** An SVG as Illustrator saves one: a BOM, a comment, and a doctype with an internal subset. */
const WITH_SUBSET = `\uFEFF<?xml version="1.0" encoding="utf-8"?>
<!-- Generator: Adobe Illustrator -->
<!DOCTYPE svg PUBLIC "-//W3C//DTD SVG 1.1//EN" "http://www.w3.org/Graphics/SVG/1.1/DTD/svg11.dtd" [
	<!ENTITY ns_svg "http://www.w3.org/2000/svg">
]>
<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 10 10"><rect width="5" height="5"/></svg>
`;

/** The root tag and everything after it: what a prolog is not. */
const fromRoot = (text: string): string => text.slice(text.indexOf('<svg'));

describe('isDrawingText', () => {
	it('is true of an SVG document, with or without a prolog', () => {
		expect(isDrawingText(FOREIGN)).toBe(true);
		expect(isDrawingText('<svg xmlns="http://www.w3.org/2000/svg"></svg>')).toBe(true);
		expect(isDrawingText('﻿  <svg xmlns="http://www.w3.org/2000/svg"/>')).toBe(true);
		expect(isDrawingText(emptyDrawing({ id: ID }))).toBe(true);
	});

	it('is true of a root with a prefix, when the prefix is bound to SVG', () => {
		expect(isDrawingText('<svg:svg xmlns:svg="http://www.w3.org/2000/svg"></svg:svg>')).toBe(
			true
		);
		expect(isDrawingText('<svg:svg xmlns="http://www.w3.org/2000/svg"></svg:svg>')).toBe(false);
	});

	it('is false of anything else that might be named .svg', () => {
		expect(isDrawingText('')).toBe(false);
		expect(isDrawingText('<html><svg xmlns="http://www.w3.org/2000/svg"/></html>')).toBe(false);
		expect(isDrawingText('<svg>no namespace</svg>')).toBe(false);
		expect(isDrawingText('<svg xmlns="http://example.com/not-svg"/>')).toBe(false);
		expect(isDrawingText('# A markdown file\n')).toBe(false);
		expect(isDrawingText('<svgx xmlns="http://www.w3.org/2000/svg"/>')).toBe(false);
	});

	it('reads only the start of a large file', () => {
		const large = `<svg xmlns="http://www.w3.org/2000/svg">${'<path d="M0 0"/>'.repeat(200_000)}</svg>`;
		const started = performance.now();
		expect(isDrawingText(large)).toBe(true);
		expect(readDrawingId(large)).toBeUndefined();
		expect(performance.now() - started).toBeLessThan(200);
	});
});

describe('readDrawingProlog', () => {
	it('is the XML declaration and its line break on a drawing this app wrote', () => {
		expect(readDrawingProlog(emptyDrawing({ id: ID }))).toBe(
			'<?xml version="1.0" encoding="UTF-8"?>\n'
		);
	});

	it('is everything before the root tag, byte for byte, on a file from elsewhere', () => {
		expect(readDrawingProlog(FOREIGN)).toBe(FOREIGN.slice(0, -fromRoot(FOREIGN).length));
		const prolog = readDrawingProlog(WITH_SUBSET);
		expect(prolog).toBe(WITH_SUBSET.slice(0, -fromRoot(WITH_SUBSET).length));
		expect(prolog?.startsWith('\uFEFF<?xml')).toBe(true);
		expect(prolog).toContain('<!-- Generator: Adobe Illustrator -->');
		expect(prolog?.endsWith('<!ENTITY ns_svg "http://www.w3.org/2000/svg">\n]>\n')).toBe(true);
	});

	it('is empty where the root tag opens the file', () => {
		expect(readDrawingProlog(`<svg xmlns="${SVG_NAMESPACE}"/>`)).toBe('');
	});

	it('is nothing for text that is not an SVG document', () => {
		expect(readDrawingProlog('<html/>')).toBeUndefined();
		expect(readDrawingProlog('not xml')).toBeUndefined();
		expect(readDrawingProlog('<?xml version="1.0"?>\n<svg>no namespace</svg>')).toBeUndefined();
		expect(readDrawingProlog('')).toBeUndefined();
	});

	it('puts the file back together with what follows it', () => {
		[emptyDrawing({ id: ID, title: 'Logo' }), FOREIGN, WITH_SUBSET].forEach((text) => {
			const prolog = readDrawingProlog(text) ?? 'not a drawing';
			expect(prolog + text.slice(prolog.length)).toBe(text);
			expect(text.slice(prolog.length)).toBe(fromRoot(text));
		});
	});
});

describe('readDrawingId', () => {
	it('reads the id this app wrote', () => {
		expect(readDrawingId(emptyDrawing({ id: ID }))).toBe(ID);
	});

	it('finds the attribute by its namespace, whatever the prefix', () => {
		expect(
			readDrawingId(
				`<svg xmlns="${SVG_NAMESPACE}" xmlns:sk="${DRAWING_NAMESPACE}" sk:id='${ID}'/>`
			)
		).toBe(ID);
		expect(readDrawingId(`<svg xmlns="${SVG_NAMESPACE}" draw:id="${ID}"/>`)).toBeUndefined();
		expect(
			readDrawingId(
				`<svg xmlns="${SVG_NAMESPACE}" xmlns:draw="http://example.com/other" draw:id="${ID}"/>`
			)
		).toBeUndefined();
	});

	it('has no id for a file of another tool, or one with an id it would not write', () => {
		expect(readDrawingId(FOREIGN)).toBeUndefined();
		expect(
			readDrawingId(
				`<svg xmlns="${SVG_NAMESPACE}" xmlns:draw="${DRAWING_NAMESPACE}" draw:id=""/>`
			)
		).toBeUndefined();
		expect(
			readDrawingId(
				`<svg xmlns="${SVG_NAMESPACE}" xmlns:draw="${DRAWING_NAMESPACE}" draw:id="a b"/>`
			)
		).toBeUndefined();
		expect(readDrawingId('not svg')).toBeUndefined();
	});
});

describe('withDrawingId', () => {
	it('gives a file of another tool an id and keeps every other byte', () => {
		const given = withDrawingId(FOREIGN, ID);
		expect(readDrawingId(given)).toBe(ID);
		expect(given).toContain(`xmlns:draw="${DRAWING_NAMESPACE}" draw:id="${ID}">`);
		expect(given.replace(` xmlns:draw="${DRAWING_NAMESPACE}" draw:id="${ID}"`, '')).toBe(
			FOREIGN
		);
		expect(readDrawingTitle(given)).toBe('A4 sheet');
	});

	it('replaces the id a file has, under the prefix the file uses', () => {
		const other = '0'.repeat(32);
		const text = `<svg xmlns="${SVG_NAMESPACE}" xmlns:sk="${DRAWING_NAMESPACE}" sk:id="${other}" viewBox="0 0 1 1"/>`;
		const changed = withDrawingId(text, ID);
		expect(readDrawingId(changed)).toBe(ID);
		expect(changed).not.toContain(other);
		expect(changed.match(/sk:id=/g)).toHaveLength(1);
		expect(changed).toBe(
			`<svg xmlns="${SVG_NAMESPACE}" xmlns:sk="${DRAWING_NAMESPACE}" sk:id="${ID}" viewBox="0 0 1 1"/>`
		);
	});

	it('chooses a prefix the root has not bound already', () => {
		const text = `<svg xmlns="${SVG_NAMESPACE}" xmlns:draw="http://example.com/x"></svg>`;
		const given = withDrawingId(text, ID);
		expect(given).toContain(`xmlns:draw2="${DRAWING_NAMESPACE}" draw2:id="${ID}"`);
		expect(readDrawingId(given)).toBe(ID);
	});

	it('is its own result a second time', () => {
		const once = withDrawingId(FOREIGN, ID);
		expect(withDrawingId(once, ID)).toBe(once);
	});

	it('refuses an id it would not read back, and text that is not a drawing', () => {
		expect(() => withDrawingId(FOREIGN, '')).toThrow(RangeError);
		expect(() => withDrawingId(FOREIGN, 'a"b')).toThrow(RangeError);
		expect(() => withDrawingId(FOREIGN, '-starts-with-a-dash')).toThrow(RangeError);
		expect(() => withDrawingId(FOREIGN, 'x'.repeat(65))).toThrow(RangeError);
		expect(() => withDrawingId('<html/>', ID)).toThrow(RangeError);
	});
});

describe('readDrawingSize', () => {
	it('is the viewBox where there is one', () => {
		expect(readDrawingSize(FOREIGN)).toEqual({ width: 210, height: 297 });
		expect(readDrawingSize(`<svg xmlns="${SVG_NAMESPACE}" viewBox="-5,-5,20.5,10"/>`)).toEqual({
			width: 20.5,
			height: 10,
		});
		expect(readDrawingSize(emptyDrawing({ id: ID }))).toEqual(DEFAULT_DRAWING_SIZE);
	});

	it('falls back to width and height in user units, and to nothing otherwise', () => {
		expect(
			readDrawingSize(`<svg xmlns="${SVG_NAMESPACE}" width="800" height="600px"/>`)
		).toEqual({
			width: 800,
			height: 600,
		});
		expect(
			readDrawingSize(`<svg xmlns="${SVG_NAMESPACE}" width="210mm" height="297mm"/>`)
		).toBe(undefined);
		expect(readDrawingSize(`<svg xmlns="${SVG_NAMESPACE}" width="100%" height="100%"/>`)).toBe(
			undefined
		);
		expect(readDrawingSize(`<svg xmlns="${SVG_NAMESPACE}" width="800"/>`)).toBeUndefined();
		expect(readDrawingSize(`<svg xmlns="${SVG_NAMESPACE}"/>`)).toBeUndefined();
		expect(readDrawingSize('<html/>')).toBeUndefined();
	});

	it('takes no size from a viewBox that is not one', () => {
		expect(
			readDrawingSize(`<svg xmlns="${SVG_NAMESPACE}" viewBox="0 0 0 10"/>`)
		).toBeUndefined();
		expect(readDrawingSize(`<svg xmlns="${SVG_NAMESPACE}" viewBox="0 0 10"/>`)).toBeUndefined();
		expect(
			readDrawingSize(`<svg xmlns="${SVG_NAMESPACE}" viewBox="a b c d"/>`)
		).toBeUndefined();
	});
});

describe('readDrawingTitle', () => {
	it('is the text of the first title, references decoded', () => {
		expect(readDrawingTitle(FOREIGN)).toBe('A4 sheet');
		expect(readDrawingTitle(emptyDrawing({ id: ID, title: 'Q3 <plan> & "notes"' }))).toBe(
			'Q3 <plan> & "notes"'
		);
		expect(
			readDrawingTitle(
				`<svg xmlns="${SVG_NAMESPACE}">\n<!-- a comment -->\n<title id="t">Caf&#233; &#x1F389; &apos;x&apos;</title></svg>`
			)
		).toBe("Café 🎉 'x'");
	});

	it('is nothing for a drawing without one, or with an empty one', () => {
		expect(readDrawingTitle(emptyDrawing({ id: ID }))).toBeUndefined();
		expect(readDrawingTitle(emptyDrawing({ id: ID, title: '   ' }))).toBeUndefined();
		expect(
			readDrawingTitle(`<svg xmlns="${SVG_NAMESPACE}"><title>  </title></svg>`)
		).toBeUndefined();
		expect(readDrawingTitle(`<svg xmlns="${SVG_NAMESPACE}"/>`)).toBeUndefined();
		expect(
			readDrawingTitle(`<svg xmlns="${SVG_NAMESPACE}"><g><title>nested</title></g></svg>`)
		).toBeUndefined();
		expect(readDrawingTitle('<html><title>page</title></html>')).toBeUndefined();
	});
});

describe('emptyDrawing', () => {
	it('is a drawing this app reads back whole', () => {
		const text = emptyDrawing({ id: ID, title: 'Logo', size: { width: 400, height: 300 } });
		expect(text.startsWith('<?xml version="1.0" encoding="UTF-8"?>\n<svg xmlns=')).toBe(true);
		expect(text.endsWith('</svg>\n')).toBe(true);
		expect(isDrawingText(text)).toBe(true);
		expect(readDrawingId(text)).toBe(ID);
		expect(readDrawingTitle(text)).toBe('Logo');
		expect(readDrawingSize(text)).toEqual({ width: 400, height: 300 });
		expect(text).toContain('viewBox="0 0 400 300" width="400" height="300"');
	});

	it('is the root, the title and one empty vector layer, as docs/ARCHITECTURE.md §3 shows', () => {
		expect(emptyDrawing({ id: ID, title: 'Floor plan' })).toBe(
			[
				'<?xml version="1.0" encoding="UTF-8"?>',
				`<svg xmlns="http://www.w3.org/2000/svg" xmlns:draw="https://skysa.org/draw/1" draw:id="${ID}" viewBox="0 0 1600 1000" width="1600" height="1000">`,
				'  <title>Floor plan</title>',
				'  <g id="layer-1" draw:kind="vector"/>',
				'</svg>',
				'',
			].join('\n')
		);
	});

	it('has the layer follow the root tag directly where there is no title', () => {
		expect(emptyDrawing({ id: ID })).toBe(
			[
				'<?xml version="1.0" encoding="UTF-8"?>',
				`<svg xmlns="http://www.w3.org/2000/svg" xmlns:draw="https://skysa.org/draw/1" draw:id="${ID}" viewBox="0 0 1600 1000" width="1600" height="1000">`,
				'  <g id="layer-1" draw:kind="vector"/>',
				'</svg>',
				'',
			].join('\n')
		);
		expect(emptyDrawing({ id: ID, title: '  ' })).toBe(emptyDrawing({ id: ID }));
	});

	it('refuses an id or a size it would not write', () => {
		expect(() => emptyDrawing({ id: 'not an id' })).toThrow(RangeError);
		expect(() => emptyDrawing({ id: ID, size: { width: 0, height: 10 } })).toThrow(RangeError);
		expect(() => emptyDrawing({ id: ID, size: { width: 10, height: Number.NaN } })).toThrow(
			RangeError
		);
	});
});

describe('withDrawingTitle', () => {
	it('replaces the title a file has, where it was', () => {
		const titled = withDrawingTitle(FOREIGN, 'Letter');
		expect(readDrawingTitle(titled)).toBe('Letter');
		expect(titled).toBe(FOREIGN.replace('<title>A4 sheet</title>', '<title>Letter</title>'));
	});

	it('puts one right after the root where the file has none', () => {
		const text = emptyDrawing({ id: ID });
		const titled = withDrawingTitle(text, 'Plan & <sketch>');
		expect(readDrawingTitle(titled)).toBe('Plan & <sketch>');
		expect(titled).toContain(
			'>\n  <title>Plan &amp; &lt;sketch&gt;</title>\n  <g id="layer-1" draw:kind="vector"/>\n</svg>'
		);
		// Before the first layer, so a title given later is the same bytes as one given at birth.
		expect(titled).toBe(emptyDrawing({ id: ID, title: 'Plan & <sketch>' }));
		expect(withDrawingId(titled, ID)).toBe(titled);
	});

	it('opens a self-closing root to hold one', () => {
		expect(withDrawingTitle(`<svg xmlns="${SVG_NAMESPACE}"/>`, 'Dot')).toBe(
			`<svg xmlns="${SVG_NAMESPACE}"><title>Dot</title></svg>`
		);
		expect(withDrawingTitle(`<svg:svg xmlns:svg="${SVG_NAMESPACE}" />`, 'Dot')).toBe(
			`<svg:svg xmlns:svg="${SVG_NAMESPACE}"><title>Dot</title></svg:svg>`
		);
		expect(withDrawingTitle(`<svg xmlns="${SVG_NAMESPACE}"/>`, ' ')).toBe(
			`<svg xmlns="${SVG_NAMESPACE}"/>`
		);
	});

	it('takes the title away for an empty one, and leaves a file with none alone', () => {
		const untitled = withDrawingTitle(FOREIGN, '');
		expect(readDrawingTitle(untitled)).toBeUndefined();
		expect(untitled).toBe(FOREIGN.replace('\n  <title>A4 sheet</title>', ''));
		const plain = emptyDrawing({ id: ID });
		expect(withDrawingTitle(plain, '  ')).toBe(plain);
		// The layer line stays where it was, so an untitled drawing is the same bytes either way.
		expect(withDrawingTitle(emptyDrawing({ id: ID, title: 'Logo' }), '')).toBe(plain);
	});

	it('leaves a nested title alone, which is not the drawing’s', () => {
		const text = `<svg xmlns="${SVG_NAMESPACE}"><g><title>part</title></g></svg>`;
		const titled = withDrawingTitle(text, 'Whole');
		expect(readDrawingTitle(titled)).toBe('Whole');
		expect(titled).toContain('<g><title>part</title></g>');
	});

	it('refuses text that is not a drawing', () => {
		expect(() => withDrawingTitle('<html/>', 'x')).toThrow(RangeError);
	});
});
