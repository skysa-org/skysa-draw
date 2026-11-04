import { describe, expect, it } from 'vitest';

import type { RemoteEntry } from '../../../src/providers/types.js';
import {
	decidedApartFromMoves,
	decidedDrawings,
	reestablished,
} from '../../../src/sync/pull/decided.js';
import type { PullChange } from '../../../src/sync/store.js';

/**
 * What a batch has spoken for, read off its decisions (`pull/decided.ts`).
 * The engine's tests (`engine/*.test.ts`) reach these through whole pulls;
 * this says what each answers for one change of every kind.
 */

const entry = (remoteId: string, path: string): RemoteEntry => ({
	remoteId,
	path,
	kind: 'file',
	version: 'v1',
	modifiedAt: '',
});

/** Every kind a change can be, so a new one fails to compile here until it has a row. */
const KINDS: Readonly<Record<PullChange['kind'], true>> = {
	'upsert-drawing': true,
	'adopt-version': true,
	'move-drawing': true,
	'delete-drawing': true,
	'detach-drawing': true,
	'displace-drawing': true,
	'reupload-drawing': true,
	'ensure-folder': true,
	'move-folder': true,
	'delete-folder': true,
	'reupload-folder': true,
	unreadable: true,
	'forget-unreadable': true,
	conflict: true,
	'upsert-file': true,
	'displace-file': true,
	'delete-file': true,
	'reupload-file': true,
};

interface Row {
	change: PullChange;
	/** `reestablished`'s drawings and folders. */
	drawings: readonly string[];
	folders: readonly string[];
	/** `decidedDrawings`, then `decidedApartFromMoves`. */
	decided: readonly string[];
	apart: readonly string[];
}

/**
 * The table, about drawing `n` (and its conflict copy) and folder `work`. Made
 * twice over, so that pairs can be about one drawing or two.
 */
const rowsAbout = (n: string, work: string): readonly Row[] => {
	const copy = `${n}-copy`;
	const moved = `${work}-moved`;
	return [
		{
			change: {
				kind: 'upsert-drawing',
				id: n,
				path: 'a.svg',
				content: '',
				remote: entry('r', 'a.svg'),
				syncedHash: '',
			},
			drawings: [n],
			folders: [],
			decided: [n],
			apart: [n],
		},
		{
			change: { kind: 'adopt-version', id: n, remote: entry('r', 'a.svg') },
			drawings: [n],
			folders: [],
			decided: [n],
			apart: [n],
		},
		{
			change: { kind: 'move-drawing', id: n, path: 'b.svg', remote: entry('r', 'b.svg') },
			drawings: [n],
			folders: [],
			decided: [n],
			apart: [n],
		},
		// Taken away, so said something about, but not written back.
		{
			change: { kind: 'delete-drawing', id: n },
			drawings: [],
			folders: [],
			decided: [n],
			apart: [n],
		},
		{
			change: { kind: 'detach-drawing', id: n },
			drawings: [],
			folders: [],
			decided: [n],
			apart: [n],
		},
		// Moved out of another file's way, which says nothing about its own.
		{
			change: { kind: 'displace-drawing', id: n, path: 'a (moved).svg' },
			drawings: [],
			folders: [],
			decided: [n],
			apart: [],
		},
		{
			change: { kind: 'reupload-drawing', id: n },
			drawings: [],
			folders: [],
			decided: [n],
			apart: [n],
		},
		{
			change: { kind: 'ensure-folder', path: work },
			drawings: [],
			folders: [work],
			decided: [],
			apart: [],
		},
		{
			change: { kind: 'move-folder', from: work, to: moved },
			drawings: [],
			folders: [moved],
			decided: [],
			apart: [],
		},
		// The drawings a folder delete keeps are not decided by it.
		{
			change: { kind: 'delete-folder', path: work, keep: [n] },
			drawings: [],
			folders: [],
			decided: [],
			apart: [],
		},
		{
			change: { kind: 'reupload-folder', path: work },
			drawings: [],
			folders: [],
			decided: [],
			apart: [],
		},
		{
			change: { kind: 'unreadable', file: { remoteId: 'r', path: 'a.svg' } },
			drawings: [],
			folders: [],
			decided: [],
			apart: [],
		},
		{
			change: { kind: 'forget-unreadable', remoteId: 'r' },
			drawings: [],
			folders: [],
			decided: [],
			apart: [],
		},
		// Two drawings: the one that lost and the copy that keeps its edit.
		{
			change: {
				kind: 'conflict',
				resolution: {
					drawingId: n,
					remoteContent: '',
					remoteHash: '',
					remote: entry('r', 'a.svg'),
					copyId: copy,
					copyPath: 'a (conflict).svg',
					copyContent: '',
				},
			},
			drawings: [n, copy],
			folders: [],
			decided: [n, copy],
			apart: [n, copy],
		},
		{
			change: {
				kind: 'upsert-file',
				fileId: 'f',
				path: 'a.png',
				remote: entry('r', 'a.png'),
			},
			drawings: [],
			folders: [],
			decided: [],
			apart: [],
		},
		{
			change: { kind: 'displace-file', fileId: 'f', path: 'b.png' },
			drawings: [],
			folders: [],
			decided: [],
			apart: [],
		},
		{
			change: { kind: 'delete-file', fileId: 'f' },
			drawings: [],
			folders: [],
			decided: [],
			apart: [],
		},
		{
			change: { kind: 'reupload-file', fileId: 'f' },
			drawings: [],
			folders: [],
			decided: [],
			apart: [],
		},
	];
};

const ROWS = rowsAbout('n', 'Work');
const ELSEWHERE = rowsAbout('m', 'Home');

describe('one change of every kind', () => {
	it('has a row for every kind', () => {
		expect(ROWS.map((row) => row.change.kind).sort()).toEqual(Object.keys(KINDS).sort());
	});

	it.each(ROWS.map((row) => [row.change.kind, row] as const))('%s', (_kind, row) => {
		const written = reestablished([row.change]);
		expect(written.drawings).toEqual(new Set(row.drawings));
		expect(written.folders).toEqual(new Set(row.folders));
		expect(decidedDrawings([row.change])).toEqual(new Set(row.decided));
		expect(decidedApartFromMoves([row.change])).toEqual(new Set(row.apart));
	});
});

describe('changes together', () => {
	const union = (first: readonly string[], second: readonly string[]) =>
		new Set([...first, ...second]);

	/**
	 * What a pair answers is what its two changes answer alone, together:
	 * nothing one says hides what the other says, in either order, about the
	 * same drawing or another. So a drawing moved aside and also written back or
	 * taken away still counts apart from moves.
	 */
	it.each([
		['the same drawing and folder', ROWS],
		['another drawing and folder', ELSEWHERE],
	] as const)('answers for a pair what each answers alone, about %s', (_about, seconds) => {
		ROWS.forEach((first) => {
			seconds.forEach((second) => {
				const changes = [first.change, second.change];
				const pair = `${first.change.kind} then ${second.change.kind}`;
				const written = reestablished(changes);
				expect(written.drawings, pair).toEqual(union(first.drawings, second.drawings));
				expect(written.folders, pair).toEqual(union(first.folders, second.folders));
				expect(decidedDrawings(changes), pair).toEqual(
					union(first.decided, second.decided)
				);
				expect(decidedApartFromMoves(changes), pair).toEqual(
					union(first.apart, second.apart)
				);
			});
		});
	});
});
