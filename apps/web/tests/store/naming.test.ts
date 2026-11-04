import { describe, expect, it } from 'vitest';

import { freeName, freePath, namesIn, pathDepth, respell } from '../../src/store/naming.js';

/**
 * The comparison, on its own.
 *
 * Every question here is "are these two names the same file?", and the answer
 * has to be the provider's answer rather than JavaScript's. Reached through
 * `moveFolder` and `moveDrawing` these look like naming tests; asked directly they
 * are what they are, which is why the first two cases below went unnoticed
 * while the suite was green.
 */

describe('freeName', () => {
	it('keeps a name nothing is in the way of', () => {
		expect(freeName('My Report.svg', ['other.svg'])).toBe('My Report.svg');
	});

	it('gives way to a name that differs only in case', () => {
		expect(freeName('report.svg', ['Report.svg'])).toBe('report-2.svg');
	});

	it('gives way to a name that differs only in Unicode normalization', () => {
		// `café.svg` with the accent as its own codepoint, against the same name
		// with it baked into the `é`. One file on Dropbox, on Drive and on macOS.
		// Written with escapes: the two are indistinguishable in an editor, and
		// any tool that normalizes this file would quietly delete the test.
		const composed = 'caf\u00e9.svg';
		const decomposed = 'cafe\u0301.svg';
		expect(composed).not.toBe(decomposed);
		const answer = freeName(decomposed, [composed]);
		expect(answer.normalize('NFC')).not.toBe(composed.normalize('NFC'));
	});

	it('gives way whichever side the composed form is on', () => {
		// The direction that was wrong. `slugify` always emits NFC, so a name
		// arriving as NFD was recognized when the candidate was NFD too and
		// missed when the candidate was the NFC a slug always produces — and
		// missed, the function handed back the very name it was avoiding.
		const composed = 'caf\u00e9.svg';
		const decomposed = 'cafe\u0301.svg';
		// Asserted as the property rather than as a literal: what matters is that
		// the answer is not the taken name, however `slugify` chooses to spell it.
		const answer = freeName(composed, [decomposed]);
		expect(answer).not.toBe(composed);
		expect(answer.normalize('NFC')).not.toBe(decomposed.normalize('NFC'));
	});

	it('does not take a capitalized extension for part of the name', () => {
		// `.SVG` is ordinary from Windows tools. Matched exactly, the extension
		// stays in the stem and is slugified into the name itself.
		expect(freeName('Report.SVG', ['report.SVG'])).toBe('report-2.svg');
	});
});

describe('freePath', () => {
	it('keeps a path nothing is in the way of', () => {
		expect(freePath('archive/report.svg', ['archive/other.svg'])).toBe('archive/report.svg');
	});

	it('gives way inside its own folder', () => {
		expect(freePath('archive/report.svg', ['archive/report.svg'])).toBe('archive/report-2.svg');
	});

	/**
	 * The one that matters. The check that finds the collision folds case; the
	 * one that gathered the names to avoid did not. So the occupying drawing was
	 * dropped from the list, nothing was left to avoid, and this returned the
	 * very path it had just proved was taken — failing open at the moment it
	 * found the problem.
	 */
	it('gives way when the folder it is landing in is spelled differently', () => {
		expect(freePath('archive/report.svg', ['Archive/report.svg'])).toBe('archive/report-2.svg');
	});

	it('counts only the names in the folder it is landing in', () => {
		expect(
			freePath('archive/report.svg', ['archive/report.svg', 'elsewhere/report-2.svg'])
		).toBe('archive/report-2.svg');
	});

	it('is not fooled by a path that was never normalized', () => {
		// Rows hold whatever path they were imported with, not one this app composed.
		expect(freePath('archive/report.svg', ['archive//report.svg'])).toBe(
			'archive/report-2.svg'
		);
	});
});

describe('respell', () => {
	it("takes a source's spelling of each folder along a path, and the first one seen where it has none", () => {
		const spellings = new Map([['work', 'Work']]);

		expect(respell(spellings, 'work/Plans')).toBe('Work/Plans');
		// The first spelling through a folder the source did not have is kept.
		expect(respell(spellings, 'WORK/plans/2026')).toBe('Work/Plans/2026');
		expect(respell(spellings, '')).toBe('');
	});
});

describe('namesIn', () => {
	it('lists what a folder holds directly, the folder compared folded', () => {
		expect(namesIn(['Work/a.svg', 'work/b.svg', 'Work/sub/c.svg', 'd.svg'], 'WORK')).toEqual([
			'a.svg',
			'b.svg',
		]);
		expect(namesIn(['Work/a.svg', 'd.svg'], '')).toEqual(['d.svg']);
	});
});

describe('pathDepth', () => {
	it.each([
		['', 0],
		['a.svg', 1],
		['Work/a.svg', 2],
		['Work/sub/c.svg', 3],
	])('%j is %i deep', (path, depth) => {
		expect(pathDepth(path)).toBe(depth);
	});
});
