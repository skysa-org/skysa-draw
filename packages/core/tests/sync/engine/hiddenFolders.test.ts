import { describe, expect, it } from 'vitest';

import { svg } from '../kit/drawings.js';
import { syncWorld } from '../kit/world.js';

/**
 * The hidden folders a round meets. skysa-notes synced two of them at the root,
 * its scratchpad's and its vault's, and told its app when a round met its
 * clipboard's folder or its key file for secrets; none of that is this app's
 * (docs/ARCHITECTURE.md §3, "Unlike skysa-notes, there are no exceptions at
 * the root"). Every dot-prefixed path is passed over, and a round says nothing
 * of having met one.
 */
const { world, remoteFile } = syncWorld();

describe('a hidden folder at the root', () => {
	it.each(['.scratchpad', '.vault', '.clipboard'])(
		'passes over %s and what is in it',
		async (folder) => {
			await world.provider.createFolder(folder);
			await remoteFile(`${folder}/untitled.svg`, svg('x\n'));
			await world.provider.createFile(
				`${folder}/item.txt`,
				new TextEncoder().encode('copied')
			);

			const result = await world.engine.pull();

			expect(result).toEqual({ status: 'ok', pulled: 0, pushed: 0, conflicts: [] });
			expect(world.store.drawings()).toEqual([]);
			expect(world.store.files()).toEqual([]);
			expect(world.store.folders()).toEqual([]);
		}
	);

	it('passes over a key file at the root', async () => {
		await world.provider.write('.encryption.json', '{"schemaVersion":1}\n', {});

		expect(await world.engine.pull()).toEqual({
			status: 'ok',
			pulled: 0,
			pushed: 0,
			conflicts: [],
		});
	});
});
