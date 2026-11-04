import { describe, expect, it } from 'vitest';

import {
	basename,
	isHidden,
	isWithin,
	joinPath,
	normalizePath,
	parentPath,
	pathSegments,
	rebasePath,
	replaceBasename,
	ROOT,
} from '../src/paths.js';

describe('normalizePath', () => {
	it('trims and collapses separators', () => {
		expect(normalizePath('/work//meetings/')).toBe('work/meetings');
	});

	it('drops . segments', () => {
		expect(normalizePath('work/./meetings')).toBe('work/meetings');
	});

	it('resolves ..', () => {
		expect(normalizePath('work/meetings/../drawings')).toBe('work/drawings');
	});

	it('keeps names that only look like . and .. segments', () => {
		expect(normalizePath('.drawapp.json')).toBe('.drawapp.json');
		expect(normalizePath('a../...b/.../..c')).toBe('a../...b/.../..c');
		expect(normalizePath('work/..')).toBe(ROOT);
		expect(normalizePath('./work')).toBe('work');
		expect(normalizePath('work/.')).toBe('work');
	});

	it('never lets a path escape the app folder', () => {
		expect(normalizePath('../../etc/passwd')).toBe('etc/passwd');
		expect(normalizePath('work/../../..')).toBe(ROOT);
	});

	it('maps every spelling of the root to the empty string', () => {
		expect(normalizePath('')).toBe(ROOT);
		expect(normalizePath('/')).toBe(ROOT);
		expect(normalizePath('.')).toBe(ROOT);
	});
});

describe('joinPath', () => {
	it('joins and normalizes in one step', () => {
		expect(joinPath('work', 'meetings', 'standup.svg')).toBe('work/meetings/standup.svg');
	});

	it('treats the root as no prefix', () => {
		expect(joinPath('', 'drawing.svg')).toBe('drawing.svg');
	});
});

describe('pathSegments', () => {
	it('splits a path', () => {
		expect(pathSegments('work/meetings')).toEqual(['work', 'meetings']);
	});

	it('gives the root no segments', () => {
		expect(pathSegments('')).toEqual([]);
	});
});

describe('parentPath', () => {
	it('returns the containing folder', () => {
		expect(parentPath('work/meetings/standup.svg')).toBe('work/meetings');
	});

	it('returns the root for a top-level entry', () => {
		expect(parentPath('drawing.svg')).toBe(ROOT);
	});
});

describe('basename and replaceBasename', () => {
	it('reads the final segment', () => {
		expect(basename('work/standup.svg')).toBe('standup.svg');
		expect(basename('')).toBe(ROOT);
	});

	it('swaps the final segment, keeping the parent', () => {
		expect(replaceBasename('work/old.svg', 'new.svg')).toBe('work/new.svg');
		expect(replaceBasename('old.svg', 'new.svg')).toBe('new.svg');
	});
});

describe('isHidden', () => {
	it('hides anything under a dot segment', () => {
		expect(isHidden('.drawapp.json')).toBe(true);
		expect(isHidden('.trash/old.svg')).toBe(true);
		expect(isHidden('work/.hidden.svg')).toBe(true);
	});

	it('leaves ordinary paths visible', () => {
		expect(isHidden('work/standup.svg')).toBe(false);
	});

	it('hides a dot folder at the root as anywhere else', () => {
		// skysa-notes let two of these through for its scratchpad and its vault;
		// this app has neither, so the rule has no exceptions.
		expect(isHidden('.scratchpad/untitled.svg')).toBe(true);
		expect(isHidden('.vault/github.svg')).toBe(true);
		expect(isHidden('.clipboard/a.txt')).toBe(true);
		expect(isHidden('.git/config')).toBe(true);
		expect(isHidden('.DS_Store')).toBe(true);
	});
});

describe('isWithin', () => {
	it('matches the folder itself and anything beneath it', () => {
		expect(isWithin('work', 'work')).toBe(true);
		expect(isWithin('work/meetings/a.svg', 'work')).toBe(true);
	});

	it('does not match a sibling with a shared prefix', () => {
		expect(isWithin('workshop/a.svg', 'work')).toBe(false);
	});

	it('treats the root as containing everything', () => {
		expect(isWithin('anything/at/all.svg', ROOT)).toBe(true);
	});
});

describe('rebasePath', () => {
	it('moves a path from one folder to another', () => {
		expect(rebasePath('work/meetings/a.svg', 'work', 'archive/work')).toBe(
			'archive/work/meetings/a.svg'
		);
	});

	it('rebases the folder itself', () => {
		expect(rebasePath('work', 'work', 'archive')).toBe('archive');
	});

	it('leaves a path outside the moved folder alone', () => {
		expect(rebasePath('personal/a.svg', 'work', 'archive')).toBe('personal/a.svg');
	});

	it('does not catch a sibling with a shared prefix', () => {
		expect(rebasePath('workshop/a.svg', 'work', 'archive')).toBe('workshop/a.svg');
	});

	it('can move a folder up to the root', () => {
		expect(rebasePath('archive/work/a.svg', 'archive/work', '')).toBe('a.svg');
	});
});
