import { describe, expect, it } from 'vitest';

import { pileMoveMessage } from '../../src/components/sources/connect/ConnectButton.js';

/**
 * What the question before a connect says will move. Counted, so the user can
 * tell it is their drawings being talked about, and without a count of nothing.
 */
describe('pileMoveMessage', () => {
	it('counts folders and drawings both', () => {
		expect(pileMoveMessage({ folders: 2, drawings: 5 }, 'Dropbox')).toBe(
			'Your 2 folders and 5 drawings on this device will move into Dropbox and sync there. Cancel to keep them on this device only.'
		);
	});

	it('leaves out an empty count, and says "it" of one thing', () => {
		expect(pileMoveMessage({ folders: 1, drawings: 0 }, 'OneDrive')).toBe(
			'Your 1 folder on this device will move into OneDrive and sync there. Cancel to keep it on this device only.'
		);
		expect(pileMoveMessage({ folders: 0, drawings: 3 }, 'Google Drive')).toBe(
			'Your 3 drawings on this device will move into Google Drive and sync there. Cancel to keep them on this device only.'
		);
	});
});
