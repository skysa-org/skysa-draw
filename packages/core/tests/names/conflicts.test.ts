import { describe, expect, it } from 'vitest';

import {
	conflictFilename,
	conflictFilePath,
	conflictFolderName,
	conflictFolderPath,
	conflictNameKeepingExtension,
	conflictPath,
	conflictStamp,
} from '../../src/names/conflicts.js';
import { drawingFilename } from '../../src/names/slug.js';

/**
 * The names of a conflict copy. Every rule here exists because getting it
 * wrong loses the copy — a name a provider refuses, or a name that collides
 * with the copy made a second ago.
 */

const AT = new Date('2026-09-15T14:32:10.500Z');

describe('conflictStamp', () => {
	it('is the minute, in a form a filename can hold', () => {
		expect(conflictStamp(AT)).toBe('2026-09-15T14-32');
	});

	it('has no colon in it', () => {
		// Illegal on Windows and rejected outright by several provider APIs, and
		// a copy the provider will not store is a lost edit.
		expect(conflictStamp(AT)).not.toContain(':');
	});

	it('is the same in every time zone', () => {
		// Two devices conflicting on one drawing should produce one name, not two
		// that look hours apart and unrelated.
		expect(conflictStamp(new Date('2026-09-15T14:32:10Z'))).toBe(
			conflictStamp(new Date('2026-09-15T16:32:10+02:00'))
		);
	});
});

describe('conflictFilename', () => {
	it('keeps the name it came from', () => {
		expect(conflictFilename('meeting-drawings.svg', AT)).toBe(
			'meeting-drawings (conflict 2026-09-15T14-32).svg'
		);
	});

	it('does not slug the name', () => {
		// The copy has to be recognizable as the drawing it came from, and sort
		// next to it. A slug would lowercase it and strip the parentheses that
		// say what it is.
		expect(conflictFilename('Q3 Review.svg', AT)).toBe(
			'Q3 Review (conflict 2026-09-15T14-32).svg'
		);
	});

	it('steps aside for a copy that is already there', () => {
		// Minute resolution is not unique enough on its own, and the second copy
		// overwriting the first would lose exactly what it was made to save.
		const taken = ['a (conflict 2026-09-15T14-32).svg'];
		expect(conflictFilename('a.svg', AT, taken)).toBe('a (conflict 2026-09-15T14-32)-2.svg');
	});

	it('keeps stepping aside', () => {
		const taken = ['a (conflict 2026-09-15T14-32).svg', 'a (conflict 2026-09-15T14-32)-2.svg'];
		expect(conflictFilename('a.svg', AT, taken)).toBe('a (conflict 2026-09-15T14-32)-3.svg');
	});

	it('treats a name that differs only in normal form as taken', () => {
		// NFD is what a macOS file and an iOS share sheet hand over, and it is one
		// name with its NFC spelling on every provider. Missed, this copy lands on
		// the existing one and overwrites it — and the copy is the only place the
		// edit that lost the conflict exists.
		const taken = ['caf\u00e9 (conflict 2026-09-15T14-32).svg'.normalize('NFD')];

		expect(conflictFilename('caf\u00e9.svg', AT, taken)).toBe(
			'caf\u00e9 (conflict 2026-09-15T14-32)-2.svg'
		);
	});

	it('treats a name that differs only in case as taken', () => {
		// Drive, Dropbox and macOS all do, so a name that looks free here is not
		// free where it matters.
		const taken = ['A (CONFLICT 2026-09-15T14-32).svg'];
		expect(conflictFilename('a.svg', AT, taken)).toBe('a (conflict 2026-09-15T14-32)-2.svg');
	});

	it('copes with a name that has no extension', () => {
		expect(conflictFilename('drawings', AT)).toBe('drawings (conflict 2026-09-15T14-32).svg');
	});

	it('does not leave a shouted extension on the stem and take a second one', () => {
		// `Report.SVG` comes from a Windows tool, and it is a SVG file: the
		// name has one extension, not a stem ending in `.SVG` waiting for one.
		expect(conflictFilename('Report.SVG', AT)).toBe('Report (conflict 2026-09-15T14-32).svg');
	});
});

