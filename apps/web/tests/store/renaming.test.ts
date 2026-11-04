import { describe, expect, it } from 'vitest';

import {
	createRenamings,
	type Renaming,
	shownFolder,
	shownSourceName,
} from '../../src/store/renaming.js';

/**
 * A folder or source being renamed, for everything else on screen that names
 * it (`store/renaming.ts`): what they show while it is typed, and when they let
 * go of it.
 */

const folder = (key: string, text: string): Renaming => ({ kind: 'folder', key, text });

describe('a folder’s path, while the folder is being renamed', () => {
	it('names the folder, and everything inside it, by what is typed', () => {
		const renaming = folder('Work', 'Projects');
		expect(shownFolder('Work', renaming)).toBe('Projects');
		expect(shownFolder('Work/Minutes', renaming)).toBe('Projects/Minutes');
		expect(shownFolder('Work/minutes.svg', renaming)).toBe('Projects/minutes.svg');
	});

	it('renames only the last part of a folder inside another', () => {
		expect(shownFolder('Work/Minutes/standup.svg', folder('Work/Minutes', 'Drawings'))).toBe(
			'Work/Drawings/standup.svg'
		);
	});

	it('leaves alone a folder whose name only starts the same', () => {
		expect(shownFolder('Workshop', folder('Work', 'Projects'))).toBe('Workshop');
	});

	it('says what is stored while nothing is typed, since an empty name is never given', () => {
		expect(shownFolder('Work', folder('Work', '  '))).toBe('Work');
		expect(shownFolder('Work', undefined)).toBe('Work');
		expect(shownFolder('Work', { kind: 'source', key: 'Work', text: 'Projects' })).toBe('Work');
	});
});

describe('a source’s name, while it is being renamed', () => {
	it('is what is typed, for that source only', () => {
		const renaming: Renaming = { kind: 'source', key: 'c1', text: ' Work ' };
		expect(shownSourceName('c1', 'Dropbox', renaming)).toBe('Work');
		expect(shownSourceName('c2', 'OneDrive', renaming)).toBe('OneDrive');
	});

	it('stays what was given until the store calls it something else', () => {
		const renaming: Renaming = {
			kind: 'source',
			key: 'c1',
			text: 'Work',
			given: { was: 'Dropbox' },
		};
		// The store has not caught up yet.
		expect(shownSourceName('c1', 'Dropbox', renaming)).toBe('Work');
		// It has, and what it says wins.
		expect(shownSourceName('c1', 'Work, again', renaming)).toBe('Work, again');
	});
});

describe('the store', () => {
	it('holds one rename, and tells its listeners each keystroke', () => {
		const renamings = createRenamings();
		const heard: (Renaming | undefined)[] = [];
		const stop = renamings.subscribe(() => heard.push(renamings.get()));

		renamings.typed('folder', 'Work', 'P');
		renamings.typed('folder', 'Work', 'Pr');
		expect(heard.map((each) => each?.text)).toEqual(['P', 'Pr']);
		stop();
		renamings.typed('folder', 'Work', 'Pro');
		expect(heard).toHaveLength(2);
	});

	it('marks it given over what it was called, and lets go only of the one it holds', () => {
		const renamings = createRenamings();
		renamings.typed('source', 'c1', 'Work');
		// Another rename's answers do nothing to this one.
		renamings.give('source', 'c2', 'OneDrive');
		renamings.clear('folder', 'c1');
		expect(renamings.get()?.given).toBeUndefined();

		renamings.give('source', 'c1', 'Dropbox');
		expect(renamings.get()).toEqual({
			kind: 'source',
			key: 'c1',
			text: 'Work',
			given: { was: 'Dropbox' },
		});
		renamings.clear('source', 'c1');
		expect(renamings.get()).toBeUndefined();
	});
});
