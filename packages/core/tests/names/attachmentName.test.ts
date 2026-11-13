import { bytesHash, conflictNameKeepingExtension, utf8Length } from '@skysa/storage';
import { describe, expect, it } from 'vitest';

import { attachmentName } from '../../src/names/slug.js';

/**
 * The name a file beside a drawing is stored under (docs/ARCHITECTURE.md §10,
 * "Attachments beside a drawing"), as skysa-notes names one beside a note:
 * these are its tests, with a drawing where a note was.
 */

const HASH = '3f9a1c2b7d4e5f60718293a4b5c6d7e8f90a1b2c3d4e5f60718293a4b5c6d7e8';

describe('attachmentName', () => {
	it('is the slug of the name, the hash, and the extension', () => {
		expect(attachmentName({ name: 'Q3 Report.PDF', hash: HASH })).toBe(
			'q3-report-3f9a1c2b.pdf'
		);
	});

	it('calls a picture from the clipboard what it is', () => {
		expect(attachmentName({ name: 'image.png', hash: HASH, pasted: true })).toBe(
			'pasted-image-3f9a1c2b.png'
		);
	});

	it('takes the extension from the type where the name has none', () => {
		expect(attachmentName({ name: 'image', hash: HASH, type: 'image/jpeg' })).toBe(
			'image-3f9a1c2b.jpg'
		);
		expect(attachmentName({ name: '', hash: HASH, type: 'image/png; q=1' })).toBe(
			'attachment-3f9a1c2b.png'
		);
		expect(attachmentName({ name: 'blob', hash: HASH, type: 'application/x-what' })).toBe(
			'blob-3f9a1c2b.bin'
		);
	});

	it('takes the type over an extension that is not letters and digits', () => {
		expect(attachmentName({ name: 'scan.p$f', hash: HASH, type: 'application/pdf' })).toBe(
			'scan-3f9a1c2b.pdf'
		);
	});

	it('keeps a name in any script, and never starts with a dot', () => {
		expect(attachmentName({ name: '写真 2026.JPG', hash: HASH })).toBe(
			'写真-2026-3f9a1c2b.jpg'
		);
		expect(attachmentName({ name: '.env', hash: HASH, type: 'text/plain' })).toBe(
			'env-3f9a1c2b.txt'
		);
	});

	it('keeps the name of a pasted file that is not a picture', () => {
		expect(attachmentName({ name: 'Q3 report.pdf', hash: HASH, pasted: true })).toBe(
			'q3-report-3f9a1c2b.pdf'
		);
		expect(attachmentName({ name: 'image.JPEG', hash: HASH, pasted: true })).toBe(
			'pasted-image-3f9a1c2b.jpeg'
		);
	});

	it.each([
		[{ hash: 'ABC/../x' }],
		[{ hash: '3f9a1c2' }],
		[{ hash: HASH, hashLength: 7 }],
		[{ hash: HASH, hashLength: 17 }],
		[{ hash: HASH, hashLength: 64 }],
		[{ hash: HASH, hashLength: 8.5 }],
		[{ hash: '3f9a1c2b', hashLength: 16 }],
	])('refuses a hash that is not 8 to 16 hex: %o', (input) => {
		expect(() => attachmentName({ name: 'a.png', ...input })).toThrow(RangeError);
	});

	it('uses a longer hash when asked to, in lowercase', () => {
		expect(attachmentName({ name: 'a.png', hash: HASH.toUpperCase(), hashLength: 16 })).toBe(
			'a-3f9a1c2b7d4e5f60.png'
		);
	});

	it('refuses a drawing, however it is spelled', () => {
		expect(attachmentName({ name: 'logo.svg', hash: HASH })).toBeUndefined();
		expect(attachmentName({ name: 'LOGO.SVG', hash: HASH })).toBeUndefined();
		expect(attachmentName({ name: 'logo', hash: HASH, type: 'image/svg+xml' })).toBeUndefined();
	});

	it('leaves room for a conflict suffix inside the 255 bytes a name may have', () => {
		const name = attachmentName({
			name: `${'写'.repeat(200)}.abcdefghijklmnop`,
			hash: HASH,
			hashLength: 16,
		})!;
		const copy = conflictNameKeepingExtension(name, new Date(0), [name]);
		expect(copy).toMatch(
			/^写+-3f9a1c2b7d4e5f60 \(conflict 1970-01-01T00-00\)\.abcdefghijklmnop$/u
		);
		expect(
			utf8Length(`${copy.replace(/\.[^.]+$/u, '')}-999.abcdefghijklmnop`)
		).toBeLessThanOrEqual(255);
	});

	it('does not end a slug cut short on its hyphen', () => {
		// Two characters of three bytes and a hyphen, 27 times, are the stem's
		// 189 bytes exactly, so the cut falls just after a hyphen. Within the
		// slug's own 120 code points, which an ASCII name meets first.
		const name = attachmentName({ name: `${'写写 '.repeat(40)}.txt`, hash: HASH })!;
		expect(name).toBe(`${'写写-'.repeat(27).slice(0, -1)}-3f9a1c2b.txt`);
	});

	it('is the same name for the same bytes', async () => {
		const bytes = new TextEncoder().encode('the same picture');
		const once = attachmentName({ name: 'a.png', hash: await bytesHash(bytes) });
		const again = attachmentName({ name: 'a.png', hash: await bytesHash(bytes.slice()) });
		expect(once).toBe(again);
	});

	describe('kept as the user gave it', () => {
		it('keeps its spaces and capitals, and loses what a provider or a disk would refuse', () => {
			expect(
				attachmentName({ name: 'Q3  Report: final?\u0007.pdf', hash: HASH, kept: true })
			).toBe('Q3 Report final-3f9a1c2b.pdf');
		});

		it('composes what arrived decomposed, and drops a lone surrogate', () => {
			expect(attachmentName({ name: 'Café \ud800menu.txt', hash: HASH, kept: true })).toBe(
				'Café menu-3f9a1c2b.txt'
			);
		});

		it('does not end a name cut short on a space', () => {
			const name = attachmentName({
				name: `${'abcdefgh '.repeat(30)}.txt`,
				hash: HASH,
				kept: true,
			})!;
			expect(name).toBe(`${'abcdefgh '.repeat(21).trimEnd()}-3f9a1c2b.txt`);
		});

		it('is an attachment where nothing of the name is left', () => {
			expect(attachmentName({ name: '???.pdf', hash: HASH, kept: true })).toBe(
				'attachment-3f9a1c2b.pdf'
			);
		});
	});
});