describe('a conflict name that would not fit in a filename', () => {
	const bytes = (name: string): number => new TextEncoder().encode(name).length;
	const SUFFIX = ' (conflict 2026-09-15T14-32)';

	const expectStorable = (name: string): void => {
		expect(bytes(name)).toBeLessThanOrEqual(255);
		expect(() => encodeURIComponent(name)).not.toThrow();
	};

	it('leaves a name with room for the suffix exactly as it was', () => {
		const slug = drawingFilename('\u6f22'.repeat(200));
		expect(bytes(slug)).toBe(217);
		const copy = conflictFilename(slug, AT);
		expect(copy).toBe(`${slug.slice(0, -4)}${SUFFIX}.svg`);
		expect(bytes(copy)).toBe(245);
	});

	it('cuts the stem of a copy of a copy, from its end, and keeps both suffixes whole', () => {
		const copy = conflictFilename(drawingFilename('\u6f22'.repeat(200)), AT);
		const later = new Date('2026-09-16T09:05:00Z');
		const again = conflictFilename(copy, later);
		expectStorable(again);
		expect(again.startsWith('\u6f22'.repeat(60))).toBe(true);
		expect(again.endsWith(' (conflict 2026-09-16T09-05).svg')).toBe(true);
		// 275 bytes uncut. What went is the end of the stem, which here is the
		// first suffix: nothing is stripped on purpose, and nothing is spared.
		expect(bytes(again)).toBeGreaterThan(255 - 4);
	});

	it('cuts a long name from another tool', () => {
		const theirs = `${'n'.repeat(237)}.svg`;
		expect(bytes(theirs)).toBe(241);
		const copy = conflictFilename(theirs, AT);
		expectStorable(copy);
		expect(copy).toBe(`${'n'.repeat(255 - 28 - 4)}${SUFFIX}.svg`);
	});

	it('does not cut a character in half to do it', () => {
		// Four bytes each, and a joined family of five code points at the cut.
		const family = '\u{1f468}\u200d\u{1f469}\u200d\u{1f467}';
		[`${'\u{1f389}'.repeat(70)}.svg`, `${'a'.repeat(215)}${family}.svg`].forEach((name) => {
			const copy = conflictFilename(name, AT);
			expectStorable(copy);
			expect(copy.endsWith(`${SUFFIX}.svg`)).toBe(true);
		});
		expect(conflictFilename(`${'a'.repeat(215)}${family}.svg`, AT)).toBe(
			`${'a'.repeat(215)}${SUFFIX}.svg`
		);
	});

	it('asks whether the name is taken of the name as cut', () => {
		// Two names that differ only past the cut are one name once cut.
		const first = conflictFilename(`${'n'.repeat(236)}A.svg`, AT);
		const second = conflictFilename(`${'n'.repeat(236)}B.svg`, AT, [first]);
		expectStorable(second);
		expect(second).not.toBe(first);
		expect(second.endsWith(`${SUFFIX}-2.svg`)).toBe(true);
		// And the counter is paid for out of the stem, not added on top.
		expect(bytes(second)).toBe(255);
	});

	it('fits a folder name the same way', () => {
		const folder = '\u6f22'.repeat(84);
		const copy = conflictFolderName(folder, AT);
		expectStorable(copy);
		expect(copy.endsWith(SUFFIX)).toBe(true);

		const second = conflictFolderName(folder, AT, [copy]);
		expectStorable(second);
		expect(second.endsWith(`${SUFFIX}-2`)).toBe(true);
	});
});

describe('conflictFolderName', () => {
	// A folder carries no extension, and the only engine caller computes its
	// expectation by calling this same function — so nothing anywhere says what
	// the name should look like.
	it('names a folder the way a drawing is named, without an extension', () => {
		expect(conflictFolderName('Archive', AT)).toBe('Archive (conflict 2026-09-15T14-32)');
	});

	it('steps aside for a folder name already taken', () => {
		expect(conflictFolderName('Archive', AT, ['Archive (conflict 2026-09-15T14-32)'])).toBe(
			'Archive (conflict 2026-09-15T14-32)-2'
		);
	});

	it('treats a taken name that differs only in case as taken', () => {
		expect(conflictFolderName('Archive', AT, ['archive (CONFLICT 2026-09-15T14-32)'])).toBe(
			'Archive (conflict 2026-09-15T14-32)-2'
		);
	});

	it('keeps a folder whose name ends in .svg intact', () => {
		// `conflictFilename` strips the extension; this must not, or a folder
		// someone called `drawings.svg` comes back as `drawings`.
		expect(conflictFolderName('drawings.svg', AT)).toBe(
			'drawings.svg (conflict 2026-09-15T14-32)'
		);
	});
});

