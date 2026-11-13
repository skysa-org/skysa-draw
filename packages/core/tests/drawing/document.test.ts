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
	withDrawingViewport,
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

	it('is false of a root whose prefix is empty, or more than one', () => {
		expect(isDrawingText('<:svg xmlns:="http://www.w3.org/2000/svg"/>')).toBe(false);
		expect(isDrawingText('<a:b:svg xmlns:a="http://www.w3.org/2000/svg"/>')).toBe(false);
		expect(isDrawingText('<svg: xmlns:svg="http://www.w3.org/2000/svg"/>')).toBe(false);
	});

	it('reads only the start of a large file', () => {
		const large = `<svg xmlns="http://www.w3.org/2000/svg">${'<path d="M0 0"/>'.repeat(200_000)}</svg>`;
		const started = performance.now();
		expect(isDrawingText(large)).toBe(true);
		expect(readDrawingId(large)).toBeUndefined();
		expect(performance.now() - started).toBeLessThan(200);
	});

	it('answers at once of a doctype that never closes', () => {
		// The whitespace in it could be read two ways, and each was tried: a
		// pattern quadratic in it, which for this text was seconds.
		const unclosed = `<!DOCTYPE svg${' '.repeat(200_000)}`;
		const started = performance.now();
		expect(isDrawingText(unclosed)).toBe(false);
		expect(readDrawingId(unclosed)).toBeUndefined();
		expect(readDrawingProlog(unclosed)).toBeUndefined();
		expect(performance.now() - started).toBeLessThan(200);
	});

	it('reads a prolog of a great many doctypes in time to their length', () => {
		// Each doctype's `[` was once looked for to the end of the file, so 400,000
		// of them were seconds.
		const text = `${'<!DOCTYPE>'.repeat(400_000)}<svg xmlns="http://www.w3.org/2000/svg"/>`;
		const started = performance.now();
		expect(isDrawingText(text)).toBe(true);
		expect(performance.now() - started).toBeLessThan(200);
	});

	it('ends a subset at a quoted ] that a > follows, as the pattern it replaced did', () => {
		expect(
			isDrawingText(
				'<!DOCTYPE svg [ <!ENTITY x "a]>b"> ]><svg xmlns="http://www.w3.org/2000/svg"/>'
			)
		).toBe(false);
		expect(
			isDrawingText(
				'<!DOCTYPE svg [ <!ENTITY x "a]b"> ]><svg xmlns="http://www.w3.org/2000/svg"/>'
			)
		).toBe(true);
	});

	it('reads a prolog of a great many comments without running out of stack', () => {
		const text = `${'<!-- -->'.repeat(100_000)}<svg xmlns="http://www.w3.org/2000/svg"/>`;
		expect(isDrawingText(text)).toBe(true);
		expect(readDrawingProlog(text)).toBe('<!-- -->'.repeat(100_000));
	});

	it('still reads a doctype with an internal subset and space before its close', () => {
		expect(
			readDrawingProlog(
				'<!DOCTYPE svg [ <!ENTITY a "b"> ]  \n >\n<svg xmlns="http://www.w3.org/2000/svg"/>'
			)
		).toBe('<!DOCTYPE svg [ <!ENTITY a "b"> ]  \n >\n');
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

	it('adds the id after the last attribute at once, however much whitespace the tag holds', () => {
		// A pattern for the whitespace before the tag's close took seconds over this.
		const text = `<svg xmlns="${SVG_NAMESPACE}"${' '.repeat(50_000)}a="b" \n/>`;
		const started = performance.now();
		expect(withDrawingId(text, ID)).toBe(
			`${text.slice(0, -4)} xmlns:draw="${DRAWING_NAMESPACE}" draw:id="${ID}"/>`
		);
		expect(performance.now() - started).toBeLessThan(500);
	});

	it('reads a bare value’s slash before the root’s > as the value’s, and writes after it', () => {
		// XML would not have the value bare. HTML reads the slash so, and so did
		// the pattern this had; the rewrites now read it as the reader does.
		const text = `<svg xmlns="${SVG_NAMESPACE}" width=10 height=10/>`;
		expect(readDrawingSize(text)).toBeUndefined();
		expect(withDrawingId(text, ID)).toBe(
			`<svg xmlns="${SVG_NAMESPACE}" width=10 height=10/ xmlns:draw="${DRAWING_NAMESPACE}" draw:id="${ID}">`
		);
		expect(withDrawingTitle(text, 'T')).toBe(`${text}\n  <title>T</title>`);
		const bare = `<svg xmlns="${SVG_NAMESPACE}" xmlns:draw="${DRAWING_NAMESPACE}" draw:id=z/>`;
		expect(readDrawingId(bare)).toBeUndefined();
		expect(withDrawingId(bare, ID)).toBe(bare.replace('draw:id=z/', `draw:id="${ID}"`));
		// Whatever follows: its end tag, or content and none, as a file cut short has.
		const based = `<svg xmlns="${SVG_NAMESPACE}" xml:base=http://a/b/>`;
		expect(withDrawingId(`${based}<g/></svg>`, ID)).toBe(
			`${based.slice(0, -1)} xmlns:draw="${DRAWING_NAMESPACE}" draw:id="${ID}"><g/></svg>`
		);
		expect(readDrawingTitle(`${text}\n<title>Kept</title><g id="layer-1">`)).toBe('Kept');
		// A namespace with the slash in it is not SVG's.
		const slashed = `<svg xmlns=${SVG_NAMESPACE}/>`;
		expect(isDrawingText(slashed)).toBe(false);
		expect(() => withDrawingId(slashed, ID)).toThrow(RangeError);
	});

	it('reads the id under the first prefix bound to the namespace, and writes it there', () => {
		// As it was always read, so the id a file is known by does not change.
		const both = `<svg xmlns="${SVG_NAMESPACE}" xmlns:a="${DRAWING_NAMESPACE}" xmlns:b="${DRAWING_NAMESPACE}"`;
		const two = `${both} a:id="first" b:id="second"/>`;
		expect(readDrawingId(two)).toBe('first');
		expect(withDrawingId(two, ID)).toBe(two.replace('a:id="first"', `a:id="${ID}"`));
		// One under another prefix alone is not read, as it never was, and the
		// new one takes its place: beside it, the root would have two attributes
		// of one expanded name, which an XML parser refuses.
		const other = `${both} b:id="other"/>`;
		expect(readDrawingId(other)).toBeUndefined();
		const given = withDrawingId(other, ID);
		expect(given).toBe(`${both} a:id="${ID}"/>`);
		expect(readDrawingId(given)).toBe(ID);
		expect(withDrawingId(given, ID)).toBe(given);
	});

	it('keeps the bytes of a root that has the id it is given, however it is written', () => {
		// A save of a drawing undone back to what it was is then no change.
		for (const written of [`draw:id = "${ID}"`, `draw:id='${ID}'`, `draw:id\n=\n"${ID}"`]) {
			const text = `<svg xmlns="${SVG_NAMESPACE}" xmlns:draw="${DRAWING_NAMESPACE}" ${written}><g/></svg>`;
			expect(withDrawingId(text, ID)).toBe(text);
		}
	});

	it('gives the id at once however many prefixes bind the namespace', () => {
		// Each attribute was once looked for among every prefix's id.
		const bound = Array.from(
			{ length: 50_000 },
			(_, n) => ` xmlns:p${n}="${DRAWING_NAMESPACE}"`
		).join('');
		const text = `<svg xmlns="${SVG_NAMESPACE}"${bound} p1:id="old"/>`;
		const started = performance.now();
		expect(withDrawingId(text, ID)).toBe(text.replace('p1:id="old"', `p0:id="${ID}"`));
		expect(performance.now() - started).toBeLessThan(500);
	});

	it('declares the namespace for an id the file has without it', () => {
		const text = `<svg xmlns="${SVG_NAMESPACE}" draw:id="old"/>`;
		const given = withDrawingId(text, ID);
		expect(given).toBe(
			`<svg xmlns="${SVG_NAMESPACE}" xmlns:draw="${DRAWING_NAMESPACE}" draw:id="${ID}"/>`
		);
		expect(readDrawingId(given)).toBe(ID);
		expect(withDrawingId(given, ID)).toBe(given);
	});

	it('finds the id among the attributes, not in another attribute’s value', () => {
		const text = `<svg xmlns="${SVG_NAMESPACE}" xmlns:draw="${DRAWING_NAMESPACE}" desc="x draw:id=abc">`;
		const given = withDrawingId(`${text}</svg>`, ID);
		expect(given).toBe(`${text.slice(0, -1)} draw:id="${ID}"></svg>`);
		expect(readDrawingId(given)).toBe(ID);
	});

	it('replaces the id that is read, where the file has two', () => {
		const text = `<svg xmlns="${SVG_NAMESPACE}" xmlns:draw="${DRAWING_NAMESPACE}" draw:id="a1" draw:id = 'b2'/>`;
		expect(readDrawingId(text)).toBe('b2');
		const given = withDrawingId(text, ID);
		expect(given).toBe(text.replace(`draw:id = 'b2'`, `draw:id="${ID}"`));
		expect(readDrawingId(given)).toBe(ID);
	});

	it('chooses a free prefix however many are taken', () => {
		const taken = Array.from(
			{ length: 20_000 },
			(_, i) => ` xmlns:draw${i === 0 ? '' : i + 1}="http://example.com/x"`
		).join('');
		const given = withDrawingId(`<svg xmlns="${SVG_NAMESPACE}"${taken}/>`, ID);
		expect(given).toContain(`xmlns:draw20001="${DRAWING_NAMESPACE}" draw20001:id="${ID}"/>`);
		expect(readDrawingId(given)).toBe(ID);
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

	it('reads a width and height with space around a px, as it always has', () => {
		expect(
			readDrawingSize(`<svg xmlns="${SVG_NAMESPACE}" width=" 1.5e2 px " height="+.5"/>`)
		).toEqual({ width: 150, height: 0.5 });
		expect(
			readDrawingSize(`<svg xmlns="${SVG_NAMESPACE}" width="1 p x" height="1"/>`)
		).toBeUndefined();
	});

	it('answers at once of a width that is a long run of digits or spaces and then not a length', () => {
		// Each could be read many ways by the pattern this had, and each was tried.
		const started = performance.now();
		for (const width of [`1${' '.repeat(50_000)}x`, `${'1'.repeat(50_000)}x`]) {
			expect(
				readDrawingSize(`<svg xmlns="${SVG_NAMESPACE}" width="${width}" height="1"/>`)
			).toBeUndefined();
		}
		expect(performance.now() - started).toBeLessThan(500);
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

	it('ends a comment before it at its first close, as XML does', () => {
		// What follows that close is text, not a comment, so the title is not the
		// root's first child. A pattern once read past it to find one.
		expect(
			readDrawingTitle(`<svg xmlns="${SVG_NAMESPACE}"><!-- a --> b --><title>t</title></svg>`)
		).toBeUndefined();
		expect(
			readDrawingTitle(`<svg xmlns="${SVG_NAMESPACE}"><!-- a -- b --><title>t</title></svg>`)
		).toBe('t');
	});

	it('ends at its end tag, space before its > and all, and not where a malformed one is', () => {
		const root = `<svg xmlns="${SVG_NAMESPACE}">`;
		expect(readDrawingTitle(`${root}<title>a</title\n><g/></svg>`)).toBe('a');
		// An HTML parser ends it at `</title b>`, and XML at neither: it is not
		// read, and a rename puts a new title ahead of it and takes nothing away.
		for (const rest of [
			'<title>a</title b> c</title\n><g/></svg>',
			'<title>a</title/>c</title><g/></svg>',
		]) {
			expect(readDrawingTitle(`${root}${rest}`)).toBeUndefined();
			expect(withDrawingTitle(`${root}${rest}`, 'New')).toBe(
				`${root}\n  <title>New</title>${rest}`
			);
		}
		expect(readDrawingTitle(`${root}<title>a</titles> b</title><g/></svg>`)).toBe(
			'a</titles> b'
		);
	});

	it('reads its start tag as the root’s is, so a quoted > does not end it', () => {
		expect(
			readDrawingTitle(`<svg xmlns="${SVG_NAMESPACE}"><title data-x="a>b">Name</title></svg>`)
		).toBe('Name');
	});

	it('is nothing for a title that closes itself, and reads nothing past it', () => {
		// Its end tag was once looked for past it, and found in a layer's own title.
		for (const tag of ['<title/>', '<title id="t" />', '<title id=t/>']) {
			expect(
				readDrawingTitle(
					`<svg xmlns="${SVG_NAMESPACE}">${tag}<g><title>tip</title></g></svg>`
				)
			).toBeUndefined();
		}
	});

	it('is SVG’s title under whatever prefix binds it, and no other', () => {
		expect(
			readDrawingTitle(
				`<svg:svg xmlns:svg="${SVG_NAMESPACE}"><svg:title>A</svg:title></svg:svg>`
			)
		).toBe('A');
		expect(
			readDrawingTitle(
				`<svg xmlns="${SVG_NAMESPACE}"><s:title xmlns:s="${SVG_NAMESPACE}">B</s:title></svg>`
			)
		).toBe('B');
		expect(
			readDrawingTitle(
				`<svg:svg xmlns:svg="${SVG_NAMESPACE}" xmlns="http://example.com/x"><title>none</title></svg:svg>`
			)
		).toBeUndefined();
		expect(
			readDrawingTitle(
				`<svg xmlns="${SVG_NAMESPACE}"><title xmlns="http://example.com/x">none</title></svg>`
			)
		).toBeUndefined();
	});

	it('is a title in no namespace, as 0.1.0 wrote under an svg:svg root', () => {
		expect(
			readDrawingTitle(`<svg:svg xmlns:svg="${SVG_NAMESPACE}"><title>Old</title></svg:svg>`)
		).toBe('Old');
		expect(
			readDrawingTitle(`<svg xmlns="${SVG_NAMESPACE}"><title xmlns="">Old</title></svg>`)
		).toBe('Old');
	});

	it('answers of a first child with a great many attributes, without running out of stack', () => {
		// Its start tag was once read whole before its name was looked at.
		const text = `<svg xmlns="${SVG_NAMESPACE}"><g${' a'.repeat(4_000_000)}/></svg>`;
		expect(readDrawingTitle(text)).toBeUndefined();
		expect(withDrawingTitle(text, '')).toBe(text);
	});

	it('reads a root and a title with a great many attributes, as it always did', () => {
		// A pattern for the tag ran out of stack over millions; the scanner has
		// none. No count is too many, so a file read before is read still, and
		// keeps the id it is known by.
		const many = ' a'.repeat(200_000);
		const text = `<svg xmlns="${SVG_NAMESPACE}" xmlns:draw="${DRAWING_NAMESPACE}"${many} draw:id="${ID}"><title${many}>Name</title></svg>`;
		expect(readDrawingId(text)).toBe(ID);
		expect(readDrawingTitle(text)).toBe('Name');
	});

	it('answers at once of what leads to no title, however long', () => {
		// Whitespace and comments before a title could each be read many ways by
		// the pattern this had, and each was tried: seconds for these.
		const root = `<svg xmlns="${SVG_NAMESPACE}">`;
		const started = performance.now();
		for (const rest of [
			`${' '.repeat(50_000)}x`,
			`<!--${'--><!--'.repeat(50_000)}x`,
			`<title>${'</title '.repeat(50_000)}`,
			`<title${' a=b'.repeat(50_000)}`,
			`${'<?x?>'.repeat(50_000)}<?`,
			`<title>${'<!--x-->'.repeat(50_000)}`,
		]) {
			expect(readDrawingTitle(`${root}${rest}`)).toBeUndefined();
		}
		expect(performance.now() - started).toBeLessThan(500);
	});
});

describe('withDrawingViewport', () => {
	const BOX = { x: 10, y: 20, width: 300, height: 200 };
	const SIZE = { width: 600, height: 400 };

	it('sets the root’s viewBox, width and height in place of its own, and keeps the rest', () => {
		const text = emptyDrawing({ id: ID });
		const sized = withDrawingViewport(text, BOX, SIZE);
		expect(sized).toBe(
			text.replace(
				' viewBox="0 0 1600 1000" width="1600" height="1000">',
				' viewBox="10 20 300 200" width="600" height="400">'
			)
		);
		expect(readDrawingId(sized ?? '')).toBe(ID);
	});

	it('keeps the prolog, the prefix and a root that closes itself', () => {
		const root = `<svg:svg xmlns:svg="${SVG_NAMESPACE}" width=5 a="b"/>`;
		expect(withDrawingViewport(`${WITH_SUBSET.split('<svg')[0]}${root}`, BOX, SIZE)).toBe(
			`${WITH_SUBSET.split('<svg')[0]}<svg:svg xmlns:svg="${SVG_NAMESPACE}" a="b" viewBox="10 20 300 200" width="600" height="400"/>`
		);
	});

	it('is nothing for text with no SVG root to read, and reads a root of many attributes', () => {
		expect(withDrawingViewport('<html/>', BOX, SIZE)).toBeUndefined();
		expect(withDrawingViewport('<svg width="5"><rect/></svg>', BOX, SIZE)).toBeUndefined();
		const many = `<svg xmlns="${SVG_NAMESPACE}"${' a="b"'.repeat(50_000)}><g/></svg>`;
		expect(
			withDrawingViewport(many, BOX, SIZE)?.endsWith(' width="600" height="400"><g/></svg>')
		).toBe(true);
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
			`<svg:svg xmlns:svg="${SVG_NAMESPACE}"><svg:title>Dot</svg:title></svg:svg>`
		);
		expect(withDrawingTitle(`<svg xmlns="${SVG_NAMESPACE}"/>`, ' ')).toBe(
			`<svg xmlns="${SVG_NAMESPACE}"/>`
		);
	});

	it('opens a self-closing root with a long run of whitespace in it at once', () => {
		// A pattern for the whitespace before its close took seconds over this.
		const text = `<svg xmlns="${SVG_NAMESPACE}"${' '.repeat(50_000)}a="b"  />`;
		const started = performance.now();
		expect(withDrawingTitle(text, 'T')).toBe(`${text.slice(0, -4)}><title>T</title></svg>`);
		expect(performance.now() - started).toBeLessThan(500);
	});

	it('fills a title that closes itself, and keeps what follows it', () => {
		const layer = '<g id="layer-1"><path d="M0 0"><title>tip</title></path></g>';
		const text = `<svg xmlns="${SVG_NAMESPACE}"><title id="t" />${layer}</svg>`;
		expect(withDrawingTitle(text, 'New')).toBe(
			`<svg xmlns="${SVG_NAMESPACE}"><title id="t">New</title>${layer}</svg>`
		);
		expect(withDrawingTitle(text, '')).toBe(`<svg xmlns="${SVG_NAMESPACE}">${layer}</svg>`);
	});

	it('takes nothing away around a title whose bare value runs into its />', () => {
		// It may close itself, or its value end in a slash: so it is not the title,
		// and a new one goes ahead of it.
		const root = `<svg xmlns="${SVG_NAMESPACE}">`;
		const layer = '<g id="layer-1"><path d="M0 0"><title>tip</title></path></g>';
		for (const rest of [
			`<title id=t/>${layer}</svg>`,
			`<title class=a/b/>Name</title>${layer}</svg>`,
		]) {
			expect(readDrawingTitle(`${root}${rest}`)).toBeUndefined();
			expect(withDrawingTitle(`${root}${rest}`, 'New')).toBe(
				`${root}\n  <title>New</title>${rest}`
			);
			expect(withDrawingTitle(`${root}${rest}`, '')).toBe(`${root}${rest}`);
		}
	});

	it('keeps a bare value’s slash its own where a rename opens or rebuilds a tag', () => {
		// Written straight before the `>`, the slash would make a tag that might
		// close itself, and the title would not be read back.
		const svg = `<svg xmlns="${SVG_NAMESPACE}">`;
		const prefixed = `<svg:svg xmlns:svg="${SVG_NAMESPACE}">`;
		for (const [text, renamed] of [
			[
				`${svg}<title a=b/ /><g id="layer-1"/></svg>`,
				`${svg}<title a=b/ >New</title><g id="layer-1"/></svg>`,
			],
			[
				`${prefixed}<title xmlns="" a=b/ >Old</title><svg:g/></svg:svg>`,
				`${prefixed}<title xmlns="${SVG_NAMESPACE}" a=b/ >New</title><svg:g/></svg:svg>`,
			],
			[
				`<svg xmlns="${SVG_NAMESPACE}" a=b/ />`,
				`<svg xmlns="${SVG_NAMESPACE}" a=b/ ><title>New</title></svg>`,
			],
		] as const) {
			expect(withDrawingTitle(text, 'New')).toBe(renamed);
			expect(readDrawingTitle(renamed)).toBe('New');
			expect(withDrawingTitle(renamed, 'New')).toBe(renamed);
		}
	});

	it('keeps the title’s own start tag, so what names it by its id still does', () => {
		const root = `<svg xmlns="${SVG_NAMESPACE}" aria-labelledby="ttl">`;
		expect(
			withDrawingTitle(`${root}<title id="ttl" xml:lang="en" >Logo</title></svg>`, 'New')
		).toBe(`${root}<title id="ttl" xml:lang="en" >New</title></svg>`);
	});

	it('names a title in no namespace as SVG’s, where it was, and keeps its attributes', () => {
		// As 0.1.0 wrote one. SVG's namespace is made its default, in place of its
		// own `xmlns`, so no prefix, and no attribute's meaning, changes.
		const root = `<svg:svg xmlns:svg="${SVG_NAMESPACE}" aria-labelledby="t">`;
		const svg = `xmlns="${SVG_NAMESPACE}"`;
		for (const [open, renamed] of [
			['<title>', `<title ${svg}>`],
			['<title id="t" xmlns="">', `<title ${svg} id="t">`],
			[
				'<title xmlns:svg="http://x"  id=\'t\'>',
				`<title ${svg} xmlns:svg="http://x" id='t'>`,
			],
			['<title xmlns:svg="urn:x" svg:a="1">', `<title ${svg} xmlns:svg="urn:x" svg:a="1">`],
		] as const) {
			const text = `${root}\n  ${open}Old</title><svg:g/></svg:svg>`;
			expect(readDrawingTitle(text)).toBe('Old');
			const titled = withDrawingTitle(text, 'New');
			expect(titled).toBe(`${root}\n  ${renamed}New</title><svg:g/></svg:svg>`);
			expect(readDrawingTitle(titled)).toBe('New');
			expect(withDrawingTitle(text, '')).toBe(`${root}<svg:g/></svg:svg>`);
		}
		const plain = `<svg xmlns="${SVG_NAMESPACE}">`;
		expect(withDrawingTitle(`${plain}<title xmlns="" id="t">Old</title></svg>`, 'New')).toBe(
			`${plain}<title id="t">New</title></svg>`
		);
	});

	it('reads no title whose first end tag something in it holds: a comment, CDATA, an instruction, a tag, a title', () => {
		// XML ends it at a later one, and a tool that knows none of them at that
		// one: it is not read, and a rename puts a new title ahead of it.
		const root = `<svg xmlns="${SVG_NAMESPACE}">`;
		const layer = '<g id="layer-1"><!-- c --><path d="M0 0"><title>tip</title></path></g>';
		for (const rest of [
			`<title>A<!-- </title> -->B</title>${layer}</svg>`,
			`<title>A<![CDATA[</title>]]>B</title>${layer}</svg>`,
			`<title>A<?pi </title> ?>B</title>${layer}</svg>`,
			`<title>x <!-- y</title>${layer}</svg>`,
			`<title>x <![CDATA[ y</title>${layer}<style><![CDATA[a{}]]></style></svg>`,
			`<title>A<!-- </title> x</svg>`,
			`<title>Doc <title xmlns="http://www.w3.org/1999/xhtml">x</title> end</title>${layer}</svg>`,
			`<title>A<a title="see </title>"/>B</title>${layer}</svg>`,
			`<title>a<b</title>${layer}</svg>`,
		]) {
			expect(readDrawingTitle(`${root}${rest}`)).toBeUndefined();
			expect(withDrawingTitle(`${root}${rest}`, 'New')).toBe(
				`${root}\n  <title>New</title>${rest}`
			);
			expect(withDrawingTitle(`${root}${rest}`, '')).toBe(`${root}${rest}`);
		}
		// One that closes before the end tag is read as part of the text, as it
		// always was, and so is an element of the title's name that closes itself.
		for (const inner of [
			'A<!-- c -->B',
			'A<?pi x?>B',
			'A<title/>B',
			'A<title id="x" />B',
			'A<title a=">" b/>B',
			'A<b class="x">bold</b>B',
			'x < y',
			'1<2 or a<-b',
		]) {
			const text = `${root}<title>${inner}</title><g/></svg>`;
			expect(readDrawingTitle(text)).toBe(inner);
			expect(withDrawingTitle(text, 'New')).toBe(`${root}<title>New</title><g/></svg>`);
		}
	});

	it('reads and writes a title after a processing instruction, as XML puts one there', () => {
		const root = `<svg xmlns="${SVG_NAMESPACE}">\n<?xml-stylesheet href="a.css"?>\n`;
		const text = `${root}<title>Plan</title><g/></svg>`;
		expect(readDrawingTitle(text)).toBe('Plan');
		expect(withDrawingTitle(text, 'New')).toBe(`${root}<title>New</title><g/></svg>`);
		expect(withDrawingTitle(text, '')).toBe(`${root.trimEnd()}<g/></svg>`);
	});

	it('writes no character XML has no place for', () => {
		const text = emptyDrawing({ id: ID });
		expect(withDrawingTitle(text, 'a\u0001b\ud800c\uffff')).toBe(
			emptyDrawing({ id: ID, title: 'abc' })
		);
		expect(withDrawingTitle(emptyDrawing({ id: ID, title: 'x' }), '\u0002 ')).toBe(text);
		expect(emptyDrawing({ id: ID, title: '\u0000' })).toBe(text);
		// A tab, a line break, and a character beyond the BMP are XML's.
		expect(readDrawingTitle(withDrawingTitle(text, 'a\tb\nc 🎉'))).toBe('a\tb\nc 🎉');
		// Nor is one read where a reference spells it, so a title read is one written.
		const root = `<svg xmlns="${SVG_NAMESPACE}">`;
		expect(readDrawingTitle(`${root}<title>Plan&#1;&#xD800;</title></svg>`)).toBe('Plan');
		expect(readDrawingTitle(`${root}<title>&#x7;</title></svg>`)).toBeUndefined();
	});

	it('names SVG’s title under a prefix `title` where SVG is the root’s default, as the editor keeps it', () => {
		// The editor's sanitizer takes elements under a prefix away, so a title
		// kept as `s:title` would go with the first edit.
		const root = `<svg xmlns="${SVG_NAMESPACE}" xmlns:s="${SVG_NAMESPACE}">`;
		for (const [open, renamed] of [
			['<s:title id="t">', '<title id="t">'],
			[
				`<s:title xmlns:s="${SVG_NAMESPACE}" xmlns="urn:x">`,
				`<title xmlns:s="${SVG_NAMESPACE}">`,
			],
		] as const) {
			const text = `${root}${open}B</s:title><g/></svg>`;
			expect(readDrawingTitle(text)).toBe('B');
			const titled = withDrawingTitle(text, 'New');
			expect(titled).toBe(`${root}${renamed}New</title><g/></svg>`);
			expect(readDrawingTitle(titled)).toBe('New');
		}
	});

	it('writes SVG’s title under the root’s prefix where SVG is not the default namespace', () => {
		const root = `<svg:svg xmlns:svg="${SVG_NAMESPACE}">`;
		expect(withDrawingTitle(`${root}<svg:title>A</svg:title></svg:svg>`, 'B')).toBe(
			`${root}<svg:title>B</svg:title></svg:svg>`
		);
		expect(withDrawingTitle(`${root}</svg:svg>`, 'B')).toBe(
			`${root}\n  <svg:title>B</svg:title></svg:svg>`
		);
		const both = `<svg:svg xmlns:svg="${SVG_NAMESPACE}" xmlns="${SVG_NAMESPACE}">`;
		expect(withDrawingTitle(`${both}</svg:svg>`, 'B')).toBe(
			`${both}\n  <title>B</title></svg:svg>`
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

	it('takes a title away at once after a long run of whitespace, and the run with it', () => {
		// The run before a comment stays. A pattern trimming the lead took
		// seconds over that one, looking for whitespace that ends the lead.
		const root = `<svg xmlns="${SVG_NAMESPACE}">`;
		const run = ' '.repeat(50_000);
		const started = performance.now();
		expect(withDrawingTitle(`${root}<!-- c -->${run}<title>t</title></svg>`, '')).toBe(
			`${root}<!-- c --></svg>`
		);
		expect(withDrawingTitle(`${root}${run}<!-- c --><title>t</title></svg>`, '')).toBe(
			`${root}${run}<!-- c --></svg>`
		);
		expect(performance.now() - started).toBeLessThan(500);
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