describe('conflictFilePath', () => {
	it('names a file beside itself, in its own folder, keeping its extension', () => {
		expect(conflictFilePath('Trips/2026/photo-3f9a1c2b.png', AT)).toBe(
			'Trips/2026/photo-3f9a1c2b (conflict 2026-09-15T14-32).png'
		);
		expect(
			conflictFilePath('Trips/photo.png', AT, ['photo (conflict 2026-09-15T14-32).png'])
		).toBe('Trips/photo (conflict 2026-09-15T14-32)-2.png');
	});
});

describe('conflictNameKeepingExtension', () => {
	// For a file that is not a drawing — a picture beside one, say. Given `.svg` it
	// would stop being a picture and start being a drawing the engine tries to read.
	it('puts the stamp before the file’s own extension', () => {
		expect(conflictNameKeepingExtension('photo-3f9a1c2b.png', AT)).toBe(
			'photo-3f9a1c2b (conflict 2026-09-15T14-32).png'
		);
		expect(conflictNameKeepingExtension('Q3 Report.PDF', AT)).toBe(
			'Q3 Report (conflict 2026-09-15T14-32).PDF'
		);
	});

	it('never gives a file that is not a drawing the extension of one', () => {
		['photo.png', 'README', 'archive.tar.gz', '.env', 'minutes.2026-01-01 board'].forEach(
			(name) => {
				expect(conflictNameKeepingExtension(name, AT).toLowerCase()).not.toMatch(/\.svg$/);
			}
		);
	});

	it('takes only the last extension, and none from a dot in the stem', () => {
		expect(conflictNameKeepingExtension('archive.tar.gz', AT)).toBe(
			'archive.tar (conflict 2026-09-15T14-32).gz'
		);
		// Too long, and spaced, to be an extension: the whole name is the stem.
		expect(conflictNameKeepingExtension('minutes.2026-01-01 with the board', AT)).toBe(
			'minutes.2026-01-01 with the board (conflict 2026-09-15T14-32)'
		);
	});

	it('stamps the end of a name with no extension, or one that is only a dot and a name', () => {
		expect(conflictNameKeepingExtension('README', AT)).toBe(
			'README (conflict 2026-09-15T14-32)'
		);
		expect(conflictNameKeepingExtension('.env', AT)).toBe('.env (conflict 2026-09-15T14-32)');
	});

	it('numbers a second copy before the extension, folding case as every name does', () => {
		expect(
			conflictNameKeepingExtension('photo.png', AT, ['PHOTO (conflict 2026-09-15T14-32).PNG'])
		).toBe('photo (conflict 2026-09-15T14-32)-2.png');
	});

	it('fits a long name by cutting the stem, never the extension', () => {
		const copy = conflictNameKeepingExtension(`${'漢'.repeat(80)}.jpeg`, AT);
		expect(new TextEncoder().encode(copy).length).toBeLessThanOrEqual(255);
		expect(copy.endsWith(' (conflict 2026-09-15T14-32).jpeg')).toBe(true);
	});
});

describe('conflictFolderPath', () => {
	it('renames the folder in place, leaving its parents alone', () => {
		expect(conflictFolderPath('Work/Archive', AT)).toBe(
			'Work/Archive (conflict 2026-09-15T14-32)'
		);
	});
});

describe('conflictPath', () => {
	it('puts the copy in the same folder as the drawing', () => {
		expect(conflictPath('Work/Meetings/a.svg', AT)).toBe(
			'Work/Meetings/a (conflict 2026-09-15T14-32).svg'
		);
	});

	it('handles a drawing at the root', () => {
		expect(conflictPath('a.svg', AT)).toBe('a (conflict 2026-09-15T14-32).svg');
	});
});
